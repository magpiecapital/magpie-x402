# x402 auth-surface review — 2026-06-09

Structural review of the x402 payment-required middleware and the on-chain payment verifier. Not a formal audit. Focus: how an agent could call a paid endpoint without paying, or reuse a single payment for multiple requests.

## What the design gets right

1. **HMAC-signed stateless nonces** — any function instance can validate any challenge without a shared store. Survives cold starts and horizontal scaling for the nonce side of the dedup story.
2. **Endpoint binding in the nonce** — an 8-byte HMAC fingerprint of the request path is part of the signed payload. A payment for `/api/v1/credit-score` cannot satisfy a `/api/v1/agent/build-borrow` even if the amounts happen to match.
3. **Constant-time MAC compare** — `timingSafeEqual` on both the nonce MAC and the endpoint fingerprint. No timing oracle on those bytes.
4. **On-chain re-derivation of every payment field** — amount, recipient, mint, payer are read from the parsed transaction, never trusted from the client.
5. **Native-SOL destination is verified by pubkey** — the System Program transfer instruction's `destination` field is compared directly to the expected recipient pubkey.
6. **Memo-program nonce extraction** — memo instructions are scanned across both outer and inner CPI instructions, so a CPI-style payment still validates.

## Findings

### Finding 1 — FIXED in this commit
**SPL token payments could be satisfied by transfers to any ATA.**

The SPL-token branch checked the mint and amount but NOT the destination ATA. Parsed token instructions surface `destination` as the ATA pubkey, not the recipient owner. An attacker could:

1. Choose any paid endpoint configured with an SPL-token price (none currently shipped).
2. Send the exact required amount of the right mint to *their own* ATA.
3. Add a memo with the magpie-x402 nonce.
4. Present that signature as `X-Payment` — the verifier would accept.

This is the only finding rated as a real bypass. No current endpoint sets `acceptedMint`, so the path was dormant. Made fail-closed in this commit:

```ts
return { valid: false, reason: "spl_token_payments_not_enabled" };
```

The comment block at the failure point documents the exact steps to safely enable SPL token payments later (add `@solana/spl-token`, derive the expected ATA via `getAssociatedTokenAddressSync(mint, recipient, true)`, add it to the check). Until those steps are taken, any future maintainer setting `acceptedMint` will get a 402 with a clear reason instead of an exploitable path.

### Finding 2 — known, documented in README, NOT fixed
**In-process signature dedup is per-instance.**

`consumedSignatures` is a per-process `Map<string, number>` in `src/middleware/x402.ts`. Under Vercel's horizontal scaling, a single on-chain payment signature could be used N times against N instances before any instance learns of the prior use.

Realistic exploitability today: low. Single-instance is the v0 deploy target per `README.md` ("Multi-instance considerations" section). At sustained >20 req/s the README already recommends switching to Vercel KV / Upstash Redis. Practical impact at current scale: zero or near-zero.

Mitigation paths, in increasing order of effort:
- Document the per-instance limit more loudly in the deploy guide (where the operator chooses Vercel plan + RPC).
- Add an `X402_DEDUP_BACKEND` env var that switches to Vercel KV / Upstash Redis when `redis://…` is configured. The interface is already a `Map`; swapping for a Redis-backed Map is a contained change.
- Switch to a shared backend unconditionally at first cold start, accept the small added latency.

Recommendation: do nothing until traffic justifies it; revisit when sustained throughput exceeds the single-instance threshold.

### Finding 3 — flagged, low-severity, NOT fixed
**Commitment level is `confirmed`, not `finalized`.**

`src/lib/solana.ts` opens its RPC connection at `confirmed`. Confirmed transactions are reorg-eligible until finalized (~13 seconds typical, occasional outliers). For x402, the failure mode is: an agent pays, gets the response, then the tx reorgs out — they received the response without a settled payment.

Practical exploitability: very low. Reorg depth at confirmed → finalized is rare on mainnet. The failure mode is "agent pays nothing, we serve once" — not a privilege escalation or systemic drain.

Recommendation: leave at `confirmed` for cheap reads (`credit-score`, etc.); consider upgrading high-stakes write builders (`build-borrow`, `intent` creation) to `finalized` if abuse is ever observed. Adds ~20s latency per call. Not worth doing prophylactically.

### Finding 4 — flagged, operational not security
**`pruneSignatures` runs in `setInterval`, doesn't fire on serverless.**

Serverless function instances are short-lived. The `setInterval(pruneSignatures, 60_000)` cleanup never executes, so the in-process `Map` grows unbounded per instance lifetime.

Real impact: bounded memory leak. Each consumed signature uses ~100 bytes; an instance that handles 10k requests holds ~1MB. Garbage collected at instance recycling. Not a security issue.

Recommendation: do nothing. If the per-instance dedup is ever replaced with a shared backend (Finding 2), this becomes moot.

### Finding 5 — flagged, fail-closed, operational only
**`X402_NONCE_SECRET` dev fallback generates random per-process secrets.**

If `X402_NONCE_SECRET` is unset, the module generates an ephemeral 32-byte secret per process and logs a one-time warning. Nonces minted under one cold start can't be validated by a different cold start.

Failure mode: legitimate clients see `nonce_invalid` after a deploy or cold-start churn — fail-closed, not exploitable.

Recommendation: leave the warning; rely on the existing deploy checklist in `README.md` (`vercel env add X402_NONCE_SECRET`). Optional hardening: refuse to start if the env var is missing in `NODE_ENV=production`.

## Areas explicitly NOT covered by this review

- The `magpie-bot` API token (`INTERNAL_API_TOKEN`) used by the proxy routes (`intents.ts`, `loan-manage.ts`, etc.) to talk to magpie-bot. Out of scope: that's an internal bearer token, not an x402 surface.
- The Anchor lending program itself. Reviewed separately.
- The Hono framework's CORS / secure-headers configuration. Looks standard but not re-audited line-by-line.
- The RPC provider trust model — a malicious / compromised RPC could return forged `getParsedTransaction` results. Mitigated by using paid providers (Helius / Triton / QuickNode) per the deploy guide.

## Sign-off

x402 auth surface review by Claude on behalf of the operator, 2026-06-09. Single fail-closed change shipped in the same commit; four advisory findings logged for future ops review.
