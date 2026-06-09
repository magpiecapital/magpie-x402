# magpie-x402 — Agent Distribution & Marketing Strategy

How Magpie's x402 paid API earns and keeps AI-agent users. Read this before adding new endpoints; the bar for a new endpoint is "does it move us up one of these levers."

This is a living doc. PRs welcome.

---

## What we're actually selling

Five things that AI agents and other Solana protocols cannot get anywhere else:

1. **Magpie credit scores + cryptographically-signed credit attestations.** Wallet-level repayment-history scoring on Solana, portable as ed25519-signed payloads that other protocols can verify without trusting our API.
2. **A real lending protocol's read surface, on-chain-direct.** Pool state, loan state, borrower history — no DB intermediary, no rate-limited public RPC, all responses CDN-cacheable.
3. **Paid agent-callable borrow / repay / extend / topup / partial-repay transaction builders.** The agent never gets our keys; we never get the agent's. Pure handoff: agent pays via x402, we build the unsigned tx, agent signs and submits.
4. **Conditional borrow intents — "limit orders for borrows."** The wedge that makes Magpie the first agent-native lending protocol on Solana. Single x402 payment buys watcher slot + final tx build.
5. **Liquidation-bot data feeds.** Past-due active loans, sorted by urgency, free + 8s cache. The on-chain liquidate ix is permissionless; we surface the discovery side so liquidation racing actually happens.

Everything else is plumbing.

---

## The five distribution levers (ranked by impact)

### Lever 1: MCP server distribution (highest leverage)

Model Context Protocol is the de facto standard for AI agents to discover and use external tools. As of late 2026, **every major agent runtime supports MCP**: Claude Desktop, OpenAI Apps, Cursor, Vercel AI SDK, Continue, Sourcegraph Cody, Replit Agent.

**Why this matters:** an MCP server is *one-command-install* for an agent developer. They don't read your README; they don't write x402 payment plumbing; they get tool definitions and call sites for free.

**What to build:**
- `magpie-x402-mcp` — separate npm package (or sub-package) that wraps every x402 endpoint as an MCP tool.
- Auto-handles the payment dance: tool definitions for read endpoints expose them as free; tool definitions for paid endpoints expose a single argument for "payment txn signature" with a one-shot retry on 402.
- Discover-on-call: pulls `/.well-known/x402.json` once, registers every endpoint listed.
- Distributable via Anthropic's [MCP marketplace](https://www.anthropic.com/news/model-context-protocol), Glama, and similar registries.
- Published as `@magpiecapital/x402-mcp` on npm.

**Distribution channels for the MCP server (in order of leverage):**
1. Anthropic's MCP marketplace (direct submission)
2. Glama's MCP registry
3. Smithery's MCP registry
4. Cursor's MCP directory
5. A pinned tweet on @MagpieLoans with the install command
6. A blog post on magpie.capital titled *"Borrow SOL against your portfolio from inside your Claude conversation"*

