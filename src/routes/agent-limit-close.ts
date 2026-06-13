import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";

/**
 * Agent-mediated limit-close-and-sell — x402 routes.
 *
 *   POST   /api/v1/agent/limit-close              → arm    (paid 0.001 SOL)
 *   GET    /api/v1/agent/limit-close?id=...       → read   (free, agent-scoped)
 *   GET    /api/v1/agent/limit-close/list[?...]   → list   (free, agent-scoped)
 *   DELETE /api/v1/agent/limit-close?id=...       → cancel (free, agent-scoped)
 *
 * Security model — what's different from intents.ts:
 *
 *   For intent CREATE, the x402 payer IS the borrower wallet — the
 *   borrower is paying for their own conditional borrow.
 *
 *   For limit-close, the x402 payer IS the AGENT, NOT the borrower.
 *   The borrower has pre-authorized this agent off-band (via the TG
 *   command /agent-authorize <agent_pubkey> limit_close [bounds]).
 *   At arm time the bot looks up agent_delegations(user_wallet,
 *   agent_pubkey, action='limit_close') and rejects if no active
 *   grant covers the order.
 *
 *   So the enforcement is:
 *     - x402 payer pubkey → bot receives this as agent_pubkey
 *     - The agent NAMES the borrower wallet in the request body
 *     - The BOT decides whether (borrower, agent) has an active
 *       delegation. The x402 service cannot make that decision
 *       (the delegation table lives in the bot's DB).
 *
 * For the read/list/cancel endpoints we keep them FREE and scope
 * results to the calling agent's pubkey. That sidesteps "agent A
 * paying 0.0005 SOL to enumerate agent B's orders." Agents pay once
 * to arm; they shouldn't pay to manage their own pipeline.
 *
 *   Cancel-after-firing: the bot's UPDATE clause WHERE status='armed'
 *   makes a too-late cancel a no-op (returns 'not_cancellable_or_not_found').
 *   The engine flips status to 'firing' BEFORE any on-chain work, so
 *   any cancel that wins the race actually prevents execution.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

const VALID_TRIGGER_KINDS = new Set(["mc_usd", "price_usd", "price_sol"]);
const VALID_DESTINATIONS = new Set(["sol", "usdc"]);
// 2026-06-13: bot PR #121 added trigger_direction to the internal arm
// endpoint so agents can arm stop-loss orders (was TP-only). This route
// now passes the field through. Default 'above' preserves back-compat
// for any agent that already integrated against the TP-only surface.
const VALID_TRIGGER_DIRECTIONS = new Set(["above", "below"]);

function unconfigured(c: Context) {
  return c.json(
    { error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" },
    503,
  );
}

function getPayer(c: Context): string | null {
  const ctx = c.get("x402") as { payer?: string; signature?: string } | undefined;
  return ctx?.payer ?? null;
}

function getX402Sig(c: Context): string | null {
  const ctx = c.get("x402") as { payer?: string; signature?: string } | undefined;
  return ctx?.signature ?? null;
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
 * POST /api/v1/agent/limit-close — arm a new agent-managed limit order.
 *
 * Body: {
 *   user_wallet:          <pubkey>            // the borrower's custodial wallet
 *   loan_id:              <integer-string>    // on-chain loan id (loans.loan_id)
 *   trigger_kind:         'mc_usd'|'price_usd'|'price_sol'
 *   trigger_value_micro:  <decimal-string>    // 1e6 USD micros or 1e9 SOL lamports
 *   slippage_bps:         <integer>           // 10..1000
 *   sell_destination?:    'sol'|'usdc'        // default 'sol'
 *   expires_at?:          <ISO string>        // optional auto-cancel
 *   auto_escalate_slippage?: boolean          // default false
 * }
 *
 * auto_escalate_slippage: when true, the engine bumps slippage_bps
 * along a 1.5x curve on each proceeds-insufficient revert, never
 * exceeding the borrower's delegation cap (max_slippage_bps in
 * agent_delegations, snapshotted at arm time). This is the agent's
 * opt-in for "actually make this execute" semantics. When false (the
 * default), slippage_bps is exact — the engine reverts forever at
 * the armed value until liquidity matches or MAX_FAILURE_COUNT trips.
 */
