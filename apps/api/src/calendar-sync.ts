import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import { loadConfig, type AppConfig, type CalendarAccount } from './config.js';
import { broadcast } from './ws.js';
import { fetchGoogleEvents, fetchGraphEvents, outlookItemId, type FetchWindow, type ProviderEvent } from './calendar-providers.js';
import { MAX_CALENDAR_EVENTS, type CalendarEvent } from './calendar-events.js';
import { safeJsonParse } from './utils.js';
import { cardLinksInText, decodeEntities, trustedHostsFor, type CardLinkRef } from './card-links.js';

/**
 * Links calendar events to cards automatically and stores them in `cards.calendar_events`
 * (a sync-owned projection; the API never accepts them from clients).
 *
 * An event belongs to a card only through an explicit reference — fuzzy title matching
 * attached unrelated events in a trial on real data:
 *  1. the event text carries a Kanban card link (`…?board=<b>&card=<id>`) or a `kb:id=<id>` marker;
 *  2. the card text quotes the event's own link or id (Outlook itemid, Google eid / event id).
 */

export const SYNC_INTERVAL_MS = 10 * 60 * 1000;
const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 180;
const RUN_DEADLINE_MS = 120_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AccountSyncStatus {
  ok: boolean;
  lastSyncAt: string | null;
  events: number;
  linked: number;
  error: string | null;
}

const status = new Map<string, AccountSyncStatus>();
let running: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let shutdown: AbortController | null = null;

interface CardRow {
  id: string;
  board_id: string;
  title: string;
  description: string | null;
  links: string | null;
  calendar_events: string | null;
}

interface LinkedEvent extends ProviderEvent {
  account: string;
}

// ---------------------------------------------------------------- matching

/** Card ids referenced from an event's text through a trusted Kanban link or a kb:id marker. */
export function cardRefsInText(text: string, trustedHosts: Set<string>): CardLinkRef[] {
  const refs = cardLinksInText(text, trustedHosts);
  for (const match of decodeEntities(text).matchAll(/\bkb:id=([A-Za-z0-9_-]{1,64})(?![A-Za-z0-9_-])/g)) {
    refs.push({ board: null, card: match[1] });
  }
  return refs;
}

/** Google eid → event id (eid is base64url of "<eventId> <calendarId>"). */
function googleEventIdFromEid(eid: string): { eventId: string; calendarId: string | null } | null {
  try {
    const decoded = Buffer.from(eid.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    const [eventId, calendarId] = decoded.split(' ');
    return eventId ? { eventId, calendarId: calendarId ?? null } : null;
  } catch {
    return null;
  }
}

/** Event identifiers a card quotes in its title, description or managed links. */
export function eventRefsInCard(card: Pick<CardRow, 'title' | 'description' | 'links'>): Set<string> {
  const refs = new Set<string>();
  const links = safeJsonParse<Array<{ url?: string }>>(card.links, []).map((link) => link.url ?? '');
  const text = [card.title, card.description ?? '', ...links].join('\n');
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[0]));
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (host.startsWith('outlook.')) {
      const itemId = outlookItemId(url.toString());
      if (itemId) refs.add(`outlook:${itemId}`);
    } else if (host === 'calendar.google.com' || host === 'www.google.com') {
      const eid = url.searchParams.get('eid') ?? /\/r\/(?:eventedit|event)\/([A-Za-z0-9_-]+)/.exec(url.pathname)?.[1];
      const decoded = eid ? googleEventIdFromEid(eid) : null;
      if (decoded) refs.add(`google:${decoded.eventId}`);
    }
  }
  return refs;
}

function eventStartMs(event: { start: string }): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start);
}

function eventEndMs(event: { start: string; end: string | null }): number {
  if (event.end) return eventStartMs({ start: event.end });
  return eventStartMs(event) + (/^\d{4}-\d{2}-\d{2}$/.test(event.start) ? DAY_MS : 0);
}

