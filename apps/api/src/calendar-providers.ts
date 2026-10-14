import { readFileSync } from 'node:fs';
import os from 'node:os';
import type { CalendarAccount } from './config.js';

/**
 * Read-only calendar fetchers. Each returns every non-cancelled event of one account
 * inside a time window, or throws — a partial page set is never returned.
 */

export interface ProviderEvent {
  /** Unique within the account (Graph id / Google id). */
  key: string;
  /** Recurring series id, or the event's own key when it is a single event. */
  seriesKey: string;
  url: string;
  title: string;
  /** 'YYYY-MM-DD' when all-day, else an ISO datetime with offset. */
  start: string;
  end: string | null;
  /** Subject, body and location — searched for card links. */
  text: string;
  /** Identifiers a card may quote to point at this event (Outlook itemid, Google event id). */
  refs: string[];
}

export interface FetchWindow {
  from: Date;
  to: Date;
  signal: AbortSignal;
}

/** Outlook on the web hosts that serve calendar items; matched exactly, never by prefix. */
export const OUTLOOK_HOSTS = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']);

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 40;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

function expandHome(file: string): string {
  return file.startsWith('~/') ? `${os.homedir()}${file.slice(1)}` : file;
}

/** Parse KEY=VALUE lines (never executed) and return only the requested keys; missing keys throw. */
export function readEnvValues(file: string, keys: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const raw of readFileSync(expandHome(file), 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!keys.includes(key)) continue;
    found[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const missing = keys.filter((key) => !found[key]);
  if (missing.length > 0) throw new Error(`credentials file is missing ${missing.join(', ')}`);
  return found;
}

/** GET/POST JSON with retries on 429/503; errors carry status and provider code, never tokens. */
export async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000, MAX_RETRY_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const body = await res.text();
    if (!res.ok) {
      // Keep provider diagnostics short and free of tokens: status plus the provider's error code.
      let code = '';
      try {
        const parsed = JSON.parse(body) as { error?: string | { code?: string; status?: string } };
        code = typeof parsed.error === 'string' ? parsed.error : parsed.error?.code ?? parsed.error?.status ?? '';
      } catch { /* non-JSON error body */ }
      throw new Error(`HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }
    return JSON.parse(body);
  }
}

interface CachedToken { value: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();
const TOKEN_SAFETY_MS = 60_000;

async function cachedToken(cacheKey: string, mint: () => Promise<{ token: string; expiresIn: number }>): Promise<string> {
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now()) return cached.value;
  const { token, expiresIn } = await mint();
  tokenCache.set(cacheKey, { value: token, expiresAt: Date.now() + expiresIn * 1000 });
  return token;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

// ---------------------------------------------------------------- Microsoft Graph

interface GraphEvent {
  id: string;
  subject?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  webLink?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  seriesMasterId?: string | null;
  start: { dateTime: string };
  end?: { dateTime: string };
}

/** Graph returns naive datetimes in the zone requested via Prefer; we ask for UTC. */
function graphUtc(dateTime: string): string {
  return `${dateTime.replace(/\.\d+$/, '')}Z`;
}

/** The `itemid` an Outlook web link carries — what a card would quote when linking an event. */
export function outlookItemId(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of url.searchParams) {
      if (key.toLowerCase() === 'itemid' && value) return value;
    }
    const match = /\/calendar\/item\/([^/?#]+)/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** App-only Microsoft Graph token for an account with graph-app credentials (shared by calendar and mail). */
export async function graphAccessToken(account: CalendarAccount, signal: AbortSignal): Promise<string> {
  if (account.credentials?.type !== 'graph-app') throw new Error('no graph-app credentials configured');
  const env = readEnvValues(account.credentials.envFile, ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET']);
  return cachedToken(`graph:${env.M365_TENANT_ID}:${env.M365_CLIENT_ID}`, async () => {
    const body = new URLSearchParams({
      client_id: env.M365_CLIENT_ID,
      client_secret: env.M365_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await fetchJson(
      `https://login.microsoftonline.com/${encodeURIComponent(env.M365_TENANT_ID)}/oauth2/v2.0/token`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      signal,
    ) as { access_token: string; expires_in: number };
    return { token: res.access_token, expiresIn: res.expires_in };
  });
}

