import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import {
  LOAN_SIZE,
  LOAN_VERSIONS,
  loanDiscriminatorFilter,
  fetchLoansAcrossVersions,
  type DecodedLoan,
  type ProgramVersion,
} from "../lib/magpie-program.js";

/**
 * GET /api/v1/wallet/:wallet/loans
 *
 * Every loan a wallet holds, ACROSS ALL THREE lending strategies:
 *   - V1 memecoin loans
 *   - V3 RWA loans
 *   - V4 in-vault exit-order loans
 *
 * Each version is queried independently (getProgramAccounts + a borrower
 * memcmp at offset 16) and decoded through the pool-separation-safe guard,
 * so a loan from one program can never be misattributed to another. If one
 * version's RPC call fails, the others still return — the failed version is
 * reported in `partial` rather than blanking the whole portfolio view (lane
 * separation).
 *
 * Privacy: on-chain data — anyone with the wallet pubkey can derive the same
 * from any RPC. This endpoint is convenience (one call vs three), not a new
 * privacy surface.
 */

// Per-wallet cache. 8s TTL for complete results. Partial results (a version
// errored) are cached for a SHORT TTL so a sustained version outage can't be
// abused to force 3x getProgramAccounts on every request (RPC amplification),
// while still letting a recovered version reappear within a couple seconds.
const walletCache = new Map<
  string,
  { loans: DecodedLoan[]; partial: Partial<Record<ProgramVersion, "error">>; expiresAt: number }
>();
const WALLET_TTL_MS = 8_000;
const PARTIAL_TTL_MS = 2_500;

const STATUS_FILTERS = ["active", "repaid", "liquidated"] as const;

function byVersionCounts(loans: DecodedLoan[]): Record<ProgramVersion, number> {
  const out = { v1: 0, v3: 0, v4: 0 } as Record<ProgramVersion, number>;
  for (const l of loans) out[l.programVersion]++;
  return out;
}

export async function walletLoansHandler(c: Context) {
  const walletParam = c.req.param("wallet");
  if (!walletParam) return c.json({ error: "missing_wallet" }, 400);
  let walletKey: PublicKey;
  try {
    walletKey = new PublicKey(walletParam);
  } catch {
    return c.json({ error: "invalid_wallet_pubkey" }, 400);
  }

  const statusFilter = c.req.query("status");
  if (statusFilter && !STATUS_FILTERS.includes(statusFilter as (typeof STATUS_FILTERS)[number])) {
    return c.json({ error: "invalid_status_filter", valid: STATUS_FILTERS }, 400);
  }

  const wallet = walletKey.toBase58();

  // Serve from cache (complete results only).
  const cached = walletCache.get(wallet);
  let loans: DecodedLoan[];
  let partial: Partial<Record<ProgramVersion, "error">> = {};
  let cacheHit = false;

  if (cached && cached.expiresAt > Date.now()) {
    loans = cached.loans;
    partial = cached.partial;
    cacheHit = true;
  } else {
    const res = await fetchLoansAcrossVersions((v) => [
      { dataSize: LOAN_SIZE[v] },
      { memcmp: { offset: 16, bytes: wallet } }, // borrower @ offset 16
      loanDiscriminatorFilter(),
    ]);
    loans = res.loans;
    partial = res.partial;
    // newest-first by on-chain loan_id (monotonic), independent of version
    loans.sort((a, b) => (BigInt(b.loanId) > BigInt(a.loanId) ? 1 : -1));
    const isPartial = Object.keys(partial).length > 0;
    walletCache.set(wallet, {
      loans,
      partial,
      expiresAt: Date.now() + (isPartial ? PARTIAL_TTL_MS : WALLET_TTL_MS),
    });
  }

  const filtered = statusFilter ? loans.filter((l) => l.status === statusFilter) : loans;

  return c.json(
    {
      wallet,
      count: filtered.length,
      by_version: byVersionCounts(filtered),
      // Which versions (if any) failed to fetch this request. Empty = all good.
      partial,
      versions_queried: LOAN_VERSIONS,
      loans: filtered,
    },
    200,
    {
      // Don't let a CDN cache a partial response.
      "Cache-Control":
        Object.keys(partial).length === 0
          ? "public, max-age=8, s-maxage=8, stale-while-revalidate=15"
          : "no-store",
      "X-Cache": cacheHit ? "HIT" : "MISS",
    },
  );
}
