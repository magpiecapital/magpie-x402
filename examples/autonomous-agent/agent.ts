/**
 * agent.ts — the orchestrator. Wires the four parts into one bounded agent:
 *
 *   BRAIN (pick) → BUY (Jupiter) → COLLATERALIZE (Magpie) → GUARD (never default)
 *
 * Safe by default (dry-run). The LoanGuardian starts FIRST and runs for the
 * whole process lifetime, so even pre-existing loans are protected immediately.
 * Run:
 *   # rehearse, free, nothing moves:
 *   MAGPIE_PAYER_KEYPAIR=~/id.json npx tsx examples/autonomous-agent/agent.ts
 *   # live (reads MINT_ALLOWLIST; spends real funds):
 *   LIVE=1 MINT_ALLOWLIST=<mint> MAGPIE_PAYER_KEYPAIR=~/id.json npx tsx examples/autonomous-agent/agent.ts
 */
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { MagpieAgent } from "@magpieloans/magpie-agent";
import { loadConfig } from "./config.js";
import { LoanGuardian } from "./loan-guardian.js";
import { jupiterBuy } from "./jupiter.js";
import { RULES, SYSTEM_PROMPT } from "./magpie-playbook.js";

const log = (s = "") => console.log(s);
const cfg = loadConfig();

/** ESM-safe keypair load (mirrors example 11; avoids the lib helper's require()). */
function loadKeypair(path: string): Keypair {
  const p = path.replace(/^~/, process.env.HOME || "");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8")) as number[]));
}

async function main() {
  const payerPath = process.env.MAGPIE_PAYER_KEYPAIR ?? process.env.X402_PAYER_KEYPAIR;
  if (!payerPath) throw new Error("Set MAGPIE_PAYER_KEYPAIR to the agent wallet's keypair JSON path.");
  const keypair = loadKeypair(payerPath);
  const agent = new MagpieAgent({ keypair, rpcUrl: cfg.rpcUrl, baseUrl: cfg.baseUrl });

  log("╔═══════════════════════════════════════════════════════════╗");
  log("║   Magpie autonomous agent — never-default by design        ║");
  log("╚═══════════════════════════════════════════════════════════╝");
  log(cfg.dryRun ? "MODE: 🟢 DRY RUN — no funds move." : "MODE: 🔴 LIVE — real funds.");
  log(`Agent wallet: ${keypair.publicKey.toBase58()}`);
  log(`Rule #1 — liquidation is ${RULES.liquidation.trigger} ${RULES.liquidation.implication}`);
  log("");

  // ── GUARD FIRST: protect any open loans before we do anything else. ───────
  const guardian = new LoanGuardian(agent, cfg);
  guardian.start();

  // ── one decision cycle (a real deployment loops this) ────────────────────
  await runCycle(agent, guardian);

  if (cfg.dryRun) {
    log("\n🟢 Dry run complete. The guardian also did one deadline sweep above. Set LIVE=1 (and MINT_ALLOWLIST) to act.");
    guardian.stop();
    return;
  }
  // LIVE: leave the guardian running forever so no loan can ever go overdue.
  log("\n🔴 Cycle done. Guardian is running — it will repay every loan well before its deadline. Ctrl-C to stop.");
}

