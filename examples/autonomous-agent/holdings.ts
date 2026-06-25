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

export interface TokenHolding {
  mint: string;
  /** Raw u64 balance (base units). */
  amount: string;
  decimals: number;
  /** From the catalog if known, else the mint head. */
  symbol: string;
  category?: string;
}

/**
 * EVERY non-zero SPL / Token-2022 balance the wallet holds — not just Magpie-approved.
 * The trade book must be able to value + SELL anything it bought, even a token that
 * isn't (or is no longer) in Magpie's collateral catalog. WSOL is excluded (that's
 * just wrapped gas, not a position).
 */
export async function getAllTokenHoldings(
  conn: Connection,
  owner: PublicKey,
  catalog: Array<{ mint: string; symbol: string; decimals: number; category: string }> = [],
): Promise<TokenHolding[]> {
  const WSOL = "So11111111111111111111111111111111111111112";
  const byMint = new Map(catalog.map((t) => [t.mint, t]));
  const out: TokenHolding[] = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
    let res;
    try {
      res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    } catch {
      continue;
    }
    for (const { account } of res.value) {
      const info = (account.data as { parsed?: { info?: Record<string, unknown> } }).parsed?.info;
      const mint = info?.mint as string | undefined;
      const ta = info?.tokenAmount as { amount?: string; decimals?: number } | undefined;
      const raw = ta?.amount;
      if (!mint || !raw || mint === WSOL || BigInt(raw) <= 0n) continue;
      const t = byMint.get(mint);
      out.push({
        mint,
        amount: raw,
        decimals: t?.decimals ?? ta?.decimals ?? 0,
        symbol: t?.symbol ?? `${mint.slice(0, 4)}…`,
        category: t?.category,
      });
    }
  }
  return out;
}
