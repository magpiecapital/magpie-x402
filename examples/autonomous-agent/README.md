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
| `jupiter.ts` | The buy step (the one integration outside Magpie). |
| `config.ts` | Every safety knob; every default is the safe choice. |
| `agent.ts` | Orchestrator: guard-first, then brain → buy → collateralize. |

## Run it
```bash
# 1) Rehearse — free, safe, nothing moves (does live read-only calls):
MAGPIE_PAYER_KEYPAIR=~/.config/solana/id.json \
  npx tsx examples/autonomous-agent/agent.ts

# 2) Go live — reads MINT_ALLOWLIST, spends real funds from the agent wallet:
LIVE=1 \
  MINT_ALLOWLIST=<mint1>,<mint2> \
  PREFERRED_CATEGORY=rwa \
  MAGPIE_PAYER_KEYPAIR=~/.config/solana/agent-wallet.json \
  npx tsx examples/autonomous-agent/agent.ts
```
Use a **dedicated allowance wallet** funded with only what you're willing to risk (e.g. $500) — never your main wallet.

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

## Plug in a real brain
Replace `chooseCandidate()` in `agent.ts` with an LLM loop (Claude Agent SDK / Solana Agent Kit / LangGraph). Feed it `SYSTEM_PROMPT` from `magpie-playbook.ts` so it understands time-based liquidation, full-gross repay, and the never-default policy before it gets tool access.

## ⚠️ Before going live
- `jupiter.ts` is the one integration **outside** Magpie's verified SDK — confirm the Ultra request/response shape against current Jupiter docs and **test with a tiny amount first** (real swaps are mainnet-only; there's no devnet path).
- The Magpie SDK/MCP are pre-1.0 (v0.1.x) — pin versions, start small.
- In-vault stop-losses are **best-effort**, not a hard stop. The guardian — not the SL — is what prevents default.
