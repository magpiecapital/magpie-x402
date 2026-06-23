import type { Context } from "hono";
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { enforcePayerMatchesWallet } from "../lib/payer-bind.js";

/**
 * POST /api/v1/agent/build-repay
 *
 * Build an unsigned repay tx. Agent signs + submits via standard
 * Solana RPC (no cosign needed — repay_loan doesn't require lender
 * authority).
 *
 * Body: { borrower_wallet, loan_pda }
 *
 * Same authenticated-proxy pattern as build-borrow: x402 verifies
 * payment, forwards to bot with INTERNAL_API_TOKEN. Bot verifies
 * on-chain borrower match, refuses suspended loans, builds tx.
 *
 * PRE-SIM (FIX 2): before handing the unsigned tx back, we run a
 * read-only `simulateTransaction` against an RPC so an agent never signs
 * a doomed repay (e.g. the `incorrect program id for instruction` class
 * that recurs when a repay is built for the wrong program version). The
 * sim runs with sigVerify=false (the tx is unsigned — the borrower hasn't
 * signed yet) and replaceRecentBlockhash=true (so a slightly-stale builder
 * blockhash surfaces a REAL program revert, not a spurious blockhash
 * error). On revert we return 422 with the decoded reason. The simulation
 * is non-custodial: it signs nothing, mutates nothing, and the tx returned
 * to the agent is byte-for-byte the builder's output. If the RPC sim itself
 * is unavailable (infra), we FAIL OPEN and return the tx unsimulated with a
 * `presim` advisory — a transient RPC blip must never block a borrower's
 * repay (the agent's own submit still simulates on the validator).
 */

const BOT_API = process.env.MAGPIE_BOT_API || "https://magpie-bot-production.up.railway.app";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

type PresimResult =
  | { ok: true; presim: "passed" | "skipped"; detail?: string }
  | { ok: false; reason: string; logs?: string[] };

/**
 * Best-effort read-only pre-simulation of an UNSIGNED repay tx.
 *
 * - Returns { ok:true, presim:"passed" } when the program executes cleanly.
 * - Returns { ok:false, reason } on a program revert (caller -> 422).
 * - Returns { ok:true, presim:"skipped" } when we can't simulate (e.g. the
 *   builder returned a versioned tx with address-lookup tables we can't
 *   resolve, or the RPC sim is down). Fail-open: the agent's own submit
 *   simulates on the validator regardless.
 */
async function presimulateRepay(txB64: string): Promise<PresimResult> {
  let vtx: VersionedTransaction;
  try {
    // The repay builder emits a legacy Transaction (same shape every other
    // Magpie builder returns; the SDK deserializes it with Transaction.from).
    // Recompile its message into a VersionedTransaction so we can simulate via
    // the non-deprecated overload with sigVerify=false (the tx is unsigned).
    const legacy = Transaction.from(Buffer.from(txB64, "base64"));
    vtx = new VersionedTransaction(legacy.compileMessage());
  } catch {
    // Not a legacy tx we can recompile (or undecodable). Don't guess —
    // skip the pre-sim rather than reject a valid tx we simply can't model.
    return { ok: true, presim: "skipped", detail: "tx_not_simulatable" };
  }

  let sim;
  try {
    sim = await conn().simulateTransaction(vtx, {
      sigVerify: false, // unsigned — borrower signs after this returns
      replaceRecentBlockhash: true, // avoid spurious stale-blockhash failures
      commitment: "processed",
    });
  } catch {
    // RPC sim unavailable — FAIL OPEN. A transient infra blip must never block
    // a real repay; the validator will simulate on the agent's submit anyway.
    return { ok: true, presim: "skipped", detail: "rpc_simulate_unavailable" };
  }

  if (sim.value.err) {
    return {
      ok: false,
      reason: decodeSimError(sim.value.err, sim.value.logs ?? null),
      logs: (sim.value.logs ?? []).slice(-12),
    };
  }
  return { ok: true, presim: "passed" };
}

