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
import { handle } from "hono/vercel";
import app from "../src/app.js";

export const config = { runtime: "nodejs" };

export default handle(app);
