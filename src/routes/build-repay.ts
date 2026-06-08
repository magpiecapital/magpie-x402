import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * POST /api/v1/agent/build-repay
 *
 * Build an unsigned repay tx. Agent signs + submits via standard
 * Solana RPC (no cosign needed — repay_loan doesn't require lender
 * authority).
 *
 * Body: { borrower_wallet, loan_pda }
 *
 * Same authenticated-proxy pattern as build-borrow: x402 verifies
 * payment, forwards to bot with INTERNAL_API_TOKEN. Bot verifies
 * on-chain borrower match, refuses suspended loans, builds tx.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

export async function buildRepayHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json({ error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const borrower = String(b.borrower_wallet ?? "");
  const loanPda = String(b.loan_pda ?? "");
  if (!borrower || !loanPda) {
    return c.json(
      { error: "missing_or_invalid_params", required: { borrower_wallet: "pubkey", loan_pda: "pubkey" } },
      400,
    );
  }
  try {
    new PublicKey(borrower);
    new PublicKey(loanPda);
  } catch {
    return c.json({ error: "invalid_pubkey" }, 400);
  }

  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/agent/build-repay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN },
      body: JSON.stringify({ borrower_wallet: borrower, loan_pda: loanPda }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return c.json({ error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: "bot_returned_non_json", raw: text.slice(0, 500) };
  }
  return c.json(parsed as Record<string, unknown>, res.status as never);
}
