/**
 * Minimal x402 client for the MCP server. Same logic as the
 * examples/lib/x402-client.ts but typed for the MCP context (no
 * keypair-loading helpers; the MCP server loads its keypair once
 * at startup from env vars).
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

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_LOOKUP = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

export interface ClientCtx {
  baseUrl: string;
  rpcUrl: string;
  /** Optional - required only for paid endpoints. */
  payer?: Keypair;
}

export interface PaidResult<T> {
  data: T;
  paid: {
    amountLamports: string;
    txSignature: string;
    nonce: string;
  } | null;
}

export async function call<T = unknown>(
  ctx: ClientCtx,
  method: "GET" | "POST" | "DELETE",
  path: string,
  init: { query?: Record<string, string>; body?: unknown } = {},
): Promise<PaidResult<T>> {
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
      throw new Error(
        `magpie ${first.status} ${path}: ${JSON.stringify(data)}`,
      );
    }
    return { data, paid: null };
  }

  if (!ctx.payer) {
    throw new Error(
      `${path} is a paid endpoint (402) but no payer keypair was configured. Set MAGPIE_MCP_PAYER_KEYPAIR or MAGPIE_MCP_PAYER_SECRET.`,
    );
  }

  const payTo = first.headers.get("X-Payment-Required-Recipient");
  const amountStr = first.headers.get("X-Payment-Required-Amount");
  const nonce = first.headers.get("X-Payment-Required-Nonce");
  const memo = first.headers.get("X-Payment-Required-Memo");
  if (!payTo || !amountStr || !nonce || !memo) {
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
    throw new Error(
      `magpie retry ${retry.status} ${path}: ${JSON.stringify(data)}`,
    );
  }
  return {
    data,
    paid: { amountLamports: amountStr, txSignature: signature, nonce },
  };
}

export function loadKeypairFromEnv(): Keypair | undefined {
  // Two supported forms:
  //   MAGPIE_MCP_PAYER_KEYPAIR=/abs/path/to/id.json (Solana CLI format)
  //   MAGPIE_MCP_PAYER_SECRET=base58_encoded_secret_key
  const path = process.env.MAGPIE_MCP_PAYER_KEYPAIR;
  if (path) {
    const fs = require("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(
      fs.readFileSync(path.replace(/^~/, process.env.HOME || ""), "utf8"),
    ) as number[];
    return Keypair.fromSecretKey(new Uint8Array(raw));
  }

  const secret = process.env.MAGPIE_MCP_PAYER_SECRET?.trim();
  if (!secret) return undefined;

  const secretKey = decodeBase58Secret(secret);
  return Keypair.fromSecretKey(secretKey);
}

function decodeBase58Secret(secret: string): Uint8Array {
  if (!secret) {
    throw new Error("MAGPIE_MCP_PAYER_SECRET is empty");
  }

  const bytes = decodeBase58(secret);
  if (bytes.length !== 64) {
    throw new Error(
      `MAGPIE_MCP_PAYER_SECRET must decode to a 64-byte Solana secret key; got ${bytes.length} bytes`,
    );
  }
  return bytes;
}

function decodeBase58(value: string): Uint8Array {
  const bytes: number[] = [];

  for (const char of value) {
    const digit = BASE58_LOOKUP.get(char);
    if (digit === undefined) {
      throw new Error(`invalid base58 character in MAGPIE_MCP_PAYER_SECRET: ${char}`);
    }

    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      const next = bytes[i] * 58 + carry;
      bytes[i] = next & 0xff;
      carry = next >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}
