import { z } from 'zod';
import type { CalendarAccount } from './config.js';

/**
 * Calendar events attached to a card. Stored as JSON in `cards.calendar_events`
 * (DB-only metadata, never written back to Markdown), replaced as a whole by
 * PATCH /api/cards/:id like `links` and `checklist`.
 */

export const MAX_CALENDAR_EVENTS = 20;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;

export type CalendarProvider = 'google' | 'outlook' | 'other';

const OUTLOOK_HOSTS = new Set(['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']);

/** Classify an event URL by host; anything unknown is a plain link ("other"). */
export function detectCalendarProvider(rawUrl: string): CalendarProvider {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'other';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'calendar.google.com') return 'google';
  if (host === 'www.google.com' && url.pathname.startsWith('/calendar')) return 'google';
  if (OUTLOOK_HOSTS.has(host)) return 'outlook';
  return 'other';
}

function isSafeHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_TZ_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** `YYYY-MM-DD` (all-day) or a timezone-aware ISO datetime; both must be real dates. */
export function isValidEventStart(value: string): boolean {
  const dateOnly = DATE_ONLY_RE.exec(value);
  if (dateOnly) return isRealCalendarDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  const dateTime = DATETIME_TZ_RE.exec(value);
  if (!dateTime) return false;
  if (!isRealCalendarDate(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return false;
  return !Number.isNaN(Date.parse(value));
}

export const CalendarEventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Event id must be 1-40 letters, digits, "_" or "-"'),
  url: z.string().trim().max(MAX_URL_LENGTH).refine(isSafeHttpsUrl, 'Event URL must be https without credentials'),
  title: z.string().trim().max(MAX_TITLE_LENGTH).default(''),
  start: z.string().nullable().default(null).refine(
    (value) => value === null || isValidEventStart(value),
    'start must be YYYY-MM-DD or an ISO datetime with Z or an offset',
  ),
  account: z.string().nullable().default(null),
});

export const CalendarEventsSchema = z.array(CalendarEventSchema).max(MAX_CALENDAR_EVENTS).superRefine((events, ctx) => {
  const seen = new Set<string>();
  events.forEach((event, i) => {
    if (seen.has(event.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: `Duplicate event id "${event.id}"` });
    }
    seen.add(event.id);
  });
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/**
 * Check event accounts against configured calendars. An account must exist, and a
 * Google/Outlook event cannot be filed under the other provider's account (its link
 * would open in the wrong calendar). Returns an error message or null.
 */
export function validateEventAccounts(events: CalendarEvent[], accounts: CalendarAccount[]): string | null {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  for (const event of events) {
    if (event.account === null) continue;
    const account = byId.get(event.account);
    if (!account) return `Unknown calendar account "${event.account}"`;
    const provider = detectCalendarProvider(event.url);
    if (provider !== 'other' && provider !== account.provider) {
      return `Event "${event.title || event.url}" is a ${provider} link but account "${account.id}" is ${account.provider}`;
    }
  }
  return null;
}
