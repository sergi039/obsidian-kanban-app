FROM node:22-slim AS base
WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --production=false

# Copy source
COPY . .

# Build frontend
WORKDIR /app/apps/web
RUN npx vite build

# Back to root
WORKDIR /app

# Expose port
ENV PORT=4000
EXPOSE 4000

# Start API server (serves built frontend via static files)
CMD ["npx", "tsx", "apps/api/src/index.ts"]