/** One entry per recurring series: the next occurrence still running/ahead, else the latest past one. */
function collapseSeries(events: LinkedEvent[], now: number): LinkedEvent[] {
  const bySeries = new Map<string, LinkedEvent[]>();
  for (const event of events) {
    const key = `${event.account}:${event.seriesKey}`;
    bySeries.set(key, [...(bySeries.get(key) ?? []), event]);
  }
  const chosen: LinkedEvent[] = [];
  for (const group of bySeries.values()) {
    const upcoming = group.filter((e) => eventEndMs(e) > now).sort((a, b) => eventStartMs(a) - eventStartMs(b));
    const past = group.filter((e) => eventEndMs(e) <= now).sort((a, b) => eventStartMs(b) - eventStartMs(a));
    chosen.push(upcoming[0] ?? past[0]);
  }
  return chosen;
}

/** Stored order: running/upcoming soonest first, then past most recent first; capped deterministically. */
function orderForCard(events: LinkedEvent[], now: number): LinkedEvent[] {
  const upcoming = events.filter((e) => eventEndMs(e) > now).sort((a, b) => eventStartMs(a) - eventStartMs(b) || a.key.localeCompare(b.key));
  const past = events.filter((e) => eventEndMs(e) <= now).sort((a, b) => eventStartMs(b) - eventStartMs(a) || a.key.localeCompare(b.key));
  return [...upcoming, ...past].slice(0, MAX_CALENDAR_EVENTS);
}

function toStored(event: LinkedEvent): CalendarEvent {
  return {
    id: createHash('sha256').update(`${event.account}:${event.key}`).digest('hex').slice(0, 16),
    url: event.url,
    title: event.title,
    start: event.start,
    end: event.end,
    account: event.account,
  };
}

/**
 * Compute every card's events from fresh provider snapshots. Accounts that failed keep
 * the events they had, so a provider outage never wipes links.
 */
export function linkEventsToCards(
  cards: CardRow[],
  snapshots: Map<string, ProviderEvent[]>,
  providers: Map<string, 'google' | 'outlook'>,
  failedAccounts: Set<string>,
  trustedHosts: Set<string>,
  now: number,
): { byCard: Map<string, CalendarEvent[]>; linkedPerAccount: Map<string, number> } {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const linked = new Map<string, LinkedEvent[]>();
  const add = (cardId: string, event: LinkedEvent) => {
    const list = linked.get(cardId) ?? [];
    if (!list.some((e) => e.account === event.account && e.key === event.key)) list.push(event);
    linked.set(cardId, list);
  };

  const cardEventRefs = new Map(cards.map((card) => [card.id, eventRefsInCard(card)]));
  for (const [accountId, events] of snapshots) {
    for (const providerEvent of events) {
      const event: LinkedEvent = { ...providerEvent, account: accountId };
      for (const ref of cardRefsInText(event.text, trustedHosts)) {
        const card = cardById.get(ref.card);
        if (card && (ref.board === null || ref.board === card.board_id)) add(card.id, event);
      }
      const provider = providers.get(accountId);
      for (const [cardId, refs] of cardEventRefs) {
        if (event.refs.some((ref) => refs.has(`${provider}:${ref}`))) add(cardId, event);
      }
    }
  }

  const byCard = new Map<string, CalendarEvent[]>();
  const linkedPerAccount = new Map<string, number>();
  for (const card of cards) {
    const kept = safeJsonParse<CalendarEvent[]>(card.calendar_events, [])
      .filter((event) => event.account !== null && failedAccounts.has(event.account));
    const fresh = orderForCard(collapseSeries(linked.get(card.id) ?? [], now), now);
    for (const event of fresh) linkedPerAccount.set(event.account, (linkedPerAccount.get(event.account) ?? 0) + 1);
    const merged = [...fresh.map(toStored), ...kept];
    byCard.set(card.id, merged.slice(0, MAX_CALENDAR_EVENTS));
  }
  return { byCard, linkedPerAccount };
}

// ---------------------------------------------------------------- sync run

async function fetchAccount(account: CalendarAccount, window: FetchWindow): Promise<ProviderEvent[]> {
  return account.provider === 'outlook' ? fetchGraphEvents(account, window) : fetchGoogleEvents(account, window);
}

