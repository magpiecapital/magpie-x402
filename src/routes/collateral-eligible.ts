import type { Context } from "hono";

/**
 * GET /api/v1/collateral/eligible
 *
 * Public catalog of every token currently approved as collateral on
 * Magpie. Agents call this once to learn "what can I borrow against?",
 * cache for an hour, and key all subsequent borrow flows off it.
 *
 * Why this matters for agents: a portfolio-managing or yield-routing
 * agent that's never used Magpie before needs to discover the
 * collateral universe before it can decide whether to integrate.
 * Right now that discovery is implicit in the site UI or buried in
 * /api/v1/markets — this is the canonical agent-facing answer.
 *
 * Free + cached aggressively (1h) — the registry changes only when
 * the operator adds/removes tokens, not on each block.
 */

const TOKENS_URL =
  process.env.MAGPIE_TOKENS_URL || "https://www.magpie.capital/api/v1/tokens";

let cache: { fetchedAt: number; payload: unknown } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface SiteTokenEntry {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  category?: string;
  image?: string | null;
}

interface SiteTokensResponse {
  ok: boolean;
  count: number;
  tokens: SiteTokenEntry[];
}

// Categories that route a plain (no-exit) borrow to the V3 RWA program. Any
// other category is treated as a V1 memecoin borrow. Exits always route to V4
// regardless of category. Kept conservative + lowercase-compared.
const RWA_CATEGORIES = new Set([
  "rwa",
  "stock",
  "stocks",
  "equity",
  "etf",
  "metal",
  "commodity",
  "bond",
  "tbill",
]);

function strategyForCategory(category?: string) {
  const isRwa = RWA_CATEGORIES.has((category || "").toLowerCase());
  return {
    plain_borrow_version: isRwa ? "v3" : "v1",
    exit_armed_version: "v4" as const,
    note: isRwa
      ? "RWA collateral: plain borrow routes to V3; has_exit_arming=true routes to V4 for in-vault exit orders."
      : "Memecoin collateral: plain borrow routes to V1; has_exit_arming=true routes to V4 for in-vault exit orders.",
  };
}

export async function collateralEligibleHandler(c: Context) {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return c.json(cache.payload as Record<string, unknown>, 200, {
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "X-Cache": "HIT",
    });
  }

  let upstream: SiteTokensResponse;
  try {
    const r = await fetch(TOKENS_URL, { signal: AbortSignal.timeout(7_000) });
    if (!r.ok) {
      return c.json(
        { error: "upstream_error", status: r.status },
        502,
      );
    }
    upstream = (await r.json()) as SiteTokensResponse;
  } catch (err) {
    return c.json(
      { error: "upstream_fetch_failed", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }

  // Bound the array so a misbehaving/compromised upstream can't force this
  // endpoint to map + serialize an unbounded payload (memory/CPU DoS).
  if (!upstream.ok || !Array.isArray(upstream.tokens) || upstream.tokens.length > 10_000) {
    return c.json({ error: "upstream_unexpected_shape" }, 502);
  }

  const byCategory: Record<string, SiteTokenEntry[]> = {};
  for (const t of upstream.tokens) {
    const key = t.category || "other";
    (byCategory[key] ||= []).push(t);
  }

  // Per-token strategy mapping so an agent learns, in ONE fetch, which
  // program a token routes to: memecoin -> V1, RWA -> V3, and "+exits" -> V4
  // for any token. Category is authoritative from the upstream registry — we
  // never infer it client-side.
  const tokens = upstream.tokens.map((t) => ({ ...t, strategy: strategyForCategory(t.category) }));

  const payload = {
    count: upstream.tokens.length,
    categories: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, v.length]),
    ),
    // The borrow-time routing master table, so an agent doesn't have to infer
    // it. Exits are V4-only; a plain (no-exit) borrow routes by category.
    routing_table: {
      no_exits_memecoin: "v1",
      no_exits_rwa: "v3",
      with_exits_any: "v4",
      note: "Pass has_exit_arming=true to POST /api/v1/agent/build-borrow to open on V4 and arm in-vault exit orders. Exits are V4-only. RWA borrow availability is gated by the on-chain program; a token appearing here is accepted by the x402 layer, not a guarantee the program will mint that loan right now.",
    },
    tokens,
    notes: {
      tier_eligibility:
        "Every eligible token can be used as collateral at any of the three tiers (Express/Quick/Standard). Tier choice affects LTV cap, duration, and fee — see /api/v1/tiers.",
      caps:
        "Per-token borrow caps are dynamic and enforced at borrow time by the on-chain program. To get the live remaining cap for a specific token, simulate a borrow at /api/v1/simulate-borrow.",
      strategy:
        "Each token carries a `strategy` block: plain_borrow_version (v1|v3) + exit_armed_version (always v4). Choose v4 by passing has_exit_arming=true at borrow time.",
      cache_ttl_seconds: 3600,
    },
    source: TOKENS_URL,
    fetched_at: new Date().toISOString(),
  };
  cache = { fetchedAt: Date.now(), payload };
  return c.json(payload, 200, {
    "Cache-Control": "public, max-age=3600, s-maxage=3600",
    "X-Cache": "MISS",
  });
}
