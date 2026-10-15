/**
 * Google consent for the personal calendar account, now with Gmail headers (backlog B-2).
 *
 * The API reads the personal Google calendar, and email follow-up threads, with a
 * refresh token stored in the account's `tokenFile`. This tool replaces that token with
 * one that also carries `gmail.metadata`: an installed-app OAuth flow (RFC 8252) on a
 * 127.0.0.1 loopback port with PKCE and a random state. The new grant is kept only if it
 * has a refresh token, both scopes and the configured account's verified address; it is
 * written with writeSecretFileAtomic. Nothing secret is printed.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CalendarAccount } from './config.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
export const CONSENT_SCOPES = ['openid', 'email', CALENDAR_SCOPE, GMAIL_SCOPE];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
export const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export interface ConsentRequest {
  url: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

/** The consent URL with PKCE (S256) and a random state, for a loopback redirect on `port`. */
export function buildConsentRequest(clientId: string, accountEmail: string, port: number): ConsentRequest {
  const codeVerifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const redirectUri = `http://127.0.0.1:${port}/`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CONSENT_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    login_hint: accountEmail,
    state,
    code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
    code_challenge_method: 'S256',
  });
  return { url: `${AUTH_URL}?${params}`, state, codeVerifier, redirectUri };
}

export type CallbackOutcome =
  | { kind: 'ignore'; status: 400 | 404 }
  | { kind: 'denied'; error: string }
  | { kind: 'code'; code: string };

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** What a request to the loopback server means; only `/` with the right state counts. */
export function readCallback(rawUrl: string, expectedState: string): CallbackOutcome {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return { kind: 'ignore', status: 400 }; // a malformed request line must not end the flow
  }
  if (url.pathname !== '/') return { kind: 'ignore', status: 404 };
  const state = url.searchParams.get('state');
  if (!state || !sameSecret(state, expectedState)) return { kind: 'ignore', status: 400 };
  const error = url.searchParams.get('error');
  if (error) return { kind: 'denied', error };
  const code = url.searchParams.get('code');
  if (!code) return { kind: 'ignore', status: 400 };
  return { kind: 'code', code };
}

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  refresh_token_expires_in?: number;
}

/** The id_token payload; it comes straight from Google's token endpoint over TLS. */
export function idTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('the id_token has no payload');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    // The parser's own message quotes the payload; never let it reach the terminal.
    throw new Error('the id_token payload is not JSON');
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('the id_token payload is not an object');
  return claims as Record<string, unknown>;
}

export interface AcceptedGrant {
  refreshToken: string;
  accessToken: string;
  scope: string;
  refreshTokenExpiresAt: string | null;
}

/** Keep the grant only if it is complete and belongs to the configured account; else throw why. */
export function acceptGrant(response: TokenResponse, account: CalendarAccount, now: Date): AcceptedGrant {
  if (!response.refresh_token) throw new Error('Google returned no refresh token (offline access was not granted)');
  if (!response.access_token) throw new Error('Google returned no access token');
  const granted = new Set((response.scope ?? '').split(/\s+/).filter(Boolean));
  for (const scope of [CALENDAR_SCOPE, GMAIL_SCOPE]) {
    if (!granted.has(scope)) throw new Error(`the consent did not include ${scope.split('/').pop()} (was a checkbox left unticked?)`);
  }
  if (!response.id_token) throw new Error('Google returned no id_token, so the account cannot be checked');
  const claims = idTokenClaims(response.id_token);
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (email !== account.email.toLowerCase()) {
    throw new Error(`the consent was given by ${email || 'an account without an address'}, not ${account.email}`);
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error(`${account.email} is not a verified address`);
  const lifetime = response.refresh_token_expires_in;
  return {
    refreshToken: response.refresh_token,
    accessToken: response.access_token,
    scope: [...granted].join(' '),
    refreshTokenExpiresAt: typeof lifetime === 'number' && lifetime > 0 ? new Date(now.getTime() + lifetime * 1000).toISOString() : null,
  };
}

/** The line about the refresh token's lifetime; there is always one. */
export function describeLifetime(expiresAt: string | null): string {
  if (expiresAt) {
    return `WARNING: Google says this refresh token expires at ${expiresAt}. The OAuth app is most likely in "Testing" `
      + 'publishing status, where refresh tokens last 7 days; the existing calendar grant from the same client expires the same way. '
      + 'Publish the app (Google Auth Platform -> Audience -> Publish app), then run this tool again.';
  }
  return 'Google returned no refresh-token lifetime. This tool does not verify the publishing status: '
    + 'check Google Auth Platform -> Audience -> Publishing status; "Testing" refresh tokens expire after 7 days.';
}

export type GmailProbe = { kind: 'ready' } | { kind: 'api-disabled'; enableUrl: string } | { kind: 'failed'; detail: string };

/** Whether Gmail answers with the new grant; a disabled API gets the console link for the client's project. */
export async function probeGmail(accessToken: string, clientId: string, fetchImpl: typeof fetch = fetch): Promise<GmailProbe> {
  const res = await fetchImpl(GMAIL_PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (res.ok) return { kind: 'ready' };
  let reasons: string[] = [];
  try {
    const body = await res.json() as { error?: { status?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> } };
    reasons = [body.error?.status, ...(body.error?.errors ?? []).map((e) => e.reason), ...(body.error?.details ?? []).map((d) => d.reason)]
      .filter((r): r is string => typeof r === 'string');
  } catch { /* non-JSON error body: report the status only */ }
  if (res.status === 403 && reasons.some((r) => r === 'SERVICE_DISABLED' || r === 'accessNotConfigured')) {
    const projectNumber = /^(\d+)-/.exec(clientId)?.[1];
    const enableUrl = `https://console.cloud.google.com/apis/library/gmail.googleapis.com${projectNumber ? `?project=${projectNumber}` : ''}`;
    return { kind: 'api-disabled', enableUrl };
  }
  return { kind: 'failed', detail: `HTTP ${res.status}${reasons.length ? ` ${reasons.join(', ')}` : ''}` };
}

/** Serve the loopback redirect until a valid callback, a denial, or the deadline. */
export function awaitCallback(
  server: http.Server,
  expectedState: string,
  timeoutMs: number,
): Promise<{ kind: 'code'; code: string } | { kind: 'denied'; error: string }> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      server.close();
      reject(new Error(`no answer from the browser within ${Math.round(timeoutMs / 1000)} s; nothing was changed`));
    }, timeoutMs);
    server.on('request', (req, res) => {
      const outcome = readCallback(req.url ?? '/', expectedState);
      if (outcome.kind === 'ignore') {
        res.writeHead(outcome.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not a valid consent callback.');
        return;
      }
      const text = outcome.kind === 'code'
        ? 'Consent received. You can close this tab and go back to the terminal.'
        : 'Consent was not given. Nothing was changed. You can close this tab.';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }).end(text);
      clearTimeout(deadline);
      server.close();
      resolve(outcome);
    });
  });
}

/** Listen on an ephemeral 127.0.0.1 port. */
export async function listenLoopback(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}
