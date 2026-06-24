/**
 * config.ts — all the safety knobs in one place.
 * Every default is the SAFE choice. You opt INTO risk, never out of safety.
 */
export interface AgentConfig {
  /** Master switch. true = simulate everything, move no funds. Flip with LIVE=1. */
  dryRun: boolean;
  /** Solana RPC. Use a paid endpoint (Helius/Triton) for a real deployment. */
  rpcUrl: string;
  /** Magpie x402 base URL. */
  baseUrl: string;

  /** HARD allowlist of mints the agent may buy. Empty in dry-run = "auto-pick one memecoin to illustrate". */
  mintAllowlist: string[];
  /** Reject any candidate whose Magpie token-risk score exceeds this (0-100, lower = safer). */
  maxTokenRisk: number;
  /** Preferred collateral class. 'rwa' is the materially safer path. */
  preferredCategory: "rwa" | "memecoin" | "any";

  /** Borrow tier. express=2d, quick=3d, standard=7d term. */
  tier: "express" | "quick" | "standard";
  /** Open on V4 so we can arm in-vault exits. */
  useV4Exits: boolean;

  /** Never run more than this many loans (deadlines) at once. */
  maxOpenLoans: number;
  /**
   * Repay this far before due, as a FRACTION of the loan term (0.5 = repay at
   * the halfway point). Wide leads survive RPC blips + retries. Also bounded
   * by repayLeadSecondsMin.
   */
  repayLeadFraction: number;
  repayLeadSecondsMin: number;

  /** Keep this much SOL untouched for gas/rent/signatures (lamports). */
  gasBufferLamports: bigint;
  /**
   * THE leverage-loop kill switch. false (default) = borrowed SOL is held idle
   * as repay reserve, never re-deployed into another buy. true = recursive
   * re-leverage (much higher risk of total loss). Keep this false.
   */
  allowRecursiveRedeploy: boolean;

  /** How often the loan guardian wakes to check deadlines (ms). */
  guardianIntervalMs: number;
}

export function loadConfig(): AgentConfig {
  return {
    dryRun: !(process.env.LIVE === "1"),
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    baseUrl: process.env.X402_BASE_URL ?? "https://x402.magpie.capital",

    mintAllowlist: (process.env.MINT_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxTokenRisk: Number(process.env.MAX_TOKEN_RISK ?? 60),
    preferredCategory: (process.env.PREFERRED_CATEGORY as AgentConfig["preferredCategory"]) ?? "rwa",

    tier: (process.env.TIER as AgentConfig["tier"]) ?? "standard", // longest term = most repay headroom
    useV4Exits: process.env.USE_V4_EXITS !== "false",

    maxOpenLoans: Number(process.env.MAX_OPEN_LOANS ?? 1),
    repayLeadFraction: Number(process.env.REPAY_LEAD_FRACTION ?? 0.5),
    repayLeadSecondsMin: Number(process.env.REPAY_LEAD_SECONDS_MIN ?? 6 * 3600), // >= 6h before due

    gasBufferLamports: BigInt(process.env.GAS_BUFFER_LAMPORTS ?? 30_000_000), // 0.03 SOL
    allowRecursiveRedeploy: process.env.ALLOW_RECURSIVE_REDEPLOY === "true",

    guardianIntervalMs: Number(process.env.GUARDIAN_INTERVAL_MS ?? 10 * 60_000), // every 10 min
  };
}
