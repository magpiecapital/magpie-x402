/**
 * 13 — Bring-your-own-wallet agent (SendAI BaseWallet / Privy / Turnkey)
 *
 * Most agent frameworks NEVER hand you a raw Solana `Keypair` — the private key
 * lives inside a wallet service (Privy / Turnkey / embedded) or a framework
 * abstraction (SendAI / Solana Agent Kit `BaseWallet`). Magpie works with those
 * unchanged: pass a `signer` instead of a `keypair`.
 *
 * A `signer` is any object implementing the `MagpieSigner` shape:
 *
 *     interface MagpieSigner {
 *       publicKey: PublicKey;
 *       signTransaction<T>(tx: T): Promise<T>;             // sign in the wallet
 *       signMessage(message: Uint8Array): Promise<Uint8Array>;  // 64-byte Ed25519
 *     }
 *
 * Every adapter you'd write is ~10 lines — forward `signTransaction` /
 * `signMessage` to your wallet. The SDK never sees the secret key; with a
 * `signer` it touches no raw key bytes at all.
 *
 * This file runs end-to-end with a local keypair as the reference wallet (via
 * the SDK's `signerFromKeypair`), and shows — in comments — exactly where a
 * SendAI `BaseWallet` or a Privy/Turnkey wallet plugs in instead.
 *
 * Run:
 *   MAGPIE_PAYER_KEYPAIR=/path/to/id.json SOLANA_RPC_URL=https://… \
 *     npx tsx examples/13-basewallet-agent.ts <WALLET_PUBKEY?>
 */
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import {
  MagpieAgent,
  signerFromKeypair,
  type MagpieSigner,
} from "@magpieloans/magpie-agent";

// ── 1) Get a signer ──────────────────────────────────────────────────────────
//
// (a) Reference: adapt a local Keypair. This is the back-compat path — the SDK
//     would do this for you if you passed `{ keypair }`, but doing it
//     explicitly shows that `signer` and `keypair` are the same abstraction.
const keypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(process.env.MAGPIE_PAYER_KEYPAIR!, "utf8"))),
);
const signer: MagpieSigner = signerFromKeypair(keypair);

// (b) SendAI / Solana Agent Kit `BaseWallet` — drop in instead of (a):
//
//     import { KeypairWallet } from "@solana/agent-kit"; // or your BaseWallet
//     const wallet = new KeypairWallet(/* … */);
//     const signer: MagpieSigner = {
//       publicKey: wallet.publicKey,
//       signTransaction: (tx) => wallet.signTransaction(tx),
//       signMessage: (msg) => wallet.signMessage(msg),
//     };
//
// (c) Privy server wallet — drop in instead of (a):
//
//     const signer: MagpieSigner = {
//       publicKey: new PublicKey(privyWallet.address),
//       signTransaction: async (tx) => (await privy.walletApi.solana.signTransaction({
//         walletId, transaction: tx,
//       })).signedTransaction,
//       signMessage: async (msg) => (await privy.walletApi.solana.signMessage({
//         walletId, message: msg,
//       })).signature,
//     };
//
// (d) Turnkey — same shape, forwarding to your Turnkey signer's
//     `signTransaction` / `signRawPayload`.

// ── 2) Construct the agent with the signer (no raw key reaches the SDK) ───────
const agent = new MagpieAgent({ signer, rpcUrl: process.env.SOLANA_RPC_URL });
console.log(`agent wallet: ${agent.publicKey()?.toBase58()}`);

async function main() {
  // Everything works identically to the keypair path — reads are free, paid
  // calls sign through the wallet, and exit-arming signs the Ed25519 envelope
  // through `signer.signMessage`. Here we do a couple of safe, illustrative
  // reads, then point at the write paths.

  // Free read: the agent's current loans (no payment, no signature).
  const wallet = process.argv[2] ?? agent.publicKey()!.toBase58();
  const loans = await agent.walletLoans(wallet);
  console.log(`${loans.loans.length} loan(s) for ${wallet}`);

  // From here the FULL surface is available through the same `signer`:
  //
  //   await agent.borrow({ collateralMint, collateralAmount, tier: "express" });
  //   await agent.armExit({ loanId, direction: "above", target: "2x", slippageBps: 100 });
  //   await agent.repay({ loanPda });
  //
  // Each one signs in your wallet service — the x402 service holds no keys, so
  // even a full compromise of it can't move the agent's funds. Non-custodial
  // by construction, with or without a raw keypair.
  console.log(
    "signer wired ✓ — borrow / arm-exit / repay all sign through your wallet, never a raw key.",
  );
}

main().catch((e) => {
  console.error("basewallet agent failed:", e);
  process.exit(1);
});
