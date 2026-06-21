/**
 * 12 — RWA carry agent (no-taxable-sale leverage on tokenized equity)
 *
 * An autonomous agent borrows SOL against a tokenized US equity (RWA)
 * collateral and arms an in-vault stop-loss — a carry trade that NEVER
 * sells the equity, so no capital-gains event is triggered and the
 * position stays open:
 *
 *   borrow (V4, exit-armed, RWA collateral)  →  arm in-vault stop-loss  →
 *   (engine fires the SL in-vault if the equity drops)  →  repay to unwind
 *
 * HONESTY — RWA IS LAUNCH-GATED. The V3 equity track is not live yet, so
 * the RWA borrow leg below will be ACCEPTED by x402 but REJECTED at the
 * program level until the V3 equity-track launch. On the V3 launch this
 * runs end-to-end as written; today it degrades gracefully — it prints the
 * exact V4 routing the borrow WOULD take, then exits without implying the
 * RWA borrow is live. Swap in any standard catalog mint to exercise the
 * full arm/repay flow now.
 *
 * The agent signs every action with its own keypair; the x402 service
 * holds no keys. Self-custody, no Telegram, no delegation.
 *
 * Run:
 *   MAGPIE_PAYER_KEYPAIR=/path/to/id.json SOLANA_RPC_URL=https://… \
 *     npx tsx examples/12-rwa-carry-agent.ts <EQUITY_MINT> <RAW_AMOUNT>
 */
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { MagpieAgent, X402Error } from "@magpieloans/magpie-agent";

const [mint, rawAmount] = process.argv.slice(2);
if (!mint || !rawAmount) {
  console.error("usage: 12-rwa-carry-agent.ts <EQUITY_MINT> <RAW_AMOUNT>");
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(process.env.MAGPIE_PAYER_KEYPAIR!, "utf8"))),
);
const agent = new MagpieAgent({ keypair, rpcUrl: process.env.SOLANA_RPC_URL });

async function main() {
  // 0) Confirm how this collateral routes. RWA mints (category 'rwa') will
  //    settle on the V3 equity track once it launches; with exit arming the
  //    loan opens on V4 so we can hang an in-vault stop-loss off it.
  const { tokens } = await agent.collateralCatalog();
  const meta = tokens.find((t) => t.mint === mint);
  const isRwa = meta?.category === "rwa";
  console.log(
    `collateral ${meta?.symbol ?? mint} — category ${meta?.category ?? "unknown"} → ` +
      `${isRwa ? "V3 equity track (on the V3 launch) + V4 in-vault exits" : "V4 in-vault"}`,
  );

  // 1) Borrow SOL against the equity, opening on V4 so we can arm exits.
  //    On the V3 equity-track launch this leg settles RWA collateral; today
  //    an RWA mint is rejected at the program level — caught below.
  let loan;
  try {
    loan = await agent.borrow({
      collateralMint: mint,
      collateralAmount: BigInt(rawAmount),
      tier: "express",
      hasExitArming: true, // → routes to the V4 in-vault program
    });
    console.log(`borrowed ${loan.borrowedLamports} lamports — loan ${loan.loanId}`);
  } catch (e) {
    if (isRwa && e instanceof X402Error) {
      // Launch-gated: the RWA borrow leg goes live on the V3 equity-track
      // launch. Until then, surface the routing this borrow WOULD take and
      // exit cleanly rather than pretending the position opened.
      console.log(
        "\nRWA borrow is launch-gated — this will settle on the V3 equity-track launch.",
      );
      console.log(
        `Routing preview: ${meta?.symbol ?? mint} → V3 equity track (collateral) + ` +
          `V4 in-vault loan, tier express, ${rawAmount} raw units. ` +
          "Re-run on the V3 launch (or with a standard catalog mint today) to open.",
      );
      return;
    }
    throw e;
  }

  // 2) Arm an in-vault stop-loss at 0.7× — it fires IN-VAULT: SOL proceeds
  //    accrue in the loan's vault, the loan stays Active, and only a
  //    borrower-signed repay can release funds to the wallet. The equity is
  //    never sold by the agent, so no taxable disposal occurs.
  const sl = await agent.armExit({
    loanId: loan.loanId,
    direction: "below",
    target: "0.7x",
    slippageBps: 150,
  });
  console.log("armed in-vault stop-loss:", sl.order);

  // 3) Inspect the live exits + the loan's in-vault state.
  const exits = await agent.listExits();
  console.log(`${exits.orders.length} armed exit order(s)`);
  const loanPda = sl.order.loan_pda as string | undefined;
  if (loanPda) {
    const view = await agent.loanByPda(loanPda);
    if (view.v4) {
      console.log(
        `in-vault SOL proceeds so far: ${view.v4.solProceedsLamports} lamports ` +
          `(${view.v4.autoSellsFired} auto-sells fired)`,
      );
    }
  }

  // 4) The engine watches the equity and fires the stop-loss in-vault — no
  //    babysitting, no forced sale of the equity. To unwind the carry, the
  //    agent repays (the only path to the wallet); the equity returns intact.
  console.log("carry armed. The engine fires the stop-loss in-vault; repay to unwind.");
}

main().catch((e) => {
  console.error("rwa carry failed:", e);
  process.exit(1);
});
