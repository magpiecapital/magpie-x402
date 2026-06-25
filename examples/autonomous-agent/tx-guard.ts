/**
 * tx-guard — pre-sign safety checks for server-built transactions.
 *
 * The agent signs transactions built by upstream services it does not control:
 * Magpie's build-borrow / build-repay API and Jupiter's swap API. Those are
 * trusted over TLS (the same assumption every Magpie client and every Jupiter
 * integrator makes), but the operator's bar is "cannot lose money to exploits",
 * so before adding our signature we assert the cheapest high-value invariant:
 * the fee payer of the transaction is OUR OWN wallet.
 *
 * This bounds a class of substitution attacks — being made to sign/pay for a
 * transaction we did not initiate, or one whose payer was swapped. It does not
 * (and cannot cheaply) validate every inner instruction of an arbitrary swap;
 * that residual trust in the upstream builder is explicit and documented.
 */
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

export function assertFeePayerIsSelf(
  tx: Transaction | VersionedTransaction,
  self: PublicKey,
  label: string,
): void {
  let feePayer: PublicKey | undefined;
  if (tx instanceof VersionedTransaction) {
    // Account index 0 of a (legacy or v0) compiled message is the fee payer.
    feePayer = tx.message.staticAccountKeys[0];
  } else {
    feePayer = tx.feePayer ?? tx.signatures[0]?.publicKey ?? undefined;
  }
  if (!feePayer || !feePayer.equals(self)) {
    throw new Error(
      `${label}: refusing to sign — fee payer ${feePayer?.toBase58() ?? "(none)"} ` +
        `is not this wallet ${self.toBase58()} (possible malicious / substituted server-built tx).`,
    );
  }
}
