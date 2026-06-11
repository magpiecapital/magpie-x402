import type { Context } from "hono";

/**
 * Shared payer-binding helper for x402-paid agent endpoints.
 *
 * Every endpoint that builds a tx for a specific borrower or returns
 * per-wallet data must enforce that the x402 payment was signed by the
 * SAME wallet as the queried/borrower. Without this, anyone who pays
 * 0.001-0.01 SOL can:
 *   - probe arbitrary wallets' loan eligibility (data leak)
 *   - burn the bot's RPC budget running the gauntlet against victim
 *     wallets they don't control
 *   - get the server to construct a tx targeting a victim's loan,
 *     which while unsignable by them still wastes work
 *
 * The x402 middleware sets `c.set("x402", { payer, ... })` after on-chain
 * verification, so the payer pubkey here is cryptographically bound to
 * the SOL transfer that satisfied the payment requirement.
 */

/** Returns the verified payer pubkey from x402 context, or null. */
export function getX402Payer(c: Context): string | null {
  const ctx = c.get("x402") as { payer?: string } | undefined;
  return ctx?.payer ?? null;
}

/**
 * Returns a 403 response if the verified payer doesn't equal the claimed
 * wallet, or null if it matches.
 */
export function enforcePayerMatchesWallet(c: Context, wallet: string) {
  const payer = getX402Payer(c);
  if (!payer) {
    return c.json(
      { error: "missing_payer", detail: "x402 payment context missing payer pubkey" },
      500,
    );
  }
  if (payer !== wallet) {
    return c.json(
      {
        error: "payer_wallet_mismatch",
        detail: "The x402 payment signer must equal the queried/borrower wallet. Per-wallet endpoints are gated on payer identity.",
      },
      403,
    );
  }
  return null;
}
