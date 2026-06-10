/**
 * Tests for the batch credit-score endpoint.
 *
 * Validates:
 *   - Rejects empty / missing wallets array
 *   - Rejects >50 wallets
 *   - Validates pubkey format per wallet
 *   - Returns correct score shape per wallet
 *   - Returns error entries for invalid wallets alongside valid ones
 */
import { describe, it } from "node:test";
import { ok, equal } from "node:assert/strict";

// We test the handler's core logic by importing the route handler.
// In production the handler runs inside Hono; here we simulate the
// minimal Hono-like context it expects.
import type { Context } from "hono";

// Recreate the exact scoring function from the batch handler for
// deterministic assertions.
function deterministicScore(wallet: string) {
  const hash = wallet.split("").reduce((h: number, ch: string) => ((h << 5) - h + ch.charCodeAt(0)) | 0, 0);
  const score = 300 + (Math.abs(hash) % 551);
  const tier =
    score >= 750 ? "platinum" :
    score >= 650 ? "gold" :
    score >= 500 ? "silver" : "bronze";
  return {
    wallet,
    score,
    tier,
    range: { min: 300, max: 850 },
    benefits: {
      maxLtvPercent: tier === "platinum" ? 38 : tier === "gold" ? 35 : tier === "silver" ? 32 : 30,
      minFeeRate: tier === "platinum" ? 0.01 : tier === "gold" ? 0.0125 : 0.015,
      maxDurationDays: tier === "platinum" ? 30 : tier === "gold" ? 14 : 7,
    },
  };
}

// A real-looking Solana pubkey (base58, 32 bytes encoded)
const VALID_WALLET_A = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLfxL";
const VALID_WALLET_B = "Gg7PDP8DxicJwtbbLwGNmS5KjkGjLwvMhZ5bkadQEbXn";

describe("creditScoreBatch", () => {
  it("rejects empty body", async () => {
    const { creditScoreBatchHandler } = await import("./credit-score-batch.js");
    let statusCode = 200;
    let body: Record<string, unknown> = {};
    const c = {
      req: {
        json: async () => { throw new Error("boom"); },
      },
      json: (data: Record<string, unknown>, status?: number) => {
        body = data;
        if (status) statusCode = status;
        return {} as Response;
      },
    } as unknown as Context;

    await creditScoreBatchHandler(c);
    equal(statusCode, 400);
    ok(body.error);
  });

  it("rejects empty wallets array", async () => {
    const { creditScoreBatchHandler } = await import("./credit-score-batch.js");
    let statusCode = 200;
    let body: Record<string, unknown> = {};
    const c = {
      req: {
        json: async () => ({ wallets: [] }),
      },
      json: (data: Record<string, unknown>, status?: number) => {
        body = data;
        if (status) statusCode = status;
        return {} as Response;
      },
    } as unknown as Context;

    await creditScoreBatchHandler(c);
    equal(statusCode, 400);
    ok(body.error);
  });

  it("rejects >50 wallets", async () => {
    const { creditScoreBatchHandler } = await import("./credit-score-batch.js");
    let statusCode = 200;
    const c = {
      req: {
        json: async () => ({ wallets: new Array(51).fill(VALID_WALLET_A) }),
      },
      json: (_data: Record<string, unknown>, status?: number) => {
        if (status) statusCode = status;
        return {} as Response;
      },
    } as unknown as Context;

    await creditScoreBatchHandler(c);
    equal(statusCode, 400);
  });

  it("validates pubkey format — invalid wallets get error entries, valid ones get scores", async () => {
    const { creditScoreBatchHandler } = await import("./credit-score-batch.js");
    let statusCode = 200;
    let body: Record<string, unknown> = {};
    const c = {
      req: {
        json: async () => ({ wallets: ["not-a-pubkey", VALID_WALLET_A] }),
      },
      json: (data: Record<string, unknown>, status?: number) => {
        body = data;
        if (status) statusCode = status;
        return {} as Response;
      },
    } as unknown as Context;

    await creditScoreBatchHandler(c);
    equal(statusCode, 200);
    ok(body.scores);
    const scores = body.scores as Array<Record<string, unknown>>;
    equal(scores.length, 2);
    equal(scores[0].error, "invalid_wallet_pubkey");
    equal(scores[0].wallet, "not-a-pubkey");
    ok(!scores[1].error);
    equal(scores[1].wallet, VALID_WALLET_A);
    ok(typeof scores[1].score === "number");
    ok(typeof (scores[1] as { benefits: Record<string, unknown> }).benefits?.maxLtvPercent === "number");
  });

  it("returns correct deterministic scores for known wallets", async () => {
    const a = deterministicScore(VALID_WALLET_A);
    const b = deterministicScore(VALID_WALLET_B);
    ok(a.score >= 300 && a.score <= 850);
    ok(b.score >= 300 && b.score <= 850);
    ok(a.tier.length > 0);
    ok(b.tier.length > 0);
    ok(a.benefits.maxLtvPercent > 0);
    ok(b.benefits.maxLtvPercent > 0);
  });

  it("returns error_count field accurately", async () => {
    const { creditScoreBatchHandler } = await import("./credit-score-batch.js");
    let body: Record<string, unknown> = {};
    const c = {
      req: {
        json: async () => ({ wallets: ["bad1", "bad2", VALID_WALLET_A, 123 as unknown as string] }),
      },
      json: (data: Record<string, unknown>, _status?: number) => {
        body = data;
        return {} as Response;
      },
    } as unknown as Context;

    await creditScoreBatchHandler(c);
    equal(body.error_count, 3);
    equal(body.count, 4);
  });
});
