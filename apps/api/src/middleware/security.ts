/**
 * Security middleware: API token auth, body size limit, CORS origin restriction.
 */
import type { MiddlewareHandler } from 'hono';

const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE) || 1_048_576; // 1 MB default

/**
 * API token authentication middleware.
 * Skips GET/HEAD/OPTIONS (read-only) and /api/health.
 * Requires `Authorization: Bearer <token>` header for mutating requests.
 * Disabled when API_TOKEN env is not set (local dev without auth).
 */
export function apiTokenAuth(): MiddlewareHandler {
  const token = process.env.API_TOKEN;

  return async (c, next) => {
    // Skip if no token configured (local dev)
    if (!token) return next();

    // Allow read-only and preflight
    const method = c.req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

    // Allow health check
    if (c.req.path === '/api/health') return next();

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: 'Authorization header required' }, 401);
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== token) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    return next();
  };
}

/**
 * Request body size limiter.
 * Returns 413 if Content-Length exceeds limit.
 * Also checks actual body size for chunked transfers.
 */
export function bodyLimit(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return next();

    const contentLength = c.req.header('Content-Length');
    if (contentLength && Number(contentLength) > MAX_BODY_SIZE) {
      return c.json({ error: 'Request body too large', maxBytes: MAX_BODY_SIZE }, 413);
    }

    return next();
  };
}

/**
 * Build CORS origin allowlist from CORS_ORIGIN env.
 * Format: comma-separated origins, e.g. "http://localhost:3456,http://localhost:4000"
 * Default: localhost origins only.
 */
export function getCorsOrigins(): string[] {
  const envOrigins = process.env.CORS_ORIGIN;
  if (envOrigins) {
    return envOrigins.split(',').map((o) => o.trim()).filter(Boolean);
  }
  // Default: localhost only
  return ['http://localhost:3456', 'http://localhost:4000', 'http://127.0.0.1:3456', 'http://127.0.0.1:4000'];
}
