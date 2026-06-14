import type { CallInit } from "./x402-client.js";

export interface ToolRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  init?: CallInit;
}

function agentHeaders(agentPubkey?: string): Record<string, string> {
  if (!agentPubkey) {
    throw new Error(
      "limit-close management requires MAGPIE_MCP_PAYER_KEYPAIR so the configured payer pubkey can be used as X-Agent-Pubkey",
    );
  }
  return { "X-Agent-Pubkey": agentPubkey };
}

export function routeParityTool(
  name: string,
  args: Record<string, unknown>,
  agentPubkey?: string,
): ToolRequest | null {
  switch (name) {
    case "magpie_credit_attest":
      return {
        method: "GET",
        path: "/api/v1/agent/credit-attest",
        init: { query: { wallet: String(args.wallet) } },
      };
    case "magpie_build_extend":
      return {
        method: "POST",
        path: "/api/v1/agent/build-extend",
        init: { body: args },
      };
    case "magpie_build_topup":
      return {
        method: "POST",
        path: "/api/v1/agent/build-topup",
        init: { body: args },
      };
    case "magpie_build_partial_repay":
      return {
        method: "POST",
        path: "/api/v1/agent/build-partial-repay",
        init: { body: args },
      };
    case "magpie_cancel_intent":
      return {
        method: "DELETE",
        path: "/api/v1/agent/intent",
        init: { query: { id: String(args.id) } },
      };
    case "magpie_list_intents":
      return {
        method: "GET",
        path: "/api/v1/agent/intents",
        init: { query: { wallet: String(args.wallet) } },
      };
    case "magpie_limit_close_arm":
      return {
        method: "POST",
        path: "/api/v1/agent/limit-close",
        init: { body: args },
      };
    case "magpie_limit_close_preflight":
      return {
        method: "POST",
        path: "/api/v1/agent/limit-close/preflight",
        init: { body: args, headers: agentHeaders(agentPubkey) },
      };
    case "magpie_limit_close_get":
      return {
        method: "GET",
        path: "/api/v1/agent/limit-close",
        init: {
          query: { id: String(args.id) },
          headers: agentHeaders(agentPubkey),
        },
      };
    case "magpie_limit_close_modify":
      return {
        method: "PATCH",
        path: "/api/v1/agent/limit-close/modify",
        init: { body: args, headers: agentHeaders(agentPubkey) },
      };
    case "magpie_limit_close_list": {
      const query: Record<string, string> =
        args.status === undefined ? {} : { status: String(args.status) };
      return {
        method: "GET",
        path: "/api/v1/agent/limit-close/list",
        init: { query, headers: agentHeaders(agentPubkey) },
      };
    }
    case "magpie_limit_close_delegations":
      return {
        method: "GET",
        path: "/api/v1/agent/limit-close/delegations",
        init: { headers: agentHeaders(agentPubkey) },
      };
    case "magpie_limit_close_eligible_loans":
      return {
        method: "GET",
        path: "/api/v1/agent/limit-close/eligible-loans",
        init: { headers: agentHeaders(agentPubkey) },
      };
    case "magpie_limit_close_cancel":
      return {
        method: "DELETE",
        path: "/api/v1/agent/limit-close",
        init: {
          query: { id: String(args.id) },
          headers: agentHeaders(agentPubkey),
        },
      };
    default:
      return null;
  }
}
