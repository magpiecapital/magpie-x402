/**
 * 09 — Webhook receiver for intent.matched events.
 *
 * Starts a tiny HTTPS server that:
 *   1. Creates a conditional borrow intent with webhook_url pointing
 *      at itself
 *   2. Verifies every incoming POST with HMAC-SHA256 + constant-time
 *      compare
 *   3. Logs the matched intent data (in a real agent, you'd sign +
 *      submit the partial_signed_tx_b64 here)
 *
 * No polling — costs you 0.01 SOL for the intent and 0 SOL after.
 * Compare to the polling pattern (0.0005 SOL per 30s poll, can add
 * up to 0.06 SOL/hr).
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   WEBHOOK_PUBLIC_URL=https://my-tunnel-domain.example/intent \
 *     npx tsx examples/09-webhook-receiver.ts <COLLATERAL_MINT>
 *
 * WEBHOOK_PUBLIC_URL must be HTTPS and externally reachable. For
 * local testing, use ngrok / cloudflared / tailscale-funnel to
 * expose port 3030 to the public internet.
 */
import { resolve } from "node:path";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadKeypairFromFile, paidCall } from "./lib/x402-client.js";

const mint = process.argv[2];
if (!mint) {
  console.error("Usage: npx tsx examples/09-webhook-receiver.ts <COLLATERAL_MINT>");
  process.exit(1);
}

const payerPath = process.env.X402_PAYER_KEYPAIR;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const webhookPublicUrl = process.env.WEBHOOK_PUBLIC_URL;
if (!payerPath || !webhookPublicUrl) {
  console.error(
    "Set X402_PAYER_KEYPAIR + WEBHOOK_PUBLIC_URL (HTTPS, externally reachable).",
  );
  process.exit(1);
}
const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));

// ── Create the intent FIRST so we have webhook_secret to verify with ──
console.log("─── Creating intent with webhook_url ───");
const create = await paidCall<{
  intent_id: string;
  status: string;
  expires_at: string;
  webhook?: {
    url: string;
    secret: string;
    signature_header: string;
    signature_alg: string;
    retry_policy: string;
  };
}>({ rpcUrl, payer, baseUrl }, "POST", "/api/v1/agent/intent", {
  body: {
    borrower_wallet: payer.publicKey.toBase58(),
    collateral_mint: mint,
    collateral_amount: "1000000",
    tier: 0,
    condition_type: "price_below",
    condition_params: { price_usd: "0.95", source: "jupiter" },
    expires_in_seconds: 86400,
    webhook_url: webhookPublicUrl,
  },
});
console.log(JSON.stringify(create.data, null, 2));
if (!create.data.webhook) {
  console.error("Server didn't return webhook block — check that webhook_url was accepted.");
  process.exit(1);
}

const webhookSecret = create.data.webhook.secret;
const expectedIntentId = create.data.intent_id;
console.log(`\n─── Listening for HMAC-signed POST on /intent ───`);
console.log(`    Public URL: ${webhookPublicUrl}`);
console.log(`    Local port: 3030\n`);

// ── HMAC verification + constant-time compare ──────────────────────
function verify(body: Buffer, signatureHex: string): boolean {
  if (typeof signatureHex !== "string" || signatureHex.length !== 64) return false;
  const expected = createHmac("sha256", webhookSecret).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signatureHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Tiny HTTP server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/intent") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const sig = (req.headers["x-magpie-signature"] || "") as string;
    if (!verify(body, sig)) {
      console.warn(`[webhook] rejected — bad signature (sig=${sig.slice(0, 16)}…)`);
      res.writeHead(401, { "Content-Type": "application/json" }).end(
        JSON.stringify({ error: "bad_signature" }),
      );
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (payload.intent_id !== expectedIntentId) {
      console.warn(`[webhook] rejected — intent_id mismatch`);
      res.writeHead(404).end();
      return;
    }
    console.log(`✓ verified webhook for ${payload.intent_id}`);
    console.log(`  status: ${payload.status}`);
    console.log(`  matched_at: ${payload.matched_at}`);
    console.log(`  summary:`, payload.summary);
    console.log(`  partial_signed_tx_b64: ${(payload.partial_signed_tx_b64 as string)?.slice(0, 32)}…`);
    console.log(`\n  Next: sign the tx with the borrower wallet and POST to /api/v1/cosign-borrow`);

    // Acknowledge with 2xx so the server marks delivered.
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ received: true }),
    );

    // Gracefully exit — this example handles one match.
    setTimeout(() => process.exit(0), 100);
  });
});

server.listen(3030, () => {
  console.log("(serving on :3030 — tunnel this to WEBHOOK_PUBLIC_URL)");
});
