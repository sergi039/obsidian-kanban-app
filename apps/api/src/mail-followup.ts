/**
 * Email follow-ups (issue #2, EMAIL-3): "remind me if this thread gets no answer in N days".
 *
 * A follow-up is a `follow_up` reminder on one of the card's email threads
 * (`card_email_threads`, `reminders.email_thread_id`): a card can follow threads in
 * several mailboxes, each with its own follow-up. Its `source_meta.follow_up` records
 * what is awaited:
 *
 * - `await_reply`: the owner wrote last and waits for the other side;
 * - `owe_reply`: the other side wrote last and the owner has to answer.
 *
 * The reminder fires `days` after the message the wait counts from. Every sync reads
 * the thread's message headers (never a body) through the account credentials the
 * calendar sync already uses; once the awaited answer is in the thread, the reminder
 * is dismissed and the card gets a comment saying so. A fired follow-up is still read
 * for `LATE_ANSWER_DAYS`, so an answer that comes after the reminder still shows.
 * Automatic messages (out-of-office replies, delivery failures, auto-generated notices)
 * are not answers. Only sender and date of the answer are stored.
 * Without mailbox access (an unconfigured mailbox, a Google consent without Gmail)
 * the reminder still fires on time; it just cannot dismiss itself.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './db.js';
import { loadConfig, type AppConfig, type CalendarAccount } from './config.js';
import { fetchJson, graphAccessToken, googleAccessToken } from './calendar-providers.js';
import { broadcast } from './ws.js';
import { safeJsonParse } from './utils.js';
import { isProviderId } from './email-provenance.js';
import { refreshEmailThreads, threadById, threadsOfCard, type EmailThreadRow } from './email-threads.js';

export const FOLLOW_UP_MODES = ['await_reply', 'owe_reply'] as const;
export type FollowUpMode = (typeof FOLLOW_UP_MODES)[number];

export const FOLLOW_UP_SYNC_INTERVAL_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_FETCH_TIMEOUT_MS = 20_000;
const MAX_THREAD_PAGES = 10;
const COMMENT_AUTHOR = 'kanban';
/** How long a fired follow-up's thread is still read for a late answer. */
export const LATE_ANSWER_DAYS = 30;

/** One message of a thread, reduced to what a follow-up needs. */
export interface ThreadMessage {
  /** ISO UTC (`toISOString`), so string order is time order. */
  at: string;
  /** Sent from the card's mailbox. */
  outbound: boolean;
  from: string;
  /** Out-of-office reply, delivery report or other auto-generated mail: never an answer. */
  auto: boolean;
}

export interface FollowUpState {
  mode: FollowUpMode;
  days: number;
  /** The message the wait counts from: the owner's last one (await_reply) or theirs (owe_reply). */
  baseline_at: string;
  /** thread: taken from the thread; fallback: the thread was unreadable, re-taken on the first good read. */
  baseline_source: 'thread' | 'fallback';
  /** waiting: thread read, no answer yet; unchecked: the thread could not be read; answered: done. */
  state: 'waiting' | 'unchecked' | 'answered';
  checked_at: string | null;
  error: string | null;
  answered_at?: string;
  answered_by?: string;
}

interface CardEmail {
  provider: 'gmail' | 'outlook';
  account: string;
  thread_id?: string;
  received_at?: string;
}

export type ThreadFetcher = (account: CalendarAccount, email: CardEmail, signal: AbortSignal) => Promise<ThreadMessage[]>;

export class FollowUpError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function threadEmail(thread: Pick<EmailThreadRow, 'provider' | 'account' | 'thread_id' | 'received_at'>): CardEmail {
  return {
    provider: thread.provider,
    account: thread.account,
    ...(thread.thread_id ? { thread_id: thread.thread_id } : {}),
    ...(thread.received_at ? { received_at: thread.received_at } : {}),
  };
}

// ---------------------------------------------------------------- rules (pure)

/** Exchange message classes of out-of-office/rule replies and of delivery/read reports. */
const AUTO_MESSAGE_CLASS_RE = /^(IPM\.Note\.Rules\.|REPORT\.)/i;
const AUTO_SENDER_RE = /^(mailer-daemon|postmaster)@/i;

