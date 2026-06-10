# magpie-x402 examples

Turn-key agent code that talks to the live x402 API at `https://x402.magpie.capital`. Pick the one closest to what your agent does, clone, edit one or two values, run.

All examples are TypeScript, depend only on `@solana/web3.js`, and use the minimal client in [`lib/x402-client.ts`](./lib/x402-client.ts) (~150 lines, copy into your project).

## Quickstart

```bash
git clone git@github.com:magpiecapital/magpie-x402.git
cd magpie-x402
npm install

# Set the wallet your agent pays with (any keypair JSON file).
export X402_PAYER_KEYPAIR=~/.config/solana/id.json
export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"   # or any RPC

# Free — no payment.
npx tsx examples/02-liquidation-bot.ts
npx tsx examples/05-loan-monitor.ts <WALLET_PUBKEY>

# Paid — needs ~0.01 SOL in the payer wallet to cover a few calls.
npx tsx examples/01-fetch-credit-score.ts <WALLET_PUBKEY>
```

## The examples

| File | Cost | Endpoint(s) | What it shows |
|------|------|-------------|---------------|
| [01-fetch-credit-score.ts](./01-fetch-credit-score.ts) | 0.001 SOL | `GET /credit-score` | The simplest paid call — 402 → pay → retry → score |
| [02-liquidation-bot.ts](./02-liquidation-bot.ts) | free | `GET /markets/liquidatable` | Liquidation-bot scaffold polling past-due loans |
| [03-agent-borrow.ts](./03-agent-borrow.ts) | 0.005 SOL | `simulate-borrow` → `build-borrow` → `cosign-borrow` | Full borrow loop: preview, build, sign, submit |
| [04-conditional-borrow-intent.ts](./04-conditional-borrow-intent.ts) | 0.01 SOL + 0.0005/poll | `POST /agent/intent`, `GET /agent/intent` | "Limit order for a loan" — fires when a price/time/liquidity condition matches |
| [05-loan-monitor.ts](./05-loan-monitor.ts) | free | `GET /wallet/:wallet/loans` | Watch your loans, warn before due |
| [06-yield-agent.ts](./06-yield-agent.ts) | 0.002 SOL per build | `GET /agent/lp-state` + `POST /agent/build-deposit` / `build-withdraw` | Full LP loop: read position, deposit SOL, withdraw shares |

## Costs at a glance

| Endpoint | Cost (SOL) | Notes |
|----------|-----------|-------|
| `/api/v1/pool`, `/loan/:id`, `/wallet/:wallet/loans`, `/tiers`, `/simulate-borrow`, `/collateral/eligible`, `/markets/liquidatable` | free | Heavily cached |
| `/api/v1/credit-score` | 0.001 | Per lookup |
| `/api/v1/agent/credit-attest` | 0.0005 | Signed attestation portable to other protocols |
| `/api/v1/agent/build-repay` / `build-extend` / `build-topup` / `build-partial-repay` | 0.002 | Unsigned tx returned |
| `/api/v1/agent/build-deposit` / `build-withdraw` | 0.002 | LP-side: lend SOL into the pool or redeem shares |
| `/api/v1/agent/build-borrow` | 0.005 | Full anti-exploit gate eval included |
| `/api/v1/agent/intent` (create) | 0.01 | Single payment covers entire lifecycle |
| `/api/v1/agent/intent` (poll) | 0.0005 | |
| `/api/v1/agent/intents` (list) | 0.001 | |

## Patterns to copy

**Read first, pay second.** Use the free `/simulate-borrow` and `/pool` endpoints to make decisions before any paid call.

**Build, sign, submit are three separate steps.** The x402 service NEVER touches your keypair. It returns an unsigned `partial_signed_tx_b64`; your code signs locally and submits to the lender's cosign endpoint. A full RCE on the x402 service can't drain you.

**Idempotent retries are safe.** All paid endpoints validate the payment memo + on-chain tx server-side. If your retry logic accidentally pays twice for the same logical request, you've paid twice but you won't get charged the third time — the nonce blocks replay.

**Bundle cheap polls.** For intent-driven flows, polls are 0.0005 SOL each — keep poll interval ≥30s and you spend ~0.06 SOL/hr of polling, much less than the SOL value of a typical loan.

## Going further

- **Integrate as an SDK** — copy `lib/x402-client.ts` into your project. No npm package yet on purpose; this stays a single file you fully understand.
- **Webhook subscriptions** — coming in v0.2. Eliminates polling for intent + loan events.
- **LP-side endpoints** — shipped. See [`06-yield-agent.ts`](./06-yield-agent.ts) and `/api/v1/agent/build-deposit` / `/build-withdraw` / `/lp-state`.
- **MCP server** — coming in v0.3. Drop-in tools for Claude, ChatGPT, Cursor, and any MCP-aware agent host.

Open an issue on [magpie-x402](https://github.com/magpiecapital/magpie-x402/issues) to vote on what ships next.
