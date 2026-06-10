import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * GET /api/v1/agent/token-risk?mint=<mint>
 *
 * Magpie's internal token risk profile for any token in the
 * supported-mints catalog. Useful before posting a build-borrow:
 * decide whether the collateral is safe enough to lend against at
 * the LTV your strategy wants.
 *
 * Returns:
 *   - risk_score                 0-100, higher = riskier
 *   - dimensions:                volatility, liquidity, concentration,
 *                                volume, rug_pull (all 0-100)
 *   - market_data:               liquidity_usd, volume_24h_usd, market_cap_usd
 *   - lending_impact:            ltv_modifier, max_allowed_ltv (the
 *                                cap Magpie's program would actually
 *                                enforce for this token regardless of
 *                                the requested tier)
 *   - flagged + flag_reason:     operator-set hard flags
 *   - updated_at:                last refresh timestamp
 *
 * Priced at 0.001 SOL — same as credit-score. Both are "scoring"
 * lookups that compress meaningful protocol intelligence into a
 * single tier-decision input.
 */
const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";

export async function tokenRiskHandler(c: Context) {
  const mint = c.req.query("mint") ?? "";
  if (!mint) return c.json({ error: "missing_mint" }, 400);
  try {
    new PublicKey(mint);
  } catch {
    return c.json({ error: "invalid_mint_pubkey" }, 400);
  }

  let res: Response;
  try {
    res = await fetch(
      `${BOT_API}/api/v1/risk/token?mint=${encodeURIComponent(mint)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } catch (err) {
    return c.json(
      { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }
  const data = await res.json().catch(() => ({ error: "bot_returned_non_json" }));
  return c.json(data as Record<string, unknown>, res.status as never);
}
