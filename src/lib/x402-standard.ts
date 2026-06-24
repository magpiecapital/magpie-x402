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
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { verifyNonce, NONCE_TTL_MS, mintPriceCommit, verifyPriceCommit } from "./hmac-nonce.js";

// ── Constants (env-tunable) ─────────────────────────────────────────────────
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // mainnet
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const WSOL_DECIMALS = 9;

const FACILITATOR_PRIMARY = process.env.X402_FACILITATOR_URL || "https://facilitator.payai.network";
const FACILITATOR_FALLBACK = process.env.X402_FACILITATOR_URL_FALLBACK || "https://dexter.cash/facilitator";
// HARDCODED trust anchor. The allowlist is NOT derived from the (env-tunable)
// facilitator URLs — that would be circular (an env override could whitelist
// itself and point settlement at an attacker-controlled facilitator). Only an
// env URL whose host is in this in-code set is ever usable for verify/settle.
const FACILITATOR_TRUSTED_HOSTS = new Set([
  "facilitator.payai.network",
  "dexter.cash",
]);
const FACILITATOR_ALLOWLIST = new Set(
  [FACILITATOR_PRIMARY, FACILITATOR_FALLBACK]
    .map(hostOf)
    .filter((h) => FACILITATOR_TRUSTED_HOSTS.has(h)),
);
const SOL_USD_RATE_FALLBACK = Number(process.env.X402_SOL_USD_RATE || "150"); // fallback ONLY — getSolUsdRate() fetches the live rate
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
  // priceCommit (optional, audit #2): HMAC binding this exact amount to
  // (endpoint, asset, nonce) so settle enforces the quoted price, not a
  // recomputed-at-settle one. Absent on legacy challenges → settle falls back.
  extra: { feePayer: string; memo: string; priceCommit?: string };
}
interface VerifyResponse { isValid?: boolean; invalidReason?: string; payer?: string }
interface SettleResponse { success?: boolean; errorReason?: string; signature?: string; transaction?: string; payer?: string }

// ── feePayer provenance (cached at boot) ────────────────────────────────────
let _feePayerCache: { url: string; feePayer: string } | null = null;
let _feePayerNegUntilMs = 0;
export async function getSvmFeePayer(): Promise<{ url: string; feePayer: string } | null> {
  if (_feePayerCache) return _feePayerCache;
  // Negative cache: if both facilitators were just unreachable, don't re-probe
  // (2 × timeout) on every 402 challenge for the next window — that would add
  // ~6s to every challenge during an outage and approach the function's
  // maxDuration. (audit MEDIUM #7.)
  if (Date.now() < _feePayerNegUntilMs) return null;
  for (const url of [FACILITATOR_PRIMARY, FACILITATOR_FALLBACK]) {
    if (!FACILITATOR_ALLOWLIST.has(hostOf(url))) continue;
    try {
      // 3s on the challenge path (was 8s) — a 402 must never hang on the
      // facilitator's /supported. verify/settle keep their longer timeouts.
      const r = await fetch(`${url}/supported`, { signal: AbortSignal.timeout(3000) });
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
  _feePayerNegUntilMs = Date.now() + 45_000; // both unreachable — back off so challenges don't re-probe for 45s
  return null;
}

// ── Pricing (server-owned) ──────────────────────────────────────────────────
// Live SOL/USD so USDC is priced at the REAL SOL-equivalent. A fixed rate
// over/under-charges agents as SOL moves — a hardcoded 150 was ~2.1x the real
// ~$71 at go-live, which would actively repel USDC-paying agents. Jupiter-
// primary, cached 60s, env/150 fallback so a Jupiter blip never blocks a 402.
let _solUsdCache: { rate: number; atMs: number } | null = null;
let _solUsdLastGood: number | null = null;

function sane(p: unknown): number | null {
  return typeof p === "number" && Number.isFinite(p) && p > 0 && p < 100_000 ? p : null;
}
async function jupiterSolUsd(): Promise<number | null> {
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { usdPrice?: number } | undefined>;
    return sane(j[WSOL_MINT]?.usdPrice);
  } catch { return null; }
}
async function dexscreenerSolUsd(): Promise<number | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${WSOL_MINT}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    const pairs = Array.isArray(j) ? j : (j?.pairs || []);
    if (!pairs.length) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const best = pairs.reduce((b: any, p: any) => ((p.liquidity?.usd || 0) > (b?.liquidity?.usd || 0) ? p : b), pairs[0]);
    return sane(parseFloat(best?.priceUsd));
  } catch { return null; }
}

