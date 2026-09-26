import assert from "node:assert/strict";
import test from "node:test";
import { Connection, Keypair } from "@solana/web3.js";
import { paidCall, type PaymentRequirements } from "./x402.js";

const payTo = Keypair.generate().publicKey.toBase58();

function challengeResponse() {
  return new Response(null, {
    status: 402,
    headers: {
      "X-Payment-Required-Recipient": payTo,
      "X-Payment-Required-Amount": "1000000",
      "X-Payment-Required-Nonce": "nonce-1",
      "X-Payment-Required-Memo": "magpie-x402:nonce-1",
    },
  });
}

test("runs the external hook before the signer and allows the retry", async () => {
  const requirements: PaymentRequirements[] = [];
  let signed = false;
  const signer = {
    publicKey: Keypair.generate().publicKey,
    async signTransaction(tx: any) {
      signed = true;
      return tx;
    },
  } as any;
  const originalBlockhash = Connection.prototype.getLatestBlockhash;
  const originalSend = Connection.prototype.sendRawTransaction;
  const originalConfirm = Connection.prototype.confirmTransaction;
  Connection.prototype.getLatestBlockhash = async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }) as any;
  Connection.prototype.sendRawTransaction = async () => "signature-1";
  Connection.prototype.confirmTransaction = async () => ({ value: { err: null } } as any);
  try {
    let first = true;
    const result = await paidCall(
      { baseUrl: "https://x402.magpie.capital", rpcUrl: "https://rpc.invalid", signer,
        beforePayment: async (value) => { requirements.push(value); } },
      "GET", "/api/v1/credit-score", {
        fetcher: async (_url, init: any) => {
          if (first) { first = false; return challengeResponse(); }
          assert.equal(init.headers["X-Payment"], "signature-1");
          return Response.json({ ok: true });
        },
      },
    );
    assert.deepEqual(result.data, { ok: true });
    assert.equal(signed, true);
    assert.equal(requirements[0].amountLamports, "1000000");
    assert.equal(requirements[0].payTo, payTo);
  } finally {
    Connection.prototype.getLatestBlockhash = originalBlockhash;
    Connection.prototype.sendRawTransaction = originalSend;
    Connection.prototype.confirmTransaction = originalConfirm;
  }
});

test("blocks before signing when the external policy denies", async () => {
  let signed = false;
  const signer = {
    publicKey: Keypair.generate().publicKey,
    async signTransaction(tx: any) { signed = true; return tx; },
  } as any;
  await assert.rejects(
    () => paidCall(
      { baseUrl: "https://x402.magpie.capital", rpcUrl: "https://rpc.invalid", signer,
        beforePayment: () => ({ abort: true, reason: "daily_cap" }) },
      "GET", "/api/v1/credit-score", { fetcher: async () => challengeResponse() },
    ),
    (error: any) => error.code === "policy_denied" && /daily_cap/.test(error.message),
  );
  assert.equal(signed, false);
});

test("fails closed when the external policy is unavailable", async () => {
  let signed = false;
  const signer = {
    publicKey: Keypair.generate().publicKey,
    async signTransaction(tx: any) { signed = true; return tx; },
  } as any;
  await assert.rejects(
    () => paidCall(
      { baseUrl: "https://x402.magpie.capital", rpcUrl: "https://rpc.invalid", signer,
        beforePayment: async () => { throw new Error("Varyntiq unavailable"); } },
      "GET", "/api/v1/credit-score", { fetcher: async () => challengeResponse() },
    ),
    (error: any) => error.code === "policy_hook_failed" && error.status === 503,
  );
  assert.equal(signed, false);
});

