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

  /**
   * What the agent does each cycle:
   *   'trade'  — find memecoins, BUY them, and SELL for profit (take-profit / stop-loss /
   *              brain exit). Spot only, no leverage. The wallet's own SOL is the book.
   *   'borrow' — buy collateral + borrow against it on Magpie, guardian repays (the demo).
   *   'both'   — run the trade book AND keep the borrow/guardian path.
   * Default 'trade'.
   */
  strategy: "trade" | "borrow" | "both";

  // ── trade-mode knobs (only used when strategy includes 'trade') ────────────
  /** SOL to deploy per new memecoin position (lamports). */
  tradePositionLamports: bigint;
  /** Never hold more than this many open memecoin positions at once. */
  maxPositions: number;
  /** Mechanical take-profit: auto-sell a position up >= this % vs entry (needs a known cost basis). */
  tradeTakeProfitPct: number;
  /** Mechanical stop-loss: auto-sell a position down >= this % vs entry. The downside floor. */
  tradeStopLossPct: number;
  /** Don't mechanically exit a position younger than this (lets a thesis breathe; ms). */
  tradeMinHoldMs: number;
  /** Ignore dust positions worth less than this in SOL (lamports) when valuing/selling. */
  tradeMinPositionLamports: bigint;
  /** Max slippage tolerated on a trade swap (bps). */
  tradeSlippageBps: number;

  /** HARD allowlist of mints the agent may buy. Empty in dry-run = "auto-pick one to illustrate". */
  mintAllowlist: string[];
  /**
   * When LIVE with an EMPTY allowlist: false = buy nothing (safest). true = let the
   * brain pick from Magpie's full approved-collateral catalog (already a vetted
   * allowlist), still risk-gated. Set OPEN_UNIVERSE=true for an actively-trading agent.
   */
  openUniverse: boolean;
  /**
   * Prefer collateralizing tokens the wallet ALREADY holds (e.g. its BONK) over
   * buying fresh — cheaper, no Jupiter slippage. Default true. The agent still
   * falls back to buying when it holds nothing borrowable in the chosen category.
   */
  useExistingHoldings: boolean;
  /** Reject any candidate whose Magpie token-risk score exceeds this (0-100, lower = safer). */
  maxTokenRisk: number;
  /** Preferred collateral class. 'rwa' is the materially safer path; 'any' = memecoins + RWAs. */
  preferredCategory: "rwa" | "memecoin" | "any";

  /** Borrow tier. express=2d, quick=3d, standard=7d term. */
  tier: "express" | "quick" | "standard";
  /** Open on V4 so we can arm in-vault exits. */
  useV4Exits: boolean;

  /** Never run more than this many loans (deadlines) at once. */
  maxOpenLoans: number;
  /** Hard cap on SOL spent per buy (lamports). 0 = no cap beyond the solvency reserve. */
  maxBuyLamports: bigint;
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
  /**
   * How often the trading brain wakes to (maybe) open a new position (ms). The agent
   * runs continuously: every cycle it researches + acts within the safety rails, then
   * sleeps this long. Default 30 min. 0 = one cycle then idle (the guardian keeps running).
   */
  cycleIntervalMs: number;

  /** Passive monitoring — DM every action to Telegram. Empty token = console only. */
  notify: { telegramToken: string; telegramChatId: string };
}

/** Where the agent's signing key can come from (file path for local, secret for env/Railway). */
export function loadKeySources(): { secret?: string; path?: string } {
  return {
    secret: process.env.MAGPIE_PAYER_SECRET, // bs58 or JSON array — for Railway/env deploys
    path: process.env.MAGPIE_PAYER_KEYPAIR ?? process.env.X402_PAYER_KEYPAIR, // local file path
  };
}

export function loadConfig(): AgentConfig {
  const num = (v: string | undefined, d: number) => (v == null || v === "" ? d : Number(v));
  return {
    dryRun: !(process.env.LIVE === "1"),
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    baseUrl: process.env.X402_BASE_URL ?? "https://x402.magpie.capital",

    strategy: (process.env.STRATEGY as AgentConfig["strategy"]) ?? "trade",
    tradePositionLamports: BigInt(Math.round(num(process.env.TRADE_POSITION_SOL, 0.25) * 1e9)),
    maxPositions: num(process.env.MAX_POSITIONS, 3),
    tradeTakeProfitPct: num(process.env.TRADE_TAKE_PROFIT_PCT, 40),
    tradeStopLossPct: num(process.env.TRADE_STOP_LOSS_PCT, 25),
    tradeMinHoldMs: num(process.env.TRADE_MIN_HOLD_MIN, 0) * 60_000,
    tradeMinPositionLamports: BigInt(Math.round(num(process.env.TRADE_MIN_POSITION_SOL, 0.01) * 1e9)),
    tradeSlippageBps: num(process.env.TRADE_SLIPPAGE_BPS, 150),

    mintAllowlist: (process.env.MINT_ALLOWLIST ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    openUniverse: process.env.OPEN_UNIVERSE === "true",
    useExistingHoldings: process.env.USE_EXISTING_HOLDINGS !== "false",
    maxTokenRisk: num(process.env.MAX_TOKEN_RISK, 60),
    preferredCategory: (process.env.PREFERRED_CATEGORY as AgentConfig["preferredCategory"]) ?? "rwa",

    tier: (process.env.TIER as AgentConfig["tier"]) ?? "standard", // longest term = most repay headroom
    useV4Exits: process.env.USE_V4_EXITS !== "false",

    maxOpenLoans: num(process.env.MAX_OPEN_LOANS, 1),
    maxBuyLamports: BigInt(Math.round(num(process.env.MAX_BUY_SOL, 0) * 1e9)),
    repayLeadFraction: num(process.env.REPAY_LEAD_FRACTION, 0.5),
    repayLeadSecondsMin: num(process.env.REPAY_LEAD_SECONDS_MIN, 6 * 3600), // >= 6h before due

    gasBufferLamports: BigInt(process.env.GAS_BUFFER_LAMPORTS ?? 50_000_000), // 0.05 SOL (swap fees + ATA rent + priority)
    allowRecursiveRedeploy: process.env.ALLOW_RECURSIVE_REDEPLOY === "true",

    guardianIntervalMs: num(process.env.GUARDIAN_INTERVAL_MS, 10 * 60_000), // every 10 min
    cycleIntervalMs: num(process.env.CYCLE_INTERVAL_MIN, 30) * 60_000, // every 30 min

    notify: {
      telegramToken: process.env.AGENT_NOTIFY_TELEGRAM_TOKEN ?? "",
      telegramChatId: process.env.AGENT_NOTIFY_TELEGRAM_CHAT ?? "",
    },
  };
}
