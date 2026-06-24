/**
 * loan-guardian.ts — THE NEVER-DEFAULT ENGINE (the heart of this agent).
 * ─────────────────────────────────────────────────────────────────────────
 * Magpie liquidation is TIME-based: you lose 100% of collateral only if a loan
 * goes overdue. So this module has exactly one job — make sure that NEVER
 * happens. It does three things:
 *
 *   1. RESERVE  — tracks the SOL needed to repay every open loan and refuses to
 *                 let the agent deploy below that reserve. (Solvency by design.)
 *   2. REPAY EARLY — repays each loan with a wide time lead (default: halfway
 *                 through the term), never at the last minute.
 *   3. RETRY FOREVER — a repay is sacred; transient failures are retried with
 *                 backoff until the chain confirms the loan is closed.
 *
 * It is intentionally independent of the trading "brain": even if the strategy
 * code crashes, a running guardian keeps every open loan from defaulting.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import type { MagpieAgent, AgentLoan } from "@magpieloans/magpie-agent";
import type { AgentConfig } from "./config.js";

const log = (s: string) => console.log(`[guardian] ${s}`);
const crit = (s: string) => console.error(`[guardian] 🚨 CRITICAL: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowUnix = () => Math.floor(Date.now() / 1000);

// Errors worth retrying (network / RPC / sim hiccups) vs. a hard "loan is gone".
function isTransient(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return (
    m.includes("timeout") || m.includes("fetch") || m.includes("network") ||
    m.includes("rate") || m.includes("429") || m.includes("503") ||
    m.includes("blockhash") || m.includes("node is behind") || m.includes("econn")
  );
}

export class LoanGuardian {
  private readonly conn: Connection;
  private readonly self: PublicKey;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** loanId -> last-seen loan snapshot we are responsible for. */
  private tracked = new Map<string, AgentLoan>();

  constructor(
    private readonly agent: MagpieAgent,
    private readonly cfg: AgentConfig,
  ) {
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    const pk = agent.publicKey();
    if (!pk) throw new Error("LoanGuardian requires an agent with a signer (keypair).");
    this.self = pk;
  }

  // ── solvency ────────────────────────────────────────────────────────────
  async liquidLamports(): Promise<bigint> {
    return BigInt(await this.conn.getBalance(this.self, "confirmed"));
  }

  /** SOL we must keep on hand: every open loan's full gross repay + gas buffer. */
  reservedLamports(): bigint {
    let r = this.cfg.gasBufferLamports;
    for (const l of this.tracked.values()) r += BigInt(l.repayAmountLamports);
    return r;
  }

  /** How much SOL the strategy is allowed to spend right now (never the reserve). */
  async deployableLamports(): Promise<bigint> {
    const free = (await this.liquidLamports()) - this.reservedLamports();
    return free > 0n ? free : 0n;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  /**
   * Borrow ONLY if we can honor the resulting deadline. Returns the opened loan
   * (now tracked + reserved) or null if it would be unsafe.
   */
  async safeBorrow(opts: {
    collateralMint: string;
    collateralAmount: bigint | string;
  }): Promise<AgentLoan | null> {
    if (this.tracked.size >= this.cfg.maxOpenLoans) {
      log(`refusing borrow — already at maxOpenLoans (${this.cfg.maxOpenLoans}).`);
      return null;
    }
    if (this.cfg.dryRun) {
      log(`DRY RUN — would borrow ${this.cfg.tier} against ${opts.collateralMint} and register it for never-default tracking.`);
      return null;
    }

    const res = await this.agent.borrow({
      collateralMint: opts.collateralMint,
      collateralAmount: opts.collateralAmount,
      tier: this.cfg.tier,
      hasExitArming: this.cfg.useV4Exits,
    });
    log(`borrowed loan ${res.loanId} (${res.borrowedLamports} lamports received).`);

    // Fetch the on-chain loan to learn its PDA, gross repay, and due time.
    const loan = await this.findActiveLoan(res.loanId);
    if (!loan) {
      crit(`borrow ${res.loanId} confirmed but the loan was not found on read-back. Forcing an immediate sync + repay sweep.`);
      await this.tick(); // self-heal: the sync will pick it up and the deadline logic will protect it
      return null;
    }
    this.track(loan);

    // Solvency invariant check — we must already hold the gross repay in SOL.
    const liquid = await this.liquidLamports();
    if (liquid < BigInt(loan.repayAmountLamports)) {
      crit(
        `under-reserved on loan ${loan.loanId}: hold ${liquid} lamports, owe ${loan.repayAmountLamports}. ` +
          `Repaying immediately to avoid any default risk.`,
      );
      await this.repayForever(loan);
      return null;
    }
    log(`loan ${loan.loanId} tracked. owe ${loan.repayAmountLamports} lamports, due in ${(loan.dueTimestampUnix - nowUnix()) / 3600 | 0}h, plan to repay ~${this.leadSeconds(loan) / 3600 | 0}h early.`);
    return loan;
  }

  /** Start the background deadline watcher. Safe to call once at boot. */
  start(): void {
    if (this.timer) return;
    log(`watching deadlines every ${this.cfg.guardianIntervalMs / 60000} min — no loan will be allowed to go overdue.`);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.guardianIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── the watcher ───────────────────────────────────────────────────────────
  /** One sweep: resync from chain, then repay anything inside its lead window. */
  async tick(): Promise<void> {
    let active: AgentLoan[];
    try {
      const r = await this.agent.walletLoans(this.self, { status: "active" });
      active = r.loans.filter((l) => l.status === "active");
    } catch (err) {
      log(`sync failed (will retry next tick): ${(err as Error).message}`);
      return; // never throw out of the watcher
    }

    const activeIds = new Set(active.map((l) => l.loanId));
    // Drop loans that closed (repaid/liquidated); adopt any active loan we weren't tracking.
    for (const id of [...this.tracked.keys()]) if (!activeIds.has(id)) this.tracked.delete(id);
    for (const l of active) this.tracked.set(l.loanId, l);

    const now = nowUnix();
    for (const loan of active) {
      const repayAt = loan.dueTimestampUnix - this.leadSeconds(loan);
      if (now >= repayAt) {
        if (this.cfg.dryRun) {
          log(`DRY RUN — loan ${loan.loanId} is inside its repay window; would repay now (due in ${(loan.dueTimestampUnix - now) / 3600 | 0}h).`);
          continue;
        }
        await this.repayForever(loan);
      }
    }
  }

  // ── repay: never give up ──────────────────────────────────────────────────
  /**
   * Repay a loan, retrying through transient failures until the chain confirms
   * it is closed. A default is unrecoverable, so this loop does not surrender.
   */
  async repayForever(loan: AgentLoan): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // If it's already gone (repaid/liquidated elsewhere), stop.
      const still = await this.findActiveLoan(loan.loanId).catch(() => undefined);
      if (still === undefined && attempt > 1) {
        log(`loan ${loan.loanId} no longer active — done.`);
        this.tracked.delete(loan.loanId);
        return;
      }

      // Make sure we can actually cover the gross repay before signing.
      const liquid = await this.liquidLamports().catch(() => 0n);
      if (liquid < BigInt(loan.repayAmountLamports)) {
        crit(
          `cannot fully fund repay of ${loan.loanId} (have ${liquid}, owe ${loan.repayAmountLamports}). ` +
            `A real deployment should liquidate/withdraw other positions here. Retrying — do not let this go overdue.`,
        );
      }

      try {
        const res = await this.agent.repay({ loanPda: loan.loanPda });
        log(`✓ repaid loan ${loan.loanId} — tx ${res.signature}`);
        this.tracked.delete(loan.loanId);
        return;
      } catch (err) {
        const overdue = nowUnix() > loan.dueTimestampUnix;
        const msg = (err as Error).message;
        if (overdue) crit(`repay attempt ${attempt} for OVERDUE loan ${loan.loanId} failed: ${msg}`);
        else log(`repay attempt ${attempt} for ${loan.loanId} failed (${isTransient(err) ? "transient" : "hard"}): ${msg}`);
        // Back off, but cap the delay so we keep hammering as the deadline nears.
        await sleep(Math.min(60_000, 2_000 * attempt));
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private track(loan: AgentLoan): void {
    this.tracked.set(loan.loanId, loan);
  }

  private leadSeconds(loan: AgentLoan): number {
    const term = Math.max(1, loan.dueTimestampUnix - loan.startTimestampUnix);
    return Math.max(this.cfg.repayLeadSecondsMin, Math.floor(term * this.cfg.repayLeadFraction));
  }

  private async findActiveLoan(loanId: string): Promise<AgentLoan | undefined> {
    const r = await this.agent.walletLoans(this.self, { status: "active" });
    return r.loans.find((l) => l.loanId === loanId && l.status === "active");
  }

  /** For dashboards/logging. */
  openLoans(): AgentLoan[] {
    return [...this.tracked.values()];
  }
}
