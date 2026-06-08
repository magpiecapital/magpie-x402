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
| GET | `/api/v1/credit-score?wallet=<pubkey>` | 0.001 SOL | Magpie credit score (300–850) + tier benefits |

More endpoints planned (token risk, simulated borrow quote, protocol stats snapshot, lender position data) — open an issue if you want one prioritized.

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
cp .env.example .env       # fill in MAGPIE_PAY_TO with a Solana pubkey
npm install
npm run dev                 # http://localhost:8402
```

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
