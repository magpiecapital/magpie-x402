/**
 * Webhook signature verification helpers.
 *
 * Used by an agent's webhook receiver to verify that an incoming
 * intent.matched POST actually came from Magpie. Constant-time
 * compare is mandatory — string-equal compare leaks timing.
 *
 * Pattern:
 *
 *   import { verifyWebhookSignature } from "@magpieloans/magpie-agent";
 *
 *   app.post("/intent", async (req, res) => {
 *     const ok = verifyWebhookSignature(
 *       webhookSecret,
 *       req.rawBody,                          // Buffer of exact bytes
 *       req.headers["x-magpie-signature"],
 *     );
 *     if (!ok) return res.status(401).end();
 *     // …trusted, proceed…
 *   });
 *
 * IMPORTANT: `rawBody` must be the EXACT bytes the server signed.
 * If you JSON.parse + JSON.stringify before signing, you get a
 * different byte sequence. Many frameworks reassemble the body —
 * use a raw-body middleware (e.g. body-parser raw, or Hono's
 * c.req.arrayBuffer).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  webhookSecret: string,
  bodyBytes: Buffer | Uint8Array | string,
  presentedSignatureHex: string | string[] | undefined,
): boolean {
  if (typeof presentedSignatureHex !== "string") return false;
  // Strict: exact length + lowercase hex only. Both checks in one
  // regex so a length-only-then-format split can't get out of sync.
  if (!/^[0-9a-f]{64}$/.test(presentedSignatureHex)) return false;

  const body = typeof bodyBytes === "string"
    ? Buffer.from(bodyBytes, "utf8")
    : Buffer.from(bodyBytes);
  const expected = createHmac("sha256", webhookSecret).update(body).digest();
  const presented = Buffer.from(presentedSignatureHex, "hex");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

/**
 * The shape of an intent.matched webhook payload.
 * Re-export so SDK consumers get types for their handler.
 */
export interface IntentMatchedPayload {
  event: "intent.matched";
  issued_at: number;
  intent_id: string;
  status: "matched";
  matched_at: string;
  summary: {
    loanId: string;
    loan_pda: string;
    collateral_mint: string;
    collateral_symbol: string | null;
    collateral_amount_raw: string;
    collateral_value_sol: number;
    principal_sol: number;
    fee_sol: number;
    ltv_pct: number;
    duration_days: number;
    due_unix: number;
  };
  partial_signed_tx_b64: string;
  next_step: string;
}
