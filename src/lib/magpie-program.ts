import { Connection, PublicKey } from "@solana/web3.js";
import type { GetProgramAccountsFilter } from "@solana/web3.js";

/**
 * Direct on-chain queries into Magpie's permissionless lending programs.
 *
 * Magpie runs THREE live lending programs, one per strategy. They are
 * SEPARATE on-chain programs with SEPARATE pools, loans, and vaults — a
 * loan opened on one is never readable or manageable through another.
 * This module is the single source of truth for that separation: every
 * loan read in the service routes through a per-version decoder that is
 * guarded by (program owner + exact account size + Anchor discriminator)
 * so a V1 (memecoin) loan can never be mis-decoded as a V4 (exit) loan.
 *
 * Program IDs (public, verifiable on Solscan):
 *   - V1  memecoin loans, no exits ......... 4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh
 *   - V2  wound down (program-data closed) .. 7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P
 *   - V3  RWA / tokenized-asset loans ....... B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP
 *   - V4  in-vault auto-sell exit loans ..... HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo
 *
 * Borrow-time routing (the master table the bot enforces; mirrored here
 * for the read + discovery surface):
 *   no-exits + memecoin  -> V1
 *   no-exits + RWA       -> V3
 *   with-exits (any)     -> V4
 */
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

// Program IDs. V4 is overridable via env for staging/testnet; the
// hardcoded values are the public mainnet program IDs.
export const LENDING_PROGRAM_V1 = new PublicKey(
  process.env.PROGRAM_ID_V1 || "4FEFPeMH68BbkrrZW2ak9wWXUS7JCkvXqBkGf5Bg6wmh",
);
export const LENDING_PROGRAM_V2 = new PublicKey(
  process.env.PROGRAM_ID_V2 || "7tapneCmNwRVEtdeZks4649Q2rf8W1t9tshMN9yHX99P",
);
export const LENDING_PROGRAM_V3 = new PublicKey(
  process.env.PROGRAM_ID_V3 || "B8AwYzFmc3ZB5EWWVtJcJhJtEmKL78W5i3kZrL1uMCmP",
);
export const LENDING_PROGRAM_V4 = new PublicKey(
  process.env.PROGRAM_ID_V4 || "HA1hgvskN1goEsb33rNHFBcDXBaYyLyyqfGwGMgTUwNo",
);

/** The three live loan-issuing program versions, in read-precedence order. */
export type ProgramVersion = "v1" | "v3" | "v4";
export const LOAN_VERSIONS: readonly ProgramVersion[] = ["v4", "v3", "v1"] as const;

const PROGRAM_ID_BY_VERSION: Record<ProgramVersion, PublicKey> = {
  v1: LENDING_PROGRAM_V1,
  v3: LENDING_PROGRAM_V3,
  v4: LENDING_PROGRAM_V4,
};

export function programIdForVersion(v: ProgramVersion): PublicKey {
  return PROGRAM_ID_BY_VERSION[v];
}

/** Reverse map: which version owns this program id (or null if none). */
export function versionForProgramId(programId: PublicKey): ProgramVersion | null {
  for (const v of LOAN_VERSIONS) {
    if (PROGRAM_ID_BY_VERSION[v].equals(programId)) return v;
  }
  return null;
}

/**
 * The 8-byte Anchor account discriminator for the `Loan` account.
 *
 * IMPORTANT: Anchor derives the discriminator from the account STRUCT NAME
 * (`sha256("account:Loan")[..8]`), NOT the program. All three programs name
 * the struct `Loan`, so they SHARE this discriminator. That means the
 * discriminator alone CANNOT tell V1/V3/V4 apart — only (program owner +
 * exact account size) can. We still verify the discriminator as a guard
 * against decoding a *non-Loan* account of a colliding size owned by the
 * same program. Verified on-chain 2026-06-20 against live V1/V3/V4 loans.
 */
export const LOAN_DISCRIMINATOR = Buffer.from("14c34675a5e3b601", "hex");

/**
 * Per-version Loan account sizes (bytes). VERIFIED on-chain 2026-06-20 via
 * PDA self-check (loan_id@8 + borrower@16 + seeds ["loan", borrower, id]
 * re-derive to the account address for 5/5 sampled accounts per version)
 * AND against the Rust structs in magpie-lending / -v3 / magpie-v4.
 *
 *   V1 = 206  (base Loan struct)
 *   V3 = 207  (+ category u8)
 *   V4 = 224  (+ category u8, current_collateral u64, sol_proceeds u64,
 *              auto_sells_fired u8)
 *
 * The three sizes are DISTINCT, which is what makes a getProgramAccounts
 * dataSize filter a hard version separator.
 */
export const LOAN_SIZE: Record<ProgramVersion, number> = {
  v1: 206,
  v3: 207,
  v4: 224,
};

