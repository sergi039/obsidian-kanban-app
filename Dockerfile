# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace config + lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Install all deps (including dev)
RUN pnpm install --frozen-lockfile

# Copy source
COPY . .

# Build frontend
WORKDIR /app/apps/web
RUN pnpm exec vite build

# Back to root — prune dev deps
WORKDIR /app
RUN pnpm prune --prod

# Stage 2: Runtime
FROM node:22-slim AS runtime
WORKDIR /app

# Create non-root user
RUN groupadd -r kanban && useradd -r -g kanban -m kanban

# Copy only production deps + built assets + source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Create data dir for SQLite
RUN mkdir -p /app/data && chown -R kanban:kanban /app

USER kanban

ENV PORT=4000
ENV NODE_ENV=production
ENV SERVE_STATIC=1
EXPOSE 4000

# Use tsx for now (TS source); TODO: pre-compile to JS
CMD ["npx", "tsx", "apps/api/src/index.ts"]
