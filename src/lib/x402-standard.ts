/**
 * Standard x402 v2 SVM "exact" rail (USDC + wSOL, facilitator-settled).
 *
 * This is the SECOND payment rail beside the existing native-SOL+memo flow in
 * x402.ts. It exists so STANDARD x402 agents (whose client libraries only speak
 * the official v2 schema) can discover AND pay Magpie — the native-SOL custom
 * flow only works with Magpie's own SDK/MCP.
 *
 * Lane separation is by HEADER NAME, enforced in x402.ts:
 *   - native rail  → header `x-payment` (a bare base58 tx signature)  [UNCHANGED]
 *   - standard rail → header `PAYMENT-SIGNATURE` (base64 PaymentPayload) [HERE]
 * The two cannot collide; the native branch is byte-for-byte untouched.
 *
 * Custody boundary stays INVIOLABLE: this service holds NO keys and signs NO
 * settlement. The agent partially-signs an SPL TransferChecked; the FACILITATOR
 * co-signs as feePayer + submits. A full compromise of this service still cannot
 * move funds — it can only ask the facilitator to settle a payment the agent
 * already authorized to OUR payTo.
 *
 * SECURITY POSTURE (this rail FAILS CLOSED, opposite of the native rail):
 *  - Requirements are SERVER-OWNED: we build paymentRequirements per route and
 *    pass the IDENTICAL object to /verify AND /settle. Client-supplied
 *    asset/amount/payTo/network are NEVER trusted.
 *  - VERIFY-THEN-SETTLE: /settle only fires after /verify returns isValid===true.
 *  - DURABLE DEDUP is Magpie's job (SVM exact has no on-chain nonce): a
 *    pre-settle reservation on UNIQUE(nonce) + a post-settle claim on
 *    UNIQUE(tx_signature), both via the bot's x402 record endpoint.
 *  - RESOURCE BINDING: accepts[].extra.memo = magpie-x402:<hmac-nonce(endpoint)>;
 *    we re-verify the nonce against the endpoint so a payment for /a can't satisfy /b.
 *  - feePayer comes ONLY from the facilitator's /supported (cached at boot).
 *  - per-asset decimals: USDC 6, wSOL 9. Never reuse lamports for USDC.
 *  - Any facilitator non-2xx / parse error / !isValid / !success / failed
 *    reservation → 402. Never serve without a confirmed settle.
 *
 * Gated by X402_STANDARD_RAIL_ENABLED (default OFF). When off, the caller never
 * invokes this and the 402 omits SPL accepts — instant revert to native-only.
 */
import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { mintNonce, verifyNonce, NONCE_TTL_MS } from "./hmac-nonce.js";

// ── Constants (env-tunable) ─────────────────────────────────────────────────
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const WSOL_DECIMALS = 9;

const FACILITATOR_PRIMARY = process.env.X402_FACILITATOR_URL || "https://facilitator.payai.network";
const FACILITATOR_FALLBACK = process.env.X402_FACILITATOR_URL_FALLBACK || "https://dexter.cash/facilitator";
// Only these hosts may ever be used (provenance for the co-signing feePayer).
const FACILITATOR_ALLOWLIST = new Set([FACILITATOR_PRIMARY, FACILITATOR_FALLBACK].map(hostOf));
const SOL_USD_RATE = Number(process.env.X402_SOL_USD_RATE || "150"); // USDC pricing default; refine via oracle later
const WSOL_ENABLED = process.env.X402_WSOL_ACCEPT_ENABLED !== "false"; // gate wSOL until mainnet settle-tested
const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

export function standardRailEnabled(): boolean {
  return process.env.X402_STANDARD_RAIL_ENABLED === "true";
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string; // atomic units, per-asset decimals
  asset: string;  // SPL mint
  payTo: string;  // OWNER wallet (facilitator derives the ATA)
  maxTimeoutSeconds: number;
  extra: { feePayer: string; memo: string };
}
interface VerifyResponse { isValid?: boolean; invalidReason?: string; payer?: string }
interface SettleResponse { success?: boolean; errorReason?: string; signature?: string; transaction?: string; payer?: string }

