import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import {
  fetchLoanByPda,
  findLoansByBorrowerAndId,
  type DecodedLoan,
} from "../lib/magpie-program.js";

/**
 * Single-loan reads, multi-version + pool-separation-safe.
 *
 * Two forms:
 *   GET /api/v1/loan/by-pda/:loanPda            — unambiguous (one PDA = one loan)
 *   GET /api/v1/loan/:loanId?borrower=<pubkey>  — derives the PDA across versions
 *
 * Why borrower is required for the by-id form: the on-chain Loan PDA seeds are
 * ["loan", borrower, loan_id], so a loan_id alone cannot locate a loan. And
 * because each program (V1/V3/V4) has its OWN loan_id sequence, the same
 * borrower can hold the same numeric loan_id in more than one program — so the
 * by-id form returns a LIST. Use by-pda when you need exactly one loan.
 *
 * Each loan is decoded by the version derived from its on-chain owner, so a
 * loan from one strategy is never returned shaped as another. The response
 * tags every loan with program_version, category, V4 in-vault exit state, and
 * exits_supported (true only for V4 — the sole version that accepts exits).
 */

const LOAN_TTL_MS = 10_000;
const pdaCache = new Map<string, { loan: DecodedLoan; expiresAt: number }>();

/** Add the agent-facing exit-eligibility hint (W9) to a decoded loan. */
function withExitInfo(loan: DecodedLoan) {
  return {
    ...loan,
    exits_supported: loan.exitsSupported,
    // Why an exit-order arm would be rejected, if this loan can't take one.
    exit_ineligibility_reason: loan.exitsSupported ? null : "loan_not_v4",
  };
}

/** GET /api/v1/loan/by-pda/:loanPda */
export async function loanByPdaHandler(c: Context) {
  const pdaParam = c.req.param("loanPda");
  let pda: PublicKey;
  try {
    pda = new PublicKey(pdaParam ?? "");
  } catch {
    return c.json({ error: "invalid_loan_pda" }, 400);
  }
  const key = pda.toBase58();

  const cached = pdaCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(withExitInfo(cached.loan), 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20",
      "X-Cache": "HIT",
    });
  }

  try {
    const loan = await fetchLoanByPda(pda);
    if (!loan) return c.json({ error: "loan_not_found", loanPda: key }, 404);
    pdaCache.set(key, { loan, expiresAt: Date.now() + LOAN_TTL_MS });
    return c.json(withExitInfo(loan), 200, {
      "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=20",
      "X-Cache": "MISS",
    });
  } catch (err) {
    console.warn("[loan/by-pda] error:", (err as Error).message);
    return c.json({ error: "loan_fetch_failed" }, 502);
  }
}

/** GET /api/v1/loan/:loanId?borrower=<pubkey> */
export async function loanHandler(c: Context) {
  const loanIdParam = c.req.param("loanId");
  if (!loanIdParam || !/^\d{1,20}$/.test(loanIdParam)) {
    return c.json({ error: "invalid_loan_id", detail: "u64 decimal string" }, 400);
  }
  const borrowerParam = c.req.query("borrower");
  if (!borrowerParam) {
    return c.json(
      {
        error: "borrower_required",
        detail:
          "Loan PDAs are seeded by borrower; pass ?borrower=<pubkey>, or use GET /api/v1/loan/by-pda/:loanPda for an unambiguous single-loan read.",
      },
      400,
    );
  }
  let borrower: PublicKey;
  try {
    borrower = new PublicKey(borrowerParam);
  } catch {
    return c.json({ error: "invalid_borrower_pubkey" }, 400);
  }
  let loanId: bigint;
  try {
    loanId = BigInt(loanIdParam);
  } catch {
    return c.json({ error: "invalid_loan_id" }, 400);
  }

  try {
    const { loans, partial } = await findLoansByBorrowerAndId(borrower, loanId);
    if (loans.length === 0 && Object.keys(partial).length === 0) {
      return c.json({ error: "loan_not_found", loanId: loanIdParam, borrower: borrower.toBase58() }, 404);
    }
    return c.json(
      {
        loanId: loanIdParam,
        borrower: borrower.toBase58(),
        count: loans.length,
        partial,
        loans: loans.map(withExitInfo),
      },
      200,
      {
        "Cache-Control":
          Object.keys(partial).length === 0
            ? "public, max-age=10, s-maxage=10, stale-while-revalidate=20"
            : "no-store",
      },
    );
  } catch (err) {
    console.warn("[loan] error:", (err as Error).message);
    return c.json({ error: "loan_fetch_failed" }, 502);
  }
}
