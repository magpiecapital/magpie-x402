/**
 * Minimal x402 client — one file, no extra deps beyond @solana/web3.js.
 *
 * Implements the request → 402-challenge → pay → retry-with-signature
 * round-trip used by every paid endpoint on x402.magpie.capital.
 *
 * Public-domain example code. Copy into your project; modify freely.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export interface X402ClientOpts {
  /** Base URL of the x402 service (default production). */
  baseUrl?: string;
  /** Solana RPC endpoint for paying the 402 challenge. */
  rpcUrl: string;
  /** Keypair the agent pays with. */
  payer: Keypair;
}

export interface PaidCallResult<T> {
  data: T;
  paid: {
    amountLamports: string;
    txSignature: string;
    nonce: string;
  } | null;
}

/**
 * Make a paid request. If the endpoint is free, the call returns
 * immediately with paid: null. If it returns 402, the client:
 *   1. Reads the X-Payment-Required-* headers
 *   2. Builds + sends a memo'd transfer for the exact amount
 *   3. Retries the original request with X-Payment: <signature>
 *
 * Throws on any non-2xx after the retry, or on payment build failure.
 */
export async function paidCall<T = unknown>(
  opts: X402ClientOpts,
  method: "GET" | "POST" | "DELETE",
  path: string,
  init: { query?: Record<string, string>; body?: unknown } = {},
): Promise<PaidCallResult<T>> {
  const baseUrl = opts.baseUrl ?? "https://x402.magpie.capital";
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  // First attempt — may come back as 200 (free) or 402 (paid).
  const first = await fetch(url, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (first.status !== 402) {
    const data = (await first.json()) as T;
    if (!first.ok) {
      throw new Error(`x402 ${first.status} ${path}: ${JSON.stringify(data)}`);
    }
    return { data, paid: null };
  }

  // 402 — pay and retry.
  const payTo = first.headers.get("X-Payment-Required-Recipient");
  const amountStr = first.headers.get("X-Payment-Required-Amount");
  const nonce = first.headers.get("X-Payment-Required-Nonce");
  const memo = first.headers.get("X-Payment-Required-Memo");
  if (!payTo || !amountStr || !nonce || !memo) {
    throw new Error(
      `x402 402 missing required headers: ${path}` +
        ` (payTo=${!!payTo} amount=${!!amountStr} nonce=${!!nonce} memo=${!!memo})`,
    );
  }
  const amount = BigInt(amountStr);

  const connection = new Connection(opts.rpcUrl, "confirmed");
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: opts.payer.publicKey,
      toPubkey: new PublicKey(payTo),
      lamports: amount,
    }),
  );
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [opts.payer], {
    commitment: "confirmed",
  });

  // Retry with X-Payment header — server re-derives amount/recipient/memo
  // from the on-chain tx, so anything client-supplied here is just routing.
  const retry = await fetch(url, {
    method,
    headers: { ...headers, "X-Payment": signature },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await retry.json()) as T;
  if (!retry.ok) {
    throw new Error(`x402 retry ${retry.status} ${path}: ${JSON.stringify(data)}`);
  }
  return { data, paid: { amountLamports: amountStr, txSignature: signature, nonce } };
}

/** Free-endpoint helper — same as paidCall but assumes no 402. */
export async function freeGet<T = unknown>(
  baseUrl: string,
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const data = (await res.json()) as T;
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(data)}`);
  return data;
}

/** Load a keypair from JSON array file (the format `solana-keygen` writes). */
export function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(raw));
}
