/**
 * brain.ts — the Claude-driven decision brain.
 * ─────────────────────────────────────────────────────────────────────────
 * Claude *proposes* what to buy; the deterministic safety layer *disposes*.
 * The model can ONLY pick from a pre-computed allowed menu, researches with a
 * couple of read tools, and submits a structured decision. It can never bypass
 * the allowlist, the solvency reserve, or the never-default guardian — those
 * stay in code. Holding is always an allowed, safe answer.
 *
 * Optional: needs `@anthropic-ai/sdk` installed + ANTHROPIC_API_KEY. If either
 * is missing, the orchestrator falls back to the deterministic picker.
 */
import type { MagpieAgent } from "@magpieloans/magpie-agent";
import type { AgentConfig } from "./config.js";
import { SYSTEM_PROMPT } from "./magpie-playbook.js";

export interface MenuItem {
  mint: string;
  symbol: string;
  decimals: number;
  category: string;
}

export interface BrainDecision {
  action: "buy" | "hold";
  mint?: string;
  symbol?: string;
  reasoning: string;
  confidence: number; // 0..1
}

const MODEL = process.env.MAGPIE_BRAIN_MODEL ?? "claude-sonnet-4-6";
const MAX_TOOL_CALLS = Number(process.env.BRAIN_MAX_TOOL_CALLS ?? 6);

/** Use the LLM brain when explicitly on, or whenever an API key is present. */
export function brainEnabled(): boolean {
  if (process.env.USE_LLM_BRAIN === "false") return false;
  return process.env.USE_LLM_BRAIN === "true" || !!process.env.ANTHROPIC_API_KEY;
}

const TOOLS = [
  {
    name: "assess_token_risk",
    description:
      "Magpie's risk profile for a collateral mint: risk_score 0-100 (lower = safer), dimension breakdown, max_allowed_ltv. In dry-run this is a stub (no payment).",
    input_schema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] },
  },
  {
    name: "get_pool_state",
    description: "Live Magpie lending pool: TVL, utilization, paused. Context for borrow capacity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "submit_decision",
    description: "Submit your FINAL choice. Call exactly once when done researching.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["buy", "hold"] },
        mint: { type: "string", description: "chosen mint from the allowed menu (required when action=buy)" },
        reasoning: { type: "string" },
        confidence: { type: "number", description: "0..1" },
      },
      required: ["action", "reasoning", "confidence"],
    },
  },
] as const;

async function runTool(
  agent: MagpieAgent,
  cfg: AgentConfig,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (name === "assess_token_risk") {
      if (cfg.dryRun) return { note: "dry-run: risk check skipped (no payment made). Reason from category/liquidity instead." };
      return await agent.tokenRisk(String(input.mint));
    }
    if (name === "get_pool_state") return await agent.poolState();
    return { error: `unknown tool ${name}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function taskPrompt(cfg: AgentConfig, menu: MenuItem[]): string {
  const list = menu.map((m) => `- ${m.symbol}  ${m.mint}  [${m.category}]`).join("\n");
  return [
    "Choose ONE collateral asset to buy-and-collateralize, or decide to HOLD.",
    "",
    "ALLOWED MENU — you may ONLY pick a mint from this list; anything else is rejected:",
    list,
    "",
    "Constraints:",
    `- Preferred category: ${cfg.preferredCategory}. RWAs (stocks) are far safer; memecoins are high-risk.`,
    `- Max acceptable Magpie risk score: ${cfg.maxTokenRisk} (0-100, lower = safer).`,
    `- The agent borrows at the '${cfg.tier}' tier and MUST repay the full loan on time. Never pick an asset whose thinness/volatility would make a clean exit-to-repay unlikely.`,
    `- Borrowed SOL is held as repay reserve (no re-leverage). You are choosing collateral, not a trade to flip.`,
    "- When nothing is clearly worth the risk, choose action='hold'. Holding is always acceptable and frequently correct.",
    "",
    "Research with assess_token_risk and get_pool_state, then call submit_decision exactly once.",
  ].join("\n");
}

export async function chooseCandidateWithClaude(
  agent: MagpieAgent,
  cfg: AgentConfig,
  menu: MenuItem[],
): Promise<BrainDecision> {
  if (!menu.length) return { action: "hold", reasoning: "empty menu", confidence: 1 };
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: taskPrompt(cfg, menu) },
  ];

  for (let step = 0; step < MAX_TOOL_CALLS; step++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        SYSTEM_PROMPT +
        "\n\nYou are the research/selection brain. You only SELECT collateral; the surrounding code enforces all safety (solvency, deadlines, repay). Prefer caution; HOLD when unsure.",
      tools: TOOLS as never,
      messages: messages as never,
    });

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    for (const block of resp.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use") continue;
      if (block.name === "submit_decision") {
        const d = block.input as Partial<BrainDecision>;
        const conf = Math.max(0, Math.min(1, Number(d.confidence ?? 0)));
        const mint = d.action === "buy" ? String(d.mint ?? "") : undefined;
        return {
          action: d.action === "buy" ? "buy" : "hold",
          mint,
          symbol: menu.find((m) => m.mint === mint)?.symbol,
          reasoning: String(d.reasoning ?? "(none)"),
          confidence: conf,
        };
      }
      const out = await runTool(agent, cfg, String(block.name), (block.input ?? {}) as Record<string, unknown>);
      toolResults.push({ type: "tool_result", tool_use_id: String(block.id), content: JSON.stringify(out) });
    }

    messages.push({ role: "assistant", content: resp.content });
    if (toolResults.length === 0) {
      // Model replied without a tool call and without deciding — nudge once, then hold.
      messages.push({ role: "user", content: "Call submit_decision now with your choice (or action='hold')." });
    } else {
      messages.push({ role: "user", content: toolResults });
    }
  }
  return { action: "hold", reasoning: "tool-call budget exhausted without a decision — holding for safety", confidence: 0 };
}