function persist(db: Database.Database, snapshots: Map<string, ProviderEvent[]>, failed: Set<string>, config: AppConfig, now: number) {
  const changedBoards = new Set<string>();
  let linkedPerAccount = new Map<string, number>();
  db.transaction(() => {
    // Read cards inside the transaction so links follow the current set of cards.
    const cards = db
      .prepare('SELECT id, board_id, title, description, links, calendar_events FROM cards WHERE deleted_at IS NULL')
      .all() as CardRow[];
    const providers = new Map((config.calendarAccounts ?? []).map((account) => [account.id, account.provider] as const));
    const result = linkEventsToCards(cards, snapshots, providers, failed, trustedHostsFor(config), now);
    linkedPerAccount = result.linkedPerAccount;
    const update = db.prepare('UPDATE cards SET calendar_events = ? WHERE id = ?');
    for (const card of cards) {
      const next = JSON.stringify(result.byCard.get(card.id) ?? []);
      if (next !== (card.calendar_events ?? '[]')) {
        update.run(next, card.id);
        changedBoards.add(card.board_id);
      }
    }
  })();
  return { changedBoards, linkedPerAccount };
}

export async function runCalendarSync(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const config = loadConfig();
    const accounts = (config.calendarAccounts ?? []).filter((account) => account.credentials);
    if (accounts.length === 0) return;
    const runAbort = new AbortController();
    const deadline = setTimeout(() => runAbort.abort(new Error('calendar sync deadline exceeded')), RUN_DEADLINE_MS);
    const signal = shutdown ? AbortSignal.any([runAbort.signal, shutdown.signal]) : runAbort.signal;
    const now = Date.now();
    const window: FetchWindow = { from: new Date(now - WINDOW_PAST_DAYS * DAY_MS), to: new Date(now + WINDOW_FUTURE_DAYS * DAY_MS), signal };
    try {
      const results = await Promise.allSettled(accounts.map((account) => fetchAccount(account, window)));
      if (signal.aborted && shutdown?.signal.aborted) return; // shutting down: never write after close
      const snapshots = new Map<string, ProviderEvent[]>();
      const failed = new Set<string>();
      results.forEach((result, i) => {
        const account = accounts[i];
        if (result.status === 'fulfilled') {
          snapshots.set(account.id, result.value);
        } else {
          failed.add(account.id);
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
          const previous = status.get(account.id);
          status.set(account.id, { ok: false, lastSyncAt: previous?.lastSyncAt ?? null, events: previous?.events ?? 0, linked: previous?.linked ?? 0, error: message });
          console.warn(`[calendar] ${account.id}: sync failed — ${message}`);
        }
      });
      const { changedBoards, linkedPerAccount } = persist(getDb(), snapshots, failed, config, now);
      for (const [accountId, events] of snapshots) {
        status.set(accountId, { ok: true, lastSyncAt: new Date(now).toISOString(), events: events.length, linked: linkedPerAccount.get(accountId) ?? 0, error: null });
      }
      for (const boardId of changedBoards) {
        broadcast({ type: 'card-updated', boardId, timestamp: new Date().toISOString() });
      }
    } finally {
      clearTimeout(deadline);
    }
  })().catch((err) => {
    console.error('[calendar] sync run failed:', err);
  }).finally(() => {
    running = null;
  });
  return running;
}

export function getCalendarSyncStatus(): Record<string, AccountSyncStatus> {
  const config = loadConfig();
  const result: Record<string, AccountSyncStatus> = {};
  for (const account of config.calendarAccounts ?? []) {
    result[account.id] = status.get(account.id) ?? {
      ok: false,
      lastSyncAt: null,
      events: 0,
      linked: 0,
      error: account.credentials ? 'not synced yet' : 'no credentials configured',
    };
  }
  return result;
}

/** Start after reconciliation so links see the current cards; first run immediately. */
export function startCalendarSync(): void {
  if (timer) return;
  shutdown = new AbortController();
  void runCalendarSync();
  timer = setInterval(() => { void runCalendarSync(); }, SYNC_INTERVAL_MS);
  timer.unref();
}

/** Abort in-flight requests before the database closes. */
export function stopCalendarSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  shutdown?.abort(new Error('shutting down'));
}

export function resetCalendarSyncForTests(): void {
  stopCalendarSync();
  status.clear();
  running = null;
  shutdown = null;
}
