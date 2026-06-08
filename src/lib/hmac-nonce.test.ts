import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mintNonce, verifyNonce, NONCE_TTL_MS } from "./hmac-nonce.js";

describe("hmac-nonce", () => {
  it("mints and verifies a round-trip", () => {
    const nonce = mintNonce("/api/v1/credit-score");
    const v = verifyNonce(nonce, "/api/v1/credit-score");
    assert.equal(v.ok, true);
    if (v.ok) assert.ok(Math.abs(Date.now() - v.mintedAtMs) < 1000);
  });

  it("rejects a nonce reused on a DIFFERENT endpoint", () => {
    const nonce = mintNonce("/api/v1/credit-score");
    const v = verifyNonce(nonce, "/api/v1/pool");
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "wrong_endpoint");
  });

  it("rejects a nonce with a tampered MAC", () => {
    const nonce = mintNonce("/x");
    // Flip a bit in the MAC portion (last 16 bytes)
    const bytes = Buffer.from(nonce, "base64url");
    bytes[bytes.length - 1] ^= 0x01;
    const tampered = bytes.toString("base64url");
    const v = verifyNonce(tampered, "/x");
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "bad_mac");
  });

  it("rejects a nonce with a tampered timestamp", () => {
    const nonce = mintNonce("/x");
    const bytes = Buffer.from(nonce, "base64url");
    // Flip a bit in the timestamp region
    bytes[2] ^= 0x80;
    const tampered = bytes.toString("base64url");
    const v = verifyNonce(tampered, "/x");
    assert.equal(v.ok, false);
    // Bad MAC OR bad timestamp — either is a valid rejection
    if (!v.ok) assert.ok(["bad_mac", "expired"].includes(v.reason));
  });

  it("rejects malformed nonces", () => {
    assert.equal(verifyNonce("", "/x").ok, false);
    assert.equal(verifyNonce("not-base64url!@#", "/x").ok, false);
    assert.equal(verifyNonce("AAAA", "/x").ok, false); // wrong length
  });

  it("rejects wrong-version envelope", () => {
    const nonce = mintNonce("/x");
    const bytes = Buffer.from(nonce, "base64url");
    bytes[0] = 0x99; // bogus version
    const v = verifyNonce(bytes.toString("base64url"), "/x");
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(["bad_version", "bad_mac"].includes(v.reason));
  });

  it("encodes a real timestamp in the envelope", () => {
    const before = Date.now();
    const nonce = mintNonce("/x");
    const after = Date.now();
    const v = verifyNonce(nonce, "/x");
    assert.equal(v.ok, true);
    if (v.ok) assert.ok(v.mintedAtMs >= before && v.mintedAtMs <= after);
  });

  it("TTL constant is 10 minutes", () => {
    assert.equal(NONCE_TTL_MS, 10 * 60 * 1000);
  });
});
