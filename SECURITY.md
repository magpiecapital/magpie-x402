# Security

Magpie x402 takes security seriously. This document describes the
posture of this service, the threat model, and how to report a
vulnerability.

## Threat model

This service is a **public, unauthenticated HTTP API** that:
- Returns **public protocol data** (credit scores, token risk, stats)
- Accepts **on-chain payment proofs** to gate access
- **Never holds, signs, or moves** user funds
- **Never has access to** Magpie's lender authority, deployer key, or
  any operator-controlled wallet

In-scope threats:
- Replay attacks on payment proofs → mitigated by single-use nonces
  bound to the payment memo
- Forged payment claims → mitigated by RPC-side re-derivation of
  amount, recipient, and mint from the on-chain tx
- DoS via cheap unauthenticated calls → mitigated by per-IP rate
  limiting on every endpoint
- Information leakage via error messages → mitigated by generic
  error responses that don't reveal verification logic
- Malformed input crashing the service → mitigated by strict input
  validation at every entry point

Out of scope:
- Compromise of the Magpie lender authority (separate concern, lives
  in the magpie-bot repo)
- Phishing of users (handled by the magpie-bot moderation pipeline)
- DeFi market risk (handled by the on-chain Magpie program)

## Operational guarantees

- **No secrets in source.** All sensitive config (RPC URLs, DB creds,
  payment recipient) is supplied via environment variables. `.env*`
  files are gitignored.
- **No keys stored.** This service only verifies incoming payments.
  It has no private keys, no signing capability, and cannot move
  funds. Even a full RCE on this host cannot drain a user.
- **Public data only.** Every response field corresponds to data
  already visible on-chain via solscan.io or in Magpie's public
  repositories.
- **Rate limited from day one.** Per-IP minute + hour buckets on
  every endpoint, including the free ones.
- **Source open.** Both source code and infrastructure config
  (Dockerfile, deployment specs) live in this public repo.

## Reporting a vulnerability

Open a GitHub issue with the `security` label OR email the
operator through https://magpie.capital/security. We respond within
24 hours and provide an initial assessment within 72 hours.

We do not take legal action against researchers following
responsible disclosure practices.

## Audits in progress

Magpie's smart-contract audit process is **actively underway**. Independent
security firms have been **engaged to review** the protocol's on-chain lending
programs; **reports will be published when complete**. The protocol is **not yet
audited** — please do not treat the absence of a published report as a completed
review.

| Firm | Engagement status |
| --- | --- |
| **Sec3** | Repository access granted; review underway (formal scope being finalized). |
| **Hashlock** | Invited (read-only access); engagement in progress. |
| **QuillAudits** | Invited (read-only access); engagement in progress. |
| **OtterSec** | Invited to audit; awaiting response. |
| **Neodyme** | Invited to audit; awaiting response. |

The audit-target program, `magpiecapital/magpie-v4`, is kept **private** during
pre-audit review, and every engaged firm is granted **read-only** access.
Completed reports will be published at **https://github.com/magpiecapital/audits**.

## Defense in depth

Patterns enforced in code:

1. **Outer-instruction validation** — payment verification iterates
   parsed instructions and validates programId + parsed type. We
   never trust client-supplied tx fields.
2. **Nonce single-use** — `consumedNonces` map enforces each
   challenge nonce is used at most once. Replayed payments fail.
3. **Time-bounded nonces** — challenges expire after 10 minutes,
   regardless of consumption status.
4. **Generic error messages** — no internal details (RPC version,
   stack traces, parser state) leak in error responses.
5. **Logging without PII** — service logs request paths + outcomes
   but never the wallet addresses queried or the payment signatures
   in cleartext.
6. **Security headers** — secure-headers middleware sets
   X-Content-Type-Options, Referrer-Policy, etc. on every response.
7. **Strict CORS** — production deployments should set
   `CORS_ORIGINS` to a strict allowlist rather than `*`.

## Production-deployment hardening

When deploying this service:

- Set `MAGPIE_PAY_TO` to a real treasury pubkey, not the operator's
  hot wallet.
- Use a paid RPC (Helius, Triton, QuickNode) — the public
  `api.mainnet-beta.solana.com` will rate-limit us out under any
  meaningful load.
- Put the service behind a reverse proxy (Vercel, Railway, Cloudflare)
  that handles TLS termination and edge-level DoS filtering.
- Set `CORS_ORIGINS` to your known agent callers, not `*`.
- Set conservative `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_PER_HOUR` values
  based on observed legitimate traffic.
- Run as a non-root user inside a container with a minimal base image.
- Pin all dependency versions and review `npm audit` output before
  every release.

## What this service does NOT do

- Does not custody user funds
- Does not sign transactions on behalf of users
- Does not store wallet private keys
- Does not have admin endpoints for arbitrary code execution
- Does not have a write path to Magpie's protocol database
- Does not communicate with the Telegram bot or any other Magpie
  service except via on-chain RPC queries
