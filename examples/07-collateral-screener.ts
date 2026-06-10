/**
 * 07 — Collateral screener.
 *
 * Walks the free collateral catalog (every approved token), fetches
 * the per-mint risk profile (paid 0.001 SOL each), and prints the
 * ones that pass an agent-defined threshold. A real strategy would
 * pipe this into a build-borrow call for the top picks.
 *
 * Cost ceiling: by default it scans only the first N (default 5) so
 * a test run is bounded at 5 × 0.001 = 0.005 SOL. Bump MAX_SCAN to
 * cover the full catalog when you trust the agent.
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/07-collateral-screener.ts
 *
 * Tighten the filter:
 *   MAX_RISK=40 MIN_LIQUIDITY_USD=250000 npx tsx examples/07-collateral-screener.ts
 */
import { resolve } from "node:path";
import { loadKeypairFromFile, paidCall, freeGet } from "./lib/x402-client.js";

const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const payerPath = process.env.X402_PAYER_KEYPAIR;
if (!payerPath) {
  console.error("Set X402_PAYER_KEYPAIR to a keypair JSON file path");
  process.exit(1);
}
const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));

const MAX_SCAN = Number(process.env.MAX_SCAN ?? "5");
const MAX_RISK = Number(process.env.MAX_RISK ?? "60");
const MIN_LIQUIDITY = Number(process.env.MIN_LIQUIDITY_USD ?? "100000");

interface Token {
  mint: string;
  symbol: string;
  decimals: number;
  category: string;
}
interface RiskProfile {
  mint: string;
  symbol: string;
  risk_score: number;
  dimensions: Record<string, number>;
  market_data: {
    liquidity_usd: number;
    volume_24h_usd: number;
    market_cap_usd: number;
  };
  lending_impact: { ltv_modifier: number; max_allowed_ltv: number };
  flagged: boolean;
  flag_reason: string | null;
}

console.log("─── pulling collateral catalog (free) ───");
const catalog = await freeGet<{ tokens: Token[] }>(baseUrl, "/api/v1/collateral/eligible");
const candidates = catalog.tokens.slice(0, MAX_SCAN);
console.log(`scanning ${candidates.length} of ${catalog.tokens.length} tokens (MAX_SCAN=${MAX_SCAN})\n`);

const passing: Array<RiskProfile & { ltv: number }> = [];
for (const tok of candidates) {
  process.stderr.write(`  · ${tok.symbol.padEnd(8)} ${tok.mint.slice(0, 4)}…${tok.mint.slice(-4)}  `);
  try {
    const r = await paidCall<RiskProfile>(
      { rpcUrl, payer, baseUrl },
      "GET",
      "/api/v1/agent/token-risk",
      { query: { mint: tok.mint } },
    );
    const p = r.data;
    const ok =
      !p.flagged &&
      p.risk_score <= MAX_RISK &&
      p.market_data.liquidity_usd >= MIN_LIQUIDITY;
    process.stderr.write(
      `risk=${p.risk_score.toFixed(0).padStart(3)} liq=$${Math.round(p.market_data.liquidity_usd / 1000)}k ltv=${p.lending_impact.max_allowed_ltv}% ${ok ? "✓" : "✗"}\n`,
    );
    if (ok) passing.push({ ...p, ltv: p.lending_impact.max_allowed_ltv });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message.slice(0, 80)}\n`);
  }
}

console.log("\n─── passing collateral (sorted by safety + LTV) ───");
passing.sort((a, b) => a.risk_score - b.risk_score || b.ltv - a.ltv);
for (const p of passing) {
  console.log(
    `  ${p.symbol.padEnd(8)} risk=${p.risk_score.toFixed(0)} max-LTV=${p.ltv}% liq=$${Math.round(p.market_data.liquidity_usd / 1000)}k  mint=${p.mint}`,
  );
}
console.log(`\n${passing.length}/${candidates.length} tokens passed your filter.`);
