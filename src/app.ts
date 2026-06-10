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
import { x402Required } from "./middleware/x402.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { creditScoreHandler } from "./routes/credit-score.js";
import { creditScoreBatchHandler } from "./routes/credit-score-batch.js";
import { poolHandler } from "./routes/pool.js";
import { loanHandler } from "./routes/loan.js";
import { walletLoansHandler } from "./routes/wallet-loans.js";
import { walletHealthHandler } from "./routes/wallet-health.js";
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
import { recentBorrowsHandler } from "./routes/recent-borrows.js";
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
import { tokenRiskHandler } from "./routes/token-risk.js";
import { TIERS } from "./lib/tiers.js";

const PAY_TO = process.env.MAGPIE_PAY_TO;

const app = new Hono();

// Order matters: security headers + CORS + rate limit BEFORE any route
app.use("*", secureHeaders());
app.use("*", cors({
  origin: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()),
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

// ─── Free endpoints ────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "magpie-x402",
    version: "0.1.0",
    description: "x402 payment-required API for the Magpie Capital protocol",
    docs: "https://github.com/magpiecapital/magpie-x402#readme",
    endpoints: {
      free: [
        "GET /health",
        "GET /.well-known/x402.json",
        "GET /openapi.json",
        "GET /api/v1/pool — live on-chain LendingPool state (15s cache)",
        "GET /api/v1/tiers — protocol tier constants (1h cache)",
        "GET /api/v1/loan/:loanId — single loan by u64 id",
        "GET /api/v1/wallet/:wallet/loans — all loans for a wallet (8s cache)",
        "GET /api/v1/wallet/:wallet/health — per-loan and portfolio health factor (8s cache)",
        "GET /api/v1/simulate-borrow — preview a loan from caller-supplied prices (free)",
        "GET /api/v1/collateral/eligible — full collateral catalog (1h cache)",
        "GET /api/v1/markets/liquidatable — past-due active loans for liquidation bots (8s cache)",
        "GET /api/v1/markets/recent-borrows — most recent loans across the protocol (15s cache)",
        "GET /api/v1/agent/activity — anonymized recent borrow/repay/liquidate events (15s cache)",
        "GET /api/v1/agent/protocol-pulse — 24h aggregate volume + counts (30s cache)",
        "GET /api/v1/agent/leaderboard — top wallets by Magpie credit score (60s cache)",
        "GET /api/v1/agent/lp-state?wallet=<pubkey> — depositor position + pool context (10s cache)",
      ],
      paid: [
        "GET /api/v1/credit-score?wallet=<pubkey> — 0.001 SOL",
        "POST /api/v1/credit-score/batch — batch credit-score lookups (0.02 SOL flat, max 50 wallets)",
        "GET /api/v1/agent/token-risk?mint=<pubkey> — 0.001 SOL (per-token risk profile)",
        "GET /api/v1/agent/credit-attest?wallet=<pubkey> — 0.0005 SOL (signed, portable)",
        "POST /api/v1/agent/build-borrow — 0.005 SOL (full anti-exploit gate eval)",
        "POST /api/v1/agent/build-repay — 0.002 SOL",
        "POST /api/v1/agent/build-extend — 0.002 SOL",
        "POST /api/v1/agent/build-topup — 0.002 SOL",
        "POST /api/v1/agent/build-partial-repay — 0.002 SOL",
        "POST /api/v1/agent/build-deposit — 0.002 SOL (LP — deposit SOL into the LendingPool)",
        "POST /api/v1/agent/build-withdraw — 0.002 SOL (LP — withdraw shares)",
        "POST /api/v1/agent/intent — 0.01 SOL (conditional borrow, single payment for lifecycle)",
        "GET /api/v1/agent/intent?id=<intent_id> — 0.0005 SOL",
        "GET /api/v1/agent/intents?wallet=<pubkey> — 0.001 SOL",
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
app.get("/api/v1/loan/:loanId", loanHandler);
app.get("/api/v1/wallet/:wallet/loans", walletLoansHandler);
app.get("/api/v1/wallet/:wallet/health", walletHealthHandler);
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
app.get("/api/v1/markets/recent-borrows", recentBorrowsHandler);

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
    title: "Magpie x402 API",
    version: "0.1.0",
    description: "Pay-per-call API for Magpie Capital's permissionless lending protocol. Solana-native x402 payments.",
    license: { name: "MIT", identifier: "MIT" },
    contact: { url: "https://github.com/magpiecapital/magpie-x402/issues" },
  },
  servers: [{ url: "https://x402.magpie.capital" }],
  paths: {
    "/api/v1/pool": {
      get: {
        summary: "Live on-chain LendingPool state",
        description: "Reads the Magpie LendingPool Anchor account directly from the program. 15s in-process cache.",
        responses: { "200": { description: "Pool state", content: { "application/json": {} } } },
      },
    },
    "/api/v1/loan/{loanId}": {
      get: {
        summary: "Fetch a single loan by ID",
        description: "Reads the Loan PDA from the program for the given u64 loan_id.",
        parameters: [{ name: "loanId", in: "path", required: true, schema: { type: "string", pattern: "^[0-9]+$" } }],
        responses: {
          "200": { description: "Loan state" },
          "404": { description: "Loan not found" },
        },
      },
    },
    "/api/v1/wallet/{wallet}/loans": {
      get: {
        summary: "All loans owned by a wallet",
        description: "Single-roundtrip getProgramAccounts + memcmp filter on the borrower offset. Optional ?status=active|repaid|liquidated query filter. 8s cache.",
        parameters: [
          { name: "wallet", in: "path", required: true, schema: { type: "string" } },
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "repaid", "liquidated"] } },
        ],
        responses: { "200": { description: "Loan list (newest-first)" } },
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
        description: "The wedge of agent-native lending: post an intent specifying WHEN to fire a borrow. The bot watches the condition every 30s and builds the unsigned tx when matched. Same anti-exploit gates as direct borrows.",
        responses: {
          "200": { description: "Intent created" },
          "400": { description: "Validation error" },
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
        description: "Sorted most-past-due-first. Optional within_seconds query for pre-positioning. Free — the read surface for liquidation-bot agents.",
        parameters: [
          { name: "within_seconds", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 604800, default: 0 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 100 } },
        ],
        responses: { "200": { description: "Liquidatable loan list with per-loan seconds_past_due" } },
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
  },
}));

