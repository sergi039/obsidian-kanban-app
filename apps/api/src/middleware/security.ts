/**
 * Security middleware: Host/Origin check, API token auth, body size limit, CORS origin restriction, security headers.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { IncomingMessage } from 'node:http';
import { loadConfig } from '../config.js';

const MAX_BODY_SIZE = Number(process.env.MAX_BODY_SIZE) || 1_048_576; // 1 MB default
const MAX_WS_CONNECTIONS = Number(process.env.MAX_WS_CONNECTIONS) || 50;

/** Names this server is reached by on the machine itself; the local server speaks plain HTTP. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOGGED_HEADER_MAX = 200;

/** A Host header in canonical `host[:port]` form, or null (missing, malformed, userinfo, path, `127.1`…). */
function parseHostHeader(host: string | undefined): URL | null {
  if (!host) return null;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return null;
  }
  return url.host === host.toLowerCase() ? url : null;
}

/** A serialized http(s) origin as browsers send it, or null ("null", file:, a path…). */
function parseOriginHeader(origin: string): URL | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin === origin ? url : null;
}

/**
 * Why a request's Host/Origin pair is refused, or null when it may proceed.
 * The API has no token on loopback installs, so this is what keeps other web pages out:
 * - Host must name this server: a loopback name or the `publicUrl` host. A DNS-rebinding page
 *   cannot forge that name; the port is not compared, as proxies (vite, `--port`) present their own.
 * - A present Origin must be the exact origin the server is reached at, scheme included
 *   (`http://<loopback host>` or the `publicUrl` origin), or an entry of the CORS allowlist.
 *   A cross-site browser write always carries Origin; curl, Node fetch and agents send none.
 */
export function hostOriginRefusal(
  host: string | undefined,
  origin: string | undefined,
  publicUrl: string | undefined,
  corsOrigins: string[],
): string | null {
  const hostUrl = parseHostHeader(host);
  if (!hostUrl) return 'Host header missing or malformed';
  const isLoopback = LOOPBACK_HOSTNAMES.has(hostUrl.hostname);
  const publicOrigin = publicUrl ? new URL(publicUrl) : null;
  const isPublic = publicOrigin !== null && hostUrl.hostname === publicOrigin.hostname;
  if (!isLoopback && !isPublic) return 'Host not allowed';

  if (origin === undefined) return null;
  const originUrl = parseOriginHeader(origin);
  if (!originUrl) return 'Origin malformed';
  if (corsOrigins.includes(origin)) return null;
  if (isLoopback && origin === `http://${hostUrl.host}`) return null;
  if (isPublic && origin === publicOrigin.origin) return null;
  return 'Origin not allowed';
}

/** One log line per refusal; header values are length-capped and JSON-quoted (no log injection). */
export function logHostOriginRefusal(kind: 'http' | 'ws', reason: string, host: string | undefined, origin: string | undefined): void {
  const quote = (value: string | undefined) => (value === undefined ? 'absent' : JSON.stringify(value.slice(0, LOGGED_HEADER_MAX)));
  console.warn(`[security] Refused ${kind} request: ${reason} (host=${quote(host)} origin=${quote(origin)})`);
}

/**
 * Refuses requests from other web pages: a foreign Origin (cross-site form/fetch) or a Host that is
 * not this server (DNS rebinding). Applies to every path and independently of API_TOKEN.
 * Reads the Host header, never `c.req.url`: the node bridge in index.ts always builds that URL on localhost.
 */
export function hostOriginGuard(getPublicUrl: () => string | undefined = () => loadConfig().publicUrl): MiddlewareHandler {
  const corsOrigins = getCorsOrigins();
  return async (c, next) => {
    const host = c.req.header('host');
    const origin = c.req.header('origin');
    const reason = hostOriginRefusal(host, origin, getPublicUrl(), corsOrigins);
    if (reason) {
      logHostOriginRefusal('http', reason, host, origin);
      return c.json({ error: 'Request refused: host or origin not allowed' }, 403);
    }
    return next();
  };
}

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

    // Ingest routes have a stricter fail-closed middleware with INGEST_API_TOKEN fallback.
    if (c.req.path.startsWith('/api/inbox/')) return next();

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
 * Ingest routes are intended for external agents and fail closed.
 * They require a dedicated INGEST_API_TOKEN.
 */
export function ingestTokenAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = process.env.INGEST_API_TOKEN;
    if (!token) {
      return c.json({ error: 'INGEST_API_TOKEN is required for ingest routes' }, 401);
    }

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
