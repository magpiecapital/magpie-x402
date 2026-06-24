/**
 * loan-guardian.ts — THE NEVER-DEFAULT ENGINE (the heart of this agent).
 * ─────────────────────────────────────────────────────────────────────────
 * Magpie liquidation is TIME-based: you lose 100% of collateral only if a loan
 * goes overdue. So this module has exactly one job — make sure that NEVER
 * happens. It does three things:
 *
 *   1. RESERVE  — tracks the SOL needed to repay every open loan and refuses to
 *                 let the agent deploy below that reserve. (Solvency by design.)
 *   2. REPAY EARLY — repays each loan with a wide time lead, never last-minute.
 *   3. RETRY FOREVER — a repay is sacred; transient failures are retried with
 *                 backoff until the chain confirms the loan is closed.
 *
 * It is independent of the trading "brain": even if the strategy code crashes,
 * a running guardian keeps every open loan from defaulting.
 *
 * NOTE: the published SDK (@magpieloans/magpie-agent@0.1.x) has no repay()
 * method, so repayment goes through the x402 build-repay HTTP path (see
 * repay.ts) — which is why the guardian also needs the signing keypair.
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import type { MagpieAgent, LoanInfo, TierName } from "@magpieloans/magpie-agent";
import type { AgentConfig } from "./config.js";
import type { Notifier } from "./notifier.js";
import { repayLoan } from "./repay.js";

const log = (s: string) => console.log(`[guardian] ${s}`);
const crit = (s: string) => console.error(`[guardian] 🚨 CRITICAL: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowUnix = () => Math.floor(Date.now() / 1000);

// Reserve 15% over the received principal — a conservative solvency buffer that
// covers the loan fee / any interest gap between received and owed. The actual
// repay pays exactly what the on-chain program computes; this is just headroom.
const RESERVE_MARGIN_NUM = 115n;
const RESERVE_MARGIN_DEN = 100n;
const TIER_TERM_SECONDS: Record<TierName, number> = {
  express: 2 * 86400,
  quick: 3 * 86400,
  standard: 7 * 86400,
};

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
  private tracked = new Map<string, LoanInfo>();

  constructor(
    private readonly agent: MagpieAgent,
    private readonly cfg: AgentConfig,
    private readonly keypair: Keypair,
    private readonly notify?: Notifier,
  ) {
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.self = keypair.publicKey;
  }

  // ── solvency ────────────────────────────────────────────────────────────
  async liquidLamports(): Promise<bigint> {
    return BigInt(await this.conn.getBalance(this.self, "confirmed"));
  }

  /** Conservative SOL we must keep to repay a loan: received principal + margin. */
  private repayReserveFor(loan: LoanInfo): bigint {
    return (BigInt(loan.borrowed_lamports) * RESERVE_MARGIN_NUM) / RESERVE_MARGIN_DEN;
  }

  /** SOL we must keep on hand: every open loan's repay reserve + gas buffer. */
  reservedLamports(): bigint {
    let r = this.cfg.gasBufferLamports;
    for (const l of this.tracked.values()) r += this.repayReserveFor(l);
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
  }): Promise<LoanInfo | null> {
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
    });
    log(`borrowed loan ${res.loanId} (${res.borrowedLamports} lamports received).`);

    // Fetch the on-chain loan to learn its PDA + due time.
    const loan = await this.findActiveLoan(res.loanId);
    if (!loan) {
      crit(`borrow ${res.loanId} confirmed but the loan was not found on read-back. Forcing an immediate sync + repay sweep.`);
      await this.tick(); // self-heal: the sync picks it up and the deadline logic protects it
      return null;
    }
    this.track(loan);

    // Solvency invariant — we must hold the repay reserve in SOL.
    const liquid = await this.liquidLamports();
    const reserve = this.repayReserveFor(loan);
    if (liquid < reserve) {
      crit(
        `under-reserved on loan ${loan.loan_id}: hold ${liquid} lamports, need ~${reserve}. ` +
          `Repaying immediately to avoid any default risk.`,
      );
      await this.repayForever(loan);
      return null;
    }
    const hoursToDue = ((loan.due_at_unix - nowUnix()) / 3600) | 0;
    log(`loan ${loan.loan_id} tracked. owe ~${(Number(reserve) / 1e9).toFixed(4)} SOL reserve, due in ${hoursToDue}h, repays ~${(this.leadSeconds() / 3600) | 0}h early.`);
    await this.notify?.send(
      "borrow",
      `Opened loan ${loan.loan_id} vs ${loan.collateral_mint.slice(0, 8)}… — got ${(Number(res.borrowedLamports) / 1e9).toFixed(4)} SOL, due in ${hoursToDue}h; auto-repays ~${(this.leadSeconds() / 3600) | 0}h early.`,
    );
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
    let active: LoanInfo[];
    try {
      const r = await this.agent.walletLoans(this.self, { status: "active" });
      active = r.loans.filter((l) => l.status === "active");
    } catch (err) {
      log(`sync failed (will retry next tick): ${(err as Error).message}`);
      return; // never throw out of the watcher
    }

    const activeIds = new Set(active.map((l) => l.loan_id));
    for (const id of [...this.tracked.keys()]) if (!activeIds.has(id)) this.tracked.delete(id);
    for (const l of active) this.tracked.set(l.loan_id, l);

    const now = nowUnix();
    for (const loan of active) {
      const repayAt = loan.due_at_unix - this.leadSeconds();
      if (now >= repayAt) {
        if (this.cfg.dryRun) {
          log(`DRY RUN — loan ${loan.loan_id} is inside its repay window; would repay now (due in ${(loan.due_at_unix - now) / 3600 | 0}h).`);
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
  async repayForever(loan: LoanInfo): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // If it's already gone (repaid/liquidated elsewhere), stop.
      const still = await this.findActiveLoan(loan.loan_id).catch(() => undefined);
      if (still === undefined && attempt > 1) {
        log(`loan ${loan.loan_id} no longer active — done.`);
        this.tracked.delete(loan.loan_id);
        return;
      }

      // Make sure we can cover the reserve before signing.
      const liquid = await this.liquidLamports().catch(() => 0n);
      if (liquid < this.repayReserveFor(loan)) {
        crit(
          `under-funded to repay ${loan.loan_id} (have ${liquid}, reserve ~${this.repayReserveFor(loan)}). ` +
            `A real deployment should liquidate/withdraw other positions here. Retrying — do not let this go overdue.`,
        );
      }

      try {
        const res = await repayLoan(this.keypair, loan.loan_pda, this.cfg);
        log(`✓ repaid loan ${loan.loan_id} — tx ${res.signature}`);
        await this.notify?.send("repay", `Repaid loan ${loan.loan_id} on time — tx ${res.signature}`);
        this.tracked.delete(loan.loan_id);
        return;
      } catch (err) {
        const overdue = nowUnix() > loan.due_at_unix;
        const msg = (err as Error).message;
        if (overdue) {
          crit(`repay attempt ${attempt} for OVERDUE loan ${loan.loan_id} failed: ${msg}`);
          await this.notify?.send("error", `OVERDUE loan ${loan.loan_id} repay attempt ${attempt} failed: ${msg} — retrying, will not stop.`);
        } else {
          log(`repay attempt ${attempt} for ${loan.loan_id} failed (${isTransient(err) ? "transient" : "hard"}): ${msg}`);
        }
        // Back off, but cap the delay so we keep hammering as the deadline nears.
        await sleep(Math.min(60_000, 2_000 * attempt));
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private track(loan: LoanInfo): void {
    this.tracked.set(loan.loan_id, loan);
  }

  /**
   * How early to repay, in seconds. We don't have the loan's start time from
   * the SDK, so derive the term from the configured tier and repay at the
   * configured fraction of it (min repayLeadSecondsMin). Wide leads survive RPC
   * blips + the retry loop.
   */
  private leadSeconds(): number {
    const term = TIER_TERM_SECONDS[this.cfg.tier] ?? TIER_TERM_SECONDS.standard;
    return Math.max(this.cfg.repayLeadSecondsMin, Math.floor(term * this.cfg.repayLeadFraction));
  }

  private async findActiveLoan(loanId: string): Promise<LoanInfo | undefined> {
    const r = await this.agent.walletLoans(this.self, { status: "active" });
    return r.loans.find((l) => l.loan_id === loanId && l.status === "active");
  }

  /** For dashboards/logging. */
  openLoans(): LoanInfo[] {
    return [...this.tracked.values()];
  }
}