/** RFC 3834 and common auto-responder markers; any one makes a message automatic. */
export function isAutomatic(signals: {
  messageClass?: string;
  headers?: Map<string, string>;
  fromAddress?: string;
  mimeType?: string;
}): boolean {
  const header = (name: string) => signals.headers?.get(name)?.trim().toLowerCase();
  const autoSubmitted = header('auto-submitted');
  return Boolean(
    (signals.messageClass && AUTO_MESSAGE_CLASS_RE.test(signals.messageClass))
    || (autoSubmitted && autoSubmitted !== 'no')
    || signals.headers?.has('x-autoreply')
    || signals.headers?.has('x-autorespond')
    || header('precedence') === 'auto_reply'
    || (signals.fromAddress && AUTO_SENDER_RE.test(signals.fromAddress))
    || signals.mimeType?.toLowerCase() === 'multipart/report',
  );
}

/** The time the wait counts from; `fallback` when the thread has no message to anchor on. */
export function baselineFor(mode: FollowUpMode, messages: ThreadMessage[], fallback: string): string {
  const human = messages.filter((m) => !m.auto);
  const own = human.filter((m) => (mode === 'await_reply' ? m.outbound : !m.outbound));
  const pool = own.length > 0 ? own : human;
  if (pool.length === 0) return fallback;
  return pool.reduce((latest, m) => (m.at > latest.at ? m : latest)).at;
}

/** The first awaited message after the baseline: theirs for await_reply, the owner's for owe_reply. */
export function findAnswer(mode: FollowUpMode, baselineAt: string, messages: ThreadMessage[]): ThreadMessage | null {
  const answers = messages.filter((m) => !m.auto && (mode === 'await_reply' ? !m.outbound : m.outbound) && m.at > baselineAt);
  if (answers.length === 0) return null;
  return answers.reduce((first, m) => (m.at < first.at ? m : first));
}

// ---------------------------------------------------------------- mailbox access

/** The configured account that reads this mailbox (calendar accounts carry the credentials). */
export function mailAccountFor(config: AppConfig, email: CardEmail): CalendarAccount | null {
  const provider = email.provider === 'gmail' ? 'google' : 'outlook';
  const mailbox = email.account.toLowerCase();
  return (config.calendarAccounts ?? []).find(
    (account) => account.provider === provider && account.email.toLowerCase() === mailbox && account.credentials,
  ) ?? null;
}

interface GraphMessage {
  isDraft?: boolean;
  sentDateTime?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
}

interface GmailMessage {
  internalDate?: string;
  labelIds?: string[];
  payload?: { mimeType?: string; headers?: Array<{ name: string; value: string }> };
}

/** PidTagMessageClass: tells Exchange out-of-office replies and reports from ordinary mail. */
const GRAPH_MESSAGE_CLASS = 'String 0x001A';
/** Graph answers with the short form (`String 0x1a`), so compare the tag number, not the text. */
const GRAPH_MESSAGE_CLASS_ID_RE = /^string 0x0*1a$/i;
const GMAIL_HEADERS = ['From', 'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond'];

