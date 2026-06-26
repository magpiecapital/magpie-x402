/**
 * submit.ts — robust send + confirm for Magpie-built transactions.
 *
 * Why this exists: the 0.2.0 signAndSubmit sent the signed tx exactly once and
 * confirmed with the deprecated signature-only confirmTransaction. A single
 * dropped tx, an RPC blip, or a "node is behind" hiccup therefore failed the
 * whole borrow/repay/deposit/withdraw call — directly against Magpie's
 * >=99.9% borrow / >=99.95% repay reliability bar.
 *
 * This re-broadcasts the SAME signed bytes — an identical signature, so any
 * cluster node that already saw it dedupes and NO second on-chain transaction
 * is ever produced — and polls getSignatureStatuses until the tx confirms or a
 * bounded budget (roughly a blockhash's lifetime) elapses. On timeout it throws
 * a RETRYABLE X402Error so the caller can rebuild a fresh tx and resubmit; an
 * on-chain failure throws a NON-retryable one.
 */
import type { Connection } from "@solana/web3.js";
import { X402Error } from "./x402.js";

// Transient send/RPC conditions worth re-broadcasting (same classes the example
// agent's guardian treats as retryable). Anything else is surfaced immediately.
const TRANSIENT =
  /timeout|timed out|fetch failed|network|ECONN|socket hang up|429|too many requests|503|502|node is behind|blockhash not found|rate.?limit|getaddrinfo|ENOTFOUND|ETIMEDOUT/i;

/** True when an error is a transient send/RPC failure worth re-broadcasting. */
export function isTransientSubmitError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? "");
  return TRANSIENT.test(m);
}

export interface SubmitOptions {
  /** Max distinct re-broadcasts of the signed bytes. Default 8. */
  maxRebroadcasts?: number;
  /** Overall confirm budget in ms (~ a blockhash's life). Default 90_000. */
  confirmTimeoutMs?: number;
  /** Status poll cadence in ms. Default 2_500. */
  pollIntervalMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Broadcast + confirm pre-signed raw tx bytes with dedupe-safe re-broadcast and
 * a bounded, structured confirmation poll. Returns the signature on success.
 */
export async function sendAndConfirmRaw(
  connection: Connection,
  rawTx: Uint8Array | Buffer,
  opts: SubmitOptions = {},
): Promise<string> {
  const maxRebroadcasts = opts.maxRebroadcasts ?? 8;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const deadline = Date.now() + confirmTimeoutMs;

  let sig: string | undefined;
  let broadcasts = 0;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    if (broadcasts < maxRebroadcasts) {
      try {
        // Re-broadcast IDENTICAL signed bytes → same signature → cluster dedupes.
        // Preflight the first send (catch a bad tx early); skip on resends (the
        // tx already passed once, and preflight can spuriously fail a resend).
        // Disable the RPC's own retry — re-broadcast is owned here.
        sig = await connection.sendRawTransaction(rawTx, {
          skipPreflight: broadcasts > 0,
          maxRetries: 0,
        });
        broadcasts++;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/already processed|already been processed|AlreadyProcessed/i.test(m)) {
          // The tx already landed — drop through to status polling.
        } else if (isTransientSubmitError(e)) {
          lastErr = e; // transient — wait and re-broadcast
        } else {
          throw e instanceof X402Error
            ? e
            : new X402Error(`submit failed: ${m}`, 0, e, { code: "submit_failed", retryable: false });
        }
      }
    }

    if (sig) {
      try {
        const { value } = await connection.getSignatureStatuses([sig], {
          // CRITICAL — look past the validator's in-memory recent-status cache
          // (~150-300 slots). A tx that confirmed on-chain but aged out of that
          // cache, or returns null from a rotated/load-balanced RPC node (how
          // Helius / public mainnet behave), must NOT be misread as "never
          // landed" → retryable timeout → a rebuild that double-submits /
          // double-charges a repay. This makes an aged-out-but-successful tx
          // observable, separating "dropped (safe to retry)" from "succeeded
          // but evicted (NOT safe)".
          searchTransactionHistory: true,
        });
        const st = value[0];
        if (st?.err) {
          throw new X402Error(
            `transaction ${sig} failed on-chain: ${JSON.stringify(st.err)}`,
            0,
            st.err,
            { code: "tx_failed", retryable: false },
          );
        }
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
          return sig;
        }
      } catch (e) {
        // Preserve a real on-chain failure; absorb transient RPC blips during
        // polling (the same classes the send path tolerates) so a single hiccup
        // can't abort confirmation of a possibly-landed tx; surface anything
        // genuinely non-transient.
        if (e instanceof X402Error) throw e;
        if (!isTransientSubmitError(e)) throw e;
        lastErr = e;
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new X402Error(
    `transaction not confirmed within ${confirmTimeoutMs}ms${sig ? ` (sig ${sig})` : ""}` +
      ` — blockhash likely expired; safe to rebuild a fresh tx and resubmit.`,
    0,
    lastErr ?? null,
    { code: "confirm_timeout", retryable: true },
  );
}
