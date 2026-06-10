/**
 * 02 — Liquidation bot scaffold.
 *
 * Polls GET /api/v1/markets/liquidatable (free) every N seconds, surfaces
 * past-due loans, and prints a ready-to-execute liquidation plan for the
 * top candidate. Wire the printed PDA + amount into your own Anchor client
 * to call the on-chain `liquidate_loan` instruction — that step is
 * permissionless and rewards the caller.
 *
 * Two-stage discovery so you can pre-position:
 *   - `within_seconds=0` (default) — already past due, race other liquidators
 *   - `within_seconds=600` — due in next 10min, time to warm a connection
 *
 * Run:
 *   npx tsx examples/02-liquidation-bot.ts
 *   POLL_INTERVAL_MS=3000 LOOKAHEAD_SECONDS=300 npx tsx examples/02-liquidation-bot.ts
 */
import { freeGet } from "./lib/x402-client.js";

const BASE = process.env.X402_BASE_URL ?? "https://x402.magpie.capital";
const INTERVAL = Number(process.env.POLL_INTERVAL_MS ?? "8000");
const LOOKAHEAD = String(process.env.LOOKAHEAD_SECONDS ?? "0");
const LIMIT = String(process.env.LIQUIDATABLE_LIMIT ?? "25");

interface Liquidatable {
  loan_pda: string;
  loan_id: string;
  borrower: string;
  collateral_mint: string;
  collateral_amount: string;
  borrowed_lamports: string;
  due_at_unix: number;
  seconds_past_due: number;
}

async function tick() {
  const res = await freeGet<{ liquidatable: Liquidatable[]; total: number }>(
    BASE,
    "/api/v1/markets/liquidatable",
    { within_seconds: LOOKAHEAD, limit: LIMIT },
  );
  const items = res.liquidatable;
  const now = new Date().toISOString();

  if (items.length === 0) {
    console.log(`[${now}] no liquidatable loans (lookahead ${LOOKAHEAD}s)`);
    return;
  }

  const top = items[0];
  const dueRel =
    top.seconds_past_due > 0
      ? `${top.seconds_past_due}s past due`
      : `due in ${-top.seconds_past_due}s`;

  console.log(
    `[${now}] ${items.length} candidate(s). Top: loan_id=${top.loan_id} ${dueRel}`,
  );
  console.log(`    pda          ${top.loan_pda}`);
  console.log(`    borrower     ${top.borrower}`);
  console.log(`    collateral   ${top.collateral_amount} of ${top.collateral_mint}`);
  console.log(`    borrowed     ${(Number(top.borrowed_lamports) / 1e9).toFixed(4)} SOL`);
  console.log(
    `    next step    call \`liquidate_loan\` on the Magpie program with loan_pda=${top.loan_pda}`,
  );
}

await tick();
setInterval(tick, INTERVAL);
console.log(`[liquidation-bot] polling every ${INTERVAL}ms, lookahead=${LOOKAHEAD}s`);
