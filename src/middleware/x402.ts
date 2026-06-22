import type { Context, MiddlewareHandler } from "hono";
import { PublicKey } from "@solana/web3.js";
import { verifyPayment } from "../lib/solana.js";
import { mintNonce, verifyNonce, NONCE_TTL_MS } from "../lib/hmac-nonce.js";

/**
 * x402 — HTTP 402 Payment Required middleware (Solana, HMAC-nonces).
 *
 * Why this implementation is faster + more scalable than the
 * common in-memory-map pattern:
 *   - STATELESS nonces (HMAC-signed) → any function instance can
 *     validate any challenge. Vercel scales horizontally without
 *     breaking validation.
 *   - PAYMENT-TX DEDUP via in-process Map keyed by the on-chain
 *     signature (much smaller surface than nonce dedup; signature
 *     uniqueness is enforced by Solana itself).
 *   - PER-ENDPOINT BINDING — the endpoint path is HMAC'd into the
 *     nonce, so a payment for /credit-score can't satisfy a /pool
 *     request even if both happen to be the same amount.
 *
 * Flow:
 *   1. Client → GET /endpoint without X-Payment header
 *   2. Server → 402 with X-Payment-Required-* headers
 *      (recipient, amount, mint, signed-nonce, memo)
 *   3. Client → Solana tx transferring amount to recipient with
 *      memo "magpie-x402:<nonce>"
 *   4. Client → retry GET /endpoint with X-Payment: <signature>
 *   5. Server → verify payment on-chain, verify nonce HMAC, verify
 *      signature not previously consumed → serve response
 */

// Signature-level dedup. Same payment tx can't be used twice across
// 10-min window. In-process; multi-instance deploys should swap this
// for Vercel KV / Upstash Redis. See SECURITY.md "production hardening".
const consumedSignatures = new Map<string, number>();
function pruneSignatures() {
  const now = Date.now();
  for (const [s, exp] of consumedSignatures) if (exp < now) consumedSignatures.delete(s);
}
setInterval(pruneSignatures, 60_000).unref?.();

export interface X402Config {
  payTo: string;
  amountLamports: bigint;
  acceptedMint?: string;
  label?: string;
  docsUrl?: string;
}

