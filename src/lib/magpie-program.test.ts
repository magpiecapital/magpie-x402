import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  LOAN_DISCRIMINATOR,
  LOAN_SIZE,
  LENDING_PROGRAM_V1,
  LENDING_PROGRAM_V3,
  LENDING_PROGRAM_V4,
  decodeLoanForVersion,
  decodeLoanGuarded,
  versionForLoanSize,
  versionForProgramId,
  programIdForVersion,
  loanPda,
  loanStatusName,
  type ProgramVersion,
} from "./magpie-program.js";

// Fixed, well-known public keys — never operator wallets. Used only as
// sentinel field values so a wrong byte offset surfaces as a wrong pubkey.
const BORROWER = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL mint
const POOL = new PublicKey("11111111111111111111111111111111"); // system program
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mint
const VAULT = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"); // token program

interface LoanFields {
  loanId: bigint;
  collateralAmount: bigint;
  loanAmount: bigint;
  repayAmount: bigint;
  transactionFee: bigint;
  ltvBps: number;
  durationDays: number;
  startTimestamp: bigint;
  dueTimestamp: bigint;
  status: number;
  collateralValueAtStart: bigint;
  bump: number;
  vaultBump: number;
  category?: number; // v3/v4
  currentCollateralAmount?: bigint; // v4
  solProceeds?: bigint; // v4
  autoSellsFired?: number; // v4
}

/** Build a byte-accurate Loan account buffer for a version. */
function buildLoan(version: ProgramVersion, f: LoanFields): Buffer {
  const d = Buffer.alloc(LOAN_SIZE[version]);
  LOAN_DISCRIMINATOR.copy(d, 0);
  d.writeBigUInt64LE(f.loanId, 8);
  BORROWER.toBuffer().copy(d, 16);
  POOL.toBuffer().copy(d, 48);
  MINT.toBuffer().copy(d, 80);
  VAULT.toBuffer().copy(d, 112);
  d.writeBigUInt64LE(f.collateralAmount, 144);
  d.writeBigUInt64LE(f.loanAmount, 152);
  d.writeBigUInt64LE(f.repayAmount, 160);
  d.writeBigUInt64LE(f.transactionFee, 168);
  d.writeUInt16LE(f.ltvBps, 176);
  d.writeUInt8(f.durationDays, 178);
  d.writeBigInt64LE(f.startTimestamp, 179);
  d.writeBigInt64LE(f.dueTimestamp, 187);
  d.writeUInt8(f.status, 195);
  d.writeBigUInt64LE(f.collateralValueAtStart, 196);
  d.writeUInt8(f.bump, 204);
  d.writeUInt8(f.vaultBump, 205);
  if (version === "v3" || version === "v4") d.writeUInt8(f.category ?? 0, 206);
  if (version === "v4") {
    d.writeBigUInt64LE(f.currentCollateralAmount ?? 0n, 207);
    d.writeBigUInt64LE(f.solProceeds ?? 0n, 215);
    d.writeUInt8(f.autoSellsFired ?? 0, 223);
  }
  return d;
}

const SAMPLE: LoanFields = {
  loanId: 42n,
  collateralAmount: 1_000_000n,
  loanAmount: 500_000_000n,
  repayAmount: 515_000_000n,
  transactionFee: 15_000_000n,
  ltvBps: 3000,
  durationDays: 7,
  startTimestamp: 1_700_000_000n,
  dueTimestamp: 1_700_604_800n,
  status: 0, // active
  collateralValueAtStart: 1_650_000_000n,
  bump: 254,
  vaultBump: 253,
};

// Any valid pubkey — only used as the (unasserted) loanPda field value.
const DUMMY_PDA = new PublicKey("SysvarC1ock11111111111111111111111111111111");

describe("version <-> program id mapping", () => {
  it("round-trips every version", () => {
    for (const v of ["v1", "v3", "v4"] as ProgramVersion[]) {
      assert.equal(versionForProgramId(programIdForVersion(v)), v);
    }
  });
  it("maps each exact loan size to exactly one version", () => {
    assert.equal(versionForLoanSize(206), "v1");
    assert.equal(versionForLoanSize(207), "v3");
    assert.equal(versionForLoanSize(224), "v4");
    assert.equal(versionForLoanSize(123), null); // the old wrong size matches nothing
    assert.equal(versionForLoanSize(625), null); // the shared non-loan account
  });
  it("returns null for an unknown program id", () => {
    assert.equal(versionForProgramId(new PublicKey("11111111111111111111111111111111")), null);
  });
});

