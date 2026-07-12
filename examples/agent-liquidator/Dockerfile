# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Copy dependency metadata first for layer caching
COPY package.json tsconfig.json ./

# Install all deps (devDeps included for tsx)
RUN npm install

# Copy source
COPY liquidator.ts ./
COPY ../lib/x402-client.ts ./lib/

# Type-check
RUN npx tsc --noEmit

# ── Stage 2: Production ─────────────────────────────────────────────────
FROM gcr.io/distroless/nodejs20-debian12

WORKDIR /app

# Copy node_modules (includes tsx runtime)
COPY --from=builder /build/node_modules /app/node_modules
COPY --from=builder /build/package.json /app/
COPY --from=builder /build/liquidator.ts /app/
COPY --from=builder /build/lib /app/lib

# Use tsx as the entry point (ships with the dependency)
ENTRYPOINT ["node", "/app/node_modules/.bin/tsx", "/app/liquidator.ts"]
