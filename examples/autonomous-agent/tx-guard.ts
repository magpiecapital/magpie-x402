/**
 * tx-guard — pre-sign safety checks for server-built transactions.
 *
 * The agent signs transactions built by upstream services it does not control.
 * Those are trusted over TLS (the same assumption every Magpie client and every
 * Jupiter integrator makes), but the operator's bar is "cannot lose money to
 * exploits", so before adding our signature we assert the cheapest high-value
 * invariant available for each builder:
 *
 *   - Magpie build-borrow / build-repay / topup / extend / partial-repay: the
 *     agent IS the fee payer, so `assertFeePayerIsSelf` bounds payer-substitution
 *     attacks — being made to pay for / authorize a tx we did not initiate, or
 *     one whose fee payer was swapped to drain our SOL.
 *
 *   - Jupiter Ultra (`/order`): the returned swap is GASLESS — Jupiter or the RFQ
 *     market-maker is the fee payer BY DESIGN, so fee-payer-is-self does NOT hold
 *     (asserting it there is a false positive that refuses every legitimate swap).
 *     The meaningful invariant is `assertSelfIsRequiredSigner`: the tx genuinely
 *     needs OUR signature (so we never blind-sign an unrelated tx) while letting
 *     a third party pay the fee — strictly better for us, since we pay no gas.
 *
 * Neither check validates every inner instruction of an arbitrary swap; that
 * residual trust in the upstream builder is explicit and documented.
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

/**
 * Assert OUR wallet is a REQUIRED signer of `tx` — i.e. the transaction cannot
 * execute without our signature. Use this for builders that legitimately put a
 * DIFFERENT account as fee payer (e.g. Jupiter Ultra's gasless / RFQ swaps): we
 * still refuse to blind-sign a tx that doesn't actually need us, but we allow a
 * third party to pay the fee. A required signer occupies one of the first
 * `numRequiredSignatures` account slots of the compiled message.
 */
export function assertSelfIsRequiredSigner(
  tx: Transaction | VersionedTransaction,
  self: PublicKey,
  label: string,
): void {
  let signers: PublicKey[];
  if (tx instanceof VersionedTransaction) {
    const n = tx.message.header.numRequiredSignatures;
    signers = tx.message.staticAccountKeys.slice(0, n);
  } else {
    signers = tx.signatures.map((s) => s.publicKey);
    if (tx.feePayer) signers.push(tx.feePayer);
  }
  if (!signers.some((k) => k.equals(self))) {
    throw new Error(
      `${label}: refusing to sign — this wallet ${self.toBase58()} is not a required ` +
        `signer of the tx (required signers: ${signers.map((k) => k.toBase58()).join(", ") || "(none)"}). ` +
        `Won't blind-sign a transaction that doesn't need our authorization.`,
    );
  }
}
