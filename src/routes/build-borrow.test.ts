import { test } from "node:test";
import assert from "node:assert";
import { adaptBorrowSummary } from "./build-borrow.js";

/**
 * CONTRACT test for the build-borrow SUMMARY field-shape adapter.
 *
 * The bot returns the borrow summary in snake_case + SOL
 * (`loan_id`, `principal_sol`, `fee_sol`); the SDK reads camelCase + lamports
 * (`loanId`, `borrowableLamports`, `feeLamports`). A mismatch across this exact
 * boundary once threw `Cannot convert undefined to a BigInt` in the SDK AFTER
 * a loan had already opened on-chain. These assertions pin the adapter so that
 * drift fails CI instead of production.
 */

test("adaptBorrowSummary: snake_case + SOL bot shape -> camelCase + lamports aliases", () => {
  const out = adaptBorrowSummary({
    loan_id: "116806956026849291",
    principal_sol: 0.3189,
    fee_sol: 0.009,
    program_id: "PROG",
    loan_pda: "PDA",
  });

  // camelCase aliases the SDK depends on
  assert.equal(out.loanId, "116806956026849291");
  assert.equal(out.borrowableLamports, String(Math.round(0.3189 * 1e9)));
  assert.equal(out.feeLamports, String(Math.round(0.009 * 1e9)));

  // pass-through fields untouched
  assert.equal(out.program_id, "PROG");
  assert.equal(out.loan_pda, "PDA");

  // original snake_case keys are kept for direct/curl consumers
  assert.equal(out.loan_id, "116806956026849291");
  assert.equal(out.principal_sol, 0.3189);
  assert.equal(out.fee_sol, 0.009);
});

test("adaptBorrowSummary: already-camelCase input is preserved (?? keeps existing value)", () => {
  const out = adaptBorrowSummary({
    loanId: "999",
    borrowableLamports: "123456789",
    feeLamports: "42",
    // snake_case also present but must NOT override the camelCase values
    loan_id: "111",
    principal_sol: 5,
    fee_sol: 1,
  });

  assert.equal(out.loanId, "999");
  assert.equal(out.borrowableLamports, "123456789");
  assert.equal(out.feeLamports, "42");
});

test("adaptBorrowSummary: null/missing SOL amounts -> undefined, NO throw (the exact crash class)", () => {
  let out: Record<string, unknown> | undefined;
  assert.doesNotThrow(() => {
    out = adaptBorrowSummary({ loan_id: "5" });
  });

  assert.equal(out!.loanId, "5");
  assert.equal(out!.borrowableLamports, undefined);
  assert.equal(out!.feeLamports, undefined);
});
