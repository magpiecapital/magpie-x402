/**
 * @magpieloans/magpie-agent — the agent SDK for Magpie x402.
 *
 * Every action on the Magpie permissionless lending protocol as a
 * typed one-liner. Borrow, lend, liquidate, post conditional intents,
 * fetch credit scores. The first x402-native lending SDK on Solana.
 *
 *   import { MagpieAgent } from "@magpieloans/magpie-agent";
 *   import { Keypair } from "@solana/web3.js";
 *
 *   const agent = new MagpieAgent({ keypair, rpcUrl });
 *
 *   // Borrow SOL against any approved collateral:
 *   const loan = await agent.borrow({
 *     collateralMint: "9UuLs...pump",
 *     collateralAmount: 1_000_000_000n,   // raw u64
 *     tier: "express",
 *   });
 *
 *   // Deposit SOL into the LP for yield:
 *   await agent.deposit({ lamports: 100_000_000n });
 *
 *   // Liquidate a past-due loan:
 *   await agent.liquidate({ loanPda: "..." });
 *
 *   // Conditional borrow with webhook delivery:
 *   const intent = await agent.createIntent({
 *     collateralMint: "9UuLs...pump",
 *     collateralAmount: 1_000_000_000n,
 *     tier: "express",
 *     conditionType: "price_below",
 *     conditionParams: { priceUsd: "0.95", source: "jupiter" },
 *     webhookUrl: "https://my-agent.example/intent",
 *   });
 *   // Store intent.webhook.secret to verify the incoming POST later.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { freeGet, paidCall, X402Context, X402Error } from "./x402.js";
import { buildSignedEnvelope, buildManagementHeaders, signerFromKeypair } from "./envelope.js";
import type { MagpieSigner } from "./envelope.js";
import { sendAndConfirmRaw } from "./submit.js";

export { X402Error };
export { verifyWebhookSignature, IntentMatchedPayload } from "./webhooks.js";
export { buildSignedEnvelope, buildManagementHeaders, envelopeHeaders, SignedEnvelope } from "./envelope.js";
// External-signer surface — implement `MagpieSigner` for a Privy/Turnkey/SendAI
// BaseWallet (or wrap a raw Keypair with `signerFromKeypair`) and pass it as
// `new MagpieAgent({ signer })`.
export { signerFromKeypair } from "./envelope.js";
export type { MagpieSigner } from "./envelope.js";

const DEFAULT_BASE_URL = "https://x402.magpie.capital";
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const DEFAULT_SITE_URL = "https://www.magpie.capital";

// ── Tier index for the on-chain program ─────────────────────────────
// Names mirror what's visible to humans on the marketplace UI.
export type TierName = "express" | "quick" | "standard";
const TIER_INDEX: Record<TierName, 0 | 1 | 2> = {
  express: 0,
  quick: 1,
  standard: 2,
};

// ── Common response shapes ──────────────────────────────────────────

export interface PoolState {
  totalDeposits: number;
  totalBorrowed: number;
  totalShares: number;
  utilizationRate: number;
  protocolFeeBps: number;
  keeperRewardBps: number;
  paused: boolean;
}

/**
 * @deprecated Misleading and unused — NO method returns this snake_case shape.
 * Every loan-returning method (`loan`, `loanByPda`, `walletLoans`, `liquidatable`)
 * returns the camelCase {@link AgentLoan}. Use `AgentLoan` instead. Kept only so
 * existing imports don't break; will be removed in a future major.
 */
export interface LoanInfo {
  loan_pda: string;
  loan_id: string;
  borrower: string;
  collateral_mint: string;
  collateral_amount: string;
  borrowed_lamports: string;
  due_at_unix: number;
  status: "active" | "repaid" | "liquidated";
}

/** A loan decoded across V1/V3/V4 — tagged with its program version. */
export interface AgentLoan {
  programVersion: "v1" | "v3" | "v4";
  programId: string;
  loanPda: string;
  loanId: string;
  borrower: string;
  collateralMint: string;
  collateralAmount: string;
  loanAmountLamports: string;
  repayAmountLamports: string;
  ltvBps: number;
  durationDays: number;
  startTimestampUnix: number;
  dueTimestampUnix: number;
  status: "active" | "repaid" | "liquidated" | "unknown";
  /** 'memecoin' | 'rwa' — undefined on V1. */
  category?: "memecoin" | "rwa";
  /** In-vault auto-sell state — present only on V4 loans. */
  v4?: { currentCollateralAmount: string; solProceedsLamports: string; autoSellsFired: number };
  /** True only for V4 loans (the sole version that accepts exit orders). */
  exitsSupported: boolean;
}

/** Per-version error map returned when a multi-version read fails-soft. */
export type PartialVersions = Partial<Record<"v1" | "v3" | "v4", "error">>;

export interface ExitOrderResult {
  /** Raw bot response (order id, status, etc.). */
  order: Record<string, unknown>;
  feesPaidLamports: bigint;
}

