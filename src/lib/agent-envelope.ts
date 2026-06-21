/**
 * Delegated-agent identity binding for the limit-close MANAGEMENT routes
 * (preflight / get / list / delegations / eligible-loans / modify / cancel).
 *
 * SECURITY (audit 2026-06-21, HIGH): these routes previously trusted a
 * self-asserted `X-Agent-Pubkey` header. Agent pubkeys are public, so any
 * unauthenticated actor could pass another agent's pubkey to cancel / modify /
 * enumerate that agent's armed exit orders — silently disarming a borrower's
 * stop-loss. The bot scopes every delegated operation purely by the forwarded
 * `agent_pubkey` and its own comment states the contract: "the x402 service
 * binds agent_pubkey ← VERIFIED identity before calling us." The /arm route
 * honored that (verified x402 payer); the management routes did not.
 *
 * This module restores the contract WITHOUT charging for free management calls:
 * the caller signs a short Ed25519 envelope with the SAME agent keypair and
 * sends it in three headers. We verify the signature locally (no key material
 * here — verify only), bind `From == signer`, bind the action, optionally bind
 * the target order id, and enforce a 5-minute freshness window. The verified
 * signer — and ONLY the verified signer — becomes the agent identity forwarded
 * to the bot. A forged or replayed-cross-agent header can no longer pass: an
 * attacker cannot produce a valid Ed25519 signature for a key they don't hold.
 *
 * Envelope text (newline-joined, exactly what the SDK signs):
 *   magpie: <action>            e.g. limit-close-cancel/v1
 *   From: <signer pubkey>       MUST equal the X-Magpie-Env-Signer header
 *   OrderId: <id>               (modify / cancel / get — binds the target)
 *   Nonce: <uuid>
 *   IssuedAt: <ISO-8601>
 *
 * Headers:
 *   X-Magpie-Env-Msg    base64(signed UTF-8 message)
 *   X-Magpie-Env-Sig    base58(64-byte Ed25519 signature)
 *   X-Magpie-Env-Signer base58 Ed25519 / Solana pubkey (the agent identity)
 */
import type { Context } from "hono";
import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";

const FRESHNESS_MS = 5 * 60_000; // 5-minute window (matches the self-path)
const CLOCK_SKEW_MS = 60_000; // tolerate 60s of forward clock skew
const MAX_MSG_BYTES = 1024;

// Standard (Bitcoin/Solana) base58 alphabet. We decode the signature inline
// rather than pulling in `bs58` (an untyped transitive dep at v4.0.1) — this
// verifier must stay self-contained and zero-trust on its imports, mirroring
// the inline base58 ENCODER the self-path uses in src/lib/... envelope builder.
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]] = i;
  return m;
})();

/**
 * Decode a base58 string to bytes. Throws on any non-alphabet character so a
 * malformed signature is rejected (caught by the caller) rather than silently
 * decoding to garbage.
 */
