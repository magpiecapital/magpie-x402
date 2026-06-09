import { webcrypto } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { loadConfig, paidJson, printJson } from "../shared/magpie-client.js";

type RiskResponse = { [key: string]: unknown };

const config = loadConfig();
const walletQuery = `wallet=${encodeURIComponent(config.wallet)}`;

// x402 step 1: request the paid score without X-Payment and read the challenge.
// x402 step 2: pay the returned recipient with the returned memo.
// x402 step 3: set X402_PAYMENT_SIGNATURE so the helper retries with X-Payment.
const score = await paidJson<RiskResponse>(config, `/api/v1/credit-score?${walletQuery}`);
if (score.kind === "response") {
  printJson("credit score", score.data);
}

const attestation = await paidJson<RiskResponse>(config, `/api/v1/agent/credit-attest?${walletQuery}`);
if (attestation.kind === "response") {
  printJson("credit attestation", attestation.data);
  const verification = await verifyPartnerAttestation(attestation.data);
  printJson("partner verification", verification);
}

async function verifyPartnerAttestation(body: RiskResponse): Promise<RiskResponse> {
  const publicKey = pickString(body, ["publicKey", "public_key", "signer", "signer_pubkey"]);
  const payload = pickString(body, ["payload", "message", "signed_payload"]);
  const signature = pickString(body, ["signature", "ed25519_signature"]);
  if (!publicKey || !payload || !signature) {
    return {
      verified: false,
      reason: "attestation response does not expose publicKey, payload, and signature fields yet",
    };
  }
  const key = await webcrypto.subtle.importKey(
    "raw",
    new PublicKey(publicKey).toBytes(),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeSignature(signature),
    new TextEncoder().encode(payload),
  );
  return { verified: valid, publicKey };
}

function pickString(body: RiskResponse, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function decodeSignature(signature: string): Uint8Array {
  const base64 = Buffer.from(signature, "base64");
  if (base64.length === 64) return Uint8Array.from(base64);
  return decodeBase58(signature);
}

function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit === -1) throw new Error("signature is not valid base64 or base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n % 256n));
    n /= 256n;
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