describe("decodeLoanForVersion — offset correctness", () => {
  it("decodes every common field at the right offset (V1)", () => {
    const loan = decodeLoanForVersion(DUMMY_PDA, buildLoan("v1", SAMPLE), "v1");
    assert.equal(loan.programVersion, "v1");
    assert.equal(loan.loanId, "42");
    assert.equal(loan.borrower, BORROWER.toBase58());
    assert.equal(loan.pool, POOL.toBase58());
    assert.equal(loan.collateralMint, MINT.toBase58());
    assert.equal(loan.collateralVault, VAULT.toBase58());
    assert.equal(loan.collateralAmount, "1000000");
    assert.equal(loan.loanAmountLamports, "500000000");
    assert.equal(loan.repayAmountLamports, "515000000");
    assert.equal(loan.transactionFeeLamports, "15000000");
    assert.equal(loan.ltvBps, 3000);
    assert.equal(loan.durationDays, 7);
    assert.equal(loan.startTimestampUnix, 1_700_000_000);
    assert.equal(loan.dueTimestampUnix, 1_700_604_800);
    assert.equal(loan.status, "active");
    assert.equal(loan.collateralValueAtStart, "1650000000");
    // V1 has no category and no v4 block
    assert.equal(loan.category, undefined);
    assert.equal(loan.v4, undefined);
    assert.equal(loan.exitsSupported, false);
  });

  it("decodes category on V3 (RWA)", () => {
    const loan = decodeLoanForVersion(DUMMY_PDA, buildLoan("v3", { ...SAMPLE, category: 1 }), "v3");
    assert.equal(loan.programVersion, "v3");
    assert.equal(loan.category, "rwa");
    assert.equal(loan.v4, undefined);
    assert.equal(loan.exitsSupported, false);
  });

  it("decodes V4 in-vault exit state + flags exitsSupported", () => {
    const loan = decodeLoanForVersion(
      DUMMY_PDA,
      buildLoan("v4", {
        ...SAMPLE,
        category: 0,
        currentCollateralAmount: 400_000n,
        solProceeds: 123_456_789n,
        autoSellsFired: 3,
      }),
      "v4",
    );
    assert.equal(loan.programVersion, "v4");
    assert.equal(loan.category, "memecoin");
    assert.equal(loan.exitsSupported, true);
    assert.ok(loan.v4);
    assert.equal(loan.v4!.currentCollateralAmount, "400000");
    assert.equal(loan.v4!.solProceedsLamports, "123456789");
    assert.equal(loan.v4!.autoSellsFired, 3);
  });

  it("rejects a wrong-size buffer for the named version", () => {
    assert.throws(() => decodeLoanForVersion(DUMMY_PDA, buildLoan("v4", SAMPLE), "v1"));
  });
  it("rejects a buffer with a bad discriminator", () => {
    const bad = buildLoan("v1", SAMPLE);
    bad.writeUInt8(0xff, 0);
    assert.throws(() => decodeLoanForVersion(DUMMY_PDA, bad, "v1"));
  });
});

describe("decodeLoanGuarded — POOL SEPARATION (the core safety property)", () => {
  it("decodes a V1-owned, V1-sized account as v1", () => {
    const loan = decodeLoanGuarded(DUMMY_PDA, LENDING_PROGRAM_V1, buildLoan("v1", SAMPLE));
    assert.ok(loan);
    assert.equal(loan!.programVersion, "v1");
  });

  it("REFUSES to decode a V1-sized account owned by the V4 program (no cross-version mis-decode)", () => {
    // 206-byte body, but owner says V4 (whose Loan is 224B). Must be rejected,
    // never silently decoded as a V4 (or V1) loan.
    const v1bytes = buildLoan("v1", SAMPLE);
    assert.equal(decodeLoanGuarded(DUMMY_PDA, LENDING_PROGRAM_V4, v1bytes), null);
  });

  it("REFUSES to decode a V4-sized account owned by the V1 program", () => {
    const v4bytes = buildLoan("v4", { ...SAMPLE, category: 0 });
    assert.equal(decodeLoanGuarded(DUMMY_PDA, LENDING_PROGRAM_V1, v4bytes), null);
  });

  it("REFUSES an account owned by an unknown program", () => {
    const unknown = new PublicKey("11111111111111111111111111111111");
    assert.equal(decodeLoanGuarded(DUMMY_PDA, unknown, buildLoan("v1", SAMPLE)), null);
  });

  it("REFUSES a correctly-sized account with a non-Loan discriminator", () => {
    const bad = buildLoan("v3", { ...SAMPLE, category: 1 });
    bad.writeUInt8(0x00, 0); // corrupt discriminator
    assert.equal(decodeLoanGuarded(DUMMY_PDA, LENDING_PROGRAM_V3, bad), null);
  });

  it("routes a V3-owned 207B account to v3 and reads its category", () => {
    const loan = decodeLoanGuarded(DUMMY_PDA, LENDING_PROGRAM_V3, buildLoan("v3", { ...SAMPLE, category: 1 }));
    assert.ok(loan);
    assert.equal(loan!.programVersion, "v3");
    assert.equal(loan!.category, "rwa");
  });
});

describe("loanPda — borrower is part of the seed set", () => {
  it("derives deterministically and depends on the borrower", () => {
    const a = loanPda(BORROWER, 42n, LENDING_PROGRAM_V1);
    const a2 = loanPda(BORROWER, 42n, LENDING_PROGRAM_V1);
    assert.equal(a.toBase58(), a2.toBase58()); // deterministic
    const b = loanPda(MINT, 42n, LENDING_PROGRAM_V1); // different borrower
    assert.notEqual(a.toBase58(), b.toBase58());
    const c = loanPda(BORROWER, 43n, LENDING_PROGRAM_V1); // different id
    assert.notEqual(a.toBase58(), c.toBase58());
    const d = loanPda(BORROWER, 42n, LENDING_PROGRAM_V4); // different program
    assert.notEqual(a.toBase58(), d.toBase58());
  });
});

describe("loanStatusName", () => {
  it("maps the Anchor LoanStatus enum", () => {
    assert.equal(loanStatusName(0), "active");
    assert.equal(loanStatusName(1), "repaid");
    assert.equal(loanStatusName(2), "liquidated");
    assert.equal(loanStatusName(9), "unknown");
  });
});
