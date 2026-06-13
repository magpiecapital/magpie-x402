# Agent Quickstart — Limit-Close Orders

Build an agent that arms, monitors, and steers Magpie limit-close orders on behalf of borrowers.

This doc covers the **complete flow** for a third-party agent: from discovering authorized wallets to firing, monitoring fills, modifying live orders, and handling failures. Every endpoint, every header, every error code.

> **Audience:** developers building agents that operate against Magpie loans. Assumes Solana, x402, and basic Anchor familiarity.

---

## Why an agent for limit-close?

A Magpie borrower has SOL borrowed against memecoin collateral. They want their position auto-closed at certain price targets — take-profit (price goes up) or stop-loss (price goes down). A human can do this via Telegram or the dashboard, but an agent can:

- **React in milliseconds** instead of "when the user happens to look"
- **Manage many positions** across many borrowers at once
- **Steer orders** as conditions change without the borrower being awake
- **Capture per-fire fees** from the borrower (1% of proceeds, baked into the protocol)

The borrower wins the responsiveness; the agent wins the per-fire economics; the protocol wins the fee.

---

## Authorization model

The agent doesn't hold the borrower's keys. Instead:

1. **The borrower runs `/agent-authorize` in the Magpie Telegram bot.**
   They pick an agent's pubkey, set bounds (max per-order notional, max active orders, max slippage), and an expiration.
2. **A row lands in `agent_delegations`** capturing those bounds.
3. **The agent pays x402 for /arm**, and the bot verifies the agent's pubkey (the on-chain payer) matches an active delegation.

The agent operates **only within the borrower's stated bounds**. Tighter delegations are a unilateral borrower choice; the agent has no veto.

```
borrower            telegram bot                 magpie-x402            agent
   │                     │                           │                    │
   │  /agent-authorize   │                           │                    │
   │ ───────────────────►│                           │                    │
   │                     │   INSERT agent_delegation │                    │
   │                     │                           │                    │
   │                     │                           │                    │
   │                     │                           │                    │
   │                     │     GET /delegations      │  X-Agent-Pubkey   │
   │                     │ ◄─────────────────────────┤◄───────────────────│
   │                     │      [{user_wallet,       │                    │
   │                     │        bounds, …}]        │                    │
   │                     │                           │                    │
   │                     │   POST /arm + x402 sig    │  body              │
   │                     │ ◄─────────────────────────┤◄───────────────────│
   │                     │   {order_id, …}           │                    │
```

---

## Endpoints (full reference)

All paths are under `https://x402.magpie.capital`.

### Free (no x402 charge)

These let an agent navigate without paying.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/agent/limit-close/delegations` | What wallets has the borrower authorized me for? What bounds + usage so far? |
| `GET /api/v1/agent/limit-close/eligible-loans` | Per-wallet loan list, each with `eligible: true \| false` + `ineligibility_reasons`. |
| `GET /api/v1/agent/limit-close?id=<order_id>` | Read one order's current state. |
| `GET /api/v1/agent/limit-close/list?status=armed\|all` | List the agent's own orders. |
| `POST /api/v1/agent/limit-close/preflight` | Dry-run an arm. Returns 200 if the arm would succeed, or the same error codes `/arm` would on failure. **Use this before paying for an arm.** |
| `PATCH /api/v1/agent/limit-close/modify` | Change trigger / slippage / dest / expires on an armed order. |
| `DELETE /api/v1/agent/limit-close?id=<order_id>` | Cancel an armed order. Race-safe (404 if already firing). |

### Paid (x402 — 0.001 SOL per arm)

| Endpoint | Purpose | Charge |
|---|---|---|
| `POST /api/v1/agent/limit-close` | Arm a new TP or SL order. | 0.001 SOL |

The execution fee (1% of proceeds at fire time) is taken on the engine side from the swap proceeds — it's NOT a separate x402 charge.

All free endpoints require the `X-Agent-Pubkey` header. The paid endpoint identifies the agent via the x402 payment payer pubkey (more secure — the agent can't lie about being someone else).

---

## End-to-end agent flow

A minimal agent loop, in pseudocode:

```ts
// 1. startup — what surface am I working over?
const delegations = await client.get("/api/v1/agent/limit-close/delegations", {
  headers: { "x-agent-pubkey": MY_PUBKEY },
});
// delegations.delegations = [{ user_wallet, bounds, usage }, …]

