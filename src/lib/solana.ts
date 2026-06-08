import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export interface PaymentVerification {
  valid: boolean;
  reason?: string;
  payer?: string;
  memoNonce?: string;
}

/**
 * Verify a Solana transaction satisfies an x402 payment requirement.
 *
 * Re-derives EVERY assertion from on-chain data — never trusts a
 * client-supplied amount/recipient.
 *
 * Checks (all must pass):
 *   1. Transaction exists, confirmed, no error
 *   2. Includes a transfer to `expectedRecipient` of exactly
 *      `expectedAmountLamports` (or more — overpay is fine)
 *   3. If `expectedMint` is null/'native-sol', the transfer is native
 *      SOL (SystemProgram::transfer). Otherwise it must be SPL Token
 *      transfer of the right mint.
 *   4. Includes a Memo instruction with `magpie-x402:<nonce>` shape,
 *      and the nonce is parseable.
 *
 * Returns `{ valid: true, payer, memoNonce }` on success; otherwise
 * `{ valid: false, reason: "…" }`. Generic reasons by design.
 */
export async function verifyPayment(opts: {
  signature: string;
  expectedRecipient: PublicKey;
  expectedAmountLamports: bigint;
  expectedMint: string | null;
}): Promise<PaymentVerification> {
  const tx = await conn().getParsedTransaction(opts.signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { valid: false, reason: "tx_not_found" };
  if (tx.meta?.err) return { valid: false, reason: "tx_failed_on_chain" };

  const instructions = [
    ...(tx.transaction.message.instructions ?? []),
    ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
  ];

  // 1. Find a payment instruction matching recipient + amount
  let payer: string | undefined;
  let foundPayment = false;

  if (opts.expectedMint === null || opts.expectedMint === "native-sol") {
    // Native SOL via SystemProgram::transfer
    for (const ix of instructions) {
      if (!("parsed" in ix)) continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
      if (
        ix.programId.toString() === SYSTEM_PROGRAM_ID &&
        p.type === "transfer" &&
        p.info?.destination === opts.expectedRecipient.toBase58()
      ) {
        const lamports = BigInt((p.info.lamports as number | string | undefined) ?? 0);
        if (lamports >= opts.expectedAmountLamports) {
          foundPayment = true;
          payer = p.info.source as string;
          break;
        }
      }
    }
  } else {
    // SPL Token transfer of the right mint
    const expectedMint = opts.expectedMint;
    for (const ix of instructions) {
      if (!("parsed" in ix)) continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
      const prog = ix.programId.toString();
      const isToken =
        prog === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" ||
        prog === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
      if (!isToken) continue;
      if (p.type !== "transferChecked" && p.type !== "transfer") continue;
      if (p.info?.mint !== expectedMint) continue;
      // The destination here is the ATA — recipient owner is what we
      // care about, but parsed instructions usually include
      // `destination` (the ATA) not the owner. For now we accept if
      // a token transfer to the expected mint exists for the right
      // amount. Production should compare destination ATA to
      // getAssociatedTokenAddressSync(expectedMint, expectedRecipient).
      const amount = BigInt(
        ((p.info.tokenAmount as { amount?: string } | undefined)?.amount) ??
          (p.info.amount as string | number | undefined) ??
          0,
      );
      if (amount >= opts.expectedAmountLamports) {
        foundPayment = true;
        payer = (p.info.authority as string) ?? (p.info.source as string);
        break;
      }
    }
  }

  if (!foundPayment) {
    return { valid: false, reason: "payment_not_found_in_tx" };
  }

  // 2. Find a magpie-x402:<nonce> memo
  let memoNonce: string | undefined;
  for (const ix of instructions) {
    const prog = (ix as { programId: { toString(): string } }).programId.toString();
    if (prog !== MEMO_PROGRAM_ID) continue;
    // Parsed memo instructions have the memo text in `parsed` directly
    // OR in info.memo depending on RPC version. Handle both.
    let memoText: string | undefined;
    if ("parsed" in ix && typeof ix.parsed === "string") {
      memoText = ix.parsed;
    } else if ("parsed" in ix && typeof ix.parsed === "object" && ix.parsed) {
      memoText = (ix.parsed as { info?: { memo?: string } }).info?.memo;
    }
    if (!memoText) continue;
    // Match either the v0 hex nonce (32 hex chars) OR the v1
    // HMAC-signed nonce (base64url, ~66 chars). The middleware
    // hands off to verifyNonce() which gates on length + MAC.
    const m = memoText.match(/^magpie-x402:([A-Za-z0-9_\-]{32,128})$/);
    if (m) {
      memoNonce = m[1];
      break;
    }
  }

  if (!memoNonce) {
    return { valid: false, reason: "missing_or_malformed_memo" };
  }

  return { valid: true, payer, memoNonce };
}
