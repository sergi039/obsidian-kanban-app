import type { CalendarAccount, CalendarEvent } from '../types';

export type EventProvider = 'google' | 'outlook' | 'other';

const OUTLOOK_HOSTS = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']);
const GOOGLE_EVENT_PATH_RE = /\/r\/(?:eventedit|event)\/([A-Za-z0-9_-]+)/;
const GOOGLE_ACCOUNT_PATH_RE = /^\/calendar\/u\/\d+(?=\/)/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** When an event has no end, a timed event counts as ongoing for this long after it starts. */
const ASSUMED_EVENT_DURATION_MS = 60 * 60 * 1000;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Mirrors the API's classification (apps/api/src/calendar-events.ts): exact hosts only. */
export function detectProvider(rawUrl: string): EventProvider {
  const url = parseUrl(rawUrl);
  if (!url) return 'other';
  const host = url.hostname.toLowerCase();
  if (host === 'calendar.google.com') return 'google';
  if (host === 'www.google.com' && url.pathname.startsWith('/calendar')) return 'google';
  if (OUTLOOK_HOSTS.has(host)) return 'outlook';
  return 'other';
}

/** Google event id from `?eid=` or a `/r/eventedit/<eid>` path. */
export function googleEid(rawUrl: string): string | null {
  const url = parseUrl(rawUrl);
  if (!url || detectProvider(rawUrl) !== 'google') return null;
  return url.searchParams.get('eid') ?? GOOGLE_EVENT_PATH_RE.exec(url.pathname)?.[1] ?? null;
}

/**
 * The calendar id inside an eid (base64url of "<eventId> <calendarId>"), usually the
 * owner's email. Google abbreviates "@gmail.com" to "@m". Only a hint: events on
 * secondary calendars carry a calendar id that is not an account email.
 */
export function eidCalendarId(eid: string): string | null {
  try {
    const base64 = eid.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const calendarId = atob(padded).split(' ')[1];
    if (!calendarId) return null;
    return calendarId.endsWith('@m') ? `${calendarId.slice(0, -2)}@gmail.com` : calendarId;
  } catch {
    return null;
  }
}

function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/** The account an event was synced from (null when that account is no longer configured). */
export function resolveAccount(event: CalendarEvent, accounts: CalendarAccount[]): CalendarAccount | null {
  return event.account ? accounts.find((account) => account.id === event.account) ?? null : null;
}

/**
 * Link that opens the event in the right signed-in Google account. Google otherwise
 * opens the default account (u/0) and reports a personal event as not found. An
 * explicit `authuser` already in the link wins; other links are returned unchanged.
 */
export function eventOpenUrl(event: CalendarEvent, account: CalendarAccount | null): string {
  const url = parseUrl(event.url);
  if (!url || !account || account.provider !== 'google' || detectProvider(event.url) !== 'google') return event.url;
  if (url.searchParams.has('authuser')) return event.url;
  if (url.hostname.toLowerCase() === 'www.google.com') url.hostname = 'calendar.google.com';
  url.pathname = url.pathname.replace(GOOGLE_ACCOUNT_PATH_RE, '/calendar');
  url.searchParams.set('authuser', account.email);
  return url.toString();
}

function buildQuery(params: Array<[string, string]>): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + DAY_MS).toISOString().slice(0, 10);
}

export interface NewEventDraft {
  title: string;
  details: string;
  /** 'YYYY-MM-DD'; the template becomes an all-day event that day. Omitted = calendar picks. */
  date: string | null;
}

