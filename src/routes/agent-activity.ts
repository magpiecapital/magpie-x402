import type { Context } from "hono";

/**
 * GET /api/v1/agent/activity
 *
 * Anonymized recent protocol activity — borrows, repays, liquidations.
 * Wallets reduced to `Xxxx…Yyyy` short forms; no usernames, no PII.
 * Free, cached. Designed as the first-touch "is this protocol alive
 * and growing?" signal for any agent or third-party monitor evaluating
 * Magpie before deeper integration.
 */
const BOT_API = process.env.MAGPIE_BOT_API || "https://api.magpie.capital";

export async function agentActivityHandler(c: Context) {
  const limit = c.req.query("limit") ?? "50";
  const url = `${BOT_API}/api/v1/public/activity?limit=${encodeURIComponent(limit)}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return c.json(
      { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }
  const data = await res.json().catch(() => ({ error: "bot_returned_non_json" }));
  return c.json(data as Record<string, unknown>, res.status as never, {
    "Cache-Control": "public, max-age=15, s-maxage=15",
  });
}

/**
 * GET /api/v1/agent/protocol-pulse
 *
 * 24h protocol aggregates: active loans, active borrowers, borrow
 * volume, liquidations. Pure numbers, no per-wallet data. Useful as
 * a healthcheck-with-context for an agent's monitoring loop.
 */
export async function protocolPulseHandler(c: Context) {
  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/public/protocol-pulse`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return c.json(
      { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }
  const data = await res.json().catch(() => ({ error: "bot_returned_non_json" }));
  return c.json(data as Record<string, unknown>, res.status as never, {
    "Cache-Control": "public, max-age=30, s-maxage=30",
  });
}

/**
 * GET /api/v1/agent/leaderboard
 *
 * Top wallets by Magpie credit score (anonymized). Proxy to the bot's
 * existing /api/v1/credit/leaderboard. Same anonymization — no
 * Telegram identities, just `Xxxx…Yyyy` short forms.
 */
export async function leaderboardHandler(c: Context) {
  let res: Response;
  try {
    res = await fetch(`${BOT_API}/api/v1/credit/leaderboard`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return c.json(
      { error: "bot_unreachable", detail: (err as Error).message?.slice(0, 200) },
      502,
    );
  }
  const data = await res.json().catch(() => ({ error: "bot_returned_non_json" }));
  return c.json(data as Record<string, unknown>, res.status as never, {
    "Cache-Control": "public, max-age=60, s-maxage=60",
  });
}
