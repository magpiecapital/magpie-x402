import type { Context } from "hono";
import { Connection, PublicKey } from "@solana/web3.js";
import { LENDING_PROGRAM_V1 } from "../lib/magpie-program.js";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

/**
 * Decode a Magpie Loan account.
 *
 * On-chain Anchor struct (matches the IDL at magpie-bot/programs/
 * magpie-lending/src/lib.rs). Offsets after the 8-byte Anchor
 * discriminator:
 *
 *   0..32   borrower               (Pubkey)
 *  32..64   collateral_mint        (Pubkey)
 *  64..72   loan_id                (u64, le)
 *  72..80   loan_amount_lamports   (u64, le)
 *  80..88   original_loan_amount   (u64, le)
 *  88..96   collateral_amount      (u64, le)
 *  96..104  start_timestamp        (i64, le, unix seconds)
 * 104..112  due_timestamp          (i64, le, unix seconds)
 * 112      ltv_percentage          (u8)
 * 113      duration_days           (u8)
 * 114      status                  (u8 → 0=active 1=repaid 2=liquidated)
 *
 * Reads are validated against the actual program owner before parsing.
 */
interface LoanState {
  loanPda: string;
  loanId: string;
  borrower: string;
  collateralMint: string;
  loanAmountLamports: string;
  originalLoanAmountLamports: string;
  collateralAmount: string;
  startTimestampUnix: number;
  dueTimestampUnix: number;
  ltvPercentage: number;
  durationDays: number;
  status: "active" | "repaid" | "liquidated" | "unknown";
}

function statusFromByte(b: number): LoanState["status"] {
  return b === 0 ? "active" : b === 1 ? "repaid" : b === 2 ? "liquidated" : "unknown";
}

function decodeLoan(pda: PublicKey, data: Buffer): LoanState {
  if (data.length < 115) throw new Error("loan account too small");
  const u64 = (o: number) => data.readBigUInt64LE(o).toString();
  const i64 = (o: number) => Number(data.readBigInt64LE(o));
  return {
    loanPda: pda.toBase58(),
    borrower: new PublicKey(data.subarray(8, 40)).toBase58(),
    collateralMint: new PublicKey(data.subarray(40, 72)).toBase58(),
    loanId: u64(72),
    loanAmountLamports: u64(80),
    originalLoanAmountLamports: u64(88),
    collateralAmount: u64(96),
    startTimestampUnix: i64(104),
    dueTimestampUnix: i64(112),
    ltvPercentage: data.readUInt8(120),
    durationDays: data.readUInt8(121),
    status: statusFromByte(data.readUInt8(122)),
  };
}

/** Derive a loan PDA from its u64 loan_id. */
function loanPdaFromId(loanId: bigint, programId = LENDING_PROGRAM_V1): PublicKey {
  const idBytes = Buffer.alloc(8);
  idBytes.writeBigUInt64LE(loanId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("loan"), idBytes],
    programId,
  );
  return pda;
}

/**
 * GET /api/v1/loan/:loanId
 *
 * Returns the full on-chain Loan account state for a given loan_id.
 * Public, free, lightly cached (10s) since loan state changes on
 * borrow/repay/liquidate events.
 *
 * "Direct communication with the lending protocol" — reads the Loan
 * PDA directly from the program. No DB intermediary.
 */
const loanCache = new Map<string, { state: LoanState; expiresAt: number }>();
const LOAN_TTL_MS = 10_000;

export async function loanHandler(c: Context) {
  const loanIdParam = c.req.param("loanId");
  if (!loanIdParam || !/^\d+$/.test(loanIdParam)) {
    return c.json({ error: "invalid_loan_id" }, 400);
  }
  let loanId: bigint;
  try {
    loanId = BigInt(loanIdParam);
  } catch {
    return c.json({ error: "invalid_loan_id" }, 400);
  }
  const pda = loanPdaFromId(loanId);
  const cacheKey = pda.toBase58();
  const cached = loanCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.state, 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20",
      "X-Cache": "HIT",
    });
  }

  try {
    const acct = await conn().getAccountInfo(pda, "confirmed");
    if (!acct) return c.json({ error: "loan_not_found", loanId: loanIdParam }, 404);
    if (!acct.owner.equals(LENDING_PROGRAM_V1)) {
      return c.json({ error: "loan_account_owner_mismatch" }, 502);
    }
    const state = decodeLoan(pda, Buffer.from(acct.data));
    loanCache.set(cacheKey, { state, expiresAt: Date.now() + LOAN_TTL_MS });
    return c.json(state, 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20",
      "X-Cache": "MISS",
    });
  } catch (err) {
    console.warn("[loan] error:", (err as Error).message);
    return c.json({ error: "loan_fetch_failed" }, 502);
  }
}
