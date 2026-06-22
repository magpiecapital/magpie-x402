# Your first Magpie agent in 10 minutes

Zero to a working autonomous lending agent on Solana — borrowing SOL against tokens you hold, all signed by your agent's own keypair, no custody, no API keys.

This guide is for code-first builders. If you'd rather your agent host (Claude Desktop / Cursor / Windsurf / ChatGPT desktop) handle everything for you, jump straight to the [MCP server install instructions](./mcp/README.md) — one config block and you're done.

## What you'll have at the end

- A dedicated Solana keypair for your agent (separate from your main wallet)
- A 30-line script that borrows SOL against any approved collateral token
- Optional: a conditional borrow agent that fires when a price condition is met, with HMAC-verified webhook delivery

## Prerequisites

- Node.js 20+
- Solana CLI (for keypair generation; alternative: use the snippet in step 2)
- A Solana wallet with ~0.1 SOL on mainnet (for x402 fees + network fees + collateral)
- An RPC endpoint. Public mainnet is fine for testing; for production, use Helius/Triton/QuickNode

## Step 1 — Project setup (1 minute)

```bash
mkdir my-magpie-agent && cd my-magpie-agent
npm init -y
npm install @magpieloans/magpie-agent @solana/web3.js
```

## Step 2 — Generate the agent's keypair (1 minute)

Your agent gets its own wallet. Keep this separate from your main wallet — limits blast radius if the agent's keypair ever leaks.

```bash
solana-keygen new -o ./agent-keypair.json --no-bip39-passphrase
solana-keygen pubkey ./agent-keypair.json
# Copy the printed pubkey
```

No Solana CLI installed? One-liner alternative:

```bash
node -e "
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const kp = Keypair.generate();
fs.writeFileSync('./agent-keypair.json', JSON.stringify(Array.from(kp.secretKey)));
console.log(kp.publicKey.toBase58());
"
```

## Step 3 — Fund the agent's wallet (2 minutes)

Send some SOL to the pubkey from step 2. Minimum for trying things: **0.05 SOL** (covers ~5–10 paid x402 calls plus network fees plus rent). For real use, send more depending on the actions you'll run.

If you want to borrow against a token (not SOL), you also need to transfer that token to the agent's wallet. You can see the catalog of approved collateral at:

```bash
curl -s https://x402.magpie.capital/api/v1/collateral/eligible | jq '.tokens[] | { symbol, mint, decimals }'
```

## Step 4 — Write the agent (5 minutes)

Create `agent.js`:

```js
import { MagpieAgent } from "@magpieloans/magpie-agent";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";

// Load the keypair from disk.
const secret = JSON.parse(readFileSync("./agent-keypair.json", "utf8"));
const keypair = Keypair.fromSecretKey(new Uint8Array(secret));

// Initialize the agent. Defaults to mainnet + the production x402 service.
const agent = new MagpieAgent({
  keypair,
  rpcUrl: process.env.SOLANA_RPC_URL,  // optional; defaults to public mainnet
});

console.log("Agent wallet:", agent.publicKey().toBase58());

// ─── Step A: check the pool's state (free) ───
const pool = await agent.poolState();
console.log("Pool utilization:", (pool.utilizationRate * 100).toFixed(1) + "%");

// ─── Step B: borrow SOL against a token we hold (paid 0.005 SOL) ───
//
// Replace the mint + amount with the token you want to use as collateral.
// Example below assumes you have 1.0 of a token with 6 decimals.

const COLLATERAL_MINT = "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump"; // $MAGPIE
const COLLATERAL_AMOUNT_RAW = 1_000_000n;                              // 1.0 at 6 decimals

const loan = await agent.borrow({
  collateralMint: COLLATERAL_MINT,
  collateralAmount: COLLATERAL_AMOUNT_RAW,
  tier: "express",  // 30% LTV, 2-day duration, 3% fee
});

console.log("✓ Borrow complete!");
console.log("  loan_id:    ", loan.loanId);
console.log("  borrowed:   ", Number(loan.borrowedLamports) / 1e9, "SOL");
console.log("  tx:          https://solscan.io/tx/" + loan.signature);
```

## Step 5 — Run it (2 minutes)

```bash
node --experimental-vm-modules agent.js
```

You should see something like:

```
Agent wallet: ABcDeF...
Pool utilization: 71.4%
✓ Borrow complete!
  loan_id:     42
  borrowed:    0.45 SOL
  tx:          https://solscan.io/tx/3UpL...
```

Click the Solscan link — your loan is on-chain.

You just built and ran a Magpie agent. Total time: 10 minutes. Total code: 28 lines.

---

## Going further

### Arm an in-vault exit order (take-profit / stop-loss)

Borrow on the V4 in-vault program (`hasExitArming: true`), then arm a take-profit / stop-loss that fires **in-vault** — proceeds accumulate on the loan, and the only path back to your wallet is your own borrower-signed repay. The order is self-owned: the SDK signs an Ed25519 envelope with the *same* keypair that pays, so no Telegram, delegation, or custodial key is involved.

