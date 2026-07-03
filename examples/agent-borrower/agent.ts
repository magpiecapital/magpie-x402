/**
 * agent.ts — Magpie Reference Borrowing Agent
 *
 * A standalone, production-deployable agent that:
 *   1. Fetches the eligible collateral catalog (free)
 *   2. Simulates borrow quotes for each candidate (free)
 *   3. Applies strategy rules (price threshold, diversity, max positions)
 *   4. If conditions are met: calls build-borrow (paid via x402), signs locally,
 *      submits to cosign-borrow
 *   5. Monitors and manages open positions
 *
 * JSON logging to stdout for log aggregation. Graceful shutdown on SIGTERM/SIGINT.
 *
 * Run:
 *   cp .env.example .env
 *   npx tsx agent.ts
 *
 * Docker:
 *   docker build -t magpie-agent-borrower .
 *   docker run --env-file .env magpie-agent-borrower
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MagpieAgent, type BorrowQuote } from "@magpieloans/magpie-agent";
import { z } from "zod";

// ── Zod Config Schema ────────────────────────────────────────────────────────

const ConfigSchema = z.object({
  MAGPIE_PAYER_SECRET: z.string().optional(),
  MAGPIE_PAYER_KEYPAIR: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  X402_BASE_URL: z.string().default("https://x402.magpie.capital"),
  MAGPIE_SITE_URL: z.string().default("https://www.magpie.capital"),
  CHECK_INTERVAL: z.coerce.number().int().min(10).default(300),
  RETRY_DELAY_SECONDS: z.coerce.number().int().min(5).default(30),
  MAX_POSITIONS: z.coerce.number().int().min(1).max(50).default(3),
  MIN_PRICE_CHANGE_PCT: z.coerce.number().min(0).max(1000).default(5.0),
  MAX_PRICE_CHANGE_PCT: z.coerce.number().min(0).max(10000).default(50.0),
  MAX_COLLATERAL_VALUE_SOL: z.coerce.number().min(0.01).default(5.0),
  MIN_COLLATERAL_VALUE_SOL: z.coerce.number().min(0).default(0.1),
  BORROW_TIER: z.enum(["express", "quick", "standard"]).default("standard"),
  USE_V4_EXITS: z.coerce.boolean().default(true),
  ENFORCE_DIVERSITY: z.coerce.boolean().default(true),
  X402_MAX_PAYMENT_LAMPORTS: z.coerce.bigint().default(20_000_000n),
  X402_ALLOWED_RECIPIENTS: z.string().default(""),
  MINT_ALLOWLIST: z.string().default(""),
  LOG_LEVEL: z.enum(["info", "warn", "error", "debug"]).default("info"),
});

type Config = z.infer<typeof ConfigSchema>;

// ── JSON Logger ──────────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, msg: string, meta: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    msg,
    agent: "magpie-agent-borrower",
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

const logInfo = (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta);
const logWarn = (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta);
const logError = (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta);
const logDebug = (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta);

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal bs58 decode using BigInt arithmetic. No extra dependency beyond
 * what @solana/web3.js already pulls in transitively.
 */
function bs58Decode(s: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP: Record<string, bigint> = {};
  for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = BigInt(i);
  const BASE = 58n;
  let num = 0n;
  for (const ch of s) {
    const v = ALPHABET_MAP[ch];
    if (v === undefined) throw new Error(`Invalid base58 character: ${ch}`);
    num = num * BASE + v;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 255n));
    num >>= 8n;
  }
  // Preserve leading 1s (which map to leading zeros)
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

