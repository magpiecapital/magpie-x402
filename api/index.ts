/**
 * Vercel serverless entry point.
 *
 * Vercel routes every request matched by vercel.json to this handler.
 * We delegate to the shared Hono app via the hono/vercel adapter.
 *
 * Runtime: Node.js (NOT Edge) — @solana/web3.js depends on Buffer
 * and crypto primitives that don't ship in Edge runtime. Once
 * @solana/kit (web3.js v2) stabilizes and we migrate, we can switch
 * to Edge for an additional latency win.
 */
import app from "../src/app.js";

export const config = { runtime: "nodejs" };

// Vercel's Node.js runtime selects between the classic (req, res) → void
// signature and the modern Web fetch-style signature by inspecting the
// EXPORT NAMES. A default export is treated as classic; named HTTP
// method exports (or a `fetch` named export) opt into fetch-style. We
// route every method through the Hono app so each export is just a thin
// shim calling app.fetch().
const handler = (request: Request): Response | Promise<Response> =>
  app.fetch(request);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