```js
// Borrow on V4 so the loan can hold exit orders.
const loan = await agent.borrow({
  collateralMint: COLLATERAL_MINT,
  collateralAmount: COLLATERAL_AMOUNT_RAW,
  tier: "express",
  hasExitArming: true,
});

// Arm a take-profit at 2x (paid 0.001 SOL). Supply exactly ONE trigger:
// target ("2x"/"0.7x"), priceUsd, mcUsd ("5M"/"1.2B"), or trailingBps (SL only).
const tp = await agent.armExit({
  loanId: loan.loanId,
  direction: "above",   // take-profit (default); use "below" for a stop-loss
  target: "2x",
  slippageBps: 100,
  dest: "sol",          // sol | usdc
});

// List, modify, or cancel any time (list/modify/cancel are free).
const { orders } = await agent.listExits();
await agent.modifyExit({ orderId: tp.order.order_id, target: "3x" });
// await agent.cancelExit(tp.order.order_id);
```

When you're done, repay the loan (borrower-signed, via the site/bot) to release the collateral plus any in-vault SOL proceeds back to your wallet.

### Conditional borrows with push notifications

For a long-running agent that should react to market conditions, use intents with webhooks. The agent doesn't need to be online — Magpie posts the matched intent to your webhook URL when the trigger fires.

```js
const intent = await agent.createIntent({
  collateralMint: COLLATERAL_MINT,
  collateralAmount: COLLATERAL_AMOUNT_RAW,
  tier: "express",
  conditionType: "price_below",
  conditionParams: { priceUsd: "0.95", source: "jupiter" },
  expiresInSeconds: 7 * 86400,
  webhookUrl: "https://my-agent.example/intent-matched",
});

// Persist this secret — you'll need it to verify the incoming POST.
const webhookSecret = intent.webhook.secret;
```

Receiver side (verifies the HMAC signature):

```js
import { verifyWebhookSignature } from "@magpieloans/magpie-agent";

app.post("/intent-matched", (req, res) => {
  if (!verifyWebhookSignature(webhookSecret, req.rawBody, req.headers["x-magpie-signature"])) {
    return res.status(401).end();
  }
  const { intent_id, partial_signed_tx_b64 } = req.body;
  // …sign and submit, run your strategy, etc.
  res.json({ received: true });
});
```

See [`examples/09-webhook-receiver.ts`](./examples/09-webhook-receiver.ts) for a full receiver in 130 lines.

### Liquidation keeper

Find past-due loans and capture the bounty:

```js
const { liquidatable } = await agent.liquidatable({ limit: 5 });
for (const candidate of liquidatable) {
  try {
    const result = await agent.liquidate({ loanPda: candidate.loan_pda });
    console.log("Liquidated", candidate.loan_id, "tx:", result.signature);
  } catch (e) {
    console.log("Skipped", candidate.loan_id, "—", e.message);
  }
}
```

See [`examples/08-liquidation-keeper.ts`](./examples/08-liquidation-keeper.ts) for the auto-loop version.

### Provide liquidity (be the lender side)

```js
// Deposit 0.1 SOL into the LendingPool to earn yield from borrowers:
const dep = await agent.deposit({ lamports: 100_000_000n });
console.log("Deposited, shares:", dep.signature);

// Check your position anytime:
const pos = await agent.lpPosition();
console.log("Current value:", Number(pos.current_value_lamports) / 1e9, "SOL");
console.log("Yield earned: ", Number(pos.yield_lamports) / 1e9, "SOL");

// Withdraw when ready:
const w = await agent.withdraw({ shares: BigInt(pos.shares) });
```

See [`agents/yield-bot/`](./agents/yield-bot/) for the full autonomous rebalancer.

---

## Common patterns

### Cost ceiling for paranoid first deploys

Fund the agent keypair with a small float (0.05 SOL) and let it run dry rather than top up unattended. Every paid call is bounded — there's no path for surprise spending beyond the documented per-call cost.

### Reading without paying

Every read endpoint on the SDK is free. Use `simulateBorrow` before `borrow` to know exactly what you'll get. Use `tokenRisk` before any new collateral to screen it. Use `lpPosition` before any LP action to know your current state.

### Production hardening

- Use a paid RPC (Helius/Triton/QuickNode). The default public RPC will rate-limit you.
- Wrap actions in retry-with-backoff for transient network errors.
- Log every `feesPaidLamports` so you can audit your x402 spend.
- For webhooks, enforce that the `intent_id` in the payload matches one your agent posted — don't trust the signature alone.

### Operational visibility

Every paid call to x402 is recorded (anonymously, no per-payer detail) and surfaced as live aggregates at [magpie.capital/x402](https://magpie.capital/x402) — your agent's activity contributes to the public protocol metrics there.

---

## What's next

- **Premium Tier** (in build, 4–6 weeks): tokenized US equities (NVDAx, COINx, TSLAx, AAPLx, MSFTx) + blue-chip Solana memecoins ($PUMP, $BONK, $FARTCOIN, $TROLL) accepted as collateral. The SDK already supports any new tier; just change the `tier` argument when it ships.
- **More examples**: 10 turn-key agent files in `examples/` — fork freely.
- **MCP host integration**: drop the [MCP server](./mcp/README.md) into your Claude / Cursor / Windsurf / ChatGPT desktop config and the same 19 actions become first-class tool calls.

## Help

- API reference: [magpie.capital/x402](https://magpie.capital/x402)
- OpenAPI spec: [x402.magpie.capital/openapi.json](https://x402.magpie.capital/openapi.json)
- Endpoint catalog: [x402.magpie.capital/.well-known/x402.json](https://x402.magpie.capital/.well-known/x402.json)
- Issues: [github.com/magpiecapital/magpie-x402/issues](https://github.com/magpiecapital/magpie-x402/issues)
