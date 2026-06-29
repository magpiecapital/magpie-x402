/**
 * discovery.ts — the "trench-token brain": find GOOD early/low-cap memecoins.
 * ─────────────────────────────────────────────────────────────────────────
 * The base agent only ever considers tokens already in Magpie's collateral
 * catalog. This module widens the funnel: it sources FRESH trench tokens from
 * public market data (DexScreener) and runs each through a deterministic
 * downside-protection gauntlet BEFORE it is ever offered to the buy brain.
 *
 * "Good" trench token = passes ALL of:
 *   • Solana pair with real liquidity (≥ DISCOVERY_MIN_LIQ_USD)
 *   • real 24h volume (≥ DISCOVERY_MIN_VOL_USD)
 *   • age in the trench window (old enough to not be a 5-minute rug, young
 *     enough to still be a trench) — [DISCOVERY_MIN_AGE_MIN, DISCOVERY_MAX_AGE_H]
 *   • mint authority renounced AND freeze authority renounced (on-chain) —
 *     so supply can't be inflated and balances can't be frozen
 *   • SELLABLE: a live Jupiter token→SOL route exists (anti-honeypot, proves
 *     there is exit liquidity to ever repay/realize)
 *
 * Everything here is READ-ONLY research — no funds move. The candidates it
 * returns are still independently risk-gated, position-sized, solvency-bounded,
 * stop-lossed and take-profited by the existing trade engine. This is the
 * funnel, not the trigger.
 *
 * Failure is always soft: any network/RPC hiccup yields fewer (or zero)
 * candidates, never an exception into the agent loop.
 *
 * Operator-mandated 2026-06-28: "x402TWO wallet should have a brain finding
 * good trench tokens and then using Magpie for loans" — protect the downside,
 * never chase high-rug tokens.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { AgentConfig } from "./config.js";
import type { TradeCandidate } from "./brain.js";
import { WSOL_MINT } from "./jupiter.js";

const JUPITER_BASE = process.env.JUPITER_BASE ?? "https://lite-api.jup.ag";
const DEXSCREENER = "https://api.dexscreener.com";

// Mints that are never "trench" candidates (SOL, majors, stables).
const EXCLUDE_MINTS = new Set<string>([
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj", // stSOL
  "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump", // $MAGPIE (own token)
]);

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * Validate a mint is a real base58 Solana pubkey BEFORE it is ever interpolated
 * into a DexScreener / Jupiter URL. Values come from an external API feed, so
 * this is the trust boundary: anything that isn't a clean 32-byte base58 key is
 * dropped (no malformed string can reach a request URL).
 */
function isValidMint(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

interface DiscoveryCfg {
  minLiqUsd: number;
  minVol24Usd: number;
  minAgeMin: number;
  maxAgeHours: number;
  maxCandidates: number;
  maxVet: number;
}

export function discoveryConfig(): DiscoveryCfg {
  return {
    minLiqUsd: num(process.env.DISCOVERY_MIN_LIQ_USD, 20_000),
    minVol24Usd: num(process.env.DISCOVERY_MIN_VOL_USD, 30_000),
    minAgeMin: num(process.env.DISCOVERY_MIN_AGE_MIN, 30),
    maxAgeHours: num(process.env.DISCOVERY_MAX_AGE_H, 72),
    maxCandidates: num(process.env.DISCOVERY_MAX_CANDIDATES, 8),
    maxVet: num(process.env.DISCOVERY_MAX_VET, 14),
  };
}

/** Discovery is on by default in trade mode; flip DISCOVERY_ENABLED=false to disable. */
export function discoveryEnabled(): boolean {
  return process.env.DISCOVERY_ENABLED !== "false";
}

async function dfetch(url: string): Promise<unknown | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number; // ms epoch
  marketCap?: number;
}

/** Pull a raw pool of candidate Solana mints from DexScreener's trending/boosted feeds. */
async function sourceTrendingMints(): Promise<string[]> {
  const out = new Set<string>();
  // Boosted tokens are the closest public proxy for "what the trenches are
  // looking at right now". Two feeds: latest + top. Both are { tokenAddress, chainId }[].
  for (const path of ["/token-boosts/latest/v1", "/token-boosts/top/v1"]) {
    const data = (await dfetch(`${DEXSCREENER}${path}`)) as Array<Record<string, unknown>> | null;
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      if (String(row.chainId) !== "solana") continue;
      const mint = String(row.tokenAddress ?? "");
      // Trust boundary: only accept well-formed base58 mints (no URL injection).
      if (mint && isValidMint(mint) && !EXCLUDE_MINTS.has(mint)) out.add(mint);
    }
  }
  return [...out];
}

