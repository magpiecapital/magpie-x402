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
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { MagpieSigner } from "./envelope.js";

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

export interface X402ErrorOptions {
  /** Machine-readable failure code, e.g. "confirm_timeout" | "tx_failed" | "submit_failed". */
  code?: string;
  /** True when retrying the same logical request (rebuild + resubmit) may succeed. */
  retryable?: boolean;
}

export class X402Error extends Error {
  readonly status: number;
  readonly response: unknown;
  /** Machine-readable code — lets agents branch retry vs re-quote vs fatal without string-matching the message. */
  readonly code?: string;
  /** True when the failure is transient and a rebuild + resubmit may succeed. */
  readonly retryable: boolean;
  constructor(message: string, status: number, response: unknown, opts: X402ErrorOptions = {}) {
    super(message);
    this.name = "X402Error";
    this.status = status;
    this.response = response;
    this.code = opts.code;
    // Default retryability from the HTTP status when not explicitly set: 429/502/503 are transient.
    this.retryable = opts.retryable ?? (status === 429 || status === 502 || status === 503);
  }
}

export interface X402Context {
  baseUrl: string;
  rpcUrl: string;
  /** Required for paid endpoints (a Keypair, adapted to a MagpieSigner, OR any
   *  external signer — Privy/Turnkey/embedded/SendAI). Free endpoints work without one. */
  signer?: MagpieSigner;
  /** Override the default fetch (handy for tests). */
  fetcher?: typeof fetch;
  /**
   * SECURITY — hard ceiling (lamports) on any single x402 payment. The payTo and
   * amount in a 402 response are server-supplied and therefore untrusted: a
   * compromised or MITM'd endpoint could demand a wallet-draining transfer to an
   * attacker address. A 402 demanding more than this cap is refused, never signed.
   * Defaults to the X402_MAX_PAYMENT_LAMPORTS env, else 20_000_000 (0.02 SOL) —
   * comfortably above the dearest real endpoint (0.01 SOL) and far below any
   * amount worth draining. Raise only for endpoints you explicitly trust.
   */
  maxPaymentLamports?: bigint;
  /**
   * SECURITY — optional allowlist of acceptable payment recipients (base58). When
   * non-empty, a 402 whose recipient is not on the list is refused. Defaults to
   * the X402_ALLOWED_RECIPIENTS env (comma-separated). Empty ⇒ recipient is not
   * pinned and only the amount cap applies. Pin this to the known Magpie fee
   * wallet (server MAGPIE_PAY_TO) to fully neutralize recipient spoofing.
   */
  allowedRecipients?: string[];
}

export async function paidCall<T = unknown>(
  ctx: X402Context,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  init: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<PaidCallResult<T>> {
  const fetcher = ctx.fetcher ?? fetch;
  const url = new URL(path, ctx.baseUrl);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
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
  if (!ctx.signer) {
    throw new X402Error(
      `${path} is a paid endpoint (HTTP 402). Configure a keypair or signer to call it.`,
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

  // ── SECURITY GATE — payTo + amount come from the (untrusted) 402 response ──
  // The signer's key never leaves this process, but a compromised / spoofed /
  // MITM'd endpoint could still demand a large transfer to an attacker wallet.
  // Cap the amount and (optionally) pin the recipient so a hostile 402 can move
  // at most one capped fee, never the wallet.
  const maxPaymentLamports =
    ctx.maxPaymentLamports ?? BigInt(process.env.X402_MAX_PAYMENT_LAMPORTS ?? "20000000");
  if (amount > maxPaymentLamports) {
    throw new X402Error(
      `${path}: 402 demanded ${amount.toString()} lamports, above the ${maxPaymentLamports.toString()}-lamport safety cap — refusing to pay (possible spoofed/MITM 402). ` +
        `Raise maxPaymentLamports / X402_MAX_PAYMENT_LAMPORTS only if you trust this endpoint.`,
      402,
      null,
    );
  }
  const allowedRecipients =
    ctx.allowedRecipients ??
    (process.env.X402_ALLOWED_RECIPIENTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (allowedRecipients.length > 0 && !allowedRecipients.includes(payTo)) {
    throw new X402Error(
      `${path}: 402 recipient ${payTo} is not in the allowlist — refusing to pay (possible spoofed/MITM 402).`,
      402,
      null,
    );
  }

  // Pay on Solana.
  const connection = new Connection(ctx.rpcUrl, "confirmed");
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: ctx.signer.publicKey,
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
  // Sign via the MagpieSigner (a Keypair adapter signs locally; an external
  // wallet signs in its own environment — the secret key never reaches us).
  tx.feePayer = ctx.signer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signedTx = await ctx.signer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signedTx.serialize());
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

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
  headers: Record<string, string> = {},
): Promise<T> {
  const result = await paidCall<T>(ctx, "GET", path, { query, headers });
  return result.data;
}
