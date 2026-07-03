# Magpie x402 — Reference Liquidation Bot

**Bounty:** [$1,000–2,000](https://github.com/magpiecapital/magpie-x402/issues/5)

A production-grade liquidation (keeper) bot for [Magpie Capital](https://magpie.capital)'s x402 permissionless lending protocol on Solana. Polls the liquidatable-loan feed, profit-checks every candidate, builds a signed liquidation transaction via the x402 API, signs locally, and submits on-chain.

## How it works

```
                      ┌──────────────────────┐
                      │  Every POLL_INTERVAL  │
                      │  (default 8 seconds)  │
                      └──────────┬───────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ GET /api/v1/markets/    │
                    │    liquidatable  (FREE) │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Filter + profit-check   │
                    │ Skip if:                │
                    │  • on cooldown          │
                    │  • not past-due enough  │
                    │  • keeper reward < gas  │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Pick most-past-due loan │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ POST /api/v1/agent/     │
                    │   build-liquidate (PAID)│
                    │   → 402 → pay 0.003 SOL │
                    │   → retry → get signed  │
                    │     partial tx          │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Sign locally + submit   │
                    │ to Solana               │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ Log result + track      │
                    │ keeper reward           │
                    └─────────────────────────┘
```

## Profit calculation

The bot only liquidates a loan when the **estimated keeper reward exceeds the transaction cost:**

```
keeper_reward_lamports = (borrowed_lamports × keeperRewardBps) / 10_000

profitable = keeper_reward_lamports >= GAS_COST_LAMPORTS + MIN_KEEPER_REWARD_LAMPORTS
```

- `keeperRewardBps` — fetched from `GET /api/v1/pool` (default 500 bps = 5% of seized value)
- `borrowed_lamports` — the loan's outstanding principal
- `GAS_COST_LAMPORTS` — estimated Solana tx fee (default 5,000 lamports)
- `MIN_KEEPER_REWARD_LAMPORTS` — minimum profit threshold (default 10,000 lamports)

Loans below the threshold are skipped and logged with their estimated reward.

## Setup (3 steps)

### 1. Clone and install

```bash
git clone https://github.com/scotia1973-bot/magpie-x402.git
cd magpie-x402/examples/agent-liquidator
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# A Solana keypair JSON file (created with `solana-keygen new`)
X402_PAYER_KEYPAIR=/home/user/.config/solana/id.json

# Solana RPC endpoint (Helius, QuickNode, or public mainnet-beta)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

### 3. Run the bot

```bash
X402_PAYER_KEYPAIR=~/.config/solana/id.json \
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  npx tsx liquidator.ts
```

Or with environment variables from `.env`:

```bash
export $(grep -v '^#' .env | xargs)
npx tsx liquidator.ts
```

### Docker

```bash
# Build from the examples/ directory so the lib/x402-client.ts is accessible
cd ../..
docker build -f examples/agent-liquidator/Dockerfile -t magpie-liquidator examples/agent-liquidator

docker run --env-file examples/agent-liquidator/.env magpie-liquidator
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `X402_PAYER_KEYPAIR` | ✅ | — | Path to Solana keypair JSON file |
| `SOLANA_RPC_URL` | ✅ | — | Solana RPC endpoint |
| `X402_BASE_URL` | — | `https://x402.magpie.capital` | x402 API base URL |
| `POLL_INTERVAL_MS` | — | `8000` | Polling interval in milliseconds |
| `MIN_PAST_DUE_SEC` | — | `0` | Min seconds past due before attempting |
| `MIN_KEEPER_REWARD_LAMPORTS` | — | `10000` | Minimum keeper reward to attempt |
| `GAS_COST_LAMPORTS` | — | `5000` | Estimated gas cost per transaction |
| `LOG_LEVEL` | — | `info` | `info`, `debug`, or `quiet` |

## Output

All logs are **structured JSON** for easy ingestion by log shippers (CloudWatch, Datadog, ELK, etc.).

Example success:
```json
{"ts":"2026-07-03T12:34:56.789Z","level":"info","msg":"Liquidation successful","loan_id":"abc123","loan_pda":"6x9p...","tx_signature":"5KtN...","solscan_url":"https://solscan.io/tx/5KtN...","keeper_reward_estimated_lamports":50000,"daily_rewards_lamports":150000,"total_attempts":3,"total_successes":1,"total_failures":1,"total_skipped":1}
```

## Safety features

- **Cooldown per loan PDA** — prevents racing the same loan across multiple poll cycles (2-minute cooldown by default)
- **Profitability gate** — skips loans where keeper reward doesn't cover gas + minimum margin
- **Graceful shutdown** — traps SIGINT/SIGTERM, persists daily rewards, drains in-flight operations
- **JSON logging** — all output is parseable JSON; no mixed plain-text output
- **Error isolation** — every x402 call, tx build, and submit is individually try/caught; one failure doesn't stop the bot

## File structure

```
examples/agent-liquidator/
├── .env.example       # Environment variable template
├── Dockerfile         # Multi-stage distroless build
├── liquidator.ts      # Main bot (the agent loop)
├── package.json       # Dependencies
├── tsconfig.json      # Strict TypeScript config
└── README.md          # This file
```

## Economics

- **Cost per attempt:** 0.003 SOL (x402 build fee) + ~0.000005 SOL (network tx fee)
- **Revenue per liquidation:** keeper reward (a percentage of seized collateral, paid in collateral token)
- **Break-even:** ~1 liquidation per 1,000 SOL borrowed at 5% keeper reward (0.003 SOL build cost / (0.05 × borrowed))
- **Keeper reward is paid in the collateral token**, not SOL. The bot leaves seized tokens in the keeper's associated token account (ATA); swap externally or via Jupiter.
