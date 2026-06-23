import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * Self-owned exit orders — the loan OWNER arms / modifies / cancels in-vault
 * auto-sell (take-profit / stop-loss) orders on its OWN V4 loan.
 *
 * This is distinct from agent-limit-close.ts (the DELEGATION surface, where a
 * third-party agent acts on a borrower's loan via an off-band TG grant). Here
 * the caller IS the borrower: a fully self-custody agent that borrowed via
 * x402 (with has_exit_arming=true → a V4 loan) can manage its own exits
 * programmatically, no Telegram, no custodial keypair.
 *
 * How it works — the bot already exposes a signature-authenticated surface at
 * /api/v1/site/limit-close/* (the same one the website uses). Auth is an
 * Ed25519-signed envelope, NOT a session cookie, so it is forwardable:
 *
 *   agent (loan owner) ──signs envelope──▶ x402 ──forwards envelope──▶ bot
 *                                            │                          │
 *                                   binds payer==signer        verifies Ed25519 sig,
 *                                   (paid arm only)            From==signer, freshness,
 *                                                              nonce-uniqueness, and
 *                                                              V4_EXIT_EXCLUSIVE_ENFORCE
 *                                                              (only a V4 loan can arm)
 *
 * The envelope is `{ signedMessageBase64, signatureBase58, signerPubkey }`.
 * The signed text is a human-readable "Header: value" block carrying
 * `magpie: limit-close-arm/v1`, `From` (== signer), `LoanId`, `Direction`,
 * the trigger, `Nonce`, `IssuedAt`, etc. x402 does NOT parse the order
 * params — it forwards the exact signed bytes so the signature stays valid
 * and the bot remains the single source of truth + final guard.
 *
 * SECURITY:
 *   - We RECONSTRUCT the forwarded body from the three validated envelope
 *     fields (never pass the caller's raw object through) → no prototype
 *     pollution, no smuggled fields.
 *   - For PAID actions (arm / arm-batch) we bind payer == signerPubkey so a
 *     caller can't pay to relay a different wallet's signed envelope.
 *   - V4-only + ownership are enforced bot-side; even a full compromise of
 *     this service cannot arm an exit on a non-V4 loan or a loan it doesn't
 *     own (the signature wouldn't verify).
 *   - No INTERNAL_API_TOKEN is used: the bot endpoint is signature-gated and
 *     intentionally public; x402 adds the pay-per-arm convenience layer.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";

// The bot caps the decoded signed message at 2048 bytes; mirror that so we
// reject oversized payloads before a round-trip.
const MAX_SIGNED_MESSAGE_BYTES = 2048;

interface Envelope {
  signedMessageBase64: string;
  signatureBase58: string;
  signerPubkey: string;
}

function getPayer(c: Context): string | null {
  const ctx = c.get("x402") as { payer?: string } | undefined;
  return ctx?.payer ?? null;
}

/**
 * Validate + normalize the signed envelope. Returns the three fields (and
 * nothing else) or a typed error response.
 */
function readEnvelope(body: unknown): { ok: true; env: Envelope } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "invalid_json" };
  }
  const b = body as Record<string, unknown>;
  const signedMessageBase64 = b.signedMessageBase64;
  const signatureBase58 = b.signatureBase58;
  const signerPubkey = b.signerPubkey;

  if (
    typeof signedMessageBase64 !== "string" ||
    typeof signatureBase58 !== "string" ||
    typeof signerPubkey !== "string"
  ) {
    return { ok: false, status: 400, error: "missing_signed_envelope_fields" };
  }
  // signerPubkey must be a real on-curve pubkey.
  try {
    new PublicKey(signerPubkey);
  } catch {
    return { ok: false, status: 400, error: "invalid_signerPubkey" };
  }
  // Bound the signed message size (decoded) before forwarding.
  let decodedLen: number;
  try {
    decodedLen = Buffer.from(signedMessageBase64, "base64").length;
  } catch {
    return { ok: false, status: 400, error: "invalid_signedMessageBase64" };
  }
  if (decodedLen === 0 || decodedLen > MAX_SIGNED_MESSAGE_BYTES) {
    return { ok: false, status: 400, error: "signed_message_size_out_of_range" };
  }
  // Reconstruct — only these three fields ever reach the bot.
  return { ok: true, env: { signedMessageBase64, signatureBase58, signerPubkey } };
}

