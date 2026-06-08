/**
 * magpie-x402 — server entry point.
 *
 * Lightweight Hono server exposing Magpie Capital protocol data behind
 * the x402 (HTTP 402 Payment Required) standard. Designed for AI agents
 * and other Solana protocols to pay-per-call for credit scores, token
 * risk assessments, and protocol analytics.
 *
 * Free endpoints (rate-limited):
 *   GET /             — service info
 *   GET /health       — liveness check
 *   GET /.well-known/x402.json — machine-readable endpoint catalog
 *
 * Paid endpoints (x402-gated):
 *   GET /api/v1/credit-score?wallet=<pubkey>  — Magpie credit score
 *
 * Security posture documented in SECURITY.md.
 */
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { x402Required } from "./middleware/x402.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { creditScoreHandler } from "./routes/credit-score.js";

const PORT = Number(process.env.PORT) || 8402;
const PAY_TO = process.env.MAGPIE_PAY_TO;
if (!PAY_TO) {
  console.warn(
    "[magpie-x402] MAGPIE_PAY_TO not set — paid endpoints will reject requests. " +
    "Set it before serving traffic in production.",
  );
}

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
      free: ["GET /health", "GET /.well-known/x402.json"],
      paid: ["GET /api/v1/credit-score?wallet=<pubkey>"],
    },
    repository: "https://github.com/magpiecapital/magpie-x402",
  }),
);

app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.get("/.well-known/x402.json", (c) =>
  c.json({
    scheme: "x402/solana/v1",
    payTo: PAY_TO ?? null,
    endpoints: [
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
  // 404 when the operator forgets to set MAGPIE_PAY_TO.
  app.get("/api/v1/credit-score", (c) =>
    c.json({ error: "service_not_configured", reason: "MAGPIE_PAY_TO not set" }, 503),
  );
}

// ─── Generic 404 with helpful message ───────────────────────────
app.notFound((c) =>
  c.json(
    {
      error: "not_found",
      try: ["/", "/health", "/.well-known/x402.json"],
    },
    404,
  ),
);

// ─── Centralized error handler (avoid leaking internals) ────────
app.onError((err, c) => {
  console.error("[magpie-x402] unhandled:", err);
  return c.json({ error: "internal_server_error" }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[magpie-x402] listening on http://localhost:${info.port}`);
  console.log(`[magpie-x402] MAGPIE_PAY_TO: ${PAY_TO ?? "(unset — paid endpoints disabled)"}`);
});

export default app;
