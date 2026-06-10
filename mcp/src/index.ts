#!/usr/bin/env node
/**
 * Magpie MCP server — exposes the magpie-x402 API as native MCP tools
 * for Claude Desktop, Cursor, Windsurf, ChatGPT desktop, and any other
 * MCP-aware agent host.
 *
 * Transport: stdio (the standard for desktop hosts).
 *
 * Free tools work out of the box. Paid tools require a configured
 * Solana keypair (env var) that's funded with a small SOL balance for
 * the per-call payments. The server signs payment txs locally; nothing
 * is sent to magpie-x402 except the public X-Payment header.
 *
 * Env vars:
 *   MAGPIE_X402_BASE_URL    default https://x402.magpie.capital
 *   SOLANA_RPC_URL          default https://api.mainnet-beta.solana.com
 *   MAGPIE_MCP_PAYER_KEYPAIR  path to a Solana keypair JSON (~/.config/solana/id.json format)
 *
 * Run from this directory:
 *   npm install && npm run build && node dist/index.js
 *
 * Or via tsx without build step:
 *   npx tsx src/index.ts
 *
 * Wire into Claude Desktop / Cursor / Windsurf via their `mcpServers`
 * config — see ../README.md in this directory for snippets.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { call, loadKeypairFromEnv, type ClientCtx } from "./x402-client.js";

const baseUrl = process.env.MAGPIE_X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const payer = loadKeypairFromEnv();
const ctx: ClientCtx = { baseUrl, rpcUrl, payer };

// Schema-only tool registry. Each entry maps to a thin handler below
// that turns the args into a magpie-x402 HTTP call. Keeping the tool
// list in one declarative block makes ListTools cheap + always in sync
// with CallTool dispatch.
const TOOLS = [
  // ── Free reads ──────────────────────────────────────────────────
  {
    name: "magpie_pool_state",
    description:
      "Get live on-chain Magpie LendingPool state — totalDeposits, totalBorrowed, totalShares, utilization, fees earned. Free, 15s cache.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_protocol_pulse",
    description:
      "24h protocol aggregates: active loans, active borrowers, borrows in last 1h + 24h, borrow volume in SOL, repays, liquidations. Pure aggregates, no per-wallet data. Free, 30s cache.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_recent_activity",
    description:
      "Anonymized recent borrow/repay/liquidate events across the protocol. Wallets reduced to Xxxx…Yyyy. Useful as 'is this protocol active right now' signal. Free, 15s cache.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
      },
    },
  },
  {
    name: "magpie_loan",
    description: "Fetch a single Magpie loan by its u64 ID. Free.",
    inputSchema: {
      type: "object",
      properties: { loan_id: { type: "string", pattern: "^[0-9]+$" } },
      required: ["loan_id"],
    },
  },
  {
    name: "magpie_wallet_loans",
    description:
      "All loans owned by a wallet. Optional ?status filter. Free, 8s cache.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string" },
        status: { type: "string", enum: ["active", "repaid", "liquidated"] },
      },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_tiers",
    description:
      "Magpie loan tier constants — three fixed tiers (Express / Quick / Standard) with their LTV, duration, and fee parameters. Free, 1h cache.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_simulate_borrow",
    description:
      "Preview a loan WITHOUT submitting. Pure math from caller-supplied prices + the public tier constants. Use tier='all' to compare all three tiers. Free.",
    inputSchema: {
      type: "object",
      properties: {
        mint: { type: "string" },
        amount: { type: "string", pattern: "^[0-9]+$" },
        decimals: { type: "string", pattern: "^[0-9]{1,2}$" },
        pricePerTokenUsd: { type: "string" },
        solPriceUsd: { type: "string" },
        tier: {
          type: "string",
          enum: ["express", "quick", "standard", "all"],
          default: "all",
        },
      },
      required: ["mint", "amount", "decimals", "pricePerTokenUsd", "solPriceUsd"],
    },
  },
  {
    name: "magpie_collateral_eligible",
    description:
      "Catalog of every token currently approved as Magpie collateral. Mint, symbol, decimals, category. First-touch endpoint for new agent integrations. Free, 1h cache.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_liquidatable",
    description:
      "Active loans at or past their on-chain due timestamp — the canonical liquidation-bot data feed. Sorted most-past-due-first. Use within_seconds for pre-positioning. Free, 8s cache.",
    inputSchema: {
      type: "object",
      properties: {
        within_seconds: { type: "integer", minimum: 0, maximum: 604800 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "magpie_credit_leaderboard",
    description:
      "Top wallets ranked by Magpie credit score (anonymized to Xxxx…Yyyy). Free, 60s cache.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "magpie_lp_state",
    description:
      "Read a wallet's LP position in the main LendingPool — shares, deposited lamports, current value, yield earned, share-of-pool, plus pool context. Free, 10s cache.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  // ── Paid endpoints ──────────────────────────────────────────────
  {
    name: "magpie_credit_score",
    description:
      "Magpie credit score (300-850) + tier benefits for a wallet. Paid: 0.001 SOL per lookup.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string" } },
      required: ["wallet"],
    },
  },
  {
    name: "magpie_token_risk",
    description:
      "Per-token risk profile from Magpie's internal risk engine — risk score (0-100), dimension breakdown (volatility, liquidity, concentration, volume, rug_pull), market data, max allowed LTV the program will enforce, operator flags. Useful pre-borrow collateral check. Paid: 0.001 SOL per lookup.",
    inputSchema: {
      type: "object",
      properties: { mint: { type: "string" } },
      required: ["mint"],
    },
  },
  {
    name: "magpie_build_borrow",
    description:
      "Build an UNSIGNED borrow transaction. Server runs the full anti-exploit gate eval (ban registry, TWAP, pool floor, cross-source price, RWA-only guard, etc.) and returns a partial-signed tx. Agent signs locally and submits to magpie.capital/api/v1/cosign-borrow. Paid: 0.005 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        collateral_mint: { type: "string" },
        collateral_amount: { type: "string", pattern: "^[0-9]+$" },
        tier: { type: "integer", enum: [0, 1, 2] },
      },
      required: ["borrower_wallet", "collateral_mint", "collateral_amount", "tier"],
    },
  },
  {
    name: "magpie_build_repay",
    description: "Build an unsigned repay tx for an existing loan. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        loan_id: { type: "string", pattern: "^[0-9]+$" },
      },
      required: ["borrower_wallet", "loan_id"],
    },
  },
  {
    name: "magpie_build_deposit",
    description:
      "Build an UNSIGNED LP-deposit transaction (wraps SOL → wSOL → deposits into the main LendingPool → closes wSOL ATA). Agent signs and submits. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        depositor: { type: "string" },
        lamports: { type: "string", pattern: "^[0-9]+$" },
      },
      required: ["depositor", "lamports"],
    },
  },
  {
    name: "magpie_build_withdraw",
    description:
      "Build an unsigned LP-withdraw tx for the requested shares. Server pre-validates the on-chain position and refuses chunks larger than max_safe_shares. Paid: 0.002 SOL.",
    inputSchema: {
      type: "object",
      properties: {
        depositor: { type: "string" },
        shares: { type: "string", pattern: "^[0-9]+$" },
      },
      required: ["depositor", "shares"],
    },
  },
  {
    name: "magpie_build_liquidate",
    description:
      "Build an unsigned liquidate-loan tx for a past-due active loan. The keeper (your wallet) receives keeper_reward_bps share of the seized collateral as bounty; the rest goes to the lender authority for pool recovery. Permissionless — any wallet can liquidate. Server pre-validates the loan exists, is active, and is past due. Paid: 0.003 SOL. Workflow: poll magpie_liquidatable to find candidates, then call this on the loan_pda.",
    inputSchema: {
      type: "object",
      properties: {
        keeper: { type: "string" },
        loan_pda: { type: "string" },
      },
      required: ["keeper", "loan_pda"],
    },
  },
  {
    name: "magpie_create_intent",
    description:
      "Post a CONDITIONAL borrow intent. Bot watches the trigger condition (price_above / price_below / time_after / pool_liq_above) and builds the unsigned tx when matched. Single payment covers entire intent lifecycle. Paid: 0.01 SOL. Optional webhook_url — server POSTs an HMAC-SHA256-signed payload on match instead of forcing you to poll. The webhook_secret is returned ONCE in the response; persist it to verify signatures on receive.",
    inputSchema: {
      type: "object",
      properties: {
        borrower_wallet: { type: "string" },
        collateral_mint: { type: "string" },
        collateral_amount: { type: "string" },
        tier: { type: "integer", enum: [0, 1, 2] },
        condition_type: {
          type: "string",
          enum: ["price_above", "price_below", "time_after", "pool_liq_above"],
        },
        condition_params: { type: "object" },
        expires_in_seconds: { type: "integer", minimum: 60, maximum: 2592000 },
        webhook_url: {
          type: "string",
          format: "uri",
          description: "Optional HTTPS endpoint to receive the match notification. Must be HTTPS; private IPs blocked.",
        },
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
      "Poll the status of a conditional borrow intent. When status='matched', the response includes partial_signed_tx_b64 ready to sign + submit. Paid: 0.0005 SOL per poll.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] as const;

// ── Server wiring ─────────────────────────────────────────────────
const server = new Server(
  {
    name: "magpie-mcp",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS as unknown as Array<{
    name: string;
    description: string;
    inputSchema: object;
  }>,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, unknown>;
  try {
    let result;
    switch (name) {
      case "magpie_pool_state":
        result = await call(ctx, "GET", "/api/v1/pool");
        break;
      case "magpie_protocol_pulse":
        result = await call(ctx, "GET", "/api/v1/agent/protocol-pulse");
        break;
      case "magpie_recent_activity":
        result = await call(ctx, "GET", "/api/v1/agent/activity", {
          query: a.limit !== undefined ? { limit: String(a.limit) } : {},
        });
        break;
      case "magpie_loan":
        result = await call(ctx, "GET", `/api/v1/loan/${encodeURIComponent(String(a.loan_id))}`);
        break;
      case "magpie_wallet_loans": {
        const q: Record<string, string> = {};
        if (a.status) q.status = String(a.status);
        result = await call(ctx, "GET", `/api/v1/wallet/${encodeURIComponent(String(a.wallet))}/loans`, { query: q });
        break;
      }
      case "magpie_tiers":
        result = await call(ctx, "GET", "/api/v1/tiers");
        break;
      case "magpie_simulate_borrow": {
        const q: Record<string, string> = {
          mint: String(a.mint),
          amount: String(a.amount),
          decimals: String(a.decimals),
          pricePerTokenUsd: String(a.pricePerTokenUsd),
          solPriceUsd: String(a.solPriceUsd),
        };
        if (a.tier) q.tier = String(a.tier);
        result = await call(ctx, "GET", "/api/v1/simulate-borrow", { query: q });
        break;
      }
      case "magpie_collateral_eligible":
        result = await call(ctx, "GET", "/api/v1/collateral/eligible");
        break;
      case "magpie_liquidatable": {
        const q: Record<string, string> = {};
        if (a.within_seconds !== undefined) q.within_seconds = String(a.within_seconds);
        if (a.limit !== undefined) q.limit = String(a.limit);
        result = await call(ctx, "GET", "/api/v1/markets/liquidatable", { query: q });
        break;
      }
      case "magpie_credit_leaderboard":
        result = await call(ctx, "GET", "/api/v1/agent/leaderboard");
        break;
      case "magpie_lp_state":
        result = await call(ctx, "GET", "/api/v1/agent/lp-state", {
          query: { wallet: String(a.wallet) },
        });
        break;
      case "magpie_credit_score":
        result = await call(ctx, "GET", "/api/v1/credit-score", {
          query: { wallet: String(a.wallet) },
        });
        break;
      case "magpie_token_risk":
        result = await call(ctx, "GET", "/api/v1/agent/token-risk", {
          query: { mint: String(a.mint) },
        });
        break;
      case "magpie_build_borrow":
        result = await call(ctx, "POST", "/api/v1/agent/build-borrow", { body: a });
        break;
      case "magpie_build_repay":
        result = await call(ctx, "POST", "/api/v1/agent/build-repay", { body: a });
        break;
      case "magpie_build_deposit":
        result = await call(ctx, "POST", "/api/v1/agent/build-deposit", { body: a });
        break;
      case "magpie_build_withdraw":
        result = await call(ctx, "POST", "/api/v1/agent/build-withdraw", { body: a });
        break;
      case "magpie_build_liquidate":
        result = await call(ctx, "POST", "/api/v1/agent/build-liquidate", { body: a });
        break;
      case "magpie_create_intent":
        result = await call(ctx, "POST", "/api/v1/agent/intent", { body: a });
        break;
      case "magpie_get_intent":
        result = await call(ctx, "GET", "/api/v1/agent/intent", {
          query: { id: String(a.id) },
        });
        break;
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `unknown tool: ${name}` }],
        };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { data: result.data, paid: result.paid },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `error calling ${name}: ${(err as Error).message}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

// MCP servers communicate over stdio so anything written to stdout
// gets parsed as protocol JSON. Use stderr for any human-readable
// startup logs.
const payerNote = payer
  ? `paid endpoints enabled — payer: ${payer.publicKey.toBase58()}`
  : "free endpoints only — set MAGPIE_MCP_PAYER_KEYPAIR to enable paid tools";
process.stderr.write(`magpie-mcp ready (${baseUrl}) — ${payerNote}\n`);
