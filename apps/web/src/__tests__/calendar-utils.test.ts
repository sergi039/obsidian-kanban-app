import { describe, it, expect } from 'vitest';
import {
  cardDeepLink,
  detectProvider,
  eidCalendarId,
  eventLabel,
  eventOpenUrl,
  formatEventTime,
  googleEid,
  isPastEvent,
  newEventUrl,
  resolveAccount,
  sortEvents,
} from '../lib/calendar-utils';
import type { CalendarAccount, CalendarEvent } from '../types';

const WORK: CalendarAccount = { id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example' };
const PERSONAL: CalendarAccount = { id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example' };
const ACCOUNTS = [WORK, PERSONAL];

function b64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const PERSONAL_EID = b64url('abc123 me@home.example');
const GOOGLE_URL = `https://www.google.com/calendar/event?eid=${PERSONAL_EID}`;
const OUTLOOK_URL = 'https://outlook.office.com/calendar/item/AAMkAD%3D';

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: 'e1', url: GOOGLE_URL, title: '', start: null, account: null, ...overrides };
}

describe('provider and eid parsing', () => {
  it('detects providers by exact host', () => {
    expect(detectProvider(GOOGLE_URL)).toBe('google');
    expect(detectProvider('https://calendar.google.com/calendar/u/1/r/eventedit/xyz')).toBe('google');
    expect(detectProvider(OUTLOOK_URL)).toBe('outlook');
    expect(detectProvider('https://www.google.com/maps')).toBe('other');
    expect(detectProvider('https://calendar.google.com.evil.example/')).toBe('other');
    expect(detectProvider('not a url')).toBe('other');
  });

  it('reads the eid from the query or an eventedit path', () => {
    expect(googleEid(GOOGLE_URL)).toBe(PERSONAL_EID);
    expect(googleEid(`https://calendar.google.com/calendar/u/0/r/eventedit/${PERSONAL_EID}`)).toBe(PERSONAL_EID);
    expect(googleEid(OUTLOOK_URL)).toBeNull();
  });

  it('decodes the calendar id, expanding the gmail abbreviation', () => {
    expect(eidCalendarId(PERSONAL_EID)).toBe('me@home.example');
    expect(eidCalendarId(b64url('abc someone@m'))).toBe('someone@gmail.com');
    expect(eidCalendarId('%%%')).toBeNull();
  });
});

describe('account resolution', () => {
  it('uses the account the event was synced from', () => {
    expect(resolveAccount(event({ account: 'personal' }), ACCOUNTS)?.id).toBe('personal');
    expect(resolveAccount(event({ account: 'gone' }), ACCOUNTS)).toBeNull();
    expect(resolveAccount(event({ account: null }), ACCOUNTS)).toBeNull();
  });
});