Tracked in: [#mcp-server](https://github.com/magpiecapital/magpie-x402/issues)

### Lever 2: x402 directory listings

The x402 ecosystem is small enough that being on every directory is realistic.

**Directories to submit to (in order):**
1. [x402.dev](https://x402.dev) — the canonical x402 spec site, accepts service submissions
2. [x402.org](https://x402.org) — protocol homepage
3. Coinbase's x402 docs (Coinbase invented the x402 expansion of HTTP 402; their docs list reference implementations)
4. Vercel's AI Gateway endpoint marketplace (when it accepts x402 entries)
5. Helius / Triton "Solana developer ecosystem" pages — both list third-party APIs

**The hidden lever:** discoverability via `/.well-known/x402.json`. We already serve it. Submit our URL `https://x402.magpie.capital/.well-known/x402.json` to anyone who maintains an x402 service index — they'll auto-pull our endpoint catalog and price list on each refresh.

Tracked in: [#x402-directory-submissions](https://github.com/magpiecapital/magpie-x402/issues)

### Lever 3: SDK / framework integrations

Hand agent framework authors a copy-paste integration.

**Frameworks to target:**
- **Vercel AI SDK** — the largest AI SDK on npm. Build a `@magpiecapital/ai-sdk-tools` package exposing Magpie tools as `tool(...)` definitions.
- **LangChain (JS + Python)** — submit to `langchain-community` integrations.
- **Letta** (formerly MemGPT) — agent-with-memory framework; their tool registry is small enough that a clean integration gets featured.
- **Crew AI** — multi-agent framework; their tool catalog gets attention from devs building agent teams.
- **Solana Agent Kit** — the de facto Solana-native agent SDK as of 2026. PR adding Magpie tools.

**What each SDK integration needs:**
- Tool definitions for every public endpoint
- Schema for `simulate-borrow` so agents can quote before paying
- Wrapper around `build-borrow`/`build-repay` that abstracts the x402 payment + retry loop
- One example: "the 50-line borrowing agent"

Tracked in: [#sdk-integrations](https://github.com/magpiecapital/magpie-x402/issues)

### Lever 4: Content + showcase

Agents are built by developers. Developers read content. Content that converts:

- **`examples/` directory in this repo** with at least 4 runnable reference agents:
  1. *Borrowing agent* — "use my $MAGPIE to borrow SOL when SOL is up 5% in 24h"
  2. *Liquidation bot* — "poll `/markets/liquidatable` every 5s, race to liquidate past-due loans"
  3. *Yield agent* — "track $MAGPIE holder distributions and auto-compound my receipts"
  4. *Portfolio-risk agent* — "check my credit score weekly, attest it to a partner protocol for better terms"
- **Public agent showcase** at `magpie.capital/agents` — list real agents using the API, link to their code. Bootstrap by paying 3-5 reference agents to be built ($500-1000 bounty each).
- **Tutorial series** on the Magpie blog: "Build a Solana borrowing agent in 50 lines." One tutorial per framework integration.
- **Twitter (@MagpieLoans) thread weekly** showing live agent activity: liquidation races, credit attestations issued, intent fills.

Tracked in: [#examples-directory](https://github.com/magpiecapital/magpie-x402/issues) and [#agent-bounties](https://github.com/magpiecapital/magpie-x402/issues)

### Lever 5: Bounties + hackathons

Direct money for adoption.

- **Standing bounties** — `examples/` reference agents, MCP server, SDK integrations. Range $500-2000.
- **Solana hackathons** — Solana Foundation, Colosseum, etc. Sponsor a $MAGPIE/x402 prize category for "best AI-agent integration with a real lending protocol."
- **Eternal liquidation rebate** — burn a share of liquidator rewards back to top liquidation-bot operators monthly. Costs us nothing (it's their own reward), signals "we want you here."

Tracked in: [#bounty-program](https://github.com/magpiecapital/magpie-x402/issues)

---

## Endpoint roadmap (high-leverage adds, prioritized)

### Tier 1: ship next (~1 sprint each)

1. **MCP server wrapper** — see Lever 1. Single biggest distribution multiplier we can ship.
2. **`POST /api/v1/credit-score/batch`** — batch credit-score lookups for portfolio scanners. 0.0008 SOL per wallet, capped at 50 per request. Saves agents N-1 round trips.
3. **`GET /api/v1/wallet/:wallet/health`** — borrower health factor per loan + portfolio-wide collateral utilization. Free; piggy-backs on `wallet/loans`. The natural follow-up call for any agent that just hit `wallet/loans`.
4. **`GET /api/v1/markets/recent-borrows`** — most recent N loans across the protocol. Trading-signal data for agents that score "what tokens are being borrowed against right now."

### Tier 2: ship after Tier 1

5. **Webhook subscriptions** — agents register a callback URL, pay a sub fee, get pinged on `loan_originated`, `loan_liquidatable`, `loan_repaid`, `holder_distribution_paid` events. Removes the polling tax.
6. **`POST /api/v1/agent/build-liquidate`** — counterpart to `build-borrow`. Lets liquidation agents pay us a small fee to skip the on-chain ix-construction work. Priced low (0.001 SOL) since we want lots of liquidation participation.
7. **`GET /api/v1/collateral/:mint/risk`** — per-token risk assessment: liquidity, oracle confidence, recent volatility, screener-tier classification. The "token risk score" hinted at in the README. Paid (0.001 SOL).
8. **`GET /api/v1/yield/holder-distributions`** — historical SOL distribution amounts and cadence for $MAGPIE holders. Lets yield-aggregator agents present Magpie as a real-yield SOL option.

### Tier 3: when there's bandwidth

9. **gRPC / WebSocket streaming surface** — the polling-is-tax pain point at scale.
10. **OpenAI Apps integration** — once GPT-style Apps mature.
11. **Letta-native long-running agent integration** — "Magpie remembers your credit score so you don't have to."

---

## Pricing philosophy

- **Free**: discovery surfaces, read endpoints, anything an agent needs to *decide* whether to integrate. Cost to us is RPC + CDN; the agent has not committed to us yet.
- **Cheap (0.0005–0.001 SOL)**: per-call reads that have real protocol value (credit scores, attestations, polls). We pay for infra, agent pays for protocol IP.
- **Real money (0.005–0.01 SOL)**: write paths and watcher reservations (build-borrow, intents). Pricing reflects the gauntlet evaluation we run + the value of automated borrow capability.
- **Never paywalled**: anything an agent could trivially scrape from RPC. Charging for those just pushes agents to bypass us, ending our user relationship.

We earn on the write side. We attract on the read side.

---

## Metrics to watch (what "winning" looks like)

| Metric | What it tells us |
|---|---|
| `unique agent wallets calling paid endpoints / week` | Are we actually getting agents at all? |
| `% revenue from build-* endpoints vs read-* endpoints` | Are agents converting from "look around" to "take action"? |
| `MCP server install count (npm + Anthropic marketplace)` | Did Lever 1 land? |
| `# of agents in agents.magpie.capital showcase` | Did Lever 4 land? |
| `liquidation volume from non-protocol wallets` | Did our liquidatable feed actually attract liquidation bots? |
| `intent creation count / week` | Did the agent-native wedge stick? |

No vanity metrics. We don't track impressions, tweets seen, or social engagement. We track *agents that paid us this week*.

---

## What's NOT in this strategy (and why)

- **Generic crypto-Twitter influencer outreach.** Doesn't reach agent developers. They live on GitHub, in framework Discords, and on developer-tier Twitter (a different audience than retail crypto Twitter).
- **Listing on every aggregator.** CG and CMC matter for the token. They don't matter for the API. Don't conflate.
- **Free unlimited tier for write endpoints.** Eats our infrastructure budget and trains agents to expect free borrowing.
- **A REST API gateway with API keys.** Defeats the whole x402-no-signup pitch.
- **Token-gated access** (you must hold X $MAGPIE to call the API). Adds friction with no defensible value; agents don't speculate on protocol tokens to use APIs.

---

## How to update this doc

When you add a new endpoint, update the **Endpoint roadmap** section to reflect its tier and shipped status. When you take on a new distribution channel (e.g. submit to a new MCP registry), add it to **the relevant lever section** with a brief note on outcome. When a metric moves materially in either direction, note the cause here.

Don't add fluff. Future you will thank present you.
