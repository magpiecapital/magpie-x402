/**
 * Standard x402 v2 SVM "exact" settle-test against Magpie's LIVE rail.
 *
 * Proves the SETTLE side end-to-end with a REAL on-chain payment:
 *   GET a paid endpoint → 402 (PAYMENT-REQUIRED v2) → build the USDC transfer
 *   with the facilitator as feePayer → retry with PAYMENT-SIGNATURE → the
 *   facilitator co-signs + submits → Magpie verifies on-chain → 200.
 *
 * The Magpie service holds NO keys, so only a real wallet (you) can fire this.
 * Cost: just the endpoint's USDC price (≈ $0.07 for credit-score). The
 * facilitator sponsors the network fee, so the wallet needs ~0 SOL — but it
 * MUST hold USDC and have a USDC ATA.
 *
 * Run:
 *   X402_TEST_KEYPAIR=/path/to/usdc-funded-wallet.json \
 *     npx tsx scripts/settle-test-standard-rail.ts ["/api/v1/credit-score?wallet=<pubkey>"]
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const BASE = process.env.X402_BASE_URL || "https://x402.magpie.capital";
const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ENDPOINT =
  process.argv[2] ||
  "/api/v1/credit-score?wallet=4JSSSaG3xRomQsrxmdQEsahfyFjBVjvuoBKJUUZgzPAx";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 6;

interface Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string; memo: string };
}

function loadKeypair(): Keypair {
  const p = process.env.X402_TEST_KEYPAIR;
  if (!p) throw new Error("Set X402_TEST_KEYPAIR to a JSON keypair file that holds USDC");
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
}

async function main() {
  const kp = loadKeypair();
  const conn = new Connection(RPC, "confirmed");
  console.log(`payer wallet: ${kp.publicKey.toBase58()}`);
  console.log(`endpoint:     ${BASE}${ENDPOINT}\n`);

  // 1. GET → 402 challenge
  const r1 = await fetch(new URL(ENDPOINT, BASE));
  if (r1.status !== 402) {
    throw new Error(`expected HTTP 402, got ${r1.status} — is this a paid endpoint?`);
  }
  const prHeader = r1.headers.get("payment-required");
  if (!prHeader) {
    throw new Error("no PAYMENT-REQUIRED header — standard rail not enabled or feePayer unknown");
  }
  const reqs = JSON.parse(Buffer.from(prHeader, "base64").toString("utf8")) as {
    x402Version: number;
    resource?: unknown;
    accepts: Accept[];
  };
  const accept = (reqs.accepts || []).find((a) => a.asset === USDC.toBase58());
  if (!accept) throw new Error("no USDC option in the challenge accepts");
  console.log(
    `challenge: pay ${accept.amount} USDC atomic (= $${(Number(accept.amount) / 1e6).toFixed(4)})`,
  );
  console.log(`  → payTo ${accept.payTo}`);
  console.log(`  → feePayer (facilitator) ${accept.extra.feePayer}`);
  console.log(`  → memo ${accept.extra.memo}\n`);

  const payTo = new PublicKey(accept.payTo);
  const feePayer = new PublicKey(accept.extra.feePayer);
  const amount = BigInt(accept.amount);
  const srcAta = getAssociatedTokenAddressSync(USDC, kp.publicKey, false, TOKEN_PROGRAM_ID);
  const dstAta = getAssociatedTokenAddressSync(USDC, payTo, true, TOKEN_PROGRAM_ID);

  // 2. Build the partial-signed v0 tx (facilitator = feePayer; we sign the transfer
  //    authority). The x402 v2 SVM "exact" scheme mandates a STRICT 3-6 instruction
  //    layout, in order: [SetComputeUnitLimit, SetComputeUnitPrice, TransferChecked,
  //    (Memo)] — the facilitator rejects anything else (instructions_length).
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    createTransferCheckedInstruction(
      srcAta,
      USDC,
      dstAta,
      kp.publicKey,
      amount,
      USDC_DECIMALS,
      [],
      TOKEN_PROGRAM_ID,
    ),
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM,
      data: Buffer.from(accept.extra.memo, "utf8"),
    }),
  ];
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]); // partial — the facilitator co-signs as feePayer in /settle
  const txB64 = Buffer.from(tx.serialize()).toString("base64");

  // DEBUG: reproduce the facilitator's simulation locally to surface the error.
  try {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      console.log("LOCAL SIM err:", JSON.stringify(sim.value.err));
      console.log("LOCAL SIM logs:\n  " + (sim.value.logs || []).slice(-10).join("\n  "));
    } else {
      console.log(`LOCAL SIM ok (units consumed: ${sim.value.unitsConsumed})`);
    }
  } catch (e) {
    console.log("LOCAL SIM threw:", e instanceof Error ? e.message : e);
  }

  // 3. PaymentPayload (x402 v2 SVM exact) + retry with PAYMENT-SIGNATURE
  const paymentPayload = {
    x402Version: 2,
    resource: reqs.resource,
    accepted: accept,
    payload: { transaction: txB64 },
  };
  const paymentSignature = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // DIRECT mode: call PayAI itself (bypass Magpie) on a FRESH tx, timed, to see
  // PayAI's first-settle behavior in isolation.
  if (process.env.DIRECT) {
    const fbody = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: accept });
    const t0 = Date.now();
    const fv = await fetch("https://facilitator.payai.network/verify", { method: "POST", headers: { "content-type": "application/json" }, body: fbody });
    console.log(`\nDIRECT PayAI /verify → ${fv.status} (${Date.now() - t0}ms): ${(await fv.text()).slice(0, 250)}`);
    const t1 = Date.now();
    const fs = await fetch("https://facilitator.payai.network/settle", { method: "POST", headers: { "content-type": "application/json" }, body: fbody });
    console.log(`DIRECT PayAI /settle → ${fs.status} (${Date.now() - t1}ms): ${(await fs.text()).slice(0, 400)}`);
    return;
  }

  const tR = Date.now();
  const r2 = await fetch(new URL(ENDPOINT, BASE), {
    headers: { "PAYMENT-SIGNATURE": paymentSignature },
  });
  console.log(`(Magpie retry took ${Date.now() - tR}ms)`);
  const body = await r2.text();
  const payResp = r2.headers.get("payment-response");
  console.log(`retry status: ${r2.status}`);
  if (payResp) {
    console.log(
      "PAYMENT-RESPONSE:",
      JSON.parse(Buffer.from(payResp, "base64").toString("utf8")),
    );
  }
  console.log("body:", body.slice(0, 400));

  // DEBUG: when Magpie reports settle_failed, call the facilitator DIRECTLY to
  // surface its raw verify/settle response (Magpie masks it as "no_settlement").
  if (r2.status !== 200) {
    console.log("\n--- direct PayAI facilitator debug (raw) ---");
    const fbody = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: accept });
    try {
      const fv = await fetch("https://facilitator.payai.network/verify", {
        method: "POST", headers: { "content-type": "application/json" }, body: fbody,
      });
      console.log(`PayAI /verify → ${fv.status}: ${(await fv.text()).slice(0, 300)}`);
      const fs = await fetch("https://facilitator.payai.network/settle", {
        method: "POST", headers: { "content-type": "application/json" }, body: fbody,
      });
      console.log(`PayAI /settle → ${fs.status}: ${(await fs.text()).slice(0, 500)}`);
    } catch (e) {
      console.log("direct PayAI err:", e instanceof Error ? e.message : e);
    }
  }
  if (r2.status === 200) {
    console.log("\n✅ SETTLE-TEST PASSED — the standard rail took a real USDC payment end-to-end.");
  } else {
    console.log(
      "\n❌ SETTLE-TEST DID NOT PASS — status/body above. (Fail-closed: if no on-chain settle occurred, you were not charged.)",
    );
  }
}

main().catch((e) => {
  console.error("settle-test error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
