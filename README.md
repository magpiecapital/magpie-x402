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