// 2. for each delegation, fetch the eligible loans I could act on
for (const d of delegations.delegations) {
  const loans = await client.get(
    `/api/v1/agent/limit-close/eligible-loans?wallet=${d.user_wallet}`,
    { headers: { "x-agent-pubkey": MY_PUBKEY } },
  );
  // loans.loans = [{ loan_id, eligible, ineligibility_reasons?, … }]

  // 3. pick a loan + decide a trigger
  const loan = loans.loans.find(l => l.eligible);
  if (!loan) continue;

  // 4. PREFLIGHT BEFORE PAYING. This is free; it saves the arm fee
  //    if anything would block the live arm.
  const dry = await client.post("/api/v1/agent/limit-close/preflight", {
    headers: { "x-agent-pubkey": MY_PUBKEY },
    body: {
      user_wallet: d.user_wallet,
      loan_id: loan.loan_id,
      trigger_kind: "price_usd",
      trigger_value_micro: String(BigInt(Math.round(targetUsd * 1e6))),
      slippage_bps: 200,
      sell_destination: "sol",
      trigger_direction: "above",  // 'above' = TP, 'below' = SL
      auto_escalate_slippage: true,
    },
  });
  if (!dry.would_arm) {
    log("preflight rejected", dry.error);
    continue;
  }

  // 5. pay + arm. Payer pubkey on the Solana tx must be MY_PUBKEY.
  const armed = await client.payAndPost(
    "/api/v1/agent/limit-close",
    {
      user_wallet: d.user_wallet,
      loan_id: loan.loan_id,
      trigger_kind: "price_usd",
      trigger_value_micro: String(BigInt(Math.round(targetUsd * 1e6))),
      slippage_bps: 200,
      sell_destination: "sol",
      trigger_direction: "above",
      auto_escalate_slippage: true,
    },
  );
  log("armed", armed.order_id);

  // 6. later — if conditions change, modify (free) instead of cancel+re-arm.
  await client.patch("/api/v1/agent/limit-close/modify", {
    headers: { "x-agent-pubkey": MY_PUBKEY },
    body: {
      id: armed.order_id,
      trigger_value_micro: String(BigInt(Math.round(newTargetUsd * 1e6))),
    },
  });
}
```

---

## Best practices

### Always preflight before paying

`POST /preflight` is FREE. It runs the same gates `/arm` runs (delegation bounds, collateral allowlist, immediate-fire guard, SL solvency floor, liquidity-aware slippage bump derivation) but doesn't INSERT a row and doesn't charge x402.

A `would_arm: true` response is a STRONG hint, not a contractual reservation — liquidity can shift between preflight and arm, so be prepared to handle arm-time rejection. But preflight catches 95%+ of the cases where you'd burn an arm fee on a config that was never going to succeed.

### Hold TP + SL on the same loan (multi-leg)

An agent (or borrower) can arm BOTH a take-profit AND a stop-loss on the same loan simultaneously — they protect opposite sides of the position.

```ts
// First leg: TP at 1.05x
await client.payAndPost("/api/v1/agent/limit-close", {
  user_wallet: w, loan_id: id,
  trigger_kind: "price_usd",
  trigger_value_micro: tpMicros,
  trigger_direction: "above",     // ← TP
  slippage_bps: 200, sell_destination: "sol",
  auto_escalate_slippage: true,
});

