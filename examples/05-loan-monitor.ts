/**
 * 05 — Loan monitor.
 *
 * Reads every active loan for a wallet (free), computes time-to-due,
 * and prints any that are inside a "warn me" window. A real agent
 * would wire this into a Slack/Discord/SMS bridge — or extend it to
 * automatically build a partial-repay or extend-loan tx via the
 * matching paid endpoints when the warn threshold trips.
 *
 * Free endpoint, no payment needed. Wallet-scoped read.
 *
 * Run:
 *   npx tsx examples/05-loan-monitor.ts <WALLET_PUBKEY>
 *   WARN_HOURS=6 POLL_INTERVAL_MS=60000 npx tsx examples/05-loan-monitor.ts <WALLET>
 */
import { freeGet } from "./lib/x402-client.js";

const wallet = process.argv[2];
if (!wallet) {
  console.error("Usage: npx tsx examples/05-loan-monitor.ts <WALLET_PUBKEY>");
  process.exit(1);
}

const BASE = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const WARN_HOURS = Number(process.env.WARN_HOURS ?? "12");
const INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? "60000");

interface Loan {
  loan_pda: string;
  loan_id: string;
  collateral_mint: string;
  collateral_amount: string;
  borrowed_lamports: string;
  due_at_unix: number;
  status: "active" | "repaid" | "liquidated";
}

async function tick() {
  const res = await freeGet<{ loans: Loan[] }>(BASE, `/api/v1/wallet/${wallet}/loans`, {
    status: "active",
  });
  const now = Math.floor(Date.now() / 1000);
  const warnSeconds = WARN_HOURS * 3600;
  const at = new Date().toISOString();

  if (res.loans.length === 0) {
    console.log(`[${at}] no active loans for ${wallet}`);
    return;
  }

  for (const l of res.loans) {
    const remaining = l.due_at_unix - now;
    const flag = remaining <= 0 ? "PAST_DUE" : remaining <= warnSeconds ? "WARN" : "OK";
    const hrs = (remaining / 3600).toFixed(1);
    console.log(
      `[${at}] ${flag} loan=${l.loan_id} ${(Number(l.borrowed_lamports) / 1e9).toFixed(3)} SOL · ${hrs}h remaining`,
    );

    // Where an agent would auto-take action:
    //   if (flag === "WARN")  → POST /api/v1/agent/build-extend (paid 0.002 SOL)
    //   if (flag === "PAST_DUE") → POST /api/v1/agent/build-repay (paid 0.002 SOL)
    //   then sign + submit
  }
}

await tick();
setInterval(tick, INTERVAL);
console.log(
  `[loan-monitor] watching ${wallet}, warn=${WARN_HOURS}h, poll=${INTERVAL}ms`,
);
