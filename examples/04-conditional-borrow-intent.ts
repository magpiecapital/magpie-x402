/**
 * 04 — Conditional borrow intent ("limit order for a loan").
 *
 * Single paid POST registers an intent that fires when the condition
 * matches. The bot watches for the trigger; when met, polling reveals
 * a ready-to-sign tx. Closest thing in DeFi to a stop-buy for borrowing.
 *
 * Conditions supported (see /.well-known/x402.json for current list):
 *   price_above  { mint, price_usd, source? }
 *   price_below  { mint, price_usd, source? }
 *   time_after   { unix_seconds }
 *   pool_liq_above { lamports }
 *
 * Pricing:
 *   POST  create  0.01    SOL (covers gate runs + final tx build)
 *   GET   poll    0.0005  SOL (cheap so 30s polling is affordable)
 *   DELETE cancel free
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/04-conditional-borrow-intent.ts <COLLATERAL_MINT>
 */
import { resolve } from "node:path";
import { loadKeypairFromFile, paidCall } from "./lib/x402-client.js";

const mint = process.argv[2];
if (!mint) {
  console.error("Usage: npx tsx examples/04-conditional-borrow-intent.ts <COLLATERAL_MINT>");
  process.exit(1);
}

const payerPath = process.env.X402_PAYER_KEYPAIR;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const payer = loadKeypairFromFile(resolve(payerPath!.replace(/^~/, process.env.HOME || "")));

// Example: "borrow against 1000000 raw units of <mint> at Express tier
//           the moment the token's USD price drops below $0.95"
const create = await paidCall<{ intent_id: string; status: string; expires_at: string }>(
  { rpcUrl, payer, baseUrl },
  "POST",
  "/api/v1/agent/intent",
  {
    body: {
      borrower_wallet: payer.publicKey.toBase58(),
      collateral_mint: mint,
      collateral_amount: "1000000",
      tier: 0,
      condition_type: "price_below",
      condition_params: { price_usd: "0.95", source: "jupiter" },
      expires_in_seconds: 86400,
    },
  },
);
console.log("intent created:", create.data);

// Poll until matched/expired/cancelled. Each poll is paid 0.0005 SOL.
let status = create.data.status;
while (!["matched", "expired", "cancelled"].includes(status)) {
  await new Promise((r) => setTimeout(r, 30_000));
  const poll = await paidCall<{
    status: string;
    partial_signed_tx_b64?: string;
    summary?: Record<string, unknown>;
  }>({ rpcUrl, payer, baseUrl }, "GET", "/api/v1/agent/intent", {
    query: { id: create.data.intent_id },
  });
  status = poll.data.status;
  console.log(`[${new Date().toISOString()}] status=${status}`);
  if (status === "matched") {
    console.log("matched! summary:", poll.data.summary);
    console.log(
      "next: sign poll.data.partial_signed_tx_b64 with your wallet, then POST to cosign-borrow",
    );
  }
}
