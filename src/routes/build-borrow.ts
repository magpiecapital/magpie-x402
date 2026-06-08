import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * POST /api/v1/agent/build-borrow
 *
 * The first WRITE-ish endpoint in magpie-x402. Lets an AI agent build
 * an unsigned borrow transaction the agent can then sign with their
 * own wallet + submit. The bot service (magpie-bot) is the source of
 * truth — this route is a thin authenticated proxy.
 *
 * Architecture:
 *
 *   agent ───POST + X-Payment────▶  magpie-x402  ───POST + X-Internal-Token────▶  magpie-bot
 *                                                                                       │
 *                                                                              runs every borrow gate
 *                                                                              (ban registry, anti-exploit,
 *                                                                              TWAP, pool floor, cross-source
 *                                                                              price, RWA-only guard, …)
 *                                                                                       │
 *   agent ◀─partial_signed_tx_b64─  magpie-x402  ◀────tx + summary────────────  builds tx (does NOT sign)
 *
 * The agent then:
 *   1. Signs partial_signed_tx_b64 with their wallet's secret
 *   2. POSTs the signed bytes to magpie.capital's /api/v1/cosign-borrow
 *      (the existing lender-cosign endpoint). That endpoint runs the
 *      final security gates, adds the lender authority signature, and
 *      submits to chain.
 *
 * Body schema:
 *   {
 *     borrower_wallet:    string  (Solana pubkey, base58)
 *     collateral_mint:    string  (Solana mint pubkey, base58)
 *     collateral_amount:  string  (u64 in raw token units, e.g. "1000000" for 1 token at 6 decimals)
 *     tier:               number  (0=express 30% LTV / 2d / 3% fee,
 *                                  1=quick   25% LTV / 3d / 2% fee,
 *                                  2=standard 20% LTV / 7d / 1.5% fee)
 *   }
 *
 * Response:
 *   200 OK { partial_signed_tx_b64, summary, next_step }
 *   400/403/500 with { error, detail?, reason? } on validation / gate / build failure
 *
 * Safety: agents get NO exemptions from the gates the human flow runs.
 * Same per-token caps, same imported-wallet cooldown, same TWAP, same
 * everything. The agent's wallet is the borrower; the agent's wallet
 * signs; the agent's wallet bears all loan obligations.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

export async function buildBorrowHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json(
      { error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" },
      503,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;

  // Validate before forwarding — cheap server-side check, fail fast.
  const borrower = String(b.borrower_wallet ?? "");
  const mint = String(b.collateral_mint ?? "");
  const amount = String(b.collateral_amount ?? "");
  const tier = Number(b.tier);
  if (!borrower || !mint || !amount || ![0, 1, 2].includes(tier)) {
    return c.json(
      {
        error: "missing_or_invalid_params",
        required: { borrower_wallet: "pubkey", collateral_mint: "pubkey", collateral_amount: "u64 string", tier: "0|1|2" },
      },
      400,
    );
  }
  try {
    new PublicKey(borrower);
    new PublicKey(mint);
  } catch {
    return c.json({ error: "invalid_pubkey" }, 400);
  }
  if (!/^\d+$/.test(amount)) return c.json({ error: "amount_must_be_u64_string" }, 400);

  // Forward to bot.
  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/agent/build-borrow`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        borrower_wallet: borrower,
        collateral_mint: mint,
        collateral_amount: amount,
        tier,
      }),
      // 25s timeout — tx build can include RPC calls for blockhash + mint info
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    return c.json(
      { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
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