export interface LpPosition {
  wallet: string;
  has_position: boolean;
  shares?: string;
  deposited_lamports?: string;
  current_value_lamports?: string;
  yield_lamports?: string;
  share_of_pool_pct?: number;
  pool: {
    total_deposits: number;
    total_shares: number;
    utilization_rate: number;
  } | null;
}

export interface BorrowQuote {
  tier: string;
  borrowableLamports: string;
  feeLamports: string;
  durationDays: number;
  ltvBps: number;
}

export interface BorrowResult {
  /** On-chain tx signature of the confirmed borrow. */
  signature: string;
  /** Loan ID assigned by the program. */
  loanId: string;
  /** Principal lamports the borrower received. */
  borrowedLamports: bigint;
  /** Total x402 + network fees paid in this round-trip. */
  feesPaidLamports: bigint;
}

export interface DepositResult {
  signature: string;
  depositedLamports: bigint;
  feesPaidLamports: bigint;
}

export interface WithdrawResult {
  signature: string;
  sharesRedeemed: bigint;
  projectedLamports: bigint;
  feesPaidLamports: bigint;
}

export interface LiquidateResult {
  signature: string;
  loanPda: string;
  collateralAmount: bigint;
  feesPaidLamports: bigint;
}

export interface RepayResult {
  /** On-chain tx signature of the confirmed repay. */
  signature: string;
  /** The loan PDA that was repaid and closed. */
  loanPda: string;
  /** Total x402 + network fees paid in this round-trip. */
  feesPaidLamports: bigint;
}

export interface IntentResult {
  intentId: string;
  status: "pending" | "matched" | "expired" | "cancelled";
  expiresAt: string;
  webhook?: {
    url: string;
    secret: string;
    signatureHeader: "X-Magpie-Signature";
    signatureAlg: "HMAC-SHA256";
  };
  feesPaidLamports: bigint;
}

export interface MagpieAgentOptions {
  /**
   * The agent's signing keypair (back-compat path; the SDK signs locally).
   * Provide EITHER this OR `signer`. Required for paid actions if `signer`
   * is not given.
   */
  keypair?: Keypair;
  /**
   * An external signer — Privy / Turnkey / embedded / SendAI BaseWallet, or
   * anything implementing { publicKey, signTransaction, signMessage }. Use this
   * when the agent's key lives in a wallet service and a raw Keypair is never
   * available. Takes precedence over `keypair`. The SDK never sees the secret key.
   */
  signer?: MagpieSigner;
  /** Solana RPC URL. Defaults to the public mainnet endpoint (rate-limited). */
  rpcUrl?: string;
  /** Magpie x402 service URL. Defaults to x402.magpie.capital. */
  baseUrl?: string;
  /** Magpie cosign endpoint host. Defaults to magpie.capital. */
  siteUrl?: string;
}

// ── Main SDK class ──────────────────────────────────────────────────

/**
 * MagpieAgent — every action on the protocol as a typed method.
 *
 * The class is intentionally stateless beyond its config; create one
 * per agent / per keypair. Methods are safe to call concurrently
 * (each does its own RPC + payment).
 */
export class MagpieAgent {
  private readonly signer?: MagpieSigner;
  private readonly siteUrl: string;
  private readonly ctx: X402Context;

  constructor(opts: MagpieAgentOptions = {}) {
    // `signer` (external wallet) wins; otherwise adapt a raw Keypair. Either
    // way the rest of the SDK only ever touches the MagpieSigner abstraction —
    // it never reaches for a secret key.
    this.signer = opts.signer ?? (opts.keypair ? signerFromKeypair(opts.keypair) : undefined);
    this.siteUrl = (opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/$/, "");
    this.ctx = {
      baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      rpcUrl: opts.rpcUrl ?? DEFAULT_RPC_URL,
      signer: this.signer,
    };
  }