describe('event links', () => {
  it('opens google events in the owning account', () => {
    const url = new URL(eventOpenUrl(event(), PERSONAL));
    expect(url.hostname).toBe('calendar.google.com');
    expect(url.pathname).toBe('/calendar/event');
    expect(url.searchParams.get('eid')).toBe(PERSONAL_EID);
    expect(url.searchParams.get('authuser')).toBe('me@home.example');
  });

  it('replaces a copied /u/N/ account index with the account email', () => {
    const raw = `https://calendar.google.com/calendar/u/0/r/eventedit/${PERSONAL_EID}`;
    const url = new URL(eventOpenUrl(event({ url: raw }), PERSONAL));
    expect(url.pathname).toBe(`/calendar/r/eventedit/${PERSONAL_EID}`);
    expect(url.searchParams.get('authuser')).toBe('me@home.example');
  });

  it('keeps an eid-less google link intact apart from the account', () => {
    const raw = 'https://calendar.google.com/calendar/r/week/2026/10/12?tab=mc';
    const url = new URL(eventOpenUrl(event({ url: raw }), PERSONAL));
    expect(url.pathname).toBe('/calendar/r/week/2026/10/12');
    expect(url.searchParams.get('tab')).toBe('mc');
    expect(url.searchParams.get('authuser')).toBe('me@home.example');
  });

  it('keeps links that already name an account, and non-google links, unchanged', () => {
    const named = `${GOOGLE_URL}&authuser=1`;
    expect(eventOpenUrl(event({ url: named }), PERSONAL)).toBe(named);
    expect(eventOpenUrl(event({ url: OUTLOOK_URL }), WORK)).toBe(OUTLOOK_URL);
    expect(eventOpenUrl(event(), null)).toBe(GOOGLE_URL);
  });

  it('builds a google all-day template with an exclusive end date', () => {
    const url = new URL(newEventUrl(PERSONAL, { title: 'Call A & B', details: 'Kanban: x', date: '2026-12-31' }));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Call A & B');
    expect(url.searchParams.get('dates')).toBe('20261231/20270101');
    expect(url.searchParams.get('authuser')).toBe('me@home.example');
  });

  it('builds an outlook compose link, with no dates when the card has none', () => {
    const raw = newEventUrl(WORK, { title: 'Call A & B', details: 'Kanban: x', date: null });
    expect(raw).toContain('subject=Call%20A%20%26%20B');
    const url = new URL(raw);
    expect(url.origin + url.pathname).toBe('https://outlook.office.com/calendar/action/compose');
    expect(url.searchParams.get('rru')).toBe('addevent');
    expect(url.searchParams.has('startdt')).toBe(false);
    const dated = new URL(newEventUrl(WORK, { title: 't', details: '', date: '2026-10-14' }));
    expect(dated.searchParams.get('startdt')).toBe('2026-10-14');
    expect(dated.searchParams.get('enddt')).toBe('2026-10-15');
    expect(dated.searchParams.get('allday')).toBe('true');
  });

  it('builds card links', () => {
    expect(cardDeepLink('https://kanban.example', 'vs', 'a b')).toBe('https://kanban.example/?board=vs&card=a%20b');
  });
});

describe('event ordering and labels', () => {
  const now = new Date(2026, 9, 12, 12, 0);
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

  it('orders upcoming soonest first, then undated, then past most recent first', () => {
    const events = [
      event({ id: 'past-old', start: at(1, 9) }),
      event({ id: 'undated' }),
      event({ id: 'later', start: at(20, 9) }),
      event({ id: 'past-recent', start: at(11, 9) }),
      event({ id: 'soon', start: at(12, 15) }),
      event({ id: 'all-day-today', start: '2026-10-12' }),
    ];
    expect(sortEvents(events, now).map((e) => e.id)).toEqual([
      'all-day-today', 'soon', 'later', 'undated', 'past-recent', 'past-old',
    ]);
  });

  it('uses the real end when the calendar provides one', () => {
    expect(isPastEvent(event({ start: at(12, 9), end: at(12, 13) }), now)).toBe(false);
    expect(isPastEvent(event({ start: at(12, 9), end: at(12, 11) }), now)).toBe(true);
    expect(isPastEvent(event({ start: '2026-10-10', end: '2026-10-13' }), now)).toBe(false);
    expect(isPastEvent(event({ start: '2026-10-10', end: '2026-10-12' }), now)).toBe(true);
  });

  it('without an end, treats a timed event as ongoing for an hour and an all-day event until the day ends', () => {
    expect(isPastEvent(event({ start: at(12, 11, 30) }), now)).toBe(false);
    expect(isPastEvent(event({ start: at(12, 10, 59) }), now)).toBe(true);
    expect(isPastEvent(event({ start: '2026-10-12' }), now)).toBe(false);
    expect(isPastEvent(event({ start: '2026-10-11' }), now)).toBe(true);
    expect(isPastEvent(event(), now)).toBe(false);
  });

  it('formats relative days and falls back to the title', () => {
    expect(formatEventTime(event({ start: '2026-10-12' }), now)).toBe('Today');
    expect(formatEventTime(event({ start: '2026-10-13' }), now)).toBe('Tomorrow');
    expect(formatEventTime(event({ start: at(13, 9, 30) }), now)).toMatch(/^Tomorrow 0?9:30/);
    expect(formatEventTime(event({ start: '2027-01-05' }), now)).toMatch(/2027/);
    expect(eventLabel(event({ title: 'Kick-off' }), now)).toBe('Kick-off');
    expect(eventLabel(event(), now)).toBe('Event');
  });
});
