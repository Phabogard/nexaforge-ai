FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@10.15.0 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker.io ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/application-builder/package.json apps/application-builder/package.json
COPY packages/ai-core/package.json packages/ai-core/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile

COPY apps/application-builder apps/application-builder
COPY packages/ai-core packages/ai-core
COPY packages/db packages/db
COPY tsconfig.json tsconfig.json

RUN pnpm --filter @nexaforge/application-builder build

CMD ["node", "apps/application-builder/dist/server.js"]