// Second leg: SL at 0.85x — same loan, opposite direction
await client.payAndPost("/api/v1/agent/limit-close", {
  user_wallet: w, loan_id: id,
  trigger_kind: "price_usd",
  trigger_value_micro: slMicros,
  trigger_direction: "below",     // ← SL
  slippage_bps: 300, sell_destination: "sol",
  auto_escalate_slippage: true,
});
```

Both arms count separately against `max_active_orders`. When ONE side fires, the loan is closed (collateral sold, repay done) so the OTHER side is auto-cancelled by the engine with `cancellation_reason = "sibling_order_fired"` — you'll see that on a subsequent GET of the order. **Don't try to arm a second TP or a second SL on the same loan** — that throws `loan_already_has_active_order_in_direction`.

### Use modify, not cancel + re-arm

If the market moves and you want to chase the price, **PATCH /modify** is free and atomic:
- No new x402 charge (you already paid for the slot)
- No "window" where the market can move past your new target before the new arm lands
- The order stays armed throughout

Only force cancel + re-arm when you need to change:
- `trigger_kind` (price_usd → mc_usd or vice versa)
- `trigger_direction` (TP → SL or vice versa)
- The loan itself

### Respect the delegation bounds

The borrower set `max_per_order_lamports`, `max_active_orders`, and `max_slippage_bps`. The bot enforces all three at arm time — but you should also self-enforce so you don't waste x402 fees on rejected arms.

`GET /delegations` returns the bounds AND the current usage (how many active orders, total notional). Cache it at startup and after every arm/cancel to avoid round-tripping.

### Handle race-safe responses

If you `PATCH /modify` or `DELETE` an order at the exact moment the engine starts firing it, you'll get `409 not_modifiable_or_not_found`. That's normal — the engine flipped status to `firing` before doing on-chain work. Treat 409 here as "too late, the fire is committed" and move on.

### Don't poll status — listen to outcomes

The engine emits one of:
- `fired` — order executed, see `tx_signature_repay` + `tx_signature_swap` for receipts
- `failed` — execution failed; check `failure_reason`
- `partial_fired` — TWAP filled some chunks
- `cancelled` (by you or the borrower)
- `expired` (past `expires_at`)

Once an order leaves `armed`, it's terminal for your purposes. Stop polling that order id and move on. The list endpoint returns `status='armed'` by default for exactly this reason.

---

## Error reference

Every endpoint returns the same error code on the same condition. Key codes:

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_user_wallet` | 400 | Wallet isn't a valid base58 Solana pubkey. |
| `invalid_loan_id` | 400 | Loan id isn't a decimal-string up to 20 digits. |
| `invalid_trigger_kind` | 400 | Not one of `mc_usd \| price_usd \| price_sol`. |
| `invalid_trigger_direction` | 400 | Not `above` or `below`. |
| `invalid_slippage_bps` | 400 | Outside `10..1000`. |
| `no_active_delegation` | 403 | Borrower hasn't authorized you for this wallet. |
| `delegation_expired` | 403 | Authorization expired; borrower needs to renew. |
| `order_exceeds_delegation_cap` | 403 | Loan size > borrower's stated per-order cap. |
| `slippage_exceeds_delegation_cap` | 403 | Slippage > borrower's stated cap. |
| `slippage_exceeds_order_cap` | 403 | (modify only) Can't widen past the order's existing cap. |
| `loan_not_found_for_wallet` | 404 | Wallet doesn't own that loan. |
| `loan_not_active` | 409 | Loan is repaid / liquidated. |
| `loan_below_minimum_size` | 409 | Loan < 1 SOL — not eligible for limit-close. |
| `collateral_not_enabled` | 409 | Collateral mint disabled by operator. |
| `rwa_collateral_not_supported_in_v1` | 409 | RWA collateral; limit-close v1 is memecoin-only. |
| `trigger_would_fire_immediately` | 409 | TP set at or below current; SL set at or above current. Move the target. |
| `sl_below_solvency` | 409 | Stop-loss target so low that fire proceeds couldn't cover loan repay. Move the target up. |
| `loan_already_has_active_order` | 409 | (Legacy) Already an armed order on that loan. Pre-multi-leg shape — superseded by the per-direction code below. |
| `loan_already_has_active_order_in_direction` | 409 | Already an armed order in the same `trigger_direction`. The OTHER direction is still open — TP+SL on the same loan is supported (multi-leg). Detail field carries `direction`. |
| `agent_concurrency_cap_reached` | 429 | You've hit the borrower's `max_active_orders` for this wallet. |
| `user_concurrency_cap_reached` | 429 | The borrower has hit the protocol-wide 10-active-orders cap. |
| `not_modifiable_or_not_found` | 409 | Race with the engine firing the order, or the order is closed. |

---

## Where this all lives

- **Public x402 endpoints:** [magpie-x402](https://github.com/magpiecapital/magpie-x402) (this repo).
- **Internal bot handler that does the actual work:** [magpie-bot/src/api/internal-agent-limitclose.js](https://github.com/magpiecapital/magpie-bot/blob/main/src/api/internal-agent-limitclose.js).
- **Shared arm/cancel/modify core:** [magpie-bot/src/services/limit-close-arm-core.js](https://github.com/magpiecapital/magpie-bot/blob/main/src/services/limit-close-arm-core.js).
- **Engine that actually fires:** [magpiecapital/magpie-limitclose](https://github.com/magpiecapital/magpie-limitclose) (private — the on-chain submission service).

---

## Operator escape hatches

- `LIMIT_CLOSE_AGENT_DISABLED=1` on the bot's env disables `POST /arm` for x402 agents WITHOUT affecting TG-armed orders or already-armed agent orders. You'll get `503 agent_arm_disabled_by_operator`. Don't retry until the operator clears it.
- The bot's `/agent-revoke` command in Telegram lets a borrower revoke your delegation instantly. The next arm attempt returns `no_active_delegation`.

Both exist so the operator and borrower can pull the brakes if an agent misbehaves. Build your retry logic to back off cleanly on these.

---

## Questions, feedback, integration help

[github.com/magpiecapital/magpie-x402/issues](https://github.com/magpiecapital/magpie-x402/issues) or [@MagpieLoans](https://x.com/MagpieLoans) on X.