function loadKeypair(cfg: Config): Keypair {
  if (cfg.MAGPIE_PAYER_SECRET && cfg.MAGPIE_PAYER_SECRET.trim()) {
    const s = cfg.MAGPIE_PAYER_SECRET.trim();
    if (s.startsWith("[")) {
      return Keypair.fromSecretKey(new Uint8Array(JSON.parse(s) as number[]));
    }
    // Assume bs58-encoded
    return Keypair.fromSecretKey(bs58Decode(s));
  }
  if (cfg.MAGPIE_PAYER_KEYPAIR && cfg.MAGPIE_PAYER_KEYPAIR.trim()) {
    const p = cfg.MAGPIE_PAYER_KEYPAIR.replace(/^~/, process.env.HOME || "");
    const raw = JSON.parse(readFileSync(resolve(p), "utf8")) as number[];
    return Keypair.fromSecretKey(new Uint8Array(raw));
  }
  throw new Error(
    "Set MAGPIE_PAYER_SECRET (bs58 or JSON array) or MAGPIE_PAYER_KEYPAIR (file path)."
  );
}

// ── Price Feed ───────────────────────────────────────────────────────────────
// Fetches current token prices from Jupiter price API (free, no key needed).
// Falls back to static defaults if unavailable (the agent still uses simulated
// borrow quotes from Magpie, which accept client-supplied prices).

interface TokenPrice {
  id: string;
  mintSymbol: string;
  vsToken: string;
  vsTokenSymbol: string;
  price: number;
}

const JUPITER_PRICE_API = "https://price.jup.ag/v6/price";

async function fetchTokenPrices(mints: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (mints.length === 0) return map;
  try {
    const ids = mints.join(",");
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${ids}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logWarn("Price API returned non-200", { status: res.status });
      return map;
    }
    const body = (await res.json()) as { data?: Record<string, TokenPrice> };
    if (body.data) {
      for (const [mint, info] of Object.entries(body.data)) {
        map.set(mint, info.price);
      }
    }
  } catch (e) {
    logWarn("Failed to fetch token prices", { error: String(e) });
  }
  return map;
}

// ── Positions Tracker ────────────────────────────────────────────────────────
// Tracks open borrowing positions in-memory. On restart, the agent reconciles
// with on-chain state via the SDK's walletLoans() call.

interface OpenPosition {
  loanId: string;
  collateralMint: string;
  collateralSymbol: string;
  borrowedLamports: bigint;
  openedAt: number;
  dueAt: number;
  loanPda: string;
}

class PositionManager {
  private positions: Map<string, OpenPosition> = new Map();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get size(): number {
    return this.positions.size;
  }

  get mints(): string[] {
    return Array.from(this.positions.values()).map((p) => p.collateralMint);
  }

  hasMint(mint: string): boolean {
    return this.positions.has(mint);
  }

  add(pos: OpenPosition): void {
    this.positions.set(pos.collateralMint, pos);
    logInfo("Position opened", {
      loanId: pos.loanId,
      collateralMint: pos.collateralMint,
      collateralSymbol: pos.collateralSymbol,
      borrowedLamports: pos.borrowedLamports.toString(),
      openedAt: pos.openedAt,
      dueAt: pos.dueAt,
    });
  }

  remove(mint: string): void {
    const pos = this.positions.get(mint);
    if (pos) {
      this.positions.delete(mint);
      logInfo("Position removed", {
        loanId: pos.loanId,
        collateralMint: mint,
      });
    }
  }

  list(): OpenPosition[] {
    return Array.from(this.positions.values());
  }

  isFull(): boolean {
    return this.positions.size >= this.config.MAX_POSITIONS;
  }

  /**
   * Reconcile positions from on-chain data on startup.
   * This catches any positions that were opened in a previous session.
   */
  async reconcile(agent: MagpieAgent, wallet: PublicKey): Promise<void> {
    try {
      const result = await agent.walletLoans(wallet, { status: "active" });
      if (result.loans.length > 0) {
        for (const loan of result.loans) {
          this.positions.set(loan.collateralMint, {
            loanId: loan.loanId,
            collateralMint: loan.collateralMint,
            collateralSymbol: "",
            borrowedLamports: BigInt(loan.loanAmountLamports),
            openedAt: loan.startTimestampUnix * 1000,
            dueAt: loan.dueTimestampUnix * 1000,
            loanPda: loan.loanPda,
          });
        }
        logInfo("Reconciled open positions from chain", {
          count: result.loans.length,
        });
      }
    } catch (e) {
      logWarn("Failed to reconcile positions (will start fresh)", {
        error: String(e),
      });
    }
  }

