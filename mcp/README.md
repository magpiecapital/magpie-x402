# magpie-mcp

**MCP server exposing the Magpie Capital x402 API as native tools for Claude Desktop, Cursor, Windsurf, ChatGPT desktop, and any other MCP-aware agent host.**

Drop one config block into your host and your agent can query Magpie's protocol state, simulate borrows, fetch credit scores, build deposit/withdraw transactions, post conditional borrow intents, and arm self-owned in-vault take-profit / stop-loss exits on its own loans — all as first-class tool calls. No bespoke client code, no API keys.

## What it exposes

26 tools wrapping the x402 endpoints:

**Free reads (work out of the box):**
- `magpie_pool_state` — live LendingPool account
- `magpie_protocol_pulse` — 24h aggregates (active loans, volume, liquidations)
- `magpie_recent_activity` — anonymized borrow/repay/liquidate stream
- `magpie_loan` — single loan by ID
- `magpie_wallet_loans` — all loans for a wallet
- `magpie_tiers` — protocol tier constants
- `magpie_simulate_borrow` — quote a loan without submitting
- `magpie_collateral_eligible` — full collateral catalog
- `magpie_liquidatable` — loans currently liquidatable
- `magpie_credit_leaderboard` — top wallets by credit score
- `magpie_lp_state` — depositor position + pool context
- `magpie_loan_by_pda` — single loan by on-chain loan PDA
- `magpie_pools` — Magpie lending pools (program-version lanes + context)
- `magpie_list_exits` — armed in-vault exit orders for a wallet
- `magpie_modify_exit` — change an armed exit's trigger / params
- `magpie_cancel_exit` — cancel an armed exit (loan stays Active)

**Paid (require a configured Solana keypair):**
- `magpie_credit_score` — 0.001 SOL
- `magpie_token_risk` — 0.001 SOL (per-token risk profile)
- `magpie_build_borrow` — 0.005 SOL (pass `has_exit_arming: true` to route into the V4 in-vault-exit lane)
- `magpie_build_repay` — 0.002 SOL
- `magpie_build_deposit` — 0.002 SOL
- `magpie_build_withdraw` — 0.002 SOL
- `magpie_build_liquidate` — 0.003 SOL (liquidate a past-due loan, receive keeper bounty)
- `magpie_create_intent` — 0.01 SOL (conditional borrow)
- `magpie_get_intent` — 0.0005 SOL (poll)
- `magpie_arm_exit` — 0.001 SOL (arm a self-owned in-vault TP / SL / trailing exit)

When a paid tool fires, the server signs an x402 payment tx locally with your configured keypair and forwards the signature to magpie-x402. The keypair never leaves your machine.

## Self-owned in-vault exits (V4)

Magpie's V4 lane lets an agent arm **its own** take-profit, stop-loss, and trailing exits on **its own** active loan — and the sell happens **in-vault**: when a trigger fires, the collateral is auto-sold and the proceeds (SOL by default, or USDC) accumulate inside that loan's per-loan proceeds vault while the loan stays **Active**. Proceeds only ever reach your wallet through your own borrower-signed repay. There's no fire-and-close, and nothing the protocol can do to move your funds out.

- `magpie_arm_exit` (**0.001 SOL**) — arm a TP / SL / trailing exit on a V4 loan you own. Set `direction` (`above` = take-profit, the default; `below` = stop-loss) and exactly one trigger: `target` (e.g. `"2x"` / `"0.7x"`), `price_usd`, `mc_usd` (e.g. `"5M"`, `"1.2B"`), or `trailing_bps` (stop-loss only). Optional `slippage_bps`, `dest` (`sol` | `usdc`), and `slice` for laddered exits.
- `magpie_modify_exit` (**free**) — retune an armed order's trigger or params in place.
- `magpie_cancel_exit` (**free**) — remove an armed order; the loan is untouched.
- `magpie_list_exits` (**free**) — audit a wallet's armed orders, each with its distance-to-trigger.

Every exit call is authenticated with a dependency-free Ed25519 **signed envelope** built locally from your configured keypair. For `magpie_arm_exit` the envelope is signed by the **same** keypair that pays the 0.001 SOL x402 challenge, so the bot's `payer == signer` invariant holds and only the owner of a loan can arm exits on it. The bot enforces a 5-minute freshness window and nonce-uniqueness on every envelope.

To start a borrow that supports these exits, call `magpie_build_borrow` with `has_exit_arming: true` (routes into V4); leave it `false` for a plain memecoin (V1) borrow.

> RWA / xStock collateral runs on the separate V3 lane, which is launch-gated — on the V3 launch, the same exit tooling will extend to RWA loans.

## Install

Two paths. Both end at the same place.

### Path A — npm (recommended once published)

No clone, no build, no absolute paths in your host config:

```bash
# Verify it runs once before wiring into your host:
npx -y @magpieloans/magpie-mcp --help
```

Then in your host config:

```json
{
  "mcpServers": {
    "magpie": {
      "command": "npx",
      "args": ["-y", "@magpieloans/magpie-mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        "MAGPIE_MCP_PAYER_KEYPAIR": "/path/to/payer-id.json"
      }
    }
  }
}
```

### Path B — from source

If the npm package isn't published yet, or you want to hack on the server:

```bash
git clone git@github.com:magpiecapital/magpie-x402.git
cd magpie-x402/mcp
npm install
npm run build
```

Built executable lands at `mcp/dist/index.js`. Use the absolute path in your host config below.

## Configure your host

Pick the snippet for your host. The `command` + `args` shape changes between npm-install vs source-build; the `env` block is identical.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "magpie": {
      "command": "node",
      "args": ["/ABS/PATH/TO/magpie-x402/mcp/dist/index.js"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        "MAGPIE_MCP_PAYER_KEYPAIR": "/ABS/PATH/TO/payer-id.json"
      }
    }
  }
}
```

Restart Claude Desktop. The Magpie tools appear in the tool picker.

### Cursor

Edit `~/.cursor/mcp.json`. Same shape as Claude Desktop above.

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`. Same shape.

### ChatGPT desktop / any other MCP-aware host

Use the same shape — point the host at `node /ABS/PATH/.../mcp/dist/index.js`, pass env vars through the host's MCP config interface.

## Free-only mode (no keypair)

Omit `MAGPIE_MCP_PAYER_KEYPAIR` and the read-only free tools still work. Paid tools — and the envelope-signed exit tools (`magpie_arm_exit`, `magpie_modify_exit`, `magpie_cancel_exit`, which need the keypair to sign the envelope even though modify/cancel cost nothing) — return a clear error explaining that no payer is configured. Useful for read-only research agents or as a no-friction first install.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MAGPIE_X402_BASE_URL` | `https://x402.magpie.capital` | Override for self-hosted or testnet deployments |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC used to send x402 payment txs. Public RPC rate-limits aggressively — use Helius/Triton/QuickNode for any real volume. |
| `MAGPIE_MCP_PAYER_KEYPAIR` | _(unset)_ | Path to a Solana keypair JSON in the standard `solana-keygen` format. Enables paid tools. |

## Cost ceiling

The keypair you configure is the only place SOL can leave. Per-call costs are exact (the server doesn't ever pay more than the 402 challenge demands), but if you're paranoid about runaway tool-calls during agent experimentation, fund the payer wallet with a small float — say 0.05 SOL — and let it run dry rather than top it up unattended.

## Security model

- The MCP server reads but never modifies your keypair file. The keypair is loaded into memory once at startup; the signature for each paid call happens locally; only the resulting tx signature ever leaves your machine (sent to magpie-x402 in the `X-Payment` header).
- The Magpie x402 service has no way to sign anything on your behalf. Even with a complete compromise of x402.magpie.capital, the worst case is that you pay for tool calls you didn't get useful results from. Your keypair is not exposed.
- For high-stakes write paths (`build-borrow`, `build-deposit`, etc.) the server returns an *unsigned* tx. Your agent receives it as plain text; you decide whether to sign + submit it. The MCP server itself never signs anything besides x402 payment transfers.

## Troubleshooting

**Tool doesn't appear in host UI** — restart the host after editing config. Most hosts only re-read the MCP config on launch.

**402 error on a paid tool** — `MAGPIE_MCP_PAYER_KEYPAIR` is unset or the file doesn't exist. Run `solana-keygen new -o ~/.config/solana/magpie-mcp.json` and point the env var at the result, then `solana transfer …` a small SOL float in.

**`fetch failed` on x402.magpie.capital** — check the URL is reachable from your machine. If you're behind a corporate proxy, set `HTTPS_PROXY` in the same `env` block.

**RPC rate-limit during a paid call** — switch `SOLANA_RPC_URL` to a paid Helius/Triton/QuickNode URL. The default `api.mainnet-beta.solana.com` will throttle under any sustained use.

## For maintainers — publishing to npm

The package is set up for `npm publish` with no additional configuration. From `mcp/`:

```bash
# One-time per machine:
npm login --scope=@magpieloans

# Each release:
# 1. Bump version in package.json (semver)
# 2. Publish — prepublishOnly rebuilds dist/ and chmod +x's the binary
npm publish
```

The package is scoped (`@magpieloans/magpie-mcp`) and `publishConfig.access: "public"` is set, so publish doesn't require any extra flags. The `files` field whitelists what ships — only `dist/`, `README.md`, `LICENSE` end up in the tarball (~9 KB).

Verify the contents before publish:

```bash
npm pack --dry-run
```

## License

MIT.
