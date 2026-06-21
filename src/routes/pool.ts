import type { Context } from "hono";
import {
  fetchLendingPool,
  lamportsToSol,
  programIdForVersion,
  LOAN_VERSIONS,
  type LendingPoolState,
  type ProgramVersion,
} from "../lib/magpie-program.js";

const LENDER_AUTHORITY = process.env.MAGPIE_LENDER_PUBKEY;

/**
 * GET /api/v1/pool[?version=v1|v3|v4]   — one strategy's pool (default v1)
 * GET /api/v1/pools                     — all three pools, fail-soft
 *
 * Verified 2026-06-20: V1/V3/V4 each have exactly one LendingPool, all under
 * the same lender authority, with identical 159-byte layout. So a single
 * MAGPIE_LENDER_PUBKEY resolves every version's pool.
 *
 * Public, free, 15s cached. The protocol's live state — agents, indexers,
 * and other protocols query it freely as a proof-of-direct-protocol-access
 * signal.
 */

function shapePool(state: LendingPoolState) {
  return {
    program: state.programId,
    program_version: state.programVersion,
    poolPda: state.poolPda,
    lenderAuthority: state.lenderAuthority,
    lamports: {
      totalDeposits: state.totalDepositsLamports,
      totalShares: state.totalSharesLamports,
      totalBorrowed: state.totalBorrowedLamports,
      totalFeesEarned: state.totalFeesEarnedLamports,
    },
    sol: {
      totalDeposits: lamportsToSol(state.totalDepositsLamports),
      totalBorrowed: lamportsToSol(state.totalBorrowedLamports),
      totalFeesEarned: lamportsToSol(state.totalFeesEarnedLamports),
    },
    counts: {
      loansIssuedLifetime: Number(state.totalLoansIssued),
      liquidationsLifetime: Number(state.totalLiquidations),
    },
    fetchedAtMs: state.fetchedAtMs,
    verify: `https://solscan.io/account/${state.poolPda}`,
  };
}

function parseVersion(raw: string | undefined): ProgramVersion | null {
  if (raw === undefined) return "v1"; // default — back-compat
  return raw === "v1" || raw === "v3" || raw === "v4" ? raw : null;
}

export async function poolHandler(c: Context) {
  if (!LENDER_AUTHORITY) {
    return c.json({ error: "service_not_configured", reason: "MAGPIE_LENDER_PUBKEY not set" }, 503);
  }
  const version = parseVersion(c.req.query("version"));
  if (!version) {
    return c.json({ error: "invalid_version", detail: "must be v1, v3, or v4" }, 400);
  }
  try {
    const state = await fetchLendingPool(LENDER_AUTHORITY, { programId: programIdForVersion(version) });
    return c.json({ ...shapePool(state), cacheTtlMs: 15_000 }, 200, {
      "Cache-Control": "public, max-age=15, s-maxage=15, stale-while-revalidate=30",
    });
  } catch (err) {
    console.warn(`[pool] ${version} fetch error:`, (err as Error).message);
    return c.json({ error: "pool_fetch_failed", version }, 502);
  }
}

/**
 * GET /api/v1/pools — every strategy's pool in one call. Each version is
 * fetched independently (Promise.allSettled): a V4 RPC failure never blanks
 * the V1/V3 pools (lane separation); failed versions appear in `partial`.
 */
export async function poolsAggregateHandler(c: Context) {
  if (!LENDER_AUTHORITY) {
    return c.json({ error: "service_not_configured", reason: "MAGPIE_LENDER_PUBKEY not set" }, 503);
  }
  const results = await Promise.allSettled(
    LOAN_VERSIONS.map((v) =>
      fetchLendingPool(LENDER_AUTHORITY, { programId: programIdForVersion(v) }).then((s) => ({ v, s })),
    ),
  );

  const pools: Partial<Record<ProgramVersion, ReturnType<typeof shapePool>>> = {};
  const partial: Partial<Record<ProgramVersion, "error">> = {};
  results.forEach((r, i) => {
    const v = LOAN_VERSIONS[i];
    if (r.status === "fulfilled") pools[v] = shapePool(r.value.s);
    else {
      partial[v] = "error";
      console.warn(`[pools] ${v} fetch error:`, (r.reason as Error)?.message);
    }
  });

  return c.json(
    { versions: LOAN_VERSIONS, pools, partial, fetchedAtMs: Date.now() },
    200,
    {
      "Cache-Control":
        Object.keys(partial).length === 0
          ? "public, max-age=15, s-maxage=15, stale-while-revalidate=30"
          : "no-store",
    },
  );
}
