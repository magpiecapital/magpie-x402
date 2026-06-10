/**
 * Minimal x402 client for the yield-bot. Identical pattern to the
 * one used by examples/lib/x402-client.ts and mcp/src/x402-client.ts.
 * Kept inline (not imported across the repo) so the bot is a single
 * deployable unit — fork the agents/yield-bot/ folder and it works.
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

export interface ClientCtx {
  baseUrl: string;
  rpcUrl: string;
  payer?: Keypair;
}

export async function call<T = unknown>(
  ctx: ClientCtx,
  method: "GET" | "POST" | "DELETE",
  path: string,
  init: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ data: T; paidLamports: bigint }> {
  const url = new URL(path, ctx.baseUrl);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  const first = await fetch(url, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  if (first.status !== 402) {
    const data = (await first.json()) as T;
    if (!first.ok) {
      throw new Error(`${first.status} ${path}: ${JSON.stringify(data)}`);
    }
    return { data, paidLamports: 0n };
  }

  if (!ctx.payer) {
    throw new Error(`${path} is a paid endpoint but no payer is configured`);
  }

  const payTo = first.headers.get("X-Payment-Required-Recipient");
  const amountStr = first.headers.get("X-Payment-Required-Amount");
  const memo = first.headers.get("X-Payment-Required-Memo");
  if (!payTo || !amountStr || !memo) {
    throw new Error(`${path} 402 missing required headers`);
  }

  const connection = new Connection(ctx.rpcUrl, "confirmed");
  const tx = new Transaction();
  tx.add(
    SystemProgram.transfer({
      fromPubkey: ctx.payer.publicKey,
      toPubkey: new PublicKey(payTo),
      lamports: BigInt(amountStr),
    }),
  );
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    }),
  );

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [ctx.payer],
    { commitment: "confirmed" },
  );

  const retry = await fetch(url, {
    method,
    headers: { ...headers, "X-Payment": signature },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await retry.json()) as T;
  if (!retry.ok) {
    throw new Error(`retry ${retry.status} ${path}: ${JSON.stringify(data)}`);
  }
  return { data, paidLamports: BigInt(amountStr) };
}

export function loadKeypairFromEnv(): Keypair {
  // Supports the path form (PAYER_KEYPAIR=/abs/path/id.json) so
  // a Railway/Fly/etc deploy can mount a secret file at /etc/keypair.json
  // and just set PAYER_KEYPAIR=/etc/keypair.json.
  // Fallback to inline secret-key array for envs that prefer that.
  const path = process.env.PAYER_KEYPAIR;
  if (path) {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(
      fs.readFileSync(path.replace(/^~/, process.env.HOME || ""), "utf8"),
    ) as number[];
    return Keypair.fromSecretKey(new Uint8Array(raw));
  }
  const inline = process.env.PAYER_SECRET_KEY_JSON;
  if (inline) {
    const raw = JSON.parse(inline) as number[];
    return Keypair.fromSecretKey(new Uint8Array(raw));
  }
  throw new Error(
    "Set PAYER_KEYPAIR=/path/to/keypair.json OR PAYER_SECRET_KEY_JSON=<json-array>",
  );
}
