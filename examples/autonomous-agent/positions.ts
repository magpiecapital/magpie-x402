/**
 * positions.ts — the trade book's cost basis.
 * ─────────────────────────────────────────────────────────────────────────
 * A spot trader needs to know what it PAID to know if it's in profit. The
 * mechanical take-profit / stop-loss compares a position's current SOL value
 * against this entry. We record SOL spent + tokens received on every buy and
 * clear the entry on a full exit.
 *
 * Persistence is BEST-EFFORT to a JSON file (POSITIONS_FILE, default
 * ./.positions.json). It survives an in-place process restart. It does NOT
 * reliably survive a fresh container/redeploy (ephemeral FS) — and that's OK:
 * if cost basis is lost, the mechanical TP/SL simply can't fire for that
 * position and the BRAIN becomes its sole exit decision-maker until it's
 * re-bought. We never trade *worse* for lack of a basis, only less mechanically.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface Entry {
  /** Total SOL spent acquiring the current position (lamports). */
  costLamports: bigint;
  /** Total tokens acquired for that cost (base units). */
  amountBaseUnits: bigint;
  /** First-buy timestamp (ms) — used for the min-hold window. */
  entryTs: number;
}

interface RawEntry { costLamports: string; amountBaseUnits: string; entryTs: number }

export class Positions {
  private readonly file: string;
  private readonly book = new Map<string, Entry>();

  constructor(file = process.env.POSITIONS_FILE ?? "./.positions.json") {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, RawEntry>;
      for (const [mint, e] of Object.entries(raw)) {
        this.book.set(mint, {
          costLamports: BigInt(e.costLamports),
          amountBaseUnits: BigInt(e.amountBaseUnits),
          entryTs: Number(e.entryTs) || Date.now(),
        });
      }
    } catch {
      /* no file yet, or unreadable — start empty. */
    }
  }

  private persist(): void {
    try {
      const obj: Record<string, RawEntry> = {};
      for (const [mint, e] of this.book) {
        obj[mint] = {
          costLamports: e.costLamports.toString(),
          amountBaseUnits: e.amountBaseUnits.toString(),
          entryTs: e.entryTs,
        };
      }
      writeFileSync(this.file, JSON.stringify(obj, null, 2));
    } catch {
      /* best-effort only — an unwritable FS must never break trading. */
    }
  }

  get(mint: string): Entry | undefined {
    return this.book.get(mint);
  }

  /** Record a buy: adds to cost + size, stamps entryTs on first acquisition. */
  recordBuy(mint: string, costLamports: bigint, amountBaseUnits: bigint, now: number): void {
    const prev = this.book.get(mint);
    this.book.set(mint, {
      costLamports: (prev?.costLamports ?? 0n) + costLamports,
      amountBaseUnits: (prev?.amountBaseUnits ?? 0n) + amountBaseUnits,
      entryTs: prev?.entryTs ?? now,
    });
    this.persist();
  }

  /** Clear a position after a full exit. */
  clear(mint: string): void {
    if (this.book.delete(mint)) this.persist();
  }

  /**
   * Reconcile the book against what the wallet ACTUALLY holds: drop entries for
   * mints no longer held (sold elsewhere / dust-swept) so they don't linger.
   */
  reconcile(heldMints: Set<string>): void {
    let changed = false;
    for (const mint of [...this.book.keys()]) {
      if (!heldMints.has(mint)) {
        this.book.delete(mint);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
