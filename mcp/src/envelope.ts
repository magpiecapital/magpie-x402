/**
 * Ed25519 signed-envelope builder for Magpie's self-owned exit orders.
 *
 * The bot's /api/v1/site/limit-close/* surface authenticates with a signed
 * "Header: value" text envelope (NOT a session). This module builds + signs
 * that envelope so an agent can arm / modify / cancel exits on its OWN loan
 * with one call. The signature is produced with Node's built-in crypto
 * (Ed25519) and a tiny inline base58 encoder — ZERO extra dependencies.
 *
 * The signed text is exactly what the bot re-parses and verifies, e.g.:
 *
 *   magpie: limit-close-arm/v1
 *   From: <signer pubkey>
 *   LoanId: 12345
 *   Direction: above
 *   Target: 2x
 *   Slippage: 100
 *   Dest: sol
 *   Nonce: <uuid>
 *   IssuedAt: 2026-06-20T00:00:00.000Z
 */
import { createPrivateKey, sign as nodeSign, randomUUID } from "node:crypto";
import type { Keypair } from "@solana/web3.js";

// PKCS8 DER prefix for an Ed25519 private key (RFC 8410). The 32-byte seed
// follows, giving a 48-byte DER we can hand to Node's createPrivateKey.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Standard (Bitcoin/Solana) base58 encode. */
function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += BASE58_ALPHABET[digits[k]];
  return out;
}

function signEd25519(message: Uint8Array, keypair: Keypair): Buffer {
  // Solana secretKey is [32-byte seed || 32-byte pubkey]; Ed25519 PKCS8
  // needs only the seed.
  const seed = Buffer.from(keypair.secretKey.slice(0, 32));
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return nodeSign(null, Buffer.from(message), key);
}

export interface SignedEnvelope {
  signedMessageBase64: string;
  signatureBase58: string;
  signerPubkey: string;
}

/**
 * Build + sign an envelope. `From`, `Nonce`, and `IssuedAt` are added
 * automatically (unless you override them) — the bot requires all three and
 * enforces a 5-minute freshness window on IssuedAt + nonce-uniqueness.
 */
/**
 * Build envelope + return as HTTP headers for the delegated agent-limit-close
 * management routes (X-Magpie-Env-Msg / -Sig / -Signer). These routes verify
 * the envelope from request headers rather than a JSON body.
 */
export function buildEnvelopeHeaders(
  keypair: Keypair,
  action: string,
  fields: Record<string, string | number | undefined | null> = {},
): Record<string, string> {
  const env = buildSignedEnvelope(keypair, action, fields);
  return {
    "X-Magpie-Env-Msg": env.signedMessageBase64,
    "X-Magpie-Env-Sig": env.signatureBase58,
    "X-Magpie-Env-Signer": env.signerPubkey,
  };
}

export function buildSignedEnvelope(
  keypair: Keypair,
  magpieHeader: string,
  fields: Record<string, string | number | undefined | null>,
): SignedEnvelope {
  const signer = keypair.publicKey.toBase58();
  const merged: Record<string, string | number | undefined | null> = {
    Nonce: randomUUID(),
    IssuedAt: new Date().toISOString(),
    ...fields,
  };
  const lines: string[] = [`magpie: ${magpieHeader}`, `From: ${signer}`];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === "") continue;
    lines.push(`${k}: ${v}`);
  }
  const text = lines.join("\n");
  const messageBytes = new TextEncoder().encode(text);
  const sig = signEd25519(messageBytes, keypair);
  return {
    signedMessageBase64: Buffer.from(messageBytes).toString("base64"),
    signatureBase58: base58Encode(sig),
    signerPubkey: signer,
  };
}
