/**
 * 01 — Fetch a Magpie credit score for any Solana wallet (0.001 SOL per call).
 *
 * The simplest paid call: GET /api/v1/credit-score?wallet=<pubkey>.
 * Server returns 402 → client pays → retries → gets the score.
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/01-fetch-credit-score.ts <WALLET_PUBKEY>
 *
 * For a real agent, swap the wallet arg for whatever logic surfaces a
 * counterparty (a borrower applicant, a Solana wallet you encountered in
 * a transaction graph, an X-bio mention, …).
 */
import { resolve } from "node:path";
import { loadKeypairFromFile, paidCall } from "./lib/x402-client.js";

const wallet = process.argv[2];
if (!wallet) {
  console.error("Usage: npx tsx examples/01-fetch-credit-score.ts <WALLET_PUBKEY>");
  process.exit(1);
}

const payerPath = process.env.X402_PAYER_KEYPAIR;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
if (!payerPath) {
  console.error("Set X402_PAYER_KEYPAIR to a keypair JSON file path");
  process.exit(1);
}

const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));

const result = await paidCall<{
  wallet: string;
  score: number;
  tier: string;
  range: { min: number; max: number };
  benefits: { maxLtvPercent: number; minFeeRate: number; maxDurationDays: number };
  source: string;
}>({ rpcUrl, payer }, "GET", "/api/v1/credit-score", { query: { wallet } });

console.log(JSON.stringify(result.data, null, 2));
if (result.paid) {
  console.error(
    `[paid] ${Number(result.paid.amountLamports) / 1e9} SOL · tx ${result.paid.txSignature}`,
  );
}
