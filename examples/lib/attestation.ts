import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

type JsonRecord = Record<string, unknown>;

export interface CreditAttestation extends JsonRecord {
  payload?: string | JsonRecord;
  message?: string | JsonRecord;
  signature?: string;
  signature_b64?: string;
  signature_base64?: string;
  signer?: string;
  signer_pubkey?: string;
  public_key?: string;
  authority?: string;
  expires_at?: string;
  expiresAt?: string;
}

export interface AttestationVerification {
  verified: boolean | null;
  reason?: string;
  payload?: string;
  signer?: string;
}

export function verifyCreditAttestation(attestation: CreditAttestation): AttestationVerification {
  const payload = exactSignedPayload(attestation);
  const signature = pickAttestationString(attestation, ["signature", "signature_b64", "signature_base64"]);
  const signer = pickAttestationString(attestation, ["signer", "signer_pubkey", "public_key", "authority"]);
  if (!payload || !signature || !signer) {
    return {
      verified: null,
      reason: "attestation response must include payload/message, signature, and signer pubkey",
      payload,
      signer,
    };
  }

  try {
    const verified = nacl.sign.detached.verify(
      Buffer.from(payload, "utf8"),
      decodeSignature(signature),
      new PublicKey(signer).toBytes(),
    );
    return {
      verified,
      reason: verified ? undefined : "signature does not match payload and signer",
      payload,
      signer,
    };
  } catch (err) {
    return { verified: false, reason: (err as Error).message, payload, signer };
  }
}

export function pickAttestationString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function exactSignedPayload(attestation: CreditAttestation): string | undefined {
  const payload = attestation.payload ?? attestation.message;
  if (typeof payload === "string") return payload;
  if (isRecord(payload)) return stableStringify(payload);
  return undefined;
}

function decodeSignature(signature: string): Uint8Array {
  const value = signature.trim();
  if (/^[0-9a-fA-F]{128}$/.test(value)) return new Uint8Array(Buffer.from(value, "hex"));

  const base64 = Buffer.from(value, "base64");
  if (base64.length === 64 && base64.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "")) {
    return new Uint8Array(base64);
  }

  const base58 = bs58.decode(value);
  if (base58.length !== 64) throw new Error("signature must decode to 64 bytes");
  return base58;
}

function stableStringify(value: JsonRecord): string {
  const sorted: JsonRecord = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
