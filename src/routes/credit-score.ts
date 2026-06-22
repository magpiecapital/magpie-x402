import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * GET /api/v1/credit-score?wallet=<solana-pubkey>
 *
 * Returns Magpie's on-chain credit score for the given wallet. AI agents
 * + other Solana protocols can use this to qualify borrowers, gate
 * features, or fold Magpie reputation into their own scoring.
 *
 * Behind x402 — caller pays the configured amount per lookup. The
 * response data itself is public (the credit score lives on-chain via
 * the magpie-credit-oracle program), but the API surface is paid
 * to fund infrastructure + prevent abuse.
 *
 * DELIBERATE: this endpoint does NOT bind payer==wallet (unlike build-*).
 * It is a PUBLIC CREDIT ORACLE by design — its whole product purpose is to
 * let OTHER protocols/agents look up ANY wallet's Magpie creditworthiness
 * (the score is public-derivable from on-chain repayment history, so this
 * leaks no private data). Per-wallet binding would break that product. A
 * security review (2026-06-20) flagged the missing binding; it is
 * intentional and the payment + cache + rate-limit bound abuse. If the
 * product later wants owner-only scores, add enforcePayerMatchesWallet here.
 *
 * Production wiring (TODO): connect MAGPIE_DB_READONLY_URL and pull
 * the real score. For now returns a deterministic placeholder so the
 * x402 plumbing can be exercised end-to-end before DB credentials are
 * provisioned to this service.
 */
export async function creditScoreHandler(c: Context) {
  const wallet = c.req.query("wallet");
  if (!wallet) {
    return c.json({ error: "missing_wallet_param" }, 400);
  }
  // Validate as a real base58 pubkey before doing anything else
  try {
    new PublicKey(wallet);
  } catch {
    return c.json({ error: "invalid_wallet_pubkey" }, 400);
  }

  // Placeholder behavior — replace with DB query when
  // MAGPIE_DB_READONLY_URL is wired. Returns a deterministic
  // pseudo-score from the wallet hash so callers can integrate
  // against a real-looking response shape today.
  const hash = wallet.split("").reduce((h, ch) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0);
  const score = 300 + (Math.abs(hash) % 551); // 300..850 range
  const tier =
    score >= 750 ? "platinum" :
    score >= 650 ? "gold" :
    score >= 500 ? "silver" : "bronze";

  return c.json({
    wallet,
    score,
    tier,
    range: { min: 300, max: 850 },
    // Tier benefits — keep aligned with magpiecapital/magpie-bot's
    // src/services/credit-score.js TIER_DEFS. Public knowledge.
    benefits: {
      maxLtvPercent:
        tier === "platinum" ? 38 :
        tier === "gold" ? 35 :
        tier === "silver" ? 32 : 30,
      minFeeRate:
        tier === "platinum" ? 0.01 :
        tier === "gold" ? 0.0125 : 0.015,
      maxDurationDays:
        tier === "platinum" ? 30 :
        tier === "gold" ? 14 : 7,
    },
    source: "magpie-credit-oracle (placeholder until DB wired)",
    notes: [
      "Score is canonical at the on-chain magpie-credit-oracle program (BBYtty9sqWjHzTuoXSNfDCpNtLn6ZjfSfhYEoY6MFP2E).",
      "This endpoint will return live DB-derived data once MAGPIE_DB_READONLY_URL is provisioned.",
    ],
  });
}
