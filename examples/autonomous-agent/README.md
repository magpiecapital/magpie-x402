# Autonomous Magpie agent — *never-default by design*

A runnable **starter** for a self-driving agent that researches, **buys** a token (on Jupiter), **collateralizes** it on Magpie for SOL, and — above all — **always repays on time so nothing ever defaults.**

> The whole thing is built around one fact: **on Magpie you only lose your collateral if a loan goes *overdue* (liquidation is time-based, not price-based).** So the agent's #1 job isn't picking winners — it's never missing a deadline. This scaffold makes that the load-bearing guarantee.

## The three bricks
Magpie is the **bank** (lends SOL against a token you already hold) — it is **not** a DEX. So:
1. 🧠 **Brain** — decides what to buy (`agent.ts` `chooseCandidate()`; swap in an LLM).
2. 🏪 **Buy** — `jupiter.ts` (Jupiter Ultra). The token must exist in the wallet *before* you can borrow against it.
3. 🏦 **Collateralize + never-default** — `loan-guardian.ts` + the Magpie SDK.

## Files
| File | Role |
|---|---|
| `magpie-playbook.ts` | The agent's **mental model** of Magpie — facts the code enforces + a `SYSTEM_PROMPT` to give an LLM brain so it *understands* the protocol. |
| `loan-guardian.ts` | **The never-default engine.** Reserves repay SOL, repays early, retries forever. |
| `holdings.ts` | What the wallet ALREADY holds that Magpie accepts — borrow against it directly, no buy. |
| `repay.ts` | The repay leg via x402 `build-repay` (the published SDK has no `repay()` yet). |
| `jupiter.ts` | The buy step (the one integration outside Magpie). |
| `x402-client.ts` | Minimal x402 paid-call client (vendored so this folder deploys standalone). |
| `brain.ts` | The optional Claude decision brain (proposes; the safety layer disposes). |
| `notifier.ts` | Passive monitoring — DMs every action to Telegram (console fallback). |
| `config.ts` | Every safety knob; every default is the safe choice. |
| `agent.ts` | Orchestrator: guard-first, then a continuous research → buy → collateralize loop. |
| `Dockerfile` · `package.json` · `.env.example` | Standalone deploy (Railway / any container host). |

## Run it (continuous, monitored)
The agent runs a **continuous loop**: the guardian protects every loan for the whole
process lifetime, and a research cycle fires every `CYCLE_INTERVAL_MIN` to maybe open a
new position — always inside the solvency reserve + `MAX_OPEN_LOANS`. Every action is
DM'd so you can watch it passively. **Always start in dry-run.**

```bash
cd examples/autonomous-agent && npm install

# 1) Rehearse continuously — free, safe, nothing moves (real reads + decisions):
MAGPIE_PAYER_KEYPAIR=~/.config/solana/agent-wallet.json \
  CYCLE_INTERVAL_MIN=2 npm start          # fast cadence to preview; Ctrl-C to stop

# 2) Go live — actively trades memecoins + RWAs, spends real funds:
LIVE=1 OPEN_UNIVERSE=true PREFERRED_CATEGORY=any \
  MAGPIE_PAYER_KEYPAIR=~/.config/solana/agent-wallet.json \
  ANTHROPIC_API_KEY=sk-ant-... npm start
```
Use a **dedicated allowance wallet** funded with only what you're willing to risk (e.g. $500) — never your main wallet.

## Deploy always-on (Railway)
Run it 24/7 so you truly monitor passively. The key is set as a **secret env var** —
it lives only in this process; Magpie never sees it.

1. New Railway service → point it at this repo, **Root Directory** `examples/autonomous-agent`.
2. Set Variables (see `.env.example`). Minimum to go live:
   - `MAGPIE_PAYER_SECRET` — the agent wallet key (bs58 **or** a JSON byte array)
   - `SOLANA_RPC_URL` — a paid RPC (Helius/Triton) for an always-on agent
   - `ANTHROPIC_API_KEY` — the Claude brain (optional; falls back to a deterministic picker)
   - `LIVE=1`, `OPEN_UNIVERSE=true`, `PREFERRED_CATEGORY=any`
   - `AGENT_NOTIFY_TELEGRAM_TOKEN` + `AGENT_NOTIFY_TELEGRAM_CHAT` — for the DMs
3. **Deploy with `LIVE` unset first** (dry-run). Watch the DMs for a few cycles, confirm the
   decisions look sane, then add `LIVE=1` and redeploy.

> Repay path: the published `@magpieloans/magpie-agent` (0.1.x) has **no `repay()`**, so the
> guardian repays via the x402 `build-repay` HTTP endpoint (`repay.ts`). Borrow + reads use
> the SDK. When the SDK ships `repay()`, `repay.ts` can be swapped for `agent.repay()`.

## How "never default" is guaranteed
The `LoanGuardian` holds three invariants:
1. **Reserve before risk.** `deployableLamports() = liquid − (Σ every open loan's full gross repay + gas buffer)`. The agent may only ever spend *deployable* — the repay money is structurally untouchable.
2. **Repay early, not late.** Each loan is repaid once it enters its lead window (default: **halfway through the term**, min 6h before due) — leaving huge margin for RPC blips and retries.
3. **Repay is sacred.** `repayForever()` retries through transient failures with backoff until the chain confirms the loan is closed. It never surrenders, because a default is a total, unrecoverable loss of collateral.

The guardian **starts first** and runs for the whole process, so it protects pre-existing loans too — even if the trading brain crashes, deadlines are still honored.

## Make it safe (defaults already do most of this)
- `PREFERRED_CATEGORY=rwa` — tokenized stocks (lower vol, longer terms) over memecoins.
- `ALLOW_RECURSIVE_REDEPLOY=false` — borrowed SOL is **held as repay reserve**, not re-leveraged. This is the switch that keeps the strategy from bleeding out.
- `MAX_OPEN_LOANS=1`, `REPAY_LEAD_FRACTION=0.5`, `TIER=standard` (7-day term = most headroom).
- `MINT_ALLOWLIST` is **required in live** — the agent will buy nothing it isn't explicitly allowed to, and gates every candidate through paid `token_risk`.

## The Claude brain (built in — `brain.ts`)
`brain.ts` is a Claude-driven selector: it's fed the `SYSTEM_PROMPT` (so it understands time-based liquidation, full-gross repay, never-default), researches with read tools (`assess_token_risk`, `get_pool_state`), and proposes a pick **from the allowed menu** — or says HOLD. The model *proposes*; the deterministic layer (allowlist → risk gate → solvency reserve → guardian) *disposes* and always has the final word. The model can never invent a mint or bypass a safety check.

Turn it on:
```bash
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
# auto-enables when the key is present; force with USE_LLM_BRAIN=true / off with =false
# default model claude-sonnet-4-6 — override: MAGPIE_BRAIN_MODEL=claude-opus-4-8
```
No key? The agent falls back to the deterministic picker automatically (verified).

## ⚠️ Before going live
- `jupiter.ts` is the one integration **outside** Magpie's verified SDK — confirm the Ultra request/response shape against current Jupiter docs and **test with a tiny amount first** (real swaps are mainnet-only; there's no devnet path).
- The Magpie SDK/MCP are pre-1.0 (v0.1.x) — pin versions, start small.
- In-vault stop-losses are **best-effort**, not a hard stop. The guardian — not the SL — is what prevents default.
