/**
 * 10 — Equity-leverage reference agent (Premium Tier).
 *
 * NOTE: Premium Tier is in active build at the time this example
 * lands in the repo. The endpoints + tx-construction logic below
 * work TODAY for any collateral in the standard catalog; for the
 * tokenized-equity whitelist (NVDAx/COINx/TSLAx/AAPLx/MSFTx) the
 * borrow will be ACCEPTED by x402 but REJECTED at the program level
 * until v3 ships and the equity track is enabled. Run the script
 * with a standard catalog mint today to validate the flow; swap to
 * an equity mint on Premium Tier launch day to go live.
 *
 * The use case:
 *
 *   You hold tokenized US equities ($NVDAx, $COINx, $TSLAx, $AAPLx,
 *   $MSFTx) and want SOL liquidity WITHOUT selling. Selling triggers
 *   capital gains tax and closes your position. Borrowing against
 *   the equity preserves both.
 *
 * The strategy this agent implements:
 *
 *   1. Read the live equity price + current SOL price.
 *   2. Borrow SOL at the maximum safe LTV (40-45% for equity track).
 *   3. Post a conditional repay intent: "buy SOL back to repay if
 *      equity price drops > X%". This automates the deleveraging
 *      decision before liquidation health gets concerning.
 *   4. Hold the SOL for whatever your downstream use is — deploy
 *      to another protocol, fund agent ops, etc.
 *
 *   When the equity price recovers or the loan nears its 15/30-day
 *   term, the agent calls build-repay. Position closes, equity
 *   tokens return to wallet, no taxable event ever occurred.
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   COLLATERAL_MINT=<equity-token-mint> \
 *   COLLATERAL_DECIMALS=<n> \
 *   COLLATERAL_AMOUNT_RAW=<u64-string> \
 *   EQUITY_PRICE_USD=<current-equity-price> \
 *   SOL_PRICE_USD=<current-sol-price> \
 *     npx tsx examples/10-equity-leverage-bot.ts
 *
 * Pricing inputs are explicit because there's no on-chain oracle for
 * equities today — the trader is expected to plug in their own
 * pricing source (Pyth, Switchboard, or off-chain DEX quote). The
 * x402 simulate-borrow endpoint then runs the LTV/fee math.
 */
import { resolve } from "node:path";
import { Connection, Transaction } from "@solana/web3.js";
import { loadKeypairFromFile, paidCall, freeGet } from "./lib/x402-client.js";

const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const payerPath = process.env.X402_PAYER_KEYPAIR;
const collateralMint = process.env.COLLATERAL_MINT;
const collateralDecimals = Number(process.env.COLLATERAL_DECIMALS ?? "6");
const collateralAmountRaw = process.env.COLLATERAL_AMOUNT_RAW;
const equityPriceUsd = process.env.EQUITY_PRICE_USD;
const solPriceUsd = process.env.SOL_PRICE_USD;

if (!payerPath || !collateralMint || !collateralAmountRaw || !equityPriceUsd || !solPriceUsd) {
  console.error(
    "Required env: X402_PAYER_KEYPAIR, COLLATERAL_MINT, COLLATERAL_AMOUNT_RAW, " +
      "EQUITY_PRICE_USD, SOL_PRICE_USD. COLLATERAL_DECIMALS defaults to 6.",
  );
  process.exit(1);
}

const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));
const connection = new Connection(rpcUrl, "confirmed");

// ── Step 1: simulate the borrow (free, pure math) ──────────────────
console.log("─── 1. simulate-borrow (free) ───");
const sim = await freeGet<{
  tier: string;
  quotes?: Array<{
    tier: string;
    borrowableLamports: string;
    feeLamports: string;
    durationDays: number;
    ltvBps: number;
  }>;
}>(baseUrl, "/api/v1/simulate-borrow", {
  mint: collateralMint,
  amount: collateralAmountRaw,
  decimals: String(collateralDecimals),
  pricePerTokenUsd: equityPriceUsd,
  solPriceUsd: solPriceUsd,
  tier: "all",
});
console.log(JSON.stringify(sim, null, 2));

