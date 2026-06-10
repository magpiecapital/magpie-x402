/**
 * 03 — Agent borrow flow (simulate → build → sign → submit).
 *
 * End-to-end demonstration of the agent borrow path. Three steps:
 *
 *   (1) FREE   GET  /api/v1/simulate-borrow      — preview the loan terms
 *   (2) PAID   POST /api/v1/agent/build-borrow   — server runs every gate
 *                                                  and returns an unsigned
 *                                                  partial-signed tx
 *   (3) FREE   POST magpie.capital/api/v1/cosign-borrow
 *                                                — lender adds final
 *                                                  signature + submits
 *
 * The agent never trusts the server with its keypair — the server only
 * gets PUBLIC information (wallet, mint, amount, tier). Final signature
 * is added by the agent locally.
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/03-agent-borrow.ts <COLLATERAL_MINT> <RAW_AMOUNT> <TIER>
 *
 * Example (1.0 token of decimals=6, Express tier):
 *   npx tsx examples/03-agent-borrow.ts <MINT_ADDRESS> 1000000 0
 */
import { resolve } from "node:path";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { loadKeypairFromFile, paidCall, freeGet } from "./lib/x402-client.js";

const [mint, amount, tierStr] = process.argv.slice(2);
const tier = Number(tierStr);
if (!mint || !amount || ![0, 1, 2].includes(tier)) {
  console.error(
    "Usage: npx tsx examples/03-agent-borrow.ts <COLLATERAL_MINT> <RAW_AMOUNT> <TIER 0|1|2>",
  );
  process.exit(1);
}

const payerPath = process.env.X402_PAYER_KEYPAIR;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
if (!payerPath) {
  console.error("Set X402_PAYER_KEYPAIR to a keypair JSON file path");
  process.exit(1);
}
const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));

console.log("─── Step 1 · simulate-borrow (free) ───");
// Agent supplies its own prices — server returns pure math against the
// public tier constants. Use this to choose a tier before paying.
const sim = await freeGet<{
  tier: string;
  quotes?: Array<{ tier: string; borrowableLamports: string; feeLamports: string; durationDays: number }>;
}>(baseUrl, "/api/v1/simulate-borrow", {
  mint,
  amount,
  decimals: "6", // assumes 6-dec token; adjust as needed
  pricePerTokenUsd: "1.0", // plug in real price
  solPriceUsd: "150", // plug in real price
  tier: "all",
});
console.log(JSON.stringify(sim, null, 2));

console.log("─── Step 2 · build-borrow (paid 0.005 SOL) ───");
const built = await paidCall<{
  partial_signed_tx_b64: string;
  summary: { loanId: string; borrowableLamports: string; feeLamports: string };
  next_step: { method: string; url: string };
}>({ rpcUrl, payer, baseUrl }, "POST", "/api/v1/agent/build-borrow", {
  body: {
    borrower_wallet: payer.publicKey.toBase58(),
    collateral_mint: mint,
    collateral_amount: amount,
    tier,
  },
});
console.log(JSON.stringify(built.data.summary, null, 2));

console.log("─── Step 3 · sign + submit to cosign-borrow ───");
const txBytes = Buffer.from(built.data.partial_signed_tx_b64, "base64");
const tx = Transaction.from(txBytes);
tx.partialSign(payer);
const signedB64 = tx.serialize({ requireAllSignatures: false }).toString("base64");

const cosignUrl = built.data.next_step?.url ?? "https://magpie.capital/api/v1/cosign-borrow";
const cosignRes = await fetch(cosignUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ signed_tx_b64: signedB64 }),
});
const cosignJson = (await cosignRes.json()) as { signature?: string; error?: string };
console.log(JSON.stringify(cosignJson, null, 2));

if (cosignJson.signature) {
  console.log(`\n✓ Loan opened. View tx: https://solscan.io/tx/${cosignJson.signature}`);
} else {
  console.log("\n✗ cosign failed — see error above");
}
