import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * Conditional borrow intents — "limit orders for borrows".
 *
 * The wedge that makes Magpie the first agent-native lending protocol.
 * Agents post an intent specifying when to execute a borrow. The bot
 * watches conditions; when matched, it builds the unsigned tx; agent
 * polls, signs, and submits.
 *
 *   POST   /api/v1/agent/intent          → create   (paid 0.01 SOL)
 *   GET    /api/v1/agent/intent?id=...   → poll     (paid 0.0005 SOL)
 *   DELETE /api/v1/agent/intent?id=...   → cancel   (free)
 *   GET    /api/v1/agent/intents?wallet= → list     (paid 0.001 SOL)
 *
 * Intent creation is priced higher because it reserves a slot in the
 * watcher's polling pool — the server runs the gauntlet repeatedly for
 * the intent's TTL. One-time payment buys all watching + the final
 * build. Polling is priced low so agents can check often without
 * cost concerns.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function unconfigured(c: Context) {
  return c.json(
    { error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" },
    503,
  );
}

async function forward(c: Context, url: string, init: RequestInit) {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        "X-Internal-Token": INTERNAL_TOKEN,
      },
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
  try { parsed = JSON.parse(text); }
  catch { parsed = { error: "bot_returned_non_json", raw: text.slice(0, 500) }; }
  return c.json(parsed as Record<string, unknown>, res.status as never);
}

/**
 * POST /api/v1/agent/intent  — create a conditional borrow intent.
 *
 * Body: {
 *   borrower_wallet,
 *   collateral_mint,
 *   collateral_amount,
 *   tier,
 *   condition_type:    "price_above" | "price_below" | "time_after" | "pool_liq_above",
 *   condition_params:  { … },
 *   expires_in_seconds?: number (default 86400, max 30 days)
 * }
 */
export async function createIntentHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const b = (body ?? {}) as Record<string, unknown>;

  const borrower = String(b.borrower_wallet ?? "");
  const mint = String(b.collateral_mint ?? "");
  const amount = String(b.collateral_amount ?? "");
  const tier = Number(b.tier);
  const condType = String(b.condition_type ?? "");
  const condParams = b.condition_params;

  if (!borrower || !mint || !amount || ![0, 1, 2].includes(tier) || !condType || !condParams) {
    return c.json(
      {
        error: "missing_or_invalid_params",
        required: {
          borrower_wallet: "pubkey",
          collateral_mint: "pubkey",
          collateral_amount: "u64 string",
          tier: "0|1|2",
          condition_type: "price_above|price_below|time_after|pool_liq_above",
          condition_params: "object",
        },
      },
      400,
    );
  }
  try { new PublicKey(borrower); new PublicKey(mint); }
  catch { return c.json({ error: "invalid_pubkey" }, 400); }
  if (!/^\d+$/.test(amount)) return c.json({ error: "amount_must_be_u64_string" }, 400);

  return forward(c, `${BOT_API}/api/v1/agent/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      borrower_wallet: borrower,
      collateral_mint: mint,
      collateral_amount: amount,
      tier,
      condition_type: condType,
      condition_params: condParams,
      expires_in_seconds: b.expires_in_seconds,
    }),
  });
}

/**
 * GET /api/v1/agent/intent?id=...  — poll status.
 *
 * When status='matched', the response includes partial_signed_tx_b64
 * ready for the agent to sign + submit via /api/v1/cosign-borrow.
 */
export async function getIntentHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(id)) return c.json({ error: "invalid_intent_id" }, 400);

  return forward(c, `${BOT_API}/api/v1/agent/intent?id=${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

/**
 * DELETE /api/v1/agent/intent?id=...  — cancel a pending intent.
 * Free — we don't charge agents to clean up after themselves.
 */
export async function cancelIntentHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id) return c.json({ error: "missing_id" }, 400);
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(id)) return c.json({ error: "invalid_intent_id" }, 400);

  return forward(c, `${BOT_API}/api/v1/agent/intent?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * GET /api/v1/agent/intents?wallet=...  — list all intents for a wallet.
 */
export async function listIntentsHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const wallet = c.req.query("wallet");
  if (!wallet) return c.json({ error: "missing_wallet" }, 400);
  try { new PublicKey(wallet); }
  catch { return c.json({ error: "invalid_pubkey" }, 400); }

  return forward(c, `${BOT_API}/api/v1/agent/intents?wallet=${encodeURIComponent(wallet)}`, {
    method: "GET",
  });
}