// ── feePayer provenance (cached at boot) ────────────────────────────────────
let _feePayerCache: { url: string; feePayer: string } | null = null;
export async function getSvmFeePayer(): Promise<{ url: string; feePayer: string } | null> {
  if (_feePayerCache) return _feePayerCache;
  for (const url of [FACILITATOR_PRIMARY, FACILITATOR_FALLBACK]) {
    if (!FACILITATOR_ALLOWLIST.has(hostOf(url))) continue;
    try {
      const r = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { kinds?: Array<{ x402Version?: number; scheme?: string; network?: string; extra?: { feePayer?: string } }> };
      const kind = (j.kinds || []).find(
        (k) => k.x402Version === 2 && k.scheme === "exact" && k.network === SOLANA_CAIP2 && k.extra?.feePayer,
      );
      if (kind?.extra?.feePayer) {
        try { new PublicKey(kind.extra.feePayer); } catch { continue; }
        _feePayerCache = { url, feePayer: kind.extra.feePayer };
        return _feePayerCache;
      }
    } catch { /* try next */ }
  }
  return null;
}

// ── Pricing (server-owned) ──────────────────────────────────────────────────
export function usdcAtomicForLamports(amountLamports: bigint): string {
  // USDC default = SOL-price equivalent at the env rate. (Override per-route later.)
  const sol = Number(amountLamports) / 1e9;
  const usdc = Math.max(1, Math.round(sol * SOL_USD_RATE * 10 ** USDC_DECIMALS));
  return String(usdc);
}
export function wsolAtomicForLamports(amountLamports: bigint): string {
  return amountLamports.toString(); // wSOL == lamports, exact
}

// ── Build the SERVER-OWNED accepts for a route ──────────────────────────────
export function buildSplAccepts(amountLamports: bigint, memo: string, feePayer: string): PaymentRequirements[] {
  const maxTimeoutSeconds = Math.min(60, Math.floor(NONCE_TTL_MS / 1000)); // <= blockhash/window; nonce TTL covers it
  const base = { scheme: "exact" as const, network: SOLANA_CAIP2, payTo: getPayTo(), maxTimeoutSeconds, extra: { feePayer, memo } };
  const accepts: PaymentRequirements[] = [
    { ...base, amount: usdcAtomicForLamports(amountLamports), asset: USDC_MINT },
  ];
  if (WSOL_ENABLED) accepts.push({ ...base, amount: wsolAtomicForLamports(amountLamports), asset: WSOL_MINT });
  return accepts;
}

function getPayTo(): string {
  const p = process.env.MAGPIE_PAY_TO;
  if (!p) throw new Error("[x402-standard] MAGPIE_PAY_TO unset");
  return p;
}