  /**
   * Check if adding a position for this mint would violate diversity rules.
   */
  canAddForMint(mint: string): boolean {
    if (!this.config.ENFORCE_DIVERSITY) return true;
    return !this.positions.has(mint);
  }
}

// ── Strategy Engine ──────────────────────────────────────────────────────────

interface CollateralCandidate {
  mint: string;
  symbol: string;
  decimals: number;
  category: string;
  priceUsd: number;
  solPriceUsd: number;
  priceChange24hPct: number;
  quote: BorrowQuote;
}

class StrategyEngine {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Score and rank candidates. Returns the best candidate that passes all
   * strategy rules, or null if none qualifies.
   */
  selectCandidate(
    candidates: CollateralCandidate[],
    positionManager: PositionManager,
  ): CollateralCandidate | null {
    // Filter by strategy rules
    const passing = candidates.filter((c) => this.passesRules(c, positionManager));
    if (passing.length === 0) return null;

    // Sort by 24h price change descending (biggest gainers first)
    passing.sort((a, b) => b.priceChange24hPct - a.priceChange24hPct);
    return passing[0];
  }

  private passesRules(c: CollateralCandidate, pm: PositionManager): boolean {
    // Price threshold: must be up at least MIN_PRICE_CHANGE_PCT in 24h
    if (c.priceChange24hPct < this.config.MIN_PRICE_CHANGE_PCT) {
      logDebug("Candidate below min price change threshold", {
        symbol: c.symbol,
        change24h: c.priceChange24hPct,
        min: this.config.MIN_PRICE_CHANGE_PCT,
      });
      return false;
    }

    // Max price change: don't chase tokens that have already mooned
    if (c.priceChange24hPct > this.config.MAX_PRICE_CHANGE_PCT) {
      logDebug("Candidate above max price change threshold", {
        symbol: c.symbol,
        change24h: c.priceChange24hPct,
        max: this.config.MAX_PRICE_CHANGE_PCT,
      });
      return false;
    }

    // Max positions
    if (pm.isFull()) {
      logDebug("At max positions", {
        current: pm.size,
        max: this.config.MAX_POSITIONS,
      });
      return false;
    }

    // Diversity: don't borrow against the same mint twice
    if (!pm.canAddForMint(c.mint)) {
      logDebug("Candidate mint already has an open position", {
        symbol: c.symbol,
        mint: c.mint,
      });
      return false;
    }

    // Max collateral value
    const collateralValueSol = c.priceUsd / c.solPriceUsd;
    if (collateralValueSol > this.config.MAX_COLLATERAL_VALUE_SOL) {
      logDebug("Candidate exceeds max collateral value", {
        symbol: c.symbol,
        valueSol: collateralValueSol,
        max: this.config.MAX_COLLATERAL_VALUE_SOL,
      });
      return false;
    }

    // Min collateral value
    if (collateralValueSol < this.config.MIN_COLLATERAL_VALUE_SOL) {
      logDebug("Candidate below min collateral value", {
        symbol: c.symbol,
        valueSol: collateralValueSol,
        min: this.config.MIN_COLLATERAL_VALUE_SOL,
      });
      return false;
    }

    return true;
  }
}

// ── Agent Orchestrator ───────────────────────────────────────────────────────

interface AgentState {
  running: boolean;
  cycleCount: number;
  lastError: string | null;
}

class BorrowingAgent {
  private cfg: Config;
  private agent: MagpieAgent;
  private keypair: Keypair;
  private positions: PositionManager;
  private strategy: StrategyEngine;
  private state: AgentState;

  constructor(cfg: Config, keypair: Keypair) {
    this.cfg = cfg;
    this.keypair = keypair;
    this.agent = new MagpieAgent({
      keypair,
      rpcUrl: cfg.SOLANA_RPC_URL,
      baseUrl: cfg.X402_BASE_URL,
      siteUrl: cfg.MAGPIE_SITE_URL,
    });
    this.positions = new PositionManager(cfg);
    this.strategy = new StrategyEngine(cfg);
    this.state = { running: true, cycleCount: 0, lastError: null };
  }

