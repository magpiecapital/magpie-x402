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
import { assertFeePayerIsSelf } from "./tx-guard.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_BASE = process.env.JUPITER_BASE ?? "https://lite-api.jup.ag";
const FETCH_TIMEOUT_MS = Number(process.env.JUPITER_TIMEOUT_MS ?? 15_000);

/** fetch() with a hard timeout — a hung Jupiter call must never stall a cycle. */
function jfetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

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
  slippageBps?: number;
}): Promise<BuyResult> {
  const taker = opts.payer.publicKey.toBase58();
  const slip = opts.slippageBps ? `&slippageBps=${opts.slippageBps}` : "";

  // 1) Quote + pre-built transaction.
  const orderUrl =
    `${JUPITER_BASE}/ultra/v1/order?inputMint=${WSOL_MINT}` +
    `&outputMint=${opts.outputMint}&amount=${opts.amountLamports.toString()}&taker=${taker}${slip}`;
  const orderRes = await jfetch(orderUrl, { headers: { Accept: "application/json" } });
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
  // SECURITY — the swap must be fee-paid by us; refuse a substituted tx whose
  // payer is someone else before we add our signature (defense-in-depth on a
  // server-built tx). A skipped swap is safe; the cycle simply retries.
  assertFeePayerIsSelf(tx, opts.payer.publicKey, "jupiter-swap");
  tx.sign([opts.payer]);

  // 3) Hand the signed tx back to Jupiter to land + confirm.
  const execRes = await jfetch(`${JUPITER_BASE}/ultra/v1/execute`, {
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

export interface SellResult {
  ok: boolean;
  signature?: string;
  /** Lamports of SOL received (base units of WSOL). */
  outLamports?: bigint;
  reason?: string;
}

/**
 * SELL `inputMint` back to SOL — the exit half of a trade. Same Ultra rail as the
 * buy, just reversed (inputMint=token → outputMint=WSOL). In dryRun, quote only.
 */
export async function jupiterSell(opts: {
  payer: Keypair;
  inputMint: string;
  amountBaseUnits: bigint;
  rpcUrl: string;
  dryRun: boolean;
  slippageBps?: number;
}): Promise<SellResult> {
  if (opts.amountBaseUnits <= 0n) return { ok: false, reason: "nothing to sell" };
  const taker = opts.payer.publicKey.toBase58();
  const slip = opts.slippageBps ? `&slippageBps=${opts.slippageBps}` : "";

  const orderUrl =
    `${JUPITER_BASE}/ultra/v1/order?inputMint=${opts.inputMint}` +
    `&outputMint=${WSOL_MINT}&amount=${opts.amountBaseUnits.toString()}&taker=${taker}${slip}`;
  const orderRes = await jfetch(orderUrl, { headers: { Accept: "application/json" } });
  const order = (await orderRes.json()) as {
    transaction?: string | null;
    requestId?: string;
    outAmount?: string;
    errorMessage?: string;
  };
  if (!orderRes.ok || !order.transaction || !order.requestId) {
    return { ok: false, reason: `no route/quote: ${order.errorMessage ?? orderRes.status}` };
  }
  const outLamports = order.outAmount ? BigInt(order.outAmount) : undefined;

  if (opts.dryRun) {
    return { ok: true, outLamports, reason: "dry-run (quote only, no swap executed)" };
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([opts.payer]);

  const execRes = await jfetch(`${JUPITER_BASE}/ultra/v1/execute`, {
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
  try {
    await new Connection(opts.rpcUrl, "confirmed").confirmTransaction(exec.signature, "confirmed");
  } catch {
    /* Ultra already lands+confirms. */
  }
  return { ok: true, signature: exec.signature, outLamports };
}

/**
 * QUOTE-ONLY valuation: how many lamports of SOL would `amountBaseUnits` of
 * `inputMint` fetch right now? Free (no swap, no payment). Returns null if no
 * route (illiquid / dead token). Used to mark positions to market each cycle.
 */
export async function jupiterValueInSol(opts: {
  inputMint: string;
  amountBaseUnits: bigint;
  taker: string;
}): Promise<bigint | null> {
  if (opts.amountBaseUnits <= 0n) return 0n;
  const url =
    `${JUPITER_BASE}/ultra/v1/order?inputMint=${opts.inputMint}` +
    `&outputMint=${WSOL_MINT}&amount=${opts.amountBaseUnits.toString()}&taker=${opts.taker}`;
  try {
    const res = await jfetch(url, { headers: { Accept: "application/json" } });
    const j = (await res.json()) as { outAmount?: string };
    if (!res.ok || !j.outAmount) return null;
    return BigInt(j.outAmount);
  } catch {
    return null;
  }
}
