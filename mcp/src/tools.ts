/**
 * MCP tool registry — declarative schema + metadata for every tool.
 *
 * This file has NO side effects (no server start, no network) so it can
 * be safely imported by both index.ts and test files.
 */

// ── Tool definition shape ─────────────────────────────────────────
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Registry ──────────────────────────────────────────────────────
export const TOOLS: readonly ToolDef[] = [
  // Free reads
  {
    name: "magpie_pool_state",
    description:
      "Live LendingPool account — raw on-chain state of the pool vault, reserves, and utilization. FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_protocol_pulse",
    description:
      "Aggregated protocol health — TVL, total loans, weighted credit score, and risk breakdown across V1 and V4. FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_recent_activity",
    description:
      "Latest borrows, repays, liquidations, and deposits across the protocol. FREE.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", description: "Max items (default 25)." } },
    },
  },
  {
    name: "magpie_loan",
    description:
      "Fetch a single loan by on-chain loan ID — status, debt, collateral, timestamps, and credit impact. FREE.",
    inputSchema: {
      type: "object",
      properties: { loan_id: { type: "string", description: "On-chain loan id." } },
      required: ["loan_id"],
    },
  },
  {
    name: "magpie_wallet_loans",
    description:
      "All loans for a wallet — open, repaid, or liquidated. FREE.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Solana wallet pubkey." },
        status: { type: "string", description: "Filter: open | repaid | liquidated | all." },
      },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_tiers",
    description:
      "Current credit tiers, thresholds, and benefits (borrow limits, LTV, rate multipliers). FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_simulate_borrow",
    description:
      "Dry-run borrow: returns expected debt, collateral ratio, tier impact, and liquidation price without committing. FREE.",
    inputSchema: {
      type: "object",
      properties: {
        mint: { type: "string" },
        amount: { type: "string" },
        decimals: { type: "integer" },
        pricePerTokenUsd: { type: "number" },
        solPriceUsd: { type: "number" },
        tier: { type: "string" },
      },
      required: ["mint", "amount", "decimals", "pricePerTokenUsd", "solPriceUsd"],
    },
  },
  {
    name: "magpie_collateral_eligible",
    description:
      "Whitelist of accepted collateral tokens with risk tiers and max LTV. FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_liquidatable",
    description:
      "Loans currently below minimum collateral ratio — potential keeper opportunities. FREE.",
    inputSchema: {
      type: "object",
      properties: {
        within_seconds: { type: "integer", description: "Time window." },
        limit: { type: "integer" },
      },
    },
  },
  {
    name: "magpie_credit_leaderboard",
    description:
      "Top wallets by credit score — useful for underwriting research. FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_lp_state",
    description:
      "Your LP position — shares, underlying value, unrealised yield, and fee tier. FREE.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string", description: "Solana wallet pubkey." } },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_loan_by_pda",
    description:
      "Look up a loan by its on-chain PDA address. FREE.",
    inputSchema: {
      type: "object",
      properties: { loan_pda: { type: "string", description: "Loan PDA public key." } },
      required: ["loan_pda"],
    },
  },
  {
    name: "magpie_pools",
    description:
      "List the Magpie lending pools (program versions and their pool context) — V1 memecoin and V4 in-vault-exit lanes. FREE.",
    inputSchema: { type: "object", properties: {} },
  },
  // Paid reads
  {
    name: "magpie_credit_score",
    description:
      "Credit score for a wallet — on-chain behaviour analysis. Paid: 0.001 SOL.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_token_risk",
    description:
      "Risk profile for a token (collateral eligibility, volatility, concentration). Paid: 0.001 SOL.",
    inputSchema: {
      type: "object",
      properties: { mint: { type: "string" } },
      required: ["mint"],
    },
  },
  // Paid builders
  {
    name: "magpie_build_borrow",
    description:
      "Build an unsigned Solana transaction to borrow against collateral. Pass `has_exit_arming: true` to route into the V4 in-vault-exit lane. Paid: 0.005 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        collateral_mint: { type: "string" },
        collateral_amount: { type: "string" },
        tier: { type: "string" },
      },
      required: ["borrower_wallet", "collateral_mint", "collateral_amount", "tier"],
    },
  },
  {
    name: "magpie_build_repay",
    description:
      "Build an unsigned repay transaction (full settlement). Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        loan_id: { type: "string" },
      },
      required: ["borrower_wallet", "loan_id"],
    },
  },
  {
    name: "magpie_build_extend",
    description:
      "Build an unsigned transaction to extend a loan's due date. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        loan_pda: { type: "string" },
      },
      required: ["borrower_wallet", "loan_pda"],
    },
  },
  {
    name: "magpie_build_topup",
    description:
      "Build an unsigned transaction to add collateral to an existing loan. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        loan_pda: { type: "string" },
        extra_collateral_amount: { type: "string" },
      },
      required: ["borrower_wallet", "loan_pda", "extra_collateral_amount"],
    },
  },
  {
    name: "magpie_build_partial_repay",
    description:
      "Build an unsigned transaction to pay down part of a loan's debt. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        loan_pda: { type: "string" },
        repay_lamports: { type: "string" },
      },
      required: ["borrower_wallet", "loan_pda", "repay_lamports"],
    },
  },
  {
    name: "magpie_build_deposit",
    description:
      "Build an unsigned deposit into the LP vault. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        depositor: { type: "string" },
        lamports: { type: "string" },
      },
      required: ["depositor", "lamports"],
    },
  },
  {
    name: "magpie_build_withdraw",
    description:
      "Build an unsigned LP withdrawal. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        depositor: { type: "string" },
        shares: { type: "string" },
      },
      required: ["depositor", "shares"],
    },
  },
  {
    name: "magpie_build_liquidate",
    description:
      "Build a keeper liquidation tx — repay bad debt, receive collateral + keeper bounty. Paid: 0.003 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        keeper: { type: "string" },
        loan_pda: { type: "string" },
      },
      required: ["keeper", "loan_pda"],
    },
  },
  // Intents
  {
    name: "magpie_create_intent",
    description:
      "Create a conditional borrow intent — executes when price/rate condition is met. Paid: 0.01 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        collateral_mint: { type: "string" },
        collateral_amount: { type: "string" },
        tier: { type: "string" },
        condition_type: { type: "string" },
        condition_params: { type: "object" },
      },
      required: [
        "borrower_wallet",
        "collateral_mint",
        "collateral_amount",
        "tier",
        "condition_type",
        "condition_params",
      ],
    },
  },
  {
    name: "magpie_get_intent",
    description:
      "Poll an intent's status — pending, triggered, expired, or cancelled. Paid: 0.0005 SOL.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  // V4 self-owned exit orders
  {
    name: "magpie_arm_exit",
    description:
      "Arm a take-profit / stop-loss / trailing exit on a loan you own. Paid: 0.001 SOL.",
    inputSchema: {
      type: "object",
      properties: { loan_id: { type: "string" } },
      required: ["loan_id"],
    },
  },
  {
    name: "magpie_modify_exit",
    description:
      "Modify an existing exit order (change trigger, slippage, or destination). Free — envelope-signed.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "magpie_cancel_exit",
    description:
      "Cancel an armed exit order. Free — envelope-signed.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "magpie_list_exits",
    description:
      "List all exit orders for a wallet — armed, triggered, or cancelled. FREE.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  // ── Credit attestation ──────────────────────────────────────────
  {
    name: "magpie_credit_attest",
    description:
      "Pay-per-call ed25519-signed credit attestation. Returns the wallet's credit score WITH a cryptographic signature from the lender authority. Any consumer can verify — no need to trust this API. Useful for presenting creditworthiness to other protocols. 7-day TTL. Paid: 0.0005 SOL.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  // ── Intent management ───────────────────────────────────────────
  {
    name: "magpie_list_intents",
    description:
      "List all pending conditional borrow intents for a wallet. Returns newest-first, max 100. Paid: 0.001 SOL.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_cancel_intent",
    description:
      "Cancel a pending conditional borrow intent. Free — don't tax cleanup. Requires a signed envelope to prove you own the intent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  // ── Delegated agent limit-close (third-party agent on borrower's loan) ──
  {
    name: "magpie_limit_close_arm",
    description:
      "Arm a delegated limit-close-and-sell order on ANOTHER wallet's loan. The borrower must have pre-authorized you via TG /agent-authorize. x402 payer IS the agent (not the borrower). The agent identity is the verified x402 payer pubkey. Paid: 0.001 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        user_wallet: { type: "string", description: "The borrower's custodial wallet pubkey." },
        loan_id: { type: "string", description: "On-chain loan id (decimal string)." },
        trigger_kind: { type: "string", enum: ["mc_usd", "price_usd", "price_sol"], description: "What metric triggers the sell." },
        trigger_value_micro: { type: "string", description: "Trigger value — 1e6 USD micros or 1e9 SOL lamports." },
        slippage_bps: { type: "integer", minimum: 10, maximum: 1000, description: "Max slippage tolerance in basis points." },
        trigger_direction: { type: "string", enum: ["above", "below"], description: "'above' = take-profit (default), 'below' = stop-loss." },
        sell_destination: { type: "string", enum: ["sol", "usdc"], description: "Proceeds asset. Default 'sol'." },
        expires_at: { type: "string", description: "Optional ISO timestamp for auto-cancel." },
        auto_escalate_slippage: { type: "boolean", description: "Let the engine widen slippage toward delegation cap on reverts." },
      },
      required: ["user_wallet", "loan_id", "trigger_kind", "trigger_value_micro", "slippage_bps"],
    },
  },
  {
    name: "magpie_limit_close_preflight",
    description:
      "Check whether a delegated limit-close arm would succeed WITHOUT paying. Same body shape as arm but free. Returns would_arm=true on success or the same error codes arm would return. Use before arming to save fees on rejected configs. Requires signed envelope.",
    inputSchema: {
      type: "object",
      properties: {
        user_wallet: { type: "string" },
        loan_id: { type: "string" },
        trigger_kind: { type: "string", enum: ["mc_usd", "price_usd", "price_sol"] },
        trigger_value_micro: { type: "string" },
        slippage_bps: { type: "integer", minimum: 10, maximum: 1000 },
        trigger_direction: { type: "string", enum: ["above", "below"] },
        sell_destination: { type: "string", enum: ["sol", "usdc"] },
        expires_at: { type: "string" },
        auto_escalate_slippage: { type: "boolean" },
      },
      required: ["user_wallet", "loan_id", "trigger_kind", "trigger_value_micro", "slippage_bps"],
    },
  },
  {
    name: "magpie_limit_close_get",
    description:
      "Read a specific delegated limit-close order by ID. Free, scoped to the calling agent. Requires signed envelope.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The order ID (decimal string)." } },
      required: ["id"],
    },
  },
  {
    name: "magpie_limit_close_list",
    description:
      "List all delegated limit-close orders for this agent. Free, scoped to the calling agent. Requires signed envelope.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["armed", "all"], description: "Filter by status. Default 'armed'." },
      },
    },
  },
  {
    name: "magpie_limit_close_modify",
    description:
      "Modify an existing delegated limit-close order in-place (change trigger value, slippage, destination, or expiry). Free — agent already paid to arm. Requires signed envelope bound to the order ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The order ID to modify." },
        trigger_value_micro: { type: "string", description: "New trigger value." },
        slippage_bps: { type: "integer", minimum: 10, maximum: 1000, description: "New slippage." },
        sell_destination: { type: "string", enum: ["sol", "usdc"], description: "New destination." },
        expires_at: { type: "string", description: "New expiry (ISO) or null to clear." },
      },
      required: ["id"],
    },
  },
  {
    name: "magpie_limit_close_cancel",
    description:
      "Cancel a delegated limit-close order. Free. A too-late cancel (engine already firing) returns 409 no-op. Requires signed envelope bound to the order ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The order ID to cancel." } },
      required: ["id"],
    },
  },
  {
    name: "magpie_limit_close_delegations",
    description:
      "Discover what this agent is authorized for — every active (user_wallet, bounds, usage) delegation. Standard startup call: see your surface, cache, then arm as orders come in. Free. Requires signed envelope.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_limit_close_eligible_loans",
    description:
      "The agent's full actionable surface — every (user_wallet, loan) tuple where this agent has an active delegation, with eligibility for each loan (is_eligible + ineligibility_reasons). Free. Requires signed envelope.",
    inputSchema: { type: "object", properties: {} },
  },
];
