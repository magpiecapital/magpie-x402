import type { Context } from "hono";
import { PublicKey } from "@solana/web3.js";
import { tierFromName, quoteBorrow, TIERS } from "../lib/tiers.js";

/**
 * GET /api/v1/simulate-borrow
 *
 * Preview a loan WITHOUT submitting it on-chain. Agents use this to:
 *   - quote a borrow to a user before they commit
 *   - compare tiers side-by-side for the same collateral
 *   - estimate liquidation risk relative to expected loan amount
 *
 * Query params (all required):
 *   mint                 Solana mint pubkey of the collateral token
 *   amount               raw u64 in the token's smallest unit
 *   decimals             token decimals (0–18)
 *   pricePerTokenUsd     spot price (caller responsible for fresh oracle)
 *   solPriceUsd          spot SOL/USD price (for lamport conversion)
 *   tier                 express | quick | standard
 *                        OR pass tier=all to return quotes for all 3
 *
 * Why "caller-supplied prices" rather than fetching ourselves: agents
 * already have their own oracle preferences (Pyth, Switchboard,
 * Birdeye, on-chain reads). Forcing our oracle would couple them to
 * our choice + add 50-200ms of latency. They pass prices, we do the
 * math — single roundtrip, no oracle dependency, fully deterministic.
 *
 * Free endpoint — pure math from public tier constants + caller
 * inputs. Costs us nothing per call.
 */
export async function simulateBorrowHandler(c: Context) {
  const mint = c.req.query("mint");
  const amountStr = c.req.query("amount");
  const decimalsStr = c.req.query("decimals");
  const priceStr = c.req.query("pricePerTokenUsd");
  const solPriceStr = c.req.query("solPriceUsd");
  const tierName = (c.req.query("tier") ?? "all").toLowerCase();

  // ── Validation (strict, fail-fast, no oracle fallback) ──
  if (!mint || !amountStr || !decimalsStr || !priceStr || !solPriceStr) {
    return c.json(
      {
        error: "missing_params",
        required: ["mint", "amount", "decimals", "pricePerTokenUsd", "solPriceUsd", "tier"],
      },
      400,
    );
  }
  try {
    new PublicKey(mint);
  } catch {
    return c.json({ error: "invalid_mint" }, 400);
  }
  if (!/^\d+$/.test(amountStr)) return c.json({ error: "invalid_amount" }, 400);
  if (!/^\d{1,2}$/.test(decimalsStr)) return c.json({ error: "invalid_decimals" }, 400);
  const price = Number(priceStr);
  const solPrice = Number(solPriceStr);
  if (!isFinite(price) || price <= 0) return c.json({ error: "invalid_pricePerTokenUsd" }, 400);
  if (!isFinite(solPrice) || solPrice <= 0) return c.json({ error: "invalid_solPriceUsd" }, 400);

  const amount = BigInt(amountStr);
  const decimals = Number(decimalsStr);
  if (amount <= 0n) return c.json({ error: "amount_must_be_positive" }, 400);

  // ── Compute quote(s) ──
  try {
    if (tierName === "all") {
      const quotes = Object.values(TIERS).map((tier) =>
        quoteBorrow({ tier, mint, amount, decimals, pricePerTokenUsd: price, solPriceUsd: solPrice }),
      );
      return c.json(
        { tier: "all", quotes },
        200,
        { "Cache-Control": "private, max-age=5" },
      );
    }
    const tier = tierFromName(tierName);
    if (!tier) {
      return c.json({ error: "invalid_tier", validTiers: Object.keys(TIERS) }, 400);
    }
    const quote = quoteBorrow({
      tier,
      mint,
      amount,
      decimals,
      pricePerTokenUsd: price,
      solPriceUsd: solPrice,
    });
    return c.json(quote, 200, { "Cache-Control": "private, max-age=5" });
  } catch (err) {
    return c.json({ error: "quote_failed", reason: (err as Error).message }, 400);
  }
}
