import type { Context, MiddlewareHandler } from "hono";
import { PublicKey } from "@solana/web3.js";
import { verifyPayment } from "../lib/solana.js";
import { mintNonce, verifyNonce, NONCE_TTL_MS } from "../lib/hmac-nonce.js";
import {
  settleStandardSplPayment,
  standardRailEnabled,
  buildSplAccepts,
  getSvmFeePayer,
} from "../lib/x402-standard.js";

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
    const endpoint = c.req.path;
    // Lane discrimination by HEADER NAME (cannot collide):
    //   native rail  → x-payment (bare base58 signature)
    //   standard rail → PAYMENT-SIGNATURE (base64 PaymentPayload)
    const paymentHeader = c.req.header("x-payment");
    const stdSig = c.req.header("payment-signature");
    // NOTE: do NOT set Access-Control-Expose-Headers here — app.ts's CORS
    // middleware already exposes the full set (PAYMENT-REQUIRED,
    // PAYMENT-RESPONSE, Retry-After, and every X-Payment-Required-*).
    // Re-setting it here OVERWRITES that list (Hono's c.header replaces, not
    // appends), dropping the X-Payment-Required-* headers a browser-origin
    // agent needs to read the native-rail challenge. (audit FIX 4)

    // ── Standard x402 v2 SVM rail (gated, fail-closed) ──
    // Only when explicitly enabled (X402_STANDARD_RAIL_ENABLED=true) AND the
    // client used the standard header. Settles USDC/wSOL via the facilitator;
    // the service holds no keys. On ANY failure this returns a 402 (fail closed).
    if (stdSig && standardRailEnabled()) {
      const result = await settleStandardSplPayment(c, {
        endpoint,
        amountLamports: config.amountLamports,
        v2Sig: stdSig,
      });
      if (!result.ok) return result.res;
      // Propagate the SPL transfer authority so enforcePayerMatchesWallet still gates per-wallet routes.
      c.set("x402", { signature: "spl", nonce: "", payer: result.payer, mintedAtMs: Date.now() });
      await next();
      return;
    }

    // ── No payment supplied — return challenge ──
    if (!paymentHeader) {
      const nonce = mintNonce(endpoint);
      const memo = `magpie-x402:${nonce}`;
      const headers: Record<string, string> = {
        "X-Payment-Required-Scheme": "x402/solana/v1",
        "X-Payment-Required-Amount": config.amountLamports.toString(),
        "X-Payment-Required-Recipient": payToKey.toBase58(),
        "X-Payment-Required-Nonce": nonce,
        "X-Payment-Required-Memo": memo,
      };
      // Standard x402 v2 PaymentRequired — ONLY advertised when the SPL rail is
      // actually live + the facilitator feePayer is known. We never advertise a
      // settlement we can't honor (that would make standard agents pay + fail).
      let standardBody: Record<string, unknown> = {};
      if (standardRailEnabled()) {
        const fp = await getSvmFeePayer();
        if (fp) {
          const v2 = {
            x402Version: 2,
            error: "payment_required",
            resource: {
              url: c.req.url,
              description: config.label ?? "Magpie x402 paid endpoint",
              mimeType: "application/json",
            },
            accepts: await buildSplAccepts(config.amountLamports, memo, fp.feePayer),
            extensions: {},
          };
          standardBody = v2;
          headers["PAYMENT-REQUIRED"] = Buffer.from(JSON.stringify(v2)).toString("base64");
        }
      }
      return c.json(
        {
          ...standardBody,
          // ── Magpie native custom fields (unchanged — our SDK/MCP read these) ──
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
        headers,
      );
    }

    // ── Native payment supplied — verify (UNCHANGED native rail) ──
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
    if (claim && claim.fresh === true) {
      // Single-use proven for the first time — reset the breaker.
      noteClaimResolved();
    } else {
      // null / {} — the durable single-use claim couldn't be established
      // (missing token, bot/DB blip). FAIL CLOSED by default so a replayed
      // payment can't be served free data during a blip (the real exposure
      // is the self-contained data endpoints, which have no on-chain lower
      // layer). UNLESS the bot is in a PROVEN sustained outage, in which case
      // the breaker briefly fails OPEN (bounded) so legitimately-paid agents
      // aren't hard-blocked. The in-process Map still guards same-instance
      // replay; the 10-min nonce TTL is the hard outer bound. (audit FIX 1 +
      // feedback_defense_in_depth_failopen_when_lower_layer_proven.)
      if (claimBreakerVerdict() === "reject") {
        return c.json({ error: "settlement_claim_unconfirmed", retryable: true }, 402);
      }
    }

    // ── Two-phase claim release (audit FIX 3) ──
    // The signature was claimed (in-process + durable) BEFORE next() to enforce
    // single-use. If the downstream handler then FAILS for an infra reason —
    // throws, or returns a 5xx (bot 502 / timeout / non-JSON / onError 500) —
    // the agent paid but got nothing, and the consumed claim would block a retry
    // (payment_already_consumed) → the agent loses its SOL with no recourse.
    // Release the claim (and reverse the holder accrual) on infra failure so the
    // SAME payment re-drives the handler within the 10-min nonce window. NEVER
    // release on 2xx (served) or 4xx (agent-fault: bad params / doomed sim) —
    // else an attacker could re-drive the handler repeatedly on one payment.
    try {
      await next();
    } catch (err) {
      releaseClaim(sig);
      throw err;
    }
    if (c.res && c.res.status >= 500) {
      releaseClaim(sig);
    }
  };
}

