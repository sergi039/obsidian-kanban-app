import type { CalendarAccount } from './config.js';

/**
 * Calendar events linked to a card. Stored as JSON in `cards.calendar_events` by the
 * calendar sync (apps/api/src/calendar-sync.ts); DB-only, never written to Markdown and
 * never accepted from clients.
 */

export const MAX_CALENDAR_EVENTS = 20;

export interface CalendarEvent {
  id: string;
  url: string;
  title: string;
  /** 'YYYY-MM-DD' for all-day events, otherwise an ISO datetime with offset. */
  start: string;
  /** Exclusive end in the same format as `start`; null when the provider gave none. */
  end: string | null;
  /** Calendar account id from config.calendarAccounts. */
  account: string | null;
}

/** The client-safe part of a calendar account (never the credentials). */
export function publicCalendarAccount(account: CalendarAccount) {
  return { id: account.id, label: account.label, provider: account.provider, email: account.email };
}