app.get("/.well-known/x402.json", (c) =>
  c.json({
    scheme: "x402/solana/v1",
    payTo: PAY_TO ?? null,
    endpoints: [
      {
        method: "GET",
        path: "/api/v1/pool",
        params: {},
        priceLamports: "0",
        priceLabel: "free (15s server cache)",
        description: "Live on-chain LendingPool state — totalDeposits, totalBorrowed, totalLoansIssued, totalLiquidations, totalFeesEarned. Decoded directly from the Magpie program account.",
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
        },
        priceLamports: "10000000",
        priceLabel: "0.01 SOL per intent",
        description: "Post a CONDITIONAL borrow: bot watches a trigger condition (price/time/liquidity) and builds the unsigned tx when matched. Agent then polls + signs + submits. Single payment covers the entire intent lifecycle. Same anti-exploit gates as direct borrows.",
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
        },
        priceLamports: "0",
        priceLabel: "free (8s cache)",
        description: "Active loans at or past their on-chain due timestamp — the canonical liquidation-bot data feed. The liquidate ix is permissionless on-chain; any wallet can call it and receive the liquidator reward.",
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

  // Batch credit-score lookup — max 50 wallets per request.
  // Flat 0.02 SOL covers the mid-range case; pricing is a single
  // x402 payment regardless of batch size.
  app.post(
    "/api/v1/credit-score/batch",
    x402Required({
      payTo: PAY_TO,
      amountLamports: 20_000_000n, // 0.02 SOL flat per batch
      label: "Magpie batch credit-score lookup",
      docsUrl: "https://github.com/magpiecapital/magpie-x402#credit-score-batch",
    }),
    creditScoreBatchHandler,
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
