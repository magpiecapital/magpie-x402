import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { enforcePayerMatchesWallet } from "../lib/payer-bind.js";

/**
 * Agent-as-LP endpoints. Completes the protocol-integration loop:
 * agents can already simulate, build, and submit BORROW transactions
 * through magpie-x402. These three add the LEND side — deposit SOL
 * into the LendingPool, withdraw shares, read the position.
 *
 * Both build endpoints proxy magpie-site, which already owns the
 * canonical TS tx-construction logic for the on-chain v1 program.
 *
 * Pricing rationale:
 *   build-deposit / build-withdraw — 0.002 SOL each. Same as the
 *     loan-management builders; the work involved (RPC blockhash,
 *     program-method serialization, position lookup for safety) is
 *     comparable.
 *   position (read) — free. Same as /api/v1/pool: it's just account
 *     decoding. No need to gate it; charging would only deter the
 *     pre-deposit "is this protocol worth integrating?" inspection
 *     phase.
 */

const SITE_API = process.env.MAGPIE_SITE_API || "https://www.magpie.capital";

async function proxyJson(
  c: Context,
  upstreamPath: string,
  method: "GET" | "POST",
  body?: unknown,
) {
  let res: Response;
  try {
    res = await fetch(`${SITE_API}${upstreamPath}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
    // Don't echo a raw upstream body to the caller — a CDN/proxy error page
    // can carry internal details. Log server-side, return a generic shape.
    console.warn(`[agent-lp] non-JSON from ${upstreamPath} (status ${res.status}):`, text.slice(0, 300));
    data = { error: "site_returned_non_json", status: res.status };
  }
  return c.json(data as Record<string, unknown>, res.status as never);
}

/** POST /api/v1/agent/build-deposit */
export async function buildDepositHandler(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const depositor = String(b.depositor ?? "");
  const lamports = String(b.lamports ?? "");

  if (!depositor || !lamports) {
    return c.json(
      {
        error: "missing_params",
        required: { depositor: "pubkey", lamports: "u64 string in lamports" },
      },
      400,
    );
  }
  try {
    new PublicKey(depositor);
  } catch {
    return c.json({ error: "invalid_depositor_pubkey" }, 400);
  }
  if (!/^\d+$/.test(lamports)) {
    return c.json({ error: "lamports_must_be_u64_string" }, 400);
  }

  // Security gate: the x402 payer must equal the depositor — you build a
  // deposit tx only for your own wallet. Prevents a paying caller from
  // burning server/RPC work building txs targeting arbitrary wallets.
  const mismatch = enforcePayerMatchesWallet(c, depositor);
  if (mismatch) return mismatch;

  return proxyJson(c, "/api/v1/lp/build-deposit", "POST", { depositor, lamports });
}

/** POST /api/v1/agent/build-withdraw */
export async function buildWithdrawHandler(c: Context) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const depositor = String(b.depositor ?? "");
  const shares = String(b.shares ?? "");

  if (!depositor || !shares) {
    return c.json(
      {
        error: "missing_params",
        required: { depositor: "pubkey", shares: "u64 string (LP shares)" },
      },
      400,
    );
  }
  try {
    new PublicKey(depositor);
  } catch {
    return c.json({ error: "invalid_depositor_pubkey" }, 400);
  }
  if (!/^\d+$/.test(shares)) {
    return c.json({ error: "shares_must_be_u64_string" }, 400);
  }

  // Security gate: x402 payer must equal the depositor (own-wallet only).
  const mismatch = enforcePayerMatchesWallet(c, depositor);
  if (mismatch) return mismatch;

  return proxyJson(c, "/api/v1/lp/build-withdraw", "POST", { depositor, shares });
}

/** GET /api/v1/agent/lp-state?wallet=… */
export async function lpStateHandler(c: Context) {
  const wallet = c.req.query("wallet") ?? "";
  if (!wallet) return c.json({ error: "missing_wallet" }, 400);
  try {
    new PublicKey(wallet);
  } catch {
    return c.json({ error: "invalid_wallet_pubkey" }, 400);
  }
  return proxyJson(c, `/api/v1/lp/position/${encodeURIComponent(wallet)}`, "GET");
}
