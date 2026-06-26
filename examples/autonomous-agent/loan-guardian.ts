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
 * FIELD NORMALIZATION (critical): the published SDK types loans as snake_case
 * (loan_id, loan_pda, …) but the live walletLoans response is camelCase
 * (loanId, loanPda, loanAmountLamports, repayAmountLamports, dueTimestampUnix).
 * If we read the typed snake_case names we get `undefined` → the guardian can't
 * find/track the loan and BigInt(undefined) throws. So every loan from the SDK
 * is run through norm() which reads camelCase first, snake_case as fallback, and
 * uses the EXACT on-chain repayAmountLamports + start/due times.
 *
 * The published SDK (@magpieloans/magpie-agent@0.1.x) has no repay() method, so
 * repayment goes through the x402 build-repay HTTP path (see repay.ts) — which is
 * why the guardian also needs the signing keypair.
 */
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import type { MagpieAgent, TierName } from "@magpieloans/magpie-agent";
import type { AgentConfig } from "./config.js";
import type { Notifier } from "./notifier.js";
import { repayLoan } from "./repay.js";

const log = (s: string) => console.log(`[guardian] ${s}`);
const crit = (s: string) => console.error(`[guardian] 🚨 CRITICAL: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowUnix = () => Math.floor(Date.now() / 1000);

// Fallback reserve margin when the exact repay amount isn't present (it normally is).
const RESERVE_MARGIN_NUM = 115n;
const RESERVE_MARGIN_DEN = 100n;
// Per-loan repay OVERHEAD held back on top of each loan's gross repay: the x402
// build-repay payment (POST /api/v1/agent/build-repay = 0.002 SOL). Reserved once
// per open loan so N concurrent repays are all funded, not just one.
const X402_BUILD_REPAY_FEE_LAMPORTS = 2_000_000n;
const TIER_TERM_SECONDS: Record<TierName, number> = {
  express: 2 * 86400,
  quick: 3 * 86400,
  standard: 7 * 86400,
};

/** Normalized loan — what the guardian actually works with (SDK-shape-agnostic). */
interface NLoan {
  loanId: string;
  loanPda: string;
  collateralMint: string;
  repayLamports: bigint;
  borrowedLamports: bigint;
  dueUnix: number;
  startUnix: number;
  status: string;
}

/**
 * Read camelCase first, snake_case as fallback — robust to both SDK response
 * shapes. Typed shape-agnostic (Record) on purpose: the SDK's walletLoans()
 * return changed from LoanInfo (snake_case, 0.1.x) to AgentLoan (camelCase,
 * 0.2.x); norm reads every field dynamically via pick(), so it handles either
 * without depending on the exact SDK loan type.
 */
function norm(raw: Record<string, unknown>): NLoan {
  const o = raw;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (o[k] != null) return o[k];
    return undefined;
  };
  const big = (v: unknown): bigint => {
    try { return BigInt(String(v ?? "0")); } catch { return 0n; }
  };
  return {
    loanId: String(pick("loanId", "loan_id") ?? ""),
    loanPda: String(pick("loanPda", "loan_pda") ?? ""),
    collateralMint: String(pick("collateralMint", "collateral_mint") ?? ""),
    repayLamports: big(pick("repayAmountLamports", "repay_amount_lamports")),
    borrowedLamports: big(pick("loanAmountLamports", "borrowed_lamports", "borrowedLamports")),
    dueUnix: Number(pick("dueTimestampUnix", "due_at_unix", "dueAtUnix") ?? 0),
    startUnix: Number(pick("startTimestampUnix", "start_timestamp_unix") ?? 0),
    status: String(pick("status") ?? "active"),
  };
}

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
  /** loanId -> normalized loan we are responsible for. */
  private tracked = new Map<string, NLoan>();
  /**
   * loanIds with a repay loop currently in flight. The watcher runs on a
   * setInterval, and repayForever is an unbounded retry loop — without this
   * guard a single stuck repay would let each subsequent tick spawn ANOTHER
   * concurrent repay loop for the same loan, each paying the 0.002-SOL
   * build-repay x402 fee and broadcasting a duplicate repay tx. The guard
   * makes repay strictly one-loop-per-loan so a stuck loan bleeds nothing.
   */
  private repaying = new Set<string>();

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

  /** SOL we must keep to repay a loan: the EXACT on-chain repay, else principal + margin. */
  private repayReserveFor(l: NLoan): bigint {
    if (l.repayLamports > 0n) return l.repayLamports;
    return (l.borrowedLamports * RESERVE_MARGIN_NUM) / RESERVE_MARGIN_DEN;
  }

  reservedLamports(): bigint {
    // Base liquidity floor (gas/rent/priority) scales with the number of open
    // loans so N concurrent repay txs are each funded — a flat buffer would
    // under-reserve once MAX_OPEN_LOANS > 1. Plus the x402 build-repay fee per
    // loan, plus every loan's exact gross repay. At N=0 this is one gasBuffer;
    // at N=1 it adds a single 0.002-SOL repay fee (strictly safer than before).
    const n = BigInt(Math.max(1, this.tracked.size));
    let r = this.cfg.gasBufferLamports * n + BigInt(this.tracked.size) * X402_BUILD_REPAY_FEE_LAMPORTS;
    for (const l of this.tracked.values()) r += this.repayReserveFor(l);
    return r;
  }

  async deployableLamports(): Promise<bigint> {
    const free = (await this.liquidLamports()) - this.reservedLamports();
    return free > 0n ? free : 0n;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────
  async safeBorrow(opts: {
    collateralMint: string;
    collateralAmount: bigint | string;
  }): Promise<NLoan | null> {
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

    const loan = await this.findActiveLoan(res.loanId);
    if (!loan) {
      crit(`borrow ${res.loanId} confirmed but not found on read-back yet. Registering a conservative placeholder so it is reserved + counted even if the sync lags, then forcing a sync sweep.`);
      // PLACEHOLDER — borrow() returned a loanId, so a loan EXISTS on-chain, but the
      // read-back hasn't surfaced it. Track it NOW with a conservative reserve
      // (repayReserveFor falls back to borrowed × margin since repayLamports is
      // unknown) so (a) deployableLamports immediately holds back the repay reserve
      // and (b) tracked.size counts it — blocking a second borrow past maxOpenLoans —
      // even if findActiveLoan AND the self-heal tick BOTH lag. tick() later adopts
      // the real loan under the same loanId (Map.set overwrites — no double-count),
      // filling in loanPda/dueUnix so repayForever can act; until then the empty
      // loanPda keeps the placeholder reserved-but-not-(yet)-repaid.
      this.track({
        loanId: res.loanId,
        loanPda: "",
        collateralMint: opts.collateralMint,
        repayLamports: 0n,
        borrowedLamports: BigInt(res.borrowedLamports ?? 0),
        dueUnix: 0,
        startUnix: nowUnix(),
        status: "active",
      });
      await this.tick(); // self-heal: the sync adopts the real loan, overwriting the placeholder
      return null;
    }
    this.track(loan);

    const liquid = await this.liquidLamports();
    const reserve = this.repayReserveFor(loan);
    if (liquid < reserve) {
      crit(`under-reserved on loan ${loan.loanId}: hold ${liquid} lamports, need ${reserve}. Repaying immediately.`);
      await this.repayForever(loan);
      return null;
    }
    const hoursToDue = ((loan.dueUnix - nowUnix()) / 3600) | 0;
    log(`loan ${loan.loanId} tracked. owe ${(Number(reserve) / 1e9).toFixed(4)} SOL, due in ${hoursToDue}h, repays ~${(this.leadSeconds(loan) / 3600) | 0}h early.`);
    await this.notify?.send(
      "borrow",
      `Opened loan ${loan.loanId} vs ${loan.collateralMint.slice(0, 8)}… — owe ${(Number(reserve) / 1e9).toFixed(4)} SOL, due in ${hoursToDue}h; auto-repays ~${(this.leadSeconds(loan) / 3600) | 0}h early.`,
    );
    return loan;
  }

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
  async tick(): Promise<void> {
    let active: NLoan[];
    let complete: boolean;
    try {
      const r = await this.agent.walletLoans(this.self, { status: "active" });
      active = (r.loans as unknown as Record<string, unknown>[]).map(norm).filter((l) => l.status === "active" && l.loanId);
      // A non-empty `partial` map means a version lane errored — the active list
      // is INCOMPLETE this tick, so an absent tracked loan may just be unreadable.
      complete = Object.keys((r as { partial?: Record<string, unknown> }).partial ?? {}).length === 0;
    } catch (err) {
      log(`sync failed (will retry next tick): ${(err as Error).message}`);
      return;
    }

    const activeIds = new Set(active.map((l) => l.loanId));
    // NEVER drop a tracked loan on an incomplete read — abandoning a still-open
    // loan is the exact time-based default this guardian exists to prevent.
    // Reconcile deletions only on a fully-successful (complete) read.
    if (complete) {
      for (const id of [...this.tracked.keys()]) if (!activeIds.has(id)) this.tracked.delete(id);
    }
    for (const l of active) this.tracked.set(l.loanId, l);

    const now = nowUnix();
    for (const loan of active) {
      const repayAt = loan.dueUnix - this.leadSeconds(loan);
      if (now >= repayAt) {
        if (this.cfg.dryRun) {
          log(`DRY RUN — loan ${loan.loanId} is inside its repay window; would repay now (due in ${(loan.dueUnix - now) / 3600 | 0}h).`);
          continue;
        }
        // Fire-and-forget: repayForever is an unbounded retry loop and is
        // self-guarded against re-entry (this.repaying), so dispatching without
        // await means one stuck loan never blocks another loan's deadline check.
        void this.repayForever(loan);
      }
    }
  }

  // ── repay: never give up ──────────────────────────────────────────────────
  async repayForever(loan: NLoan): Promise<void> {
    if (!loan.loanPda) {
      crit(`loan ${loan.loanId} has no loanPda — cannot repay. Skipping (will re-evaluate next tick).`);
      return;
    }
    // Re-entrancy guard — at most one repay loop per loan, ever. A second caller
    // (the next interval tick, or the under-reserved path) returns immediately
    // instead of double-paying the build-repay fee / double-broadcasting.
    if (this.repaying.has(loan.loanId)) return;
    this.repaying.add(loan.loanId);
    try {
      await this.repayLoop(loan);
    } finally {
      this.repaying.delete(loan.loanId);
    }
  }

  private async repayLoop(loan: NLoan): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      // Partial-aware liveness: conclude a loan is gone ONLY on a COMPLETE read
      // showing it absent. A thrown or partial read = "unknown this attempt" →
      // keep trying; never delete (and stop repaying) a loan we couldn't fully read.
      const state = await this.readLoanState(loan.loanId).catch(() => ({ loan: undefined, complete: false }));
      if (!state.loan && state.complete && attempt > 1) {
        log(`loan ${loan.loanId} no longer active (confirmed by a complete read) — done.`);
        this.tracked.delete(loan.loanId);
        return;
      }

      const liquid = await this.liquidLamports().catch(() => 0n);
      if (liquid < this.repayReserveFor(loan)) {
        crit(`under-funded to repay ${loan.loanId} (have ${liquid}, need ${this.repayReserveFor(loan)}). Retrying — do not let this go overdue.`);
      }

      try {
        const res = await repayLoan(this.keypair, loan.loanPda, this.cfg);
        log(`✓ repaid loan ${loan.loanId} — tx ${res.signature}`);
        await this.notify?.send("repay", `Repaid loan ${loan.loanId} on time — tx ${res.signature}`);
        this.tracked.delete(loan.loanId);
        return;
      } catch (err) {
        const overdue = nowUnix() > loan.dueUnix;
        const msg = (err as Error).message;
        if (overdue) {
          crit(`repay attempt ${attempt} for OVERDUE loan ${loan.loanId} failed: ${msg}`);
          await this.notify?.send("error", `OVERDUE loan ${loan.loanId} repay attempt ${attempt} failed: ${msg} — retrying, will not stop.`);
        } else {
          log(`repay attempt ${attempt} for ${loan.loanId} failed (${isTransient(err) ? "transient" : "hard"}): ${msg}`);
        }
        await sleep(Math.min(60_000, 2_000 * attempt));
      }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private track(loan: NLoan): void {
    this.tracked.set(loan.loanId, loan);
  }

  /** Repay lead in seconds — derived from the loan's real term when present. */
  private leadSeconds(loan: NLoan): number {
    const term =
      loan.startUnix > 0 && loan.dueUnix > loan.startUnix
        ? loan.dueUnix - loan.startUnix
        : (TIER_TERM_SECONDS[this.cfg.tier] ?? TIER_TERM_SECONDS.standard);
    return Math.max(this.cfg.repayLeadSecondsMin, Math.floor(term * this.cfg.repayLeadFraction));
  }

  /**
   * Read a single loan's live state. `complete` is true ONLY when the wallet-loans
   * read succeeded across ALL version lanes (empty `partial` map). A loan missing
   * from an INCOMPLETE read means "unreadable this tick", NOT "gone" — never delete
   * on that basis, or a transient one-lane RPC blip would abandon a still-open loan
   * and let it default. (Audit 2026-06-20.)
   */
  private async readLoanState(loanId: string): Promise<{ loan?: NLoan; complete: boolean }> {
    const r = await this.agent.walletLoans(this.self, { status: "active" });
    const complete = Object.keys((r as { partial?: Record<string, unknown> }).partial ?? {}).length === 0;
    const loan = (r.loans as unknown as Record<string, unknown>[])
      .map(norm)
      .find((l) => l.loanId === loanId && l.status === "active");
    return { loan, complete };
  }

  private async findActiveLoan(loanId: string): Promise<NLoan | undefined> {
    return (await this.readLoanState(loanId)).loan;
  }

  /** For dashboards/logging. */
  openLoans(): NLoan[] {
    return [...this.tracked.values()];
  }
}
