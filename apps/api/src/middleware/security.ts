/**
 * Security middleware: API token auth, body size limit, CORS origin restriction, security headers.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';

const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE) || 1_048_576; // 1 MB default
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS) || 50;

/** Timing-safe token comparison to prevent timing attacks. */
function safeTokenCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * API token authentication middleware.
 * When API_TOKEN is set, ALL endpoints require authentication (including reads).
 * Only /api/health and OPTIONS (preflight) are exempt.
 */
let _warnedNoToken = false;

export function apiTokenAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = process.env.API_TOKEN;

    // Skip if no token configured (local dev)
    if (!token) {
      if (!_warnedNoToken) {
        console.warn('[security] WARNING: API_TOKEN not set — all endpoints are unauthenticated. Set API_TOKEN env for production.');
        _warnedNoToken = true;
      }
      return next();
    }

    // Allow preflight
    if (c.req.method.toUpperCase() === 'OPTIONS') return next();

    // Allow health check
    if (c.req.path === '/api/health') return next();

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json({ error: 'Authorization header required' }, 401);
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !safeTokenCompare(parts[1], token)) {
      return c.json({ error: 'Invalid token' }, 401);
    }

    return next();
  };
}

/**
 * Validate WebSocket upgrade request authentication.
 * Returns true if authenticated, false otherwise.
 */
export function validateWsAuth(req: IncomingMessage): boolean {
  const token = process.env.API_TOKEN;
  if (!token) return true; // No auth configured

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer' && safeTokenCompare(parts[1], token)) {
      return true;
    }
  }

  // Check ?token= query parameter (for browser WebSocket which can't set headers)
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeTokenCompare(queryToken, token)) {
    return true;
  }

  return false;
}

/** Maximum allowed WebSocket connections. */
export { MAX_WS_CONNECTIONS };

/**
 * Request body size limiter.
 * Returns 413 if Content-Length exceeds limit.
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
 * Security headers middleware.
 * Sets standard security headers on all responses.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('X-XSS-Protection', '0'); // Disabled per modern best practice
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
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
