/**
 * Magpie loan tiers — public protocol constants, mirrored from
 * magpie-bot's src/services/tiers.js. Keep in sync if the on-chain
 * program ever ships new tiers (currently fixed at 3).
 */

export type TierName = "express" | "quick" | "standard";

export interface Tier {
  name: TierName;
  ltvPercent: number;        // collateral utilization
  durationDays: number;      // loan term
  feePercent: number;        // upfront fee at borrow time
  description: string;
}

export const TIERS: Record<TierName, Tier> = {
  express: {
    name: "express",
    ltvPercent: 30,
    durationDays: 2,
    feePercent: 3.0,
    description: "Most SOL up-front, shortest leash. Pay more for speed.",
  },
  quick: {
    name: "quick",
    ltvPercent: 25,
    durationDays: 3,
    feePercent: 2.0,
    description: "Middle of the road. Most users land here.",
  },
  standard: {
    name: "standard",
    ltvPercent: 20,
    durationDays: 7,
    feePercent: 1.5,
    description: "Most breathing room, lowest fee, smallest SOL slice.",
  },
};

export function tierFromName(name: string): Tier | null {
  const lower = name.toLowerCase();
  return (TIERS as Record<string, Tier>)[lower] ?? null;
}

/**
 * Compute loan terms from collateral USD value + tier.
 *
 *   loan_usd  = collateral_usd * ltv_percent / 100
 *   fee_usd   = loan_usd * fee_percent / 100
 *   net_usd   = loan_usd - fee_usd          (what the borrower receives)
 *   owed_usd  = loan_usd                    (what they have to repay before due)
 *   due_at    = now + duration_days
 *
 * USD numbers convert to SOL via the caller-supplied solPriceUsd.
 */
export interface BorrowQuote {
  tier: TierName;
  collateral: {
    mint: string;
    amount: string;        // raw u64 in the token's smallest unit
    decimals: number;
    pricePerTokenUsd: number;
    totalValueUsd: number;
  };
  terms: {
    ltvPercent: number;
    feePercent: number;
    durationDays: number;
    dueAtUnix: number;
  };
  loan: {
    grossLamports: string;
    grossSol: number;
    feeLamports: string;
    feeSol: number;
    netLamports: string;     // what the borrower actually receives
    netSol: number;
    owedLamports: string;    // what they have to repay (= gross)
    owedSol: number;
  };
  solPriceUsd: number;
  generatedAtUnix: number;
}

export function quoteBorrow(opts: {
  tier: Tier;
  mint: string;
  amount: bigint;
  decimals: number;
  pricePerTokenUsd: number;
  solPriceUsd: number;
}): BorrowQuote {
  if (opts.pricePerTokenUsd <= 0) throw new Error("price_must_be_positive");
  if (opts.solPriceUsd <= 0) throw new Error("sol_price_must_be_positive");
  if (opts.amount <= 0n) throw new Error("amount_must_be_positive");
  if (opts.decimals < 0 || opts.decimals > 18) throw new Error("invalid_decimals");

  const tokens = Number(opts.amount) / 10 ** opts.decimals;
  const collateralUsd = tokens * opts.pricePerTokenUsd;
  const loanUsd = collateralUsd * opts.tier.ltvPercent / 100;
  const feeUsd = loanUsd * opts.tier.feePercent / 100;

  const lamportsPerUsd = 1e9 / opts.solPriceUsd;
  const grossLamports = BigInt(Math.floor(loanUsd * lamportsPerUsd));
  const feeLamports = BigInt(Math.floor(feeUsd * lamportsPerUsd));
  const netLamports = grossLamports - feeLamports;

  const now = Math.floor(Date.now() / 1000);
  return {
    tier: opts.tier.name,
    collateral: {
      mint: opts.mint,
      amount: opts.amount.toString(),
      decimals: opts.decimals,
      pricePerTokenUsd: opts.pricePerTokenUsd,
      totalValueUsd: collateralUsd,
    },
    terms: {
      ltvPercent: opts.tier.ltvPercent,
      feePercent: opts.tier.feePercent,
      durationDays: opts.tier.durationDays,
      dueAtUnix: now + opts.tier.durationDays * 86400,
    },
    loan: {
      grossLamports: grossLamports.toString(),
      grossSol: Number(grossLamports) / 1e9,
      feeLamports: feeLamports.toString(),
      feeSol: Number(feeLamports) / 1e9,
      netLamports: netLamports.toString(),
      netSol: Number(netLamports) / 1e9,
      owedLamports: grossLamports.toString(),
      owedSol: Number(grossLamports) / 1e9,
    },
    solPriceUsd: opts.solPriceUsd,
    generatedAtUnix: now,
  };
}
