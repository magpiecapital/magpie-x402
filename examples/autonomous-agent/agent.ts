/**
 * agent.ts — the orchestrator. Wires the parts into one continuous, bounded agent:
 *
 *   BRAIN (pick) → BUY (Jupiter) → COLLATERALIZE (Magpie) → GUARD (never default)
 *
 * Runs CONTINUOUSLY: the LoanGuardian protects every open loan for the whole
 * process lifetime, and a research cycle fires every CYCLE_INTERVAL_MIN to maybe
 * open a new position — always inside the solvency reserve + maxOpenLoans rails.
 * Safe by default (dry-run). Every action is DM'd via the Notifier so you can
 * watch it passively.
 *
 * Run:
 *   # rehearse continuously, free, nothing moves:
 *   MAGPIE_PAYER_KEYPAIR=~/id.json npx tsx examples/autonomous-agent/agent.ts
 *   # live (spends real funds from the agent wallet):
 *   LIVE=1 OPEN_UNIVERSE=true PREFERRED_CATEGORY=any \
 *     MAGPIE_PAYER_SECRET=<bs58|json> npx tsx examples/autonomous-agent/agent.ts
 */
import { Keypair, Connection } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { MagpieAgent } from "@magpieloans/magpie-agent";
import { loadConfig, loadKeySources } from "./config.js";
import { LoanGuardian } from "./loan-guardian.js";
import { jupiterBuy } from "./jupiter.js";
import { brainEnabled, chooseCandidateWithClaude, type MenuItem } from "./brain.js";
import { getExistingCollateral } from "./holdings.js";
import { Notifier } from "./notifier.js";
import { Positions } from "./positions.js";
import { runTradeCycle } from "./trade.js";
import { RULES } from "./magpie-playbook.js";

const log = (s = "") => console.log(s);
const cfg = loadConfig();

/**
 * Load the agent's signing key from EITHER an env secret (MAGPIE_PAYER_SECRET —
 * bs58 string or JSON byte array; ideal for Railway) OR a local file path
 * (MAGPIE_PAYER_KEYPAIR). The key only ever lives in this process; Magpie never sees it.
 */
function loadKeypair(): Keypair {
  const { secret, path } = loadKeySources();
  if (secret && secret.trim()) {
    const s = secret.trim();
    if (s.startsWith("[")) return Keypair.fromSecretKey(new Uint8Array(JSON.parse(s) as number[]));
    return Keypair.fromSecretKey(bs58.decode(s));
  }
  if (path) {
    const p = path.replace(/^~/, process.env.HOME || "");
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8")) as number[]));
  }
  throw new Error("Set MAGPIE_PAYER_SECRET (bs58/JSON, for Railway) or MAGPIE_PAYER_KEYPAIR (file path).");
}

