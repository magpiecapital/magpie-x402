/**
 * 08 — Liquidation keeper (full auto loop).
 *
 * Polls /api/v1/markets/liquidatable (free), picks the most-past-due
 * candidate, calls /api/v1/agent/build-liquidate (paid 0.003 SOL),
 * signs locally, submits.
 *
 * Closes the liquidation loop end-to-end — the bot we ship to prove
 * the API works for a real revenue-generating agent strategy.
 *
 * Economics:
 *   - Each successful liquidation earns the keeper a share of the
 *     seized collateral (keeper_reward_bps of the position).
 *   - Cost per attempt: 0.003 SOL (x402 build) + ~5000 lamports
 *     network fee + first-time-only ~0.002 SOL ATA rent for the
 *     keeper's collateral account.
 *   - The keeper bounty is paid in COLLATERAL TOKEN, not SOL. The
 *     keeper bot leaves the seized token in the ATA; the operator
 *     swaps to SOL externally (or you swap on Jupiter and roll into
 *     more bot capital).
 *
 * Run:
 *   X402_PAYER_KEYPAIR=~/.config/solana/id.json \
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx examples/08-liquidation-keeper.ts
 *
 * Tune via env:
 *   POLL_INTERVAL_MS  default 8000
 *   MIN_PAST_DUE_SEC  refuse to attempt anything not past due by at
 *                     least this much (avoids racing other keepers on
 *                     borderline cases). default 0.
 */
import { resolve } from "node:path";
import { Connection, Transaction } from "@solana/web3.js";
import { loadKeypairFromFile, paidCall, freeGet } from "./lib/x402-client.js";

const baseUrl = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const payerPath = process.env.X402_PAYER_KEYPAIR;
if (!payerPath) {
  console.error("Set X402_PAYER_KEYPAIR to a keypair JSON file path");
  process.exit(1);
}
const payer = loadKeypairFromFile(resolve(payerPath.replace(/^~/, process.env.HOME || "")));
const keeper = payer.publicKey.toBase58();
const connection = new Connection(rpcUrl, "confirmed");

const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? "8000");
const MIN_PAST_DUE = Number(process.env.MIN_PAST_DUE_SEC ?? "0");

interface Candidate {
  loan_pda: string;
  loan_id: string;
  borrower: string;
  collateral_mint: string;
  collateral_amount: string;
  borrowed_lamports: string;
  due_at_unix: number;
  seconds_past_due: number;
}

const seen = new Set<string>(); // loan_pdas attempted in this run, to avoid retry storms

async function tick() {
  const at = new Date().toISOString();
  let feed;
  try {
    feed = await freeGet<{ liquidatable: Candidate[]; total: number }>(
      baseUrl,
      "/api/v1/markets/liquidatable",
      { limit: "25" },
    );
  } catch (err) {
    console.error(`[${at}] feed error: ${(err as Error).message.slice(0, 200)}`);
    return;
  }

  const candidates = feed.liquidatable
    .filter((c) => c.seconds_past_due >= MIN_PAST_DUE)
    .filter((c) => !seen.has(c.loan_pda));

  if (candidates.length === 0) {
    console.log(`[${at}] no eligible candidates (feed=${feed.liquidatable.length}, attempted=${seen.size})`);
    return;
  }

  // Most-past-due first — they're the highest-value targets and
  // furthest into the program's grace before another keeper races.
  candidates.sort((a, b) => b.seconds_past_due - a.seconds_past_due);
  const target = candidates[0];
  seen.add(target.loan_pda);

  console.log(
    `[${at}] attempting loan_id=${target.loan_id} pda=${target.loan_pda.slice(0, 8)}… ` +
      `${target.seconds_past_due}s past due, ` +
      `${(Number(target.borrowed_lamports) / 1e9).toFixed(3)} SOL borrowed`,
  );

  try {
    const built = await paidCall<{
      partial_signed_tx_b64: string;
      summary: Record<string, unknown>;
      keeper_reward_info: { note: string };
    }>({ rpcUrl, payer, baseUrl }, "POST", "/api/v1/agent/build-liquidate", {
      body: { keeper, loan_pda: target.loan_pda },
    });
    console.log("  build summary:", built.data.summary);

    const tx = Transaction.from(
      Buffer.from(built.data.partial_signed_tx_b64, "base64"),
    );
    tx.partialSign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`  ✓ liquidated. tx: https://solscan.io/tx/${sig}`);
  } catch (err) {
    console.error(`  ✗ failed: ${(err as Error).message.slice(0, 200)}`);
  }
}

console.error(`[keeper] keeper=${keeper} poll=${POLL_MS}ms min_past_due=${MIN_PAST_DUE}s`);
await tick();
setInterval(tick, POLL_MS);