export function x402Required(config: X402Config): MiddlewareHandler {
  let payToKey: PublicKey;
  try {
    payToKey = new PublicKey(config.payTo);
  } catch {
    throw new Error("[x402] invalid payTo pubkey in config");
  }
  if (config.amountLamports <= 0n) {
    throw new Error("[x402] amountLamports must be > 0");
  }

  return async (c: Context, next) => {
    const paymentHeader = c.req.header("x-payment");
    const endpoint = c.req.path;

    // ── No payment supplied — return signed challenge ──
    if (!paymentHeader) {
      const nonce = mintNonce(endpoint);
      const memo = `magpie-x402:${nonce}`;
      return c.json(
        {
          error: "payment_required",
          scheme: "x402/solana/v1",
          payTo: payToKey.toBase58(),
          amountLamports: config.amountLamports.toString(),
          acceptedMint: config.acceptedMint ?? "native-sol",
          nonce,
          memo,
          ttlMs: NONCE_TTL_MS,
          label: config.label,
          docs: config.docsUrl,
          instructions:
            `Send ${config.amountLamports.toString()} lamports of ` +
            `${config.acceptedMint ?? "SOL"} to ${payToKey.toBase58()} ` +
            `with memo "${memo}", then retry with header X-Payment: <tx_signature>`,
        },
        402,
        {
          "X-Payment-Required-Scheme": "x402/solana/v1",
          "X-Payment-Required-Amount": config.amountLamports.toString(),
          "X-Payment-Required-Recipient": payToKey.toBase58(),
          "X-Payment-Required-Nonce": nonce,
          "X-Payment-Required-Memo": memo,
        },
      );
    }

    // ── Payment supplied — verify ──
    const sig = paymentHeader.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
      return c.json({ error: "invalid_payment_format" }, 402);
    }
    // Dedup BEFORE the RPC roundtrip — cheap early reject
    const existing = consumedSignatures.get(sig);
    if (existing && existing > Date.now()) {
      return c.json({ error: "payment_already_consumed" }, 402);
    }

    let verification;
    try {
      verification = await verifyPayment({
        signature: sig,
        expectedRecipient: payToKey,
        expectedAmountLamports: config.amountLamports,
        expectedMint: config.acceptedMint ?? null,
      });
    } catch (err) {
      console.warn("[x402] verify error:", (err as Error).message);
      return c.json({ error: "payment_verification_failed" }, 402);
    }
    if (!verification.valid) {
      return c.json({ error: "payment_invalid", reason: verification.reason }, 402);
    }
    const memoNonce = verification.memoNonce;
    if (!memoNonce) {
      return c.json({ error: "payment_missing_memo_nonce" }, 402);
    }

    // Verify the HMAC + endpoint binding + expiry — stateless check.
    const nonceCheck = verifyNonce(memoNonce, endpoint);
    if (!nonceCheck.ok) {
      return c.json({ error: "nonce_invalid", reason: nonceCheck.reason }, 402);
    }

    // Single-use enforcement on the SIGNATURE (smaller, more accurate
    // than nonce-dedup since signatures are unique on-chain).
    consumedSignatures.set(sig, Date.now() + NONCE_TTL_MS);

    c.set("x402", {
      signature: sig,
      nonce: memoNonce,
      payer: verification.payer,
      mintedAtMs: nonceCheck.mintedAtMs,
    });

    // Durable, cross-instance single-use gate (REPLAY-02 fix). The in-process
    // `consumedSignatures` Map above only guards ONE warm instance; on
    // horizontally-scaled serverless a replayed signature could otherwise land
    // on a different instance and pass. Claim the signature in the bot's
    // x402_paid_calls (UNIQUE(tx_signature)) BEFORE serving: fresh===false means
    // it was already spent → reject as a replay. FAIL OPEN on any infra error
    // (null / no signal) so a transient bot/DB blip never blocks a
    // legitimately-paid call — the in-process Map still guards same-instance
    // replay, and the on-chain program is the final authority on every action.
    // This call also records the billing metric + accrues the holder-fee share.
    const claim = await recordPaidCall({
      endpointPath: endpoint,
      method: c.req.method,
      amountLamports: config.amountLamports.toString(),
      payerPubkey: verification.payer ?? "",
      txSignature: sig,
      nonce: memoNonce,
    });
    if (claim && claim.fresh === false) {
      return c.json({ error: "payment_already_consumed" }, 402);
    }

    await next();
  };
}

// Fire-and-forget. Errors swallowed — metrics are best-effort.
// 3s timeout caps per-invocation latency contribution to ~0ms in the
// happy path (we don't await) and 3s upper bound if a Promise leak
// somehow tries to drain it.
const BOT_API_FOR_METRICS = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN_FOR_METRICS = process.env.INTERNAL_API_TOKEN || "";
// Records the paid call AND serves as the durable, cross-instance single-use
// claim. Returns { fresh: true } when this signature was claimed for the first
// time, { fresh: false } when it was already spent (replay), {} when the bot
// recorded but gave no freshness signal (e.g. a db blip), or null on any infra
// error. The middleware treats fresh===false as a replay and everything else as
// allow (FAIL OPEN) — a transient bot/DB issue must never block a paid call.
async function recordPaidCall(rec: {
  endpointPath: string;
  method: string;
  amountLamports: string;
  payerPubkey: string;
  txSignature: string;
  nonce: string;
}): Promise<{ fresh?: boolean } | null> {
  if (!INTERNAL_TOKEN_FOR_METRICS) return null; // can't claim without auth → fail open
  try {
    const res = await fetch(`${BOT_API_FOR_METRICS}/api/v1/internal/x402/record`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_TOKEN_FOR_METRICS,
      },
      body: JSON.stringify({
        endpoint_path: rec.endpointPath,
        method: rec.method,
        amount_lamports: rec.amountLamports,
        payer_pubkey: rec.payerPubkey,
        tx_signature: rec.txSignature,
        nonce: rec.nonce,
      }),
      signal: AbortSignal.timeout(3_000),
    });
    const j = (await res.json().catch(() => null)) as { fresh?: unknown } | null;
    if (j && typeof j === "object" && "fresh" in j) {
      return { fresh: Boolean((j as { fresh?: unknown }).fresh) };
    }
    return {}; // recorded but no freshness signal → fail open
  } catch {
    return null; // infra error → fail open
  }
}