function headerMap(headers: Array<{ name: string; value: string }> | undefined): Map<string, string> {
  return new Map((headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
}

function addressOf(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match ? match[1] : from).trim().toLowerCase();
}

/** Sender and date of every message in the thread; throws rather than return a partial thread. */
export const fetchThreadMessages: ThreadFetcher = async (account, email, signal) => {
  if (!email.thread_id) throw new Error('the card\'s email has no thread id');
  if (!isProviderId(email.provider, email.thread_id)) throw new Error(`not a ${email.provider} thread id`);
  const mailbox = account.email.toLowerCase();

  if (account.provider === 'outlook') {
    const token = await graphAccessToken(account, signal);
    // Headers, never the body: internetMessageHeaders carry the auto-reply markers.
    const params = new URLSearchParams({
      $filter: `conversationId eq '${email.thread_id.replace(/'/g, "''")}'`,
      $select: 'from,sentDateTime,receivedDateTime,isDraft,internetMessageHeaders',
      $expand: `singleValueExtendedProperties($filter=id eq '${GRAPH_MESSAGE_CLASS}')`,
      $top: '50',
    });
    let next: string | null = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(account.email)}/messages?${params}`;
    const messages: ThreadMessage[] = [];
    for (let page = 0; next; page++) {
      if (page >= MAX_THREAD_PAGES) throw new Error(`thread has more than ${MAX_THREAD_PAGES} pages of messages`);
      const res = await fetchJson(next, { headers: { Authorization: `Bearer ${token}` } }, signal) as {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
      };
      for (const m of res.value ?? []) {
        if (m.isDraft) continue;
        const address = (m.from?.emailAddress?.address ?? '').toLowerCase();
        const outbound = address === mailbox;
        const at = outbound ? m.sentDateTime : m.receivedDateTime;
        if (!at) continue;
        const auto = isAutomatic({
          messageClass: m.singleValueExtendedProperties?.find((p) => GRAPH_MESSAGE_CLASS_ID_RE.test(p.id))?.value,
          headers: headerMap(m.internetMessageHeaders),
          fromAddress: address,
        });
        messages.push({ at: new Date(at).toISOString(), outbound, from: m.from?.emailAddress?.name || address, auto });
      }
      next = res['@odata.nextLink'] ?? null;
    }
    return messages;
  }

  const token = await googleAccessToken(account, signal);
  const params = new URLSearchParams({ format: 'metadata' });
  for (const name of GMAIL_HEADERS) params.append('metadataHeaders', name);
  let res: { messages?: GmailMessage[] };
  try {
    res = await fetchJson(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(email.thread_id)}?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
      signal,
    ) as { messages?: GmailMessage[] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('HTTP 403')) {
      throw new Error('Gmail is not readable: the Google consent covers the calendar only (needs gmail.metadata)');
    }
    throw err;
  }
  const messages: ThreadMessage[] = [];
  for (const m of res.messages ?? []) {
    const labels = m.labelIds ?? [];
    if (labels.includes('DRAFT') || !m.internalDate) continue;
    const headers = headerMap(m.payload?.headers);
    const from = headers.get('from') ?? '';
    const auto = isAutomatic({ headers, fromAddress: addressOf(from), mimeType: m.payload?.mimeType });
    messages.push({ at: new Date(Number(m.internalDate)).toISOString(), outbound: labels.includes('SENT'), from, auto });
  }
  return messages;
};

// ---------------------------------------------------------------- storage

function newId(): string {
  return createHash('sha256').update(`follow-up|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12);
}

function formatAt(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  }
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new FollowUpError(`Unknown time zone "${timezone}"`, 400, 'invalid_timezone');
  }
}

interface ActiveFollowUpRow {
  id: string;
  card_id: string;
  board_id: string;
  timezone: string;
  source_meta: string;
}

/** The thread's follow-up that is not over yet: an active one, else a fired one (still read for a late answer). */
function openFollowUp(db: Database.Database, threadId: string): ActiveFollowUpRow | undefined {
  return db.prepare(`
    SELECT id, card_id, board_id, timezone, source_meta FROM reminders
    WHERE email_thread_id = ? AND kind = 'follow_up' AND status IN ('scheduled', 'snoozed', 'fired')
    ORDER BY CASE status WHEN 'fired' THEN 1 ELSE 0 END, updated_at DESC, created_at DESC LIMIT 1
  `).get(threadId) as ActiveFollowUpRow | undefined;
}

/**
 * Dismiss a follow-up because the awaited answer arrived, and say so on the card.
 * Returns false when the reminder changed meanwhile (dismissed, deleted, or its
 * follow-up re-set) or the card went to the trash: `row.source_meta` is the value this
 * decision was made on.
 */
function markAnswered(db: Database.Database, row: ActiveFollowUpRow, follow: FollowUpState, answer: ThreadMessage, nowIso: string): boolean {
  const meta = safeJsonParse<Record<string, unknown>>(row.source_meta, {});
  const answered: FollowUpState = {
    ...follow,
    state: 'answered',
    checked_at: nowIso,
    error: null,
    answered_at: answer.at,
    answered_by: answer.from,
  };
  const text = follow.mode === 'await_reply'
    ? `Ответ получен ${formatAt(answer.at, row.timezone)}${answer.from ? ` от ${answer.from}` : ''}: напоминание о follow-up снято.`
    : `Ответ отправлен ${formatAt(answer.at, row.timezone)}: напоминание ответить снято.`;
  return db.transaction(() => {
    const updated = db.prepare(`
      UPDATE reminders SET status = 'dismissed', dismissed_at = ?, source_meta = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('scheduled', 'snoozed', 'fired') AND source_meta = ?
        AND card_id IN (SELECT id FROM cards WHERE deleted_at IS NULL)
    `).run(nowIso, JSON.stringify({ ...meta, follow_up: answered }), row.id, row.source_meta);
    if (updated.changes === 0) return false;
    db.prepare('INSERT INTO comments (id, card_id, author, text) VALUES (?, ?, ?, ?)').run(newId(), row.card_id, COMMENT_AUTHOR, text);
    db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(row.card_id);
    refreshEmailThreads(db, row.card_id);
    return true;
  })();
}

