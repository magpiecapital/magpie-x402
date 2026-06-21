/**
 * 11 — Full-lifecycle leverage agent (the flagship flow)
 *
 * One autonomous agent runs an entire leveraged-position lifecycle on Magpie,
 * permissionlessly, with no human and no custody:
 *
 *   borrow (V4, exit-armed)  →  arm in-vault take-profit + stop-loss  →
 *   (engine fires the exits in-vault as price moves)  →  repay
 *
 * The agent signs every transaction with its own keypair. The x402 service
 * holds no keys; even a full compromise of it cannot move the agent's funds.
 *
 * Run:
 *   MAGPIE_PAYER_KEYPAIR=/path/to/id.json SOLANA_RPC_URL=https://… \
 *     npx tsx examples/11-full-lifecycle-leverage-agent.ts <COLLATERAL_MINT> <RAW_AMOUNT>
 */
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { MagpieAgent } from "@magpieloans/magpie-agent";

const [mint, rawAmount] = process.argv.slice(2);
if (!mint || !rawAmount) {
  console.error("usage: 11-full-lifecycle-leverage-agent.ts <COLLATERAL_MINT> <RAW_AMOUNT>");
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(process.env.MAGPIE_PAYER_KEYPAIR!, "utf8"))),
);
const agent = new MagpieAgent({ keypair, rpcUrl: process.env.SOLANA_RPC_URL });

async function main() {
  // 1) Borrow against the token, opening on V4 so we can arm exits on the loan.
  const loan = await agent.borrow({
    collateralMint: mint,
    collateralAmount: BigInt(rawAmount),
    tier: "express",
    hasExitArming: true, // → routes to the V4 in-vault program
  });
  console.log(`borrowed ${loan.borrowedLamports} lamports — loan ${loan.loanId}`);

  // 2) Arm a take-profit at 2× and a stop-loss at 0.7× — both fire IN-VAULT:
  //    proceeds accrue in the loan's vault, the loan stays Active, and only a
  //    borrower-signed repay can release funds to the wallet.
  const tp = await agent.armExit({ loanId: loan.loanId, direction: "above", target: "2x", slippageBps: 100 });
  const sl = await agent.armExit({ loanId: loan.loanId, direction: "below", target: "0.7x", slippageBps: 150 });
  console.log("armed take-profit:", tp.order, "\narmed stop-loss:", sl.order);

  // 3) Inspect: what exits are live, and what's the loan's in-vault state?
  const exits = await agent.listExits();
  console.log(`${exits.orders.length} armed exit order(s)`);
  const loanPda = tp.order.loan_pda as string | undefined;
  if (loanPda) {
    const view = await agent.loanByPda(loanPda);
    if (view.v4) {
      console.log(
        `in-vault SOL proceeds so far: ${view.v4.solProceedsLamports} lamports ` +
          `(${view.v4.autoSellsFired} auto-sells fired)`,
      );
    }
  }

  // 4) The engine fires the exits as the market moves — no babysitting. When
  //    the agent decides to close out, it repays (the only path to the wallet).
  //    Repay is borrower-signed; build it with the SDK's repay flow when ready.
  console.log("lifecycle armed. The engine will fire exits in-vault; repay when you're done.");
}

main().catch((e) => {
  console.error("lifecycle failed:", e);
  process.exit(1);
});
