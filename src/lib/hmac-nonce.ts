import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless HMAC-signed payment nonces.
 *
 * Why this beats every "in-memory Map" implementation:
 *   - SCALES HORIZONTALLY — any function instance can validate any
 *     nonce because the nonce IS its own proof. No shared state.
 *   - WORKS ON EDGE — no setInterval cleanup, no Map growing
 *     unbounded across function restarts.
 *   - SURVIVES RESTARTS — nonces minted before a deploy are still
 *     valid (within their TTL) after the deploy. No "challenge
 *     expired" rejections during routine rollouts.
 *   - REPLAY-RESISTANT — combined with per-tx signature dedup
 *     (signature can only exist once on-chain), the same payment
 *     cannot satisfy two different requests.
 *
 * Nonce structure:
 *   base64url( ver:1 ‖ ts:8 ‖ endpoint_hash:8 ‖ rand:16 ‖ mac:16 )
 *   where mac = HMAC-SHA256(secret, ver ‖ ts ‖ endpoint_hash ‖ rand)[:16]
 *
 * Total length: 49 bytes binary → 66 chars base64url. Fits comfortably
 * in a Solana memo (566 byte limit) alongside the magpie-x402: prefix.
 *
 * Secret rotation:
 *   - Set X402_NONCE_SECRET env var. 32+ random bytes recommended.
 *   - To rotate without invalidating outstanding challenges, support
 *     two secrets temporarily (NONCE_SECRET_PREV) and accept either
 *     for up to NONCE_TTL_MS. Not implemented in v0 — add when
 *     operational rotation matters.
 */

const VERSION = 0x01;
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function secret(): Buffer {
  const raw = process.env.X402_NONCE_SECRET;
  if (!raw || raw.length < 16) {
    // Dev fallback — random per-process so signed nonces are still
    // validatable within the same process lifetime. Production MUST
    // set X402_NONCE_SECRET to a stable 32+ char value or nonces
    // become invalid on every cold start.
    if (!process.env._X402_DEV_WARNED) {
      console.warn(
        "[x402] X402_NONCE_SECRET not set — using ephemeral per-process secret. " +
        "Production deploys MUST set this env var to a stable random value (32+ bytes).",
      );
      process.env._X402_DEV_WARNED = "1";
    }
    if (!(globalThis as { _x402DevSecret?: Buffer })._x402DevSecret) {
      (globalThis as { _x402DevSecret?: Buffer })._x402DevSecret = randomBytes(32);
    }
    return (globalThis as { _x402DevSecret?: Buffer })._x402DevSecret!;
  }
  return Buffer.from(raw);
}

/** Deterministic 8-byte fingerprint of an endpoint path. */
function endpointHash(endpoint: string): Buffer {
  return createHmac("sha256", "magpie-x402-endpoint").update(endpoint).digest().subarray(0, 8);
}

/** Mint a fresh signed nonce for a given endpoint. */
export function mintNonce(endpoint: string): string {
  const ts = Buffer.alloc(8);
  ts.writeBigInt64BE(BigInt(Date.now()));
  const rand = randomBytes(16);
  const ep = endpointHash(endpoint);
  const payload = Buffer.concat([Buffer.from([VERSION]), ts, ep, rand]);
  const mac = createHmac("sha256", secret()).update(payload).digest().subarray(0, 16);
  return Buffer.concat([payload, mac]).toString("base64url");
}

export interface VerifiedNonce {
  ok: true;
  mintedAtMs: number;
  endpoint: string;
}
export interface InvalidNonce {
  ok: false;
  reason: "malformed" | "bad_version" | "bad_mac" | "expired" | "wrong_endpoint";
}

/** Verify a nonce. Returns ok=true if all checks pass. */
export function verifyNonce(nonce: string, endpoint: string): VerifiedNonce | InvalidNonce {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(nonce, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (bytes.length !== 49) return { ok: false, reason: "malformed" };
  if (bytes[0] !== VERSION) return { ok: false, reason: "bad_version" };

  const payload = bytes.subarray(0, 33);
  const claimedMac = bytes.subarray(33, 49);
  const expectedMac = createHmac("sha256", secret()).update(payload).digest().subarray(0, 16);
  // Constant-time compare — avoid timing leaks
  if (claimedMac.length !== expectedMac.length || !timingSafeEqual(claimedMac, expectedMac)) {
    return { ok: false, reason: "bad_mac" };
  }

  const ts = Number(bytes.readBigInt64BE(1));
  if (Date.now() - ts > NONCE_TTL_MS) return { ok: false, reason: "expired" };

  const ep = bytes.subarray(9, 17);
  const expectedEp = endpointHash(endpoint);
  if (!timingSafeEqual(ep, expectedEp)) return { ok: false, reason: "wrong_endpoint" };

  return { ok: true, mintedAtMs: ts, endpoint };
}

export { NONCE_TTL_MS };
