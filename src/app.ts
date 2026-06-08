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
import { poolHandler } from "./routes/pool.js";
import { loanHandler } from "./routes/loan.js";

const PAY_TO = process.env.MAGPIE_PAY_TO;

const app = new Hono();

// Order matters: security headers + CORS + rate limit BEFORE any route
app.use("*", secureHeaders());
app.use("*", cors({
  origin: (process.env.CORS_ORIGINS || "*").split(",").map((s) => s.trim()),
  allowMethods: ["GET", "HEAD", "OPTIONS"],
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
        "GET /api/v1/pool — live on-chain LendingPool state (15s cache)",
      ],
      paid: ["GET /api/v1/credit-score?wallet=<pubkey>"],
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
    ],
    contact: "https://github.com/magpiecapital/magpie-x402/issues",
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
} else {
  // Surfaces a clear "service misconfigured" error instead of a silent
  // 404 when MAGPIE_PAY_TO isn't set in the environment.
  app.get("/api/v1/credit-score", (c) =>
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