/**
 * Turn a simulation error + logs into a short, agent-actionable reason.
 * Surfaces the Anchor custom error code and the most relevant program log
 * line without leaking the entire log stream.
 */
function decodeSimError(err: unknown, logs: string[] | null): string {
  // Anchor custom errors arrive as { InstructionError: [i, { Custom: code }] }.
  if (err && typeof err === "object") {
    const ie = (err as { InstructionError?: [number, unknown] }).InstructionError;
    if (Array.isArray(ie)) {
      const [ixIndex, detail] = ie;
      if (detail && typeof detail === "object" && "Custom" in (detail as object)) {
        const code = (detail as { Custom: number }).Custom;
        return `repay_would_revert: instruction ${ixIndex} failed with custom program error 0x${code.toString(16)} (${code})`;
      }
      if (typeof detail === "string") {
        return `repay_would_revert: instruction ${ixIndex} failed: ${detail}`;
      }
      return `repay_would_revert: instruction ${ixIndex} failed`;
    }
  }
  // Fall back to the last meaningful program log line (e.g. an explicit
  // "incorrect program id for instruction" or an Anchor require! message).
  const lastErrLog = (logs ?? [])
    .filter((l) => /error|failed|insufficient|incorrect|panicked|require/i.test(l))
    .pop();
  if (lastErrLog) return `repay_would_revert: ${lastErrLog.slice(0, 180)}`;
  return "repay_would_revert: simulation failed";
}

export async function buildRepayHandler(c: Context) {
  if (!INTERNAL_TOKEN) {
    return c.json({ error: "agent_api_not_configured", detail: "INTERNAL_API_TOKEN not set on x402 service" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const borrower = String(b.borrower_wallet ?? "");
  const loanPda = String(b.loan_pda ?? "");
  if (!borrower || !loanPda) {
    return c.json(
      { error: "missing_or_invalid_params", required: { borrower_wallet: "pubkey", loan_pda: "pubkey" } },
      400,
    );
  }
  try {
    new PublicKey(borrower);
    new PublicKey(loanPda);
  } catch {
    return c.json({ error: "invalid_pubkey" }, 400);
  }

  // Security gate: x402 payer must equal borrower_wallet. Same rationale
  // as build-borrow — gate per-wallet operations to wallet ownership.
  const mismatch = enforcePayerMatchesWallet(c, borrower);
  if (mismatch) return mismatch;

  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/agent/build-repay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Internal-Token": INTERNAL_TOKEN },
      body: JSON.stringify({ borrower_wallet: borrower, loan_pda: loanPda }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return c.json({ error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) }, 502);
  }
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { error: "bot_returned_non_json", status: res.status };
  }

  // Pre-sim gate: only when the bot returned a built tx. On any bot error
  // (non-2xx) pass it straight through unchanged.
  const txB64 =
    res.ok && typeof parsed.partial_signed_tx_b64 === "string"
      ? (parsed.partial_signed_tx_b64 as string)
      : null;
  if (txB64) {
    const sim = await presimulateRepay(txB64);
    if (!sim.ok) {
      // Revert detected BEFORE the agent signs — refuse the build so a doomed
      // repay is never signed. 422 = the request was well-formed but the tx
      // wouldn't land.
      return c.json(
        {
          error: "repay_simulation_failed",
          reason: sim.reason,
          logs: sim.logs,
          loan_pda: loanPda,
          detail:
            "The repay transaction was built but reverts in simulation; it would fail on-chain. Not returned for signing.",
        },
        422,
      );
    }
    // Passed (or skipped on infra fail-open) — annotate so the agent can see
    // the tx was pre-validated, without altering the tx bytes.
    parsed = { ...parsed, presim: sim.presim, ...(sim.detail ? { presim_detail: sim.detail } : {}) };
  }

  return c.json(parsed, res.status as never);
}
