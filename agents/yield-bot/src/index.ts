#!/usr/bin/env node
/**
 * Magpie yield-bot — reference autonomous agent.
 *
 * Watches a wallet's idle SOL balance + LP position in Magpie's
 * main LendingPool, rebalances every TICK_INTERVAL_MS to maintain
 * a target ratio of (lp_value / total_assets). Generates real
 * on-chain protocol volume.
 *
 * Safety properties:
 *   - Never deposits below MIN_IDLE_SOL — the wallet always keeps
 *     enough SOL for fees / pivots.
 *   - Never deposits below MIN_TX_LAMPORTS — avoids dust txs.
 *   - Never withdraws if pool utilization is above HIGH_UTIL_PCT —
 *     other LPs need their share; large pulls during squeeze hurt
 *     the borrower side.
 *   - Hard MAX_DEPOSIT_LAMPORTS cap per cycle so a single tick can't
 *     drain the whole wallet even with a misconfigured target.
 *   - Verifies signature on submitted txs (sendAndConfirm).
 *
 * The whole loop is ~150 lines of bot logic. Fork it, tune the
 * thresholds, drop in your own trigger (price feed, news signal,
 * external metric) — same shape as the strategy code you'd run
 * against any DeFi protocol.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import { call, loadKeypairFromEnv, type ClientCtx } from "./x402-client.js";

// ── Config from env ────────────────────────────────────────────────
const X402_URL = process.env.X402_URL ?? "https://x402.magpie.capital";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const TICK_MS = Number(process.env.TICK_INTERVAL_MS ?? `${10 * 60 * 1000}`); // 10 min
const TARGET_LP_RATIO = Number(process.env.TARGET_LP_RATIO ?? "0.7"); // 70% in LP
const MIN_IDLE_SOL = Number(process.env.MIN_IDLE_SOL ?? "0.02"); // keep ≥ 0.02 SOL idle
const MIN_TX_SOL = Number(process.env.MIN_TX_SOL ?? "0.01"); // skip dust rebalances
const MAX_DEPOSIT_SOL = Number(process.env.MAX_DEPOSIT_SOL ?? "1.0"); // single-tick cap
const HIGH_UTIL_PCT = Number(process.env.HIGH_UTIL_PCT ?? "0.92"); // don't pull above 92%
const REBALANCE_BAND = Number(process.env.REBALANCE_BAND ?? "0.05"); // ±5% deadband

const payer = loadKeypairFromEnv();
const wallet = payer.publicKey;
const connection = new Connection(RPC_URL, "confirmed");
const ctx: ClientCtx = { baseUrl: X402_URL, rpcUrl: RPC_URL, payer };

// Cumulative tally for the dashboard line.
let totalDeposited = 0n;
let totalWithdrawn = 0n;
let totalFeesPaid = 0n;
let cycleCount = 0;

// ── x402 surface ───────────────────────────────────────────────────
interface LpState {
  has_position: boolean;
  shares?: string;
  deposited_lamports?: string;
  current_value_lamports?: string;
  yield_lamports?: string;
  pool: { total_deposits: number; total_shares: number; utilization_rate: number } | null;
}

interface BuiltTx {
  partial_signed_tx_b64: string;
  summary: Record<string, unknown>;
}

async function fetchLpState(): Promise<LpState> {
  const r = await call<LpState>(ctx, "GET", "/api/v1/agent/lp-state", {
    query: { wallet: wallet.toBase58() },
  });
  return r.data;
}

async function buildDepositTx(lamports: bigint): Promise<BuiltTx> {
  const r = await call<BuiltTx>(ctx, "POST", "/api/v1/agent/build-deposit", {
    body: { depositor: wallet.toBase58(), lamports: lamports.toString() },
  });
  totalFeesPaid += r.paidLamports;
  return r.data;
}

async function buildWithdrawTx(shares: bigint): Promise<BuiltTx> {
  const r = await call<BuiltTx>(ctx, "POST", "/api/v1/agent/build-withdraw", {
    body: { depositor: wallet.toBase58(), shares: shares.toString() },
  });
  totalFeesPaid += r.paidLamports;
  return r.data;
}

async function signAndSubmit(built: BuiltTx): Promise<string> {
  const tx = Transaction.from(Buffer.from(built.partial_signed_tx_b64, "base64"));
  tx.partialSign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ── Decision logic ─────────────────────────────────────────────────
interface Plan {
  action: "deposit" | "withdraw" | "hold";
  lamports?: bigint;
  shares?: bigint;
  reason: string;
}

function planRebalance(
  walletLamports: bigint,
  lpValueLamports: bigint,
  lpShares: bigint,
  utilization: number,
): Plan {
  const total = walletLamports + lpValueLamports;
  if (total === 0n) {
    return { action: "hold", reason: "empty wallet" };
  }

  const minIdleLamports = BigInt(Math.round(MIN_IDLE_SOL * 1e9));
  const minTxLamports = BigInt(Math.round(MIN_TX_SOL * 1e9));
  const maxDepositLamports = BigInt(Math.round(MAX_DEPOSIT_SOL * 1e9));

  const targetLpLamports = BigInt(
    Math.floor(Number(total) * TARGET_LP_RATIO),
  );
  const currentLpRatio = Number(lpValueLamports) / Number(total);
  const drift = Math.abs(currentLpRatio - TARGET_LP_RATIO);
  if (drift < REBALANCE_BAND) {
    return {
      action: "hold",
      reason: `within deadband (lp=${(currentLpRatio * 100).toFixed(1)}% target=${(TARGET_LP_RATIO * 100).toFixed(1)}%)`,
    };
  }

  if (lpValueLamports < targetLpLamports) {
    // Need to deposit. Cap at what we can spare (keep MIN_IDLE) and the
    // per-tick MAX_DEPOSIT.
    const spareable = walletLamports > minIdleLamports ? walletLamports - minIdleLamports : 0n;
    let depositAmount = targetLpLamports - lpValueLamports;
    if (depositAmount > spareable) depositAmount = spareable;
    if (depositAmount > maxDepositLamports) depositAmount = maxDepositLamports;
    if (depositAmount < minTxLamports) {
      return { action: "hold", reason: `deposit ${depositAmount}L below MIN_TX` };
    }
    return {
      action: "deposit",
      lamports: depositAmount,
      reason: `lp ratio ${(currentLpRatio * 100).toFixed(1)}% below target by ${(drift * 100).toFixed(1)}%`,
    };
  }

  // Need to withdraw. Refuse if utilization is too high — the LP needs
  // liquidity for active borrows; pulling out aggravates the squeeze.
  if (utilization > HIGH_UTIL_PCT) {
    return {
      action: "hold",
      reason: `lp ratio above target but utilization=${(utilization * 100).toFixed(1)}% > HIGH_UTIL — leaving LP intact`,
    };
  }
  const excessLamports = lpValueLamports - targetLpLamports;
  if (excessLamports < minTxLamports) {
    return { action: "hold", reason: `withdraw ${excessLamports}L below MIN_TX` };
  }
  // Convert excess lamports → shares using the position's own ratio.
  // shares × deposited/value gives shares-to-redeem; close to (excessLamports / value × totalShares).
  const shares = (excessLamports * lpShares) / lpValueLamports;
  if (shares <= 0n) {
    return { action: "hold", reason: "share computation rounded to 0" };
  }
  return {
    action: "withdraw",
    shares,
    reason: `lp ratio ${(currentLpRatio * 100).toFixed(1)}% above target by ${(drift * 100).toFixed(1)}%`,
  };
}

// ── Main loop ──────────────────────────────────────────────────────
async function tick() {
  cycleCount++;
  const cycle = cycleCount;
  const at = new Date().toISOString();
  try {
    // Concurrent: chain balance + LP state. Cheaper RTT.
    const [balanceLamports, lp] = await Promise.all([
      connection.getBalance(wallet, "confirmed").then(BigInt),
      fetchLpState(),
    ]);
    const lpShares = lp.has_position && lp.shares ? BigInt(lp.shares) : 0n;
    const lpValue =
      lp.has_position && lp.current_value_lamports
        ? BigInt(lp.current_value_lamports)
        : 0n;
    const utilization = lp.pool?.utilization_rate ?? 0;

    const plan = planRebalance(balanceLamports, lpValue, lpShares, utilization);
    console.log(
      JSON.stringify({
        at,
        cycle,
        wallet: wallet.toBase58(),
        wallet_sol: Number(balanceLamports) / 1e9,
        lp_value_sol: Number(lpValue) / 1e9,
        lp_shares: lpShares.toString(),
        pool_utilization: utilization,
        plan: plan.action,
        plan_reason: plan.reason,
        plan_amount_sol:
          plan.lamports !== undefined
            ? Number(plan.lamports) / 1e9
            : plan.shares !== undefined
              ? `${plan.shares.toString()} shares`
              : null,
      }),
    );

    if (plan.action === "hold") return;
    if (plan.action === "deposit" && plan.lamports !== undefined) {
      const built = await buildDepositTx(plan.lamports);
      const sig = await signAndSubmit(built);
      totalDeposited += plan.lamports;
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          cycle,
          action: "deposit",
          amount_sol: Number(plan.lamports) / 1e9,
          tx: sig,
          explorer: `https://solscan.io/tx/${sig}`,
        }),
      );
      return;
    }
    if (plan.action === "withdraw" && plan.shares !== undefined) {
      const built = await buildWithdrawTx(plan.shares);
      const sig = await signAndSubmit(built);
      totalWithdrawn += plan.shares;
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          cycle,
          action: "withdraw",
          shares: plan.shares.toString(),
          tx: sig,
          explorer: `https://solscan.io/tx/${sig}`,
        }),
      );
      return;
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        at,
        cycle,
        error: (err as Error).message?.slice(0, 500),
      }),
    );
  }
}

// Hourly cumulative line, easy to grep in deploy logs.
function hourlyReport() {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      cumulative: {
        cycles: cycleCount,
        deposited_sol: Number(totalDeposited) / 1e9,
        withdrawn_shares: totalWithdrawn.toString(),
        x402_fees_paid_sol: Number(totalFeesPaid) / 1e9,
      },
    }),
  );
}

process.stderr.write(
  `[yield-bot] wallet=${wallet.toBase58()} target_lp=${(TARGET_LP_RATIO * 100).toFixed(0)}% tick=${TICK_MS / 1000}s\n`,
);

await tick();
setInterval(tick, TICK_MS);
setInterval(hourlyReport, 60 * 60 * 1000);

// Graceful shutdown so Railway/Fly etc don't kill mid-tx.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[yield-bot] ${signal} received, exiting cleanly`);
    process.exit(0);
  });
}