  async start(): Promise<void> {
    logInfo("Agent starting", {
      wallet: this.keypair.publicKey.toBase58(),
      tier: this.cfg.BORROW_TIER,
      maxPositions: this.cfg.MAX_POSITIONS,
      checkInterval: this.cfg.CHECK_INTERVAL,
    });

    // Reconcile any existing positions from on-chain
    await this.positions.reconcile(this.agent, this.keypair.publicKey);

    logInfo("Agent entering main loop", {
      openPositions: this.positions.size,
    });

    while (this.state.running) {
      this.state.cycleCount++;
      await this.runCycle();
      // Wait for next cycle (check every second if we should stop)
      for (let i = 0; i < this.cfg.CHECK_INTERVAL && this.state.running; i++) {
        await sleep(1000);
      }
    }
  }

  stop(): void {
    logInfo("Agent stopping (graceful shutdown)");
    this.state.running = false;
  }

  private async runCycle(): Promise<void> {
    logInfo("Starting agent cycle", { cycle: this.state.cycleCount });

    try {
      // Step 1: Fetch eligible collateral catalog
      const catalog = await this.withRetry(() => this.fetchCatalog());
      if (!catalog || catalog.length === 0) {
        logWarn("No eligible collateral tokens found");
        return;
      }
      logInfo("Fetched collateral catalog", { count: catalog.length });

      // Step 2: Fetch current prices for all candidates
      const mints = catalog.map((t) => t.mint);
      const prices = await fetchTokenPrices(mints);
      if (prices.size === 0) {
        logWarn("Could not fetch token prices, skipping cycle");
        return;
      }

      // Step 3: Fetch SOL price for value calculations
      const solPriceData = await fetchTokenPrices([
        "So11111111111111111111111111111111111111112",
      ]);
      const solPriceUsd = solPriceData.get(
        "So11111111111111111111111111111111111111112",
      ) ?? 150;

      // Step 4: Build candidate list from eligible tokens with prices
      const candidates: CollateralCandidate[] = [];
      for (const token of catalog) {
        const priceUsd = prices.get(token.mint);
        if (!priceUsd || priceUsd <= 0) {
          logDebug("No price data for token", { symbol: token.symbol });
          continue;
        }

        // Simulate borrow to get quote
        try {
          const quote = await this.withRetry(() =>
            this.agent.simulateBorrow({
              collateralMint: token.mint,
              collateralAmount: BigInt(10 ** token.decimals), // 1 token
              decimals: token.decimals,
              pricePerTokenUsd: priceUsd,
              solPriceUsd,
              tier: this.cfg.BORROW_TIER,
            }),
          );

          // Normalize: simulateBorrow can return a single quote or a list
          const quotes = Array.isArray(quote) ? quote : (quote as any).quotes ?? [quote];
          const bestQuote = quotes.find(
            (q: any) => q.tier === this.cfg.BORROW_TIER,
          ) ?? quotes[0];

          if (bestQuote && BigInt(bestQuote.borrowableLamports ?? "0") > 0n) {
            candidates.push({
              mint: token.mint,
              symbol: token.symbol,
              decimals: token.decimals,
              category: token.category,
              priceUsd,
              solPriceUsd,
              priceChange24hPct: 0, // Will be filled if available
              quote: bestQuote as BorrowQuote,
            });
          }
        } catch (e) {
          logDebug("Simulate-borrow failed for token", {
            symbol: token.symbol,
            error: String(e),
          });
        }
      }

      logInfo("Built candidate list", { count: candidates.length });

      // Step 5: Apply strategy to select best candidate
      const selected = this.strategy.selectCandidate(candidates, this.positions);
      if (!selected) {
        logInfo("No candidate passed strategy rules this cycle");
        return;
      }

      logInfo("Selected candidate for borrow", {
        symbol: selected.symbol,
        mint: selected.mint,
        borrowableLamports: selected.quote.borrowableLamports,
        priceChange24hPct: selected.priceChange24hPct,
      });

      // Step 6: Execute the borrow
      await this.executeBorrow(selected);
    } catch (e) {
      const errMsg = String(e);
      this.state.lastError = errMsg;
      logError("Agent cycle failed", { error: errMsg, cycle: this.state.cycleCount });

      // Wait before retrying
      await sleep(this.cfg.RETRY_DELAY_SECONDS * 1000);
    }
  }