// The Premium equity track aims for the HIGHEST safe LTV (target 45%
// for 15-day, 40% for 30-day). On standard catalog mints (today) the
// max LTV is 30% (Express tier). Until Premium ships, this example
// falls back to whatever the highest available tier supports.
const quotes = sim.quotes ?? [];
if (quotes.length === 0) {
  console.error("simulate-borrow returned no quotes — check inputs");
  process.exit(1);
}
quotes.sort((a, b) => b.ltvBps - a.ltvBps);
const bestQuote = quotes[0];
console.log(
  `\n  → Best tier: ${bestQuote.tier} @ ${bestQuote.ltvBps / 100}% LTV, ` +
    `${Number(bestQuote.borrowableLamports) / 1e9} SOL borrowable, ` +
    `${bestQuote.durationDays}d term`,
);

// Tier index lookup. Anchor program tier indices:
//   0 = Express (highest LTV in standard tier today)
//   1 = Quick
//   2 = Standard
//   3 = Premium Equity 15d   (Premium Tier — pending v3 deploy)
//   4 = Premium Equity 30d   (Premium Tier — pending v3 deploy)
//   5 = Premium Memecoin     (Premium Tier — pending v3 deploy)
const tierIndex =
  { express: 0, quick: 1, standard: 2 }[bestQuote.tier.toLowerCase()] ?? 0;

// ── Step 2: build-borrow (paid 0.005 SOL) ──────────────────────────
console.log("\n─── 2. build-borrow (paid 0.005 SOL) ───");
console.log("    Building tx for", collateralAmountRaw, "raw collateral units...");
const built = await paidCall<{
  partial_signed_tx_b64: string;
  summary: { loanId: string; borrowableLamports: string; feeLamports: string };
  next_step: { url: string };
}>({ rpcUrl, payer, baseUrl }, "POST", "/api/v1/agent/build-borrow", {
  body: {
    borrower_wallet: payer.publicKey.toBase58(),
    collateral_mint: collateralMint,
    collateral_amount: collateralAmountRaw,
    tier: tierIndex,
  },
});
console.log(JSON.stringify(built.data.summary, null, 2));

// ── Step 3: sign and submit ────────────────────────────────────────
console.log("\n─── 3. sign + submit to cosign-borrow ───");
const txBytes = Buffer.from(built.data.partial_signed_tx_b64, "base64");
const tx = Transaction.from(txBytes);
tx.partialSign(payer);
const signedB64 = tx.serialize({ requireAllSignatures: false }).toString("base64");

const cosignRes = await fetch(built.data.next_step.url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ signed_tx_b64: signedB64 }),
});
const cosign = (await cosignRes.json()) as { signature?: string; error?: string };
if (cosign.error) {
  console.error("✗ cosign failed:", cosign.error);
  console.error(
    "  If this is a 'tier not enabled' rejection on an equity mint, you're " +
      "early — Premium Tier hasn't shipped yet. Run with a standard catalog " +
      "mint to validate the flow.",
  );
  process.exit(1);
}
console.log(`✓ Loan opened. tx: https://solscan.io/tx/${cosign.signature}`);

// ── Step 4: post a stop-loss intent (paid 0.01 SOL) ────────────────
// "If the equity price drops more than 10% from now, repay the loan
// automatically to avoid liquidation risk." This is the auto-deleverage
// safety wire — without it, a 30%+ price crash could put the position
// in liquidation territory before the human / agent owner notices.
console.log("\n─── 4. stop-loss intent (paid 0.01 SOL) ───");
const stopLossPriceUsd = (Number(equityPriceUsd) * 0.9).toFixed(2);
const intent = await paidCall<{
  intent_id: string;
  status: string;
  expires_at: string;
}>({ rpcUrl, payer, baseUrl }, "POST", "/api/v1/agent/intent", {
  body: {
    borrower_wallet: payer.publicKey.toBase58(),
    // Conditional REPAY intent is a planned variant; today this fires a
    // borrow on the condition. Adapt to your own intent shape when the
    // build-repay-conditional endpoint ships.
    collateral_mint: collateralMint,
    collateral_amount: collateralAmountRaw,
    tier: tierIndex,
    condition_type: "price_below",
    condition_params: { price_usd: stopLossPriceUsd, source: "jupiter" },
    expires_in_seconds: 30 * 86400, // 30 days
  },
});
console.log("Stop-loss intent posted:", intent.data);
console.log(
  `\nDone. The loan is open. The stop-loss watches at \$${stopLossPriceUsd}.`,
);
console.log("Next: hold or deploy the borrowed SOL; the stop-loss fires automatically.");