function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  // Leading '1's encode leading zero bytes verbatim. Count + strip them so the
  // big-number loop below sees only the significant digits — this avoids the
  // all-zero double-count bug (a seed zero PLUS the '1' prefix).
  let leadingZeros = 0;
  while (leadingZeros < str.length && str[leadingZeros] === "1") leadingZeros++;

  const bytes: number[] = [];
  for (let i = leadingZeros; i < str.length; i++) {
    const value = BASE58_MAP[str[i]];
    if (value === undefined) throw new Error("invalid base58 character");
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  // `bytes` is little-endian; reverse into big-endian after the zero pad.
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export type EnvelopeOk = { ok: true; signer: string; fields: Record<string, string> };
export type EnvelopeErr = { ok: false; status: number; error: string };

/** Parse the three envelope fields from raw header values (or any record). */
export function readEnvelopeHeaders(
  get: (name: string) => string | undefined,
): { msgB64?: string; sigB58?: string; signer?: string } {
  return {
    msgB64: get("x-magpie-env-msg") ?? undefined,
    sigB58: get("x-magpie-env-sig") ?? undefined,
    signer: get("x-magpie-env-signer") ?? undefined,
  };
}

/**
 * Verify a management envelope. Pure (no I/O). `nowMs` is injectable for tests.
 * `expectedAction` binds the envelope to a specific operation; `expectedOrderId`
 * (when provided) binds it to a specific order so a cancel/modify envelope can
 * never be replayed against a different order.
 */
export function verifyManagementEnvelope(
  raw: { msgB64?: string; sigB58?: string; signer?: string },
  expectedAction: string,
  opts: { expectedOrderId?: string; nowMs?: number } = {},
): EnvelopeOk | EnvelopeErr {
  const { msgB64, sigB58, signer } = raw;
  if (!msgB64 || !sigB58 || !signer) {
    return { ok: false, status: 401, error: "missing_signed_envelope" };
  }
  // Signer must be a real on-curve pubkey.
  let pubBytes: Uint8Array;
  try {
    pubBytes = new PublicKey(signer).toBytes();
  } catch {
    return { ok: false, status: 400, error: "invalid_signer_pubkey" };
  }
  // Decode message (bounded) + signature (exactly 64 bytes).
  let msgBytes: Buffer;
  try {
    msgBytes = Buffer.from(msgB64, "base64");
  } catch {
    return { ok: false, status: 400, error: "invalid_message_encoding" };
  }
  if (msgBytes.length === 0 || msgBytes.length > MAX_MSG_BYTES) {
    return { ok: false, status: 400, error: "message_size_out_of_range" };
  }
  let sigBytes: Uint8Array;
  try {
    sigBytes = base58Decode(sigB58);
  } catch {
    return { ok: false, status: 400, error: "invalid_signature_encoding" };
  }
  if (sigBytes.length !== 64) {
    return { ok: false, status: 400, error: "invalid_signature_length" };
  }
  // The actual cryptographic check — the load-bearing line.
  let valid = false;
  try {
    valid = ed25519.verify(sigBytes, msgBytes, pubBytes);
  } catch {
    valid = false;
  }
  if (!valid) {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  // Parse the verified message text into header + fields.
  const text = msgBytes.toString("utf8");
  let action = "";
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k === "magpie") action = v;
    else if (k) fields[k] = v;
  }
  // Bind the action so a "list" envelope can't be replayed as a "cancel".
  if (action !== expectedAction) {
    return { ok: false, status: 401, error: "envelope_action_mismatch" };
  }
  // From MUST equal the verified signer — the signature proves control of this
  // key, and From asserts it; both must agree.
  if (fields.From !== signer) {
    return { ok: false, status: 401, error: "envelope_from_signer_mismatch" };
  }
  // Bind the target order for resource-scoped actions.
  if (opts.expectedOrderId != null && String(fields.OrderId ?? "") !== String(opts.expectedOrderId)) {
    return { ok: false, status: 401, error: "envelope_order_mismatch" };
  }
  // Freshness — reject stale/replayed envelopes outside the window.
  const now = opts.nowMs ?? Date.now();
  const issued = Date.parse(fields.IssuedAt ?? "");
  if (Number.isNaN(issued)) {
    return { ok: false, status: 401, error: "envelope_missing_issued_at" };
  }
  const age = now - issued;
  if (age > FRESHNESS_MS || age < -CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: "envelope_expired_or_future" };
  }
  return { ok: true, signer, fields };
}

/**
 * Hono convenience: verify directly from a request Context's headers.
 * Returns the verified agent identity (signer) or a typed error.
 */
export function verifyAgentFromContext(
  c: Context,
  expectedAction: string,
  opts: { expectedOrderId?: string } = {},
): EnvelopeOk | EnvelopeErr {
  const raw = readEnvelopeHeaders((n) => c.req.header(n));
  return verifyManagementEnvelope(raw, expectedAction, opts);
}
