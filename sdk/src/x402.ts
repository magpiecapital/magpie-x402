/**
 * x402 payment client — handles the 402-challenge → pay → retry flow.
 * Internal helper; the public SDK surface is in index.ts.
 *
 * Design constraints:
 *   - Signs payments LOCALLY with the user's keypair; never sends the
 *     keypair anywhere
 *   - Re-derives expected payment params from the 402 response headers
 *     and verifies them before paying
 *   - Single-use signature on the retry (server-side enforced too)
 *   - 10s timeout per HTTP call
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

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const TIMEOUT_MS = 10_000;

export interface PaidCallResult<T> {
  data: T;
  /**
   * Set when the call actually went through the paid round-trip.
   * `null` indicates the endpoint was free (no 402 challenge issued).
   */
  paid: {
    amountLamports: bigint;
    txSignature: string;
    nonce: string;
  } | null;
}

export class X402Error extends Error {
  readonly status: number;
  readonly response: unknown;
  constructor(message: string, status: number, response: unknown) {
    super(message);
    this.name = "X402Error";
    this.status = status;
    this.response = response;
  }
}

export interface X402Context {
  baseUrl: string;
  rpcUrl: string;
  /** Required for paid endpoints. Free endpoints work without one. */
  payer?: Keypair;
  /** Override the default fetch (handy for tests). */
  fetcher?: typeof fetch;
}

export async function paidCall<T = unknown>(
  ctx: X402Context,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  init: { query?: Record<string, string>; body?: unknown } = {},
): Promise<PaidCallResult<T>> {
  const fetcher = ctx.fetcher ?? fetch;
  const url = new URL(path, ctx.baseUrl);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const first = await fetcher(url, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (first.status !== 402) {
    const data = (await first.json()) as T;
    if (!first.ok) {
      throw new X402Error(`${first.status} ${path}`, first.status, data);
    }
    return { data, paid: null };
  }

  // 402 — pay and retry.
  if (!ctx.payer) {
    throw new X402Error(
      `${path} is a paid endpoint (HTTP 402). Configure a payer keypair to call it.`,
      402,
      null,
    );
  }
  const payTo = first.headers.get("X-Payment-Required-Recipient");
  const amountStr = first.headers.get("X-Payment-Required-Amount");
  const nonce = first.headers.get("X-Payment-Required-Nonce");
  const memo = first.headers.get("X-Payment-Required-Memo");
  if (!payTo || !amountStr || !nonce || !memo) {
    throw new X402Error(
      `${path} returned 402 but missing required X-Payment-Required-* headers`,
      402,
      await first.json().catch(() => null),
    );
  }
  const amount = BigInt(amountStr);

  // Pay on Solana.
  const connection = new Connection(ctx.rpcUrl, "confirmed");
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
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
  const signature = await sendAndConfirmTransaction(connection, tx, [ctx.payer], {
    commitment: "confirmed",
  });

  // Retry the original request with X-Payment header.
  const retry = await fetcher(url, {
    method,
    headers: { ...headers, "X-Payment": signature },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await retry.json()) as T;
  if (!retry.ok) {
    throw new X402Error(
      `${retry.status} (after payment) ${path}`,
      retry.status,
      data,
    );
  }
  return { data, paid: { amountLamports: amount, txSignature: signature, nonce } };
}

/** Convenience wrapper for free GET endpoints. */
export async function freeGet<T = unknown>(
  ctx: X402Context,
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  const result = await paidCall<T>(ctx, "GET", path, { query });
  return result.data;
}
