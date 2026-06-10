# magpie-yield-bot

**Reference autonomous agent for the Magpie x402 API. Runs 24/7, rebalances SOL between idle wallet balance and the Magpie LendingPool, generates real on-chain protocol activity.**

This is the agent we run ourselves to demonstrate the API end-to-end. Fork it, change the trigger, ship your own.

## What it does

Every `TICK_INTERVAL_MS` (default 10 min):

1. Reads wallet SOL balance from chain.
2. Reads LP position via `GET /api/v1/agent/lp-state` (free).
3. Decides whether to rebalance toward `TARGET_LP_RATIO` (default 70%):
   - **Deposit** if LP share is below target by more than `REBALANCE_BAND` (5%) — calls `POST /api/v1/agent/build-deposit` (0.002 SOL).
   - **Withdraw** if above target — but refuses if pool utilization is above `HIGH_UTIL_PCT` (92%), to avoid pulling liquidity during a borrower squeeze. Calls `POST /api/v1/agent/build-withdraw` (0.002 SOL).
   - **Hold** otherwise.
4. Signs the returned tx locally, submits, logs the signature.

Every cycle prints a structured JSON line — easy to grep, easy to forward to a logging service.

## Safety properties

| Guard | Default | Why |
|---|---|---|
| `MIN_IDLE_SOL` | 0.02 SOL | Wallet always keeps enough for fees + future operations |
| `MIN_TX_SOL` | 0.01 SOL | Skip dust rebalances that cost more in fees than they earn |
| `MAX_DEPOSIT_SOL` | 1.0 SOL | Single-tick cap — a misconfigured target can't drain the wallet |
| `HIGH_UTIL_PCT` | 0.92 | Don't withdraw when other LPs are stretched supporting active borrows |
| `REBALANCE_BAND` | ±0.05 | Deadband around target — prevents constant churn from random walks |

## Deploy

### Railway (recommended — one-click)

1. Fork the [magpie-x402](https://github.com/magpiecapital/magpie-x402) repo.
2. In Railway, **New Project → Deploy from GitHub** → pick your fork.
3. Set the **Root Directory** to `agents/yield-bot`.
4. **Variables**:
   - `PAYER_SECRET_KEY_JSON` — paste the 64-byte secret-key array (Solana CLI `--outfile` JSON contents). Use a *dedicated* wallet, never your main wallet.
   - `SOLANA_RPC_URL` — your Helius/Triton/QuickNode URL (do not use public mainnet for 24/7 operation).
   - Optional overrides: `TARGET_LP_RATIO`, `MIN_IDLE_SOL`, etc. — see `.env.example`.
5. **Deploy.** First boot logs the wallet pubkey + target ratio to stderr, then begins ticking.

Fund the wallet with a small SOL float (e.g., 0.5–1.0 SOL) and watch the logs. First deposit should land within one tick.

### Local

```bash
git clone git@github.com:magpiecapital/magpie-x402.git
cd magpie-x402/agents/yield-bot
npm install
cp .env.example .env       # fill in PAYER_KEYPAIR + SOLANA_RPC_URL
npm run build
node --env-file=.env dist/index.js
```

### Docker / Fly.io / Kubernetes / anywhere

```bash
docker build -t magpie-yield-bot agents/yield-bot
docker run --rm -it \
  -e SOLANA_RPC_URL=https://your-rpc \
  -v /path/to/keypair.json:/etc/magpie/keypair.json:ro \
  -e PAYER_KEYPAIR=/etc/magpie/keypair.json \
  magpie-yield-bot
```

## Verifying it works

Watch the log stream. A healthy bot looks like:

```json
{"at":"2026-06-10T03:14:00Z","cycle":1,"wallet":"…","wallet_sol":0.487,"lp_value_sol":0.0,"lp_shares":"0","pool_utilization":0.745,"plan":"deposit","plan_reason":"lp ratio 0.0% below target by 70.0%","plan_amount_sol":0.467}
{"at":"2026-06-10T03:14:08Z","cycle":1,"action":"deposit","amount_sol":0.467,"tx":"5Hx…","explorer":"https://solscan.io/tx/5Hx…"}
{"at":"2026-06-10T03:24:00Z","cycle":2,"wallet":"…","wallet_sol":0.020,"lp_value_sol":0.467,"lp_shares":"…","pool_utilization":0.745,"plan":"hold","plan_reason":"within deadband (lp=95.9% target=70.0%)"}
```

Notice the deadband kicks in after the first deposit overshoots — it's by design, prevents churn.

After an hour you'll also see a cumulative report line:

```json
{"at":"…","cumulative":{"cycles":6,"deposited_sol":0.467,"withdrawn_shares":"0","x402_fees_paid_sol":0.002}}
```

## Cost model

| What you pay | Amount | Cadence |
|---|---|---|
| x402 build-deposit fee | 0.002 SOL | per deposit tick |
| x402 build-withdraw fee | 0.002 SOL | per withdraw tick |
| Solana network fee | ~0.000005 SOL | per submitted tx |
| Idle ticks (lp-state read) | Free | every TICK_INTERVAL_MS |

With default config (10 min tick, ±5% deadband, decent pool flow) you'll typically see 2–6 rebalances per day. At 6 × 0.002 = 0.012 SOL/day in fees, you need the LP yield to clear that bar to be profitable.

The bot logs every fee it pays in the hourly cumulative report — easy to subtract from yield earned (`yield_lamports` in the `/lp-state` response) to know your true net.

## Customizing the strategy

The decision logic is all in `planRebalance()` (in `src/index.ts`). Three things you might tune:

1. **Triggers** — instead of "rebalance when off-target," wire in:
   - Price-based (move out of LP when SOL price is rising → trade)
   - News/event-based (move out before scheduled volatility)
   - Cross-protocol (move out when another protocol offers higher yield)
2. **Target** — make `TARGET_LP_RATIO` dynamic. e.g., higher target when pool utilization is low (your share earns more), lower when utilization is squeezing borrowers.
3. **Cap** — `MAX_DEPOSIT_SOL` defaults to 1.0; raise it once you trust the bot.

The bot is intentionally simple. The hard part of running an agent is the *judgment*, not the API plumbing. We did the plumbing.

## Open source

MIT licensed. Fork freely, modify aggressively, ship to mainnet at your own risk.

The protocol itself is at [magpie.capital](https://magpie.capital). The API this bot uses is documented at [magpie.capital/x402](https://magpie.capital/x402). The MCP server that exposes these endpoints as native tools for Claude / Cursor / Windsurf is at [magpie-x402/mcp/](../../mcp/).