function notifyAnswered(row: ActiveFollowUpRow): void {
  const timestamp = new Date().toISOString();
  broadcast({ type: 'reminder-dismissed', reminderId: row.id, cardId: row.card_id, boardId: row.board_id, timestamp });
  broadcast({ type: 'card-updated', cardId: row.card_id, boardId: row.board_id, timestamp });
}

function notifyCardChanged(row: ActiveFollowUpRow): void {
  broadcast({ type: 'card-updated', cardId: row.card_id, boardId: row.board_id, timestamp: new Date().toISOString() });
}

// ---------------------------------------------------------------- create

export interface CreateFollowUpInput {
  cardId: string;
  /** The card's thread to follow; may be left out when the card has exactly one. */
  emailThreadId?: string;
  mode: FollowUpMode;
  days: number;
  channel: string;
  timezone: string;
  message?: string;
}

export interface CreateFollowUpResult {
  /** The active reminder, or null when the awaited answer is already in the thread. */
  reminderId: string | null;
  created: boolean;
  followUp: FollowUpState;
  emailThreadId: string;
}

/** The thread a follow-up is for: the named one, or the card's only thread. */
function followedThread(db: Database.Database, cardId: string, emailThreadId: string | undefined): EmailThreadRow {
  if (emailThreadId) {
    const thread = threadById(db, emailThreadId);
    if (!thread || thread.card_id !== cardId) {
      throw new FollowUpError('The card has no such email thread', 404, 'thread_not_found');
    }
    return thread;
  }
  const threads = threadsOfCard(db, cardId);
  if (threads.length === 0) {
    throw new FollowUpError('A follow-up needs an email thread on the card', 400, 'not_an_email_card');
  }
  if (threads.length > 1) {
    const list = threads.map((thread) => `${thread.id} ${thread.account}${thread.subject ? ` «${thread.subject}»` : ''}`).join('; ');
    throw new FollowUpError(`The card follows several email threads, name one with email_thread_id: ${list}`, 400, 'thread_required', {
      threads: threads.map((thread) => ({ id: thread.id, account: thread.account, subject: thread.subject })),
    });
  }
  return threads[0];
}