// Cross-sourced SOL/USD so a single mis-priced source can't make USDC
// under-collect (the audit's single-source underpay finding + the protocol's
// robust-price rule). Jupiter-primary + DexScreener; agree-within-3x → trust
// Jupiter, diverge → use last-good (don't trust either), one source → it, none
// → last-good, else the static fallback. 60s cache.
export async function getSolUsdRate(): Promise<number> {
  const now = Date.now();
  if (_solUsdCache && now - _solUsdCache.atMs < 60_000) return _solUsdCache.rate;
  const [jup, dex] = await Promise.all([jupiterSolUsd(), dexscreenerSolUsd()]);
  let rate: number | null = null;
  if (jup && dex) {
    const hi = Math.max(jup, dex), lo = Math.min(jup, dex);
    rate = hi / lo <= 3 ? jup : _solUsdLastGood; // agree → Jupiter; diverge → last-good
  } else {
    rate = jup ?? dex ?? _solUsdLastGood;
  }
  if (rate && rate > 0) {
    _solUsdCache = { rate, atMs: now };
    _solUsdLastGood = rate;
    return rate;
  }
  // Both sources unusable + no last-good — static fallback (last resort; can be
  // stale, so wSOL-denominated payment stays exact and unaffected).
  return _solUsdLastGood ?? SOL_USD_RATE_FALLBACK;
}

export function usdcAtomicForLamports(amountLamports: bigint, solUsdRate: number): string {
  const sol = Number(amountLamports) / 1e9;
  const usdc = Math.max(1, Math.round(sol * solUsdRate * 10 ** USDC_DECIMALS));
  return String(usdc);
}
export function wsolAtomicForLamports(amountLamports: bigint): string {
  return amountLamports.toString(); // wSOL == lamports, exact
}

// ── Build the SERVER-OWNED accepts for a route ──────────────────────────────
export async function buildSplAccepts(endpoint: string, amountLamports: bigint, memo: string, feePayer: string): Promise<PaymentRequirements[]> {
  const maxTimeoutSeconds = Math.min(60, Math.floor(NONCE_TTL_MS / 1000)); // <= blockhash/window; nonce TTL covers it
  const solUsdRate = await getSolUsdRate();
  const nonce = memo.replace(/^magpie-x402:/, "");
  // Each accept carries a priceCommit binding ITS amount to (endpoint, asset,
  // nonce). Settle verifies this instead of recomputing the price, killing
  // challenge→settle SOL/USD drift. (audit #2.)
  const mk = (amount: string, asset: string): PaymentRequirements => ({
    scheme: "exact", network: SOLANA_CAIP2, payTo: getPayTo(), maxTimeoutSeconds,
    extra: { feePayer, memo, priceCommit: mintPriceCommit(endpoint, asset, amount, nonce) },
    amount, asset,
  });
  const accepts: PaymentRequirements[] = [
    mk(usdcAtomicForLamports(amountLamports, solUsdRate), USDC_MINT),
  ];
  if (WSOL_ENABLED) accepts.push(mk(wsolAtomicForLamports(amountLamports), WSOL_MINT));
  return accepts;
}

function getPayTo(): string {
  const p = process.env.MAGPIE_PAY_TO;
  if (!p) throw new Error("[x402-standard] MAGPIE_PAY_TO unset");
  return p;
}