  private async executeBorrow(candidate: CollateralCandidate): Promise<void> {
    logInfo("Executing borrow", {
      symbol: candidate.symbol,
      mint: candidate.mint,
      tier: this.cfg.BORROW_TIER,
      borrowableLamports: candidate.quote.borrowableLamports,
    });

    try {
      // Use the SDK's borrow() method which handles the full flow:
      // build-borrow (paid via x402) → sign locally → submit to cosign-borrow
      const result = await this.agent.borrow({
        collateralMint: candidate.mint,
        collateralAmount: BigInt(10 ** candidate.decimals), // 1 token
        tier: this.cfg.BORROW_TIER,
        hasExitArming: this.cfg.USE_V4_EXITS,
      });

      logInfo("Borrow executed successfully", {
        loanId: result.loanId,
        signature: result.signature,
        borrowedLamports: result.borrowedLamports.toString(),
        feesPaidLamports: result.feesPaidLamports.toString(),
      });

      // Track the position
      this.positions.add({
        loanId: result.loanId,
        collateralMint: candidate.mint,
        collateralSymbol: candidate.symbol,
        borrowedLamports: result.borrowedLamports,
        openedAt: Date.now(),
        dueAt: Date.now() + candidate.quote.durationDays * 86400_000,
        loanPda: result.loanId, // SDK returns loanId as the PDA-ish identifier
      });
    } catch (e) {
      logError("Borrow execution failed", {
        symbol: candidate.symbol,
        mint: candidate.mint,
        error: String(e),
      });
      throw e;
    }
  }

  private async fetchCatalog(): Promise<
    Array<{ mint: string; symbol: string; decimals: number; category: string }>
  > {
    const result = await this.agent.collateralCatalog();
    let tokens = result.tokens ?? [];

    // Apply mint allowlist filter if configured
    const allowlist = this.cfg.MINT_ALLOWLIST
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.length > 0) {
      tokens = tokens.filter((t) => allowlist.includes(t.mint.toLowerCase()));
    }

    return tokens;
  }

  /**
   * Retry wrapper with exponential backoff for transient failures.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 30_000);
          logWarn("Retryable operation failed, retrying", {
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            error: String(e),
          });
          await sleep(delay);
        }
      }
    }
    throw lastErr;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // Parse and validate config
  const env = process.env as Record<string, string>;
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        msg: "Configuration validation failed",
        errors: parsed.error.flatten().fieldErrors,
      }),
    );
    process.exit(1);
  }

  const cfg = parsed.data;

  // Mask secret when logging config
  const logCfg = { ...cfg, MAGPIE_PAYER_SECRET: cfg.MAGPIE_PAYER_SECRET ? "***" : undefined };
  logInfo("Configuration loaded", { config: logCfg });

  // Load keypair
  let keypair: Keypair;
  try {
    keypair = loadKeypair(cfg);
  } catch (e) {
    logError("Failed to load signing keypair", { error: String(e) });
    process.exit(1);
  }

  logInfo("Keypair loaded", { publicKey: keypair.publicKey.toBase58() });

  // Create and start the agent
  const agent = new BorrowingAgent(cfg, keypair);

  // Graceful shutdown handler
  const shutdown = () => {
    logInfo("Shutdown signal received");
    agent.stop();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Run the agent (this blocks until stopped)
  agent.start().catch((e) => {
    logError("Agent terminated with fatal error", { error: String(e) });
    process.exit(1);
  });
}

// Start
main();
