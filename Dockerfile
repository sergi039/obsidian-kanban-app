# node:22-slim (Debian bookworm), multi-arch index pinned by digest; bump it on purpose
ARG NODE_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Stage 1: Build
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# Install pnpm, pinned to the version used in development
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

# Copy workspace config + lockfile + every workspace package manifest
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mcp/package.json apps/mcp/

# Install all deps (including dev)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build frontend
WORKDIR /app/apps/web
RUN pnpm exec vite build

# Back to root — keep production deps only. `pnpm prune` does not support workspaces
# (it empties apps/api/node_modules), so reinstall with --prod as pnpm's docs advise;
# CI=true because without a TTY pnpm refuses to remove a modules directory
WORKDIR /app
RUN rm -rf node_modules apps/*/node_modules && CI=true pnpm install --frozen-lockfile --prod

# Stage 2: Runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Create non-root user
RUN groupadd -r kanban && useradd -r -g kanban -m kanban

# Copy only production deps + built assets + source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/config.boards.example.json ./
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Data dir for SQLite and backups, config dir for config.boards.json (both mounted by docker-compose.yml)
RUN mkdir -p /app/data /config && chown -R kanban:kanban /app /config

USER kanban

ENV PORT=4000
# Listen on every interface of the container; docker-compose.yml publishes the port on the host's loopback only
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV SERVE_STATIC=1
ENV KANBAN_CONFIG_PATH=/config/config.boards.json
EXPOSE 4000

# The API runs from TypeScript source through tsx (a runtime dependency of @kanban/api)
CMD ["/app/apps/api/node_modules/.bin/tsx", "/app/apps/api/src/index.ts"]
