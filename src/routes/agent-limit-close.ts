import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { verifyAgentFromContext } from "../lib/agent-envelope.js";

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

const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
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
  catch { parsed = { error: "bot_returned_non_json", status: res.status }; }
  // Bot internal-auth 401/403 = protocol misconfig (token mismatch), never the
  // agent's fault → remap to 503 so the x402 claim refunds (no charged-but-denied).
  if (res.status === 401 || res.status === 403) {
    console.error(`[agent-limit-close] bot internal-auth ${res.status} — INTERNAL_API_TOKEN mismatch (x402↔bot). Releasing claim; agent not charged.`);
    return c.json(
      { error: "agent_api_unavailable", detail: "Magpie's agent API is temporarily unavailable (server configuration). Your payment was NOT consumed — please retry shortly." },
      503,
    );
  }
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
 * POST /api/v1/agent/limit-close/preflight  — "would this arm succeed?"
 *
 * Free. Same body shape as /arm but no x402 payment required. Lets
 * agents check whether an arm with these parameters would succeed
 * BEFORE paying. Returns 200 with would_arm=true on success, or the
 * same error codes /arm would have returned on rejection.
 *
 * Why free: a preflight is a question the agent should be encouraged
 * to ask. Charging x402 here would defeat the purpose — the whole
 * point is to save the agent the per-arm fee on rejected configs.
 *
 * Agent identity comes from a signed Ed25519 envelope (headers
 * X-Magpie-Env-Msg / -Sig / -Signer, action "limit-close-preflight/v1";
 * same scoping model as /list and /get). The verified signer — never a
 * self-asserted header — is forwarded as agent_pubkey. Preflight is
 * read-only on the database — the worst a (now signature-bound) caller
 * can do is enumerate "would any of these configs pass?", which leaks
 * nothing beyond what /arm would leak anyway via its error codes.
 *
 * Liquidity can shift between preflight and arm, so a successful
 * preflight is a strong hint, NOT a contractual reservation.
 */
export async function preflightLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);

  const verified = verifyAgentFromContext(c, "limit-close-preflight/v1", {});
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const b = (body ?? {}) as Record<string, unknown>;

  const userWallet         = String(b.user_wallet ?? "");
  const loanId             = String(b.loan_id ?? "");
  const triggerKind        = String(b.trigger_kind ?? "");
  const triggerDirection   = String(b.trigger_direction ?? "above");
  const triggerValueMicro  = String(b.trigger_value_micro ?? "");
  const slippageBpsRaw     = Number(b.slippage_bps);
  const sellDestination    = String(b.sell_destination ?? "sol").toLowerCase();
  const expiresAt          = b.expires_at == null ? null : String(b.expires_at);
  const autoEscalate       = b.auto_escalate_slippage === true;

  // Shape validation (mirrors /arm so the agent sees the same 400s)
  if (!userWallet || !loanId || !triggerKind || !triggerValueMicro) {
    return c.json({ error: "missing_params" }, 400);
  }
  try { new PublicKey(userWallet); }
  catch { return c.json({ error: "invalid_user_wallet" }, 400); }
  if (!/^\d{1,20}$/.test(loanId)) {
    return c.json({ error: "invalid_loan_id" }, 400);
  }
  if (!VALID_TRIGGER_KINDS.has(triggerKind)) {
    return c.json({ error: "invalid_trigger_kind" }, 400);
  }
  if (!VALID_TRIGGER_DIRECTIONS.has(triggerDirection)) {
    return c.json({ error: "invalid_trigger_direction" }, 400);
  }
  if (!/^\d{1,18}$/.test(triggerValueMicro)) {
    return c.json({ error: "invalid_trigger_value" }, 400);
  }
  if (!Number.isInteger(slippageBpsRaw) || slippageBpsRaw < 10 || slippageBpsRaw > 1000) {
    return c.json({ error: "invalid_slippage_bps" }, 400);
  }
  if (!VALID_DESTINATIONS.has(sellDestination)) {
    return c.json({ error: "invalid_sell_destination" }, 400);
  }
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) {
    return c.json({ error: "invalid_expires_at" }, 400);
  }
  if (agentPubkey === userWallet) {
    return c.json({ error: "self_arm_not_allowed" }, 400);
  }

  return forward(c, `${BOT_API}/api/v1/internal/agent/limit-close/preflight`, {
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
    }),
  });
}

