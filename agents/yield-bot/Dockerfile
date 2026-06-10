# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev=false
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Mount your keypair at /etc/magpie/keypair.json via secret volume
# and set PAYER_KEYPAIR=/etc/magpie/keypair.json
USER node
CMD ["node", "dist/index.js"]
