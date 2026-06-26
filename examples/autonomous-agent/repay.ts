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
import { Keypair, Transaction } from "@solana/web3.js";
import { paidCall } from "./x402-client.js";
import { assertFeePayerIsSelf } from "./tx-guard.js";
import { rpcConnections, sendAndConfirmFailover } from "./submit.js";
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
  // SECURITY — the borrower pays the repay; the fee payer MUST be us. Refuse to
  // sign a substituted tx whose payer is someone else (defense-in-depth on a
  // server-built tx). Repay always re-attempts later, so a refusal is safe.
  assertFeePayerIsSelf(tx, keypair.publicKey, "build-repay");
  tx.partialSign(keypair);
  // Broadcast + confirm with RPC failover, a dedupe-safe re-broadcast, and a
  // searchTransactionHistory poll so a slow-but-landed repay is detected (not
  // re-paid). The repay is the agent's single most safety-critical RPC.
  const sig = await sendAndConfirmFailover(rpcConnections(cfg.rpcUrl), tx.serialize());
  return { signature: sig };
}
