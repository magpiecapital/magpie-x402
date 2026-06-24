/**
 * demo-memecoin-borrow-live.ts
 * ─────────────────────────────────────────────────────────────────────────
 * "An AI agent borrows SOL against a memecoin — by itself, live."
 *
 * A narrated, camera-ready demo of the Magpie x402 flow. Every line it prints
 * IS the narration — run it in a terminal on screen and talk over it.
 *
 * SAFE BY DEFAULT. With no LIVE flag it runs ONLY free, read-only calls
 * (no wallet, no funds move) and shows exactly what it *would* do — perfect
 * for rehearsing on camera. Set LIVE=1 to actually pay the x402 fee, open a
 * real loan, and arm in-vault exits with real funds.
 *
 *   # Dry run — free, safe, no wallet needed:
 *   npx tsx examples/demo-memecoin-borrow-live.ts
 *
 *   # Live — spends ~0.006 SOL of x402 fees + opens a real loan:
 *   LIVE=1 MAGPIE_PAYER_KEYPAIR=~/.config/solana/id.json \
 *     npx tsx examples/demo-memecoin-borrow-live.ts [COLLATERAL_MINT] [RAW_AMOUNT]
 *
 * Env:
 *   MAGPIE_PAYER_KEYPAIR  (or X402_PAYER_KEYPAIR)  path to the agent's keypair JSON  (LIVE only)
 *   SOLANA_RPC_URL        Solana RPC                (default mainnet-beta)
 *   X402_BASE_URL         x402 service              (default https://x402.magpie.capital)
 */
import { freeGet, loadKeypairFromFile } from "./lib/x402-client.js";
// MagpieAgent is imported lazily inside the LIVE branch so the free dry-run
// runs with zero dependencies beyond this repo's own client.

const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const LIVE = process.env.LIVE === "1" || process.argv.includes("--live");
const payerPath = process.env.MAGPIE_PAYER_KEYPAIR ?? process.env.X402_PAYER_KEYPAIR;

// ── tiny narration helpers ───────────────────────────────────────────────
const log = (s = "") => console.log(s);
const step = (n: number, t: string) => console.log(`\n━━━━━ ${n} · ${t} ━━━━━`);
const sol = (lamports: unknown) => (Number(lamports) / 1e9).toFixed(4);
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
const pause = () => new Promise((r) => setTimeout(r, 900)); // a beat, for the camera

