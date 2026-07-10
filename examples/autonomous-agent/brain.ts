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
import { cachedTokenRisk } from "./risk-cache.js";

export interface MenuItem {
  mint: string;
  symbol: string;
  decimals: number;
  category: string;
  /** True if the wallet ALREADY holds this — collateralize it directly, no buy. */
  held?: boolean;
}

export interface BrainDecision {
  action: "buy" | "hold";
  mint?: string;
  symbol?: string;
  reasoning: string;
  confidence: number; // 0..1
  /** Loan TERM the brain chose for THIS loan. Clamped to a valid tier by the caller; undefined => config default. */
  tier?: "express" | "quick" | "standard";
  /**
   * Sizing CONVICTION 0.4..0.95 — the fraction of deployable capital to put behind
   * THIS pick. Lets the brain probe small on speculative ideas and lean in on strong
   * ones instead of deploying a fixed amount every cycle. Clamped by the caller;
   * undefined => the caller's default fraction.
   */
  sizeFraction?: number;
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
        term: {
          type: "string",
          enum: ["express", "quick", "standard"],
          description:
            "Loan TERM to match your thesis: express=2 days (fast momentum / tight setup), quick=3 days (medium), standard=7 days (needs room, or a steadier RWA). VARY this across loans — pick the term the thesis actually needs, don't default to one.",
        },
        size: {
          type: "number",
          description:
            "Sizing CONVICTION from 0.4 to 0.95 — the fraction of available capital to deploy on THIS pick. 0.4-0.55 = small probe on a speculative idea, 0.7-0.8 = solid setup, 0.9-0.95 = high-conviction, lean in. Match size to how strong the setup is; don't deploy the same amount every time.",
        },
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
  menu: MenuItem[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  try {
    if (name === "assess_token_risk") {
      const mint = String(input.mint);
      if (cfg.dryRun) {
        // No paid risk call in dry-run. Return a CATEGORY HEURISTIC so the brain
        // can rehearse a full decision end-to-end (RWAs/stocks are materially
        // safer than memecoins). LIVE replaces this with the real paid oracle.
        const cat = menu.find((m) => m.mint === mint)?.category ?? "memecoin";
        const estimate = cat === "memecoin" ? 50 : 25;
        return {
          mint,
          risk_score: estimate,
          category: cat,
          estimate: true,
          note: "DRY-RUN heuristic estimate (no payment made). Treat it as a usable score to rehearse the full borrow flow; in LIVE this is a real paid risk assessment.",
        };
      }
      // Cached: a token is paid for (0.001 SOL) at most once per RISK_CACHE_TTL_MIN,
      // even though the brain re-evaluates the same mints every cycle.
      const r = await cachedTokenRisk(agent, mint);
      return r.raw;
    }
    if (name === "get_pool_state") return await agent.poolState();
    return { error: `unknown tool ${name}` };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/**
 * SECURITY — token symbols/names are attacker-authored free text that flows into
 * the Claude prompt. Strip newlines and control chars, drop characters used to
 * fake prompt structure, and truncate, so a token named e.g. "ignore all prior
 * instructions" can't break out of its line. The model output is independently
 * constrained to on-allowlist mints with a code-fixed buy size, so this is
 * defense-in-depth, not the only guard.
 */
function safeSym(s: string | undefined): string {
  if (!s) return "?";
  return (
    s
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ") // control chars + newlines
      .replace(/[`{}[\]<>|]/g, "") // chars used to fake code/role framing
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32) || "?"
  );
}

function taskPrompt(cfg: AgentConfig, menu: MenuItem[]): string {
  const list = menu
    .map((m) => `- ${safeSym(m.symbol)}  ${m.mint}  [${m.category}]${m.held ? "  (already held/recently used — REPETITIVE; pick ONLY if nothing fresh qualifies)" : "  (FRESH — not currently held)"}`)
    .join("\n");
  return [
    "Choose ONE collateral asset to collateralize (buy first if not already held), or decide to HOLD.",
    "",
    "ALLOWED MENU — you may ONLY pick a mint from this list; anything else is rejected:",
    list,
    "",
    "BE FORWARD-THINKING — your JOB is to find the NEXT winner, not to re-borrow the same safe bag. A monotonous stream of near-identical loans (same asset, same size, same term) is the #1 FAILURE mode and is unacceptable. On every axis, show range and intent:",
    "  • ASSET: pick a FRESH, forward-looking, high-quality name you have NOT used recently — chase genuine momentum and upside, not the most-boring safest coin. Real breadth across the supported universe is MANDATORY. Re-picking an already-held or recently-used token is a LAST RESORT, allowed ONLY if literally nothing fresh qualifies. Saving a small buy fee is NEVER a reason to repeat.",
    "  • SIZE (`size` 0.4-0.95): match sizing to conviction. Probe a speculative idea small (0.4-0.55); lean into a strong, liquid setup (0.85-0.95). Do NOT deploy the same fraction every cycle.",
    "  • TERM (`term`): match the horizon to the thesis. A fast momentum/mean-reversion play wants express (2d); a steadier RWA or a thesis that needs room wants standard (7d); quick (3d) is the middle. Rotate — don't default to one term.",
    "  • FORWARD-THINKING ALPHA: favor FRESH names with genuine momentum and upside that also have enough liquidity for a clean exit-to-repay. The best pick is a new, high-conviction mover — never the safest-but-repetitive recycle. If two names tie, take the one you have NOT touched recently.",
    "",
    cfg.dryRun
      ? "DRY RUN — this is a no-funds REHEARSAL. The risk scores you get back are heuristic estimates; treat them as usable and prefer to make a real PICK (especially an ALREADY HELD asset) so the full borrow flow can be validated. Nothing moves. Only HOLD if every option is genuinely unsuitable."
      : "",
    "Constraints:",
    `- Preferred category: ${cfg.preferredCategory}. RWAs (stocks) are far safer; memecoins are high-risk.`,
    `- Max acceptable Magpie risk score: ${cfg.maxTokenRisk} (0-100, lower = safer).`,
    `- Whatever 'term' you choose, the loan MUST be repaid in full on time — the guardian repays automatically, well before due. A longer term never rescues an illiquid pick: never choose an asset whose thinness/volatility would make a clean exit-to-repay unlikely.`,
    `- 'size' is bounded by available capital + solvency reserves regardless of what you ask for; asking bigger never risks a default (the code clamps it). So size honestly to conviction.`,
    `- Borrowed SOL is held as repay reserve (no re-leverage) — but picking FRESH, forward-looking collateral each cycle IS the alpha; build a diverse, forward-looking book, never park in one safe bag.`,
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
        "\n\nYou are the research/selection brain. You only SELECT collateral; the surrounding code enforces all safety (solvency, deadlines, repay, risk limits). Be FORWARD-THINKING and seek fresh alpha with real breadth — the code already caps your risk, so your job is to find the next mover, not to hug the safest repetitive bag. HOLD only when nothing fresh genuinely qualifies.",
      tools: TOOLS as never,
      messages: messages as never,
    });

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    for (const block of resp.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use") continue;
      if (block.name === "submit_decision") {
        const raw = (block.input ?? {}) as Record<string, unknown>;
        const d = raw as Partial<BrainDecision>;
        const conf = Math.max(0, Math.min(1, Number(d.confidence ?? 0)));
        const mint = d.action === "buy" ? String(d.mint ?? "") : undefined;
        // TERM — accept only a valid tier; anything else => undefined (caller uses config default).
        const termRaw = String(raw.term ?? "");
        const tier = (["express", "quick", "standard"] as const).includes(termRaw as never)
          ? (termRaw as BrainDecision["tier"])
          : undefined;
        // SIZE — clamp conviction to [0.4, 0.95]; non-numeric => undefined (caller default).
        const sizeNum = Number(raw.size);
        const sizeFraction = Number.isFinite(sizeNum) ? Math.max(0.4, Math.min(0.95, sizeNum)) : undefined;
        return {
          action: d.action === "buy" ? "buy" : "hold",
          mint,
          symbol: menu.find((m) => m.mint === mint)?.symbol,
          reasoning: String(d.reasoning ?? "(none)"),
          confidence: conf,
          tier,
          sizeFraction,
        };
      }
      const out = await runTool(agent, cfg, menu, String(block.name), (block.input ?? {}) as Record<string, unknown>);
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

// ───────────────────────────────────────────────────────────────────────────
// TRADE BRAIN — manage a spot memecoin book: decide EXITS (sell) and ENTRIES (buy).
// ───────────────────────────────────────────────────────────────────────────

/** A position the agent currently holds, already marked to market. */
export interface TradePosition {
  mint: string;
  symbol: string;
  /** Current SOL value of the position (lamports), from a live Jupiter quote. */
  valueLamports: bigint;
  /** SOL originally spent (lamports), if a cost basis is known (else undefined). */
  costLamports?: bigint;
  /** Profit/loss vs cost basis as a percent, if known. */
  pnlPct?: number;
  /** Minutes since first acquired, if known. */
  ageMin?: number;
}

/** A memecoin the agent MAY buy this cycle. */
export interface TradeCandidate {
  mint: string;
  symbol: string;
  category: string;
}

export interface TradeDecision {
  sells: string[]; // mints from the positions list
  buys: string[]; // mints from the candidate menu
  /** OPTIONAL per-buy conviction multiplier keyed by mint (0.5=probe … 2.0=lean in). Clamped by the engine. */
  sizings?: Record<string, number>;
  reasoning: string;
  confidence: number;
}

const TRADE_TOOLS = [
  {
    name: "assess_token_risk",
    description:
      "Magpie's risk profile for a mint: risk_score 0-100 (lower=safer), dimension breakdown, and market_data (liquidity, 24h volume, market cap). Cached — call freely. In dry-run it's a category stub.",
    input_schema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] },
  },
  {
    name: "submit_trades",
    description: "Submit your FINAL trade decisions. Call exactly once when done researching.",
    input_schema: {
      type: "object",
      properties: {
        sells: {
          type: "array",
          items: { type: "string" },
          description: "Mints of CURRENT positions to sell now (must be from the positions list). [] to hold them all.",
        },
        buys: {
          type: "array",
          items: { type: "string" },
          description: "Mints of CANDIDATES to buy now (must be from the candidate menu). [] to buy nothing.",
        },
        sizings: {
          type: "object",
          additionalProperties: { type: "number" },
          description:
            "OPTIONAL per-buy conviction, keyed by mint: 0.5 = half-size probe on a speculative idea, 1.0 = normal, up to 2.0 = double-size on a high-conviction setup. Size your best ideas bigger and your speculative ones smaller instead of a flat amount. Omit a mint (or use 1.0) for normal size. The engine clamps to solvency regardless.",
        },
        reasoning: { type: "string" },
        confidence: { type: "number", description: "0..1" },
      },
      required: ["sells", "buys", "reasoning", "confidence"],
    },
  },
] as const;

function tradePrompt(
  cfg: AgentConfig,
  positions: TradePosition[],
  candidates: TradeCandidate[],
  roomForBuys: number,
): string {
  const fmtSol = (l: bigint) => (Number(l) / 1e9).toFixed(4);
  const posList = positions.length
    ? positions
        .map(
          (p) =>
            `- ${safeSym(p.symbol)}  ${p.mint}  value ${fmtSol(p.valueLamports)} SOL` +
            (p.pnlPct != null ? `  PnL ${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%` : "  (cost basis unknown)") +
            (p.ageMin != null ? `  age ${p.ageMin}m` : ""),
        )
        .join("\n")
    : "  (no open positions)";
  const candList = candidates.length
    ? candidates.map((c) => `- ${safeSym(c.symbol)}  ${c.mint}  [${c.category}]`).join("\n")
    : "  (no candidates this cycle)";
  return [
    "You manage a SMALL SPOT memecoin trade book. Decide which CURRENT positions to SELL",
    "(take profit, cut a loser, or exit a broken thesis) and which CANDIDATES to BUY.",
    "Doing nothing (sells:[], buys:[]) is always allowed and frequently correct.",
    "",
    "CURRENT POSITIONS (already marked to market):",
    posList,
    "",
    "BUY CANDIDATES — you may ONLY buy a mint from this list:",
    candList,
    "",
    "Rules:",
    `- A mechanical stop-loss (-${cfg.tradeStopLossPct}%) and take-profit (+${cfg.tradeTakeProfitPct}%) ALREADY run before you,`,
    "  so focus on thesis: is momentum/liquidity deteriorating (sell), or is a candidate genuinely worth a fresh entry?",
    `- Room for at most ${roomForBuys} NEW position(s) this cycle (book cap ${cfg.maxPositions}). Buying 0 is fine.`,
    `- Base buy size is ~${fmtSol(cfg.tradePositionLamports)} SOL; use \`sizings\` to scale each buy by CONVICTION (0.5 = half-size probe … 2.0 = double-size on a strong, liquid setup). Size your best ideas bigger and speculative ones smaller instead of a flat amount. Max acceptable risk score: ${cfg.maxTokenRisk} (lower=safer).`,
    "- Memecoins are brutal and most go to zero. Be selective; thin liquidity = no clean exit. When unsure, don't buy.",
    cfg.dryRun ? "- DRY RUN: nothing moves; risk scores are heuristic stubs. Still make realistic calls to validate the loop." : "",
    "",
    "Research candidates with assess_token_risk (check market_data liquidity/volume), then call submit_trades exactly once.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Ask Claude to manage the book. The model can ONLY sell mints it already holds
 * and buy mints from the candidate menu; the trade engine enforces sizing,
 * solvency, the position cap, and the risk gate regardless of what it returns.
 */
export async function decideTradesWithClaude(
  agent: MagpieAgent,
  cfg: AgentConfig,
  positions: TradePosition[],
  candidates: TradeCandidate[],
  roomForBuys: number,
): Promise<TradeDecision> {
  const empty: TradeDecision = { sells: [], buys: [], reasoning: "nothing to do", confidence: 1 };
  if (!positions.length && !candidates.length) return empty;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const posMints = new Set(positions.map((p) => p.mint));
  const candMints = new Set(candidates.map((c) => c.mint));

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    { role: "user", content: tradePrompt(cfg, positions, candidates, roomForBuys) },
  ];

  for (let step = 0; step < MAX_TOOL_CALLS; step++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        SYSTEM_PROMPT +
        "\n\n── CONTEXT SHIFT — READ CAREFULLY ──\n" +
        "You are now the trading brain for a SPOT memecoin book. This is NOT borrowing: the wallet trades its OWN SOL, there is NO loan, NO repay, and NO never-default concern in this task. The lending facts above are background about the protocol only — do NOT apply 'hold SOL idle as repay reserve' here. Deploying capital into genuinely good setups is the JOB; sitting 100% in SOL forever is a failure mode too. " +
        "You only SELECT what to buy/sell; the surrounding code enforces position sizing, solvency, the position cap, slippage, and a mechanical stop-loss/take-profit. Be selective (most memecoins go to zero; thin liquidity = no clean exit), but when a candidate is genuinely worth the risk within the rails, BUY it.",
      tools: TRADE_TOOLS as never,
      messages: messages as never,
    });

    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    for (const block of resp.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use") continue;
      if (block.name === "submit_trades") {
        const raw = (block.input ?? {}) as Record<string, unknown>;
        const d = raw as Partial<TradeDecision>;
        const sells = (Array.isArray(d.sells) ? d.sells : []).map(String).filter((m) => posMints.has(m));
        const buys = (Array.isArray(d.buys) ? d.buys : []).map(String).filter((m) => candMints.has(m));
        // Per-buy conviction, clamped 0.5..2.0, only for mints we're actually buying.
        const rawSizings = (raw.sizings ?? {}) as Record<string, unknown>;
        const sizings: Record<string, number> = {};
        for (const m of buys) {
          const v = Number(rawSizings[m]);
          if (Number.isFinite(v)) sizings[m] = Math.max(0.5, Math.min(2, v));
        }
        return {
          sells,
          buys,
          sizings,
          reasoning: String(d.reasoning ?? "(none)"),
          confidence: Math.max(0, Math.min(1, Number(d.confidence ?? 0))),
        };
      }
      // assess_token_risk only (no pool state needed for spot trading).
      const out =
        block.name === "assess_token_risk"
          ? await runTool(agent, cfg, candidates.map((c) => ({ ...c, decimals: 0 })), "assess_token_risk", (block.input ?? {}) as Record<string, unknown>)
          : { error: `unknown tool ${String(block.name)}` };
      toolResults.push({ type: "tool_result", tool_use_id: String(block.id), content: JSON.stringify(out) });
    }

    messages.push({ role: "assistant", content: resp.content });
    if (toolResults.length === 0) {
      messages.push({ role: "user", content: "Call submit_trades now (sells:[] buys:[] is a valid 'do nothing')." });
    } else {
      messages.push({ role: "user", content: toolResults });
    }
  }
  return { ...empty, reasoning: "tool-call budget exhausted — doing nothing for safety", confidence: 0 };
}
