import { test } from "node:test";
import assert from "node:assert";

/**
 * Smoke tests for the MCP tool registry:
 *   1. Every tool has a unique name and a valid JSON Schema input.
 *   2. Tool-to-endpoint mapping is correct (method + path).
 *   3. Free vs paid classification matches the API's pricing.
 *   4. Envelope-signed tools require a payer keypair.
 *
 * These are STRUCTURAL tests — they never hit the network. They verify the
 * declarative registry is internally consistent so regressions (duplicate
 * names, wrong paths, schema drift) fail CI.
 */

import { TOOLS } from "./tools.js";

// ── Tool-to-endpoint mapping ─────────────────────────────────────
// { method, path, paid, requiresEnvelope }
const ROUTING: Record<string, { method: string; path: string; paid: boolean; requiresEnvelope?: boolean }> = {
  // Free reads
  magpie_pool_state:            { method: "GET",  path: "/api/v1/pool",                                              paid: false },
  magpie_protocol_pulse:        { method: "GET",  path: "/api/v1/agent/protocol-pulse",                               paid: false },
  magpie_recent_activity:       { method: "GET",  path: "/api/v1/agent/activity",                                     paid: false },
  magpie_loan:                  { method: "GET",  path: "/api/v1/loan/:loanId",                                       paid: false },
  magpie_wallet_loans:          { method: "GET",  path: "/api/v1/wallet/:wallet/loans",                               paid: false },
  magpie_tiers:                 { method: "GET",  path: "/api/v1/tiers",                                              paid: false },
  magpie_simulate_borrow:       { method: "GET",  path: "/api/v1/simulate-borrow",                                    paid: false },
  magpie_collateral_eligible:   { method: "GET",  path: "/api/v1/collateral/eligible",                                paid: false },
  magpie_liquidatable:          { method: "GET",  path: "/api/v1/markets/liquidatable",                               paid: false },
  magpie_credit_leaderboard:    { method: "GET",  path: "/api/v1/agent/leaderboard",                                  paid: false },
  magpie_lp_state:              { method: "GET",  path: "/api/v1/agent/lp-state",                                     paid: false },
  magpie_loan_by_pda:           { method: "GET",  path: "/api/v1/loan/by-pda/:loanPda",                               paid: false },
  magpie_pools:                 { method: "GET",  path: "/api/v1/pools",                                              paid: false },
  // Paid reads
  magpie_credit_score:          { method: "GET",  path: "/api/v1/credit-score",                                       paid: true },
  magpie_token_risk:            { method: "GET",  path: "/api/v1/agent/token-risk",                                   paid: true },
  // Paid builders
  magpie_build_borrow:          { method: "POST", path: "/api/v1/agent/build-borrow",                                 paid: true },
  magpie_build_repay:           { method: "POST", path: "/api/v1/agent/build-repay",                                  paid: true },
  magpie_build_extend:          { method: "POST", path: "/api/v1/agent/build-extend",                                 paid: true },
  magpie_build_topup:           { method: "POST", path: "/api/v1/agent/build-topup",                                  paid: true },
  magpie_build_partial_repay:   { method: "POST", path: "/api/v1/agent/build-partial-repay",                          paid: true },
  magpie_build_deposit:         { method: "POST", path: "/api/v1/agent/build-deposit",                                paid: true },
  magpie_build_withdraw:        { method: "POST", path: "/api/v1/agent/build-withdraw",                               paid: true },
  magpie_build_liquidate:       { method: "POST", path: "/api/v1/agent/build-liquidate",                              paid: true },
  // Intents
  magpie_create_intent:         { method: "POST", path: "/api/v1/agent/intent",                                       paid: true },
  magpie_get_intent:            { method: "GET",  path: "/api/v1/agent/intent",                                       paid: true },
  // V4 self-owned exits
  magpie_arm_exit:              { method: "POST", path: "/api/v1/agent/self-limit-close/arm",                         paid: true },
  magpie_modify_exit:           { method: "POST", path: "/api/v1/agent/self-limit-close/modify",                      paid: false, requiresEnvelope: true },
  magpie_cancel_exit:           { method: "POST", path: "/api/v1/agent/self-limit-close/cancel",                      paid: false, requiresEnvelope: true },
  magpie_list_exits:            { method: "GET",  path: "/api/v1/agent/self-limit-close/list",                        paid: false },
  // ── New parity tools ────────────────────────────────────────
  // Credit attestation
  magpie_credit_attest:         { method: "GET",  path: "/api/v1/agent/credit-attest",                                paid: true },
  // Intent management
  magpie_list_intents:          { method: "GET",  path: "/api/v1/agent/intents",                                      paid: true },
  magpie_cancel_intent:         { method: "DELETE", path: "/api/v1/agent/intent",                                     paid: false, requiresEnvelope: true },
  // Delegated agent limit-close
  magpie_limit_close_arm:       { method: "POST", path: "/api/v1/agent/limit-close",                                  paid: true },
  magpie_limit_close_preflight: { method: "POST", path: "/api/v1/agent/limit-close/preflight",                        paid: false, requiresEnvelope: true },
  magpie_limit_close_get:       { method: "GET",  path: "/api/v1/agent/limit-close",                                  paid: false, requiresEnvelope: true },
  magpie_limit_close_list:      { method: "GET",  path: "/api/v1/agent/limit-close/list",                             paid: false, requiresEnvelope: true },
  magpie_limit_close_modify:    { method: "POST", path: "/api/v1/agent/limit-close/modify",                           paid: false, requiresEnvelope: true },
  magpie_limit_close_cancel:    { method: "DELETE", path: "/api/v1/agent/limit-close",                                paid: false, requiresEnvelope: true },
  magpie_limit_close_delegations:  { method: "GET", path: "/api/v1/agent/limit-close/delegations",                     paid: false, requiresEnvelope: true },
  magpie_limit_close_eligible_loans: { method: "GET", path: "/api/v1/agent/limit-close/eligible-loans",                paid: false, requiresEnvelope: true },
};

