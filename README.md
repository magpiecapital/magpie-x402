# magpie-x402

**x402 payment-required API endpoints for the [Magpie Capital](https://magpie.capital) protocol.** AI agents and other Solana protocols can pay-per-call for credit scores, token risk assessments, and protocol analytics — no API keys, no signups, just a Solana payment.

```
                        AI agent
                            │
                            │  GET /api/v1/credit-score?wallet=…
                            ▼
                ┌────────────────────┐
                │ 402 Payment        │
                │ Required           │  ← scheme, recipient, amount, nonce
                └─────────┬──────────┘
                          │
                          │  Solana tx
                          ▼            (transfer to MAGPIE_PAY_TO
              ┌────────────────────┐    + memo `magpie-x402:<nonce>`)
              │ on-chain ↪ Solana  │
              └─────────┬──────────┘
                        │
                        │  retry GET with header X-Payment: <signature>
                        ▼
              ┌────────────────────┐
              │  Service verifies  │  ← amount, recipient, mint, memo nonce,
              │  payment on-chain  │    nonce not previously consumed
              └─────────┬──────────┘
                        │
                        ▼
                 { score, tier, … }
```

## What this is (and isn't)

- ✅ **An open standard implementation.** [x402](https://x402.dev) is HTTP 402 Payment Required, designed for AI-agent-payable APIs.
- ✅ **A revenue path for protocol data.** Magpie's credit oracle, token risk scores, and analytics are useful to OTHER protocols and agents — this is how they pay for that access.
- ✅ **Public-data-only.** Every response field corresponds to data already verifiable on-chain via [solscan.io](https://solscan.io) or in the [magpie-bot](https://github.com/magpiecapital/magpie-bot) source.
- ❌ **Not custodial.** This service holds no keys, signs no transactions, cannot move any user funds. Even a full RCE on this host can't drain a user — see [SECURITY.md](./SECURITY.md).

## Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| GET | `/` | Free | Service info + endpoint catalog |
| GET | `/health` | Free | Liveness check |
| GET | `/.well-known/x402.json` | Free | Machine-readable endpoint catalog (auto-discovery) |
| GET | `/openapi.json` | Free | OpenAPI 3.1 spec (for agent frameworks) |
| GET | `/api/v1/pool` | Free | Live on-chain LendingPool state — totalDeposits, totalBorrowed, lifetime counters. 15s cache. |
| GET | `/api/v1/pools` | Free | All three strategy pools (V1 memecoin / V3 RWA / V4 in-vault) in one call, with a `partial` map if any version is unreachable. 15s cache. |
| GET | `/api/v1/loan/:loanId?borrower=<pubkey>` | Free | Loans matching a u64 ID across V1/V3/V4. Returns a list (a borrower can hold the same numeric ID in more than one program) — each tagged with `program_version`. 10s cache. |
| GET | `/api/v1/loan/by-pda/:loanPda` | Free | Single loan by its PDA — unambiguous, routed to V1/V3/V4 from the on-chain owner. Returns `program_version`, V4 in-vault exit state, and `exits_supported`. 10s cache. |
| GET | `/api/v1/wallet/:wallet/loans?status=...` | Free | All loans owned by a wallet across V1/V3/V4 via `getProgramAccounts` + memcmp filter, each tagged with `program_version` (with a `by_version` count). Optional status filter. 8s cache. |
| GET | `/api/v1/collateral/eligible` | Free | Catalog of every token currently approved as Magpie collateral. First-touch for new agent integrations. 1h cache. |
| GET | `/api/v1/markets/liquidatable` | Free | Active loans at or past their on-chain due timestamp across V1/V3 — the canonical liquidation-bot data feed, each tagged with `program_version`. Sorted most-past-due-first. Optional `?within_seconds=` for pre-positioning, `?include_v4=true` to include in-vault V4 loans. 8s cache. |
| GET | `/api/v1/agent/activity` | Free | Anonymized recent borrow/repay/liquidate events. First-touch "is this protocol alive?" feed for arriving agents. 15s cache. |
| GET | `/api/v1/agent/protocol-pulse` | Free | 24h aggregates: active loans, active borrowers, borrow volume, liquidations. 30s cache. |
| GET | `/api/v1/agent/leaderboard` | Free | Top wallets by Magpie credit score, anonymized. 60s cache. |
| GET | `/api/v1/agent/lp-state?wallet=<pubkey>` | Free | Depositor position + pool context (shares, deposited, current value, yield, share-of-pool). 10s cache. |
| GET | `/api/v1/agent/self-limit-close/list?wallet=<pubkey>` | Free | A wallet's armed in-vault exit orders (TP/SL) on its V4 loans. |
| GET | `/api/v1/credit-score?wallet=<pubkey>` | 0.001 SOL | Magpie credit score (300–850) + tier benefits |
| POST | `/api/v1/agent/build-borrow` | 0.005 SOL | Build an unsigned borrow tx. Pass `has_exit_arming: true` to route to the V4 in-vault program (so exit orders can be armed on the loan); otherwise routes to V1 (memecoin) — and, once it launches, V3 (RWA). |
| POST | `/api/v1/agent/build-deposit` | 0.002 SOL | Build an unsigned LP-deposit tx (SOL → pool). Caller signs and submits. |
| POST | `/api/v1/agent/build-withdraw` | 0.002 SOL | Build an unsigned LP-withdraw tx (shares → SOL). Server validates against the on-chain position and refuses unsafe chunk sizes. |
| POST | `/api/v1/agent/self-limit-close/arm` | 0.001 SOL | Arm an in-vault take-profit / stop-loss on your OWN V4 loan. Body is an Ed25519 signed envelope; pays AND signs with the same keypair, so payer == signer. Bot enforces ownership + V4-only. |
| POST | `/api/v1/agent/self-limit-close/modify` | Free | Modify an armed exit order (signed envelope). |
| POST | `/api/v1/agent/self-limit-close/cancel` | Free | Cancel an armed exit order (signed envelope). |

All free endpoints query the on-chain Magpie program directly and have proper `Cache-Control` headers so CDN edges serve repeat reads without round-tripping.

Loan and pool reads are **multi-version**: every loan/pool is resolved across the V1 (memecoin), V3 (RWA — on the V3 launch), and V4 (in-vault auto-sell) programs and tagged with its `program_version`. These reads fail soft — if one version is unreachable, the rest still return and the affected version is reported in a `partial` map rather than erroring the whole call. The `/api/v1/agent/self-limit-close/*` surface lets a borrower-agent arm, modify, cancel, and list **self-owned** in-vault exit orders (take-profit / stop-loss) on its own V4 loans, authenticated by an Ed25519 signed envelope where the x402 payer is also the envelope signer.

> 🚀 **Building your first Magpie agent?** Read [`QUICKSTART.md`](./QUICKSTART.md) — zero to a working autonomous borrow agent on Solana in 10 minutes, using the typed SDK.
>
> 📦 **TypeScript SDK** (`@magpieloans/magpie-agent`): every action as a one-liner. Borrow, lend, liquidate, post conditional intents — no HTTP plumbing. See [`sdk/README.md`](./sdk/README.md).
>
> 🧩 **MCP server** for Claude Desktop / Cursor / Windsurf / ChatGPT desktop: one config block, 26 tools. See [`mcp/README.md`](./mcp/README.md).
>
> 🎯 **Limit-close agent quickstart** — full end-to-end walkthrough for agents that arm, monitor, and steer limit-close (TP/SL) orders on borrowers' loans. Authorization flow, every endpoint, sample code, error reference, best practices. See [`docs/AGENT_QUICKSTART_LIMIT_CLOSE.md`](./docs/AGENT_QUICKSTART_LIMIT_CLOSE.md).
>
> 👉 **Just want code examples?** [`/examples/`](./examples/) — 13 turn-key TypeScript agents (credit fetch, liquidation keeper, full borrow loop, conditional intent, yield agent, webhook receiver, collateral screener, equity-leverage preview, more) that talk to the live production endpoint. Each is a single file, runs with `npx tsx`.
>
> 🧩 **Using Claude Desktop, Cursor, Windsurf, or ChatGPT desktop?** [`/mcp/`](./mcp/) ships a one-config-block MCP server that exposes the full API as native tools in your agent host. Free reads work without any keypair; paid endpoints sign x402 payments locally with a configured Solana wallet.

More paid endpoints in progress (token risk score, batch credit lookups, webhook subscriptions, MCP server, LP-side build-deposit / build-withdraw) — see [MARKETING.md](./MARKETING.md) for the agent-distribution roadmap or open an issue if you want one prioritized.

## How to call a paid endpoint

### Step 1 — get the challenge

```bash
curl -i https://x402.magpie.capital/api/v1/credit-score?wallet=9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump
```

Response:

```http
HTTP/2 402
X-Payment-Required-Scheme: x402/solana/v1
X-Payment-Required-Amount: 1000000
X-Payment-Required-Recipient: <MAGPIE_PAY_TO pubkey>
X-Payment-Required-Nonce: a1b2c3...
X-Payment-Required-Memo: magpie-x402:a1b2c3...

{
  "error": "payment_required",
  "scheme": "x402/solana/v1",
  "payTo": "...",
  "amountLamports": "1000000",
  "nonce": "a1b2c3...",
  "memo": "magpie-x402:a1b2c3...",
  "instructions": "Send 1000000 lamports of SOL to ... with memo 'magpie-x402:...', then retry with header X-PAYMENT: <tx_signature>"
}
```

### Step 2 — pay on Solana

Send a `SystemProgram::transfer` (or SPL Token transfer) for the exact amount to the recipient pubkey, with the **memo** instruction containing the challenge string. Confirm.

### Step 3 — retry with the signature

```bash
curl -i \
  -H "X-Payment: <your_tx_signature>" \
  https://x402.magpie.capital/api/v1/credit-score?wallet=9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump
```

Response:

```json
{
  "wallet": "9UuLsJ...",
  "score": 712,
  "tier": "gold",
  "range": { "min": 300, "max": 850 },
  "benefits": { "maxLtvPercent": 35, "minFeeRate": 0.0125, "maxDurationDays": 14 },
  "source": "magpie-credit-oracle"
}
```

## Local development

```bash
git clone git@github.com:magpiecapital/magpie-x402.git
cd magpie-x402
cp .env.example .env       # fill in MAGPIE_PAY_TO + MAGPIE_LENDER_PUBKEY
npm install
npm run dev                 # http://localhost:8402
```

## Deploy to Vercel (1-click)

The repo is structured for Vercel serverless out of the box:
- `api/index.ts` — Vercel-native entry, handles every request via `hono/vercel` adapter
- `vercel.json` — routes all paths to `/api`
- `src/app.ts` — the shared Hono app (also used by local dev)
- `src/index.ts` — local-dev Node server (NOT used by Vercel)

### Step-by-step

1. **In the Vercel dashboard, click "Add New" → "Project"**
2. **Import `magpiecapital/magpie-x402` from GitHub**
3. **Framework Preset:** "Other" (Vercel auto-detects via vercel.json)
4. **Set Environment Variables** (Production + Preview + Development):
   - `MAGPIE_PAY_TO` — your Solana treasury pubkey
   - `MAGPIE_LENDER_PUBKEY` — the Magpie lender authority
   - `SOLANA_RPC_URL` — use a paid Helius/Triton/QuickNode URL for speed (public RPC will rate-limit you)
   - `CORS_ORIGINS` — comma-separated allowlist (use `*` only during testing)
   - `RATE_LIMIT_PER_MIN` and `RATE_LIMIT_PER_HOUR` — tune per traffic
5. **Click Deploy.** First build runs `npm install && npm run build` (or just `npm install` since Vercel handles TS) — ~1 minute.
6. **Test:** `curl https://<your-deployment>.vercel.app/api/v1/pool`

### Custom domain

After the first deploy, in **Settings → Domains** attach `x402.magpie.capital` (or any subdomain you control). Vercel handles the TLS cert automatically.

### Why Node runtime, not Edge

`@solana/web3.js` depends on Buffer + Node crypto primitives that don't ship in Vercel's Edge runtime. Once `@solana/kit` (web3.js v2) stabilizes for Edge, switching gets us another latency win — but Node serverless is plenty fast for v0 (cold start ~150–250ms, warm <10ms server-side).

### Multi-instance considerations (caveat for high-scale deploys)

The in-memory nonce store (in `src/middleware/x402.ts`) and rate-limit buckets are per-instance. At low traffic, Vercel runs a single warm instance and this works fine. At high concurrency, Vercel scales horizontally — a payment challenge issued by instance A might fail validation on instance B because B hasn't seen the nonce.

When that becomes a problem (it isn't for v0 — but if you push >20 req/s sustained, plan for it):
- **Option 1:** HMAC-sign the nonces with a server secret. Stateless, infinitely scalable, no external dependency.
- **Option 2:** Wire Vercel KV (Upstash Redis) for shared state. Drop-in via `@vercel/kv`.

Both paths sketched in `SECURITY.md` under "production hardening".

## Security

See [SECURITY.md](./SECURITY.md) for the full posture. Highlights:

- **No keys ever stored or signed.** This service verifies incoming payments only.
- **No secrets in source.** All config via env vars; `.env` is gitignored; `.gitignore` excludes any file matching `*keypair*.json`, `*.pem`, `*.key`, etc.
- **Replay-resistant.** Single-use nonces bound to payment memos.
- **On-chain re-derivation.** Amount, recipient, and mint are always re-read from the on-chain transaction — never trusted from the client.
- **Rate-limited from day one** — per-IP minute + hour buckets on every endpoint.
- **Generic error responses** — verification logic isn't leaked through error messages.

To report a vulnerability: open a GitHub issue tagged `security`, or contact us via https://magpie.capital/security.

## Related repos

- [magpiecapital/magpie-bot](https://github.com/magpiecapital/magpie-bot) — the Telegram wallet bot + Anchor programs
- [magpiecapital/magpie-site](https://github.com/magpiecapital/magpie-site) — the web app
- [Magpie Capital](https://magpie.capital) — protocol overview + live stats

## License

MIT — see [LICENSE](./LICENSE).
