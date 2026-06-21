import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { enforcePayerMatchesWallet } from "../lib/payer-bind.js";
import { fetchLoanByPda } from "../lib/magpie-program.js";

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
 *
 * VERSION ROUTING (pool-separation-safe): each Magpie loan lives in exactly
 * ONE on-chain program (V1 memecoin / V3 RWA / V4 in-vault). The liquidate
 * instruction, program id, and PDAs differ per version, so this handler
 * resolves the loan's true version FROM THE ACCOUNT OWNER (via the shared
 * pool-separation-safe decoder, same as the loan / liquidatable read
 * surfaces) and forwards `program_version` + `program_id` to the upstream
 * builder. Without this, the upstream defaults to V1 and a V3/V4 loan can't
 * be liquidated through the agent path. Resolving the version here also lets
 * us reject a non-existent / already-resolved loan BEFORE the paid upstream
 * build burns work. The service still holds no keys — the returned tx is
 * unsigned and the keeper signs it locally.
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

  // Security gate: the x402 payer must equal the keeper — you build a
  // liquidate tx naming YOUR wallet as the bounty recipient. Stops a paying
  // caller from constructing liquidations crediting an arbitrary keeper.
  const mismatch = enforcePayerMatchesWallet(c, keeper);
  if (mismatch) return mismatch;

  // Resolve the loan's program version FROM THE ON-CHAIN OWNER so we route
  // the upstream build to the matching program (V1/V3/V4) instead of letting
  // it default to V1. This mirrors how the loan / liquidatable read surfaces
  // derive version, and also lets us fail fast (before the paid upstream
  // build) on a missing / non-active loan.
  let loan;
  try {
    loan = await fetchLoanByPda(new PublicKey(loanPda));
  } catch (err) {
    // RPC blip resolving the version — surface as transient, don't mislabel
    // as "not found". The keeper can retry.
    return c.json(
      { error: "loan_lookup_failed", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }
  if (!loan) {
    // Account doesn't exist or isn't a clean Loan of a known version. A
    // liquidated/closed loan reads as gone here — same shape the SDK expects.
    return c.json(
      { error: "loan_not_found", loan_pda: loanPda },
      404,
    );
  }
  if (loan.status !== "active") {
    // Already repaid or liquidated — nothing to liquidate. Fail before the
    // paid build rather than letting the upstream simulate-fail.
    return c.json(
      { error: "loan_not_active", status: loan.status, loan_pda: loanPda },
      409,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${SITE_API}/api/v1/lp/build-liquidate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Forward the resolved version + program id so the upstream builder
      // targets the correct program (V1/V3/V4) and its version-specific PDAs,
      // instead of hardcoding V1. A version-aware builder uses these; a legacy
      // V1-only builder simply ignores the extra fields (so this is a safe,
      // backwards-compatible addition — V1 loans behave exactly as before).
      body: JSON.stringify({
        keeper,
        loan_pda: loanPda,
        program_version: loan.programVersion,
        program_id: loan.programId,
      }),
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
    console.warn(`[agent-liquidate] non-JSON from site (status ${res.status}):`, text.slice(0, 300));
    data = { error: "site_returned_non_json", status: res.status };
  }
  return c.json(data as Record<string, unknown>, res.status as never);
}
