# Magpie Reference Borrowing Agent

A **standalone, production-deployable** agent that automatically finds and executes borrowing opportunities on the [Magpie Capital](https://magpie.capital) lending protocol. Part of the [magpie-x402](https://github.com/magpiecapital/magpie-x402) bounty program.

> **Bounty:** $500–$1,000 — Reference Borrowing Agent (Issue [#5](https://github.com/magpiecapital/magpie-x402/issues/5))

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Magpie Borrowing Agent                     │
│                                                             │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Config  │──▶│  Agent Loop  │──▶│  Strategy Engine   │  │
│  │  (Zod)   │   │  (interval)  │   │  (rules + scoring) │  │
│  └──────────┘   └──────┬───────┘   └─────────┬──────────┘  │
│                        │                      │             │
│         ┌──────────────┴──────────────────────┘             │
│         ▼                                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Magpie x402 Service (SDK)               │    │
│  │  ┌──────────┐  ┌───────────┐  ┌───────────────────┐ │    │
│  │  │ Catalog  │  │ Simulate  │  │  Build-Borrow     │ │    │
│  │  │ (free)   │  │ (free)    │  │  (x402 paid)      │ │    │
│  │  └──────────┘  └───────────┘  └────────┬──────────┘ │    │
│  │                                        │             │    │
│  │  ┌─────────────────────────────────────┘             │    │
│  │  ▼                                                     │    │
│  │  ┌───────────┐  ┌────────────────┐  ┌──────────────┐  │    │
│  │  │ Sign Tx   │──▶│ Cosign-Borrow │──▶│ On-Chain     │  │    │
│  │  │ (local)   │  │ (free)         │  │ Confirmation  │  │    │
│  │  └───────────┘  └────────────────┘  └──────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
│                        │                                     │
│                        ▼                                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              Position Manager                        │    │
│  │  ┌──────────────────┐  ┌────────────────────────┐   │    │
│  │  │ Open Positions   │  │ On-Chain Reconciliation│   │    │
│  │  │ (in memory)      │  │ (SDK walletLoans)      │   │    │
│  │  └──────────────────┘  └────────────────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              JSON Logger → stdout                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Agent Flow (per cycle)

```
1. Fetch Collateral Catalog  ── GET /api/v1/collateral/eligible  (FREE)
2. Fetch Token Prices        ── Jupiter Price API                (FREE)
3. Simulate Borrow           ── GET /api/v1/simulate-borrow      (FREE)
4. Apply Strategy Rules      ── Price threshold, diversity,
                                max positions, value limits
5. Select Best Candidate     ── Highest 24h gain that passes all
                                rules
6. Execute Borrow            ── POST /api/v1/agent/build-borrow  (x402 paid)
                                → Sign transaction locally
                                → POST /api/v1/cosign-borrow     (FREE)
7. Track Position            ── Add to in-memory position manager
8. Wait CHECK_INTERVAL       ── Repeat from step 1
```

### x402 Payment Flow

The x402 protocol is used for paid endpoints (build-borrow at 0.005 SOL):

```
Request ──▶ 402 Payment Required ──▶ Pay on Solana (transfer + memo)
              │                           │
              │                           ▼
              │                   Retry with X-Payment header
              │                           │
              ▼                           ▼
          (free path)              Get signed transaction
```

The SDK (`@magpieloans/magpie-agent`) handles this automatically. The agent never sends its private key to the server — only the signed transaction is submitted.

---

## Strategy

### Core Principle: Borrow when Collateral is Appreciating

The agent borrows SOL against tokens that are **up in price** — the same strategy a human trader would use: collateralize winners, not losers.

### Strategy Rules

| Rule | Default | Description |
|------|---------|-------------|
| `MIN_PRICE_CHANGE_PCT` | 5.0% | Only borrow when collateral is up at least this much in 24h |
| `MAX_PRICE_CHANGE_PCT` | 50.0% | Skip tokens that have already mooned (FOMO guard) |
| `MAX_POSITIONS` | 3 | Max concurrent open loan positions |
| `ENFORCE_DIVERSITY` | true | Never borrow against the same mint twice |
| `MAX_COLLATERAL_VALUE_SOL` | 5.0 SOL | Max collateral value per position |
| `MIN_COLLATERAL_VALUE_SOL` | 0.1 SOL | Skip dust positions |

### Candidate Selection

1. **Filter** — Remove candidates that fail any strategy rule
2. **Score** — Sort remaining by 24h price change (descending)
3. **Select** — Pick the highest-scoring candidate
4. **Execute** — Build, sign, and submit the borrow transaction

### Risk Management

- **No repeated mints**: Diversity prevents over-exposure to any single token
- **Position limits**: Hard cap on concurrent positions
- **Price ceilings**: Don't chase parabolic moves
- **Graceful shutdown**: SIGTERM/SIGINT cleanly stops the loop mid-cycle
- **Retry logic**: Exponential backoff (1s → 2s → 4s → ... → 30s max) on transient failures
- **On-chain reconciliation**: On restart, reads existing loans from the blockchain

---

## 3-Step Setup

### Prerequisites

- Node.js >= 20
- A Solana keypair (generated with `solana-keygen new` or any wallet export)
- SOL for gas + the 0.005 SOL x402 fee per borrow

### Step 1: Configure

```bash
cd examples/agent-borrower
cp .env.example .env
```

Edit `.env` to set:

```bash
# REQUIRED: Your signing key (pick one)
MAGPIE_PAYER_SECRET=<base58-or-json-secret>  # for Docker/Railway
# OR
MAGPIE_PAYER_KEYPAIR=~/.config/solana/id.json  # for local dev

# REQUIRED: Solana RPC
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

### Step 2: Install & Run

```bash
npm install
npx tsx agent.ts
```

### Step 3: Deploy (Docker)

```bash
docker build -t magpie-agent-borrower .
docker run --env-file .env magpie-agent-borrower
```

Or on **Railway**: Connect your fork, set the root as `examples/agent-borrower`, and add env vars in the dashboard.

---

## Configuration Reference

All configuration is done via environment variables, validated by Zod at startup.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAGPIE_PAYER_SECRET` | One of | — | Base58 or JSON array of the agent signing key |
| `MAGPIE_PAYER_KEYPAIR` | One of | — | Path to keypair JSON file |
| `SOLANA_RPC_URL` | Yes | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `X402_BASE_URL` | No | `https://x402.magpie.capital` | x402 payment service |
| `MAGPIE_SITE_URL` | No | `https://www.magpie.capital` | Cosign endpoint host |
| `CHECK_INTERVAL` | No | `300` | Agent loop interval (seconds) |
| `RETRY_DELAY_SECONDS` | No | `30` | Delay after error before retry |
| `MAX_POSITIONS` | No | `3` | Max concurrent loan positions |
| `MIN_PRICE_CHANGE_PCT` | No | `5.0` | Min 24h price increase to borrow |
| `MAX_PRICE_CHANGE_PCT` | No | `50.0` | Max 24h price increase (FOMO guard) |
| `MAX_COLLATERAL_VALUE_SOL` | No | `5.0` | Max collateral value per position |
| `MIN_COLLATERAL_VALUE_SOL` | No | `0.1` | Min collateral value to borrow |
| `BORROW_TIER` | No | `standard` | `express` (2d), `quick` (3d), `standard` (7d) |
| `USE_V4_EXITS` | No | `true` | Use V4 program for exit support |
| `ENFORCE_DIVERSITY` | No | `true` | Prevent duplicate mint borrowing |
| `X402_MAX_PAYMENT_LAMPORTS` | No | `20000000` | Max x402 payment (0.02 SOL) |
| `X402_ALLOWED_RECIPIENTS` | No | — | Comma-separated payment allowlist |
| `MINT_ALLOWLIST` | No | — | Comma-separated allowed collateral mints |
| `LOG_LEVEL` | No | `info` | `info`, `warn`, `error`, `debug` |

---

## Logging

The agent writes **JSON Lines** to stdout — compatible with any log aggregator (Datadog, Loki, CloudWatch):

```json
{"timestamp":"2026-07-03T20:00:00.000Z","level":"info","msg":"Selected candidate for borrow","symbol":"BONK","mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","borrowableLamports":"1000000000","priceChange24hPct":12.5}
```

Each log line includes:
- `timestamp` — ISO 8601
- `level` — info/warn/error/debug
- `msg` — Human-readable message
- `agent` — Always `"magpie-agent-borrower"`
- Additional context fields per event

---

## Project Structure

```
examples/agent-borrower/
├── agent.ts          # Main orchestrator (684 lines)
├── package.json      # Dependencies
├── tsconfig.json     # TypeScript strict config
├── Dockerfile        # Multi-stage distroless build
├── .env.example      # All config vars documented
└── README.md         # This file
```

### Key Design Decisions

- **Zod for config**: All env vars are typed and validated at startup
- **SDK integration**: Uses `@magpieloans/magpie-agent` for all Magpie protocol interactions
- **Inline base58**: No extra dependency for key decoding — works with bs58 or JSON arrays
- **Jupiter price feed**: Fetches real-time token prices from Jupiter's free API
- **Exponential backoff**: Retry wrapper handles transient failures gracefully
- **Graceful shutdown**: Completes the current operation before stopping
- **Distroless Docker**: Minimal attack surface for production deployment

---

## Related Repositories

- [magpie-x402](https://github.com/magpiecapital/magpie-x402) — Magpie Capital x402 API
- [@magpieloans/magpie-agent](https://www.npmjs.com/package/@magpieloans/magpie-agent) — Official SDK
- [Autonomous Agent](https://github.com/magpiecapital/magpie-x402/tree/main/examples/autonomous-agent) — Full-featured agent reference

---

*Built for the Magpie Capital bounty program — Issue [#5](https://github.com/magpiecapital/magpie-x402/issues/5)*
