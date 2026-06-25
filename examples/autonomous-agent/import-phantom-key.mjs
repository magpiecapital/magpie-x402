/**
 * import-phantom-key.mjs
 * Turn a Phantom (base58) private key into the JSON keypair file the agent uses.
 *
 * 100% LOCAL. Your key is read from stdin — never passed as an argument, never
 * written to a log, never sent anywhere. Output prints ONLY your public address.
 * Run it yourself; never share the key with anyone (including in a chat).
 *
 *   node examples/autonomous-agent/import-phantom-key.mjs
 *   # paste your key when prompted → writes ~/agent-wallet.json (chmod 600)
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Keypair } from "@solana/web3.js";
import bs58mod from "bs58";

const bs58 = bs58mod && bs58mod.decode ? bs58mod : bs58mod.default;
const out = process.env.OUT ?? join(homedir(), "agent-wallet.json");

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
process.stdout.write("Paste your Phantom PRIVATE KEY (base58), then press Enter:\n> ");
rl.once("line", (raw) => {
  try {
    const secret = bs58.decode(raw.trim());
    if (secret.length !== 64) {
      throw new Error(
        `Got a ${secret.length}-byte value. Export the PRIVATE KEY (a ~88-char base58 string) ` +
          `from Phantom — not the seed phrase.`,
      );
    }
    const kp = Keypair.fromSecretKey(secret);
    writeFileSync(out, JSON.stringify(Array.from(secret)), { mode: 0o600 });
    console.log(`\n✓ Wrote ${out}  (permissions 600)`);
    console.log(`✓ Wallet address: ${kp.publicKey.toBase58()}`);
    console.log("  → Confirm this EXACTLY matches the address Phantom shows for this account.");
    console.log("  → Then clear your terminal (Cmd-K) so the key isn't left on screen.");
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
});