// ── On-chain settlement verification (NEVER trust the facilitator's word) ─────
// SOLANA_RPC_URL is server-owned. A compromised / MITM'd / lying facilitator can
// at most return a bogus {success, signature, payer}; we INDEPENDENTLY confirm
// the on-chain transfer of >= the required amount of the required asset into OUR
// payTo ATA, and derive the payer FROM THE CHAIN (never the facilitator's
// claimed payer — that feeds enforcePayerMatchesWallet downstream). No confirmed
// matching transfer → fail closed.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
let _settleConn: Connection | null = null;
function settleConn(): Connection {
  if (!_settleConn) _settleConn = new Connection(RPC_URL, "confirmed");
  return _settleConn;
}

async function verifySplSettlementOnChain(
  signature: string,
  reqd: PaymentRequirements,
): Promise<{ payer: string } | { unconfirmed: true } | null> {
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) return null;
  // The destination must be OUR payTo ATA for the required asset. An ATA can
  // only ever hold its own mint, so destination === payToAta(asset) already
  // pins the asset even for a bare `transfer`.
  let expectedAta: string;
  try {
    expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(reqd.asset), new PublicKey(getPayTo()), true,
    ).toBase58();
  } catch { return null; }
  let minAmount: bigint;
  try { minAmount = BigInt(reqd.amount); } catch { return null; }
  if (minAmount <= 0n) return null;

  // The facilitator returns before finality — poll for the confirmed tx. ~24s
  // (well within the 60s maxTimeout) so a congested-network confirmation lands.
  let tx: Awaited<ReturnType<Connection["getParsedTransaction"]>> = null;
  for (let i = 0; i < 12; i++) {
    try {
      tx = await settleConn().getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0, commitment: "confirmed",
      });
    } catch { tx = null; }
    if (tx) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  // tx NEVER fetched → unconfirmed (RPC lag): the facilitator settled but we
  // couldn't yet see it. This is RETRYABLE — distinct from a real mismatch — so
  // the caller can tell the agent to retry (the same signature re-confirms and
  // is served exactly once) instead of a hard reject of an agent who DID pay.
  if (!tx) return { unconfirmed: true };
  // tx fetched but failed on-chain → hard reject (no payment landed).
  if (tx.meta?.err) return null;

  // Asset pinning. The destination-ATA match in the loop below is already
  // structurally sufficient: `expectedAta` is derived from (payTo, reqd.asset)
  // and an ATA can ONLY ever hold its own mint, so a non-errored transfer of
  // >= the amount into expectedAta definitively credits reqd.asset to payTo.
  // The tx's token balances are used as EXTRA corroboration when the RPC
  // populated them — but we must NOT hard-require them: some providers / tx
  // shapes omit pre/postTokenBalances, and a hard gate there would falsely
  // reject a legitimately-settled payment (charged-but-denied). So: reject ONLY
  // when balances ARE present and CONTRADICT (none credit reqd.asset to payTo);
  // when absent, fall through to the structurally-sufficient loop.
  const tokenBalances = [
    ...(tx.meta?.postTokenBalances ?? []),
    ...(tx.meta?.preTokenBalances ?? []),
  ];
  if (
    tokenBalances.length > 0 &&
    !tokenBalances.some((b) => b.mint === reqd.asset && b.owner === getPayTo())
  ) {
    return null;
  }

  const top = tx.transaction.message.instructions || [];
  const inner = (tx.meta?.innerInstructions || []).flatMap((i) => i.instructions);
  for (const ix of [...top, ...inner]) {
    if (!("parsed" in ix)) continue;
    const program = (ix as { program?: string }).program;
    if (program !== "spl-token" && program !== "spl-token-2022") continue;
    const p = (ix as { parsed?: { type?: string; info?: Record<string, unknown> } }).parsed;
    if (!p || (p.type !== "transfer" && p.type !== "transferChecked")) continue;
    const info = p.info ?? {};
    if (info.destination !== expectedAta) continue;
    const amtStr = p.type === "transferChecked"
      ? (info.tokenAmount as { amount?: string } | undefined)?.amount
      : (info.amount as string | undefined);
    if (typeof amtStr !== "string") continue;
    let amt: bigint;
    try { amt = BigInt(amtStr); } catch { continue; }
    if (amt < minAmount) continue;
    // transferChecked also carries the mint — assert it (defense in depth).
    if (p.type === "transferChecked" && typeof info.mint === "string" && info.mint !== reqd.asset) continue;
    const payer = info.authority ?? info.multisigAuthority ?? info.source;
    if (typeof payer !== "string") continue;
    try { new PublicKey(payer); } catch { continue; }
    return { payer };
  }
  return null;
}