async function forwardEnvelope(
  c: Context,
  botPath: string,
  env: Envelope,
  method: "POST" | "DELETE" = "POST",
) {
  let res: Response;
  try {
    res = await fetch(`${BOT_API}${botPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(env), // reconstructed — exactly the 3 fields
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return c.json({ error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.warn(`[self-limit-close] non-JSON from bot ${botPath} (status ${res.status}):`, text.slice(0, 300));
    parsed = { error: "bot_returned_non_json", status: res.status };
  }
  // Idempotency: if the bot already consumed this envelope's nonce, the arm
  // most likely landed on a prior attempt — surface it distinctly so a paid
  // agent treats a post-timeout retry as "already armed", not a new failure.
  if (res.status === 409 && String(parsed.error ?? "") === "nonce_already_used") {
    parsed = {
      ...parsed,
      classified: {
        reason: "already_processed",
        detail: "This signed envelope was already consumed — the original request likely succeeded. Re-read your orders to confirm before re-signing a new one.",
      },
    };
  }
  return c.json(parsed, res.status as never);
}

/**
 * Bind a PAID action to the payer: the x402 payment signer MUST equal the
 * envelope signer, so a caller can't pay to relay someone else's order.
 */
function enforcePayerIsSigner(c: Context, signerPubkey: string) {
  const payer = getPayer(c);
  if (!payer) {
    return c.json({ error: "missing_payer", detail: "x402 payment context missing payer pubkey" }, 500);
  }
  if (payer !== signerPubkey) {
    return c.json(
      {
        error: "payer_signer_mismatch",
        detail: "The x402 payment signer must equal the envelope signer (you arm exits on your own loans).",
      },
      403,
    );
  }
  return null;
}

async function paidEnvelopeRoute(c: Context, botPath: string) {
  const body = await c.req.json().catch(() => null);
  const parsed = readEnvelope(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status as never);
  const mismatch = enforcePayerIsSigner(c, parsed.env.signerPubkey);
  if (mismatch) return mismatch;
  return forwardEnvelope(c, botPath, parsed.env);
}

async function freeEnvelopeRoute(c: Context, botPath: string, method: "POST" | "DELETE" = "POST") {
  const body = await c.req.json().catch(() => null);
  const parsed = readEnvelope(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status as never);
  return forwardEnvelope(c, botPath, parsed.env, method);
}

/** POST /api/v1/agent/self-limit-close/arm — PAID. Arm one exit on your V4 loan. */
export function armSelfLimitCloseHandler(c: Context) {
  return paidEnvelopeRoute(c, "/api/v1/site/limit-close/arm");
}

/** POST /api/v1/agent/self-limit-close/arm-batch — PAID. Arm a ladder of exits. */
export function armBatchSelfLimitCloseHandler(c: Context) {
  return paidEnvelopeRoute(c, "/api/v1/site/limit-close/arm-batch");
}

/** POST /api/v1/agent/self-limit-close/modify — FREE (signature authorizes). */
export function modifySelfLimitCloseHandler(c: Context) {
  return freeEnvelopeRoute(c, "/api/v1/site/limit-close/modify");
}

/** DELETE /api/v1/agent/self-limit-close/cancel — FREE (signature authorizes). */
export function cancelSelfLimitCloseHandler(c: Context) {
  return freeEnvelopeRoute(c, "/api/v1/site/limit-close/cancel", "DELETE");
}

/**
 * GET /api/v1/agent/self-limit-close/list?wallet=<pubkey> — FREE.
 * Lists the wallet's armed exit orders. Public read on the bot (same data the
 * owner sees in the UI); we validate the pubkey + forward.
 */
export async function listSelfLimitCloseHandler(c: Context) {
  const wallet = c.req.query("wallet") ?? "";
  try {
    new PublicKey(wallet);
  } catch {
    return c.json({ error: "invalid_or_missing_wallet" }, 400);
  }
  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/site/limit-close?wallet=${encodeURIComponent(wallet)}`, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return c.json({ error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "bot_returned_non_json", status: res.status };
  }
  return c.json(parsed as Record<string, unknown>, res.status as never);
}
