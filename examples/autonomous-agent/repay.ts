/**
 * repay.ts — the repay leg.
 *
 * The published @magpieloans/magpie-agent@0.1.x SDK does NOT expose a repay()
 * method, so the never-default guardian repays directly against the x402 HTTP
 * API: POST /api/v1/agent/build-repay (0.002 SOL) → the bot returns the built
 * repay tx → the borrower signs it locally and submits to RPC. Repay is
 * BORROWER-ONLY (no lender cosign), so there is no cosign round-trip.
 *
 * The on-chain program computes the exact amount owed, so the repay pays
 * precisely what's due — the guardian's reserve is only a solvency buffer.
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { paidCall } from "./x402-client.js";
import type { AgentConfig } from "./config.js";

export interface RepayResult {
  signature: string;
}

export async function repayLoan(
  keypair: Keypair,
  loanPda: string,
  cfg: AgentConfig,
): Promise<RepayResult> {
  const { data } = await paidCall<{ partial_signed_tx_b64?: string; error?: string }>(
    { baseUrl: cfg.baseUrl, rpcUrl: cfg.rpcUrl, payer: keypair },
    "POST",
    "/api/v1/agent/build-repay",
    { body: { borrower_wallet: keypair.publicKey.toBase58(), loan_pda: loanPda } },
  );
  if (!data.partial_signed_tx_b64) {
    throw new Error(`build-repay returned no tx: ${data.error ?? "unknown"}`);
  }
  // Legacy tx (matches the SDK's signAndSubmit). Borrower signs + submits; no cosign.
  const tx = Transaction.from(Buffer.from(data.partial_signed_tx_b64, "base64"));
  tx.partialSign(keypair);
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  return { signature: sig };
}
