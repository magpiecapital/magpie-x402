# Magpie autonomous agent — always-on deploy (Railway, Fly, any container host).
# Safe by default: it runs in DRY-RUN unless LIVE=1 is set in the environment.
FROM node:20-slim
WORKDIR /app

# Install deps first (better layer caching). tsx is a runtime dep, so --omit=dev is fine.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY . .

# The agent loop keeps the process alive (guardian + cycle timers).
# Set env vars on the host (MAGPIE_PAYER_SECRET, SOLANA_RPC_URL, ANTHROPIC_API_KEY, LIVE, …).
CMD ["npm", "start"]
