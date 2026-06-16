/**
 * 11 - Portfolio-risk agent.
 *
 * Fetches a paid Magpie credit score, fetches the cheaper signed credit
 * attestation, verifies the Ed25519 signature when the response exposes
 * payload + signer + signature fields, then prints a packet another
 * protocol can consume.
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/11-portfolio-risk-agent.ts <WALLET_PUBKEY>
 */
import "dotenv/config";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  type CreditAttestation,
  pickAttestationString,
  verifyCreditAttestation,
} from "./lib/attestation.js";
import { loadKeypairFromFile, paidCall } from "./lib/x402-client.js";

type JsonRecord = Record<string, unknown>;

interface CreditScore extends JsonRecord {
  wallet: string;
  score: number;
  tier: string;
  range?: { min: number; max: number };
  benefits?: JsonRecord;
  source?: string;
}

const payerPath = process.env.X402_PAYER_KEYPAIR;
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
if (!payerPath) {
  console.error("Set X402_PAYER_KEYPAIR to a keypair JSON file path");
  process.exit(1);
}

const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));
const wallet = process.argv[2] ?? process.env.PORTFOLIO_RISK_WALLET ?? payer.publicKey.toBase58();
try {
  new PublicKey(wallet);
} catch {
  console.error(`Invalid wallet pubkey: ${wallet}`);
  process.exit(1);
}

const client = { rpcUrl, payer, baseUrl };

console.log("--- Step 1: credit-score risk tier (paid 0.001 SOL) ---");
// paidCall performs the x402 round trip: request, receive 402 challenge,
// send the Solana payment, then retry with X-Payment: <tx signature>.
const score = await paidCall<CreditScore>(client, "GET", "/api/v1/credit-score", {
  query: { wallet },
});
console.log(JSON.stringify(score.data, null, 2));

console.log("\n--- Step 2: signed credit attestation (paid 0.0005 SOL) ---");
// The attestation is cheaper than a full score lookup and can be carried
// to a partner protocol, where the Ed25519 payload is verified locally.
const attestation = await paidCall<CreditAttestation>(
  client,
  "GET",
  "/api/v1/agent/credit-attest",
  { query: { wallet } },
);
const signatureCheck = verifyCreditAttestation(attestation.data);

console.log(
  JSON.stringify(
    {
      wallet,
      payments: { creditScore: score.paid, creditAttestation: attestation.paid },
      signatureCheck,
      partnerPacket: {
        wallet,
        score: score.data.score,
        tier: score.data.tier,
        signedPayload: signatureCheck.payload,
        signer: signatureCheck.signer,
        signature: pickAttestationString(attestation.data, [
          "signature",
          "signature_b64",
          "signature_base64",
        ]),
        expiresAt: pickAttestationString(attestation.data, ["expires_at", "expiresAt", "expires"]),
        rawAttestation: attestation.data,
      },
    },
    null,
    2,
  ),
);

if (signatureCheck.verified === false) process.exitCode = 1;
