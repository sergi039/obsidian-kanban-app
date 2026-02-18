# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

# Install all deps (including dev)
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# Copy source
COPY . .

# Build frontend
WORKDIR /app/apps/web
RUN npx vite build

# Back to root — prune dev deps
WORKDIR /app
RUN npm prune --omit=dev

# Stage 2: Runtime
FROM node:22-slim AS runtime
WORKDIR /app

# Create non-root user
RUN groupadd -r kanban && useradd -r -g kanban -m kanban

# Copy only production deps + built assets + source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/apps/web/dist ./apps/web/dist
COPY --from=builder /app/config.boards.json ./

# Install tsx for runtime (lightweight TS execution)
RUN npm install -g tsx

# Create data dir for SQLite
RUN mkdir -p /app/data && chown -R kanban:kanban /app

USER kanban

ENV PORT=4000
ENV NODE_ENV=production
ENV SERVE_STATIC=1
EXPOSE 4000

CMD ["tsx", "apps/api/src/index.ts"]
