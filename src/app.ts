/**
 * Hono app definition — used by BOTH:
 *   - src/index.ts (local Node.js dev server via @hono/node-server)
 *   - api/index.ts (Vercel serverless handler)
 *
 * Keep this file free of "listen on a port" side-effects so it stays
 * import-safe in serverless contexts where there's no port to bind.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { x402Required } from "./middleware/x402.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { creditScoreHandler } from "./routes/credit-score.js";
import { poolHandler, poolsAggregateHandler } from "./routes/pool.js";
import { loanHandler, loanByPdaHandler } from "./routes/loan.js";
import { walletLoansHandler } from "./routes/wallet-loans.js";
import { simulateBorrowHandler } from "./routes/simulate-borrow.js";
import { buildBorrowHandler } from "./routes/build-borrow.js";
import { buildRepayHandler } from "./routes/build-repay.js";
import { buildExtendHandler, buildTopupHandler, buildPartialRepayHandler } from "./routes/loan-manage.js";
import { creditAttestHandler } from "./routes/credit-attest.js";
import {
  createIntentHandler,
  getIntentHandler,
  cancelIntentHandler,
  listIntentsHandler,
} from "./routes/intents.js";
import { collateralEligibleHandler } from "./routes/collateral-eligible.js";
import { liquidatableHandler } from "./routes/liquidatable.js";
import {
  agentActivityHandler,
  protocolPulseHandler,
  leaderboardHandler,
} from "./routes/agent-activity.js";
import {
  buildDepositHandler,
  buildWithdrawHandler,
  lpStateHandler,
} from "./routes/agent-lp.js";
import { buildLiquidateHandler } from "./routes/agent-liquidate.js";
import {
  armLimitCloseHandler,
  preflightLimitCloseHandler,
  modifyLimitCloseHandler,
  getLimitCloseHandler,
  listLimitCloseHandler,
  listEligibleLoansHandler,
  cancelLimitCloseHandler,
  listDelegationsHandler,
} from "./routes/agent-limit-close.js";
import {
  armSelfLimitCloseHandler,
  armBatchSelfLimitCloseHandler,
  modifySelfLimitCloseHandler,
  cancelSelfLimitCloseHandler,
  listSelfLimitCloseHandler,
} from "./routes/self-limit-close.js";
import { tokenRiskHandler } from "./routes/token-risk.js";
import { TIERS } from "./lib/tiers.js";

const PAY_TO = process.env.MAGPIE_PAY_TO;

const app = new Hono();

// Order matters: security headers + CORS + rate limit BEFORE any route
app.use("*", secureHeaders());
// CORS default is the public Magpie origins. The earlier `* `default
// let any browser fetch every paid response (within rate limits) by
// triggering 402s + payments from third-party pages. Operators who need
// a wider allowlist can override with CORS_ORIGINS=https://... (comma-
// separated). Explicit "*" still works but must be opted in.
const CORS_DEFAULT = "https://magpie.capital,https://www.magpie.capital";
app.use("*", cors({
  origin: (process.env.CORS_ORIGINS || CORS_DEFAULT).split(",").map((s) => s.trim()),
  allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Payment", "X-Payment-Required-Scheme"],
  exposeHeaders: [
    "X-Payment-Required-Scheme",
    "X-Payment-Required-Amount",
    "X-Payment-Required-Recipient",
    "X-Payment-Required-Nonce",
    "X-Payment-Required-Memo",
    "Retry-After",
  ],
}));
app.use("*", logger());
app.use("/api/*", rateLimit);
app.use("/", rateLimit);

// Cap request body size BEFORE any route handler buffers it. Every
// POST/PUT body in this service is small structured JSON — the
// largest reasonable payload is a build-borrow body with a few
// addresses and amounts (< 2 KB). 64 KB leaves comfortable headroom
// for future fields without giving a DoS attacker a 10 MB free
// upload that ties up serverless memory. Returns 413 on overflow.
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        { error: "payload_too_large", max_bytes: 64 * 1024 },
        413,
      ),
  }),
);

// ─── Free endpoints ────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "magpie-x402",
    version: "0.1.0",
    tagline:
      "The first lending protocol an autonomous agent can drive end-to-end — no signup, no API key, no custody.",
    what_it_is:
      "Pay per call via x402, get back an UNSIGNED Solana transaction, sign + submit it yourself. The service holds zero keys. An agent runs the entire leveraged-position lifecycle permissionlessly: borrow against a memecoin or RWA, arm its own in-vault take-profit / stop-loss, let it fire (proceeds accrue in a per-loan vault, loan stays active), and repay.",
    capabilities: {
      borrow_memecoins: "Borrow SOL against memecoin collateral [program V1].",
      borrow_rwas:
        "Borrow SOL against tokenized stocks / RWAs [program V3] — on the V3 equity-track launch (the x402 layer is ready today).",
      exit_orders:
        "Arm in-vault take-profit / stop-loss on your OWN loan [program V4] — self-custody, no Telegram, no delegation. Proceeds accrue in a per-loan vault; only a borrower-signed repay releases funds. No other Solana lending tool exposes agent-set TP/SL on a loan.",
      full_lifecycle:
        "borrow → arm auto-exit → fire in-vault → repay, every tx agent-signed. A full RCE on this service cannot move your funds.",
      reads:
        "On-chain-direct, multi-version (V1/V3/V4) pool / loan / wallet / liquidatable state, each tagged program_version. Free + CDN-cached.",
      credit_oracle:
        "Portable ed25519-signed credit attestations other protocols can verify without trusting this API.",
    },
    agent_quickstart: {
      sdk: "npm i @magpieloans/magpie-agent — borrow({ hasExitArming: true }) → armExit({ loanId, target: '2x' }) → repay()",
      mcp: "npx -y @magpieloans/magpie-mcp — drop-in tools for Claude / Cursor / Windsurf / ChatGPT desktop",
      examples: "https://github.com/magpiecapital/magpie-x402/tree/main/examples",
      discovery: "GET /.well-known/x402.json (machine catalog) · GET /openapi.json (OpenAPI 3.1)",
    },
    no_custody:
      "This service holds no keys, signs no user transactions, and cannot move user funds. It verifies x402 payments, builds UNSIGNED txs, and forwards signed envelopes. The on-chain program is the final guard.",
    pricing: "Free to discover + read. You pay only on the write side (borrow / arm exit / intents).",
    endpoints: {
      free: [
        "GET /health",
        "GET /.well-known/x402.json — machine-readable endpoint catalog (auto-discovery)",
        "GET /openapi.json — OpenAPI 3.1 spec",
        "GET /api/v1/pool?version=v1|v3|v4 — live on-chain LendingPool state (default v1, 15s cache)",
        "GET /api/v1/pools — all three strategy pools at once, fail-soft per version",
        "GET /api/v1/tiers — protocol tier constants (1h cache)",
        "GET /api/v1/loan/by-pda/:loanPda — single loan by PDA, routed to V1/V3/V4 (program_version + V4 exit state)",
        "GET /api/v1/loan/:loanId?borrower=<pubkey> — loans by borrower + id across versions",
        "GET /api/v1/wallet/:wallet/loans — every loan a wallet holds across V1/V3/V4 (8s cache)",
        "GET /api/v1/simulate-borrow — preview a loan from caller-supplied prices",
        "GET /api/v1/collateral/eligible — collateral catalog + per-token strategy/routing table (1h cache)",
        "GET /api/v1/markets/liquidatable — past-due V1/V3 loans for liquidation bots (?include_v4=true to add V4; 8s cache)",
        "GET /api/v1/agent/activity — anonymized recent borrow/repay/liquidate events (15s cache)",
        "GET /api/v1/agent/protocol-pulse — 24h aggregate volume + counts (30s cache)",
        "GET /api/v1/agent/leaderboard — top wallets by Magpie credit score (60s cache)",
        "GET /api/v1/agent/lp-state?wallet=<pubkey> — depositor position + pool context (10s cache)",
        "GET /api/v1/agent/self-limit-close/list?wallet=<pubkey> — your armed in-vault exit orders",
      ],
      paid: [
        "GET /api/v1/credit-score?wallet=<pubkey> — 0.001 SOL (public credit oracle)",
        "GET /api/v1/agent/token-risk?mint=<pubkey> — 0.001 SOL (per-token risk profile)",
        "GET /api/v1/agent/credit-attest?wallet=<pubkey> — 0.0005 SOL (signed, portable)",
        "POST /api/v1/agent/build-borrow — 0.005 SOL (memecoin→V1 / RWA→V3 / has_exit_arming→V4; full anti-exploit gate)",
        "POST /api/v1/agent/self-limit-close/arm — 0.001 SOL (arm an in-vault TP/SL on YOUR OWN V4 loan; signed envelope, payer==signer)",
        "POST /api/v1/agent/self-limit-close/arm-batch — 0.001 SOL (arm a ladder of exits)",
        "POST /api/v1/agent/self-limit-close/modify — FREE (signed envelope; steer an armed order)",
        "POST|DELETE /api/v1/agent/self-limit-close/cancel — FREE (signed envelope)",
        "POST /api/v1/agent/build-repay — 0.002 SOL",
        "POST /api/v1/agent/build-extend — 0.002 SOL",
        "POST /api/v1/agent/build-topup — 0.002 SOL",
        "POST /api/v1/agent/build-partial-repay — 0.002 SOL",
        "POST /api/v1/agent/build-deposit — 0.002 SOL (LP)",
        "POST /api/v1/agent/build-withdraw — 0.002 SOL (LP)",
        "POST /api/v1/agent/build-liquidate — 0.003 SOL (liquidate a past-due loan, receive keeper bounty)",
        "POST /api/v1/agent/intent — 0.01 SOL (conditional borrow, single payment for lifecycle)",
        "GET /api/v1/agent/intent?id=<intent_id> — 0.0005 SOL",
        "GET /api/v1/agent/intents?wallet=<pubkey> — 0.001 SOL",
        "POST /api/v1/agent/limit-close — 0.001 SOL (delegated: arm against ANOTHER wallet's loan via TG /agent-authorize grant)",
        "GET /api/v1/agent/limit-close/eligible-loans — FREE (signed Ed25519 envelope, action limit-close-eligible/v1; delegated loans + eligibility)",
      ],
      examples: "https://github.com/magpiecapital/magpie-x402/tree/main/examples",
      mcp_server: "https://github.com/magpiecapital/magpie-x402/tree/main/mcp",
    },
    repository: "https://github.com/magpiecapital/magpie-x402",
  }),
);

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// ─── Direct on-chain protocol query (free, cached) ──────────────
// "Direct communication with the lending protocol" — this endpoint
// decodes the live LendingPool Anchor account from the canonical
// program ID. Cached 15s in-process for speed.
app.get("/api/v1/pool", poolHandler);
app.get("/api/v1/pools", poolsAggregateHandler);
// Multi-version loan reads (V1 memecoin / V3 RWA / V4 exit). by-pda is the
// unambiguous single-loan form; the :loanId form requires ?borrower= because
// loan PDAs are seeded by borrower and loan_id is per-program.
app.get("/api/v1/loan/by-pda/:loanPda", loanByPdaHandler);
app.get("/api/v1/loan/:loanId", loanHandler);
app.get("/api/v1/wallet/:wallet/loans", walletLoansHandler);
app.get("/api/v1/simulate-borrow", simulateBorrowHandler);

// Discovery endpoints for agents. Both free + heavily cached.
//
// /collateral/eligible is the canonical "what can I borrow against?"
// answer — first-touch surface for any new agent integration.
//
// /markets/liquidatable is the canonical liquidation-bot data feed.
// Liquidation racing on Solana is a real revenue path for agents, and
// surfacing past-due-loan data prominently is how we get liquidation
// bots to integrate Magpie.
app.get("/api/v1/collateral/eligible", collateralEligibleHandler);
app.get("/api/v1/markets/liquidatable", liquidatableHandler);

// Social-proof endpoints. Both free, both heavily cached. /activity
// is the canonical "is this protocol alive?" feed for arriving agents;
// /protocol-pulse is the 24h aggregate ("how much volume?"); /leaderboard
// is the credit-score-ranked top wallets. All anonymized — wallets
// reduced to `Xxxx…Yyyy`, never any Telegram or off-chain identity.
app.get("/api/v1/agent/activity", agentActivityHandler);
app.get("/api/v1/agent/protocol-pulse", protocolPulseHandler);
app.get("/api/v1/agent/leaderboard", leaderboardHandler);

// Agent LP-state — read-only. Free because reading depositor positions
// is just an account decode (same cost class as /api/v1/pool).
app.get("/api/v1/agent/lp-state", lpStateHandler);

// Public tier constants — agents fetch this once and cache forever
// (tiers are fixed at the program level; they only change on a v3
// deploy). Free, no auth.
app.get("/api/v1/tiers", (c) => c.json({ tiers: Object.values(TIERS) }, 200, {
  "Cache-Control": "public, max-age=3600, s-maxage=3600",
}));

// ─── OpenAPI 3.1 spec (for agent auto-discovery) ──────────────
// Agent ecosystems (LangChain, Crew, Letta, etc.) commonly fetch
// /openapi.json on a service URL to learn its endpoints. Serving
// this is a fast win for discoverability.
app.get("/openapi.json", (c) => c.json({
  openapi: "3.1.0",
  info: {
    title: "Magpie x402 API — agent-native lending on Solana",
    version: "0.1.0",
    description:
      "The first lending protocol an autonomous agent can drive end-to-end (no signup, no API key, no custody). Borrow SOL against memecoins (V1) or tokenized RWAs (V3), arm in-vault take-profit / stop-loss exit orders on your own loan (V4), and repay — all permissionlessly via Solana-native x402 payments. The service holds no keys: it returns unsigned txs you sign yourself. SDK: @magpieloans/magpie-agent · MCP: @magpieloans/magpie-mcp.",
    license: { name: "MIT", identifier: "MIT" },
    contact: { url: "https://github.com/magpiecapital/magpie-x402/issues" },
  },
  servers: [{ url: "https://x402.magpie.capital" }],
  paths: {
    "/api/v1/pool": {
      get: {
        summary: "Live on-chain LendingPool state (one strategy)",
        description: "Reads the LendingPool Anchor account for one program version. ?version=v1 (memecoin, default) | v3 (RWA) | v4 (exit-order). 15s cache.",
        parameters: [{ name: "version", in: "query", required: false, schema: { type: "string", enum: ["v1", "v3", "v4"], default: "v1" } }],
        responses: { "200": { description: "Pool state (with program_version)" } },
      },
    },
    "/api/v1/pools": {
      get: {
        summary: "All three strategy pools in one call",
        description: "V1 + V3 + V4 LendingPool state together. Each version is fetched independently; a failed version appears in `partial` and never blanks the others (lane separation).",
        responses: { "200": { description: "{ pools: { v1, v3, v4 }, partial }" } },
      },
    },
    "/api/v1/loan/by-pda/{loanPda}": {
      get: {
        summary: "Fetch a single loan by its PDA (unambiguous, any version)",
        description: "Decodes the Loan account, routing to V1/V3/V4 purely from the account owner. Returns program_version, category, and (V4) in-vault exit state + exits_supported.",
        parameters: [{ name: "loanPda", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Loan (with program_version + exits_supported)" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/loan/{loanId}": {
      get: {
        summary: "Find loans by borrower + loan_id (across versions)",
        description: "Requires ?borrower= because loan PDAs are seeded by borrower and each program has its own loan_id sequence. Returns a LIST (a borrower can hold the same loan_id in more than one program). For a single unambiguous loan use /api/v1/loan/by-pda/{loanPda}.",
        parameters: [
          { name: "loanId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
          { name: "borrower", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "{ count, loans[] } each tagged with program_version" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/wallet/{wallet}/loans": {
      get: {
        summary: "All loans owned by a wallet, across V1/V3/V4",
        description: "Fans getProgramAccounts (borrower memcmp @offset 16) across all three lending programs and decodes each through the pool-separation-safe guard. Each loan is tagged with program_version + category + (V4) exit state. A failed version appears in `partial` and never blanks the rest. Optional ?status=active|repaid|liquidated. 8s cache.",
        parameters: [
          { name: "wallet", in: "path", required: true, schema: { type: "string" } },
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "repaid", "liquidated"] } },
        ],
        responses: { "200": { description: "{ count, by_version, partial, loans[] } newest-first" } },
      },
    },
    "/api/v1/tiers": {
      get: {
        summary: "Magpie loan tier definitions",
        description: "Static protocol constants — fixed 3 tiers (Express / Quick / Standard). 1h cache.",
        responses: { "200": { description: "All tier definitions" } },
      },
    },
    "/api/v1/simulate-borrow": {
      get: {
        summary: "Preview a loan WITHOUT submitting on-chain",
        description: "Pure-math quote from caller-supplied prices + the public tier constants. Use ?tier=all to get quotes for all three tiers side-by-side.",
        parameters: [
          { name: "mint", in: "query", required: true, schema: { type: "string" } },
          { name: "amount", in: "query", required: true, schema: { type: "string", pattern: "^[0-9]+$" } },
          { name: "decimals", in: "query", required: true, schema: { type: "string", pattern: "^[0-9]{1,2}$" } },
          { name: "pricePerTokenUsd", in: "query", required: true, schema: { type: "string" } },
          { name: "solPriceUsd", in: "query", required: true, schema: { type: "string" } },
          { name: "tier", in: "query", required: false, schema: { type: "string", enum: ["express", "quick", "standard", "all"], default: "all" } },
        ],
        responses: { "200": { description: "BorrowQuote or { tier: 'all', quotes: [...] }" } },
      },
    },
    "/api/v1/credit-score": {
      get: {
        summary: "Magpie credit score for a wallet (paid: 0.001 SOL)",
        description: "Returns the 300-850 credit score + tier benefits for a wallet. Requires x402 payment.",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Credit score + tier benefits" },
          "402": { description: "Payment Required — see X-Payment-Required-* headers" },
        },
      },
    },
    "/api/v1/agent/intent": {
      post: {
        summary: "Create a conditional borrow intent (paid: 0.01 SOL)",
        description: "The wedge of agent-native lending: post an intent specifying WHEN to fire a borrow. The bot watches the condition every 30s and builds the unsigned tx when matched. Same anti-exploit gates as direct borrows. Optional webhook_url for push delivery — server POSTs an HMAC-signed payload when matched, eliminating poll cost. The webhook_secret is returned ONCE at create time.",
        responses: {
          "200": { description: "Intent created (optionally with webhook { url, secret, signature_header })" },
          "400": { description: "Validation error (including invalid_webhook_url for SSRF/credentials/non-HTTPS)" },
          "402": { description: "Payment Required" },
          "429": { description: "Too many pending intents" },
        },
      },
      get: {
        summary: "Poll intent status (paid: 0.0005 SOL)",
        description: "When status='matched', the response includes partial_signed_tx_b64 ready to sign + submit.",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Intent state" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        summary: "Cancel a pending intent (free)",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cancelled" }, "404": { description: "Not found or terminal" } },
      },
    },
    "/api/v1/agent/intents": {
      get: {
        summary: "List intents for a wallet (paid: 0.001 SOL)",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Intent list (newest first, max 100)" } },
      },
    },
    "/api/v1/collateral/eligible": {
      get: {
        summary: "Catalog of every approved collateral token",
        description: "Public token registry — mint, symbol, decimals, category. 1h cache. First-touch endpoint for agents discovering what they can borrow against.",
        responses: { "200": { description: "Token catalog grouped by category" } },
      },
    },
    "/api/v1/markets/liquidatable": {
      get: {
        summary: "Active loans currently liquidatable (past due)",
        description: "Multi-version (V1 memecoin + V3 RWA by default). Sorted most-past-due-first; each loan tagged with program_version. V4 (exit-order) loans auto-sell in-vault and are EXCLUDED by default; pass ?include_v4=true to add them. Optional within_seconds for pre-positioning. Free — the read surface for liquidation-bot agents.",
        parameters: [
          { name: "within_seconds", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 604800, default: 0 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
          { name: "include_v4", in: "query", required: false, schema: { type: "string", enum: ["true", "false"], default: "false" } },
        ],
        responses: { "200": { description: "Liquidatable loan list with per-loan program_version + seconds_past_due" } },
      },
    },
    "/api/v1/agent/activity": {
      get: {
        summary: "Anonymized recent protocol activity stream",
        description: "Last N borrow/repay/liquidate events. Wallets anonymized to Xxxx…Yyyy. No PII. The first-touch 'is this protocol alive' feed for new agents and third-party monitors. Free — 15s cache.",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { "200": { description: "Activity stream (newest-first)" } },
      },
    },
    "/api/v1/agent/protocol-pulse": {
      get: {
        summary: "24h protocol aggregates",
        description: "Active loans, active borrowers, borrow volume and counts over 24h + 1h windows, liquidation counts. Pure numbers, no per-wallet data. Free — 30s cache.",
        responses: { "200": { description: "Aggregate counts + volume" } },
      },
    },
    "/api/v1/agent/leaderboard": {
      get: {
        summary: "Top wallets by Magpie credit score",
        description: "Top 20 wallets ranked by credit score. Anonymized to Xxxx…Yyyy. Free — 60s cache.",
        responses: { "200": { description: "Credit leaderboard" } },
      },
    },
    "/api/v1/agent/lp-state": {
      get: {
        summary: "Read a wallet's LP position + pool context",
        description: "Free. Shares, deposited lamports, current value, yield earned, share-of-pool. Plus pool totals for the caller to compute their own ratios. 10s cache.",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Position + pool context" } },
      },
    },
    "/api/v1/agent/build-liquidate": {
      post: {
        summary: "Build an unsigned liquidate-loan tx (paid 0.003 SOL)",
        description: "Permissionless on the Anchor side — any wallet can sign and submit. The keeper (the agent's wallet) receives keeper_reward_bps of the seized collateral; the rest goes to the lender authority for pool recovery. Server pre-validates the loan exists, is active, and is past due before building.",
        responses: {
          "200": { description: "partial_signed_tx_b64 + summary + keeper_reward_info" },
          "400": { description: "Validation error or loan not yet due" },
          "402": { description: "Payment Required" },
          "404": { description: "loan_not_active" },
        },
      },
    },
    "/api/v1/agent/token-risk": {
      get: {
        summary: "Per-token risk profile (paid 0.001 SOL)",
        description: "Risk score (0-100), dimension breakdown (volatility, liquidity, concentration, volume, rug_pull), market data, lending impact (max allowed LTV the program will actually enforce), operator flags. Useful for an agent's collateral-selection step before posting a build-borrow.",
        parameters: [{ name: "mint", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Token risk profile" },
          "402": { description: "Payment Required" },
          "404": { description: "No risk profile for this mint" },
        },
      },
    },
    "/api/v1/agent/build-deposit": {
      post: {
        summary: "Build an unsigned LP-deposit tx (paid 0.002 SOL)",
        description: "Wraps SOL → wSOL → deposits into the main LendingPool → closes wSOL (recovers dust). Caller signs locally and submits. Server never touches the keypair.",
        responses: {
          "200": { description: "partial_signed_tx_b64 + summary" },
          "400": { description: "Validation error" },
          "402": { description: "Payment Required" },
        },
      },
    },
    "/api/v1/agent/build-withdraw": {
      post: {
        summary: "Build an unsigned LP-withdraw tx (paid 0.002 SOL)",
        description: "Withdraws the requested shares back to SOL. Server pre-validates against the on-chain position and refuses chunks larger than max_safe_shares (avoids the v1 u64 overflow).",
        responses: {
          "200": { description: "partial_signed_tx_b64 + summary" },
          "400": { description: "Validation error or insufficient position" },
          "402": { description: "Payment Required" },
        },
      },
    },
    "/api/v1/agent/build-borrow": {
      post: {
        summary: "Build an unsigned borrow tx (paid 0.005 SOL)",
        description: "Body: { borrower_wallet, collateral_mint, collateral_amount (u64 string), tier (0|1|2), has_exit_arming? }. The borrow is routed by the bot: no-exits+memecoin → V1, no-exits+RWA → V3, has_exit_arming=true → V4 (so the agent can then arm in-vault exit orders on the loan). x402 payer must equal borrower_wallet. The agent signs + submits via the lender-cosign endpoint.",
        responses: {
          "200": { description: "partial_signed_tx_b64 + summary (program_id, program_version, loan_id, loan_pda)" },
          "400": { description: "Validation error (classified for known V4 rejections)" },
          "402": { description: "Payment Required" },
          "403": { description: "payer != borrower_wallet" },
        },
      },
    },
    "/api/v1/agent/self-limit-close/arm": {
      post: {
        summary: "Arm an in-vault exit order on YOUR OWN V4 loan (paid 0.001 SOL)",
        description: "Self-custody agents manage exits on their own loans — no Telegram, no delegation, no custodial keypair. Body is an Ed25519-signed envelope { signedMessageBase64, signatureBase58, signerPubkey } whose signed text carries magpie: limit-close-arm/v1, From (==signer), LoanId, Direction (above=TP / below=SL), the trigger, Nonce, IssuedAt. x402 binds payer==signer; the bot re-verifies the signature, enforces ownership, and enforces exits-are-V4-only. SDK helper builds + signs the envelope for you.",
        responses: {
          "200": { description: "Order armed" },
          "400": { description: "Bad envelope / not a V4 loan (exits_require_v4_loan)" },
          "402": { description: "Payment Required" },
          "403": { description: "payer != envelope signer" },
          "409": { description: "nonce_already_used — the original arm likely succeeded (idempotent)" },
        },
      },
    },
    "/api/v1/agent/self-limit-close/arm-batch": {
      post: {
        summary: "Arm a ladder of exit orders on your own V4 loan (paid 0.001 SOL)",
        description: "Same signed-envelope auth as /arm (magpie: limit-close-arm-batch/v1). Arms multiple take-profit / stop-loss steps in one call.",
        responses: { "200": { description: "Batch armed" }, "402": { description: "Payment Required" }, "403": { description: "payer != signer" } },
      },
    },
    "/api/v1/agent/self-limit-close/modify": {
      post: {
        summary: "Modify an armed exit on your own loan (free)",
        description: "Signed envelope (magpie: limit-close-modify/v1, OrderId). Change trigger / slippage / destination / expiry without re-paying — the signature authorizes.",
        responses: { "200": { description: "Modified" }, "409": { description: "Already firing / not modifiable" } },
      },
    },
    "/api/v1/agent/self-limit-close/cancel": {
      post: {
        summary: "Cancel an armed exit on your own loan (free)",
        description: "Signed envelope (magpie: limit-close-cancel/v1, OrderId). A too-late cancel is a 409 no-op (the engine flipped to firing).",
        responses: { "200": { description: "Cancelled" }, "409": { description: "Not cancellable" } },
      },
    },
    "/api/v1/agent/self-limit-close/list": {
      get: {
        summary: "List your armed exit orders (free)",
        description: "All armed exit orders for a wallet. Public read of the same data the owner sees in the UI.",
        parameters: [{ name: "wallet", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Armed order list" } },
      },
    },
  },
}));

app.get("/.well-known/x402.json", (c) =>
  c.json({
    scheme: "x402/solana/v1",
    name: "Magpie — agent-native lending on Solana",
    description:
      "The first lending protocol an autonomous agent drives end-to-end, no custody: borrow against memecoins (V1) or RWAs (V3), arm in-vault TP/SL exit orders on your own loan (V4), repay. Pay per call via x402; get back unsigned txs you sign yourself.",
    docs: "https://github.com/magpiecapital/magpie-x402#readme",
    sdk: "@magpieloans/magpie-agent",
    mcp: "@magpieloans/magpie-mcp",
    payTo: PAY_TO ?? null,
    endpoints: [
      {
        method: "GET",
        path: "/api/v1/pool",
        params: { version: "optional v1|v3|v4 (default v1) — which strategy's pool" },
        priceLamports: "0",
        priceLabel: "free (15s server cache)",
        description: "Live on-chain LendingPool state for one strategy version — totalDeposits, totalBorrowed, totalLoansIssued, totalLiquidations, totalFeesEarned. Use /api/v1/pools for all three at once.",
      },
      {
        method: "GET",
        path: "/api/v1/credit-score",
        params: { wallet: "Solana pubkey (base58)" },
        priceLamports: "1000000",
        priceLabel: "0.001 SOL per lookup",
        description: "Magpie on-chain credit score (300-850) + tier benefits",
      },
      {
        method: "POST",
        path: "/api/v1/agent/intent",
        params: {
          borrower_wallet: "Solana pubkey",
          collateral_mint: "Solana mint",
          collateral_amount: "u64 string",
          tier: "0|1|2",
          condition_type: "price_above|price_below|time_after|pool_liq_above",
          condition_params: "shape depends on condition_type",
          expires_in_seconds: "optional, default 86400, max 2592000",
          webhook_url: "optional HTTPS URL — push delivery on match (eliminates polling). Server returns webhook_secret ONCE for HMAC signature verification.",
        },
        priceLamports: "10000000",
        priceLabel: "0.01 SOL per intent",
        description: "Post a CONDITIONAL borrow: bot watches a trigger condition (price/time/liquidity) and builds the unsigned tx when matched. Agent EITHER polls + signs + submits OR receives an HMAC-signed POST at webhook_url. Single payment covers the entire intent lifecycle. Same anti-exploit gates as direct borrows.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/intent",
        params: { id: "intent_id from create" },
        priceLamports: "500000",
        priceLabel: "0.0005 SOL per poll",
        description: "Poll the status of a conditional borrow intent. Returns partial_signed_tx_b64 + summary when status='matched'.",
      },
      {
        method: "DELETE",
        path: "/api/v1/agent/intent",
        params: { id: "intent_id" },
        priceLamports: "0",
        priceLabel: "free",
        description: "Cancel a pending conditional borrow intent.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/intents",
        params: { wallet: "Solana pubkey" },
        priceLamports: "1000000",
        priceLabel: "0.001 SOL per list",
        description: "List all conditional borrow intents for a wallet (newest first, max 100).",
      },
      {
        method: "GET",
        path: "/api/v1/collateral/eligible",
        params: {},
        priceLamports: "0",
        priceLabel: "free (1h cache)",
        description: "Catalog of every token currently approved as Magpie collateral. Mint, symbol, decimals, category. First-touch endpoint for any agent integrating Magpie.",
      },
      {
        method: "GET",
        path: "/api/v1/markets/liquidatable",
        params: {
          within_seconds: "optional int — also include loans due within N seconds (0..604800), default 0",
          limit: "optional int — max returned entries (1..500), default 100",
          include_v4: "optional 'true' — include V4 exit-order loans (excluded by default; they auto-sell in-vault)",
        },
        priceLamports: "0",
        priceLabel: "free (8s cache)",
        description: "Active V1/V3 loans at or past their on-chain due timestamp — the canonical liquidation-bot data feed, each tagged with program_version. The liquidate ix is permissionless on-chain; any wallet can call it and receive the liquidator reward.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/activity",
        params: { limit: "optional int (1..200), default 50" },
        priceLamports: "0",
        priceLabel: "free (15s cache)",
        description: "Anonymized recent protocol activity — borrows, repays, liquidations. Wallets reduced to Xxxx…Yyyy short forms. First-touch 'is this protocol alive' feed for arriving agents.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/protocol-pulse",
        params: {},
        priceLamports: "0",
        priceLabel: "free (30s cache)",
        description: "24h protocol aggregates — active loans, active borrowers, borrow volume, liquidation counts. Pure numbers, no per-wallet data.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/leaderboard",
        params: {},
        priceLamports: "0",
        priceLabel: "free (60s cache)",
        description: "Top wallets by Magpie credit score, anonymized.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/lp-state",
        params: { wallet: "Solana pubkey (base58)" },
        priceLamports: "0",
        priceLabel: "free (10s cache)",
        description: "Depositor position state + pool context — shares, deposited lamports, current value, yield earned, share-of-pool.",
      },
      {
        method: "POST",
        path: "/api/v1/agent/build-liquidate",
        params: {
          keeper: "Solana pubkey (base58) — the agent's wallet, will sign + receive the keeper bounty",
          loan_pda: "Solana pubkey (base58) — loan PDA from /api/v1/markets/liquidatable",
        },
        priceLamports: "3000000",
        priceLabel: "0.003 SOL per build",
        description: "Build an unsigned liquidate-loan tx for a past-due active loan. Keeper receives keeper_reward_bps share of seized collateral; rest goes to lender authority. Server pre-validates loan status + due time before building.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/token-risk",
        params: { mint: "Solana mint pubkey (base58)" },
        priceLamports: "1000000",
        priceLabel: "0.001 SOL per lookup",
        description: "Magpie's internal token risk profile — score, dimensions, market data, lending impact, operator flags. Pre-borrow collateral-selection signal.",
      },
      {
        method: "POST",
        path: "/api/v1/agent/build-deposit",
        params: {
          depositor: "Solana pubkey (base58)",
          lamports: "u64 string in lamports (min 10000000 = 0.01 SOL)",
        },
        priceLamports: "2000000",
        priceLabel: "0.002 SOL per build",
        description: "Build an unsigned LP-deposit tx — wraps SOL → wSOL → deposits into the main LendingPool → closes wSOL ATA. Caller signs and submits.",
      },
      {
        method: "POST",
        path: "/api/v1/agent/build-withdraw",
        params: {
          depositor: "Solana pubkey",
          shares: "u64 string — LP shares to redeem",
        },
        priceLamports: "2000000",
        priceLabel: "0.002 SOL per build",
        description: "Build an unsigned LP-withdraw tx for the given shares. Server refuses chunks larger than max_safe_shares (avoids the v1 program's u64 overflow on huge positions). For positions above one safe chunk, withdraw in multiple calls.",
      },
      {
        method: "GET",
        path: "/api/v1/pools",
        params: {},
        priceLamports: "0",
        priceLabel: "free (15s cache)",
        description: "All three strategy pools (V1 memecoin / V3 RWA / V4 exit-order) in one call, fail-soft per version.",
      },
      {
        method: "GET",
        path: "/api/v1/loan/by-pda/{loanPda}",
        params: { loanPda: "Solana pubkey (base58) of the loan PDA" },
        priceLamports: "0",
        priceLabel: "free (10s cache)",
        description: "Single loan by PDA, routed to V1/V3/V4 from the account owner. Returns program_version, category, V4 in-vault exit state, and exits_supported.",
      },
      {
        method: "GET",
        path: "/api/v1/wallet/{wallet}/loans",
        params: { wallet: "Solana pubkey (base58)", status: "optional active|repaid|liquidated" },
        priceLamports: "0",
        priceLabel: "free (8s cache)",
        description: "Every loan a wallet holds across V1/V3/V4, each tagged with program_version + category + (V4) exit state. Fail-soft per version (a failed version appears in `partial`).",
      },
      {
        method: "POST",
        path: "/api/v1/agent/build-borrow",
        params: {
          borrower_wallet: "Solana pubkey",
          collateral_mint: "Solana mint",
          collateral_amount: "u64 string",
          tier: "0|1|2",
          has_exit_arming: "optional boolean — true routes the borrow to V4 so exit orders can be armed on the loan",
        },
        priceLamports: "5000000",
        priceLabel: "0.005 SOL per build",
        description: "Build an unsigned borrow tx. Routed by the bot: no-exits+memecoin → V1, no-exits+RWA → V3, has_exit_arming → V4. x402 payer must equal borrower_wallet.",
      },
      {
        method: "POST",
        path: "/api/v1/agent/self-limit-close/arm",
        params: {
          signedMessageBase64: "base64 of the Ed25519-signed envelope (magpie: limit-close-arm/v1; From==signer; LoanId; Direction above=TP/below=SL; trigger; Nonce; IssuedAt)",
          signatureBase58: "base58 ed25519 signature",
          signerPubkey: "Solana pubkey (== loan owner == x402 payer)",
        },
        priceLamports: "1000000",
        priceLabel: "0.001 SOL per arm",
        description: "Arm an in-vault take-profit / stop-loss exit on YOUR OWN V4 loan. Self-custody; no Telegram, no delegation, no custodial keypair. x402 binds payer==signer; the bot enforces ownership + exits-are-V4-only. Free /modify, /cancel, /list companions.",
      },
      {
        method: "GET",
        path: "/api/v1/agent/self-limit-close/list",
        params: { wallet: "Solana pubkey (base58)" },
        priceLamports: "0",
        priceLabel: "free",
        description: "List the armed in-vault exit orders for a wallet.",
      },
    ],
    contact: "https://github.com/magpiecapital/magpie-x402/issues",
    examples: "https://github.com/magpiecapital/magpie-x402/tree/main/examples",
    mcp_server: "https://github.com/magpiecapital/magpie-x402/tree/main/mcp",
  }),
);

// ─── Paid endpoints ─────────────────────────────────────────────
if (PAY_TO) {
  app.get(
    "/api/v1/credit-score",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n, // 0.001 SOL per call
      label: "Magpie credit-score lookup",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#credit-score",
    }),
    creditScoreHandler,
  );

  // Agent-native borrow tx builder. Pays for the construction + the
  // full server-side gate evaluation (ban registry, anti-exploit,
  // TWAP, pool floor, cross-source price). Returns an unsigned
  // partial-signed tx the agent then signs with their own wallet and
  // submits via the existing cosign-borrow endpoint.
  //
  // Priced higher than read endpoints because it (a) does on-chain
  // blockhash fetch + RPC writes, (b) consumes the bot's gate-eval
  // pipeline, (c) is the high-value endpoint that completes the
  // borrow loop autonomously.
  app.post(
    "/api/v1/agent/build-borrow",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 5_000_000n, // 0.005 SOL per build
      label: "Magpie agent borrow-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-borrow",
    }),
    buildBorrowHandler,
  );

  // Signed credit attestation. The killer differentiator: the response
  // includes an ed25519 signature from the lender authority over a
  // canonical payload, so OTHER protocols can verify the score
  // cryptographically. Portable on-chain reputation for agents.
  //
  // Priced low (0.0005 SOL) because we want this to be cheap enough
  // that protocols building on it can afford to verify per-request.
  app.get(
    "/api/v1/agent/credit-attest",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 500_000n, // 0.0005 SOL per attestation
      label: "Magpie signed credit attestation",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-credit-attest",
    }),
    creditAttestHandler,
  );

  // Build an unsigned repay tx for an agent's loan. Closes the loop:
  // agents can now borrow AND repay programmatically. Cheaper than
  // build-borrow because repay is a simpler tx (no cosign, no live
  // price oracle, no anti-exploit gauntlet — repay is universally
  // safe and always in the user's interest).
  app.post(
    "/api/v1/agent/build-repay",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n, // 0.002 SOL per build
      label: "Magpie agent repay-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-repay",
    }),
    buildRepayHandler,
  );

  // Loan management — extend, topup, partial-repay. All same price
  // as repay (simpler txs, no cosign, no live oracle).
  app.post(
    "/api/v1/agent/build-extend",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n,
      label: "Magpie agent extend-loan-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-extend",
    }),
    buildExtendHandler,
  );
  app.post(
    "/api/v1/agent/build-topup",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n,
      label: "Magpie agent topup-collateral-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-topup",
    }),
    buildTopupHandler,
  );
  app.post(
    "/api/v1/agent/build-partial-repay",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n,
      label: "Magpie agent partial-repay-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-partial-repay",
    }),
    buildPartialRepayHandler,
  );

  // ── LP-side (agent-as-lender) ──
  // Completes the protocol-integration loop. With these two endpoints
  // agents can also EARN yield, not just borrow — deposit SOL into the
  // main LendingPool and withdraw shares against the live shares:
  // deposits ratio. Same price as the loan-management builders.
  app.post(
    "/api/v1/agent/build-deposit",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n,
      label: "Magpie agent LP-deposit-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-deposit",
    }),
    buildDepositHandler,
  );
  app.post(
    "/api/v1/agent/build-withdraw",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 2_000_000n,
      label: "Magpie agent LP-withdraw-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-withdraw",
    }),
    buildWithdrawHandler,
  );

  // ── Build-liquidate ──
  // Closes the liquidation-bot loop. Agents see liquidatable loans via
  // /api/v1/markets/liquidatable (free); this endpoint builds the
  // unsigned tx so they don't have to roll their own Anchor client.
  // Priced 0.003 SOL — slightly above the 0.002 SOL build-builders
  // because the server does extra RPC (Loan account fetch + mint
  // account fetch to detect token program) and the per-liquidation
  // upside for the agent is materially higher than a deposit/withdraw.
  app.post(
    "/api/v1/agent/build-liquidate",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 3_000_000n,
      label: "Magpie agent liquidate-tx builder",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-build-liquidate",
    }),
    buildLiquidateHandler,
  );

  // ── Token risk score ──
  // Per-token risk profile from Magpie's internal risk engine. Useful
  // for agents picking collateral before posting a build-borrow.
  // Priced same as credit-score (0.001 SOL) — both are scoring lookups
  // that compress non-trivial protocol intelligence into a single
  // decision input.
  app.get(
    "/api/v1/agent/token-risk",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n,
      label: "Magpie token risk score",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-token-risk",
    }),
    tokenRiskHandler,
  );

  // ── Conditional borrow intents — "limit orders for borrows" ──
  // The wedge that makes Magpie the first agent-native lending
  // protocol. One paid POST reserves a watcher slot for the intent's
  // TTL; cheap GETs let agents poll without cost concerns.
  //
  // CREATE: 0.01 SOL — covers the gauntlet runs throughout the
  // intent's life + the final tx build. Single payment, no surprises.
  app.post(
    "/api/v1/agent/intent",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 10_000_000n, // 0.01 SOL per intent
      label: "Magpie agent conditional-borrow intent",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-intent",
    }),
    createIntentHandler,
  );
  // POLL: 0.0005 SOL — bot must work to fetch + serialize current
  // state; agents typically poll every 30s.
  app.get(
    "/api/v1/agent/intent",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 500_000n,
      label: "Magpie agent intent status",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-intent",
    }),
    getIntentHandler,
  );
  // CANCEL: free. Don't tax cleanup.
  app.delete("/api/v1/agent/intent", cancelIntentHandler);
  // LIST: 0.001 SOL.
  app.get(
    "/api/v1/agent/intents",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n,
      label: "Magpie agent intent list",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-intents",
    }),
    listIntentsHandler,
  );

  // ── Agent-mediated limit-close-and-sell ──
  // Tier 2 of the limit-close architecture. The borrower has pre-
  // authorized THIS agent's pubkey via the TG /agent-authorize
  // command (which writes an agent_delegations row). The agent
  // pays 0.001 SOL via x402 to arm an order; the bot validates
  // the delegation + order params, INSERTs into limit_close_orders
  // with source='agent_x402', and the private engine processes it
  // identically to a TG-armed order.
  //
  // Arm fee is 0.001 SOL (same as credit-score / token-risk) —
  // a one-time charge that covers the watch loop's resource cost;
  // the 1% execution fee on fire is where the protocol earns the
  // real value (a fee on the proceeds, not on the arm).
  //
  // Read / list / cancel / preflight / modify / delegations /
  // eligible-loans are FREE so agents can manage their pipeline
  // without being taxed. Each is scoped by the verified signer of a
  // signed Ed25519 envelope (headers X-Magpie-Env-Msg / -Sig /
  // -Signer, per-action magpie: limit-close-*/v1 binding, OrderId
  // bound for order-scoped ops) — NOT a self-asserted X-Agent-Pubkey
  // header. Agent pubkeys are public, so the prior header-trust let
  // anyone disarm another agent's stop-loss; the signature now proves
  // control of the key and keeps an agent from touching competitors'
  // orders. (audit 2026-06-21, HIGH)
  app.post(
    "/api/v1/agent/limit-close",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n, // 0.001 SOL per arm
      label: "Magpie agent limit-close arm",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#agent-limit-close",
    }),
    armLimitCloseHandler,
  );
  // Free preflight — same body shape as /arm, no x402 payment. Lets
  // agents check "would this arm succeed?" before paying. Saves
  // arm-fees on rejected configs.
  app.post("/api/v1/agent/limit-close/preflight", preflightLimitCloseHandler);
  // Free in-place modify — agent already paid for the arm slot.
  app.patch("/api/v1/agent/limit-close/modify", modifyLimitCloseHandler);
  app.post("/api/v1/agent/limit-close/modify", modifyLimitCloseHandler);
  app.get("/api/v1/agent/limit-close", getLimitCloseHandler);
  app.get("/api/v1/agent/limit-close/list", listLimitCloseHandler);
  app.get("/api/v1/agent/limit-close/delegations", listDelegationsHandler);
  app.get("/api/v1/agent/limit-close/eligible-loans", listEligibleLoansHandler);
  app.delete("/api/v1/agent/limit-close", cancelLimitCloseHandler);

  // ── Self-owned exit orders (loan OWNER arms exits on its OWN V4 loan) ──
  // The caller IS the borrower: a self-custody agent that opened a V4 loan
  // (build-borrow with has_exit_arming=true) manages its own in-vault auto-
  // sell exits via an Ed25519-signed envelope — no TG, no delegation, no
  // custodial keypair. The signature authorizes; x402 binds payer==signer on
  // the paid arms and forwards to the bot's signature-gated site surface.
  // V4-only + ownership are enforced bot-side (V4_EXIT_EXCLUSIVE_ENFORCE).
  app.post(
    "/api/v1/agent/self-limit-close/arm",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n, // 0.001 SOL per arm (matches delegation arm)
      label: "Magpie self limit-close arm",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#self-limit-close",
    }),
    armSelfLimitCloseHandler,
  );
  app.post(
    "/api/v1/agent/self-limit-close/arm-batch",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 1_000_000n, // 0.001 SOL per batch arm
      label: "Magpie self limit-close arm-batch",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#self-limit-close",
    }),
    armBatchSelfLimitCloseHandler,
  );
  // Free management — the agent already paid to arm; steering its own
  // orders (signature-authorized) isn't taxed.
  app.post("/api/v1/agent/self-limit-close/modify", modifySelfLimitCloseHandler);
  app.delete("/api/v1/agent/self-limit-close/cancel", cancelSelfLimitCloseHandler);
  app.post("/api/v1/agent/self-limit-close/cancel", cancelSelfLimitCloseHandler);
  app.get("/api/v1/agent/self-limit-close/list", listSelfLimitCloseHandler);
} else {
  // Surfaces a clear "service misconfigured" error instead of a silent
  // 404 when MAGPIE_PAY_TO isn't set in the environment.
  app.get("/api/v1/credit-score", (c) =>
    c.json({ error: "service_not_configured", reason: "MAGPIE_PAY_TO not set" }, 503),
  );
  app.post("/api/v1/agent/build-borrow", (c) =>
    c.json({ error: "service_not_configured", reason: "MAGPIE_PAY_TO not set" }, 503),
  );
}

// ─── Generic 404 + central error handler ────────────────────────
app.notFound((c) =>
  c.json(
    { error: "not_found", try: ["/", "/health", "/.well-known/x402.json"] },
    404,
  ),
);

app.onError((err, c) => {
  console.error("[magpie-x402] unhandled:", err);
  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
