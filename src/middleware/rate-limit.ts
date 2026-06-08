import type { MiddlewareHandler } from "hono";

/**
 * In-memory token-bucket-ish rate limiter. Per-IP, two-window
 * (minute + hour). NOT for multi-instance production — use Upstash
 * Redis or similar if/when this scales beyond one node.
 *
 * Why we have this from day one: an unauthenticated public API
 * without rate limits is an abuse magnet. Even with x402 payments
 * gating most endpoints, the FREE endpoints (health, payment-challenge
 * 402 responses, etc.) need a backstop or they'll get DoS'd.
 */

interface Bucket { count: number; resetAt: number; }
const minuteBuckets = new Map<string, Bucket>();
const hourBuckets = new Map<string, Bucket>();

const PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN) || 60);
const PER_HOUR = Math.max(PER_MIN, Number(process.env.RATE_LIMIT_PER_HOUR) || 600);

function check(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { allowed: false, retryMs: b.resetAt - now };
  }
  return { allowed: true, retryMs: 0 };
}

// Prune dead buckets every 5 min to bound memory
setInterval(() => {
  const now = Date.now();
  for (const m of [minuteBuckets, hourBuckets]) {
    for (const [k, b] of m) if (b.resetAt < now - 60_000) m.delete(k);
  }
}, 5 * 60_000).unref?.();

export const rateLimit: MiddlewareHandler = async (c, next) => {
  // Best-effort IP derivation. Trust X-Forwarded-For only because
  // we expect to deploy behind Vercel/Railway/Cloudflare. If you
  // deploy bare-metal, strip the header trust at the edge.
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "anon";

  const m = check(minuteBuckets, ip, PER_MIN, 60_000);
  if (!m.allowed) {
    return c.json(
      { error: "rate_limited", scope: "minute", retry_after_ms: m.retryMs },
      429,
      { "Retry-After": String(Math.ceil(m.retryMs / 1000)) },
    );
  }
  const h = check(hourBuckets, ip, PER_HOUR, 60 * 60_000);
  if (!h.allowed) {
    return c.json(
      { error: "rate_limited", scope: "hour", retry_after_ms: h.retryMs },
      429,
      { "Retry-After": String(Math.ceil(h.retryMs / 1000)) },
    );
  }
  await next();
};
