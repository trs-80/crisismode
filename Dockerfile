# SPDX-License-Identifier: Apache-2.0
# Multi-stage build for CrisisMode spoke

# --- Build stage ---
FROM node:22-alpine AS build
# Corepack resolves pnpm from package.json#packageManager — do not pin a second
# version here, it is silently ignored.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Git hooks have no meaning in an image; keeps the `prepare` script quiet.
ENV HUSKY=0
RUN corepack enable
WORKDIR /app

# Dependency manifests only, so this layer stays cached until deps change.
# pnpm-workspace.yaml carries the `overrides` block and .pnpmfile.cjs is
# checksummed into pnpm-lock.yaml — `--frozen-lockfile` fails without either.
# packages/*/package.json is required because the root depends on
# @crisismode/agent-sdk via `workspace:*`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/agent-sdk/package.json packages/agent-sdk/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages/ packages/
COPY src/ src/
# `pnpm build` runs scripts/copy-json-assets.mjs to stage JSON assets into dist/.
COPY scripts/ scripts/
RUN pnpm build

# --- Production stage ---
FROM node:22-alpine
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Git hooks have no meaning in an image; keeps the `prepare` script quiet.
ENV HUSKY=0
RUN corepack enable
RUN addgroup -S crisismode && adduser -S crisismode -G crisismode
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/agent-sdk/package.json packages/agent-sdk/
RUN pnpm install --frozen-lockfile --prod

# @crisismode/agent-sdk installs as a symlink into packages/agent-sdk, so the
# workspace package needs its compiled output present at runtime.
COPY --from=build /app/packages/agent-sdk/dist/ packages/agent-sdk/dist/
COPY --from=build /app/dist/ dist/

USER crisismode
EXPOSE 3000
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/webhook.js"]
