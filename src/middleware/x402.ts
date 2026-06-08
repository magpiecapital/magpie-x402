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
    await next();
  };
}