/** Prefilled "create event" page in the account's own calendar (the owner saves it there). */
export function newEventUrl(account: CalendarAccount, draft: NewEventDraft): string {
  const date = draft.date && DATE_ONLY_RE.test(draft.date) ? draft.date : null;
  if (account.provider === 'google') {
    const params: Array<[string, string]> = [['action', 'TEMPLATE'], ['text', draft.title], ['details', draft.details]];
    // Google all-day ranges end on the (exclusive) next day.
    if (date) params.push(['dates', `${date.replace(/-/g, '')}/${nextDay(date).replace(/-/g, '')}`]);
    params.push(['authuser', account.email]);
    return `https://calendar.google.com/calendar/render?${buildQuery(params)}`;
  }
  const params: Array<[string, string]> = [['rru', 'addevent'], ['subject', draft.title], ['body', draft.details]];
  if (date) params.push(['startdt', date], ['enddt', nextDay(date)], ['allday', 'true']);
  return `https://outlook.office.com/calendar/action/compose?${buildQuery(params)}`;
}

/** Deep link back to the card in Kanban, for event descriptions. */
export function cardDeepLink(origin: string, boardId: string, cardId: string): string {
  return `${origin}/?${buildQuery([['board', boardId], ['card', cardId]])}`;
}

interface EventRange {
  startMs: number;
  endMs: number;
  allDay: boolean;
}

export function eventRange(event: CalendarEvent): EventRange | null {
  if (!event.start) return null;
  const dateOnly = DATE_ONLY_RE.exec(event.start);
  if (dateOnly) {
    const start = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    const endOnly = event.end ? DATE_ONLY_RE.exec(event.end) : null;
    const end = endOnly
      ? new Date(Number(endOnly[1]), Number(endOnly[2]) - 1, Number(endOnly[3]))
      : new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { startMs: start.getTime(), endMs: end.getTime(), allDay: true };
  }
  const startMs = Date.parse(event.start);
  if (Number.isNaN(startMs)) return null;
  const endMs = event.end ? Date.parse(event.end) : Number.NaN;
  return { startMs, endMs: Number.isNaN(endMs) ? startMs + ASSUMED_EVENT_DURATION_MS : endMs, allDay: false };
}

export function isPastEvent(event: CalendarEvent, now = new Date()): boolean {
  const range = eventRange(event);
  return range !== null && range.endMs <= now.getTime();
}

/** Upcoming/ongoing soonest first, then undated in stored order, then past most recent first. */
export function sortEvents(events: CalendarEvent[], now = new Date()): CalendarEvent[] {
  const nowMs = now.getTime();
  const dated = events
    .map((event) => ({ event, range: eventRange(event) }))
    .filter((item): item is { event: CalendarEvent; range: EventRange } => item.range !== null);
  const upcoming = dated.filter((item) => item.range.endMs > nowMs).sort((a, b) => a.range.startMs - b.range.startMs);
  const past = dated.filter((item) => item.range.endMs <= nowMs).sort((a, b) => b.range.startMs - a.range.startMs);
  const undated = events.filter((event) => eventRange(event) === null);
  return [...upcoming.map((item) => item.event), ...undated, ...past.map((item) => item.event)];
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today 10:00", "Tomorrow", "14 Oct 10:00", "14 Oct 2027"; null when the event has no date. */
export function formatEventTime(event: CalendarEvent, now = new Date()): string | null {
  const range = eventRange(event);
  if (!range) return null;
  const start = new Date(range.startMs);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let day: string;
  if (dayKey(start) === dayKey(now)) day = 'Today';
  else if (dayKey(start) === dayKey(tomorrow)) day = 'Tomorrow';
  else {
    day = start.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      ...(start.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
    });
  }
  if (range.allDay) return day;
  return `${day} ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** Short label for a chip: the time when known, otherwise the title. */
export function eventLabel(event: CalendarEvent, now = new Date()): string {
  return formatEventTime(event, now) ?? (event.title || 'Event');
}

/** Calendar pages open in a window of their own (owner's request), not a tab and not inside the card. */
export const EVENT_WINDOW_FEATURES = 'popup,width=1200,height=860,noopener,noreferrer';

/**
 * Click handler for calendar links: a plain left click opens the page in a separate
 * browser window; modified clicks (Cmd/Ctrl/Shift, middle button) keep browser defaults.
 */
export function openInWindow(
  event: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number },
  url: string,
): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  window.open(url, '_blank', EVENT_WINDOW_FEATURES);
}

