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
 * GET /api/v1/markets/recent-borrows
 *
 * Most recent N loans across the protocol, sorted by start timestamp
 * descending (newest first).
 *
 * Free, 15s cache.
 *
 * Query params:
 *   - limit: int (default 20, max 100). Cap on returned entries.
 *
 * Returns: same shape as /wallet/:wallet/loans entries, but across
 * all borrowers.
 *
 * Use case: trading-signal agents scoring "what tokens are being
 * borrowed against right now" — surface demand-side activity.
 *
 * Implementation: getProgramAccounts with dataSize filter (no memcmp,
 * so it fetches ALL loans). Sorts by startTimestampUnix descending.
 */

const LOAN_ACCOUNT_SIZE = 123;

interface RecentBorrow {
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

interface CacheEntry {
  borrows: RecentBorrow[];
  fetchedAtUnix: number;
  expiresAt: number;
}
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 15_000;

export async function recentBorrowsHandler(c: Context) {
  const limitParam = c.req.query("limit");
  let limit = 20;
  if (limitParam !== undefined) {
    const n = Number(limitParam);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return c.json({ error: "invalid_limit", detail: "must be 1..100" }, 400);
    }
    limit = Math.floor(n);
  }

  let allBorrows: RecentBorrow[];
  if (cache && cache.expiresAt > Date.now()) {
    allBorrows = cache.borrows;
  } else {
    try {
      const accounts = await conn().getProgramAccounts(LENDING_PROGRAM_V1, {
        commitment: "confirmed",
        filters: [{ dataSize: LOAN_ACCOUNT_SIZE }],
      });

      allBorrows = accounts.map(({ pubkey, account }) => {
        const data = Buffer.from(account.data);
        const u64 = (o: number) => data.readBigUInt64LE(o).toString();
        const i64 = (o: number) => Number(data.readBigInt64LE(o));
        const statusByte = data.readUInt8(122);
        return {
          loanPda: pubkey.toBase58(),
          loanId: u64(72),
          borrower: new PublicKey(data.subarray(8, 40)).toBase58(),
          collateralMint: new PublicKey(data.subarray(40, 72)).toBase58(),
          loanAmountLamports: u64(80),
          originalLoanAmountLamports: u64(88),
          collateralAmount: u64(96),
          startTimestampUnix: i64(104),
          dueTimestampUnix: i64(112),
          ltvPercentage: data.readUInt8(120),
          durationDays: data.readUInt8(121),
          status:
            statusByte === 0 ? "active" as const :
            statusByte === 1 ? "repaid" as const :
            statusByte === 2 ? "liquidated" as const : "unknown" as const,
        };
      });

      // Sort newest-first by start timestamp
      allBorrows.sort((a, b) => b.startTimestampUnix - a.startTimestampUnix);

      cache = {
        borrows: allBorrows,
        fetchedAtUnix: Math.floor(Date.now() / 1000),
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
    } catch (err) {
      console.warn("[recent-borrows] error:", (err as Error).message);
      return c.json({ error: "recent_borrows_fetch_failed" }, 502);
    }
  }

  const trimmed = allBorrows.slice(0, limit);
  const truncated = allBorrows.length > limit;

  return c.json(
    {
      count: trimmed.length,
      total_loans_seen: allBorrows.length,
      truncated,
      limit,
      loans: trimmed,
      notes: {
        sorted_by: "startTimestampUnix descending (newest first)",
        cache_ttl_seconds: Math.ceil(CACHE_TTL_MS / 1000),
      },
    },
    200,
    {
      "Cache-Control": "public, max-age=15, s-maxage=15, stale-while-revalidate=30",
      "X-Cache": cache && cache.expiresAt > Date.now() ? "HIT" : "MISS",
    },
  );
}
