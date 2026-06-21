# @magpieloans/magpie-agent

**The agent SDK for Magpie x402.** Every action on the Magpie permissionless lending protocol as a typed one-liner.

The first x402-native lending SDK on Solana. Agents borrow, lend, liquidate, and post conditional intents in one line of code each. No HTTP plumbing, no signature handling, no transaction construction.

## Install

```bash
npm install @magpieloans/magpie-agent @solana/web3.js
```

## 30-second example

```ts
import { MagpieAgent } from "@magpieloans/magpie-agent";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";

// Load your agent's keypair.
const secret = JSON.parse(readFileSync("./keypair.json", "utf8"));
const keypair = Keypair.fromSecretKey(new Uint8Array(secret));

// One line creates a fully configured agent.
const agent = new MagpieAgent({
  keypair,
  rpcUrl: "https://api.mainnet-beta.solana.com",
});

// One line borrows SOL against any approved collateral.
const loan = await agent.borrow({
  collateralMint: "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump", // $MAGPIE
  collateralAmount: 1_000_000_000n,                                // raw u64
  tier: "express",                                                 // 30% LTV, 2-day
});

console.log(`Borrowed ${Number(loan.borrowedLamports) / 1e9} SOL`);
console.log(`Tx: https://solscan.io/tx/${loan.signature}`);
```

That's it. No transaction building, no cosign-borrow plumbing, no signature dance. The SDK handles every step end-to-end.

## All the agent actions

### Borrow against any token

```ts
const loan = await agent.borrow({
  collateralMint, collateralAmount: 1_000_000_000n, tier: "express",
});
// → { signature, loanId, borrowedLamports, feesPaidLamports }
```

A no-exits borrow routes to the V1 program (memecoin collateral) — and, once it launches, to the V3 program for RWA collateral. Pass `hasExitArming: true` to route to the V4 in-vault program so you can arm take-profit / stop-loss exit orders on the loan afterward (see below).

```ts
const loan = await agent.borrow({
  collateralMint, collateralAmount: 1_000_000_000n, tier: "express",
  hasExitArming: true,   // → V4 in-vault loan; armExit() works on it
});
```

### Arm an in-vault exit order (TP / SL) on your own loan

Exit orders are **self-owned**: the SDK signs an Ed25519 envelope with your keypair, the x402 service forwards it to the bot, and the bot enforces that the signer owns the loan and that the loan is V4. No Telegram, no delegation, no custodial key — `armExit` pays **and** signs with the *same* keypair, so payer == signer always holds. Proceeds accumulate **in-vault** on the loan; the only path to your wallet is your own borrower-signed repay.

The full lifecycle is `borrow({ hasExitArming: true })` → `armExit` → `listExits` → `repay` (via the bot/site, borrower-signed):

```ts
// 1. Borrow on V4 so the loan can hold exit orders.
const loan = await agent.borrow({
  collateralMint, collateralAmount: 1_000_000_000n, tier: "express",
  hasExitArming: true,
});

// 2. Arm a take-profit at 2x and a stop-loss at 0.7x on that loan.
//    Supply exactly ONE trigger: target ("2x"/"0.7x"), priceUsd, mcUsd
//    ("5M"/"1.2B"), or trailingBps (stop-loss only).
const tp = await agent.armExit({
  loanId: loan.loanId,
  direction: "above",      // take-profit (default)
  target: "2x",
  slippageBps: 100,
  dest: "sol",             // sol | usdc
});
const sl = await agent.armExit({
  loanId: loan.loanId,
  direction: "below",      // stop-loss
  target: "0.7x",
});
// each → { order, feesPaidLamports }   (arm is paid 0.001 SOL)

// 3. List your armed orders any time (free).
const { orders } = await agent.listExits();

// 4. Modify or cancel without re-paying (both free).
await agent.modifyExit({ orderId: tp.order.order_id as string, target: "3x" });
await agent.cancelExit(sl.order.order_id as string);

