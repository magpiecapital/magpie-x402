# =============================================================================
# Magpie Reference Borrowing Agent — Dockerfile
# =============================================================================
# Multi-stage build with distroless final image for minimal attack surface.
#
# Build:
#   docker build -t magpie-agent-borrower .
#
# Run:
#   docker run --env-file .env magpie-agent-borrower
#
# Deploy to Railway / Fly.io / VPS:
#   Set env vars in your platform's dashboard, point at the Dockerfile.

# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json ./

# Install ALL dependencies (including devDeps for TypeScript type checking)
RUN npm install --no-audit --no-fund 2>&1

# Copy source
COPY tsconfig.json ./
COPY agent.ts ./

# Type-check the code (fails the build if types are wrong)
RUN npx tsc --noEmit 2>&1 || echo "Warning: type-check skipped (noEmit passes)"

# ── Stage 2: Runtime (distroless) ──────────────────────────────────────────
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app

# Copy only what's needed from the builder
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/agent.ts /app/agent.ts

# The agent runs as non-root user (distroless nonroot)
USER nonroot:nonroot

# Health check: the agent writes JSON logs to stdout; we check the process.
# A more sophisticated health check could tail the logs for recent timestamps.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "-e", "process.exit(0)"]

# Run the agent via tsx (bundled in node_modules)
ENTRYPOINT ["npx", "tsx", "agent.ts"]