async function main() {
  log("╔════════════════════════════════════════════════════════════╗");
  log("║   Magpie x402 — an AI agent borrows against a memecoin      ║");
  log("╚════════════════════════════════════════════════════════════╝");
  log(
    LIVE
      ? "MODE: 🔴 LIVE — real funds will move."
      : "MODE: 🟢 DRY RUN — free reads only, nothing moves. (set LIVE=1 to go live)",
  );
  await pause();

  // ── 1 · proof of life (free, no wallet) ─────────────────────────────────
  step(1, "Is Magpie alive?  (free read — no signup, no key)");
  const pool: any = await freeGet(baseUrl, "/api/v1/pool");
  log(
    `  Live pool → TVL ${pool?.sol?.totalDeposits} SOL · borrowed ${pool?.sol?.totalBorrowed} SOL` +
      ` · ${pool?.counts?.loansIssuedLifetime} loans issued all-time`,
  );
  log("  → The agent just queried real on-chain state with one HTTP call. No account.");
  await pause();

  // ── 2 · pick a memecoin to borrow against (free) ────────────────────────
  step(2, "What can the agent borrow against?  (free collateral catalog)");
  // Only user args (skip node/tsx/script paths), and a mint is base58 — no '/' or '.'.
  const userArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const argMint = userArgs.find(
    (a) => a.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(a),
  );
  const catalog: any = await freeGet(baseUrl, "/api/v1/collateral/eligible");
  const tokens: any[] = catalog?.tokens ?? catalog?.collateral ?? [];
  const memecoins = tokens.filter((t) => (t.category ?? "memecoin") === "memecoin");
  const pick = argMint ? tokens.find((t) => t.mint === argMint) : memecoins[0];
  if (!pick) {
    log("  No memecoin collateral found in the catalog. Pass a mint explicitly to override.");
    process.exit(1);
  }
  log(
    `  ${memecoins.length} memecoins + ${tokens.length - memecoins.length} other assets are eligible right now.`,
  );
  log(`  Agent picks:  ${pick.symbol}   ${short(pick.mint)}   (decimals ${pick.decimals ?? 6})`);
  log("  → A free quote is one call away too:  GET /api/v1/simulate-borrow");
  await pause();

  // ── 3 · borrow + arm exits ──────────────────────────────────────────────
  const rawAmount = userArgs.find((a) => /^\d+$/.test(a)) ?? "1000000000";

  if (!LIVE) {
    step(3, "Borrow against it  (SKIPPED — dry run)");
    log("  In LIVE mode the agent would now, entirely on its own:");
    log("    1. Pay a ~0.005 SOL x402 fee — it pays its OWN way (no human, no card)");
    log("    2. Get back an unsigned borrow tx and sign it with its OWN wallet");
    log("    3. Receive SOL in its wallet; the memecoin is locked as collateral");
    log("    4. Arm an in-vault take-profit @2× and stop-loss @0.7× on the loan");
    log("    5. Keep its bag the whole time — only a borrower-signed repay releases it");
    log("");
    log("  ▶ Go live (real funds):");
    log("    LIVE=1 MAGPIE_PAYER_KEYPAIR=~/.config/solana/id.json \\");
    log(`      npx tsx examples/demo-memecoin-borrow-live.ts ${pick.mint} ${rawAmount}`);
    log("\n🟢 Dry run complete — the read path is fully live and free.");
    return;
  }

  if (!payerPath) {
    log("\n  LIVE mode needs a funded keypair. Set MAGPIE_PAYER_KEYPAIR to its JSON file.");
    process.exit(1);
  }
  const keypair = loadKeypairFromFile(payerPath.replace(/^~/, process.env.HOME || ""));
  const { MagpieAgent } = await import("@magpieloans/magpie-agent");
  const agent = new MagpieAgent({ keypair, rpcUrl });
  log(`\n  Agent wallet (the borrower):  ${keypair.publicKey.toBase58()}`);

  step(3, "Borrow against the memecoin  (the agent pays its own x402 fee)");
  const loan: any = await agent.borrow({
    collateralMint: pick.mint,
    collateralAmount: BigInt(rawAmount),
    tier: "express",
    hasExitArming: true, // route to V4 so we can arm in-vault exits
  });
  log(`  ✓ Borrowed ${sol(loan.borrowedLamports)} SOL  ·  loan ${loan.loanId}`);
  if (loan.signature) log(`    on-chain: https://solscan.io/tx/${loan.signature}`);
  await pause();

  step(4, "Arm in-vault exits  (take-profit @2×, stop-loss @0.7×)");
  const tp: any = await agent.armExit({
    loanId: loan.loanId,
    direction: "above",
    target: "2x",
    slippageBps: 100,
  });
  const sl: any = await agent.armExit({
    loanId: loan.loanId,
    direction: "below",
    target: "0.7x",
    slippageBps: 150,
  });
  log(`  ✓ Armed take-profit (${tp?.order?.id ?? "ok"}) and stop-loss (${sl?.order?.id ?? "ok"}).`);
  log("    They fire IN-VAULT: the loan stays Active, proceeds accrue in the loan's own");
  log("    vault, and only a borrower-signed repay ever releases funds to the wallet.");

  step(5, "Done — fully autonomous");
  log("  The agent borrowed SOL against a memecoin, kept its bag, and set its own exits.");
  log("  To unwind later it repays with one call:  await agent.repay({ loanPda })");
  log("\n🔴 Live demo complete.");
}

main().catch((e) => {
  console.error("\n✗ demo failed:", e?.message ?? e);
  process.exit(1);
});