async function main() {
  const keypair = loadKeypair();
  const agent = new MagpieAgent({ keypair, rpcUrl: cfg.rpcUrl, baseUrl: cfg.baseUrl });
  const notifier = new Notifier(cfg);

  log("╔═══════════════════════════════════════════════════════════╗");
  log("║   Magpie autonomous agent — never-default by design        ║");
  log("╚═══════════════════════════════════════════════════════════╝");
  log(cfg.dryRun ? "MODE: 🟢 DRY RUN — no funds move." : "MODE: 🔴 LIVE — real funds.");
  log(`Agent wallet: ${keypair.publicKey.toBase58()}`);
  log(`Rule #1 — liquidation is ${RULES.liquidation.trigger} ${RULES.liquidation.implication}`);
  log("");

  // ── GUARD FIRST: protect any open loans before we do anything else. ───────
  // Runs in EVERY strategy (even pure 'trade') as a defensive no-op: if any loan
  // is ever open on this wallet, never-default still applies. Cheap when there are none.
  const guardian = new LoanGuardian(agent, cfg, keypair, notifier);
  guardian.start();

  // ── trade book state (only used when strategy includes 'trade'). ──────────
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const positions = new Positions();
  const tradeCtx = { agent, cfg, keypair, notifier, positions, conn, guardian };
  const doesTrade = cfg.strategy === "trade" || cfg.strategy === "both";
  const doesBorrow = cfg.strategy === "borrow" || cfg.strategy === "both";

  await notifier.send(
    "boot",
    `Online · ${keypair.publicKey.toBase58().slice(0, 8)}… · strategy=${cfg.strategy}` +
      (doesTrade ? ` · ${(Number(cfg.tradePositionLamports) / 1e9).toFixed(2)}◎/pos · max ${cfg.maxPositions} pos · TP+${cfg.tradeTakeProfitPct}%/SL-${cfg.tradeStopLossPct}%` : "") +
      (doesBorrow ? ` · max ${cfg.maxOpenLoans} loan(s)` : "") +
      ` · cycle ${(cfg.cycleIntervalMs / 60000) | 0}m · ${brainEnabled() ? "Claude brain" : "deterministic picker"}.`,
  );

  // ── the continuous loop: research → maybe act → sleep → repeat ────────────
  let cycleNum = 0;
  const runOne = async () => {
    cycleNum++;
    try {
      await notifier.send("cycle", `Cycle ${cycleNum} — researching…`);
      // BORROW BEFORE TRADE — never-default ordering. The borrow cycle may open a
      // new loan; its repay reserve only exists once guardian.safeBorrow() tracks
      // it. Running borrow first means the subsequent trade cycle sizes its buys
      // off a guardian.deployableLamports() that ALREADY subtracts the new loan's
      // reserve — closing the same-cycle race where the trade book could otherwise
      // spend SOL the not-yet-tracked loan needs to repay. (Audit 2026-06-25.)
      if (doesBorrow) await runCycle(agent, guardian, notifier);
      if (doesTrade) await runTradeCycle(tradeCtx);
    } catch (err) {
      await notifier.send("error", `Cycle ${cycleNum} errored (loop continues): ${(err as Error).message}`);
    }
  };

  await runOne();

  if (cfg.cycleIntervalMs > 0) {
    setInterval(() => void runOne(), cfg.cycleIntervalMs);
    log(`\nRunning continuously — research cycle every ${(cfg.cycleIntervalMs / 60000) | 0} min; guardian sweeps every ${(cfg.guardianIntervalMs / 60000) | 0} min. Ctrl-C to stop.`);
    return; // active timers keep the process alive
  }

  // single-cycle mode (CYCLE_INTERVAL_MIN=0)
  if (cfg.dryRun) {
    log("\n🟢 Dry run (single cycle) complete. Set LIVE=1 to act, or CYCLE_INTERVAL_MIN>0 to run continuously.");
    guardian.stop();
    return;
  }
  log("\n🔴 Single cycle done. Guardian stays running so no loan can go overdue. Ctrl-C to stop.");
}

