/**
 * jupiter.ts — the BUY step. Magpie is a lender, not a DEX, so acquiring the
 * collateral happens here, on Jupiter, BEFORE we collateralize it on Magpie.
 *
 * Uses Jupiter's Ultra API (handles routing, slippage, priority fees, landing,
 * retries). Default host is the keyless Lite endpoint — switch JUPITER_BASE to
 * a keyed Ultra/Pro endpoint for production volume.
 *
 * ⚠️ This is the ONE integration outside Magpie's verified SDK. Confirm the
 *    Ultra request/response shape against current Jupiter docs before LIVE use,
 *    and test with a tiny amount first (real swaps are mainnet-only).
 */
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_BASE = process.env.JUPITER_BASE ?? "https://lite-api.jup.ag";

export interface BuyResult {
  ok: boolean;
  signature?: string;
  /** Raw output-token amount expected/received (base units). */
  outAmount?: string;
  reason?: string;
}

/**
 * Buy `outputMint` by spending `amountLamports` of SOL from `payer`.
 * In dryRun, only fetches the quote and returns the expected outAmount.
 */
export async function jupiterBuy(opts: {
  payer: Keypair;
  outputMint: string;
  amountLamports: bigint;
  rpcUrl: string;
  dryRun: boolean;
}): Promise<BuyResult> {
  const taker = opts.payer.publicKey.toBase58();

  // 1) Quote + pre-built transaction.
  const orderUrl =
    `${JUPITER_BASE}/ultra/v1/order?inputMint=${WSOL_MINT}` +
    `&outputMint=${opts.outputMint}&amount=${opts.amountLamports.toString()}&taker=${taker}`;
  const orderRes = await fetch(orderUrl, { headers: { Accept: "application/json" } });
  const order = (await orderRes.json()) as {
    transaction?: string | null;
    requestId?: string;
    outAmount?: string;
    errorMessage?: string;
  };
  if (!orderRes.ok || !order.transaction || !order.requestId) {
    return { ok: false, reason: `no route/quote: ${order.errorMessage ?? orderRes.status}` };
  }

  if (opts.dryRun) {
    return { ok: true, outAmount: order.outAmount, reason: "dry-run (quote only, no swap executed)" };
  }

  // 2) Sign the returned transaction locally (keys never leave this process).
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([opts.payer]);

  // 3) Hand the signed tx back to Jupiter to land + confirm.
  const execRes = await fetch(`${JUPITER_BASE}/ultra/v1/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId,
    }),
  });
  const exec = (await execRes.json()) as { status?: string; signature?: string; error?: string };
  if (!execRes.ok || exec.status === "Failed" || !exec.signature) {
    return { ok: false, reason: `execute failed: ${exec.error ?? exec.status ?? execRes.status}` };
  }

  // 4) Defensive confirm.
  try {
    await new Connection(opts.rpcUrl, "confirmed").confirmTransaction(exec.signature, "confirmed");
  } catch {
    /* Ultra already lands+confirms; this is belt-and-suspenders. */
  }
  return { ok: true, signature: exec.signature, outAmount: order.outAmount };
}
