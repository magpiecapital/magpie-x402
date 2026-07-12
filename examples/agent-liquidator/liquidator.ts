/**
 * agent-liquidator — Production-grade reference liquidation bot for Magpie x402.
 *
 * Polls /api/v1/markets/liquidatable (free, 8s cache), profit-checks every
 * candidate, picks the most-past-due loan, builds a liquidation tx via
 * /api/v1/agent/build-liquidate (paid 0.003 SOL via x402), signs locally,
 * and submits to the Solana network.
 *
 * Designed for the $1,000-2,000 bounty at
 * https://github.com/magpiecapital/magpie-x402/issues/5
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx liquidator.ts
 *
 * Env vars (all optional except X402_PAYER_KEYPAIR and SOLANA_RPC_URL):
 *   X402_PAYER_KEYPAIR   Path to keypair JSON file  [required]
 *   SOLANA_RPC_URL       Solana RPC endpoint        [required]
 *   X402_BASE_URL        x402 API base              [default: https://x402.magpie.capital]
 *   POLL_INTERVAL_MS     Polling interval (ms)      [default: 8000]
 *   MIN_PAST_DUE_SEC     Min seconds past due       [default: 0]
 *   MIN_KEEPER_REWARD_LAMPORTS  Profit threshold    [default: 10000]
 *   GAS_COST_LAMPORTS    Estimated gas per tx       [default: 5000]
 *   LOG_LEVEL            "info" | "debug" | "quiet" [default: "info"]
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { freeGet, paidCall } from "../lib/x402-client.js";
import type { PaidCallResult } from "../lib/x402-client.js";

/* ─────────────────────────────────────────────────────────────────────
 *  Constants
 * ───────────────────────────────────────────────────────────────────── */

const BASE = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "";
const PAYER_PATH = process.env.X402_PAYER_KEYPAIR ?? "";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? "8000");
const MIN_PAST_DUE = Number(process.env.MIN_PAST_DUE_SEC ?? "0");
const MIN_REWARD = Number(process.env.MIN_KEEPER_REWARD_LAMPORTS ?? "10000");
const GAS_COST = Number(process.env.GAS_COST_LAMPORTS ?? "5000");
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info") as "info" | "debug" | "quiet";

const COOLDOWN_MS = 120_000; // 2 minutes — don't re-attempt the same loan PDA

/* ─────────────────────────────────────────────────────────────────────
 *  Types
 * ───────────────────────────────────────────────────────────────────── */

interface LiquidatableCandidate {
  loan_pda: string;
  loan_id: string;
  borrower: string;
  collateral_mint: string;
  collateral_amount: string;
  borrowed_lamports: string;
  due_at_unix: number;
  seconds_past_due: number;
}

interface LiquidatableFeed {
  liquidatable: LiquidatableCandidate[];
  total: number;
}

interface PoolStateResponse {
  /** The protocol's share of the liquidation bounty in basis points (e.g. 500 = 5%). */
  keeperRewardBps: number;
  totalDeposits: string;
  totalBorrowed: string;
  utilizationRate: number;
  protocolFeeBps: number;
  paused: boolean;
}

interface BuildLiquidateResponse {
  partial_signed_tx_b64: string;
  summary: Record<string, unknown>;
  keeper_reward_info?: { note: string; collateral_token_amount?: string };
}

/* ─────────────────────────────────────────────────────────────────────
 *  State
 * ───────────────────────────────────────────────────────────────────── */

let payer: Keypair;
let keeperPubkey: string;
let connection: Connection;

/** Loan PDAs we've recently attempted (cooldown map keyed by loan_pda → timestamp). */
const cooldowns = new Map<string, number>();

/** Cumulative keeper rewards (in lamports of collateral token, or 0 if not tracked). */
let dailyRewards = 0;
let dailyRewardDate = dateStr();

/** Total counters for stats reporting. */
const counters = { attempts: 0, successes: 0, failures: 0, skipped: 0 };

/* ─────────────────────────────────────────────────────────────────────
 *  Helpers
 * ───────────────────────────────────────────────────────────────────── */

function dateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function log(level: "info" | "debug" | "error" | "warn", msg: string, meta?: Record<string, unknown>) {
  if (LOG_LEVEL === "quiet" && level !== "error") return;
  if (LOG_LEVEL === "info" && level === "debug") return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  // Structured JSON logging — pipe to file or log shipper for production
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

function loadKeypair(path: string): Keypair {
  const abs = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Keypair file not found: ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function persistState() {
  // Simple file-based state persistence for daily rewards tracking
  try {
    const state = { dailyRewards, date: dailyRewardDate };
    writeFileSync(".liquidator-state.json", JSON.stringify(state, null, 2));
  } catch {
    // Non-critical — best-effort persistence
  }
}

function loadState() {
  try {
    if (existsSync(".liquidator-state.json")) {
      const state = JSON.parse(readFileSync(".liquidator-state.json", "utf8"));
      const savedDate = state.date ?? "";
      if (savedDate === dateStr()) {
        dailyRewards = state.dailyRewards ?? 0;
        dailyRewardDate = savedDate;
      } else {
        // New day — reset counter
        dailyRewards = 0;
        dailyRewardDate = dateStr();
      }
    }
  } catch {
    // Start fresh
  }
}

function checkCooldown(loanPda: string): boolean {
  const last = cooldowns.get(loanPda);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return true; // still on cooldown
  }
  return false;
}

function setCooldown(loanPda: string) {
  cooldowns.set(loanPda, Date.now());
  // Prune stale entries periodically
  if (cooldowns.size > 500) {
    const now = Date.now();
    for (const [pda, ts] of cooldowns) {
      if (now - ts > COOLDOWN_MS * 2) cooldowns.delete(pda);
    }
  }
}

function pruneCooldowns() {
  const now = Date.now();
  for (const [pda, ts] of cooldowns) {
    if (now - ts > COOLDOWN_MS * 2) cooldowns.delete(pda);
  }
}

/** Estimate keeper reward in lamports for a given loan. */
async function estimateKeeperReward(candidate: LiquidatableCandidate): Promise<number> {
  try {
    const pool = await freeGet<PoolStateResponse>(BASE, "/api/v1/pool");
    const keeperRewardBps = pool.keeperRewardBps ?? 500; // default 5%
    // collateral_amount is raw token units; for SOL-collateral loans it's in lamports.
    // For non-SOL collateral, we'd need an oracle price. Here we use borrowed_lamports
    // as a conservative proxy for seized value when the collateral isn't SOL.
    const seizedValue = Number(candidate.borrowed_lamports);
    const rewardLamports = Math.floor((seizedValue * keeperRewardBps) / 10_000);
    return rewardLamports;
  } catch (err) {
    log("warn", "Failed to fetch pool state for keeper reward estimate", {
      error: (err as Error).message,
    });
    // Fallback: use a default estimate from borrowed amount
    return Math.floor(Number(candidate.borrowed_lamports) * 0.05); // 5% default
  }
}

/** Check if a liquidation attempt is profitable. */
async function isProfitable(candidate: LiquidatableCandidate): Promise<boolean> {
  const reward = await estimateKeeperReward(candidate);
  const profitable = reward >= GAS_COST + MIN_REWARD;
  if (!profitable) {
    log("info", "Skipping unprofitable loan", {
      loan_id: candidate.loan_id,
      loan_pda: candidate.loan_pda.slice(0, 12),
      estimated_reward_lamports: reward,
      gas_cost_lamports: GAS_COST,
      min_reward_lamports: MIN_REWARD,
      profitable: false,
    });
    counters.skipped++;
  }
  return profitable;
}

/* ─────────────────────────────────────────────────────────────────────
 *  Core tick — run every POLL_MS
 * ───────────────────────────────────────────────────────────────────── */

async function tick() {
  // ── Reset daily rewards at midnight ──────────────────────────────
  const today = dateStr();
  if (dailyRewardDate !== today) {
    log("info", "Daily reward counter reset", {
      previous_date: dailyRewardDate,
      previous_rewards: dailyRewards,
    });
    dailyRewards = 0;
    dailyRewardDate = today;
    persistState();
  }

  // ── Fetch liquidatable loans (free, 8s cache) ────────────────────
  let feed: LiquidatableFeed;
  try {
    feed = await freeGet<LiquidatableFeed>(BASE, "/api/v1/markets/liquidatable", {
      limit: "25",
    });
  } catch (err) {
    log("error", "Failed to fetch liquidatable feed", {
      error: (err as Error).message.slice(0, 300),
    });
    return;
  }

  if (!feed.liquidatable || feed.liquidatable.length === 0) {
    log("debug", "No liquidatable loans available", { total: feed.total ?? 0 });
    return;
  }

  // ── Filter candidates ────────────────────────────────────────────
  const candidates = feed.liquidatable
    .filter((c) => c.seconds_past_due >= MIN_PAST_DUE)
    .filter((c) => !checkCooldown(c.loan_pda));

  if (candidates.length === 0) {
    log("debug", "All candidates filtered out", {
      feed_count: feed.liquidatable.length,
      on_cooldown: feed.liquidatable.length - candidates.length,
      min_past_due: MIN_PAST_DUE,
    });
    return;
  }

  // ── Pick most-past-due ───────────────────────────────────────────
  candidates.sort((a, b) => b.seconds_past_due - a.seconds_past_due);
  const target = candidates[0];

  log("info", "Selected liquidation target", {
    loan_id: target.loan_id,
    loan_pda: target.loan_pda.slice(0, 12),
    seconds_past_due: target.seconds_past_due,
    borrowed_lamports: target.borrowed_lamports,
    collateral_mint: target.collateral_mint,
    collateral_amount: target.collateral_amount,
  });

  // ── Profitability check ──────────────────────────────────────────
  if (!(await isProfitable(target))) {
    setCooldown(target.loan_pda);
    return;
  }

  // ── Mark cooldown BEFORE attempting (prevent duplicate races) ────
  setCooldown(target.loan_pda);
  counters.attempts++;

  // ── Build liquidation tx (paid 0.003 SOL via x402) ───────────────
  let built: PaidCallResult<BuildLiquidateResponse>;
  try {
    built = await paidCall<BuildLiquidateResponse>(
      { rpcUrl: RPC_URL, payer, baseUrl: BASE },
      "POST",
      "/api/v1/agent/build-liquidate",
      {
        body: { keeper: keeperPubkey, loan_pda: target.loan_pda },
      },
    );
  } catch (err) {
    log("error", "Failed to build liquidation tx", {
      loan_pda: target.loan_pda.slice(0, 12),
      error: (err as Error).message.slice(0, 300),
    });
    counters.failures++;
    return;
  }

  const txB64 = built.data.partial_signed_tx_b64;
  if (!txB64) {
    log("error", "build-liquidate returned empty tx", {
      loan_pda: target.loan_pda.slice(0, 12),
      response: JSON.stringify(built.data).slice(0, 200),
    });
    counters.failures++;
    return;
  }

  log("debug", "Build succeeded, signing tx", {
    tx_b64_length: txB64.length,
    paid_lamports: built.paid?.amountLamports ?? "0",
    paid_sig: built.paid?.txSignature ?? "none",
  });

  // ── Sign locally ─────────────────────────────────────────────────
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(txB64, "base64"));
    tx.partialSign(payer);
  } catch (err) {
    log("error", "Failed to decode or sign tx", {
      error: (err as Error).message.slice(0, 200),
    });
    counters.failures++;
    return;
  }

  // ── Submit to network ────────────────────────────────────────────
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    await connection.confirmTransaction(sig, "confirmed");
  } catch (err) {
    log("error", "Failed to submit liquidation tx", {
      loan_pda: target.loan_pda.slice(0, 12),
      error: (err as Error).message.slice(0, 300),
    });
    counters.failures++;
    return;
  }

  // ── Success ──────────────────────────────────────────────────────
  counters.successes++;
  const reward = await estimateKeeperReward(target);
  dailyRewards += reward;
  persistState();

  log("info", "Liquidation successful", {
    loan_id: target.loan_id,
    loan_pda: target.loan_pda.slice(0, 12),
    tx_signature: sig,
    solscan_url: `https://solscan.io/tx/${sig}`,
    keeper_reward_estimated_lamports: reward,
    keeper: keeperPubkey,
    paid_for_build_lamports: built.paid?.amountLamports ?? "0",
    paid_tx_sig: built.paid?.txSignature ?? "none",
    daily_rewards_lamports: dailyRewards,
    total_attempts: counters.attempts,
    total_successes: counters.successes,
    total_failures: counters.failures,
    total_skipped: counters.skipped,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 *  Graceful shutdown
 * ───────────────────────────────────────────────────────────────────── */

let shutdown = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function handleShutdown(signal: string) {
  if (shutdown) return;
  shutdown = true;
  log("info", `Received ${signal}, shutting down gracefully`, {
    total_attempts: counters.attempts,
    total_successes: counters.successes,
    total_failures: counters.failures,
    total_skipped: counters.skipped,
    daily_rewards_lamports: dailyRewards,
  });
  persistState();
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  // Allow in-flight operations to drain
  setTimeout(() => {
    log("info", "Shutdown complete", {});
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  log("error", "Uncaught exception", { error: err.message, stack: err.stack?.slice(0, 500) });
  handleShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", { error: String(reason).slice(0, 300) });
});

/* ─────────────────────────────────────────────────────────────────────
 *  Main entry
 * ───────────────────────────────────────────────────────────────────── */

async function main() {
  // ── Validate required env ────────────────────────────────────────
  if (!PAYER_PATH) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: "X402_PAYER_KEYPAIR is required" }));
    process.exit(1);
  }
  if (!RPC_URL) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: "SOLANA_RPC_URL is required" }));
    process.exit(1);
  }

  // ── Bootstrap ────────────────────────────────────────────────────
  try {
    payer = loadKeypair(PAYER_PATH);
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: `Failed to load keypair: ${(err as Error).message}` }));
    process.exit(1);
  }

  keeperPubkey = payer.publicKey.toBase58();
  connection = new Connection(RPC_URL, "confirmed");
  loadState();

  log("info", "Liquidation bot starting", {
    keeper: keeperPubkey,
    poll_interval_ms: POLL_MS,
    min_past_due_sec: MIN_PAST_DUE,
    min_reward_lamports: MIN_REWARD,
    gas_cost_lamports: GAS_COST,
    base_url: BASE,
    rpc_url: RPC_URL.replace(/https?:\/\//, "").slice(0, 30),
    log_level: LOG_LEVEL,
  });

  // ── Run first tick immediately, then poll ────────────────────────
  await tick().catch((err) => {
    log("error", "Initial tick failed", { error: (err as Error).message.slice(0, 200) });
  });

  intervalHandle = setInterval(async () => {
    if (shutdown) return;
    // Prune stale cooldowns every poll
    pruneCooldowns();
    try {
      await tick();
    } catch (err) {
      log("error", "Tick failed", { error: (err as Error).message.slice(0, 200) });
    }
  }, POLL_MS);
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "fatal", msg: `Fatal startup error: ${err.message}` }));
  process.exit(1);
});