/**
 * GET /api/v1/agent/limit-close?id=<order_id>  — read one order.
 *
 * Free, scoped to the calling agent. The agent identity is proven by a
 * signed Ed25519 envelope (headers X-Magpie-Env-Msg / -Sig / -Signer,
 * action "limit-close-get/v1", OrderId bound to the queried id). The
 * verified signer — never a self-asserted X-Agent-Pubkey header — is
 * the agent's identity for the bot's scoping filter.
 *
 * Binding OrderId to the envelope means a get envelope can't be replayed
 * against a different order, and scoping by the verified agent prevents
 * agents from peeking at competitors' orders.
 */
export async function getLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id || !/^\d{1,12}$/.test(id)) {
    return c.json({ error: "missing_or_invalid_id" }, 400);
  }
  const verified = verifyAgentFromContext(c, "limit-close-get/v1", { expectedOrderId: id });
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  const url = `${BOT_API}/api/v1/internal/agent/limit-close?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * PATCH /api/v1/agent/limit-close/modify  — in-place modify an armed order.
 *
 * Free (no x402 charge). The agent already paid for the slot at arm
 * time; modify is just steering, not occupying. Pairs with bot PR
 * #148 which adds the shared modifyOrder() in arm-core.
 *
 * Body: { id, trigger_value_micro?, slippage_bps?, sell_destination?, expires_at? }
 * Auth: signed Ed25519 envelope (headers X-Magpie-Env-Msg / -Sig /
 *       -Signer, action "limit-close-modify/v1", OrderId == body.id).
 *       The verified signer — never a self-asserted X-Agent-Pubkey
 *       header — is forwarded as agent_pubkey; the bot internal scopes
 *       modifications to source='agent_x402' + matching pubkey.
 *
 * What the agent can change without re-paying:
 *   - trigger_value_micro (move the price target)
 *   - slippage_bps        (cannot exceed the order's existing cap)
 *   - sell_destination    (sol ↔ usdc)
 *   - expires_at          (or null to clear)
 *
 * What the agent CAN'T change via modify (force cancel + re-arm):
 *   - trigger_kind        (unit change is semantically distinct)
 *   - trigger_direction   (TP ↔ SL change is semantically distinct)
 *   - loan_id             (different loan = different order)
 *
 * Race-safe: if the engine flipped status to 'firing' between read
 * and write, the bot returns 409 not_modifiable_or_not_found.
 */
export async function modifyLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "invalid_json" }, 400); }
  const b = (body ?? {}) as Record<string, unknown>;

  const idRaw = String(b.id ?? "");
  if (!/^\d{1,12}$/.test(idRaw)) {
    return c.json({ error: "missing_or_invalid_id" }, 400);
  }

  // Bind the envelope to this exact order id so a modify envelope can
  // never be replayed against a different order.
  const verified = verifyAgentFromContext(c, "limit-close-modify/v1", { expectedOrderId: idRaw });
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  // Pass-through validation. The bot endpoint re-validates each field
  // canonically; we only catch the trivial type errors here so the
  // agent sees a useful 400 before we round-trip to the bot.
  const forwardBody: Record<string, unknown> = { id: idRaw, agent_pubkey: agentPubkey };
  if (b.trigger_value_micro !== undefined) {
    const v = String(b.trigger_value_micro);
    if (!/^\d{1,18}$/.test(v)) return c.json({ error: "invalid_trigger_value" }, 400);
    forwardBody.trigger_value_micro = v;
  }
  if (b.slippage_bps !== undefined) {
    if (!Number.isInteger(b.slippage_bps) || (b.slippage_bps as number) < 10) {
      return c.json({ error: "invalid_slippage_bps" }, 400);
    }
    forwardBody.slippage_bps = b.slippage_bps;
  }
  if (b.sell_destination !== undefined) {
    const v = String(b.sell_destination).toLowerCase();
    if (v !== "sol" && v !== "usdc") return c.json({ error: "invalid_sell_destination" }, 400);
    forwardBody.sell_destination = v;
  }
  if (b.expires_at !== undefined) {
    if (b.expires_at === null) forwardBody.expires_at = null;
    else if (Number.isNaN(Date.parse(String(b.expires_at)))) {
      return c.json({ error: "invalid_expires_at" }, 400);
    } else {
      forwardBody.expires_at = String(b.expires_at);
    }
  }
  if (Object.keys(forwardBody).length <= 2) {
    return c.json({ error: "no_changes_supplied" }, 400);
  }

  return forward(c, `${BOT_API}/api/v1/internal/agent/limit-close/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forwardBody),
  });
}

