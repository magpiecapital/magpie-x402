/**
 * submit.ts — RPC-failover send + confirm for the agent's safety-critical
 * broadcasts (the repay leg above all).
 *
 * Magpie liquidates on TIME, so the repay broadcast is the single most
 * safety-critical RPC in the agent. The old path used ONE Connection and a bare
 * confirmTransaction(sig) — a single-provider blip during the repay window could
 * stall the broadcast or the confirm, and the bare confirm throws
 * TransactionExpiredBlockheightExceeded on a slow-but-landed tx, making the
 * guardian re-pay the 0.002-SOL build-repay fee on a repay that actually
 * succeeded.
 *
 * This mirrors the SDK's adversarially-verified sendAndConfirmRaw (dedupe-safe
 * re-broadcast + bounded poll with searchTransactionHistory) and adds
 * MULTI-PROVIDER failover:
 *   - Re-broadcasting BYTE-IDENTICAL signed bytes yields an identical signature,
 *     so any node — on any provider — that already saw it DEDUPES. Broadcasting
 *     across providers can never produce a second on-chain tx.
 *   - getSignatureStatuses({searchTransactionHistory:true}) makes a confirmed-
 *     but-cache-evicted tx observable, so a slow-but-landed repay returns success
 *     instead of being misclassified as a retryable timeout (no fee re-pay).
 */
import { Connection } from "@solana/web3.js";

const TRANSIENT =
  /timeout|timed out|fetch failed|network|ECONN|socket hang up|429|too many requests|503|502|node is behind|blockhash not found|rate.?limit|getaddrinfo|ENOTFOUND|ETIMEDOUT/i;

function isTransient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err ?? "");
  return TRANSIENT.test(m);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SubmitError extends Error {
  code?: string;
  retryable?: boolean;
}
function mkErr(message: string, code: string, retryable: boolean): SubmitError {
  const e = new Error(message) as SubmitError;
  e.code = code;
  e.retryable = retryable;
  return e;
}

/**
 * Build [primary, ...fallbacks] from the primary URL + SOLANA_RPC_FALLBACKS
 * (comma-separated). Deduped, primary first. With no fallbacks set this is just
 * [primary] — behaviour is identical to before, so it's safe to adopt everywhere.
 */
export function rpcConnections(primaryUrl: string): Connection[] {
  const extra = (process.env.SOLANA_RPC_FALLBACKS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const urls = [primaryUrl, ...extra].filter((u) => u && !seen.has(u) && (seen.add(u), true));
  return urls.map((u) => new Connection(u, "confirmed"));
}

/**
 * Broadcast + confirm pre-signed raw tx bytes across providers. Returns the
 * signature on success. Throws a SubmitError with retryable:true on a
 * confirm-timeout (blockhash expiry → safe to rebuild + resubmit) and
 * retryable:false on a confirmed on-chain failure.
 */
export async function sendAndConfirmFailover(
  conns: Connection[],
  rawTx: Uint8Array | Buffer,
  opts: { maxRebroadcasts?: number; confirmTimeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<string> {
  if (conns.length === 0) throw mkErr("no RPC connections configured", "no_rpc", false);
  const maxRebroadcasts = opts.maxRebroadcasts ?? 8;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const deadline = Date.now() + confirmTimeoutMs;

  let sig: string | undefined;
  let broadcasts = 0;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    if (broadcasts < maxRebroadcasts) {
      // Rotate providers so a down primary doesn't starve the broadcast. Same
      // bytes → same signature → any node that saw it dedupes (no second tx).
      const conn = conns[broadcasts % conns.length];
      try {
        sig = await conn.sendRawTransaction(rawTx, {
          skipPreflight: broadcasts > 0, // preflight the first send; skip on resends
          maxRetries: 0, // we own re-broadcast
        });
        broadcasts++;
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/already processed|already been processed|AlreadyProcessed/i.test(m)) {
          // already landed — drop to status polling
        } else if (isTransient(e)) {
          lastErr = e;
          broadcasts++; // count it so the next attempt rotates to another provider
        } else {
          throw mkErr(`submit failed: ${m}`, "submit_failed", false);
        }
      }
    }

    if (sig) {
      // Poll across providers; the first clean (non-throwing) read wins.
      for (const conn of conns) {
        try {
          const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
          const st = value[0];
          if (st?.err) {
            throw mkErr(`transaction ${sig} failed on-chain: ${JSON.stringify(st.err)}`, "tx_failed", false);
          }
          if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            return sig;
          }
          break; // clean read (null/processed) from this provider — don't hammer the rest this poll
        } catch (e) {
          if ((e as SubmitError).code === "tx_failed") throw e; // preserve a confirmed on-chain failure
          if (!isTransient(e)) throw e;
          lastErr = e; // this provider blipped — try the next
        }
      }
    }

    await sleep(pollIntervalMs);
  }

  const cause = lastErr ? ` (last RPC error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : "";
  throw mkErr(
    `repay tx ${sig ? "not confirmed" : "never broadcast"} within ${confirmTimeoutMs}ms` +
      `${sig ? ` (sig ${sig})` : ""}${cause} — safe to rebuild a fresh tx and resubmit.`,
    "confirm_timeout",
    true,
  );
}