/** Best Solana pair (deepest liquidity) for a mint, or null. */
async function bestPairFor(mint: string): Promise<DexPair | null> {
  const data = (await dfetch(`${DEXSCREENER}/latest/dex/tokens/${mint}`)) as { pairs?: DexPair[] } | null;
  const pairs = (data?.pairs ?? []).filter((p) => p.chainId === "solana");
  if (!pairs.length) return null;
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pairs[0];
}

/** On-chain: true ONLY if BOTH mint authority and freeze authority are renounced (null). */
async function authoritiesRenounced(conn: Connection, mint: string): Promise<boolean> {
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const parsed = (info.value?.data as { parsed?: { info?: Record<string, unknown> } } | undefined)?.parsed;
    if (!parsed?.info) return false; // can't verify → reject (fail-closed)
    const mintAuth = parsed.info.mintAuthority;
    const freezeAuth = parsed.info.freezeAuthority;
    return (mintAuth === null || mintAuth === undefined) && (freezeAuth === null || freezeAuth === undefined);
  } catch {
    return false; // fail-closed: if we can't prove it's safe, it isn't a candidate
  }
}

/** Anti-honeypot: a live token→SOL route must exist (real exit liquidity). */
async function isSellable(mint: string, decimals: number): Promise<boolean> {
  // Quote selling ~1 whole token; we only care that a route exists.
  const amount = BigInt(10) ** BigInt(Math.min(decimals, 9));
  const url =
    `${JUPITER_BASE}/swap/v1/quote?inputMint=${mint}&outputMint=${WSOL_MINT}` +
    `&amount=${amount.toString()}&slippageBps=300`;
  const q = (await dfetch(url)) as { outAmount?: string; error?: string } | null;
  return !!(q && q.outAmount && BigInt(q.outAmount) > 0n);
}

export interface DiscoveredToken extends TradeCandidate {
  liquidityUsd: number;
  volume24Usd: number;
  ageMinutes: number;
  marketCapUsd?: number;
}

/**
 * Find vetted trench candidates. Pure research; returns at most
 * cfg.maxCandidates tokens that PASSED the full gauntlet, best liquidity first.
 */
export async function discoverTrenchCandidates(cfg: AgentConfig): Promise<DiscoveredToken[]> {
  const d = discoveryConfig();
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const now = Date.now();

  const mints = await sourceTrendingMints();
  if (!mints.length) return [];

  // First pass — cheap market filters (one DexScreener call each), keep the
  // best `maxVet` by liquidity to bound the expensive on-chain/Jupiter checks.
  const prelim: Array<{ c: DiscoveredToken; decimals: number }> = [];
  for (const mint of mints) {
    const pair = await bestPairFor(mint);
    if (!pair || !pair.baseToken?.address) continue;
    if (pair.baseToken.address !== mint) continue; // mint must be the BASE token
    const liq = pair.liquidity?.usd ?? 0;
    const vol = pair.volume?.h24 ?? 0;
    const ageMin = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : Number.POSITIVE_INFINITY;
    if (liq < d.minLiqUsd) continue;
    if (vol < d.minVol24Usd) continue;
    if (ageMin < d.minAgeMin) continue; // too fresh = rug window
    if (ageMin > d.maxAgeHours * 60) continue; // too old = not a trench
    prelim.push({
      c: {
        mint,
        symbol: (pair.baseToken.symbol ?? "?").slice(0, 16),
        category: "memecoin",
        liquidityUsd: liq,
        volume24Usd: vol,
        ageMinutes: Math.round(ageMin),
        marketCapUsd: pair.marketCap,
      },
      decimals: 6, // memecoin default; only used to size the sellability probe
    });
  }
  prelim.sort((a, b) => b.c.liquidityUsd - a.c.liquidityUsd);
  const shortlist = prelim.slice(0, d.maxVet);

  // Second pass — the deterministic downside-protection gauntlet (on-chain +
  // Jupiter). Fail-closed: any token that can't be PROVEN safe is dropped.
  const passed: DiscoveredToken[] = [];
  for (const { c, decimals } of shortlist) {
    if (passed.length >= d.maxCandidates) break;
    const renounced = await authoritiesRenounced(conn, c.mint);
    if (!renounced) continue;
    const sellable = await isSellable(c.mint, decimals);
    if (!sellable) continue;
    passed.push(c);
  }
  return passed;
}