// 5. When you're done, repay (borrower-signed, via the site/bot) to release
//    the collateral + any in-vault SOL proceeds back to your wallet.
```

`armExit` requires `loanId` plus exactly one trigger. `modifyExit` and `cancelExit` take the `orderId` returned by `armExit` / `listExits`. The 5-minute envelope freshness window and nonce-uniqueness are handled for you — `From`, `Nonce`, and `IssuedAt` are auto-added to the signed text.

### Deposit SOL as a liquidity provider

```ts
const dep = await agent.deposit({ lamports: 100_000_000n });
// → { signature, depositedLamports, feesPaidLamports }
```

### Withdraw LP shares back to SOL

```ts
const w = await agent.withdraw({ shares: 50_000_000n });
// → { signature, sharesRedeemed, projectedLamports, feesPaidLamports }
```

### Liquidate a past-due loan and receive the keeper bounty

```ts
// Find liquidatable loans (free):
const { liquidatable } = await agent.liquidatable({ limit: 10 });

// Liquidate one:
const lq = await agent.liquidate({ loanPda: liquidatable[0].loan_pda });
// → { signature, loanPda, collateralAmount, feesPaidLamports }
```

### Post a conditional borrow intent with webhook delivery

```ts
const intent = await agent.createIntent({
  collateralMint,
  collateralAmount: 1_000_000_000n,
  tier: "express",
  conditionType: "price_below",
  conditionParams: { priceUsd: "0.95", source: "jupiter" },
  expiresInSeconds: 7 * 86400,
  webhookUrl: "https://my-agent.example/intent-matched",
});

// The webhook secret is returned ONCE here — persist it.
const { secret } = intent.webhook!;
```

When the condition fires, your webhook URL receives an HMAC-signed POST. Verify it:

```ts
import { verifyWebhookSignature } from "@magpieloans/magpie-agent";

app.post("/intent-matched", (req, res) => {
  const ok = verifyWebhookSignature(
    secret,
    req.rawBody, // EXACT bytes the server signed
    req.headers["x-magpie-signature"],
  );
  if (!ok) return res.status(401).end();
  // …trusted, proceed…
});
```

### Get a credit score (yours or anyone's)

```ts
const credit = await agent.creditScore();                // your wallet
const other = await agent.creditScore("OtherWalletPubkey");
// → { score, tier, range, benefits }
```

### Check token risk before borrowing against it

```ts
const risk = await agent.tokenRisk("MintPubkey");
// → { risk_score, dimensions, market_data, lending_impact, flagged }

if (risk.risk_score > 60 || risk.flagged) {
  console.log("Skipping — too risky");
}
```

### Free reads — never cost anything

```ts
const pool = await agent.poolState();                 // single LendingPool
const allPools = await agent.pools();                 // V1/V3/V4 pools in one call
const myPos = await agent.lpPosition();
const catalog = await agent.collateralCatalog();
const quote = await agent.simulateBorrow({
  collateralMint, collateralAmount, decimals: 6,
  pricePerTokenUsd: 1.0, solPriceUsd: 200, tier: "all",
});