export async function fetchGraphEvents(account: CalendarAccount, window: FetchWindow): Promise<ProviderEvent[]> {
  const token = await graphAccessToken(account, window.signal);

  const params = new URLSearchParams({
    startDateTime: window.from.toISOString(),
    endDateTime: window.to.toISOString(),
    $select: 'id,subject,body,location,webLink,isAllDay,isCancelled,seriesMasterId,start,end',
    $top: '100',
  });
  let next: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account.email)}/calendarView?${params}`;
  const events: ProviderEvent[] = [];
  for (let page = 0; next; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of events`);
    const res = await fetchJson(next, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
      },
    }, window.signal) as { value: GraphEvent[]; '@odata.nextLink'?: string };
    for (const event of res.value) {
      if (event.isCancelled) continue;
      const start = event.isAllDay ? event.start.dateTime.slice(0, 10) : graphUtc(event.start.dateTime);
      const end = event.end ? (event.isAllDay ? event.end.dateTime.slice(0, 10) : graphUtc(event.end.dateTime)) : null;
      const url = event.webLink ?? '';
      const itemId = url ? outlookItemId(url) : null;
      events.push({
        key: event.id,
        seriesKey: event.seriesMasterId ?? event.id,
        url,
        title: event.subject ?? '',
        start,
        end,
        text: [event.subject, event.body?.content, event.location?.displayName].filter(Boolean).join('\n'),
        refs: [event.id, ...(itemId ? [itemId] : [])],
      });
    }
    next = res['@odata.nextLink'] ?? null;
  }
  return events;
}

// ---------------------------------------------------------------- Google Calendar

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  recurringEventId?: string;
  start: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
}

/** Access token from the owner's stored Google refresh token (scopes are whatever the consent granted). */
export async function googleAccessToken(account: CalendarAccount, signal: AbortSignal): Promise<string> {
  if (account.credentials?.type !== 'google-oauth') throw new Error('no google-oauth credentials configured');
  const { clientEnvFile, tokenFile } = account.credentials;
  const client = readEnvValues(clientEnvFile, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  let stored: { refresh_token?: string; account?: string };
  try {
    stored = JSON.parse(readFileSync(expandHome(tokenFile), 'utf-8'));
  } catch {
    throw new Error('not connected: Google consent token file is missing');
  }
  if (!stored.refresh_token) throw new Error('not connected: token file has no refresh_token');
  if (stored.account && stored.account.toLowerCase() !== account.email.toLowerCase()) {
    throw new Error(`token belongs to ${stored.account}, not ${account.email}`);
  }
  const refreshToken = stored.refresh_token;
  return cachedToken(`google:${account.id}`, async () => {
    const res = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.GOOGLE_CLIENT_ID,
        client_secret: client.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    }, signal) as { access_token: string; expires_in: number };
    return { token: res.access_token, expiresIn: res.expires_in };
  });
}

export async function fetchGoogleEvents(account: CalendarAccount, window: FetchWindow): Promise<ProviderEvent[]> {
  const token = await googleAccessToken(account, window.signal);

  const events: ProviderEvent[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page === 0 || pageToken; page++) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES} pages of events`);
    const params = new URLSearchParams({
      singleEvents: 'true',
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      maxResults: '250',
      orderBy: 'startTime',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchJson(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(account.email)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
      window.signal,
    ) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const event of res.items ?? []) {
      if (event.status === 'cancelled') continue;
      const start = event.start.date ?? event.start.dateTime;
      if (!start) continue;
      events.push({
        key: event.id,
        seriesKey: event.recurringEventId ?? event.id,
        url: event.htmlLink ?? '',
        title: event.summary ?? '',
        start,
        end: event.end?.date ?? event.end?.dateTime ?? null,
        text: [event.summary, event.description, event.location].filter(Boolean).join('\n'),
        refs: [event.id, ...(event.recurringEventId ? [event.recurringEventId] : [])],
      });
    }
    pageToken = res.nextPageToken ?? null;
  }
  return events;
}