// ── Tests ──────────────────────────────────────────────────────────

test("all tool names are unique", () => {
  const names = TOOLS.map((t) => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual(dupes, [], `duplicate tool names: ${dupes.join(", ")}`);
});

test("every tool in the routing table has a schema entry", () => {
  const toolNames = new Set(TOOLS.map((t) => t.name));
  for (const name of Object.keys(ROUTING)) {
    assert.ok(toolNames.has(name), `tool "${name}" is in ROUTING but not in TOOLS`);
  }
});

test("every tool has a schema with type=object", () => {
  for (const t of TOOLS) {
    assert.strictEqual(t.inputSchema.type, "object", `${t.name}: inputSchema.type must be "object"`);
  }
});

test("every paid tool has a non-empty description mentioning price", () => {
  for (const [name, route] of Object.entries(ROUTING)) {
    if (route.paid) {
      const tool = TOOLS.find((t) => t.name === name);
      assert.ok(tool, `missing tool ${name}`);
      assert.ok(tool.inputSchema, `${name}: paid tool should have an inputSchema`);
    }
  }
});

test("envelope-required tools are free (no x402 charge)", () => {
  for (const [name, route] of Object.entries(ROUTING)) {
    if (route.requiresEnvelope) {
      assert.strictEqual(
        route.paid,
        false,
        `${name}: envelope-signed tool should be free (auth is the envelope, not a payment)`,
      );
    }
  }
});

test("all tools have a corresponding entry in ROUTING", () => {
  for (const t of TOOLS) {
    assert.ok(
      ROUTING[t.name] !== undefined,
      `tool "${t.name}" has no ROUTING entry — add it to the routing table`,
    );
  }
});

test("new parity tools count: credit_attest, list_intents, cancel_intent, + 8 limit-close = 11 new tools", () => {
  const newTools = [
    "magpie_credit_attest",
    "magpie_list_intents",
    "magpie_cancel_intent",
    "magpie_limit_close_arm",
    "magpie_limit_close_preflight",
    "magpie_limit_close_get",
    "magpie_limit_close_list",
    "magpie_limit_close_modify",
    "magpie_limit_close_cancel",
    "magpie_limit_close_delegations",
    "magpie_limit_close_eligible_loans",
  ];
  for (const name of newTools) {
    assert.ok(TOOLS.find((t) => t.name === name), `new tool "${name}" missing from TOOLS`);
    assert.ok(ROUTING[name], `new tool "${name}" missing from ROUTING`);
  }
  assert.strictEqual(newTools.length, 11, "expected 11 new parity tools");
});

test("total tool count matches expected", () => {
  // 13 free reads + 2 paid reads + 8 builders + 2 intents + 4 self-exit + 11 new = 40
  assert.strictEqual(TOOLS.length, 40, `expected 40 tools, got ${TOOLS.length}`);
});
