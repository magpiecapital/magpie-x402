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
 * GET /api/v1/wallet/:wallet/loans
 *
 * Returns every Loan account owned by a wallet, fetched directly via
 * getProgramAccounts with a memcmp filter on the `borrower` offset.
 * This is THE canonical "show me what positions this wallet has" call
 * — what agents will hit for credit-decisioning, portfolio dashboards,
 * risk modeling.
 *
 * Performance characteristics:
 *   - Single RPC roundtrip via getProgramAccounts + memcmp filter
 *   - 8s cache per wallet (loans change on borrow/repay/liquidate)
 *   - Returns parsed loan summaries, NOT raw account data → smaller
 *     payloads, faster JSON serialize
 *
 * Privacy: this is on-chain data — anyone with the wallet pubkey
 * can query the same info from any RPC. Exposing it through this
 * endpoint adds convenience (one call instead of N pdas) but no
 * new privacy surface.
 */

// Loan account layout — must match decode in routes/loan.ts.
// `borrower` lives at offset 8 (after the 8-byte Anchor discriminator).
const BORROWER_OFFSET = 8;
const LOAN_ACCOUNT_SIZE = 123; // exact size of the Anchor Loan struct

interface LoanSummary {
  loanPda: string;
  loanId: string;
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

function decodeLoanSummary(pda: PublicKey, data: Buffer): LoanSummary {
  const u64 = (o: number) => data.readBigUInt64LE(o).toString();
  const i64 = (o: number) => Number(data.readBigInt64LE(o));
  const statusByte = data.readUInt8(122);
  return {
    loanPda: pda.toBase58(),
    collateralMint: new PublicKey(data.subarray(40, 72)).toBase58(),
    loanId: u64(72),
    loanAmountLamports: u64(80),
    originalLoanAmountLamports: u64(88),
    collateralAmount: u64(96),
    startTimestampUnix: i64(104),
    dueTimestampUnix: i64(112),
    ltvPercentage: data.readUInt8(120),
    durationDays: data.readUInt8(121),
    status:
      statusByte === 0 ? "active" :
      statusByte === 1 ? "repaid" :
      statusByte === 2 ? "liquidated" : "unknown",
  };
}

// Per-wallet cache. 8s TTL keeps us fresh during active borrow/repay
// flows without hammering RPC.
const walletCache = new Map<string, { loans: LoanSummary[]; expiresAt: number }>();
const WALLET_TTL_MS = 8_000;

export async function walletLoansHandler(c: Context) {
  const walletParam = c.req.param("wallet");
  if (!walletParam) {
    return c.json({ error: "missing_wallet" }, 400);
  }
  let walletKey: PublicKey;
  try {
    walletKey = new PublicKey(walletParam);
  } catch {
    return c.json({ error: "invalid_wallet_pubkey" }, 400);
  }

  // Optional query filter: ?status=active|repaid|liquidated
  const statusFilter = c.req.query("status");
  if (statusFilter && !["active", "repaid", "liquidated"].includes(statusFilter)) {
    return c.json({ error: "invalid_status_filter" }, 400);
  }

  const cacheKey = walletKey.toBase58();
  const cached = walletCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const filtered = statusFilter
      ? cached.loans.filter((l) => l.status === statusFilter)
      : cached.loans;
    return c.json(
      { wallet: cacheKey, count: filtered.length, loans: filtered },
      200,
      {
        "Cache-Control": "public, max-age=8, s-maxage=8, stale-while-revalidate=15",
        "X-Cache": "HIT",
      },
    );
  }

  try {
    // memcmp on the borrower field — server-side filter on the RPC
    // node. Returns ONLY accounts where bytes[8..40] match the wallet.
    const accounts = await conn().getProgramAccounts(LENDING_PROGRAM_V1, {
      commitment: "confirmed",
      filters: [
        { dataSize: LOAN_ACCOUNT_SIZE },
        { memcmp: { offset: BORROWER_OFFSET, bytes: walletKey.toBase58() } },
      ],
    });
    const loans = accounts.map(({ pubkey, account }) =>
      decodeLoanSummary(pubkey, Buffer.from(account.data)),
    );
    // Sort newest-first by loan_id (it's monotonically issued on-chain)
    loans.sort((a, b) => (BigInt(b.loanId) > BigInt(a.loanId) ? 1 : -1));
    walletCache.set(cacheKey, { loans, expiresAt: Date.now() + WALLET_TTL_MS });

    const filtered = statusFilter
      ? loans.filter((l) => l.status === statusFilter)
      : loans;
    return c.json(
      { wallet: cacheKey, count: filtered.length, loans: filtered },
      200,
      {
        "Cache-Control": "public, max-age=8, s-maxage=8, stale-while-revalidate=15",
        "X-Cache": "MISS",
      },
    );
  } catch (err) {
    console.warn("[wallet-loans] error:", (err as Error).message);
    return c.json({ error: "wallet_loans_fetch_failed" }, 502);
  }
}
