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

export { X402Error };
export { verifyWebhookSignature, IntentMatchedPayload } from "./webhooks.js";

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
  /** The agent's signing keypair. Required for paid actions. */
  keypair?: Keypair;
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
  private readonly keypair?: Keypair;
  private readonly siteUrl: string;
  private readonly ctx: X402Context;

  constructor(opts: MagpieAgentOptions = {}) {
    this.keypair = opts.keypair;
    this.siteUrl = (opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/$/, "");
    this.ctx = {
      baseUrl: (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
      rpcUrl: opts.rpcUrl ?? DEFAULT_RPC_URL,
      payer: this.keypair,
    };
  }

  /** Returns the public key of the configured keypair (if any). */
  publicKey(): PublicKey | undefined {
    return this.keypair?.publicKey;
  }

  // ── Reads ──────────────────────────────────────────────────────────

  /** Live LendingPool state — TVL, utilization, fees earned, etc. Free. */
  async poolState(): Promise<PoolState> {
    return freeGet(this.ctx, "/api/v1/pool");
  }

  /** Fetch a single loan by its u64 ID. Free. */
  async loan(loanId: string | bigint): Promise<LoanInfo> {
    return freeGet(this.ctx, `/api/v1/loan/${encodeURIComponent(String(loanId))}`);
  }

  /** Every loan opened by a wallet — active, repaid, liquidated. Free. */
  async walletLoans(
    wallet: PublicKey | string,
    opts: { status?: "active" | "repaid" | "liquidated" } = {},
  ): Promise<{ loans: LoanInfo[] }> {
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

  /** Past-due active loans — the canonical liquidation-bot feed. Free. */
  async liquidatable(opts: { withinSeconds?: number; limit?: number } = {}): Promise<{
    liquidatable: Array<LoanInfo & { seconds_past_due: number }>;
    total: number;
  }> {
    const query: Record<string, string> = {};
    if (opts.withinSeconds !== undefined) query.within_seconds = String(opts.withinSeconds);
    if (opts.limit !== undefined) query.limit = String(opts.limit);
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
  }): Promise<BorrowResult> {
    const keypair = this.requireKeypair("borrow");
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
      },
    });

    const tx = Transaction.from(Buffer.from(built.data.partial_signed_tx_b64, "base64"));
    tx.partialSign(keypair);
    const signedB64 = tx.serialize({ requireAllSignatures: false }).toString("base64");

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
    const keypair = this.requireKeypair("deposit");
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
    const keypair = this.requireKeypair("withdraw");
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
    const keypair = this.requireKeypair("liquidate");
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
    const keypair = this.requireKeypair("createIntent");
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

  /** Cancel a pending intent. Free. */
  async cancelIntent(intentId: string): Promise<void> {
    await paidCall(this.ctx, "DELETE", "/api/v1/agent/intent", {
      query: { id: intentId },
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private async signAndSubmit(partialTxB64: string, keypair: Keypair): Promise<string> {
    const tx = Transaction.from(Buffer.from(partialTxB64, "base64"));
    tx.partialSign(keypair);
    const connection = new Connection(this.ctx.rpcUrl, "confirmed");
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  private requireKeypair(action: string): Keypair {
    if (!this.keypair) {
      throw new Error(
        `MagpieAgent.${action}() requires a keypair. Construct with { keypair }.`,
      );
    }
    return this.keypair;
  }

  private requireSelf(): string {
    if (!this.keypair) {
      throw new Error(
        "No default wallet — pass an explicit wallet pubkey or construct MagpieAgent with a keypair.",
      );
    }
    return this.keypair.publicKey.toBase58();
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
