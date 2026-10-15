import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { CalendarAccount } from '../src/config.js';
import {
  acceptGrant,
  awaitCallback,
  buildConsentRequest,
  CALENDAR_SCOPE,
  describeLifetime,
  GMAIL_SCOPE,
  listenLoopback,
  probeGmail,
  readCallback,
} from '../src/google-consent.js';

const ACCOUNT: CalendarAccount = {
  id: 'personal', label: 'Personal', provider: 'google', email: 'Me@Home.example',
  credentials: { type: 'google-oauth', clientEnvFile: '/unused', tokenFile: '/unused' },
};
const NOW = new Date('2026-10-15T10:00:00Z');
const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const goodResponse = {
  access_token: 'access',
  refresh_token: 'refresh',
  scope: `openid ${CALENDAR_SCOPE} ${GMAIL_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
  id_token: idToken({ email: 'me@home.example', email_verified: true }),
};

describe('buildConsentRequest', () => {
  it('asks for offline access to both scopes with PKCE S256, a random state and the account as hint', () => {
    const a = buildConsentRequest('123-abc.apps.googleusercontent.com', 'me@home.example', 51234);
    const url = new URL(a.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: '123-abc.apps.googleusercontent.com',
      redirect_uri: 'http://127.0.0.1:51234/',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      login_hint: 'me@home.example',
      code_challenge_method: 'S256',
      state: a.state,
    });
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'email', CALENDAR_SCOPE, GMAIL_SCOPE]);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(a.codeVerifier).digest('base64url'));
    expect(a.state).not.toBe(buildConsentRequest('c', 'm', 1).state);
    expect(Buffer.from(a.codeVerifier, 'base64url')).toHaveLength(32);
  });
});

describe('readCallback', () => {
  it.each([
    ['/favicon.ico?state=s1&code=c', { kind: 'ignore', status: 404 }],
    ['/?code=c', { kind: 'ignore', status: 400 }],
    ['/?state=forged&code=c', { kind: 'ignore', status: 400 }],
    ['/?state=forged&error=access_denied', { kind: 'ignore', status: 400 }],
    ['/?state=s1&error=access_denied', { kind: 'denied', error: 'access_denied' }],
    ['/?state=s1', { kind: 'ignore', status: 400 }],
    ['/?state=s1&code=4%2Fabc', { kind: 'code', code: '4/abc' }],
  ])('%s', (url, expected) => {
    expect(readCallback(url, 's1')).toEqual(expected);
  });
});

describe('acceptGrant', () => {
  it('keeps a complete grant of the configured account and reports the refresh-token lifetime', () => {
    expect(acceptGrant({ ...goodResponse, refresh_token_expires_in: 604799 }, ACCOUNT, NOW)).toMatchObject({
      refreshToken: 'refresh', accessToken: 'access', refreshTokenExpiresAt: '2026-10-22T09:59:59.000Z',
    });
    expect(acceptGrant(goodResponse, ACCOUNT, NOW).refreshTokenExpiresAt).toBeNull();
  });

  it.each([
    ['no refresh token', { refresh_token: undefined }, /no refresh token/],
    ['the Gmail box unticked', { scope: `openid ${CALENDAR_SCOPE}` }, /gmail\.metadata/],
    ['the calendar box unticked', { scope: `openid ${GMAIL_SCOPE}` }, /calendar\.readonly/],
    ['another Google account', { id_token: idToken({ email: 'someone@else.example', email_verified: true }) }, /given by someone@else\.example, not Me@Home\.example/],
    ['an unverified address', { id_token: idToken({ email: 'me@home.example', email_verified: false }) }, /not a verified address/],
    ['no id_token', { id_token: undefined }, /no id_token/],
  ])('refuses %s', (_label, patch, message) => {
    expect(() => acceptGrant({ ...goodResponse, ...patch }, ACCOUNT, NOW)).toThrow(message);
  });
});

describe('describeLifetime', () => {
  it('warns about Testing status when Google gives the refresh token a lifetime', () => {
    expect(describeLifetime('2026-10-22T09:59:59.000Z')).toMatch(/expires at 2026-10-22T09:59:59\.000Z.*"Testing".*existing calendar grant/);
  });

  it('says the publishing status is not verified when Google gives no lifetime', () => {
    expect(describeLifetime(null)).toMatch(/does not verify the publishing status/);
  });
});

describe('probeGmail', () => {
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('is ready when Gmail answers', async () => {
    expect(await probeGmail('t', '123-abc.apps.googleusercontent.com', respond(200, { emailAddress: 'me@home.example' }))).toEqual({ kind: 'ready' });
  });

  it('points at the console when the Gmail API is off in the client\'s project', async () => {
    const body = { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } };
    expect(await probeGmail('t', '43071142-abc.apps.googleusercontent.com', respond(403, body))).toEqual({
      kind: 'api-disabled', enableUrl: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=43071142',
    });
  });

  it('reports any other failure with status and reasons only', async () => {
    const body = { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions' }] } };
    expect(await probeGmail('t', 'c', respond(403, body))).toEqual({ kind: 'failed', detail: 'HTTP 403 PERMISSION_DENIED, insufficientPermissions' });
  });
});

describe('loopback callback', () => {
  it('ignores forged requests and resolves on the right state', async () => {
    const { server, port } = await listenLoopback();
    const waiting = awaitCallback(server, 'right-state', 5000);
    const forged = await fetch(`http://127.0.0.1:${port}/?state=wrong&code=evil`);
    expect(forged.status).toBe(400);
    const good = await fetch(`http://127.0.0.1:${port}/?state=right-state&code=real`);
    expect(good.status).toBe(200);
    await expect(waiting).resolves.toEqual({ kind: 'code', code: 'real' });
    expect(server.listening).toBe(false);
  });

  it('gives up after the deadline and stops listening', async () => {
    const { server } = await listenLoopback();
    await expect(awaitCallback(server, 's', 50)).rejects.toThrow(/no answer from the browser/);
    expect(server.listening).toBe(false);
  });
});
