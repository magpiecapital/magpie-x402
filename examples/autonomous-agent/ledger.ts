/**
 * ledger.ts — realized-P&L accounting + a drawdown circuit-breaker.
 * ─────────────────────────────────────────────────────────────────────────
 * The agent tracked cost basis (positions.ts) but recorded ZERO realized P&L on
 * exits — so it could never tell it was losing money, and never adapted. That's
 * the #1 reason it bled. This ledger:
 *
 *   1. Records every CLOSED trade's realized P&L (proceeds − cost).
 *   2. Keeps cumulative stats + a high-water mark of realized P&L.
 *   3. Powers a CIRCUIT-BREAKER: halt NEW entries once realized P&L falls a set
 *      amount below its high-water mark, OR after N consecutive losers. Aggressive
 *      alpha-seeking is the mandate — but "aggressive" must never mean "ruin", so
 *      a losing streak trips the breaker and pauses new risk until a human looks.
 *
 * Persistence is best-effort JSON (LEDGER_FILE, default ./.ledger.json), same as
 * positions.ts. If it's lost on a redeploy the breaker resets — acceptable: it
 * only ever makes the agent MORE cautious, never less.
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface LedgerStats {
  /** Cumulative realized P&L across all closed trades (lamports; can be negative). */
  realizedPnlLamports: bigint;
  wins: number;
  losses: number;
  tradesClosed: number;
  /** High-water mark of cumulative realized P&L. */
  hwmLamports: bigint;
  /** How far below the high-water mark we are now (>= 0). */
  drawdownLamports: bigint;
  consecutiveLosses: number;
}

interface RawStats {
  realizedPnlLamports: string;
  wins: number;
  losses: number;
  tradesClosed: number;
  hwmLamports: string;
  consecutiveLosses: number;
}

export class Ledger {
  private readonly file: string;
  private realized = 0n;
  private wins = 0;
  private losses = 0;
  private closed = 0;
  private hwm = 0n;
  private consecLosses = 0;

  constructor(file = process.env.LEDGER_FILE ?? "./.ledger.json") {
    this.file = file;
    this.load();
  }

  private load(): void {
    try {
      const r = JSON.parse(readFileSync(this.file, "utf8")) as RawStats;
      this.realized = BigInt(r.realizedPnlLamports ?? "0");
      this.wins = Number(r.wins ?? 0);
      this.losses = Number(r.losses ?? 0);
      this.closed = Number(r.tradesClosed ?? 0);
      this.hwm = BigInt(r.hwmLamports ?? "0");
      this.consecLosses = Number(r.consecutiveLosses ?? 0);
    } catch {
      /* no ledger yet — start flat. */
    }
  }

  private persist(): void {
    try {
      const obj: RawStats = {
        realizedPnlLamports: this.realized.toString(),
        wins: this.wins,
        losses: this.losses,
        tradesClosed: this.closed,
        hwmLamports: this.hwm.toString(),
        consecutiveLosses: this.consecLosses,
      };
      writeFileSync(this.file, JSON.stringify(obj, null, 2));
    } catch {
      /* best-effort — an unwritable FS must never break trading. */
    }
  }

  /**
   * Record a CLOSED trade. Returns the realized P&L (proceeds − cost) in lamports
   * (negative = a loss). Updates win/loss counts, the consecutive-loss counter,
   * and the high-water mark.
   */
  recordExit(costLamports: bigint, proceedsLamports: bigint): bigint {
    const pnl = proceedsLamports - costLamports;
    this.realized += pnl;
    this.closed += 1;
    if (pnl >= 0n) {
      this.wins += 1;
      this.consecLosses = 0;
    } else {
      this.losses += 1;
      this.consecLosses += 1;
    }
    if (this.realized > this.hwm) this.hwm = this.realized;
    this.persist();
    return pnl;
  }

  stats(): LedgerStats {
    const dd = this.hwm - this.realized;
    return {
      realizedPnlLamports: this.realized,
      wins: this.wins,
      losses: this.losses,
      tradesClosed: this.closed,
      hwmLamports: this.hwm,
      drawdownLamports: dd > 0n ? dd : 0n,
      consecutiveLosses: this.consecLosses,
    };
  }

  /**
   * Circuit-breaker check. Returns a human reason string when tripped (caller
   * should HALT new entries + DM the operator), else null. Trips on either:
   *   • consecutiveLosses >= maxConsecutiveLosses (a losing streak), or
   *   • drawdown from the realized-P&L high-water mark >= maxDrawdownLamports.
   * Pass 0 to disable a limit.
   */
  circuitBreak(maxDrawdownLamports: bigint, maxConsecutiveLosses: number): string | null {
    const s = this.stats();
    if (maxConsecutiveLosses > 0 && s.consecutiveLosses >= maxConsecutiveLosses) {
      return `${s.consecutiveLosses} consecutive losing trades (limit ${maxConsecutiveLosses})`;
    }
    if (maxDrawdownLamports > 0n && s.drawdownLamports >= maxDrawdownLamports) {
      return `realized-P&L drawdown ${(Number(s.drawdownLamports) / 1e9).toFixed(3)} SOL from high-water mark (limit ${(Number(maxDrawdownLamports) / 1e9).toFixed(3)} SOL)`;
    }
    return null;
  }
}
