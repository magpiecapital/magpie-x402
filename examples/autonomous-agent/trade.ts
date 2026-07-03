/**
 * trade.ts — the SPOT memecoin trade engine (find them, buy them, sell for profit).
 * ─────────────────────────────────────────────────────────────────────────
 * One cycle:
 *   1. READ every token the wallet holds and MARK IT TO MARKET (live Jupiter quote → SOL).
 *   2. MECHANICAL EXITS first — a hard stop-loss and take-profit vs the recorded cost
 *      basis. This is the downside floor and it runs BEFORE the model: a position that
 *      cratered is sold without waiting on an LLM round-trip.
 *   3. BRAIN — Claude reviews the surviving book + a candidate menu and decides thesis
 *      sells / fresh buys. It can only sell what's held and buy from the vetted menu.
 *   4. EXECUTE — sells free up SOL, then buys (sized, solvency-bounded, risk-gated, capped
 *      at maxPositions). Every fill is recorded to the cost-basis book and DM'd.
 *
 * No leverage, no borrowing — this is the wallet's own SOL. Liquidation/never-default
 * does not apply here; the only risk is market risk, bounded by position size + stop-loss.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { MagpieAgent } from "@magpieloans/magpie-agent";
import type { AgentConfig } from "./config.js";
import type { Notifier } from "./notifier.js";
import type { LoanGuardian } from "./loan-guardian.js";
import { Positions } from "./positions.js";
import { getAllTokenHoldings } from "./holdings.js";
import { jupiterBuy, jupiterSell, jupiterValueInSol } from "./jupiter.js";
import {
  brainEnabled,
  decideTradesWithClaude,
  type TradeCandidate,
  type TradePosition,
} from "./brain.js";
import { cachedTokenRisk } from "./risk-cache.js";
import { discoverTrenchCandidates, discoveryEnabled } from "./discovery.js";

const log = (s: string) => console.log(`[trade] ${s}`);
const fmt = (l: bigint) => (Number(l) / 1e9).toFixed(4);
const NET_TIMEOUT_MS = Number(process.env.TRADE_NET_TIMEOUT_MS ?? 25_000);

/** Race a promise against a timeout — no network call may stall the trade loop. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export interface TradeCtx {
  agent: MagpieAgent;
  cfg: AgentConfig;
  keypair: Keypair;
  notifier: Notifier;
  positions: Positions;
  conn: Connection;
  /**
   * The never-default guardian. The trade engine sizes its buys off
   * guardian.deployableLamports() (liquid − gas − every open loan's repay
   * reserve), NOT just balance − gas — so in 'both' mode the trade book can
   * NEVER spend SOL the guardian needs to repay a loan. Never-default holds.
   */
  guardian: LoanGuardian;
}

interface Marked {
  mint: string;
  symbol: string;
  decimals: number;
  category?: string;
  amount: bigint; // on-chain balance (base units)
  value: bigint | null; // SOL lamports, null = no route (illiquid)
  cost?: bigint; // recorded cost basis (lamports)
  pnlPct?: number;
  ageMs?: number;
}