export async function armLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);

  // The agent identity is the verified x402 payer pubkey. We pulled
  // it out of the on-chain payment, the agent did not assert it.
  const agentPubkey = getPayer(c);
  const x402Sig = getX402Sig(c);
  if (!agentPubkey) {
    return c.json(
      { error: "missing_payer", detail: "x402 payment context missing payer pubkey" },
      500,
    );
  }

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const b = (body ?? {}) as Record<string, unknown>;

  const userWallet         = String(b.user_wallet ?? "");
  const loanId             = String(b.loan_id ?? "");
  const triggerKind        = String(b.trigger_kind ?? "");
  // Default 'above' (take-profit) — keeps existing agents working
  // unchanged. Agents wanting stop-loss pass `"trigger_direction": "below"`.
  const triggerDirection   = String(b.trigger_direction ?? "above");
  const triggerValueMicro  = String(b.trigger_value_micro ?? "");
  const slippageBpsRaw     = Number(b.slippage_bps);
  const sellDestination    = String(b.sell_destination ?? "sol").toLowerCase();
  const expiresAt          = b.expires_at == null ? null : String(b.expires_at);
  // Strict boolean coercion — only the literal true value enables
  // auto-escalation. Strings like "true" or "1" are deliberately
  // ignored to avoid accidental opt-in from clients that JSON-encode
  // booleans loosely.
  const autoEscalate       = b.auto_escalate_slippage === true;

  if (!userWallet || !loanId || !triggerKind || !triggerValueMicro) {
    return c.json(
      {
        error: "missing_params",
        required: {
          user_wallet: "borrower custodial wallet pubkey",
          loan_id: "on-chain loan id",
          trigger_kind: "mc_usd|price_usd|price_sol",
          trigger_value_micro: "decimal string (1e6 USD micros or 1e9 SOL lamports)",
          slippage_bps: "integer 10..1000",
        },
        optional: {
          sell_destination: "sol|usdc, default sol",
          expires_at: "ISO timestamp",
          trigger_direction: "'above' (take-profit, default) | 'below' (stop-loss)",
          auto_escalate_slippage: "boolean, default false — let the engine widen toward the delegation's max_slippage_bps if first attempt would revert",
        },
      },
      400,
    );
  }

  // Borrower wallet sanity — full base58 + curve check via PublicKey.
  try { new PublicKey(userWallet); }
  catch { return c.json({ error: "invalid_user_wallet" }, 400); }

  if (!/^\d{1,20}$/.test(loanId)) {
    return c.json({ error: "invalid_loan_id", detail: "must be a decimal string ≤ 20 digits" }, 400);
  }
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) {
    return c.json({ error: "invalid_trigger_kind" }, 400);
  }
  if (!VALID_TRIGGER_DIRECTIONS.has(triggerDirection)) {
    return c.json(
      { error: "invalid_trigger_direction", detail: "must be 'above' (take-profit, default) or 'below' (stop-loss)" },
      400,
    );
  }
  if (!/^\d{1,18}$/.test(triggerValueMicro)) {
    return c.json({ error: "invalid_trigger_value", detail: "decimal string up to 1e15 micros" }, 400);
  }
  if (!Number.isInteger(slippageBpsRaw) || slippageBpsRaw < 10 || slippageBpsRaw > 1000) {
    return c.json({ error: "invalid_slippage_bps", detail: "integer 10..1000" }, 400);
  }
  if (!VALID_DESTINATIONS.has(sellDestination)) {
    return c.json({ error: "invalid_sell_destination", detail: "must be 'sol' or 'usdc'" }, 400);
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return c.json({ error: "invalid_expires_at", detail: "must be an ISO timestamp" }, 400);
  }

  // Don't let an agent self-deal: if the verified payer (agent_pubkey)
  // happens to equal user_wallet, that means the borrower is paying
  // x402 to arm their own order — they should use TG /limitclose
  // instead (no arm fee). Reject so agents and humans can't get the
  // same surface confused.
  if (agentPubkey === userWallet) {
    return c.json(
      {
        error: "self_arm_not_allowed",
        detail: "The x402 payer pubkey must differ from user_wallet. Borrowers should use the TG /limitclose command (no fee).",
      },
      400,
    );
  }

  return forward(c, `${BOT_API}/api/v1/internal/agent/limit-close/arm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_wallet: userWallet,
      agent_pubkey: agentPubkey,
      loan_id: loanId,
      trigger_kind: triggerKind,
      trigger_direction: triggerDirection,
      trigger_value_micro: triggerValueMicro,
      slippage_bps: slippageBpsRaw,
      sell_destination: sellDestination,
      expires_at: expiresAt,
      auto_escalate_slippage: autoEscalate,
      x402_tx_signature: x402Sig ?? "",
    }),
  });
}

/**
 * GET /api/v1/agent/limit-close?id=<order_id>  — read one order.
 *
 * Free, scoped to the calling agent. The agent pubkey is asserted via
 * X-Agent-Pubkey header (must be a valid base58 pubkey). Without a
 * payment binding the value of read access is low — agents need to
 * manage their own pipeline — but we still want a stable identity
 * for the bot's scoping filter.
 *
 * Misuse risk is low: an attacker who guesses an order id sees only
 * its public-shape fields (no wallet derivation, no holdings, no PII).
 * But scoping by agent prevents agents from peeking at competitors'
 * orders.
 */
export async function getLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id || !/^\d{1,12}$/.test(id)) {
    return c.json({ error: "missing_or_invalid_id" }, 400);
  }
  const agentPubkey = c.req.header("x-agent-pubkey") ?? "";
  try { new PublicKey(agentPubkey); }
  catch { return c.json({ error: "missing_or_invalid_agent_pubkey_header" }, 400); }

  const url = `${BOT_API}/api/v1/internal/agent/limit-close?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * GET /api/v1/agent/limit-close/list[?status=all]  — list agent's orders.
 *
 * Same scoping as the single-read handler.
 */
export async function listLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const agentPubkey = c.req.header("x-agent-pubkey") ?? "";
  try { new PublicKey(agentPubkey); }
  catch { return c.json({ error: "missing_or_invalid_agent_pubkey_header" }, 400); }
  const status = c.req.query("status") === "all" ? "all" : "armed";

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/list?agent=${encodeURIComponent(agentPubkey)}&status=${status}`;
  return forward(c, url, { method: "GET" });
}

/**
 * GET /api/v1/agent/limit-close/delegations  — discover what this
 * agent is authorized for.
 *
 * Free. Scoped by X-Agent-Pubkey header. Returns every active
 * (user_wallet, bounds, usage) tuple the agent can operate against.
 *
 * Standard startup call for an agent: hit this once to see "what
 * surface am I working over today?", cache, then call POST /arm as
 * orders come in. The `usage` block tells the agent how many active
 * orders it already has per wallet vs the cap — so it can decide
 * whether to arm a new order without round-tripping.
 */
export async function listDelegationsHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const agentPubkey = c.req.header("x-agent-pubkey") ?? "";
  try { new PublicKey(agentPubkey); }
  catch { return c.json({ error: "missing_or_invalid_agent_pubkey_header" }, 400); }

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/delegations?agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * GET /api/v1/agent/limit-close/eligible-loans  — the agent's full
 * actionable surface.
 *
 * Free. Scoped by X-Agent-Pubkey header.
 *
 * Returns every (user_wallet, loan) tuple where this agent has an
 * active delegation, with EXPLICIT eligibility for each loan:
 *
 *   - is_eligible:        boolean
 *   - ineligibility_reasons: array of strings (empty when eligible)
 *
 * The reasons include things like:
 *   - 'loan_below_minimum_size'
 *   - 'rwa_collateral_not_supported_in_v1'
 *   - 'loan_already_has_active_order'
 *   - 'loan_exceeds_delegation_per_order_cap'
 *   - 'agent_concurrency_cap_reached'
 *
 * Agents typically call this on startup + every 60s during operation.
 * It gives them everything they need to decide what to arm without
 * paying for guesses that the arm endpoint would reject.
 *
 * Implementation note: the bot side mirrors the arm endpoint's
 * eligibility checks EXACTLY (same constants, same query patterns),
 * so an 'is_eligible: true' here can never be reverted by a
 * subsequent arm call without a real state change in between (loan
 * status flip, new armed order from another agent, etc).
 */
export async function listEligibleLoansHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const agentPubkey = c.req.header("x-agent-pubkey") ?? "";
  try { new PublicKey(agentPubkey); }
  catch { return c.json({ error: "missing_or_invalid_agent_pubkey_header" }, 400); }

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/eligible-loans?agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * DELETE /api/v1/agent/limit-close?id=<order_id>  — cancel an armed order.
 *
 * Free. The bot's UPDATE WHERE status='armed' makes a too-late cancel
 * a 409 no-op rather than corrupting an in-flight execution.
 */
export async function cancelLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id || !/^\d{1,12}$/.test(id)) {
    return c.json({ error: "missing_or_invalid_id" }, 400);
  }
  const agentPubkey = c.req.header("x-agent-pubkey") ?? "";
  try { new PublicKey(agentPubkey); }
  catch { return c.json({ error: "missing_or_invalid_agent_pubkey_header" }, 400); }

  const url = `${BOT_API}/api/v1/internal/agent/limit-close?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "DELETE" });
}
