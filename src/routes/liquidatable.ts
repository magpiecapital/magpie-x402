import type { Context } from "hono";
import {
  LOAN_SIZE,
  ACTIVE_STATUS_BYTES_BS58,
  loanDiscriminatorFilter,
  fetchLoansAcrossVersions,
  type DecodedLoan,
  type ProgramVersion,
} from "../lib/magpie-program.js";

/**
 * GET /api/v1/markets/liquidatable
 *
 * Active loans at or past their on-chain due timestamp — liquidation-
 * eligible right now under the protocol's duration gate. The canonical
 * liquidation-bot data feed.
 *
 * Multi-version: queries V1 (memecoin) and V3 (RWA) loans by default. V4
 * loans are EXCLUDED by default — a V4 position auto-sells in-vault as its
 * exit orders fire, so it rarely reaches a profitable due-date liquidation;
 * including it would pollute the racer feed with loans that resolve
 * themselves. Pass ?include_v4=true to opt in (the loans are tagged with
 * program_version so a bot can decide).
 *
 * Each version is fetched independently and decoded through the pool-
 * separation-safe guard; a failed version is reported in `partial` and
 * never aborts the others (lane separation).
 *
 * Query params:
 *   - within_seconds: int 0..604800 (default 0). >0 also returns loans that
 *     become liquidatable within the window (pre-positioning).
 *   - limit: int 1..500 (default 100).
 *   - include_v4: 'true' to include V4 loans (default excluded).
 *
 * Free + 8s cache. We earn on the write side; the discovery surface stays
 * open so liquidation racing actually happens.
 */

interface LiquidatableLoan extends DecodedLoan {
  secondsPastDue: number; // negative = not yet due
}

interface CacheEntry {
  loans: LiquidatableLoan[];
  partial: Partial<Record<ProgramVersion, "error">>;
  fetchedAtUnix: number;
  expiresAt: number;
}
// Separate cache slots for the v4-included vs v4-excluded views.
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 8_000;

export async function liquidatableHandler(c: Context) {
  const withinParam = c.req.query("within_seconds");
  let withinSeconds = 0;
  if (withinParam !== undefined) {
    const n = Number(withinParam);
    if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 3600) {
      return c.json({ error: "invalid_within_seconds", detail: "must be 0..604800 (7d)" }, 400);
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
  const includeV4 = c.req.query("include_v4") === "true";
  const versions: readonly ProgramVersion[] = includeV4 ? ["v4", "v3", "v1"] : ["v3", "v1"];
  const cacheKey = includeV4 ? "with_v4" : "no_v4";

  const nowUnix = Math.floor(Date.now() / 1000);

  let active: LiquidatableLoan[];
  let partial: Partial<Record<ProgramVersion, "error">>;
  let cacheHit = false;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    active = cached.loans.map((l) => ({ ...l, secondsPastDue: nowUnix - l.dueTimestampUnix }));
    partial = cached.partial;
    cacheHit = true;
  } else {
    const res = await fetchLoansAcrossVersions(
      (v) => [
        { dataSize: LOAN_SIZE[v] },
        { memcmp: { offset: 195, bytes: ACTIVE_STATUS_BYTES_BS58 } }, // status @195 == Active(0)
        loanDiscriminatorFilter(),
      ],
      { versions },
    );
    partial = res.partial;
    // Defensive: keep only genuinely-active loans (the memcmp already does
    // this server-side; re-assert after decode so a status-byte collision
    // can never surface a repaid/liquidated loan as racer bait).
    active = res.loans
      .filter((l) => l.status === "active")
      .map((l) => ({ ...l, secondsPastDue: nowUnix - l.dueTimestampUnix }));
    cache.set(cacheKey, {
      loans: active,
      partial,
      fetchedAtUnix: nowUnix,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  const eligible = active.filter((l) => l.secondsPastDue >= -withinSeconds);
  eligible.sort((a, b) => b.secondsPastDue - a.secondsPastDue);
  const trimmed = eligible.slice(0, limit);

  return c.json(
    {
      now_unix: nowUnix,
      total_active_loans: active.length,
      eligible_count: eligible.length,
      returned_count: trimmed.length,
      truncated: eligible.length > limit,
      within_seconds: withinSeconds,
      limit,
      versions_queried: versions,
      v4_included: includeV4,
      partial,
      loans: trimmed,
      notes: {
        liquidation_ix:
          "The on-chain liquidate instruction is permissionless. Any wallet can call it on a past-due loan and receive the protocol-defined liquidator reward. Use the loan's program_version to target the correct program.",
        v4_default_excluded:
          "V4 (exit-order) loans auto-sell in-vault and rarely reach a profitable due-date liquidation; they are excluded by default. Pass ?include_v4=true to include them.",
        seconds_past_due:
          "Negative means not yet due — included only when within_seconds > 0 for pre-positioning.",
        partial:
          "If a program version's RPC fetch failed, it appears here; the rest of the feed is still valid (lane separation).",
        cache_ttl_seconds: Math.ceil(CACHE_TTL_MS / 1000),
      },
    },
    200,
    {
      "Cache-Control":
        Object.keys(partial).length === 0
          ? "public, max-age=8, s-maxage=8, stale-while-revalidate=12"
          : "no-store",
      "X-Cache": cacheHit ? "HIT" : "MISS",
    },
  );
}
