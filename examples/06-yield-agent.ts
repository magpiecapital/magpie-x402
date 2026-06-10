/**
 * 06 — Yield agent (full LP loop).
 *
 * Loop:
 *   (1) FREE   GET  /api/v1/agent/lp-state?wallet=… — current position
 *   (2) FREE   GET  /api/v1/agent/protocol-pulse     — pool health
 *   (3) PAID   POST /api/v1/agent/build-deposit      — build deposit tx
 *               or POST /api/v1/agent/build-withdraw — build withdraw tx
 *   (4) sign + submit locally
 *
 * A real yield agent runs this on a schedule, only deposits when idle
 * SOL exceeds a threshold, and only withdraws when (e.g.) the pool
 * utilization drops below a floor that signals reduced yield. This
 * example just shows the mechanics — fork and add your trigger logic.
 *
 * Run (deposit 0.1 SOL):
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/06-yield-agent.ts deposit 100000000
 *
 * Run (withdraw 50000000 shares):
 *   npx tsx examples/06-yield-agent.ts withdraw 50000000
 *
 * Run (read-only — just show current position):
 *   npx tsx examples/06-yield-agent.ts status
 */
import { resolve } from "node:path";
import { Connection, Transaction } from "@solana/web3.js";
import { loadKeypairFromFile, paidCall, freeGet } from "./lib/x402-client.js";

const action = process.argv[2];
const amount = process.argv[3];
if (!["deposit", "withdraw", "status"].includes(action ?? "")) {
  console.error("Usage: npx tsx examples/06-yield-agent.ts <deposit|withdraw|status> [amount]");
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
const wallet = payer.publicKey.toBase58();

console.log("─── current LP position (free) ───");
const state = await freeGet<{
  has_position: boolean;
  shares?: string;
  deposited_lamports?: string;
  current_value_lamports?: string;
  yield_lamports?: string;
  share_of_pool_pct?: number;
  pool: { total_deposits: number; total_shares: number; utilization_rate: number } | null;
}>(baseUrl, "/api/v1/agent/lp-state", { wallet });
console.log(JSON.stringify(state, null, 2));

if (action === "status") process.exit(0);
if (!amount || !/^\d+$/.test(amount)) {
  console.error("Provide a u64 amount for deposit (lamports) or withdraw (shares).");
  process.exit(1);
}

const path = action === "deposit" ? "/api/v1/agent/build-deposit" : "/api/v1/agent/build-withdraw";
const body =
  action === "deposit"
    ? { depositor: wallet, lamports: amount }
    : { depositor: wallet, shares: amount };

console.log(`─── ${action} (paid 0.002 SOL) ───`);
const built = await paidCall<{ partial_signed_tx_b64: string; summary: unknown }>(
  { rpcUrl, payer, baseUrl },
  "POST",
  path,
  { body },
);
console.log("summary:", built.data.summary);

console.log("─── signing + submitting locally ───");
const tx = Transaction.from(Buffer.from(built.data.partial_signed_tx_b64, "base64"));
const connection = new Connection(rpcUrl, "confirmed");
tx.partialSign(payer);
const sig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction(sig, "confirmed");
console.log(`✓ ${action} submitted. tx: https://solscan.io/tx/${sig}`);
