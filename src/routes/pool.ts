import type { Context } from "hono";
import { fetchLendingPool, lamportsToSol } from "../lib/magpie-program.js";

const LENDER_AUTHORITY = process.env.MAGPIE_LENDER_PUBKEY;

/**
 * GET /api/v1/pool
 *
 * Public, free, cached for 15s. Returns the LIVE on-chain LendingPool
 * state — totalDeposits, totalBorrowed (currently lent out), totalShares,
 * totalLoansIssued, totalLiquidations, totalFeesEarned.
 *
 * No payment required — this is the protocol's public state and we want
 * AI agents, indexers, and other protocols to query it freely as a
 * proof-of-direct-protocol-access signal. (Paid endpoints layer derived
 * analytics on top.)
 *
 * Fast: in-process 15s cache + parsed-only-once Anchor decode. Typical
 * warm response: <5ms server-side. Cold path: one RPC roundtrip +
 * decode (~80-150ms depending on RPC).
 */
export async function poolHandler(c: Context) {
  if (!LENDER_AUTHORITY) {
    return c.json(
      { error: "service_not_configured", reason: "MAGPIE_LENDER_PUBKEY not set" },
      503,
    );
  }
  try {
    const state = await fetchLendingPool(LENDER_AUTHORITY);
    return c.json(
      {
        program: state.programId,
        poolPda: state.poolPda,
        lenderAuthority: state.lenderAuthority,
        // Lamports for precision-sensitive integrators
        lamports: {
          totalDeposits: state.totalDepositsLamports,
          totalShares: state.totalSharesLamports,
          totalBorrowed: state.totalBorrowedLamports,
          totalFeesEarned: state.totalFeesEarnedLamports,
        },
        // Same numbers in SOL for human consumption
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
        cacheTtlMs: 15_000,
        verify: `https://solscan.io/account/${state.poolPda}`,
      },
      200,
      {
        // Edge + browser cache-control mirroring the in-process cache
        "Cache-Control": "public, max-age=15, s-maxage=15, stale-while-revalidate=30",
      },
    );
  } catch (err) {
    console.warn("[pool] fetch error:", (err as Error).message);
    return c.json({ error: "pool_fetch_failed" }, 502);
  }
}
