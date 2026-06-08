import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TIERS, tierFromName, quoteBorrow } from "./tiers.js";

describe("tiers", () => {
  it("exposes exactly 3 canonical tiers", () => {
    const names = Object.keys(TIERS).sort();
    assert.deepEqual(names, ["express", "quick", "standard"]);
  });

  it("tier definitions match the protocol constants", () => {
    assert.equal(TIERS.express.ltvPercent, 30);
    assert.equal(TIERS.express.durationDays, 2);
    assert.equal(TIERS.express.feePercent, 3.0);

    assert.equal(TIERS.quick.ltvPercent, 25);
    assert.equal(TIERS.quick.durationDays, 3);
    assert.equal(TIERS.quick.feePercent, 2.0);

    assert.equal(TIERS.standard.ltvPercent, 20);
    assert.equal(TIERS.standard.durationDays, 7);
    assert.equal(TIERS.standard.feePercent, 1.5);
  });

  it("tierFromName is case-insensitive", () => {
    assert.equal(tierFromName("EXPRESS")?.name, "express");
    assert.equal(tierFromName("Quick")?.name, "quick");
    assert.equal(tierFromName("standard")?.name, "standard");
    assert.equal(tierFromName("unknown"), null);
  });
});

describe("quoteBorrow", () => {
  const baseOpts = {
    mint: "9UuLsJ3jf8ViBNeRcwXD53re5G3ypgfKK3s2EiMMpump",
    amount: 1_000_000_000n, // 1000 tokens at 6 decimals
    decimals: 6,
    pricePerTokenUsd: 0.01,
    solPriceUsd: 200,
  };

  it("computes Express quote correctly", () => {
    const q = quoteBorrow({ ...baseOpts, tier: TIERS.express });
    // collateral_usd = 1000 * 0.01 = $10
    assert.equal(q.collateral.totalValueUsd, 10);
    // loan_usd = $10 * 30% = $3
    // fee_usd = $3 * 3% = $0.09
    // net_usd = $3 - $0.09 = $2.91
    // at $200/SOL: gross = 0.015 SOL = 15_000_000 lamports
    //              fee   = 0.00045 SOL = 450_000 lamports
    //              net   = 0.01455 SOL
    assert.ok(Math.abs(q.loan.grossSol - 0.015) < 1e-6);
    assert.ok(Math.abs(q.loan.feeSol - 0.00045) < 1e-6);
    assert.ok(Math.abs(q.loan.netSol - 0.01455) < 1e-5);
    assert.equal(q.terms.ltvPercent, 30);
    assert.equal(q.terms.durationDays, 2);
  });

  it("computes Quick quote correctly", () => {
    const q = quoteBorrow({ ...baseOpts, tier: TIERS.quick });
    // collateral_usd = $10, loan = $2.50, fee = $0.05, net = $2.45
    assert.equal(q.collateral.totalValueUsd, 10);
    assert.ok(Math.abs(q.loan.grossSol - 0.0125) < 1e-6);
    assert.ok(Math.abs(q.loan.feeSol - 0.00025) < 1e-6);
  });

  it("computes Standard quote correctly", () => {
    const q = quoteBorrow({ ...baseOpts, tier: TIERS.standard });
    // $10 -> $2 -> fee $0.03 -> net $1.97
    assert.equal(q.collateral.totalValueUsd, 10);
    assert.ok(Math.abs(q.loan.grossSol - 0.01) < 1e-6);
    assert.ok(Math.abs(q.loan.feeSol - 0.00015) < 1e-6);
  });

  it("rejects invalid inputs", () => {
    assert.throws(() =>
      quoteBorrow({ ...baseOpts, tier: TIERS.express, pricePerTokenUsd: 0 }),
    );
    assert.throws(() =>
      quoteBorrow({ ...baseOpts, tier: TIERS.express, solPriceUsd: -1 }),
    );
    assert.throws(() =>
      quoteBorrow({ ...baseOpts, tier: TIERS.express, amount: 0n }),
    );
    assert.throws(() =>
      quoteBorrow({ ...baseOpts, tier: TIERS.express, decimals: 99 }),
    );
  });

  it("dueAt is durationDays after now", () => {
    const before = Math.floor(Date.now() / 1000);
    const q = quoteBorrow({ ...baseOpts, tier: TIERS.standard });
    const expectedMin = before + 7 * 86400;
    const expectedMax = Math.floor(Date.now() / 1000) + 7 * 86400 + 1;
    assert.ok(q.terms.dueAtUnix >= expectedMin && q.terms.dueAtUnix <= expectedMax);
  });

  it("owed equals gross (borrower repays the full loan, not the net)", () => {
    const q = quoteBorrow({ ...baseOpts, tier: TIERS.express });
    assert.equal(q.loan.owedLamports, q.loan.grossLamports);
  });
});