  /** Returns the public key of the configured signer (if any). */
  publicKey(): PublicKey | undefined {
    return this.signer?.publicKey;
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /** Live LendingPool state — TVL, utilization, fees earned, etc. Free. */
  async poolState(): Promise<PoolState> {
    return freeGet(this.ctx, "/api/v1/pool");
  }

  /** All three strategy pools (V1/V3/V4) in one call. Free. */
  async pools(): Promise<{ pools: Record<string, PoolState>; partial: PartialVersions }> {
    return freeGet(this.ctx, "/api/v1/pools");
  }

  /**
   * Fetch a single loan by its PDA — unambiguous, routed to V1/V3/V4 from the
   * on-chain owner. Returns program_version + (V4) exit state + exits_supported.
   * Free.
   */
  async loanByPda(
    loanPda: PublicKey | string,
  ): Promise<AgentLoan & { exits_supported: boolean; exit_ineligibility_reason: string | null }> {
    const p = typeof loanPda === "string" ? loanPda : loanPda.toBase58();
    return freeGet(this.ctx, `/api/v1/loan/by-pda/${encodeURIComponent(p)}`);
  }

  /**
   * Find loans by borrower + loan_id across V1/V3/V4. Returns a LIST — a
   * borrower can hold the same numeric loan_id in more than one program, so
   * borrower is required to derive the PDA. Free.
   */
  async loan(
    loanId: string | bigint,
    borrower: PublicKey | string,
  ): Promise<{ count: number; partial: PartialVersions; loans: AgentLoan[] }> {
    const b = typeof borrower === "string" ? borrower : borrower.toBase58();
    return freeGet(this.ctx, `/api/v1/loan/${encodeURIComponent(String(loanId))}`, { borrower: b });
  }

  /** Every loan a wallet holds across V1/V3/V4, tagged with program_version. Free. */
  async walletLoans(
    wallet: PublicKey | string,
    opts: { status?: "active" | "repaid" | "liquidated" } = {},
  ): Promise<{ count: number; by_version: Record<string, number>; partial: PartialVersions; loans: AgentLoan[] }> {
    const w = typeof wallet === "string" ? wallet : wallet.toBase58();
    const query: Record<string, string> = {};
    if (opts.status) query.status = opts.status;
    return freeGet(this.ctx, `/api/v1/wallet/${encodeURIComponent(w)}/loans`, query);
  }

  /** Quote a borrow without paying — pure math from public tier constants. Free. */
  async simulateBorrow(opts: {
    collateralMint: PublicKey | string;
    collateralAmount: bigint | string;
    decimals: number;
    pricePerTokenUsd: number | string;
    solPriceUsd: number | string;
    tier?: TierName | "all";
  }): Promise<{ tier: string; quotes?: BorrowQuote[] } | BorrowQuote> {
    const mint =
      typeof opts.collateralMint === "string"
        ? opts.collateralMint
        : opts.collateralMint.toBase58();
    return freeGet(this.ctx, "/api/v1/simulate-borrow", {
      mint,
      amount: String(opts.collateralAmount),
      decimals: String(opts.decimals),
      pricePerTokenUsd: String(opts.pricePerTokenUsd),
      solPriceUsd: String(opts.solPriceUsd),
      tier: opts.tier ?? "all",
    });
  }

  /** Catalog of every approved collateral token. Free. */
  async collateralCatalog(): Promise<{ tokens: Array<{ mint: string; symbol: string; decimals: number; category: string }> }> {
    return freeGet(this.ctx, "/api/v1/collateral/eligible");
  }

  /**
   * Past-due active loans across V1/V3 (and V4 if includeV4) — the canonical
   * liquidation-bot feed, each tagged with program_version. V4 loans auto-sell
   * in-vault so they're excluded unless you opt in. Free.
   */
  async liquidatable(
    opts: { withinSeconds?: number; limit?: number; includeV4?: boolean } = {},
  ): Promise<{
    eligible_count: number;
    returned_count: number;
    partial: PartialVersions;
    loans: Array<AgentLoan & { secondsPastDue: number }>;
  }> {
    const query: Record<string, string> = {};
    if (opts.withinSeconds !== undefined) query.within_seconds = String(opts.withinSeconds);
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    if (opts.includeV4) query.include_v4 = "true";
    return freeGet(this.ctx, "/api/v1/markets/liquidatable", query);
  }

  /** Read a wallet's LP position. Free. */
  async lpPosition(wallet: PublicKey | string = this.requireSelf()): Promise<LpPosition> {
    const w = typeof wallet === "string" ? wallet : wallet.toBase58();
    return freeGet(this.ctx, "/api/v1/agent/lp-state", { wallet: w });
  }

  /** Magpie credit score for a wallet. Paid: 0.001 SOL. */
  async creditScore(wallet: PublicKey | string = this.requireSelf()): Promise<{
    wallet: string;
    score: number;
    tier: string;
    range: { min: number; max: number };
    benefits: { maxLtvPercent: number; minFeeRate: number; maxDurationDays: number };
  }> {
    const w = typeof wallet === "string" ? wallet : wallet.toBase58();
    const r = await paidCall<{
      wallet: string;
      score: number;
      tier: string;
      range: { min: number; max: number };
      benefits: { maxLtvPercent: number; minFeeRate: number; maxDurationDays: number };
    }>(this.ctx, "GET", "/api/v1/credit-score", { query: { wallet: w } });
    return r.data;
  }

  /** Per-token risk profile for collateral selection. Paid: 0.001 SOL. */
  async tokenRisk(mint: PublicKey | string): Promise<{
    mint: string;
    symbol: string;
    risk_score: number;
    dimensions: Record<string, number>;
    market_data: { liquidity_usd: number; volume_24h_usd: number; market_cap_usd: number };
    lending_impact: { max_allowed_ltv: number };
    flagged: boolean;
  }> {
    const m = typeof mint === "string" ? mint : mint.toBase58();
    const r = await paidCall<any>(this.ctx, "GET", "/api/v1/agent/token-risk", {
      query: { mint: m },
    });
    return r.data;
  }

  // ── Writes — agent transacts on the protocol ───────────────────────

  /**
   * Borrow SOL against a token you hold.
   *
   * Full flow in one call: build-borrow (0.005 SOL) → sign locally →
   * submit to cosign-borrow → wait for confirmation → return.
   */
  async borrow(opts: {
    collateralMint: PublicKey | string;
    collateralAmount: bigint | string;
    tier: TierName;
    /**
     * Open on the V4 in-vault program so you can arm exit orders (TP/SL) on
     * this loan afterward via armExit(). Default false (V1 memecoin / V3 RWA).
     */
    hasExitArming?: boolean;
  }): Promise<BorrowResult> {
    const keypair = this.requireSigner("borrow");
    const mint =
      typeof opts.collateralMint === "string"
        ? opts.collateralMint
        : opts.collateralMint.toBase58();
    const built = await paidCall<{
      partial_signed_tx_b64: string;
      summary: { loanId: string; borrowableLamports: string; feeLamports: string };
      next_step: { url: string };
    }>(this.ctx, "POST", "/api/v1/agent/build-borrow", {
      body: {
        borrower_wallet: keypair.publicKey.toBase58(),
        collateral_mint: mint,
        collateral_amount: String(opts.collateralAmount),
        tier: TIER_INDEX[opts.tier],
        has_exit_arming: opts.hasExitArming === true,
      },
    });

    const tx = Transaction.from(Buffer.from(built.data.partial_signed_tx_b64, "base64"));
    const signedTx = await keypair.signTransaction(tx);
    const signedB64 = signedTx.serialize({ requireAllSignatures: false }).toString("base64");

    // Validate the cosign URL origin BEFORE posting the signed tx
    // bytes. The x402 service returns next_step.url; if x402 were
    // compromised, an attacker could redirect this POST to a host
    // they control and harvest the signature. We accept only URLs
    // whose origin matches the configured siteUrl (default
    // magpie.capital) — never a third-party URL.
    const proposedCosignUrl =
      built.data.next_step?.url ?? `${this.siteUrl}/api/v1/cosign-borrow`;
    const cosignUrl = this.validateCosignUrl(proposedCosignUrl);

    const cosignRes = await fetch(cosignUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signed_tx_b64: signedB64 }),
    });
    const cosign = (await cosignRes.json()) as { signature?: string; error?: string };
    if (!cosign.signature) {
      throw new X402Error(
        `Cosign-borrow failed: ${cosign.error ?? "unknown error"}`,
        cosignRes.status,
        cosign,
      );
    }

    return {
      signature: cosign.signature,
      loanId: built.data.summary.loanId,
      borrowedLamports: BigInt(built.data.summary.borrowableLamports),
      feesPaidLamports: built.paid?.amountLamports ?? 0n,
    };
  }

  /**
   * Deposit SOL into the LendingPool as a liquidity provider.
   *
   * Full flow in one call: build-deposit (0.002 SOL) → sign locally →
   * submit → wait for confirmation → return.
   */
  async deposit(opts: { lamports: bigint | string | number }): Promise<DepositResult> {
    const keypair = this.requireSigner("deposit");
    const lamports = BigInt(opts.lamports);
    const built = await paidCall<{
      partial_signed_tx_b64: string;
      summary: { lamports: string };
    }>(this.ctx, "POST", "/api/v1/agent/build-deposit", {
      body: {
        depositor: keypair.publicKey.toBase58(),
        lamports: lamports.toString(),
      },
    });
    const sig = await this.signAndSubmit(built.data.partial_signed_tx_b64, keypair);
    return {
      signature: sig,
      depositedLamports: lamports,
      feesPaidLamports: built.paid?.amountLamports ?? 0n,
    };
  }

  /**
   * Withdraw LP shares back to SOL.
   *
   * Server pre-validates the on-chain position and refuses unsafe
   * chunk sizes (against the v1 program's u64 overflow). For huge
   * positions, call withdraw() repeatedly with chunks <= the
   * max_safe_shares the server returns.
   */
  async withdraw(opts: { shares: bigint | string }): Promise<WithdrawResult> {
    const keypair = this.requireSigner("withdraw");
    const shares = BigInt(opts.shares);
    const built = await paidCall<{
      partial_signed_tx_b64: string;
      summary: { shares: string; projected_lamports: string };
    }>(this.ctx, "POST", "/api/v1/agent/build-withdraw", {
      body: {
        depositor: keypair.publicKey.toBase58(),
        shares: shares.toString(),
      },
    });
    const sig = await this.signAndSubmit(built.data.partial_signed_tx_b64, keypair);
    return {
      signature: sig,
      sharesRedeemed: shares,
      projectedLamports: BigInt(built.data.summary.projected_lamports),
      feesPaidLamports: built.paid?.amountLamports ?? 0n,
    };
  }

  /**
   * Liquidate a past-due active loan. Permissionless — your keypair
   * becomes the keeper and receives the bounty share of the seized
   * collateral.
   *
   * Discover targets via `liquidatable()`.
   */
  async liquidate(opts: { loanPda: PublicKey | string }): Promise<LiquidateResult> {
    const keypair = this.requireSigner("liquidate");
    const loanPda =
      typeof opts.loanPda === "string" ? opts.loanPda : opts.loanPda.toBase58();
    const built = await paidCall<{
      partial_signed_tx_b64: string;
      summary: { collateral_amount_raw: string };
    }>(this.ctx, "POST", "/api/v1/agent/build-liquidate", {
      body: { keeper: keypair.publicKey.toBase58(), loan_pda: loanPda },
    });
    const sig = await this.signAndSubmit(built.data.partial_signed_tx_b64, keypair);
    return {
      signature: sig,
      loanPda,
      collateralAmount: BigInt(built.data.summary.collateral_amount_raw),
      feesPaidLamports: built.paid?.amountLamports ?? 0n,
    };
  }

  /**
   * Repay an active loan in full and close it. Borrower-signed and fully
   * non-custodial: the service builds an UNSIGNED repay tx (pre-simulated
   * server-side so a doomed repay is never returned for signing), your
   * keypair signs it LOCALLY, and it submits via standard RPC. The on-chain
   * `repay_loan` instruction needs only the borrower's signature — Magpie
   * never co-signs or repays on your behalf.
   *
   * This is the only path that returns your collateral TO YOU. (A past-due
   * loan can alternatively be closed by a permissionless keeper `liquidate()`,
   * which seizes collateral without the borrower.)
   *
   * Paid: 0.002 SOL (the build-repay call). Discover your loan PDAs via
   * `walletLoans()`.
   */
  async repay(opts: { loanPda: PublicKey | string }): Promise<RepayResult> {
    const keypair = this.requireSigner("repay");
    const loanPda =
      typeof opts.loanPda === "string" ? opts.loanPda : opts.loanPda.toBase58();
    const built = await paidCall<{
      partial_signed_tx_b64: string;
    }>(this.ctx, "POST", "/api/v1/agent/build-repay", {
      body: { borrower_wallet: keypair.publicKey.toBase58(), loan_pda: loanPda },
    });
    const sig = await this.signAndSubmit(built.data.partial_signed_tx_b64, keypair);
    return {
      signature: sig,
      loanPda,
      feesPaidLamports: built.paid?.amountLamports ?? 0n,
    };
  }

  /**
   * Post a conditional borrow intent. Bot watches the trigger and
   * builds the unsigned tx when matched. Optional webhook URL gets
   * an HMAC-signed POST on match (zero polling required).
   *
   * Returned webhook secret is only available HERE — persist it to
   * verify incoming webhook POSTs.
   */
  async createIntent(opts: {
    collateralMint: PublicKey | string;
    collateralAmount: bigint | string;
    tier: TierName;
    conditionType: "price_above" | "price_below" | "time_after" | "pool_liq_above";
    conditionParams: Record<string, unknown>;
    expiresInSeconds?: number;
    webhookUrl?: string;
  }): Promise<IntentResult> {
    const keypair = this.requireSigner("createIntent");
    const mint =
      typeof opts.collateralMint === "string"
        ? opts.collateralMint
        : opts.collateralMint.toBase58();
    const body: Record<string, unknown> = {
      borrower_wallet: keypair.publicKey.toBase58(),
      collateral_mint: mint,
      collateral_amount: String(opts.collateralAmount),
      tier: TIER_INDEX[opts.tier],
      condition_type: opts.conditionType,
      condition_params: opts.conditionParams,
      expires_in_seconds: opts.expiresInSeconds ?? 86400,
    };
    if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;
    const r = await paidCall<{
      intent_id: string;
      status: "pending";
      expires_at: string;
      webhook?: {
        url: string;
        secret: string;
        signature_header: "X-Magpie-Signature";
        signature_alg: "HMAC-SHA256";
      };
    }>(this.ctx, "POST", "/api/v1/agent/intent", { body });
    return {
      intentId: r.data.intent_id,
      status: r.data.status,
      expiresAt: r.data.expires_at,
      webhook: r.data.webhook
        ? {
            url: r.data.webhook.url,
            secret: r.data.webhook.secret,
            signatureHeader: r.data.webhook.signature_header,
            signatureAlg: r.data.webhook.signature_alg,
          }
        : undefined,
      feesPaidLamports: r.paid?.amountLamports ?? 0n,
    };
  }

  /** Poll the status of an intent. Paid: 0.0005 SOL per poll. */
  async getIntent(intentId: string): Promise<{
    intentId: string;
    status: "pending" | "matched" | "expired" | "cancelled";
    partialSignedTxB64?: string;
    summary?: Record<string, unknown>;
  }> {
    const r = await paidCall<{
      intent_id: string;
      status: "pending" | "matched" | "expired" | "cancelled";
      partial_signed_tx_b64?: string;
      summary?: Record<string, unknown>;
    }>(this.ctx, "GET", "/api/v1/agent/intent", { query: { id: intentId } });
    return {
      intentId: r.data.intent_id,
      status: r.data.status,
      partialSignedTxB64: r.data.partial_signed_tx_b64,
      summary: r.data.summary,
    };
  }

  /**
   * Cancel a pending intent on your OWN wallet. Free. Signs an
   * "intent-cancel/v1" Ed25519 envelope bound to the intent id — the service
   * verifies the signature and the bot scopes the cancel to the signer's
   * wallet, so a leaked intent id alone can never cancel your intent.
   */
  async cancelIntent(intentId: string): Promise<void> {
    const keypair = this.requireSigner("cancelIntent");
    await paidCall(this.ctx, "DELETE", "/api/v1/agent/intent", {
      query: { id: intentId },
      headers: await buildManagementHeaders(keypair, "intent-cancel/v1", intentId),
    });
  }

  // ── Exit orders — arm in-vault TP/SL on your OWN V4 loan ────────────
  //
  // These require a V4 loan (open one with borrow({ ..., hasExitArming: true })).
  // The SDK signs an Ed25519 envelope with your keypair and the x402 service
  // forwards it to the bot, which enforces ownership + V4-only. Self-custody:
  // no Telegram, no delegation, no custodial key.

  /**
   * Arm an in-vault take-profit / stop-loss on your own V4 loan. Paid: 0.001 SOL.
   *
   * Supply exactly one trigger: `target` ("2x" for TP, "0.7x" for SL),
   * `priceUsd`, `mcUsd` ("5M"/"1.2B"), or `trailingBps` (SL only). `direction`
   * defaults to "above" (take-profit); use "below" for a stop-loss.
   */
  async armExit(opts: {
    loanId: string | bigint;
    direction?: "above" | "below";
    target?: string;
    priceUsd?: number | string;
    mcUsd?: string;
    trailingBps?: number;
    slippageBps?: number;
    dest?: "sol" | "usdc";
    slice?: string;
  }): Promise<ExitOrderResult> {
    const keypair = this.requireSigner("armExit");
    if (
      opts.target === undefined &&
      opts.priceUsd === undefined &&
      opts.mcUsd === undefined &&
      opts.trailingBps === undefined
    ) {
      throw new Error("armExit: supply one of target, priceUsd, mcUsd, or trailingBps.");
    }
    const env = await buildSignedEnvelope(keypair, "limit-close-arm/v1", {
      LoanId: String(opts.loanId),
      Direction: opts.direction,
      Target: opts.target,
      Price: opts.priceUsd,
      MC: opts.mcUsd,
      Trailing: opts.trailingBps,
      Slippage: opts.slippageBps,
      Slice: opts.slice,
      Dest: opts.dest,
    });
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/self-limit-close/arm",
      { body: env },
    );
    return { order: r.data, feesPaidLamports: r.paid?.amountLamports ?? 0n };
  }

  /** Modify an armed exit on your own loan (no re-pay). Free. */
  async modifyExit(opts: {
    orderId: string;
    priceUsd?: number | string;
    mcUsd?: string;
    target?: string;
    slippageBps?: number;
    dest?: "sol" | "usdc";
    trailingBps?: number;
  }): Promise<ExitOrderResult> {
    const keypair = this.requireSigner("modifyExit");
    const env = await buildSignedEnvelope(keypair, "limit-close-modify/v1", {
      OrderId: opts.orderId,
      Price: opts.priceUsd,
      MC: opts.mcUsd,
      Target: opts.target,
      Slippage: opts.slippageBps,
      Dest: opts.dest,
      Trailing: opts.trailingBps,
    });
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/self-limit-close/modify",
      { body: env },
    );
    return { order: r.data, feesPaidLamports: r.paid?.amountLamports ?? 0n };
  }

  /** Cancel an armed exit on your own loan. Free. */
  async cancelExit(orderId: string): Promise<ExitOrderResult> {
    const keypair = this.requireSigner("cancelExit");
    const env = await buildSignedEnvelope(keypair, "limit-close-cancel/v1", { OrderId: orderId });
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/self-limit-close/cancel",
      { body: env },
    );
    return { order: r.data, feesPaidLamports: r.paid?.amountLamports ?? 0n };
  }

  /** List your armed exit orders. Free. */
  async listExits(
    wallet: PublicKey | string = this.requireSelf(),
  ): Promise<{ orders: unknown[] }> {
    const w = typeof wallet === "string" ? wallet : wallet.toBase58();
    return freeGet(this.ctx, "/api/v1/agent/self-limit-close/list", { wallet: w });
  }

  // ── Delegated exit orders — manage exits on ANOTHER wallet's loan ───
  //
  // These act on a BORROWER's loan that pre-authorized this agent off-band
  // (TG /agent-authorize <agent_pubkey> limit_close). The x402 service used
  // to trust a self-asserted X-Agent-Pubkey header here — meaning anyone
  // could pass another agent's (public) pubkey to cancel / modify /
  // enumerate that agent's armed orders, silently disarming a borrower's
  // stop-loss (audit 2026-06-21, HIGH). Now every delegated management call
  // is authenticated by an Ed25519-signed envelope sent in the three
  // X-Magpie-Env-* headers: the service verifies the signature and uses the
  // VERIFIED signer as the agent identity. These methods sign that envelope
  // with the agent keypair so legitimate agents keep working. The paid
  // delegated arm (armDelegatedExit) keeps its x402-payer binding and does
  // not need a management envelope.

  /**
   * Arm a delegated limit-close order on a borrower's loan you've been
   * authorized for (TG /agent-authorize). Paid: 0.001 SOL. The x402 payer
   * (your keypair) is the agent identity; the bot enforces the delegation.
   */
  async armDelegatedExit(opts: {
    userWallet: PublicKey | string;
    loanId: string | bigint;
    triggerKind: "mc_usd" | "price_usd" | "price_sol";
    triggerValueMicro: string | bigint;
    slippageBps: number;
    triggerDirection?: "above" | "below";
    sellDestination?: "sol" | "usdc";
    expiresAt?: string | null;
    autoEscalateSlippage?: boolean;
  }): Promise<ExitOrderResult> {
    this.requireSigner("armDelegatedExit");
    const userWallet =
      typeof opts.userWallet === "string" ? opts.userWallet : opts.userWallet.toBase58();
    const body: Record<string, unknown> = {
      user_wallet: userWallet,
      loan_id: String(opts.loanId),
      trigger_kind: opts.triggerKind,
      trigger_value_micro: String(opts.triggerValueMicro),
      slippage_bps: opts.slippageBps,
    };
    if (opts.triggerDirection !== undefined) body.trigger_direction = opts.triggerDirection;
    if (opts.sellDestination !== undefined) body.sell_destination = opts.sellDestination;
    if (opts.expiresAt !== undefined) body.expires_at = opts.expiresAt;
    if (opts.autoEscalateSlippage !== undefined) body.auto_escalate_slippage = opts.autoEscalateSlippage;
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/limit-close",
      { body },
    );
    return { order: r.data, feesPaidLamports: r.paid?.amountLamports ?? 0n };
  }

  /**
   * Preflight a delegated arm — "would this arm succeed?" — without paying.
   * Free. Signs a "limit-close-preflight/v1" envelope (no OrderId).
   */
  async preflightDelegatedExit(opts: {
    userWallet: PublicKey | string;
    loanId: string | bigint;
    triggerKind: "mc_usd" | "price_usd" | "price_sol";
    triggerValueMicro: string | bigint;
    slippageBps: number;
    triggerDirection?: "above" | "below";
    sellDestination?: "sol" | "usdc";
    expiresAt?: string | null;
    autoEscalateSlippage?: boolean;
  }): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("preflightDelegatedExit");
    const userWallet =
      typeof opts.userWallet === "string" ? opts.userWallet : opts.userWallet.toBase58();
    const body: Record<string, unknown> = {
      user_wallet: userWallet,
      loan_id: String(opts.loanId),
      trigger_kind: opts.triggerKind,
      trigger_value_micro: String(opts.triggerValueMicro),
      slippage_bps: opts.slippageBps,
    };
    if (opts.triggerDirection !== undefined) body.trigger_direction = opts.triggerDirection;
    if (opts.sellDestination !== undefined) body.sell_destination = opts.sellDestination;
    if (opts.expiresAt !== undefined) body.expires_at = opts.expiresAt;
    if (opts.autoEscalateSlippage !== undefined) body.auto_escalate_slippage = opts.autoEscalateSlippage;
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/limit-close/preflight",
      { body, headers: await buildManagementHeaders(keypair, "limit-close-preflight/v1") },
    );
    return r.data;
  }

  /**
   * Read one delegated order by id. Free. Signs a "limit-close-get/v1"
   * envelope bound to the order id.
   */
  async getDelegatedExit(orderId: string): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("getDelegatedExit");
    return freeGet(
      this.ctx,
      "/api/v1/agent/limit-close",
      { id: orderId },
      await buildManagementHeaders(keypair, "limit-close-get/v1", orderId),
    );
  }

  /**
   * List your delegated orders. Free. Signs a "limit-close-list/v1"
   * envelope. `status: "all"` includes terminal orders (default armed-only).
   */
  async listDelegatedExits(opts: { status?: "armed" | "all" } = {}): Promise<{ orders: unknown[] }> {
    const keypair = this.requireSigner("listDelegatedExits");
    const query: Record<string, string> = {};
    if (opts.status === "all") query.status = "all";
    return freeGet(
      this.ctx,
      "/api/v1/agent/limit-close/list",
      query,
      await buildManagementHeaders(keypair, "limit-close-list/v1"),
    );
  }

  /**
   * Discover what borrowers/bounds this agent is authorized for. Free.
   * Signs a "limit-close-delegations/v1" envelope.
   */
  async listDelegations(): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("listDelegations");
    return freeGet(
      this.ctx,
      "/api/v1/agent/limit-close/delegations",
      {},
      await buildManagementHeaders(keypair, "limit-close-delegations/v1"),
    );
  }

  /**
   * The agent's full actionable surface — every delegated (wallet, loan)
   * with explicit per-loan eligibility. Free. Signs a
   * "limit-close-eligible/v1" envelope.
   */
  async eligibleLoans(): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("eligibleLoans");
    return freeGet(
      this.ctx,
      "/api/v1/agent/limit-close/eligible-loans",
      {},
      await buildManagementHeaders(keypair, "limit-close-eligible/v1"),
    );
  }

  /**
   * Modify a delegated armed order in place (no re-pay). Free. Signs a
   * "limit-close-modify/v1" envelope bound to the order id.
   */
  async modifyDelegatedExit(opts: {
    orderId: string;
    triggerValueMicro?: string | bigint;
    slippageBps?: number;
    sellDestination?: "sol" | "usdc";
    expiresAt?: string | null;
  }): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("modifyDelegatedExit");
    const body: Record<string, unknown> = { id: opts.orderId };
    if (opts.triggerValueMicro !== undefined) body.trigger_value_micro = String(opts.triggerValueMicro);
    if (opts.slippageBps !== undefined) body.slippage_bps = opts.slippageBps;
    if (opts.sellDestination !== undefined) body.sell_destination = opts.sellDestination;
    if (opts.expiresAt !== undefined) body.expires_at = opts.expiresAt;
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "POST",
      "/api/v1/agent/limit-close/modify",
      { body, headers: await buildManagementHeaders(keypair, "limit-close-modify/v1", opts.orderId) },
    );
    return r.data;
  }

  /**
   * Cancel a delegated armed order. Free. Signs a "limit-close-cancel/v1"
   * envelope bound to the order id — the highest-impact route (a forged
   * identity here would silently disarm a borrower's stop-loss).
   */
  async cancelDelegatedExit(orderId: string): Promise<Record<string, unknown>> {
    const keypair = this.requireSigner("cancelDelegatedExit");
    const r = await paidCall<Record<string, unknown>>(
      this.ctx,
      "DELETE",
      "/api/v1/agent/limit-close",
      { query: { id: orderId }, headers: await buildManagementHeaders(keypair, "limit-close-cancel/v1", orderId) },
    );
    return r.data;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async signAndSubmit(partialTxB64: string, signer: MagpieSigner): Promise<string> {
    const tx = Transaction.from(Buffer.from(partialTxB64, "base64"));
    const signedTx = await signer.signTransaction(tx);
    const connection = new Connection(this.ctx.rpcUrl, "confirmed");
    // Dedupe-safe re-broadcast + bounded, structured confirmation (replaces a
    // single send + deprecated signature-only confirm). Throws a RETRYABLE
    // X402Error on confirm-timeout (blockhash expiry) so the caller can rebuild
    // + resubmit, and a non-retryable one on an on-chain failure.
    return await sendAndConfirmRaw(connection, signedTx.serialize());
  }

  private requireSigner(action: string): MagpieSigner {
    if (!this.signer) {
      throw new Error(
        `MagpieAgent.${action}() requires a signer. Construct with { keypair } or { signer }.`,
      );
    }
    return this.signer;
  }

  private requireSelf(): string {
    if (!this.signer) {
      throw new Error(
        "No default wallet — pass an explicit wallet pubkey or construct MagpieAgent with a keypair or signer.",
      );
    }
    return this.signer.publicKey.toBase58();
  }

  /**
   * Validate that a cosign-borrow URL handed to us by the x402 service
   * actually lives on our trusted host. Defends against a malicious
   * x402 response redirecting the signed tx to an attacker.
   *
   * The signed tx contains the borrower's signature; if it landed on a
   * hostile host, the attacker could relay it through any cosigner of
   * their choice and capture the resulting on-chain SOL transfer.
   */
  private validateCosignUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new X402Error(
        `Invalid cosign URL returned by x402: ${url.slice(0, 100)}`,
        500,
        null,
      );
    }
    const siteOrigin = new URL(this.siteUrl).origin;
    if (parsed.origin !== siteOrigin) {
      throw new X402Error(
        `Refusing to post signed tx to non-Magpie origin (got ${parsed.origin}, expected ${siteOrigin}). ` +
          `This may indicate a compromised x402 service.`,
        500,
        null,
      );
    }
    return parsed.toString();
  }
}