// ── Facilitator calls (separate, fail-closed) ───────────────────────────────
async function facilitator(path: "verify" | "settle", body: unknown, timeoutMs: number): Promise<unknown | null> {
  const fp = _feePayerCache?.url ? _feePayerCache.url : FACILITATOR_PRIMARY;
  try {
    const r = await fetch(`${fp}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Durable dedup via the bot record endpoint ───────────────────────────────
async function botRecord(rec: Record<string, unknown>): Promise<{ fresh?: boolean } | null> {
  if (!INTERNAL_TOKEN) return null; // no auth → fail closed (caller treats null as failure on the reserve path)
  try {
    const r = await fetch(`${BOT_API}/api/v1/internal/x402/record`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
      body: JSON.stringify(rec),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { fresh?: unknown };
    return { fresh: typeof j.fresh === "boolean" ? j.fresh : undefined };
  } catch { return null; }
}

/**
 * Handle a standard-rail (PAYMENT-SIGNATURE) request. Returns a Hono Response
 * (the served downstream result is handled by the caller on `ok`). On ANY
 * failure returns a 402. Caller invokes this ONLY when standardRailEnabled().
 */
export async function settleStandardSplPayment(
  c: Context,
  opts: { endpoint: string; amountLamports: bigint; v2Sig: string },
): Promise<{ ok: true; payer: string } | { ok: false; res: Response }> {
  const fail = (status: number, body: Record<string, unknown>) => ({ ok: false as const, res: c.json(body, status as never) });

  // 1. feePayer provenance (cached)
  const fp = await getSvmFeePayer();
  if (!fp) return fail(503, { error: "facilitator_unavailable" });

  // 2. decode the client payload (base64 JSON)
  let payload: { accepted?: { asset?: string }; x402Version?: number } & Record<string, unknown>;
  try { payload = JSON.parse(Buffer.from(opts.v2Sig, "base64").toString("utf8")); }
  catch { return fail(402, { error: "invalid_payment_signature" }); }

  // 3. SERVER-OWNED requirements (resource-bound via hmac nonce + memo)
  const nonce = mintNonce(opts.endpoint);
  const memo = `magpie-x402:${nonce}`;
  const accepts = buildSplAccepts(opts.amountLamports, memo, fp.feePayer);

  // 4. select the requirement matching the asset the client says it paid; assert it's ours
  const clientAsset = payload.accepted?.asset;
  const reqd = accepts.find((a) => a.asset === clientAsset);
  if (!reqd) return fail(402, { error: "unsupported_asset", supported: accepts.map((a) => a.asset) });
  // defense-in-depth: never settle against anything but our own server-built object
  if (reqd.payTo !== getPayTo() || reqd.network !== SOLANA_CAIP2 || reqd.extra.feePayer !== fp.feePayer) {
    return fail(500, { error: "requirements_integrity" });
  }

  // 5. PRE-SETTLE RESERVATION (fail closed): claim the nonce before settling
  const reserve = await botRecord({
    endpoint_path: opts.endpoint, method: c.req.method, amount_lamports: reqd.amount,
    payer_pubkey: "", tx_signature: `PENDING:${nonce}`, nonce, kind: "reserve",
  });
  if (!reserve || reserve.fresh === false) {
    return fail(402, { error: reserve ? "payment_already_used" : "reservation_unavailable" });
  }

  // 6. VERIFY then SETTLE (server-owned requirements both times)
  const v = (await facilitator("verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqd }, 8000)) as VerifyResponse | null;
  if (!v || v.isValid !== true) return fail(402, { error: "payment_invalid", reason: v?.invalidReason ?? "verify_failed" });

  const s = (await facilitator("settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqd }, 20000)) as SettleResponse | null;
  if (!s || s.success !== true || !s.signature) return fail(402, { error: "settle_failed", reason: s?.errorReason ?? "no_settlement" });

  // 7. resource binding re-check + claim the SETTLED signature (durable single-use)
  const nonceCheck = verifyNonce(nonce, opts.endpoint);
  if (!nonceCheck.ok) return fail(402, { error: "nonce_invalid", reason: nonceCheck.reason });
  const payer = s.payer ?? v.payer ?? "";
  await botRecord({
    // kind "settled-spl" so the bot records the metric + claims the real signature
    // (durable single-use) but does NOT accrue: the amount is a USDC/wSOL atomic,
    // not lamports — the SPL->SOL sweep credits the holder pool after conversion.
    endpoint_path: opts.endpoint, method: c.req.method, amount_lamports: reqd.amount,
    payer_pubkey: payer, tx_signature: s.signature, nonce, kind: "settled-spl",
    asset: reqd.asset,
  });

  // 8. emit the standard settlement response header + propagate payer for per-wallet gating
  try { c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, signature: s.signature, payer })).toString("base64")); } catch { /* non-fatal */ }
  return { ok: true, payer };
}

/** Destination ATA addresses the operator must pre-create (service holds no keys). */
export function destinationAtas(): { usdc: string; wsol: string } {
  const owner = new PublicKey(getPayTo());
  return {
    usdc: getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), owner, true).toBase58(),
    wsol: getAssociatedTokenAddressSync(new PublicKey(WSOL_MINT), owner, true).toBase58(),
  };
}
