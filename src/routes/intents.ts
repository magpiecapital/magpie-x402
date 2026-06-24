import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { verifyAgentFromContext } from "../lib/agent-envelope.js";

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

const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function unconfigured(c: Context) {
  return c.json(
    { error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" },
    503,
  );
}

/** Pull the payer pubkey out of the x402 context. */
function getPayer(c: Context): string | null {
  const ctx = c.get("x402") as { payer?: string } | undefined;
  return ctx?.payer ?? null;
}

/**
 * Reject the request if the verified payer pubkey doesn't match the
 * claimed wallet. Implements the standing rule: per-user wallet info
 * must never be exposed to a caller who doesn't own that wallet OR
 * doesn't have the wallet's signed authorization. In x402, the payment
 * IS the signed authorization, so payer == wallet is the enforcement.
 */
function enforcePayerMatchesWallet(c: Context, wallet: string) {
  const payer = getPayer(c);
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
        detail: "The x402 payment signer must equal the queried/borrower wallet. Per-wallet data is gated on payer identity.",
      },
      403,
    );
  }
  return null;
}

/**
 * Defensive shallow filter to drop prototype-pollution keys before
 * forwarding an arbitrary object into the bot.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function hasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) return true;
  }
  return false;
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
  catch { parsed = { error: "bot_returned_non_json", status: res.status }; }
  // Refund ONLY on the internal-auth sentinel (401 {error:"unauthorized"} = token
  // mismatch x402↔bot). SECURITY: a bare 403 is a legitimate, correctly-charged
  // business denial (token disabled, missing_owner, …); refunding it would let one
  // payment re-drive the bot unthrottled. 403 / non-sentinel 401 passes through.
  if (res.status === 401 && (parsed as Record<string, unknown>)?.error === "unauthorized") {
    console.error(`[intents] bot internal-auth 401 unauthorized — INTERNAL_API_TOKEN mismatch (x402↔bot). Releasing claim; agent not charged.`);
    return c.json(
      { error: "agent_api_unavailable", detail: "Magpie's agent API is temporarily unavailable (server configuration). Your payment was NOT consumed — please retry shortly." },
      503,
    );
  }
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
  // u64 max is 20 digits — cap so we reject e.g. a 1000-char "amount".
  if (!/^\d{1,20}$/.test(amount)) return c.json({ error: "amount_must_be_u64_string" }, 400);

  // HIGH security gate: x402 payer must equal borrower_wallet. Without
  // this anyone who pays 0.01 SOL can create intents on behalf of any
  // wallet — server-side resources are spent and the response reveals
  // per-wallet eligibility.
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;

  // Reject prototype-pollution keys in condition_params before forwarding.
  if (hasForbiddenKey(condParams)) {
    return c.json(
      { error: "invalid_condition_params", detail: "object keys must not include __proto__, constructor, or prototype" },
      400,
    );
  }

  // expires_in_seconds: optional, but if provided must be a positive
  // finite integer ≤ 30 days. Bot enforces this too but the edge check
  // means a hostile client can't spam the bot with absurd values that
  // get logged + rejected. Undefined → bot picks the default (86400).
  let expires: number | undefined = undefined;
  if (b.expires_in_seconds !== undefined && b.expires_in_seconds !== null) {
    const n = Number(b.expires_in_seconds);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 30 * 24 * 60 * 60) {
      return c.json(
        { error: "invalid_expires_in_seconds", detail: "must be a positive integer ≤ 2592000 (30 days)" },
        400,
      );
    }
    expires = n;
  }

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
      expires_in_seconds: expires,
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

  // We can't validate payer == intent-owner locally because the intent
  // wallet isn't in the request — we'd have to ask the bot first. Forward
  // the verified payer pubkey to the bot via X-Magpie-Payer; the bot is
  // expected to reject if intent.borrower_wallet != payer (see bot-side
  // agent-intents.js for enforcement).
  const payer = getPayer(c);
  if (!payer) {
    return c.json(
      { error: "missing_payer", detail: "x402 payment context missing payer pubkey" },
      500,
    );
  }
  return forward(c, `${BOT_API}/api/v1/agent/intent?id=${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { "X-Magpie-Payer": payer },
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

  // AUTHZ (was IDOR): intent-cancel is a per-resource destructive write, and the
  // intent id is paid-but-leakable (it appears in list/poll/webhook/create
  // responses). Require an Ed25519-signed envelope — action "intent-cancel/v1",
  // OrderId bound to this intent id, From == signer, fresh — exactly like the
  // hardened limit-close-cancel route. Forward the VERIFIED signer as ?owner=
  // so the bot scopes the UPDATE to intent.borrower_wallet == signer. Without
  // this, anyone could cancel any agent's pending intent and forfeit its fee.
  const verified = verifyAgentFromContext(c, "intent-cancel/v1", { expectedOrderId: id });
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);

  return forward(
    c,
    `${BOT_API}/api/v1/agent/intent?id=${encodeURIComponent(id)}&owner=${encodeURIComponent(verified.signer)}`,
    { method: "DELETE" },
  );
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

  // HIGH security gate: payer must equal queried wallet. Without this
  // anyone who pays 0.001 SOL can enumerate any wallet's pending intents.
  const mismatch = enforcePayerMatchesWallet(c, wallet);
  if (mismatch) return mismatch;

  return forward(c, `${BOT_API}/api/v1/agent/intents?wallet=${encodeURIComponent(wallet)}`, {
    method: "GET",
  });
}
