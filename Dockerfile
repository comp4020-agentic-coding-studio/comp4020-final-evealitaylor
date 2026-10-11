# syntax = docker/dockerfile:1

# Node 24 runs .ts files directly (type stripping, no build step) — see the
# comment in tsconfig.json. That's why there's no compile stage here: we just
# install prod deps and run the TypeScript source as-is.
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY src ./src
COPY public ./public
COPY README.md ./README.md

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.ts"]