/** One full trade cycle. Safe under dryRun (quotes only, nothing moves). */
export async function runTradeCycle(ctx: TradeCtx): Promise<void> {
  const { agent, cfg, keypair, notifier, positions, conn } = ctx;
  const self = keypair.publicKey;
  const taker = self.toBase58();
  const now = Date.now();

  // 0) catalog (for symbols/decimals + the memecoin candidate menu).
  let catalog: Array<{ mint: string; symbol: string; decimals: number; category: string }> = [];
  try {
    catalog = (await withTimeout(agent.collateralCatalog(), NET_TIMEOUT_MS, "catalog")).tokens;
  } catch (err) {
    log(`catalog fetch failed (${(err as Error).message}); continuing with on-chain holdings only.`);
  }

  // 1) read holdings + reconcile the cost-basis book to what we actually hold.
  let holdings;
  try {
    holdings = await withTimeout(getAllTokenHoldings(conn, self, catalog), NET_TIMEOUT_MS, "holdings");
  } catch (err) {
    log(`holdings read failed (${(err as Error).message}); skipping this cycle (will retry).`);
    await notifier.send("warn", `Trade cycle skipped — could not read wallet holdings: ${(err as Error).message}`);
    return;
  }
  positions.reconcile(new Set(holdings.map((h) => h.mint)));

  // SCOPE THE BOOK to memecoins only. A token belongs to the trade book ONLY if
  // it's a memecoin (the mandate) OR the agent itself bought it (in the cost-basis
  // book). RWAs / tokenized stocks (e.g. QQQx) and any unknown token the wallet
  // merely holds — often leftover collateral from a repaid loan — are the operator's
  // assets and are NEVER sold here.
  const tradeable = holdings.filter((h) => h.category === "memecoin" || !!positions.get(h.mint));
  const skipped = holdings.filter((h) => !(h.category === "memecoin" || !!positions.get(h.mint)));
  if (skipped.length) {
    log(`SKIP — leaving ${skipped.length} non-memecoin holding(s) untouched: ${skipped.map((s) => `${s.symbol}${s.category ? "/" + s.category : ""}`).join(", ")}.`);
  }

  // 2) mark every tradeable position to market.
  const marked: Marked[] = [];
  for (const h of tradeable) {
    const amount = BigInt(h.amount);
    const value = await jupiterValueInSol({ inputMint: h.mint, amountBaseUnits: amount, taker });
    const entry = positions.get(h.mint);
    const cost = entry?.costLamports;
    const pnlPct =
      value != null && cost && cost > 0n ? (Number(value - cost) / Number(cost)) * 100 : undefined;
    marked.push({
      mint: h.mint,
      symbol: h.symbol,
      decimals: h.decimals,
      category: h.category,
      amount,
      value,
      cost,
      pnlPct,
      ageMs: entry ? now - entry.entryTs : undefined,
    });
  }

  const book = marked.filter((m) => (m.value ?? 0n) >= cfg.tradeMinPositionLamports || m.cost);
  if (book.length) {
    log(
      `BOOK — ${book.length} position(s): ` +
        book
          .map((m) => `${m.symbol} ${m.value != null ? fmt(m.value) + "◎" : "illiquid"}${m.pnlPct != null ? ` (${m.pnlPct >= 0 ? "+" : ""}${m.pnlPct.toFixed(0)}%)` : ""}`)
          .join(", "),
    );
  } else {
    log("BOOK — no open positions.");
  }

  // 3) MECHANICAL EXITS — stop-loss / take-profit vs cost basis. The downside floor.
  const sold = new Set<string>();
  for (const m of book) {
    if (m.pnlPct == null || m.value == null) continue; // no basis / illiquid → brain decides
    if (cfg.tradeMinHoldMs > 0 && (m.ageMs ?? Infinity) < cfg.tradeMinHoldMs) continue;
    const hitTP = m.pnlPct >= cfg.tradeTakeProfitPct;
    const hitSL = m.pnlPct <= -cfg.tradeStopLossPct;
    if (!hitTP && !hitSL) continue;
    const why = hitTP ? `take-profit +${m.pnlPct.toFixed(0)}%` : `stop-loss ${m.pnlPct.toFixed(0)}%`;
    log(`EXIT(mechanical) — ${m.symbol}: ${why}; selling ${fmt(m.value)}◎.`);
    const ok = await executeSell(ctx, m, why);
    if (ok) sold.add(m.mint);
  }

  // 4) BRAIN — thesis sells + fresh buys on whatever survived the mechanical pass.
  const survivors = book.filter((m) => !sold.has(m.mint));
  const heldMints = new Set(holdings.map((h) => h.mint));
  const catalogCandidates: TradeCandidate[] = catalog
    .filter((t) => t.category === "memecoin" && !heldMints.has(t.mint))
    .slice(0, 25)
    .map((t) => ({ mint: t.mint, symbol: t.symbol, category: t.category }));

  // Widen the funnel with freshly-DISCOVERED, gauntlet-vetted trench tokens
  // (the "find good trench tokens" brain). discovery.ts has already enforced
  // liquidity/volume/age + renounced authorities + sellability, so anything
  // here is a vetted candidate — the trade engine still risk-gates, sizes,
  // and stop-loss/take-profits it. Soft-fails to catalog-only on any error.
  let discovered: TradeCandidate[] = [];
  if (discoveryEnabled()) {
    try {
      // Bounded: per-request timeouts inside + a whole-stage ceiling here, so
      // discovery can never stall the cycle (which, with the loop's re-entrancy
      // guard, is what keeps cycles from ever overlapping on the wallet).
      const trench = await withTimeout(discoverTrenchCandidates(cfg), NET_TIMEOUT_MS * 3, "discovery");
      discovered = trench.filter((t) => !heldMints.has(t.mint));
      if (discovered.length) {
        log(`DISCOVERY — ${discovered.length} vetted trench candidate(s): ${discovered.map((t) => t.symbol).join(", ")}`);
        await notifier.send(
          "info",
          `🔭 Discovery surfaced ${discovered.length} vetted trench token(s): ${discovered.map((t) => t.symbol).join(", ")}`,
        );
      }
    } catch (err) {
      log(`DISCOVERY — failed (${(err as Error).message}); catalog-only this cycle.`);
    }
  }

  // Merge catalog + discovered, dedup by mint, cap to keep the brain prompt tight.
  const seenCand = new Set<string>();
  const candidates: TradeCandidate[] = [];
  for (const c of [...catalogCandidates, ...discovered]) {
    if (seenCand.has(c.mint)) continue;
    seenCand.add(c.mint);
    candidates.push(c);
  }
  candidates.splice(30); // hard cap

  const openCount = survivors.filter((m) => (m.value ?? 0n) >= cfg.tradeMinPositionLamports).length;
  const roomForBuys = Math.max(0, cfg.maxPositions - openCount);

  let brainSells: string[] = [];
  let brainBuys: string[] = [];
  let brainSizings: Record<string, number> = {};
  if (brainEnabled() && (survivors.length || (candidates.length && roomForBuys > 0))) {
    try {
      const positionsForBrain: TradePosition[] = survivors.map((m) => ({
        mint: m.mint,
        symbol: m.symbol,
        valueLamports: m.value ?? 0n,
        costLamports: m.cost,
        pnlPct: m.pnlPct,
        ageMin: m.ageMs != null ? Math.floor(m.ageMs / 60_000) : undefined,
      }));
      const d = await decideTradesWithClaude(agent, cfg, positionsForBrain, candidates, roomForBuys);
      brainSells = d.sells;
      brainBuys = d.buys;
      brainSizings = d.sizings ?? {};
      log(`BRAIN — sell [${brainSells.map((x) => x.slice(0, 4)).join(",")}] buy [${brainBuys.map((x) => x.slice(0, 4)).join(",")}] · conf ${d.confidence.toFixed(2)} · ${d.reasoning}`);
      await notifier.send("brain", `Trade brain (conf ${d.confidence.toFixed(2)}): sell ${brainSells.length}, buy ${brainBuys.length} — ${d.reasoning}`);
    } catch (err) {
      log(`BRAIN unavailable (${(err as Error).message}); mechanical-only this cycle.`);
    }
  }

  // 5a) thesis sells.
  for (const mint of brainSells) {
    if (sold.has(mint)) continue;
    const m = survivors.find((s) => s.mint === mint);
    if (!m || m.value == null) continue;
    log(`EXIT(thesis) — ${m.symbol}: brain sell; ${fmt(m.value)}◎.`);
    if (await executeSell(ctx, m, "brain thesis exit")) sold.add(mint);
  }

  // 5b) fresh buys — sized, solvency-bounded, risk-gated, position-capped.
  let openNow = openCount - [...sold].filter((mt) => survivors.some((s) => s.mint === mt)).length;
  for (const mint of brainBuys) {
    if (openNow >= cfg.maxPositions) {
      log(`BUY skipped — at maxPositions (${cfg.maxPositions}).`);
      break;
    }
    const free = await freeLamports(ctx);
    if (free < cfg.tradeMinPositionLamports) {
      log(`BUY skipped — free ${fmt(free)}◎ < min position ${fmt(cfg.tradeMinPositionLamports)}◎.`);
      break;
    }
    const cand = candidates.find((c) => c.mint === mint);
    const sym = cand?.symbol ?? mint.slice(0, 4);

    // Risk gate (paid, cached) — defense in depth on top of the brain's own check.
    if (!cfg.dryRun) {
      try {
        const r = await cachedTokenRisk(agent, mint);
        if (r.risk_score > cfg.maxTokenRisk) {
          log(`BUY ${sym} rejected — risk ${r.risk_score} > max ${cfg.maxTokenRisk}.`);
          await notifier.send("hold", `Skipped ${sym}: risk ${r.risk_score} > max ${cfg.maxTokenRisk}.`);
          continue;
        }
      } catch (err) {
        log(`BUY ${sym} rejected — risk check failed: ${(err as Error).message}`);
        continue;
      }
    }

    // SIZE — brain conviction multiplier (0.5 = half-size probe … 2.0 = high-conviction
    // lean-in) on the base position, bounded to 90% of free SOL (gas headroom) + MAX_BUY,
    // floored at the dust minimum. Varies trade size by conviction, not a flat amount.
    const mult = Math.max(0.5, Math.min(2, brainSizings[mint] ?? 1));
    let spend = BigInt(Math.round(Number(cfg.tradePositionLamports) * mult));
    const capByFree = (free * 9n) / 10n;
    if (spend > capByFree) spend = capByFree;
    if (cfg.maxBuyLamports > 0n && spend > cfg.maxBuyLamports) spend = cfg.maxBuyLamports;
    if (spend < cfg.tradeMinPositionLamports) {
      log(`BUY ${sym} skipped — conviction-sized ${fmt(spend)}◎ below min ${fmt(cfg.tradeMinPositionLamports)}◎.`);
      continue;
    }
    log(`BUY — ${sym}: conviction ${mult.toFixed(2)}× → deploying ${fmt(spend)}◎.`);
    const buy = await jupiterBuy({
      payer: keypair,
      outputMint: mint,
      amountLamports: spend,
      rpcUrl: cfg.rpcUrl,
      dryRun: cfg.dryRun,
      slippageBps: cfg.tradeSlippageBps,
    });
    if (!buy.ok) {
      await notifier.send("warn", `Buy ${sym} failed: ${buy.reason}`);
      continue;
    }
    if (!cfg.dryRun && buy.outAmount) {
      positions.recordBuy(mint, spend, BigInt(buy.outAmount), now);
    }
    openNow++;
    await notifier.send(
      "buy",
      `${cfg.dryRun ? "Quoted" : "Bought"} ${sym} for ${fmt(spend)}◎${buy.signature ? ` — tx ${buy.signature}` : ""} (${openNow}/${cfg.maxPositions} positions).`,
    );
  }

  if (!sold.size && !brainBuys.length) {
    await notifier.send("hold", `Trade cycle: holding ${book.length} position(s), no entries/exits — the patient default.`);
  }
}