async function runCycle(agent: MagpieAgent, guardian: LoanGuardian, notifier: Notifier) {
  // 1) BRAIN — Claude proposes a candidate from the allowed menu (or HOLD); the
  //    deterministic gates + guardian still have the final word.
  const candidate = await chooseCandidate(agent, notifier);
  if (!candidate) {
    await notifier.send("hold", "No eligible candidate this cycle — holding (the safe default).");
    return;
  }
  log(`BRAIN — candidate: ${candidate.symbol} (${candidate.mint}) [${candidate.category}]`);

  // 2) ACQUIRE collateral — collateralize what we ALREADY hold (no buy), else buy it.
  let collateralAmount: string;
  if (candidate.existingAmount) {
    collateralAmount = candidate.existingAmount;
    log(`HELD — collateralizing existing ${candidate.symbol} (${collateralAmount} base units) — no buy, no slippage.`);
    await notifier.send("info", `Collateralizing held ${candidate.symbol} directly (no buy needed).`);
  } else {
    // SOLVENCY — only ever spend what the guardian says is free (never the reserve).
    const deployable = await guardian.deployableLamports();
    let buyLamports = (deployable * 9n) / 10n; // keep 10% headroom on top of the reserve
    if (cfg.maxBuyLamports > 0n && buyLamports > cfg.maxBuyLamports) buyLamports = cfg.maxBuyLamports;
    log(`SOLVENCY — deployable ${fmt(deployable)} SOL; will buy with ${fmt(buyLamports)} SOL (reserve + gas held back).`);
    if (buyLamports <= 0n) {
      await notifier.send("hold", "Nothing deployable while keeping repay reserves — holding (never-default invariant doing its job).");
      return;
    }
    // BUY on Jupiter (Magpie can't — it's a lender, not a DEX).
    const buy = await jupiterBuy({
      payer: agentKeypair(),
      outputMint: candidate.mint,
      amountLamports: buyLamports,
      rpcUrl: cfg.rpcUrl,
      dryRun: cfg.dryRun,
    });
    if (!buy.ok) {
      await notifier.send("warn", `Buy of ${candidate.symbol} skipped/failed: ${buy.reason}`);
      return;
    }
    await notifier.send(
      "buy",
      `${cfg.dryRun ? "Quoted" : "Bought"} ${buy.outAmount ?? "?"} ${candidate.symbol} for ${fmt(buyLamports)} SOL${buy.signature ? ` (tx ${buy.signature})` : ""}.`,
    );
    collateralAmount = buy.outAmount ?? "0";
  }

  // 3) COLLATERALIZE on Magpie — only through safeBorrow, which refuses if it
  //    can't honor the resulting deadline, registers the loan + reserve, and
  //    DMs the borrow. The guardian then repays it (via repay.ts) well early.
  await guardian.safeBorrow({ collateralMint: candidate.mint, collateralAmount });

  // NOTE: in-vault exit arming (TP/SL) is NOT in the published SDK (0.1.x), so
  // this agent does not arm exits — by design, the GUARDIAN (never a stop-loss)
  // is what prevents default. Exit arming is a future SDK addition.

  // 5) DEPLOY — by policy the borrowed SOL is HELD as repay reserve, not re-risked.
  if (cfg.allowRecursiveRedeploy) {
    log("DEPLOY — ⚠️ recursive redeploy is ENABLED (higher risk). The guardian still gates spend by the reserve.");
  } else {
    log("DEPLOY — borrowed SOL held idle as repay reserve (no re-leverage). The guardian repays before the deadline.");
  }
}

interface Candidate {
  mint: string;
  symbol: string;
  category: string;
  /** Raw u64 collateral amount when the wallet ALREADY holds this (no buy needed). */
  existingAmount?: string;
}

