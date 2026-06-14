import assert from "node:assert/strict";
import test from "node:test";

import { routeParityTool } from "./tool-routing.js";

const agent = "Agent1111111111111111111111111111111111111";

test("maps all paid and general parity tools to their API endpoints", () => {
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    expected: ReturnType<typeof routeParityTool>;
  }> = [
    {
      name: "magpie_credit_attest",
      args: { wallet: "w" },
      expected: {
        method: "GET",
        path: "/api/v1/agent/credit-attest",
        init: { query: { wallet: "w" } },
      },
    },
    {
      name: "magpie_build_extend",
      args: { borrower_wallet: "w", loan_pda: "l" },
      expected: {
        method: "POST",
        path: "/api/v1/agent/build-extend",
        init: { body: { borrower_wallet: "w", loan_pda: "l" } },
      },
    },
    {
      name: "magpie_build_topup",
      args: {
        borrower_wallet: "w",
        loan_pda: "l",
        extra_collateral_amount: "10",
      },
      expected: {
        method: "POST",
        path: "/api/v1/agent/build-topup",
        init: {
          body: {
            borrower_wallet: "w",
            loan_pda: "l",
            extra_collateral_amount: "10",
          },
        },
      },
    },
    {
      name: "magpie_build_partial_repay",
      args: {
        borrower_wallet: "w",
        loan_pda: "l",
        repay_lamports: "10",
      },
      expected: {
        method: "POST",
        path: "/api/v1/agent/build-partial-repay",
        init: {
          body: {
            borrower_wallet: "w",
            loan_pda: "l",
            repay_lamports: "10",
          },
        },
      },
    },
    {
      name: "magpie_cancel_intent",
      args: { id: "intent_id" },
      expected: {
        method: "DELETE",
        path: "/api/v1/agent/intent",
        init: { query: { id: "intent_id" } },
      },
    },
    {
      name: "magpie_list_intents",
      args: { wallet: "w" },
      expected: {
        method: "GET",
        path: "/api/v1/agent/intents",
        init: { query: { wallet: "w" } },
      },
    },
    {
      name: "magpie_limit_close_arm",
      args: { user_wallet: "w", loan_id: "1" },
      expected: {
        method: "POST",
        path: "/api/v1/agent/limit-close",
        init: { body: { user_wallet: "w", loan_id: "1" } },
      },
    },
  ];

  for (const { name, args, expected } of cases) {
    assert.deepEqual(routeParityTool(name, args), expected, name);
  }
});

test("maps all free limit-close tools with the configured payer identity", () => {
  const headers = { "X-Agent-Pubkey": agent };
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    expected: ReturnType<typeof routeParityTool>;
  }> = [
    {
      name: "magpie_limit_close_preflight",
      args: { user_wallet: "w", loan_id: "1" },
      expected: {
        method: "POST",
        path: "/api/v1/agent/limit-close/preflight",
        init: {
          body: { user_wallet: "w", loan_id: "1" },
          headers,
        },
      },
    },
    {
      name: "magpie_limit_close_get",
      args: { id: "42" },
      expected: {
        method: "GET",
        path: "/api/v1/agent/limit-close",
        init: { query: { id: "42" }, headers },
      },
    },
    {
      name: "magpie_limit_close_modify",
      args: { id: "42", slippage_bps: 50 },
      expected: {
        method: "PATCH",
        path: "/api/v1/agent/limit-close/modify",
        init: { body: { id: "42", slippage_bps: 50 }, headers },
      },
    },
    {
      name: "magpie_limit_close_list",
      args: { status: "all" },
      expected: {
        method: "GET",
        path: "/api/v1/agent/limit-close/list",
        init: { query: { status: "all" }, headers },
      },
    },
    {
      name: "magpie_limit_close_delegations",
      args: {},
      expected: {
        method: "GET",
        path: "/api/v1/agent/limit-close/delegations",
        init: { headers },
      },
    },
    {
      name: "magpie_limit_close_eligible_loans",
      args: {},
      expected: {
        method: "GET",
        path: "/api/v1/agent/limit-close/eligible-loans",
        init: { headers },
      },
    },
    {
      name: "magpie_limit_close_cancel",
      args: { id: "42" },
      expected: {
        method: "DELETE",
        path: "/api/v1/agent/limit-close",
        init: { query: { id: "42" }, headers },
      },
    },
  ];

  for (const { name, args, expected } of cases) {
    assert.deepEqual(routeParityTool(name, args, agent), expected, name);
  }
});

test("omits the default status query when listing limit-close orders", () => {
  assert.deepEqual(routeParityTool("magpie_limit_close_list", {}, agent), {
    method: "GET",
    path: "/api/v1/agent/limit-close/list",
    init: { query: {}, headers: { "X-Agent-Pubkey": agent } },
  });
});

test("rejects scoped limit-close calls without an agent identity", () => {
  assert.throws(
    () => routeParityTool("magpie_limit_close_get", { id: "1" }),
    /MAGPIE_MCP_PAYER_KEYPAIR/,
  );
});

test("returns null for tools handled by the existing dispatcher", () => {
  assert.equal(routeParityTool("magpie_pool_state", {}), null);
});
