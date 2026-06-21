import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { enforcePayerMatchesWallet } from "../lib/payer-bind.js";

/**
 * Three loan-management proxies:
 *   POST /api/v1/agent/build-extend         — extend loan term
 *   POST /api/v1/agent/build-topup          — add collateral
 *   POST /api/v1/agent/build-partial-repay  — repay part of loan
 *
 * Same authenticated-proxy pattern as build-borrow / build-repay.
 * x402 verifies the payment, forwards to bot's /api/v1/agent/*
 * with INTERNAL_API_TOKEN. Bot enforces gates, builds unsigned tx,
 * returns it. Agent signs + submits via direct Solana RPC (no
 * cosign step for any of these — extend/topup/partial-repay are
 * all borrower-only ixs on-chain).
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function validatePubkey(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  try { new PublicKey(s); return s; } catch { return null; }
}

async function proxyToBot(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${BOT_API}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { status: 502, data: { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) } };
  }
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: { error: "bot_returned_non_json", status: res.status } }; }
}

export async function buildExtendHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json({ error: "agent_api_not_configured" }, 503);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const borrower = validatePubkey((body as Record<string, unknown>).borrower_wallet);
  const loanPda = validatePubkey((body as Record<string, unknown>).loan_pda);
  if (!borrower || !loanPda) return c.json({ error: "missing_or_invalid_params", required: ["borrower_wallet", "loan_pda"] }, 400);
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;
  const { status, data } = await proxyToBot("/api/v1/agent/build-extend", { borrower_wallet: borrower, loan_pda: loanPda });
  return c.json(data as Record<string, unknown>, status as never);
}

export async function buildTopupHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json({ error: "agent_api_not_configured" }, 503);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const b = body as Record<string, unknown>;
  const borrower = validatePubkey(b.borrower_wallet);
  const loanPda = validatePubkey(b.loan_pda);
  const extra = String(b.extra_collateral_amount ?? "");
  if (!borrower || !loanPda || !/^\d{1,20}$/.test(extra)) {
    return c.json({ error: "missing_or_invalid_params", required: ["borrower_wallet", "loan_pda", "extra_collateral_amount (u64 string)"] }, 400);
  }
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;
  const { status, data } = await proxyToBot("/api/v1/agent/build-topup", {
    borrower_wallet: borrower, loan_pda: loanPda, extra_collateral_amount: extra,
  });
  return c.json(data as Record<string, unknown>, status as never);
}

export async function buildPartialRepayHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json({ error: "agent_api_not_configured" }, 503);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_json" }, 400);
  const b = body as Record<string, unknown>;
  const borrower = validatePubkey(b.borrower_wallet);
  const loanPda = validatePubkey(b.loan_pda);
  const lamports = String(b.repay_lamports ?? "");
  if (!borrower || !loanPda || !/^\d{1,20}$/.test(lamports)) {
    return c.json({ error: "missing_or_invalid_params", required: ["borrower_wallet", "loan_pda", "repay_lamports (u64 string)"] }, 400);
  }
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;
  const { status, data } = await proxyToBot("/api/v1/agent/build-partial-repay", {
    borrower_wallet: borrower, loan_pda: loanPda, repay_lamports: lamports,
  });
  return c.json(data as Record<string, unknown>, status as never);
}