export async function createFollowUp(
  input: CreateFollowUpInput,
  deps: { fetchThread?: ThreadFetcher; now?: () => Date; config?: AppConfig } = {},
): Promise<CreateFollowUpResult> {
  assertTimezone(input.timezone);
  const db = getDb();
  const card = db.prepare('SELECT id, board_id, title, deleted_at FROM cards WHERE id = ?').get(input.cardId) as
    | { id: string; board_id: string; title: string; deleted_at: string | null }
    | undefined;
  if (!card || card.deleted_at) throw new FollowUpError('Card not found', 404, 'card_not_found');
  const thread = followedThread(db, card.id, input.emailThreadId);
  const email = threadEmail(thread);
  if (!email.thread_id) {
    throw new FollowUpError('The email has no thread id to follow', 400, 'no_thread_id');
  }
  if (!isProviderId(email.provider, email.thread_id)) {
    throw new FollowUpError(`The thread id is not a ${email.provider} thread id`, 400, 'invalid_thread_id');
  }

  const config = deps.config ?? loadConfig();
  const fetchThread = deps.fetchThread ?? fetchThreadMessages;
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const account = mailAccountFor(config, email);

  let messages: ThreadMessage[] | null = null;
  let error: string | null = null;
  if (!account) {
    error = `mailbox ${email.account} is not configured for reading`;
  } else {
    try {
      messages = await fetchThread(account, email, AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  // The card may have gone to the trash, or the thread been detached, while the thread was read.
  // From here on nothing awaits, so the checks and the writes below see the same state.
  const live = db.prepare('SELECT deleted_at FROM cards WHERE id = ?').get(card.id) as { deleted_at: string | null } | undefined;
  if (!live || live.deleted_at) throw new FollowUpError('Card not found', 404, 'card_not_found');
  if (threadById(db, thread.id)?.card_id !== card.id) {
    throw new FollowUpError('The email thread was detached from the card', 409, 'thread_detached');
  }

  const baselineAt = messages ? baselineFor(input.mode, messages, nowIso) : nowIso;
  const answer = messages ? findAnswer(input.mode, baselineAt, messages) : null;
  const followUp: FollowUpState = {
    mode: input.mode,
    days: input.days,
    baseline_at: baselineAt,
    baseline_source: messages ? 'thread' : 'fallback',
    state: messages ? 'waiting' : 'unchecked',
    checked_at: messages ? nowIso : null,
    error,
  };
  const existing = openFollowUp(db, thread.id);

  if (answer) {
    const answered: FollowUpState = { ...followUp, state: 'answered', answered_at: answer.at, answered_by: answer.from };
    // An older follow-up on this thread is over too.
    if (existing && markAnswered(db, existing, followUp, answer, nowIso)) notifyAnswered(existing);
    return { reminderId: null, created: false, followUp: answered, emailThreadId: thread.id };
  }

  const triggerAt = new Date(new Date(baselineAt).getTime() + input.days * DAY_MS).toISOString();
  const subject = thread.subject || card.title;
  const message = input.message?.trim()
    || (input.mode === 'await_reply' ? `Нет ответа: «${subject}»` : `Ответить: «${subject}»`);
  const cardMeta = { follow_up: followUp };

  if (existing) {
    const meta = safeJsonParse<Record<string, unknown>>(existing.source_meta, {});
    db.prepare(`
      UPDATE reminders SET status = 'scheduled', snoozed_until = NULL, trigger_at = ?, channel = ?, timezone = ?,
        message = ?, source_meta = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(triggerAt, input.channel, input.timezone, message, JSON.stringify({ ...meta, ...cardMeta }), existing.id);
    refreshEmailThreads(db, card.id);
    return { reminderId: existing.id, created: false, followUp, emailThreadId: thread.id };
  }

  const id = newId();
  db.prepare(`
    INSERT INTO reminders (id, card_id, board_id, kind, channel, status, trigger_at, timezone, message, source, source_meta, email_thread_id)
    VALUES (?, ?, ?, 'follow_up', ?, 'scheduled', ?, ?, ?, 'email', ?, ?)
  `).run(id, card.id, card.board_id, input.channel, triggerAt, input.timezone, message, JSON.stringify(cardMeta), thread.id);
  refreshEmailThreads(db, card.id);
  return { reminderId: id, created: true, followUp, emailThreadId: thread.id };
}

// ---------------------------------------------------------------- sync

export interface FollowUpSyncStatus {
  ok: boolean;
  lastSyncAt: string | null;
  active: number;
  answered: number;
  failed: number;
  error: string | null;
}

let status: FollowUpSyncStatus = { ok: false, lastSyncAt: null, active: 0, answered: 0, failed: 0, error: 'not synced yet' };
let running: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let shutdown: AbortController | null = null;

type SyncRow = ActiveFollowUpRow & Pick<EmailThreadRow, 'provider' | 'account' | 'thread_id' | 'received_at'>;

/** Read the thread of every follow-up still in play once; dismiss the ones whose answer arrived. */
export async function runFollowUpSync(deps: { fetchThread?: ThreadFetcher; now?: () => Date; config?: AppConfig } = {}): Promise<void> {
  if (running) return running;
  running = (async () => {
    const db = getDb();
    const config = deps.config ?? loadConfig();
    const fetchThread = deps.fetchThread ?? fetchThreadMessages;
    const lateSince = new Date((deps.now ?? (() => new Date()))().getTime() - LATE_ANSWER_DAYS * DAY_MS).toISOString();
    // Active follow-ups, and fired ones for a late answer unless the thread has an active one again.
    const rows = db.prepare(`
      SELECT reminders.id, reminders.card_id, reminders.board_id, reminders.timezone, reminders.source_meta,
        t.provider, t.account, t.thread_id, t.received_at
      FROM reminders
      JOIN card_email_threads t ON t.id = reminders.email_thread_id AND t.card_id = reminders.card_id
      JOIN cards ON cards.id = reminders.card_id
      WHERE reminders.kind = 'follow_up' AND cards.deleted_at IS NULL
        AND (reminders.status IN ('scheduled', 'snoozed')
          OR (reminders.status = 'fired' AND COALESCE(reminders.last_fired_at, reminders.trigger_at) >= ?
            AND NOT EXISTS (
              SELECT 1 FROM reminders other
              WHERE other.email_thread_id = reminders.email_thread_id AND other.kind = 'follow_up'
                AND other.status IN ('scheduled', 'snoozed')
            )))
    `).all(lateSince) as SyncRow[];

    let answered = 0;
    let failed = 0;
    let lastError: string | null = null;
    for (const row of rows) {
      if (shutdown?.signal.aborted) return; // shutting down: never write after close
      const meta = safeJsonParse<{ follow_up?: FollowUpState }>(row.source_meta, {});
      const follow = meta.follow_up;
      if (!follow) continue;
      const email = threadEmail(row);
      const nowIso = (deps.now ?? (() => new Date()))().toISOString();
      // Compare-and-set on the meta read above: a follow-up re-set, dismissed or detached
      // while the thread was being read keeps its new values, and the next run checks it.
      const record = (patch: Partial<FollowUpState>) => {
        const updated = db.prepare(`
          UPDATE reminders SET source_meta = ?
          WHERE id = ? AND status IN ('scheduled', 'snoozed', 'fired') AND source_meta = ?
            AND card_id IN (SELECT id FROM cards WHERE deleted_at IS NULL)
        `).run(JSON.stringify({ ...meta, follow_up: { ...follow, ...patch } }), row.id, row.source_meta);
        // The badge shows state and error, not the check time: only a change reaches the board.
        if (updated.changes > 0 && refreshEmailThreads(db, row.card_id)) notifyCardChanged(row);
      };
      const account = mailAccountFor(config, email);
      if (!account) {
        failed++;
        lastError = `mailbox ${email.account} is not configured for reading`;
        record({ state: 'unchecked', checked_at: nowIso, error: lastError });
        continue;
      }
      try {
        const signal = shutdown
          ? AbortSignal.any([shutdown.signal, AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS)])
          : AbortSignal.timeout(THREAD_FETCH_TIMEOUT_MS);
        const messages = await fetchThread(account, email, signal);
        if (shutdown?.signal.aborted) return;
        // A follow-up made while the thread was unreadable counted from its creation time;
        // the first good read anchors it on the thread, as if it had been read then.
        const rebased = follow.baseline_source === 'fallback';
        const current: FollowUpState = rebased
          ? { ...follow, baseline_at: baselineFor(follow.mode, messages, follow.baseline_at), baseline_source: 'thread' }
          : follow;
        const answer = findAnswer(current.mode, current.baseline_at, messages);
        if (answer) {
          if (markAnswered(db, row, current, answer, nowIso)) {
            answered++;
            notifyAnswered(row);
          }
        } else if (rebased) {
          const triggerAt = new Date(new Date(current.baseline_at).getTime() + current.days * DAY_MS).toISOString();
          const updated = db.prepare(`UPDATE reminders SET trigger_at = ?, source_meta = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('scheduled', 'snoozed') AND source_meta = ?`)
            .run(triggerAt, JSON.stringify({ ...meta, follow_up: { ...current, state: 'waiting', checked_at: nowIso, error: null } }), row.id, row.source_meta);
          if (updated.changes > 0 && refreshEmailThreads(db, row.card_id)) notifyCardChanged(row);
        } else {
          record({ state: 'waiting', checked_at: nowIso, error: null });
        }
      } catch (err) {
        if (shutdown?.signal.aborted) return;
        failed++;
        lastError = err instanceof Error ? err.message : String(err);
        record({ checked_at: nowIso, error: lastError });
        console.warn(`[follow-up] reminder ${row.id}: thread check failed — ${lastError}`);
      }
    }
    status = {
      ok: failed === 0,
      lastSyncAt: new Date().toISOString(),
      active: rows.length - answered,
      answered,
      failed,
      error: lastError,
    };
  })().catch((err) => {
    console.error('[follow-up] sync run failed:', err);
    status = { ...status, ok: false, error: err instanceof Error ? err.message : String(err) };
  }).finally(() => {
    running = null;
  });
  return running;
}

export function getFollowUpSyncStatus(): FollowUpSyncStatus {
  return status;
}

export function startFollowUpSync(): void {
  if (timer) return;
  shutdown = new AbortController();
  void runFollowUpSync();
  timer = setInterval(() => { void runFollowUpSync(); }, FOLLOW_UP_SYNC_INTERVAL_MS);
  timer.unref();
}

/** Abort in-flight requests before the database closes. */
export function stopFollowUpSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  shutdown?.abort(new Error('shutting down'));
}

export function resetFollowUpSyncForTests(): void {
  stopFollowUpSync();
  shutdown = null;
  running = null;
  status = { ok: false, lastSyncAt: null, active: 0, answered: 0, failed: 0, error: 'not synced yet' };
}
