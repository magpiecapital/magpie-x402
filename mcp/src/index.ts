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
import { buildSignedEnvelope, buildEnvelopeHeaders } from "./envelope.js";

const baseUrl = process.env.MAGPIE_X402_BASE_URL ?? "https://x402.magpie.capital";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const payer = loadKeypairFromEnv();
const ctx: ClientCtx = { baseUrl, rpcUrl, payer };

// The self-owned exit surface signs an Ed25519 envelope with the payer
// keypair. Both the signature AND (for arm) the x402 payment come from this
// one keypair, guaranteeing the bot's payer==signer invariant.
function requirePayer() {
  if (!payer) {
    throw new Error(
      "this tool signs an exit envelope (and arm also pays an x402 challenge) but no payer keypair was configured. Set MAGPIE_MCP_PAYER_KEYPAIR.",
    );
  }
  return payer;
}

import { TOOLS } from "./tools.js";
// ── Server wiring ─────────────────────────────────────────────────
const server = new Server(
  {
    name: "magpie-mcp",
    version: "0.3.0",
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
      case "magpie_build_extend":
        result = await call(ctx, "POST", "/api/v1/agent/build-extend", { body: a });
        break;
      case "magpie_build_topup":
        result = await call(ctx, "POST", "/api/v1/agent/build-topup", { body: a });
        break;
      case "magpie_build_partial_repay":
        result = await call(ctx, "POST", "/api/v1/agent/build-partial-repay", { body: a });
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
      // ── V4 in-vault exit orders ──────────────────────────────────
      case "magpie_arm_exit": {
        // PAID. The envelope MUST be signed by the SAME keypair that pays
        // the x402 challenge, so the bot's payer==signer guard holds.
        const kp = requirePayer();
        const fields: Record<string, string | number | undefined> = {
          LoanId: String(a.loan_id),
          Direction: a.direction !== undefined ? String(a.direction) : undefined,
          Target: a.target !== undefined ? String(a.target) : undefined,
          Price: a.price_usd !== undefined ? String(a.price_usd) : undefined,
          MC: a.mc_usd !== undefined ? String(a.mc_usd) : undefined,
          Trailing: a.trailing_bps !== undefined ? String(a.trailing_bps) : undefined,
          Slippage: a.slippage_bps !== undefined ? String(a.slippage_bps) : undefined,
          Slice: a.slice !== undefined ? String(a.slice) : undefined,
          Dest: a.dest !== undefined ? String(a.dest) : undefined,
        };
        const env = buildSignedEnvelope(kp, "limit-close-arm/v1", fields);
        result = await call(
          ctx,
          "POST",
          "/api/v1/agent/self-limit-close/arm",
          { body: env },
        );
        break;
      }
      case "magpie_modify_exit": {
        // FREE — still envelope-signed by the payer keypair (payer==signer).
        const kp = requirePayer();
        const fields: Record<string, string | number | undefined> = {
          OrderId: String(a.order_id),
          Price: a.price_usd !== undefined ? String(a.price_usd) : undefined,
          MC: a.mc_usd !== undefined ? String(a.mc_usd) : undefined,
          Target: a.target !== undefined ? String(a.target) : undefined,
          Trailing: a.trailing_bps !== undefined ? String(a.trailing_bps) : undefined,
          Slippage: a.slippage_bps !== undefined ? String(a.slippage_bps) : undefined,
          Dest: a.dest !== undefined ? String(a.dest) : undefined,
        };
        const env = buildSignedEnvelope(kp, "limit-close-modify/v1", fields);
        result = await call(
          ctx,
          "POST",
          "/api/v1/agent/self-limit-close/modify",
          { body: env },
        );
        break;
      }
      case "magpie_cancel_exit": {
        // FREE — envelope-signed by the payer keypair (payer==signer).
        const kp = requirePayer();
        const env = buildSignedEnvelope(kp, "limit-close-cancel/v1", {
          OrderId: String(a.order_id),
        });
        result = await call(
          ctx,
          "POST",
          "/api/v1/agent/self-limit-close/cancel",
          { body: env },
        );
        break;
      }
      case "magpie_list_exits":
        result = await call(ctx, "GET", "/api/v1/agent/self-limit-close/list", {
          query: { wallet: String(a.wallet) },
        });
        break;
      case "magpie_loan_by_pda":
        result = await call(
          ctx,
          "GET",
          `/api/v1/loan/by-pda/${encodeURIComponent(String(a.loan_pda))}`,
        );
        break;
      case "magpie_pools":
        result = await call(ctx, "GET", "/api/v1/pools");
        break;
      // ── Credit attestation ────────────────────────────────────────
      case "magpie_credit_attest":
        result = await call(ctx, "GET", "/api/v1/agent/credit-attest", {
          query: { wallet: String(a.wallet) },
        });
        break;
      // ── Intent management ─────────────────────────────────────────
      case "magpie_list_intents":
        result = await call(ctx, "GET", "/api/v1/agent/intents", {
          query: { wallet: String(a.wallet) },
        });
        break;
      case "magpie_cancel_intent": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "intent-cancel/v1", {
          OrderId: String(a.id),
        });
        result = await call(ctx, "DELETE", "/api/v1/agent/intent", {
          query: { id: String(a.id) },
          headers: envH,
        });
        break;
      }
      // ── Delegated agent limit-close ───────────────────────────────
      case "magpie_limit_close_arm": {
        const sbps = Number(a.slippage_bps);
        if (!Number.isFinite(sbps) || sbps < 10 || sbps > 1000) {
          return { content: [{ type: "text", text: "slippage_bps must be an integer between 10 and 1000" }], isError: true };
        }
        result = await call(ctx, "POST", "/api/v1/agent/limit-close", { body: a });
        break;
      }
      case "magpie_limit_close_preflight": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-preflight/v1", {});
        result = await call(ctx, "POST", "/api/v1/agent/limit-close/preflight", {
          body: a,
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_get": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-get/v1", {
          OrderId: String(a.id),
        });
        result = await call(ctx, "GET", "/api/v1/agent/limit-close", {
          query: { id: String(a.id) },
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_list": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-list/v1", {});
        const q: Record<string, string> = {};
        if (a.status) q.status = String(a.status);
        result = await call(ctx, "GET", "/api/v1/agent/limit-close/list", {
          query: q,
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_modify": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-modify/v1", {
          OrderId: String(a.id),
        });
        result = await call(ctx, "POST", "/api/v1/agent/limit-close/modify", {
          body: a,
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_cancel": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-cancel/v1", {
          OrderId: String(a.id),
        });
        result = await call(ctx, "DELETE", "/api/v1/agent/limit-close", {
          query: { id: String(a.id) },
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_delegations": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-delegations/v1", {});
        result = await call(ctx, "GET", "/api/v1/agent/limit-close/delegations", {
          headers: envH,
        });
        break;
      }
      case "magpie_limit_close_eligible_loans": {
        const kp = requirePayer();
        const envH = buildEnvelopeHeaders(kp, "limit-close-eligible/v1", {});
        result = await call(ctx, "GET", "/api/v1/agent/limit-close/eligible-loans", {
          headers: envH,
        });
        break;
      }
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
