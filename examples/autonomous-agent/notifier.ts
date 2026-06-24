/**
 * notifier.ts — passive monitoring. DMs every meaningful action to Telegram so
 * the operator can watch the agent work without touching it. Console is always
 * written too. A notify failure NEVER breaks the agent (best-effort, swallowed).
 *
 * Setup (optional): make a bot with @BotFather, get its token, get your numeric
 * chat id (DM @userinfobot), then set:
 *   AGENT_NOTIFY_TELEGRAM_TOKEN=123:abc
 *   AGENT_NOTIFY_TELEGRAM_CHAT=<your numeric id>
 * No token set => console-only (still fully functional).
 */
import type { AgentConfig } from "./config.js";

export type NotifyKind = "boot" | "cycle" | "brain" | "buy" | "borrow" | "repay" | "hold" | "info" | "warn" | "error";

const ICON: Record<NotifyKind, string> = {
  boot: "🤖", cycle: "🔄", brain: "🧠", buy: "🛒", borrow: "🏦",
  repay: "✅", hold: "✋", info: "ℹ️", warn: "⚠️", error: "🚨",
};

export class Notifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly dryRun: boolean;

  constructor(cfg: AgentConfig) {
    this.token = cfg.notify.telegramToken;
    this.chatId = cfg.notify.telegramChatId;
    this.dryRun = cfg.dryRun;
  }

  get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /** Fire-and-forget; awaited where convenient but never allowed to throw. */
  async send(kind: NotifyKind, text: string): Promise<void> {
    const line = `${ICON[kind]} ${this.dryRun ? "[DRY] " : ""}${text}`;
    // eslint-disable-next-line no-console
    console.log(line);
    if (!this.enabled) return;
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: line,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      /* monitoring must never break the agent */
    }
  }
}