/**
 * GET /api/v1/agent/limit-close/list[?status=all]  — list agent's orders.
 *
 * Same scoping as the single-read handler.
 */
export async function listLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const verified = verifyAgentFromContext(c, "limit-close-list/v1", {});
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;
  const status = c.req.query("status") === "all" ? "all" : "armed";

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/list?agent=${encodeURIComponent(agentPubkey)}&status=${status}`;
  return forward(c, url, { method: "GET" });
}

/**
 * GET /api/v1/agent/limit-close/delegations  — discover what this
 * agent is authorized for.
 *
 * Free. Scoped by the verified signer of a signed Ed25519 envelope
 * (headers X-Magpie-Env-Msg / -Sig / -Signer, action
 * "limit-close-delegations/v1"). Returns every active (user_wallet,
 * bounds, usage) tuple the agent can operate against.
 *
 * Standard startup call for an agent: hit this once to see "what
 * surface am I working over today?", cache, then call POST /arm as
 * orders come in. The `usage` block tells the agent how many active
 * orders it already has per wallet vs the cap — so it can decide
 * whether to arm a new order without round-tripping.
 */
export async function listDelegationsHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const verified = verifyAgentFromContext(c, "limit-close-delegations/v1", {});
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/delegations?agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * GET /api/v1/agent/limit-close/eligible-loans  — the agent's full
 * actionable surface.
 *
 * Free. Scoped by the verified signer of a signed Ed25519 envelope
 * (headers X-Magpie-Env-Msg / -Sig / -Signer, action
 * "limit-close-eligible/v1").
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
  const verified = verifyAgentFromContext(c, "limit-close-eligible/v1", {});
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  const url = `${BOT_API}/api/v1/internal/agent/limit-close/eligible-loans?agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "GET" });
}

/**
 * DELETE /api/v1/agent/limit-close?id=<order_id>  — cancel an armed order.
 *
 * Free. Auth: signed Ed25519 envelope (headers X-Magpie-Env-Msg /
 * -Sig / -Signer, action "limit-close-cancel/v1", OrderId bound to the
 * queried id). The verified signer — never a self-asserted
 * X-Agent-Pubkey header — scopes the cancel, so an attacker can no
 * longer disarm another agent's armed stop-loss. The bot's UPDATE WHERE
 * status='armed' makes a too-late cancel a 409 no-op rather than
 * corrupting an in-flight execution.
 */
export async function cancelLimitCloseHandler(c: Context) {
  if (!INTERNAL_TOKEN) return unconfigured(c);
  const id = c.req.query("id");
  if (!id || !/^\d{1,12}$/.test(id)) {
    return c.json({ error: "missing_or_invalid_id" }, 400);
  }
  const verified = verifyAgentFromContext(c, "limit-close-cancel/v1", { expectedOrderId: id });
  if (!verified.ok) return c.json({ error: verified.error }, verified.status as never);
  const agentPubkey = verified.signer;

  const url = `${BOT_API}/api/v1/internal/agent/limit-close?id=${encodeURIComponent(id)}&agent=${encodeURIComponent(agentPubkey)}`;
  return forward(c, url, { method: "DELETE" });
}
