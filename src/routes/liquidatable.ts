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
 * GET /api/v1/markets/liquidatable
 *
 * Lists currently-active loans that are at or past their on-chain
 * due timestamp — i.e. liquidation-eligible *right now* under the
 * protocol's duration gate. Optionally also returns loans approaching
 * due (within ?within_seconds=...) so liquidation-bot agents can
 * pre-position.
 *
 * Why this matters for agents: liquidation is the canonical agent
 * use case in DeFi. A bot that monitors this endpoint and races to
 * call the liquidate ix on-chain captures the liquidator reward.
 * Magpie's anti-exploit gauntlet runs server-side; the liquidate ix
 * itself is permissionless and any wallet can call it.
 *
 * Performance:
 *   - Single getProgramAccounts call filtered by dataSize + memcmp
 *     on the status byte (status=0 → active).
 *   - 8s in-process cache (loan state changes on every
 *     borrow/repay/liquidate event; 8s is fresh enough for
 *     liquidation racing without hammering RPC on burst polls).
 *
 * Query params:
 *   - within_seconds: int (default 0). If >0, also include loans
 *     that will become liquidatable within this many seconds.
 *     Useful for pre-positioning; 0 = strictly past-due only.
 *   - limit: int (default 100, max 500). Cap on returned entries.
 *
 * Free + cached aggressively. Liquidation is a fast-moving game,
 * but charging for the discovery surface would just push agents to
 * scrape RPC directly. We make our money on the *write* side
 * (build-borrow / build-repay) and want maximum agent participation
 * on the read side.
 */

const BORROWER_OFFSET = 8;
const STATUS_OFFSET = 122;
const LOAN_ACCOUNT_SIZE = 123;

interface LiquidatableLoan {
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
  secondsPastDue: number; // negative = not yet due
  status: "active";
}

function decodeActiveLoan(pda: PublicKey, data: Buffer, nowUnix: number): LiquidatableLoan {
  const u64 = (o: number) => data.readBigUInt64LE(o).toString();
  const i64 = (o: number) => Number(data.readBigInt64LE(o));
  const dueTimestampUnix = i64(112);
  return {
    loanPda: pda.toBase58(),
    borrower: new PublicKey(data.subarray(BORROWER_OFFSET, BORROWER_OFFSET + 32)).toBase58(),
    collateralMint: new PublicKey(data.subarray(40, 72)).toBase58(),
    loanId: u64(72),
    loanAmountLamports: u64(80),
    originalLoanAmountLamports: u64(88),
    collateralAmount: u64(96),
    startTimestampUnix: i64(104),
    dueTimestampUnix,
    ltvPercentage: data.readUInt8(120),
    durationDays: data.readUInt8(121),
    secondsPastDue: nowUnix - dueTimestampUnix,
    status: "active",
  };
}

interface CacheEntry {
  loans: LiquidatableLoan[];
  fetchedAtUnix: number;
  expiresAt: number;
}
let cache: CacheEntry | null = null;
const CACHE_TTL_MS = 8_000;

export async function liquidatableHandler(c: Context) {
  const withinParam = c.req.query("within_seconds");
  let withinSeconds = 0;
  if (withinParam !== undefined) {
    const n = Number(withinParam);
    if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 3600) {
      return c.json(
        { error: "invalid_within_seconds", detail: "must be 0..604800 (7d)" },
        400,
      );
    }
    withinSeconds = Math.floor(n);
  }
  const limitParam = c.req.query("limit");
  let limit = 100;
  if (limitParam !== undefined) {
    const n = Number(limitParam);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      return c.json({ error: "invalid_limit", detail: "must be 1..500" }, 400);
    }
    limit = Math.floor(n);
  }

  const nowUnix = Math.floor(Date.now() / 1000);

  let active: LiquidatableLoan[];
  if (cache && cache.expiresAt > Date.now()) {
    active = cache.loans.map((l) => ({ ...l, secondsPastDue: nowUnix - l.dueTimestampUnix }));
  } else {
    try {
      const accounts = await conn().getProgramAccounts(LENDING_PROGRAM_V1, {
        commitment: "confirmed",
        filters: [
          { dataSize: LOAN_ACCOUNT_SIZE },
          // bs58 of single 0x00 byte is "1"
          { memcmp: { offset: STATUS_OFFSET, bytes: "1" } },
        ],
      });
      active = accounts.map(({ pubkey, account }) =>
        decodeActiveLoan(pubkey, Buffer.from(account.data), nowUnix),
      );
      cache = {
        loans: active,
        fetchedAtUnix: nowUnix,
        expiresAt: Date.now() + CACHE_TTL_MS,
      };
    } catch (err) {
      console.warn("[liquidatable] error:", (err as Error).message);
      return c.json({ error: "loans_fetch_failed" }, 502);
    }
  }

  // Filter: strictly past-due, or past-due-within window
  const eligible = active.filter((l) => l.secondsPastDue >= -withinSeconds);
  // Sort: most-past-due first (highest secondsPastDue), pre-positioning loans at the end
  eligible.sort((a, b) => b.secondsPastDue - a.secondsPastDue);
  const trimmed = eligible.slice(0, limit);
  const truncated = eligible.length > limit;

  return c.json(
    {
      now_unix: nowUnix,
      total_active_loans: active.length,
      eligible_count: eligible.length,
      returned_count: trimmed.length,
      truncated,
      within_seconds: withinSeconds,
      limit,
      loans: trimmed,
      notes: {
        liquidation_ix:
          "The on-chain liquidate instruction is permissionless. Any wallet can call it on a past-due loan and receive the protocol-defined liquidator reward.",
        anti_exploit:
          "The on-chain program enforces correctness; off-chain anti-exploit gates (TWAP/oracle/etc.) apply to borrow flow, not liquidation. Liquidation racing is safe to automate.",
        seconds_past_due:
          "Negative value means the loan is not yet due — included only when within_seconds > 0 for pre-positioning.",
        cache_ttl_seconds: Math.ceil(CACHE_TTL_MS / 1000),
      },
    },
    200,
    {
      "Cache-Control": "public, max-age=8, s-maxage=8, stale-while-revalidate=12",
      "X-Cache": cache && cache.expiresAt > Date.now() && cache.fetchedAtUnix !== nowUnix ? "HIT" : "MISS",
    },
  );
}