/** Reverse map size -> version (only exact matches). */
export function versionForLoanSize(size: number): ProgramVersion | null {
  for (const v of LOAN_VERSIONS) {
    if (LOAN_SIZE[v] === size) return v;
  }
  return null;
}

/**
 * Loan field offsets, after the 8-byte Anchor discriminator. The base
 * layout is IDENTICAL across V1/V3/V4 (the structs share a common prefix);
 * V3 appends `category`, V4 appends the in-vault exit state. Verified
 * against the on-chain Rust structs 2026-06-20.
 */
const OFF = {
  loanId: 8, // u64
  borrower: 16, // Pubkey (32)
  pool: 48, // Pubkey (32)
  collateralMint: 80, // Pubkey (32)
  collateralVault: 112, // Pubkey (32)
  collateralAmount: 144, // u64
  loanAmount: 152, // u64
  repayAmount: 160, // u64
  transactionFee: 168, // u64
  ltvBps: 176, // u16
  durationDays: 178, // u8
  startTimestamp: 179, // i64
  dueTimestamp: 187, // i64
  status: 195, // u8 (LoanStatus)
  collateralValueAtStart: 196, // u64
  bump: 204, // u8
  vaultBump: 205, // u8
  // V3 + V4
  category: 206, // u8 (0 = memecoin, 1 = RWA)
  // V4 only — in-vault auto-sell state
  currentCollateralAmount: 207, // u64
  solProceedsAmount: 215, // u64
  autoSellsFired: 223, // u8
} as const;

/** LoanStatus enum (Anchor order): 0 = Active, 1 = Repaid, 2 = Liquidated. */
export type LoanStatusName = "active" | "repaid" | "liquidated" | "unknown";
export function loanStatusName(b: number): LoanStatusName {
  return b === 0 ? "active" : b === 1 ? "repaid" : b === 2 ? "liquidated" : "unknown";
}
/** bs58 of a single 0x00 byte — the memcmp needle for status === Active. */
export const ACTIVE_STATUS_BYTES_BS58 = "1";

/**
 * Decoded Loan. Fields present on every version; `category` is present on
 * V3/V4; the `v4` block is present only on V4 loans (in-vault exit state).
 */
export interface DecodedLoan {
  programVersion: ProgramVersion;
  programId: string;
  loanPda: string;
  loanId: string;
  borrower: string;
  pool: string;
  collateralMint: string;
  collateralVault: string;
  collateralAmount: string;
  loanAmountLamports: string;
  repayAmountLamports: string;
  transactionFeeLamports: string;
  ltvBps: number;
  durationDays: number;
  startTimestampUnix: number;
  dueTimestampUnix: number;
  status: LoanStatusName;
  collateralValueAtStart: string;
  /** 'memecoin' | 'rwa' — undefined on V1 (no category field on-chain). */
  category?: "memecoin" | "rwa";
  /** In-vault auto-sell state — present only on V4 loans. */
  v4?: {
    currentCollateralAmount: string;
    solProceedsLamports: string;
    autoSellsFired: number;
  };
  /** True only for V4 loans — the sole version that supports exit orders. */
  exitsSupported: boolean;
}

const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o).toString();
const i64 = (d: Buffer, o: number) => Number(d.readBigInt64LE(o));

/**
 * Decode a Loan account for a KNOWN version. Throws if the buffer fails the
 * defensive guard (exact size + discriminator). The caller is responsible
 * for pairing `version` with the account's true program owner — use
 * `decodeLoanGuarded` when the version is derived from the owner.
 */
export function decodeLoanForVersion(
  pda: PublicKey,
  data: Buffer,
  version: ProgramVersion,
): DecodedLoan {
  const expectedSize = LOAN_SIZE[version];
  if (data.length !== expectedSize) {
    throw new Error(
      `loan size mismatch for ${version}: got ${data.length}, expected ${expectedSize}`,
    );
  }
  if (!data.subarray(0, 8).equals(LOAN_DISCRIMINATOR)) {
    throw new Error(`loan discriminator mismatch for ${version}`);
  }

  const hasCategory = version === "v3" || version === "v4";
  const isV4 = version === "v4";

  return {
    programVersion: version,
    programId: PROGRAM_ID_BY_VERSION[version].toBase58(),
    loanPda: pda.toBase58(),
    loanId: u64(data, OFF.loanId),
    borrower: new PublicKey(data.subarray(OFF.borrower, OFF.borrower + 32)).toBase58(),
    pool: new PublicKey(data.subarray(OFF.pool, OFF.pool + 32)).toBase58(),
    collateralMint: new PublicKey(
      data.subarray(OFF.collateralMint, OFF.collateralMint + 32),
    ).toBase58(),
    collateralVault: new PublicKey(
      data.subarray(OFF.collateralVault, OFF.collateralVault + 32),
    ).toBase58(),
    collateralAmount: u64(data, OFF.collateralAmount),
    loanAmountLamports: u64(data, OFF.loanAmount),
    repayAmountLamports: u64(data, OFF.repayAmount),
    transactionFeeLamports: u64(data, OFF.transactionFee),
    ltvBps: data.readUInt16LE(OFF.ltvBps),
    durationDays: data.readUInt8(OFF.durationDays),
    startTimestampUnix: i64(data, OFF.startTimestamp),
    dueTimestampUnix: i64(data, OFF.dueTimestamp),
    status: loanStatusName(data.readUInt8(OFF.status)),
    collateralValueAtStart: u64(data, OFF.collateralValueAtStart),
    category: hasCategory
      ? data.readUInt8(OFF.category) === 1
        ? "rwa"
        : "memecoin"
      : undefined,
    v4: isV4
      ? {
          currentCollateralAmount: u64(data, OFF.currentCollateralAmount),
          solProceedsLamports: u64(data, OFF.solProceedsAmount),
          autoSellsFired: data.readUInt8(OFF.autoSellsFired),
        }
      : undefined,
    exitsSupported: isV4,
  };
}