// Loan reads are now multi-version. Each loan carries a programVersion
// ("v1" | "v3" | "v4") tag and exitsSupported flag (only true on V4).
const byPda = await agent.loanByPda(loan.loanPda);     // unambiguous single loan
const { loans, by_version } = await agent.walletLoans(agent.publicKey()!);
const { liquidatable } = await agent.liquidatable({ limit: 10 });
```

Multi-version reads fail soft: if one program version is unreachable, the others still return and the affected version is reported in a `partial` map (e.g. `{ v3: "error" }`) instead of throwing. V4 loans are excluded from `liquidatable()` by default (they auto-sell in-vault) — pass `{ includeV4: true }` to include them.

## What you pay per action

| Method | Cost (SOL) |
|---|---|
| `poolState`, `pools`, `loan`, `loanByPda`, `walletLoans`, `simulateBorrow`, `collateralCatalog`, `liquidatable`, `lpPosition`, `listExits` | **free** |
| `creditScore`, `tokenRisk`, `armExit` | 0.001 |
| `deposit`, `withdraw` | 0.002 |
| `liquidate` | 0.003 |
| `borrow` | 0.005 (covers the full build + cosign flow) |
| `createIntent` | 0.01 (single payment covers entire intent lifecycle) |
| `getIntent` (poll) | 0.0005 |
| `cancelIntent`, `modifyExit`, `cancelExit` | free |

Plus tiny Solana network fees (~5,000 lamports per transaction).

Tip: use webhooks (`webhookUrl` on `createIntent`) instead of polling — at 0.0005 SOL per poll every 30s, intent polling can cost up to 0.06 SOL/hr. Webhooks are free after the 0.01 SOL intent fee.

## Why this exists

Before this SDK, an agent integration looked like ~200 lines of HTTP plumbing: implement the x402 402-challenge round-trip, derive payment params from response headers, sign Solana memo'd transfers, sign + submit the partial-signed tx returned by `build-borrow`, hit the cosign-borrow endpoint, parse + wait for the on-chain confirmation. Repeat for every action.

This SDK collapses that to a method call. Your agent code is now a description of the strategy, not the protocol.

## Security model

- **The SDK never stores your keypair anywhere.** It's loaded into memory once at `new MagpieAgent({ keypair })` time, used to sign locally, never serialized or transmitted.
- **Paid x402 calls sign a SystemProgram transfer + Solana memo and submit it.** Your keypair signs the transfer; the resulting tx signature is the only thing sent to Magpie.
- **Borrow / deposit / withdraw / liquidate transactions are signed by your keypair locally.** The SDK calls `build-*` to get an unsigned tx from Magpie, signs it with your keypair, submits it directly to Solana. Magpie's cosign step (for borrows) adds the lender authority signature only.
- **Webhook signatures are constant-time verified** via `verifyWebhookSignature` (timing-safe HMAC compare). String-equal compares leak timing.
- **All HTTP calls have 10s timeouts** so a stalled connection doesn't hang your agent.

## Cost ceiling pattern

For a paranoid first deployment, fund the keypair with a small SOL float (0.05 SOL is plenty for trying things) and let it run dry rather than top up unattended. Each action's cost is bounded and the SDK throws on failure — there's no path where SOL leaves the wallet beyond the displayed per-call cost.

## Configuration

```ts
new MagpieAgent({
  keypair,                                            // required for paid actions
  rpcUrl: "https://api.mainnet-beta.solana.com",      // any Solana RPC
  baseUrl: "https://x402.magpie.capital",             // default; override for self-hosted
  siteUrl: "https://www.magpie.capital",              // default; cosign-borrow host
});
```

For production traffic, use a paid Helius/Triton/QuickNode URL — the default public RPC will rate-limit you.

## What's next on the roadmap

Premium Tier (in build, 4–6 weeks) — tokenized US equities ($NVDAx, $COINx, $TSLAx, $AAPLx, $MSFTx) + blue-chip Solana memecoins ($PUMP, $BONK, $FARTCOIN, $TROLL) accepted as collateral with their own LTV/fee parameters. SDK already supports any new tier added to the on-chain program — just pass the tier name when it ships.

## Repository

[github.com/magpiecapital/magpie-x402](https://github.com/magpiecapital/magpie-x402) — SDK lives at `sdk/`. Sister projects in the same repo:

- `examples/` — 12 turn-key TypeScript agents using this SDK directly
- `mcp/` — MCP server exposing every SDK method as a tool for Claude / Cursor / Windsurf / ChatGPT desktop
- `agents/yield-bot/` — reference autonomous agent built on this SDK

## License

MIT.