/** Sell a position's FULL on-chain balance back to SOL; record + DM. */
async function executeSell(ctx: TradeCtx, m: Marked, why: string): Promise<boolean> {
  const { cfg, keypair, notifier, positions } = ctx;
  if (cfg.dryRun) {
    await notifier.send("sell", `Would sell ${m.symbol} (${why}) for ~${m.value != null ? fmt(m.value) : "?"}◎ — dry run.`);
    return true;
  }
  const res = await jupiterSell({
    payer: keypair,
    inputMint: m.mint,
    amountBaseUnits: m.amount,
    rpcUrl: cfg.rpcUrl,
    dryRun: false,
    slippageBps: cfg.tradeSlippageBps,
  });
  if (!res.ok) {
    await notifier.send("warn", `Sell ${m.symbol} failed (${why}): ${res.reason} — will retry next cycle.`);
    return false;
  }
  positions.clear(m.mint);
  const pnl = m.pnlPct != null ? ` (${m.pnlPct >= 0 ? "+" : ""}${m.pnlPct.toFixed(0)}%)` : "";
  await notifier.send(
    "sell",
    `Sold ${m.symbol} (${why})${pnl} for ${res.outLamports != null ? fmt(res.outLamports) : "?"}◎ — tx ${res.signature}.`,
  );
  return true;
}

/**
 * SOL free to deploy into a new buy. Delegates to the guardian's
 * deployableLamports(): liquid balance MINUS the gas/rent buffer MINUS every
 * open loan's repay reserve. This is what keeps 'both' mode never-default —
 * the trade book can only ever spend SOL that is NOT earmarked to repay a loan,
 * so collateralized borrowing and active trading coexist without the trade
 * leg ever cannibalizing a repayment. The guardian is the single owner of the
 * reserve math; the trade engine never recomputes it independently.
 */
async function freeLamports(ctx: TradeCtx): Promise<bigint> {
  const deployable = await ctx.guardian.deployableLamports();
  return deployable > 0n ? deployable : 0n;
}

/** Re-exported for callers that already have a PublicKey. */
export { PublicKey };
