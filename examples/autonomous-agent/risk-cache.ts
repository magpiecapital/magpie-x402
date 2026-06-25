/**
 * risk-cache.ts — pay for a token's risk score at most once per TTL.
 *
 * The Claude brain re-evaluates the same tokens every cycle; each
 * agent.tokenRisk() is a PAID 0.001 SOL call. Re-scoring the same mints every
 * 2 minutes drains the wallet (the bug that under-funded the first repay). This
 * caches scores per mint so a token is paid for at most once per RISK_CACHE_TTL_MIN.
 */
import type { MagpieAgent } from "@magpieloans/magpie-agent";

interface Cached {
  risk_score: number;
  raw: unknown;
  ts: number;
}

const cache = new Map<string, Cached>();
const TTL_MS = Number(process.env.RISK_CACHE_TTL_MIN ?? 60) * 60_000;

export interface RiskResult {
  risk_score: number;
  raw: unknown;
  cached: boolean;
}

/** Cached token risk. Pays 0.001 SOL only on a cache miss (or stale entry). */
export async function cachedTokenRisk(agent: MagpieAgent, mint: string): Promise<RiskResult> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return { risk_score: hit.risk_score, raw: hit.raw, cached: true };
  }
  const raw = await agent.tokenRisk(mint);
  const risk_score = Number((raw as { risk_score?: number }).risk_score ?? 100);
  cache.set(mint, { risk_score, raw, ts: Date.now() });
  return { risk_score, raw, cached: false };
}
