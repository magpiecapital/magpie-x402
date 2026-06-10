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

// Defense against per-instance memory burn via X-Forwarded-For spoofing:
// each map is capped at MAX_BUCKETS entries. When the cap is hit, we
// evict an entry to make room. Without this, an attacker sending many
// unique X-Forwarded-For values could grow the maps to hundreds of MB
// between cleanup cycles. 10k entries × 2 maps × ~80 B ≈ 1.6 MB ceiling.
const MAX_BUCKETS = 10_000;

function evictOldestIfFull(m: Map<string, Bucket>) {
  if (m.size < MAX_BUCKETS) return;
  // Cheap eviction: drop the first already-expired bucket we see, or
  // failing that, drop the first insertion (Map insertion-order is
  // guaranteed in JS, so head-of-map is also the oldest entry).
  const now = Date.now();
  for (const [k, b] of m) {
    if (b.resetAt < now) { m.delete(k); return; }
  }
  const first = m.keys().next().value;
  if (first !== undefined) m.delete(first);
}

// IP-format guard. Rejects garbage values that would otherwise pollute
// the bucket map. The IP_MAX_LEN cap on the input also bounds the regex
// work — prevents catastrophic backtracking on a malicious header.
const IP_MAX_LEN = 64;
function looksLikeIp(s: string): boolean {
  if (!s || s.length > IP_MAX_LEN) return false;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;                  // IPv4
  if (/^([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(s)) return true; // IPv6
  if (/^::([0-9a-fA-F]{1,4}:?)*$/.test(s)) return true;                  // IPv6 ::shorthand
  return false;
}

function check(buckets: Map<string, Bucket>, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    evictOldestIfFull(buckets);
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
  //
  // We also validate the first value matches an IP pattern — without
  // this an attacker sending many unique X-Forwarded-For garbage
  // values could pollute the bucket map between cleanup cycles. Any
  // unparseable value falls back to the "anon" key so the attacker
  // can DoS themselves but not the rest of the world.
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const xrip = c.req.header("x-real-ip")?.trim();
  let ip = "anon";
  if (xff && looksLikeIp(xff)) ip = xff;
  else if (xrip && looksLikeIp(xrip)) ip = xrip;

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
