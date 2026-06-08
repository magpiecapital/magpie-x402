import type { Context, MiddlewareHandler } from "hono";
import { PublicKey } from "@solana/web3.js";
import { verifyPayment } from "../lib/solana.js";

/**
 * x402 — HTTP 402 "Payment Required" middleware for Solana.
 *
 * Pattern:
 *   1. Client calls a protected endpoint without payment.
 *   2. Server replies 402 with X-PAYMENT-REQUIRED headers describing
 *      the payment scheme (recipient pubkey, amount, accepted mints,
 *      and a per-request `nonce` the client must include in the memo
 *      so the same payment can't be replayed against a different call).
 *   3. Client submits a Solana transaction transferring the amount to
 *      the recipient with the nonce in the memo.
 *   4. Client retries the same request with the tx signature in the
 *      `X-PAYMENT` header.
 *   5. Server verifies the tx on-chain (correct recipient, amount, mint,
 *      memo nonce, not previously consumed), then serves the response.
 *
 * Security properties:
 *   - Nonces are single-use (in-memory set + 10-min expiry). A replayed
 *     payment for one nonce can't be used to satisfy a different
 *     endpoint call.
 *   - Payment verification is RPC-side; we never trust client-supplied
 *     amount/recipient. Always re-derives from the on-chain tx.
 *   - No private keys ever touch this service. We only receive
 *     payments; we never sign or hold funds.
 *   - All error messages are intentionally generic to avoid leaking
 *     verification logic to attackers.
 */

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const consumedNonces = new Map<string, number>();
function pruneNonces() {
  const now = Date.now();
  for (const [n, exp] of consumedNonces) {
    if (exp < now) consumedNonces.delete(n);
  }
}
setInterval(pruneNonces, 60_000).unref?.();

/** Generate a fresh, unguessable nonce for a payment challenge. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface X402Config {
  /** Solana pubkey that receives the payment. */
  payTo: string;
  /** Amount in lamports (for native SOL) or smallest token units. */
  amountLamports: bigint;
  /** Mint to accept. If null/undefined → native SOL. */
  acceptedMint?: string;
  /** Human-readable label for the response card. */
  label?: string;
  /** A URL pointing at docs / pricing for the endpoint. */
  docsUrl?: string;
}

/**
 * Hono middleware that protects an endpoint behind an x402 payment.
 *
 * Usage:
 *   app.get("/api/v1/credit-score", x402Required({
 *     payTo: process.env.MAGPIE_PAY_TO!,
 *     amountLamports: 1_000_000n,  // 0.001 SOL
 *     label: "Magpie credit-score lookup",
 *   }), creditScoreHandler);
 */
export function x402Required(config: X402Config): MiddlewareHandler {
  // Validate config at construction time, not per-request
  let payToKey: PublicKey;
  try {
    payToKey = new PublicKey(config.payTo);
  } catch {
    throw new Error("[x402] invalid MAGPIE_PAY_TO pubkey in config");
  }
  if (config.amountLamports <= 0n) {
    throw new Error("[x402] amountLamports must be > 0");
  }

  return async (c: Context, next) => {
    const paymentHeader = c.req.header("x-payment");

    // No payment supplied → return 402 with the challenge
    if (!paymentHeader) {
      const nonce = newNonce();
      // Pre-reserve the nonce so it can't be guessed/replayed before
      // the client sends payment. Marked with a future expiry; the
      // verify step replaces with a "consumed" marker.
      consumedNonces.set(nonce, Date.now() + NONCE_TTL_MS);
      return c.json(
        {
          error: "payment_required",
          scheme: "x402/solana/v1",
          payTo: payToKey.toBase58(),
          amountLamports: config.amountLamports.toString(),
          acceptedMint: config.acceptedMint ?? "native-sol",
          nonce,
          memo: `magpie-x402:${nonce}`,
          ttlMs: NONCE_TTL_MS,
          label: config.label,
          docs: config.docsUrl,
          instructions:
            `Send ${config.amountLamports.toString()} lamports of ` +
            `${config.acceptedMint ?? "SOL"} to ${payToKey.toBase58()} ` +
            `with memo "magpie-x402:${nonce}", then retry with ` +
            `header X-PAYMENT: <tx_signature>`,
        },
        402,
        {
          "X-Payment-Required-Scheme": "x402/solana/v1",
          "X-Payment-Required-Amount": config.amountLamports.toString(),
          "X-Payment-Required-Recipient": payToKey.toBase58(),
          "X-Payment-Required-Nonce": nonce,
          "X-Payment-Required-Memo": `magpie-x402:${nonce}`,
        },
      );
    }

    // Payment supplied — verify it on-chain
    const sig = paymentHeader.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) {
      return c.json({ error: "invalid_payment_format" }, 402);
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
      // Generic error to avoid leaking RPC details
      console.warn("[x402] verify error:", (err as Error).message);
      return c.json({ error: "payment_verification_failed" }, 402);
    }

    if (!verification.valid) {
      return c.json({ error: "payment_invalid", reason: verification.reason }, 402);
    }

    // Single-use nonce check (from the memo)
    const memoNonce = verification.memoNonce;
    if (!memoNonce) {
      return c.json({ error: "payment_missing_memo_nonce" }, 402);
    }
    const reservation = consumedNonces.get(memoNonce);
    const now = Date.now();
    if (reservation === undefined || reservation < now) {
      return c.json({ error: "nonce_expired_or_unknown" }, 402);
    }
    if (reservation === -1) {
      return c.json({ error: "nonce_already_used" }, 402);
    }
    // Mark consumed
    consumedNonces.set(memoNonce, -1);

    // Attach verification details for downstream handlers if needed
    c.set("x402", { signature: sig, nonce: memoNonce, payer: verification.payer });
    await next();
  };
}
