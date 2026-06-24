/**
 * holdings.ts — what the agent ALREADY holds that Magpie accepts as collateral.
 *
 * The agent doesn't only buy fresh collateral; if the wallet already holds an
 * approved token (e.g. BONK), it's cheaper + faster to borrow against THAT
 * directly — no Jupiter buy, no slippage. This enumerates the wallet's SPL +
 * Token-2022 balances and intersects them with Magpie's approved catalog.
 */
import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export interface HeldCollateral {
  mint: string;
  symbol: string;
  decimals: number;
  category: string;
  /** Raw u64 balance (base units). */
  amount: string;
}

export async function getExistingCollateral(
  conn: Connection,
  owner: PublicKey,
  catalog: Array<{ mint: string; symbol: string; decimals: number; category: string }>,
): Promise<HeldCollateral[]> {
  const byMint = new Map(catalog.map((t) => [t.mint, t]));
  const out: HeldCollateral[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    let res;
    try {
      res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    } catch {
      continue; // a missing token-2022 account set is fine
    }
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      const mint = info?.mint as string | undefined;
      const raw = (info?.tokenAmount as { amount?: string } | undefined)?.amount;
      const t = mint ? byMint.get(mint) : undefined;
      if (t && raw && BigInt(raw) > 0n) {
        out.push({ mint: t.mint, symbol: t.symbol, decimals: t.decimals, category: t.category, amount: raw });
      }
    }
  }
  return out;
}
