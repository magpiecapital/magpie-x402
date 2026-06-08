import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * GET /api/v1/agent/credit-attest?wallet=<pubkey>
 *
 * Pay-per-call ed25519-signed credit attestation. Returns the wallet's
 * Magpie credit score WITH a signature from the lender authority key.
 * Any consumer can verify cryptographically — no need to trust this
 * API.
 *
 * Use-cases for agents:
 *   - Present yourself to OTHER lending protocols as creditworthy
 *   - Cryptographically prove repayment history in a transaction memo
 *   - Build trust signals into your own multi-step DeFi flows
 *
 * The attestation has a 7-day TTL embedded in the signed payload.
 * After expiry, fetch a fresh one.
 *
 * Implementation: thin proxy to magpie-bot's
 * /api/v1/agent/credit-attest, which holds the lender signing key.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";

export async function creditAttestHandler(c: Context) {
  const wallet = c.req.query("wallet");
  if (!wallet) return c.json({ error: "wallet query param required" }, 400);
  try {
    new PublicKey(wallet);
  } catch {
    return c.json({ error: "invalid wallet pubkey" }, 400);
  }
  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/agent/credit-attest?wallet=${wallet}`, {
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return c.json({ error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  const body = await res.json();
  return c.json(body as Record<string, unknown>, res.status as never, {
    "Cache-Control": "public, s-maxage=60",
  });
}