/**
 * Decode a Loan account whose version is determined FROM THE ACCOUNT ITSELF
 * (owner + size). This is the pool-separation-safe entry point: it refuses
 * to decode unless the owner maps to a known version AND the account size
 * matches that version's exact Loan size AND the discriminator checks out.
 * Returns null on any mismatch rather than producing a misattributed loan.
 */
export function decodeLoanGuarded(
  pda: PublicKey,
  owner: PublicKey,
  data: Buffer,
): DecodedLoan | null {
  const version = versionForProgramId(owner);
  if (!version) return null; // not owned by a known lending program
  if (data.length !== LOAN_SIZE[version]) return null; // size != this version's Loan
  if (!data.subarray(0, 8).equals(LOAN_DISCRIMINATOR)) return null; // not a Loan account
  try {
    return decodeLoanForVersion(pda, data, version);
  } catch {
    return null;
  }
}

/**
 * A getProgramAccounts memcmp filter that keeps only `Loan` accounts (by
 * the 8-byte discriminator). Pairs with a per-version dataSize filter so the
 * RPC only returns real loans of that exact version. Base64-encoded so we
 * don't need a base58 dependency.
 */
export function loanDiscriminatorFilter(): GetProgramAccountsFilter {
  return { memcmp: { offset: 0, bytes: LOAN_DISCRIMINATOR.toString("base64"), encoding: "base64" } };
}

/**
 * Fan a getProgramAccounts query across the lending program versions,
 * decoding each result through the pool-separation-safe guard.
 *
 * EVERY version is fetched in its OWN try/catch: if the V4 RPC call throws,
 * V1 and V3 results are still returned, with `partial.v4 = 'error'` set.
 * This is the lane-separation guarantee on the read path — a V4 outage can
 * never blank out a borrower's V1/V3 portfolio view. Accounts that fail the
 * owner+size+discriminator guard are dropped (never misattributed).
 *
 * `buildFilters(version)` supplies the per-version filter set (it MUST
 * include the version's exact dataSize so only that version's loans match).
 */
export async function fetchLoansAcrossVersions(
  buildFilters: (v: ProgramVersion) => GetProgramAccountsFilter[],
  opts: { versions?: readonly ProgramVersion[] } = {},
): Promise<{ loans: DecodedLoan[]; partial: Partial<Record<ProgramVersion, "error">> }> {
  const versions = opts.versions ?? LOAN_VERSIONS;
  const partial: Partial<Record<ProgramVersion, "error">> = {};
  const loans: DecodedLoan[] = [];

  await Promise.all(
    versions.map(async (v) => {
      try {
        const accts = await conn().getProgramAccounts(programIdForVersion(v), {
          commitment: "confirmed",
          filters: buildFilters(v),
        });
        for (const { pubkey, account } of accts) {
          const loan = decodeLoanGuarded(pubkey, account.owner, Buffer.from(account.data));
          if (loan) loans.push(loan); // guard drops anything that isn't a clean `v` loan
        }
      } catch (err) {
        partial[v] = "error";
        console.warn(`[loans] ${v} getProgramAccounts failed:`, (err as Error).message);
      }
    }),
  );

  return { loans, partial };
}

/**
 * Fetch + decode a single Loan account by its PDA, routing to the correct
 * version purely from the account's on-chain owner (pool-separation-safe).
 * Returns null if the account doesn't exist or isn't a clean Loan of a known
 * version. Unambiguous — one PDA is exactly one loan.
 */
export async function fetchLoanByPda(loanPdaKey: PublicKey): Promise<DecodedLoan | null> {
  const acct = await conn().getAccountInfo(loanPdaKey, "confirmed");
  if (!acct) return null;
  return decodeLoanGuarded(loanPdaKey, acct.owner, Buffer.from(acct.data));
}

