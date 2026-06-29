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
import { jupiterBuy, jupiterSell, jupiterValueInSol } from "./jupiter.js";
import { brainEnabled, chooseCandidateWithClaude, type MenuItem } from "./brain.js";
import { getExistingCollateral } from "./holdings.js";
import { Notifier } from "./notifier.js";
import { Positions } from "./positions.js";
import { runTradeCycle } from "./trade.js";
import { RULES } from "./magpie-playbook.js";

const log = (s = "") => console.log(s);
const cfg = loadConfig();

// VARIETY — rotate borrow collateral so the agent doesn't keep cycling in/out of
// the SAME token (e.g. BOME every cycle). Tracks recently-used mints ACROSS
// cycles; chooseCandidate excludes the last VARIETY_AVOID_LAST of them from the
// menu — but never empties it, so a thin wallet still borrows.
const recentCollateral: string[] = [];
const VARIETY_AVOID_LAST = Math.max(0, Number(process.env.VARIETY_AVOID_LAST ?? 2));

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

  // GO-LIVE GUARD — a fresh-buy borrow can NEVER clear the min-collateral floor
  // when the floor is within a round-trip slippage of the buy cap, and with held
  // collateral disabled that is the only borrow path, so the loop would silently
  // never open a loan. We fire across the WHOLE unborrowable band: the bought
  // collateral is valued back through Jupiter, so it loses ~2× the one-way
  // slippage vs the SOL spent — a floor as low as maxBuy/(1+2·slip) still never
  // clears. Warn LOUDLY at boot (log + DM) so the misconfig is visible. We do NOT
  // exit: the guardian must keep running to repay any existing on-chain loans
  // (never-default > a borrow-config gripe). Trade + guardian continue normally.
  const floorWithRoundTripSlippage =
    (cfg.minCollateralLamports * (10000n + 2n * BigInt(cfg.tradeSlippageBps))) / 10000n;
  if (
    doesBorrow &&
    cfg.maxBuyLamports > 0n &&
    floorWithRoundTripSlippage >= cfg.maxBuyLamports &&
    !cfg.useExistingHoldings
  ) {
    const warn =
      `⚠️ BORROW CONFIG DEADLOCK — MIN_COLLATERAL_SOL (${fmt(cfg.minCollateralLamports)}) is within round-trip ` +
      `slippage of MAX_BUY_SOL (${fmt(cfg.maxBuyLamports)}) with USE_EXISTING_HOLDINGS=false: a fresh buy, valued ` +
      `back through Jupiter, lands below the floor, so every borrow is skipped and the agent will NEVER open a ` +
      `loan. Lower MIN_COLLATERAL_SOL well below MAX_BUY_SOL or raise MAX_BUY_SOL. (Trade + guardian keep running.)`;
    log(warn);
    await notifier.send("error", warn);
  }

  await notifier.send(
    "boot",
    `Online · ${keypair.publicKey.toBase58().slice(0, 8)}… · strategy=${cfg.strategy}` +
      (doesTrade ? ` · ${(Number(cfg.tradePositionLamports) / 1e9).toFixed(2)}◎/pos · max ${cfg.maxPositions} pos · TP+${cfg.tradeTakeProfitPct}%/SL-${cfg.tradeStopLossPct}%` : "") +
      (doesBorrow ? ` · max ${cfg.maxOpenLoans} loan(s)` : "") +
      ` · cycle ${(cfg.cycleIntervalMs / 60000) | 0}m · ${brainEnabled() ? "Claude brain" : "deterministic picker"}.`,
  );

  // ── the continuous loop: research → maybe act → sleep → repeat ────────────
  let cycleNum = 0;
  // RE-ENTRANCY GUARD — setInterval fires on a fixed cadence regardless of
  // whether the prior cycle finished. A slow network stage (e.g. the discovery
  // feed) could make a cycle run past the interval; without this guard the next
  // tick would launch a SECOND concurrent runOne racing the same wallet —
  // double-committing SOL and bypassing the per-cycle loan-cap / never-default
  // reserve checks (both read live balance with no in-flight accounting). This
  // caps concurrent cycles at exactly one; an overlapping tick is skipped.
  let cycleRunning = false;
  const runOne = async () => {
    if (cycleRunning) {
      log(`Cycle skipped — previous cycle still running (no overlap).`);
      return;
    }
    cycleRunning = true;
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
    } finally {
      cycleRunning = false;
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
  // COST GUARD — if we're already at maxOpenLoans there is nothing to open this
  // cycle, so SKIP the paid brain research (a Claude call + risk lookups) that
  // safeBorrow would refuse anyway. The guardian keeps protecting the open loan
  // independently (its repay + gas + fees are fully RESERVED, so the open loan
  // can never go stale — no refuel needed while it's open). This also stops
  // Anthropic/x402 spend from scaling with idle cycles.
  if (guardian.openLoans().length >= cfg.maxOpenLoans) {
    log(`HOLD — at max ${cfg.maxOpenLoans} open loan(s); skipping research (no spend) until a slot frees.`);
    return;
  }

  // NEVER-STALE — a loan slot is FREE, so deployableLamports() here is true free
  // SOL (no open-loan reserve to double-count). If it's too low to even open a
  // recycle loan (borrow fee + gas), sell a held memecoin to top it up so the
  // agent keeps cycling instead of idling (operator: "agents CANNOT go stale").
  await maybeRefuel(agent, guardian, notifier);

  // 1) BRAIN — Claude proposes a candidate from the allowed menu (or HOLD); the
  //    deterministic gates + guardian still have the final word.
  const candidate = await chooseCandidate(agent, notifier, guardian);
  if (!candidate) {
    await notifier.send("hold", "No eligible candidate this cycle — holding (the safe default).");
    return;
  }
  log(`BRAIN — candidate: ${candidate.symbol} (${candidate.mint}) [${candidate.category}]`);

  // 2) ACQUIRE collateral — collateralize what we ALREADY hold (no buy), else buy it.
  let collateralAmount: string;
  const isHeld = !!candidate.existingAmount;
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
    // PRE-BUY FLOOR — if we can't even buy MIN_COLLATERAL worth, the post-buy
    // gate below would skip the borrow anyway, leaving us holding a token we
    // can't collateralize. Slippage only LOWERS the resale value, so
    // buyLamports < floor guarantees the bought collateral lands below it.
    // Skip the cycle instead of spending SOL (+ slippage) on un-borrowable dust.
    if (cfg.minCollateralLamports > 0n && buyLamports < cfg.minCollateralLamports) {
      await notifier.send(
        "hold",
        `Skipping buy of ${candidate.symbol}: deployable ${fmt(buyLamports)} SOL is below the ${fmt(cfg.minCollateralLamports)} SOL ` +
          `collateral minimum — won't buy collateral too small to borrow against. Fund the wallet for larger/continuous loans.`,
      );
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

  // 2b) MIN-COLLATERAL GATE — never pay the build-borrow x402 fee on collateral
  //     too small to clear a real loan (e.g. dust the wallet already holds). The
  //     held-collateral path does NOT go through the MAX_BUY_SOL sizing, so this
  //     is the only floor protecting it. Value the collateral in SOL via Jupiter.
  //     null handling differs by path: on the BUY path a null is a transient blip
  //     (we just bought it on Jupiter, so a route exists) → proceed, so a Jupiter
  //     hiccup can't silently block borrowing. On the HELD path a null means the
  //     token has no route / is illiquid — exactly the dust we must NOT pay a fee
  //     to collateralize → skip.
  if (cfg.minCollateralLamports > 0n) {
    const takerPk = agent.publicKey();
    const valueLamports = takerPk
      ? await jupiterValueInSol({
          inputMint: candidate.mint,
          amountBaseUnits: BigInt(collateralAmount),
          taker: takerPk.toBase58(),
        })
      : null;
    const belowFloor = valueLamports !== null && valueLamports < cfg.minCollateralLamports;
    const unpriceableHeld = valueLamports === null && isHeld;
    if (belowFloor || unpriceableHeld) {
      const worth = valueLamports !== null ? `~${fmt(valueLamports)} SOL` : "unpriceable (no Jupiter route)";
      await notifier.send(
        "hold",
        `Skipping ${candidate.symbol}: collateral ${worth} is below the ${fmt(cfg.minCollateralLamports)} SOL ` +
          `minimum — not paying a build-borrow fee on a too-small / illiquid loan.`,
      );
      return;
    }
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

/**
 * NEVER-STALE refuel. Called ONLY when a loan slot is free (see runCycle), so
 * deployableLamports() here is genuine free SOL — no open-loan reserve to
 * double-count (an open loan's repay+gas+fees are already fully reserved and can
 * never go stale). When that free SOL falls below cfg.minOperatingLamports, sell
 * just enough of a held memecoin on Jupiter to reach cfg.refuelTargetLamports so
 * the agent can keep opening recycle loans instead of idling. Tight top-up, not
 * a basket dump (operator: "agents CANNOT go stale on too little SOL").
 *
 * Safety:
 *  - Only sells tokens the WALLET HOLDS (getExistingCollateral reads wallet
 *    balances) — an OPEN loan's collateral is locked in its vault and is NOT in
 *    the wallet, so it can never be sold here.
 *  - Sells the MINIMUM needed (deficit + small headroom), capped at one
 *    position; picks the most-valuable/liquid holding for a clean fill.
 *  - Memecoins only (the agent's whole universe is memecoins).
 *  - Best-effort + fail-soft: never throws into the cycle; on no-route or
 *    nothing-to-sell it DMs the operator that a top-up is needed.
 */
async function maybeRefuel(agent: MagpieAgent, guardian: LoanGuardian, notifier: Notifier): Promise<void> {
  const floor = cfg.minOperatingLamports;
  if (floor <= 0n) return;
  let deployable: bigint;
  try {
    deployable = await guardian.deployableLamports();
  } catch {
    return; // can't tell — don't sell blindly
  }
  if (deployable >= floor) return; // healthy free-SOL buffer

  const self = agent.publicKey();
  if (!self) return;
  let tokens: Awaited<ReturnType<MagpieAgent["collateralCatalog"]>>["tokens"];
  let held: Awaited<ReturnType<typeof getExistingCollateral>>;
  try {
    tokens = (await agent.collateralCatalog()).tokens;
    held = await getExistingCollateral(new Connection(cfg.rpcUrl, "confirmed"), self, tokens);
  } catch (err) {
    log(`REFUEL — could not read holdings: ${(err as Error).message}`);
    return;
  }
  if (!held.length) {
    await notifier.send("error", `⚠️ LOW SOL — free balance ${fmt(deployable)} below the ${fmt(floor)} operating floor and NOTHING held to sell. Top up SOL so the agent stays live.`);
    return;
  }

  // Value every holding in SOL; sell the most valuable (most liquid) one.
  const taker = self.toBase58();
  const valued: Array<{ mint: string; symbol: string; amount: bigint; value: bigint }> = [];
  for (const h of held) {
    try {
      const v = await jupiterValueInSol({ inputMint: h.mint, amountBaseUnits: BigInt(h.amount), taker });
      if (v && v > 0n) valued.push({ mint: h.mint, symbol: h.symbol, amount: BigInt(h.amount), value: v });
    } catch { /* unpriceable — skip */ }
  }
  if (!valued.length) {
    await notifier.send("error", `⚠️ LOW SOL and held tokens are unpriceable on Jupiter — can't auto-refuel. Top up SOL.`);
    return;
  }
  valued.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const pick = valued[0];

  // Sell just enough to reach the target (deficit + 5% headroom), capped at the
  // whole position — never dump the basket.
  const target = cfg.refuelTargetLamports > floor ? cfg.refuelTargetLamports : floor * 6n;
  const need = target - deployable; // > 0 here
  const sellValue = need * 105n / 100n >= pick.value ? pick.value : (need * 105n) / 100n;
  const sellAmount = sellValue >= pick.value ? pick.amount : (pick.amount * sellValue) / pick.value;
  if (sellAmount <= 0n) return;

  await notifier.send("info", `🔻 Auto-refuel: free SOL ${fmt(deployable)} < floor ${fmt(floor)}. Selling ~${fmt(sellValue)}◎ of held ${pick.symbol} so the agent stays live.`);
  const sell = await jupiterSell({
    payer: agentKeypair(),
    inputMint: pick.mint,
    amountBaseUnits: sellAmount,
    rpcUrl: cfg.rpcUrl,
    dryRun: cfg.dryRun,
    slippageBps: 150,
  });
  if (!sell.ok) {
    await notifier.send("warn", `Auto-refuel sell of ${pick.symbol} failed: ${sell.reason}. Retrying next cycle; top up if it persists.`);
    return;
  }
  await notifier.send("buy", `✅ Refueled: sold ${pick.symbol} → +${fmt(sell.outLamports ?? 0n)}◎${sell.signature ? ` (tx ${sell.signature})` : ""}. Never-stale invariant holding.`);
}

interface Candidate {
  mint: string;
  symbol: string;
  category: string;
  /** Raw u64 collateral amount when the wallet ALREADY holds this (no buy needed). */
  existingAmount?: string;
}

/** Safe candidate selection: existing holdings + allowlist/open-universe, risk gated. */
async function chooseCandidate(agent: MagpieAgent, notifier: Notifier, guardian: LoanGuardian): Promise<Candidate | null> {
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

  // COST CONTROL (keep-costs-low) — if the wallet can't afford a fresh buy that
  // clears the collateral floor, DROP the buy candidates so the brain must
  // recycle a token the wallet ALREADY holds (no buy = ~free, just fees). This
  // keeps the agent active + cheap on a small balance instead of burning every
  // cycle trying to buy collateral it can't afford. Only kicks in when there's
  // actually something held to recycle; otherwise the normal buy/skip path runs.
  if (buyPool.length && heldCandidates.length) {
    try {
      const deployable = await guardian.deployableLamports();
      let buyLamports = (deployable * 9n) / 10n;
      if (cfg.maxBuyLamports > 0n && buyLamports > cfg.maxBuyLamports) buyLamports = cfg.maxBuyLamports;
      const canAffordFreshBuy = cfg.minCollateralLamports <= 0n || buyLamports >= cfg.minCollateralLamports;
      if (!canAffordFreshBuy) {
        log(`COST — can't afford a fresh buy ≥ min collateral (${fmt(buyLamports)} < ${fmt(cfg.minCollateralLamports)} SOL); recycling held basket only this cycle (${heldCandidates.length} held).`);
        buyPool = [];
      }
    } catch { /* if deployable can't be read, leave buys enabled (fail-open) */ }
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

  // VARIETY — don't borrow against the same collateral every cycle. Exclude the
  // most-recently-used mint(s) so consecutive loans rotate across the eligible
  // set (BOME → POPCAT → … instead of BOME every time). Capped at pool.length-1
  // so the menu is never emptied — a single-token wallet still borrows.
  const avoidN = Math.min(VARIETY_AVOID_LAST, pool.length - 1);
  const avoid = new Set(avoidN > 0 ? recentCollateral.slice(-avoidN) : []);
  const varied = pool.filter((t) => !avoid.has(t.mint));
  const menu = varied.length ? varied : pool;
  if (avoid.size && menu.length < pool.length) {
    log(`VARIETY — rotating off ${pool.length - menu.length} recently-used collateral; ${menu.length} option(s) this cycle.`);
  }

  // BRAIN — Claude proposes from the (variety-filtered) menu and may say HOLD; on
  // any failure or no key, fall back to the deterministic first pick (held-first).
  let pick = menu[0];
  if (brainEnabled()) {
    try {
      const decision = await chooseCandidateWithClaude(agent, cfg, menu);
      log(`BRAIN(Claude) — ${decision.action.toUpperCase()}${decision.symbol ? " " + decision.symbol : ""} · conf ${decision.confidence.toFixed(2)} · ${decision.reasoning}`);
      await notifier.send("brain", `Claude: ${decision.action.toUpperCase()}${decision.symbol ? " " + decision.symbol : ""} (conf ${decision.confidence.toFixed(2)}) — ${decision.reasoning}`);
      if (decision.action !== "buy" || !decision.mint) return null; // HOLD is a valid, safe outcome
      const chosen = menu.find((t) => t.mint === decision.mint);
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
  // Remember this cycle's collateral so the next cycle rotates off it (bounded ring).
  recentCollateral.push(pick.mint);
  if (recentCollateral.length > 16) recentCollateral.shift();
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