// Release a previously-claimed native-rail signature so a paid agent can retry
// the SAME payment when the downstream handler failed for an infra reason.
// (audit FIX 3) — drops the in-process guard immediately (same-instance retry)
// and asks the bot to un-claim + reverse the holder accrual durably.
function releaseClaim(sig: string): void {
  if (!sig) return;
  consumedSignatures.delete(sig);
  void releasePaidCall(sig);
}

async function releasePaidCall(sig: string): Promise<void> {
  if (!INTERNAL_TOKEN_FOR_METRICS) return;
  try {
    await fetch(`${BOT_API_FOR_METRICS}/api/v1/internal/x402/release`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_TOKEN_FOR_METRICS,
      },
      body: JSON.stringify({ tx_signature: sig }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Best-effort. The in-process delete already lets a same-instance retry
    // through; the 10-min nonce TTL bounds the worst case (re-pay with a fresh
    // nonce). Never throws into the response path.
  }
}

// ── Circuit breaker for the durable single-use claim (audit FIX 1) ──
// When recordPaidCall can't establish freshness (null/{}), the gate FAILS
// CLOSED to deny replayed payments free data — but a sustained bot/DB outage
// would then hard-block every paid call. The breaker detects a proven
// sustained outage (consecutive unresolved claims within a short window) and
// trips into a BOUNDED fail-open window so legitimately-paid agents keep
// being served, then re-tests. Warm-instance state is a sufficient
// degradation signal; the 10-min nonce TTL is the hard outer bound on any
// replay even while degraded.
let claimFailWindowStart = 0;
let claimFailCount = 0;
let claimDegradedUntilMs = 0;
const CLAIM_DEGRADE_TRIP_FAILS = 4;
const CLAIM_DEGRADE_TRIP_WINDOW_MS = 20_000;
const CLAIM_DEGRADE_OPEN_MS = 60_000;

function claimBreakerVerdict(): "serve" | "reject" {
  const now = Date.now();
  if (now < claimDegradedUntilMs) return "serve"; // inside the degraded window
  if (now - claimFailWindowStart > CLAIM_DEGRADE_TRIP_WINDOW_MS) {
    claimFailWindowStart = now;
    claimFailCount = 0;
  }
  claimFailCount++;
  if (claimFailCount >= CLAIM_DEGRADE_TRIP_FAILS) {
    claimDegradedUntilMs = now + CLAIM_DEGRADE_OPEN_MS;
    return "serve";
  }
  return "reject";
}
function noteClaimResolved(): void {
  claimFailCount = 0;
  claimDegradedUntilMs = 0;
}

// Fire-and-forget. Errors swallowed — metrics are best-effort.
// 3s timeout caps per-invocation latency contribution to ~0ms in the
// happy path (we don't await) and 3s upper bound if a Promise leak
// somehow tries to drain it.
const BOT_API_FOR_METRICS = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
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
