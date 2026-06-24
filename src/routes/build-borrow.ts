import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { enforcePayerMatchesWallet } from "../lib/payer-bind.js";

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
 *     has_exit_arming?:   boolean (optional, default false) — when true, the
 *                                  loan is opened on the V4 in-vault program
 *                                  so the agent can arm auto-sell exit orders
 *                                  on it afterward (see /api/v1/agent/self-
 *                                  limit-close/*). The bot's chooseProgramId
 *                                  routes the borrow: no-exits+memecoin -> V1,
 *                                  no-exits+RWA -> V3, has_exit_arming -> V4.
 *   }
 *
 * Response:
 *   200 OK { partial_signed_tx_b64, summary, next_step }  (summary carries
 *           program_id + program_version + loan_id + loan_pda)
 *   400/403/500 with { error, detail?, reason? } on validation / gate / build failure
 *
 * Lane separation: has_exit_arming is a pure ROUTING HINT forwarded to the
 * bot. This handler performs NO V4-specific work (no TWAP / feed-ready /
 * warmup call) — isV4Borrow lives entirely bot-side, so a V1/V3 borrow is
 * never blocked by V4 readiness.
 *
 * Safety: agents get NO exemptions from the gates the human flow runs.
 * Same per-token caps, same imported-wallet cooldown, same TWAP, same
 * everything. The agent's wallet is the borrower; the agent's wallet
 * signs; the agent's wallet bears all loan obligations.
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
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
  // Strict boolean — only the literal `true` routes the borrow to V4. A
  // string "true" / 1 is deliberately ignored so a loosely-encoded client
  // can't accidentally opt into the exit-armed (V4) program.
  const hasExitArming = b.has_exit_arming === true;
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
  // u64 max is 18,446,744,073,709,551,615 — 20 digits. Cap at 20 chars
  // so we reject a 1000-char "u64" before forwarding to the bot.
  if (!/^\d{1,20}$/.test(amount)) return c.json({ error: "amount_must_be_u64_string" }, 400);

  // Security gate: x402 payer must equal borrower_wallet. Without this
  // a paying caller can have the server construct a borrow tx targeting
  // any wallet's positions, leaking eligibility info and burning the
  // bot's gauntlet RPC budget.
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;

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
        has_exit_arming: hasExitArming,
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
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Never echo a raw upstream body — a CDN/proxy error page can carry
    // internal detail. Log server-side; return a generic shape to the agent.
    console.warn(`[build-borrow] non-JSON from bot (status ${res.status}):`, text.slice(0, 300));
    parsed = { error: "bot_returned_non_json", status: res.status };
  }
  // A 401/403 from the bot's INTERNAL auth means our X-Internal-Token doesn't
  // match the bot's INTERNAL_API_TOKEN — a PROTOCOL MISCONFIG, never the agent's
  // fault. Pass-through would surface as a 4xx, and the two-phase claim only
  // refunds on 5xx → the agent would be charged-but-denied. Remap to 503 so the
  // claim RELEASES and the payment is NOT consumed. (Root-cause: align
  // INTERNAL_API_TOKEN across the x402 service and the bot.)
  if (res.status === 401 || res.status === 403) {
    console.error(
      `[build-borrow] bot internal-auth ${res.status} — INTERNAL_API_TOKEN mismatch (x402↔bot). Releasing claim; agent not charged.`,
    );
    return c.json(
      {
        error: "agent_api_unavailable",
        detail:
          "Magpie's agent API is temporarily unavailable (server configuration). Your payment was NOT consumed — please retry shortly.",
      },
      503,
    );
  }
  // Classify-before-friendly: when the bot rejects a (would-be) V4 borrow for
  // a known reason, attach a typed hint + retryability so the agent can react
  // programmatically instead of parsing an opaque string. We AUGMENT, never
  // replace, the bot's own fields.
  if (!res.ok) {
    const code = String(parsed.error ?? parsed.reason ?? "").toUpperCase();
    const hint = classifyBorrowError(code);
    if (hint) parsed = { ...parsed, classified: hint };
  }
  return c.json(parsed, res.status as never);
}

/** Map known bot rejection codes to an agent-actionable hint. */
function classifyBorrowError(code: string): { reason: string; retryable: boolean; detail: string } | null {
  if (code.includes("V4_TOKEN2022_EXITS_BLOCKED")) {
    return {
      reason: "exits_not_supported_for_token2022",
      retryable: false,
      detail: "This Token-2022 mint can't be opened as a V4 exit-armed loan. Retry with has_exit_arming=false to borrow on V1/V3 without exits.",
    };
  }
  if (code.includes("V4_BORROWS_PAUSED")) {
    return {
      reason: "v4_borrows_paused",
      retryable: true,
      detail: "V4 exit-armed borrows are temporarily paused by the protocol. Retry later, or borrow with has_exit_arming=false.",
    };
  }
  return null;
}
