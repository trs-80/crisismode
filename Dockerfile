# SPDX-License-Identifier: Apache-2.0
# Multi-stage build for CrisisMode spoke

# --- Build stage ---
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# --- Production stage ---
FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN addgroup -S crisismode && adduser -S crisismode -G crisismode
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist/ dist/
USER crisismode
EXPOSE 3000
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/webhook.js"]
