import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Direct on-chain queries into Magpie's permissionless lending program.
 *
 * No middleman. Reads the LendingPool account from the canonical
 * program ID and returns the typed protocol state. This is what
 * "direct communication with the permissionless lending protocol"
 * means — every response in this service is derived from a fresh (or
 * recently-cached) on-chain account read, not from a copied database.
 *
 * Program IDs (public, verifiable on Solscan):
 *   - magpie-lending v1: 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh
 *   - magpie-lending v2: 7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P
 */
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

export const LENDING_PROGRAM_V1 = new PublicKey("4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh");
export const LENDING_PROGRAM_V2 = new PublicKey("7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P");

/**
 * Derive the LendingPool PDA for a given lender authority.
 * Seeds: ["pool", lender_authority] — matches the on-chain program.
 */
export function lendingPoolPda(lenderAuthority: PublicKey, programId = LENDING_PROGRAM_V1): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), lenderAuthority.toBuffer()],
    programId,
  );
  return pda;
}

/**
 * Typed LendingPool account state. Mirrors the on-chain Anchor account
 * layout in magpie-bot/programs/magpie-lending. All fields are public
 * on-chain so safe to expose.
 */
export interface LendingPoolState {
  lenderAuthority: string;
  totalDepositsLamports: string;       // u64 — cumulative deposits
  totalSharesLamports: string;         // u64 — outstanding LP shares
  totalBorrowedLamports: string;       // u64 — currently lent out (decrements on repay)
  totalLoansIssued: string;            // u64 — cumulative loan count
  totalLiquidations: string;           // u64 — cumulative liquidation count
  totalFeesEarnedLamports: string;     // u64 — cumulative protocol fees
  programId: string;
  poolPda: string;
  fetchedAtMs: number;
}

/**
 * Manual decode of the LendingPool Anchor account. Done by-hand so this
 * service doesn't pull in the entire Anchor runtime (~300KB+) just to
 * decode one fixed-layout account. Layout (matches the IDL):
 *   0..8     account discriminator (skipped)
 *   8..40    lender_authority    (Pubkey, 32 bytes)
 *   40..48   total_deposits      (u64, le)
 *   48..56   total_shares        (u64, le)
 *   56..64   total_borrowed      (u64, le)
 *   64..72   total_loans_issued  (u64, le)
 *   72..80   total_liquidations  (u64, le)
 *   80..88   total_fees_earned   (u64, le)
 *
 * Adjust this layout if the on-chain struct changes. The first 8-byte
 * discriminator from Anchor is what gates compatibility — if the
 * program is redeployed with a struct change, this decode will read
 * garbage. Keep in sync with the IDL.
 */
function decodeLendingPool(data: Buffer): Omit<LendingPoolState, "programId" | "poolPda" | "fetchedAtMs"> {
  if (data.length < 88) throw new Error("pool account too small");
  const u64 = (offset: number) => data.readBigUInt64LE(offset).toString();
  const lender = new PublicKey(data.subarray(8, 40)).toBase58();
  return {
    lenderAuthority: lender,
    totalDepositsLamports: u64(40),
    totalSharesLamports: u64(48),
    totalBorrowedLamports: u64(56),
    totalLoansIssued: u64(64),
    totalLiquidations: u64(72),
    totalFeesEarnedLamports: u64(80),
  };
}

// In-memory cache. Cold start re-fetches; warm requests hit cache.
// 15s TTL — pool state doesn't change faster than that in practice,
// and 15s feels real-time to a calling agent.
const POOL_TTL_MS = 15_000;
const poolCache = new Map<string, { state: LendingPoolState; expiresAt: number }>();

/**
 * Fetch the LendingPool account for a given lender authority.
 * Cached for POOL_TTL_MS. Throws if the account doesn't exist or
 * the program ID is wrong.
 */
export async function fetchLendingPool(
  lenderAuthority: string,
  opts: { programId?: PublicKey; bustCache?: boolean } = {},
): Promise<LendingPoolState> {
  const programId = opts.programId ?? LENDING_PROGRAM_V1;
  const lenderKey = new PublicKey(lenderAuthority);
  const pda = lendingPoolPda(lenderKey, programId);
  const cacheKey = `${programId.toBase58()}:${pda.toBase58()}`;

  if (!opts.bustCache) {
    const cached = poolCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.state;
  }

  const acct = await conn().getAccountInfo(pda, "confirmed");
  if (!acct) throw new Error(`LendingPool not found at ${pda.toBase58()}`);
  if (!acct.owner.equals(programId)) {
    throw new Error(`Pool PDA owned by ${acct.owner.toBase58()}, expected ${programId.toBase58()}`);
  }

  const decoded = decodeLendingPool(Buffer.from(acct.data));
  const state: LendingPoolState = {
    ...decoded,
    programId: programId.toBase58(),
    poolPda: pda.toBase58(),
    fetchedAtMs: Date.now(),
  };
  poolCache.set(cacheKey, { state, expiresAt: Date.now() + POOL_TTL_MS });
  return state;
}

/** Helper: convert a lamports string to a SOL number for display. */
export function lamportsToSol(lamports: string): number {
  return Number(lamports) / 1e9;
}