/** Safe candidate selection: existing holdings + allowlist/open-universe, risk gated. */
async function chooseCandidate(agent: MagpieAgent, notifier: Notifier): Promise<Candidate | null> {
  const { tokens } = await agent.collateralCatalog();
  const byMint = new Map(tokens.map((t) => [t.mint, t]));

  // Catalog categories are fine-grained (memecoin | stock | etf | metal | …),
  // so "rwa" means "anything that isn't a memecoin".
  const matches = (cat: string) =>
    cfg.preferredCategory === "any" ||
    (cfg.preferredCategory === "memecoin" ? cat === "memecoin" : cat !== "memecoin");

  // 1) What the wallet ALREADY holds that Magpie accepts (collateralize directly, no buy).
  const heldMap = new Map<string, string>(); // mint -> raw amount
  const self = agent.publicKey();
  if (cfg.useExistingHoldings && self) {
    try {
      const held = await getExistingCollateral(new Connection(cfg.rpcUrl, "confirmed"), self, tokens);
      for (const h of held) heldMap.set(h.mint, h.amount);
      if (held.length) log(`HOLDINGS — wallet already holds ${held.length} approved token(s): ${held.map((h) => h.symbol).join(", ")}`);
    } catch (err) {
      log(`HOLDINGS — could not read existing balances: ${(err as Error).message}`);
    }
  }
  const heldCandidates: MenuItem[] = tokens
    .filter((t) => heldMap.has(t.mint) && matches(t.category))
    .map((t) => ({ ...t, held: true }));

  // 2) Buy candidates (need a Jupiter buy): allowlist / open-universe / dry-run.
  let buyPool: Array<{ mint: string; symbol: string; decimals: number; category: string }>;
  if (cfg.mintAllowlist.length) {
    buyPool = cfg.mintAllowlist.map((m) => byMint.get(m)).filter(Boolean) as typeof tokens;
    const pref = buyPool.filter((t) => matches(t.category));
    if (pref.length) buyPool = pref;
  } else if (cfg.dryRun || cfg.openUniverse) {
    buyPool = tokens.filter((t) => matches(t.category));
  } else {
    buyPool = []; // live + no allowlist + not open-universe → no fresh buys
  }

  // Held first (cheapest), then buy candidates; dedup by mint.
  const seen = new Set<string>();
  const pool: MenuItem[] = [];
  for (const t of [...heldCandidates, ...buyPool.map((t) => ({ ...t, held: heldMap.has(t.mint) }))]) {
    if (seen.has(t.mint)) continue;
    seen.add(t.mint);
    pool.push(t);
  }
  if (!pool.length) return null;

  // BRAIN — Claude proposes from the allowed menu (and may say HOLD); on any
  // failure or no key, fall back to the deterministic first pick (held-first).
  let pick = pool[0];
  if (brainEnabled()) {
    try {
      const decision = await chooseCandidateWithClaude(agent, cfg, pool);
      log(`BRAIN(Claude) — ${decision.action.toUpperCase()}${decision.symbol ? " " + decision.symbol : ""} · conf ${decision.confidence.toFixed(2)} · ${decision.reasoning}`);
      await notifier.send("brain", `Claude: ${decision.action.toUpperCase()}${decision.symbol ? " " + decision.symbol : ""} (conf ${decision.confidence.toFixed(2)}) — ${decision.reasoning}`);
      if (decision.action !== "buy" || !decision.mint) return null; // HOLD is a valid, safe outcome
      const chosen = pool.find((t) => t.mint === decision.mint);
      if (!chosen) {
        log("BRAIN — Claude picked a mint outside the allowed menu; rejecting for safety.");
        return null;
      }
      pick = chosen;
    } catch (err) {
      log(`BRAIN — Claude unavailable (${(err as Error).message}); using deterministic pick.`);
    }
  }

  // Risk gate (paid 0.001 SOL) — defense in depth, only spends when live.
  if (!cfg.dryRun) {
    try {
      const risk = await agent.tokenRisk(pick.mint);
      const score = Number((risk as { risk_score?: number }).risk_score ?? 100);
      if (score > cfg.maxTokenRisk) {
        log(`BRAIN — ${pick.symbol} risk ${score} > max ${cfg.maxTokenRisk}; rejecting.`);
        await notifier.send("hold", `Rejected ${pick.symbol}: Magpie risk ${score} > max ${cfg.maxTokenRisk}.`);
        return null;
      }
    } catch (err) {
      log(`BRAIN — token-risk check failed, refusing to buy blind: ${(err as Error).message}`);
      return null;
    }
  }
  return { mint: pick.mint, symbol: pick.symbol, category: pick.category, existingAmount: heldMap.get(pick.mint) };
}

// The SDK keeps the keypair private; for the Jupiter leg we need to sign
// directly, so re-load it the same way the agent did.
function agentKeypair(): Keypair {
  return loadKeypair();
}

const fmt = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);

main().catch((e) => {
  console.error("\n✗ agent error:", e?.message ?? e);
  process.exit(1);
});
