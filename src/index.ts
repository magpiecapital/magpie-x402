/**
 * Local-development server entry. Imports the shared Hono app from
 * src/app.ts and binds it to a port via @hono/node-server.
 *
 * For Vercel serverless deployment, see api/index.ts which uses the
 * same app via hono/vercel adapter — no port binding.
 */
import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 8402;
const PAY_TO = process.env.MAGPIE_PAY_TO;
if (!PAY_TO) {
  console.warn(
    "[magpie-x402] MAGPIE_PAY_TO not set — paid endpoints will reject requests. " +
    "Set it before serving traffic in production.",
  );
}

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[magpie-x402] listening on http://localhost:${info.port}`);
  console.log(`[magpie-x402] MAGPIE_PAY_TO: ${PAY_TO ?? "(unset — paid endpoints disabled)"}`);
});
