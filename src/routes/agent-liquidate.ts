import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * POST /api/v1/agent/build-liquidate
 *
 * Builds an unsigned liquidate-loan transaction for an active,
 * past-due Magpie loan. The keeper (the agent's signer) receives
 * the keeper_reward_bps share of the seized collateral; the rest
 * routes to the lender authority for pool recovery.
 *
 * Body:
 *   { keeper: <pubkey>, loan_pda: <pubkey> }
 *
 * The two free endpoints that feed this:
 *   - GET /api/v1/markets/liquidatable — enumerate eligible loans
 *   - GET /api/v1/loan/{loan_id}       — re-check a specific loan's
 *                                        status before paying for a build
 *
 * Priced at 0.003 SOL — slightly above the standard 0.002 SOL build
 * builders because liquidate-loan does extra RPC work (fetches loan
 * account + collateral mint info to detect token program) and the
 * payoff for a successful liquidation is materially higher than a
 * deposit/withdraw.
 */
const SITE_API = process.env.MAGPIE_SITE_API || "https://www.magpie.capital";

export async function buildLiquidateHandler(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const keeper = String(b.keeper ?? "");
  const loanPda = String(b.loan_pda ?? "");

  if (!keeper || !loanPda) {
    return c.json(
      {
        error: "missing_params",
        required: { keeper: "pubkey", loan_pda: "pubkey" },
      },
      400,
    );
  }
  try {
    new PublicKey(keeper);
  } catch {
    return c.json({ error: "invalid_keeper_pubkey" }, 400);
  }
  try {
    new PublicKey(loanPda);
  } catch {
    return c.json({ error: "invalid_loan_pda" }, 400);
  }

  let res: Response;
  try {
    res = await fetch(`${SITE_API}/api/v1/lp/build-liquidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keeper, loan_pda: loanPda }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return c.json(
      { error: "site_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: "site_returned_non_json", raw: text.slice(0, 500) };
  }
  return c.json(data as Record<string, unknown>, res.status as never);
}