/**
 * Find every loan a borrower holds under a given loan_id, ACROSS versions.
 * Because each program has its OWN loan_id sequence, a borrower can hold the
 * same numeric loan_id in more than one program — so this returns a list, not
 * a single loan. Each version is derived + fetched independently (fail-soft):
 * a V4 RPC error is reported in `partial` and never aborts the V1/V3 lookups.
 */
export async function findLoansByBorrowerAndId(
  borrower: PublicKey,
  loanId: bigint,
  versions: readonly ProgramVersion[] = LOAN_VERSIONS,
): Promise<{ loans: DecodedLoan[]; partial: Partial<Record<ProgramVersion, "error">> }> {
  const partial: Partial<Record<ProgramVersion, "error">> = {};
  const loans: DecodedLoan[] = [];
  await Promise.all(
    versions.map(async (v) => {
      const pda = loanPda(borrower, loanId, programIdForVersion(v));
      try {
        const loan = await fetchLoanByPda(pda);
        if (loan && loan.programVersion === v) loans.push(loan);
      } catch (err) {
        partial[v] = "error";
        console.warn(`[loan] ${v} getAccountInfo failed:`, (err as Error).message);
      }
    }),
  );
  return { loans, partial };
}

/**
 * Derive a Loan PDA. Seeds are ["loan", borrower, loan_id_le] — the borrower
 * is part of the seed set on all versions, so a loan_id alone is NOT enough
 * to locate a loan. Verified on-chain 2026-06-20.
 */
export function loanPda(
  borrower: PublicKey,
  loanId: bigint,
  programId: PublicKey,
): PublicKey {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(loanId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan"), borrower.toBuffer(), idBytes],
    programId,
  );
  return pda;
}

// ───────────────────────────────────────────────────────────────────────
// LendingPool — layout is identical (159 bytes) across V1/V3/V4. The pool
// section is unchanged from the original single-version implementation
// except that fetchLendingPool now accepts any version's program id.
// ───────────────────────────────────────────────────────────────────────

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
 * layout. All fields are public on-chain so safe to expose.
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
  programVersion: ProgramVersion | null;
  poolPda: string;
  fetchedAtMs: number;
}

/**
 * Manual decode of the LendingPool Anchor account. Layout VERIFIED 2026-06-24
 * against magpie_lending / magpie-v3 / magpie-v4 IDLs (all three share it):
 *   0..8     account discriminator (skipped)
 *   8..40    authority           (Pubkey, 32)  ← lenderAuthority
 *   40..72   loan_token_vault    (Pubkey, 32)  (skipped)
 *   72..104  loan_token_mint     (Pubkey, 32)  (skipped)
 *   104..106 protocol_fee_bps    (u16)         (skipped)
 *   106..108 keeper_reward_bps   (u16)         (skipped)
 *   108..116 total_deposits      (u64, le)
 *   116..124 total_shares        (u64, le)
 *   124..132 total_borrowed      (u64, le)
 *   132..140 total_fees_earned   (u64, le)
 *   140..148 total_loans_issued  (u64, le)
 *   148..156 total_liquidations  (u64, le)
 *
 * NOTE: the previous offsets (40/48/56/64/72/80) were WRONG — they skipped only
 * the authority pubkey, then read the loan_token_vault / loan_token_mint pubkey
 * bytes as u64s, producing ~1e19 garbage totals (e.g. "13.8 billion SOL
 * deposited"). They also had fees_earned / loans_issued out of order. Fixed.
 */
function decodeLendingPool(data: Buffer): Omit<LendingPoolState, "programId" | "programVersion" | "poolPda" | "fetchedAtMs"> {
  if (data.length < 156) throw new Error("pool account too small");
  const u = (offset: number) => data.readBigUInt64LE(offset).toString();
  const lender = new PublicKey(data.subarray(8, 40)).toBase58();
  return {
    lenderAuthority: lender,
    totalDepositsLamports: u(108),
    totalSharesLamports: u(116),
    totalBorrowedLamports: u(124),
    totalFeesEarnedLamports: u(132),
    totalLoansIssued: u(140),
    totalLiquidations: u(148),
  };
}

// In-memory cache. Cold start re-fetches; warm requests hit cache.
const POOL_TTL_MS = 15_000;
const poolCache = new Map<string, { state: LendingPoolState; expiresAt: number }>();

/**
 * Fetch the LendingPool account for a given lender authority. Cached for
 * POOL_TTL_MS. Throws if the account doesn't exist or the program ID is
 * wrong. The programId selects which version's pool to read — each call is
 * independent, so a V4 pool fetch error never affects a V1 read.
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
    programVersion: versionForProgramId(programId),
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