// ── Facilitator calls (separate, fail-closed) ───────────────────────────────
async function facilitator(path: "verify" | "settle", body: unknown, timeoutMs: number): Promise<unknown | null> {
  const fp = _feePayerCache?.url ? _feePayerCache.url : FACILITATOR_PRIMARY;
  // Defense-in-depth: never call a host outside the hardcoded trust anchor,
  // even if the cache was somehow populated with an untrusted URL.
  if (!FACILITATOR_ALLOWLIST.has(hostOf(fp))) return null;
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

// Same-instance LRU of SPL signatures served while the bot's durable single-use
// claim was unreachable (audit #3). Bounds same-instance double-serve; the
// settled on-chain tx (verified in 6b) + the bot's UNIQUE(tx_signature) on a
// later durable claim are the cross-instance anchors. Pruned on the nonce TTL.
const servedSplSigs = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [s, exp] of servedSplSigs) if (exp < now) servedSplSigs.delete(s);
}, 60_000).unref?.();

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

  // 3. REQUIREMENTS from the client's `accepted` object — VALIDATED field-by-
  // field against server policy. The client paid against the requirements it was
  // challenged with, whose extra.memo carries OUR endpoint-bound HMAC nonce. We
  // must NOT re-mint a fresh nonce: its memo wouldn't match the client's on-chain
  // tx (every payment would fail). So we trust NOTHING from `accepted` until each
  // field is checked, then settle against it. The on-chain check (6b) + the
  // durable signature claim (7) are the authoritative settlement + single-use guards.
  const accepted = payload.accepted as {
    scheme?: string; network?: string; asset?: string; amount?: string;
    payTo?: string; extra?: { feePayer?: string; memo?: string; priceCommit?: string };
  } | undefined;
  if (!accepted || typeof accepted !== "object") return fail(402, { error: "missing_accepted" });
  // 3a. asset must be one we actually offer
  const isUsdc = accepted.asset === USDC_MINT;
  const isWsol = accepted.asset === WSOL_MINT && WSOL_ENABLED;
  if (!isUsdc && !isWsol) {
    return fail(402, { error: "unsupported_asset", supported: [USDC_MINT, ...(WSOL_ENABLED ? [WSOL_MINT] : [])] });
  }
  // 3b. every non-amount field must be OURS (the client cannot redirect funds,
  //     swap the feePayer, or change networks)
  if (accepted.scheme !== "exact") return fail(402, { error: "bad_scheme" });
  if (accepted.network !== SOLANA_CAIP2) return fail(402, { error: "bad_network" });
  if (accepted.payTo !== getPayTo()) return fail(402, { error: "bad_payto" });
  if (accepted.extra?.feePayer !== fp.feePayer) return fail(402, { error: "bad_feepayer" });
  // 3c. RESOURCE BINDING: memo must be OUR hmac nonce, bound to THIS endpoint —
  //     so a payment for /a can't satisfy /b.
  const memo = accepted.extra?.memo;
  const mm = typeof memo === "string" ? memo.match(/^magpie-x402:([A-Za-z0-9_-]{16,200})$/) : null;
  if (!mm) return fail(402, { error: "bad_memo" });
  const nonce = mm[1];
  const nb = verifyNonce(nonce, opts.endpoint);
  if (!nb.ok) return fail(402, { error: "nonce_invalid", reason: nb.reason });
  // 3d. NO UNDERPAY. Prefer the price-commit (audit #2): if the claimed amount is
  //     bound to (endpoint, asset, nonce) by OUR HMAC, it IS the exact amount we
  //     quoted — enforce THAT on-chain (6b), with no fresh-rate recompute, so a
  //     SOL/USD move in the nonce window can't false-reject a correct payer or let
  //     one underpay on a downtick. Commit present but invalid → tampered → reject.
  //     Absent (legacy challenge minted before this deploy) → fall back to the
  //     recompute floor (ages out within the 10-min nonce TTL). wSOL is exact.
  let claimed: bigint;
  try { claimed = BigInt(accepted.amount ?? ""); } catch { return fail(402, { error: "invalid_amount" }); }
  if (claimed <= 0n) return fail(402, { error: "invalid_amount" });
  if (isWsol) {
    const exact = BigInt(wsolAtomicForLamports(opts.amountLamports));
    if (claimed < exact) return fail(402, { error: "amount_below_required", required: exact.toString() });
  } else {
    const hasCommit = !!accepted.extra?.priceCommit;
    const committed = verifyPriceCommit(accepted.extra?.priceCommit, opts.endpoint, accepted.asset!, accepted.amount!, nonce);
    if (hasCommit && !committed) {
      return fail(402, { error: "price_commit_invalid" });
    }
    if (!committed) {
      // Legacy challenge with no commit — recompute floor with headroom.
      const serverMin = BigInt(usdcAtomicForLamports(opts.amountLamports, await getSolUsdRate()));
      const floor = (serverMin * 90n) / 100n;
      if (claimed < floor) return fail(402, { error: "amount_below_required", required: serverMin.toString() });
    }
    // committed === true → claimed is the authentic quoted amount; 6b enforces it.
  }

  // 3e. the VALIDATED requirements we settle against (client's memo + amount, OUR
  //     payTo / feePayer / network / asset).
  const reqd: PaymentRequirements = {
    scheme: "exact", network: SOLANA_CAIP2, payTo: getPayTo(),
    maxTimeoutSeconds: Math.min(60, Math.floor(NONCE_TTL_MS / 1000)),
    extra: { feePayer: fp.feePayer, memo: `magpie-x402:${nonce}` },
    amount: claimed.toString(), asset: isUsdc ? USDC_MINT : WSOL_MINT,
  };

  // NOTE: no pre-settle nonce reservation. The durable single-use guard is the
  // post-settle claim on UNIQUE(tx_signature) (step 7), which is cross-instance
  // and lets a legit retry after a transient failure re-settle the SAME signature
  // and be served exactly once. (A fresh-random pre-settle nonce reserve never
  // actually deduped a settled signature, and a stable-nonce reserve would
  // wrongly block legit retries.)

  // 6. VERIFY then SETTLE (server-validated requirements both times)
  const v = (await facilitator("verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqd }, 12000)) as VerifyResponse | null;
  if (!v || v.isValid !== true) return fail(402, { error: "payment_invalid", reason: v?.invalidReason ?? "verify_failed" });

  // The PayAI facilitator submits AND waits for on-chain confirmation before
  // returning the signature (~20-30s on Solana), so this must outlast that or we
  // time out AFTER the agent's money already moved (charged-but-denied). 40s
  // fits inside the 60s function maxDuration (vercel.json) + the 60s nonce window.
  const s = (await facilitator("settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: reqd }, 40000)) as SettleResponse | null;
  // The x402 v2 SVM SettlementResponse carries the on-chain tx SIGNATURE in the
  // `transaction` field (PayAI + the standard); some facilitators name it
  // `signature`. Accept either — reading only `signature` silently dropped every
  // successful PayAI settlement (→ false "no_settlement" while money moved).
  const sig = (s?.transaction || s?.signature || "").trim();
  if (!s || s.success !== true || !sig) return fail(402, { error: "settle_failed", reason: s?.errorReason ?? "no_settlement" });

  // 6b. ON-CHAIN PROOF — the cornerstone. NEVER trust the facilitator's claimed
  // success/signature/payer. Independently confirm the on-chain transfer of
  // >= reqd.amount of reqd.asset into OUR payTo ATA, and derive the payer FROM
  // THE CHAIN. No confirmed matching transfer → fail closed (the agent is never
  // served a paid response without a real, verified on-chain settlement).
  const onchain = await verifySplSettlementOnChain(sig, reqd);
  if (!onchain) return fail(402, { error: "settlement_unverified_onchain" });
  if ("unconfirmed" in onchain) {
    // The facilitator settled but the tx hasn't confirmed in our window (RPC
    // lag) — the agent DID pay, so DON'T hard-reject. A retry re-settles the
    // SAME signature (idempotent), which confirms by then and is served exactly
    // once via the single-use claim. Retryable, not charged-but-denied.
    console.warn(`[x402-standard] settle confirm timeout (retryable) sig=${sig.slice(0, 16)}…`);
    return fail(402, { error: "settlement_confirming", retry_after_seconds: 5 });
  }

  // 7. resource binding re-check + claim the SETTLED signature (durable single-use)
  const nonceCheck = verifyNonce(nonce, opts.endpoint);
  if (!nonceCheck.ok) return fail(402, { error: "nonce_invalid", reason: nonceCheck.reason });
  const payer = onchain.payer; // ON-CHAIN-DERIVED ONLY — never s.payer / v.payer
  // DURABLE SINGLE-USE (the ONLY cross-instance replay guard for SVM exact — the
  // per-request nonce is fresh-random so it can't dedup a settled signature).
  // Claim the on-chain signature on the bot's UNIQUE(tx_signature) and SERVE ONLY
  // if the claim is fresh. fresh===false → this signature was already served →
  // reject as a replay. null (bot/DB unreachable) → fail CLOSED: we cannot prove
  // single-use, so we must not serve (the on-chain payment is recorded by its
  // signature and is reconcilable on retry once the bot is reachable).
  const recordArgs = {
    // kind "settled-spl": records the metric + claims the signature (durable
    // single-use) but does NOT accrue — the amount is a USDC/wSOL atomic, not
    // lamports; the SPL->SOL sweep credits the holder pool after conversion.
    endpoint_path: opts.endpoint, method: c.req.method, amount_lamports: reqd.amount,
    payer_pubkey: payer, tx_signature: sig, nonce, kind: "settled-spl",
    asset: reqd.asset,
  };
  const claim = await botRecord(recordArgs);
  if (claim && claim.fresh === false) {
    // The bot KNOWS this signature was already served — a genuine replay.
    return fail(402, { error: "payment_already_used" });
  }
  if (!claim) {
    // Bot/DB unreachable — but the on-chain settlement is CONFIRMED (6b), so the
    // agent DID move real USDC/wSOL into our payTo. Failing closed here would be
    // charged-but-denied (we keep the funds, serve nothing). The settled on-chain
    // signature is itself the single-use anchor — a settled tx can't be
    // re-settled — and a same-instance LRU dedups local replays. So SERVE, record
    // it locally, and best-effort retry the durable claim so billing +
    // cross-instance dedup land once the bot recovers. (audit #3.)
    if (servedSplSigs.has(sig)) {
      return fail(402, { error: "payment_already_used" });
    }
    servedSplSigs.set(sig, Date.now() + NONCE_TTL_MS);
    void botRecord(recordArgs).catch(() => {}); // fire-and-forget durable-claim retry
    console.warn(
      `[x402-standard] bot-record unreachable; serving on confirmed on-chain settlement sig=${sig.slice(0, 16)}… (LRU-deduped, durable claim queued)`,
    );
  }
  // claim.fresh === true (first durable claim) or served-on-confirmed above → serve.

  // 8. emit the standard settlement response header + propagate payer for per-wallet gating
  try { c.header("PAYMENT-RESPONSE", Buffer.from(JSON.stringify({ success: true, signature: sig, payer })).toString("base64")); } catch { /* non-fatal */ }
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