async function runCycle(agent: MagpieAgent, guardian: LoanGuardian) {
  // 1) BRAIN — choose a candidate. Replace this with an LLM (Claude SDK / agent
  //    kit) fed SYSTEM_PROMPT; for the scaffold it's a safe, deterministic pick.
  void SYSTEM_PROMPT; // ← give this to your LLM brain so it understands Magpie
  const candidate = await chooseCandidate(agent);
  if (!candidate) {
    log("BRAIN — no eligible candidate (empty allowlist in live, or none passed the risk gate). Doing nothing.");
    return;
  }
  log(`BRAIN — candidate: ${candidate.symbol} (${candidate.mint}) [${candidate.category}]`);

  // 2) SOLVENCY — only ever spend what the guardian says is free (never the reserve).
  const deployable = await guardian.deployableLamports();
  const buyLamports = (deployable * 9n) / 10n; // keep 10% headroom on top of the reserve
  log(`SOLVENCY — deployable ${fmt(deployable)} SOL; will buy with ${fmt(buyLamports)} SOL (reserve + gas held back).`);
  if (buyLamports <= 0n) {
    log("SOLVENCY — nothing deployable while keeping repay reserves. Holding. (This is the never-default invariant doing its job.)");
    return;
  }

  // 3) BUY on Jupiter (Magpie can't — it's a lender, not a DEX).
  const buy = await jupiterBuy({
    payer: agentKeypair(agent),
    outputMint: candidate.mint,
    amountLamports: buyLamports,
    rpcUrl: cfg.rpcUrl,
    dryRun: cfg.dryRun,
  });
  if (!buy.ok) {
    log(`BUY — skipped/failed: ${buy.reason}`);
    return;
  }
  log(`BUY — ${cfg.dryRun ? "quote" : "bought"} ${buy.outAmount ?? "?"} ${candidate.symbol}${buy.signature ? ` (tx ${buy.signature})` : ""}.`);

  // 4) COLLATERALIZE on Magpie — but ONLY through safeBorrow, which refuses if
  //    it can't honor the resulting deadline, and registers the loan + reserve.
  const collateralAmount = buy.outAmount ?? "0";
  const loan = await guardian.safeBorrow({ collateralMint: candidate.mint, collateralAmount });

  // 5) ARM EXITS (best-effort convenience, NOT a safety net) — live + V4 only.
  if (loan && cfg.useV4Exits && !cfg.dryRun) {
    try {
      await agent.armExit({ loanId: loan.loanId, direction: "above", target: "2x", slippageBps: 100 });
      await agent.armExit({ loanId: loan.loanId, direction: "below", target: "0.7x", slippageBps: 150 });
      log("ARM — in-vault TP @2x / SL @0.7x armed (best-effort; the guardian, not the SL, is what prevents default).");
    } catch (err) {
      log(`ARM — skipped: ${(err as Error).message}`);
    }
  }

  // 6) DEPLOY — by policy the borrowed SOL is HELD as repay reserve, not re-risked.
  if (cfg.allowRecursiveRedeploy) {
    log("DEPLOY — ⚠️ recursive redeploy is ENABLED (higher risk). The guardian still gates spend by the reserve.");
  } else {
    log("DEPLOY — borrowed SOL held idle as repay reserve (no re-leverage). The guardian will repay before the deadline.");
  }
}

/** Safe candidate selection: allowlist-first, eligibility + risk gated. */
async function chooseCandidate(
  agent: MagpieAgent,
): Promise<{ mint: string; symbol: string; category: string } | null> {
  const { tokens } = await agent.collateralCatalog();
  const byMint = new Map(tokens.map((t) => [t.mint, t]));

  // Catalog categories are fine-grained (memecoin | stock | etf | metal | …),
  // so "rwa" means "anything that isn't a memecoin".
  const matches = (cat: string) =>
    cfg.preferredCategory === "any" ||
    (cfg.preferredCategory === "memecoin" ? cat === "memecoin" : cat !== "memecoin");

  // Live: ONLY mints you explicitly allowlisted. Dry-run with no allowlist:
  // auto-pick one of the preferred category just to illustrate the flow.
  let pool: Array<{ mint: string; symbol: string; decimals: number; category: string }>;
  if (cfg.mintAllowlist.length) {
    pool = cfg.mintAllowlist.map((m) => byMint.get(m)).filter(Boolean) as typeof tokens;
    const pref = pool.filter((t) => matches(t.category));
    if (pref.length) pool = pref; // prefer the category among allowlisted, else use all allowlisted
  } else if (cfg.dryRun) {
    pool = tokens.filter((t) => matches(t.category));
  } else {
    pool = []; // live + no allowlist → buy nothing
  }
  const pick = pool[0];
  if (!pick) return null;

  // Risk gate (paid 0.001 SOL) — only spend on it when live.
  if (!cfg.dryRun) {
    try {
      const risk = await agent.tokenRisk(pick.mint);
      const score = Number((risk as { risk_score?: number }).risk_score ?? 100);
      if (score > cfg.maxTokenRisk) {
        log(`BRAIN — ${pick.symbol} risk ${score} > max ${cfg.maxTokenRisk}; rejecting.`);
        return null;
      }
    } catch (err) {
      log(`BRAIN — token-risk check failed, refusing to buy blind: ${(err as Error).message}`);
      return null;
    }
  }
  return { mint: pick.mint, symbol: pick.symbol, category: pick.category };
}

// The SDK keeps the keypair private; for the Jupiter leg we need to sign
// directly, so re-load it the same way the agent did.
function agentKeypair(_agent: MagpieAgent) {
  return loadKeypair((process.env.MAGPIE_PAYER_KEYPAIR ?? process.env.X402_PAYER_KEYPAIR)!);
}

const fmt = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);

main().catch((e) => {
  console.error("\n✗ agent error:", e?.message ?? e);
  process.exit(1);
});
