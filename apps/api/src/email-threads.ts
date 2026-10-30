/**
 * Email threads of a card: one card can follow threads in several mailboxes
 * (a personal Gmail, a work Outlook). `card_email_threads` is the truth: one row per
 * thread, a thread belongs to one card (UNIQUE `source_uid`, the same key a capture of
 * that thread uses). The card a capture made keeps its provenance (`source_meta.email`,
 * the `[from:email]` link in Markdown); that thread is its `origin` row. Threads attached
 * later are DB-only, like links added through the API and reminders (ADR 0001 amendment).
 *
 * `cards.email_threads` is a JSON projection of the rows plus each thread's follow-up, so
 * every card the API returns carries what the board's mail badges show (the same pattern
 * as `cards.calendar_events`). Whoever changes a thread or a follow-up calls
 * `refreshEmailThreads`; the follow-up sync and every boot refresh it too.
 *
 * Functions here take the database as a parameter: `db.ts` runs the migration at open.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { safeJsonParse } from './utils.js';
import { emailSourceMeta, emailSourceUid, emailSourceUrl, EMAIL_PROVIDERS, type EmailProvider, type EmailRef } from './email-provenance.js';

export interface EmailThreadRow {
  id: string;
  card_id: string;
  source_uid: string;
  provider: EmailProvider;
  account: string;
  message_id: string;
  thread_id: string | null;
  internet_message_id: string | null;
  subject: string | null;
  from_addr: string | null;
  received_at: string | null;
  origin: number;
  created_at: string;
}

/** A thread's follow-up as the board shows it; `state` is the follow-up's own (waiting/unchecked/answered). */
export interface EmailFollowUpView {
  reminder_id: string;
  mode: string | null;
  days: number | null;
  state: string | null;
  /** The reminder's status: scheduled, snoozed, fired or dismissed. */
  status: string;
  trigger_at: string;
  snoozed_until: string | null;
  last_fired_at: string | null;
  answered_at: string | null;
  answered_by: string | null;
  error: string | null;
}

export interface EmailThreadView {
  id: string;
  provider: EmailProvider;
  account: string;
  subject: string | null;
  from: string | null;
  received_at: string | null;
  internet_message_id: string | null;
  url: string;
  origin: boolean;
  follow_up: EmailFollowUpView | null;
}

export class EmailThreadError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function newThreadId(): string {
  return createHash('sha256').update(`email-thread|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12);
}

/** The `inbox_captures` key of a thread: the same as `makeCaptureKey('email', uid)` in ingest. */
export function emailCaptureKey(sourceUid: string): string {
  return createHash('sha256').update(`email|${sourceUid}`).digest('hex');
}

function threadRef(row: Pick<EmailThreadRow, 'provider' | 'account' | 'message_id' | 'thread_id'>): EmailRef {
  return {
    provider: row.provider,
    account: row.account,
    message_id: row.message_id,
    ...(row.thread_id ? { thread_id: row.thread_id } : {}),
  };
}

export function threadsOfCard(db: Database.Database, cardId: string): EmailThreadRow[] {
  return db.prepare('SELECT * FROM card_email_threads WHERE card_id = ? ORDER BY origin DESC, created_at ASC, id ASC')
    .all(cardId) as EmailThreadRow[];
}

export function threadById(db: Database.Database, threadId: string): EmailThreadRow | undefined {
  return db.prepare('SELECT * FROM card_email_threads WHERE id = ?').get(threadId) as EmailThreadRow | undefined;
}

/** Insert the thread row of a validated email reference; the caller owns the transaction. */
export function insertThread(db: Database.Database, cardId: string, ref: EmailRef, origin: boolean): EmailThreadRow {
  const meta = emailSourceMeta(ref);
  const id = newThreadId();
  db.prepare(`
    INSERT INTO card_email_threads (
      id, card_id, source_uid, provider, account, message_id, thread_id, internet_message_id,
      subject, from_addr, received_at, origin
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, cardId, emailSourceUid(ref), meta.provider, meta.account, meta.message_id, meta.thread_id ?? null,
    meta.internet_message_id ?? null, meta.subject ?? null, meta.from ?? null, meta.received_at ?? null, origin ? 1 : 0,
  );
  return threadById(db, id)!;
}

interface FollowUpRow {
  id: string;
  status: string;
  trigger_at: string;
  snoozed_until: string | null;
  last_fired_at: string | null;
  source_meta: string;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The thread's current follow-up: an active one, else a fired one, else the last one. */
function followUpOf(db: Database.Database, threadId: string): EmailFollowUpView | null {
  const row = db.prepare(`
    SELECT id, status, trigger_at, snoozed_until, last_fired_at, source_meta FROM reminders
    WHERE email_thread_id = ? AND kind = 'follow_up'
    ORDER BY CASE status WHEN 'scheduled' THEN 0 WHEN 'snoozed' THEN 0 WHEN 'fired' THEN 1 ELSE 2 END,
      updated_at DESC, created_at DESC
    LIMIT 1
  `).get(threadId) as FollowUpRow | undefined;
  if (!row) return null;
  const follow = safeJsonParse<Record<string, unknown>>(row.source_meta, {}).follow_up as Record<string, unknown> | undefined;
  return {
    reminder_id: row.id,
    mode: stringOrNull(follow?.mode),
    days: typeof follow?.days === 'number' ? follow.days : null,
    state: stringOrNull(follow?.state),
    status: row.status,
    trigger_at: row.trigger_at,
    snoozed_until: row.snoozed_until,
    last_fired_at: row.last_fired_at,
    answered_at: stringOrNull(follow?.answered_at),
    answered_by: stringOrNull(follow?.answered_by),
    error: stringOrNull(follow?.error),
  };
}

export function emailThreadViews(db: Database.Database, cardId: string): EmailThreadView[] {
  return threadsOfCard(db, cardId).map((row) => ({
    id: row.id,
    provider: row.provider,
    account: row.account,
    subject: row.subject,
    from: row.from_addr,
    received_at: row.received_at,
    internet_message_id: row.internet_message_id,
    url: emailSourceUrl(threadRef(row)),
    origin: row.origin === 1,
    follow_up: followUpOf(db, row.id),
  }));
}

/** Rewrite the card's `email_threads` projection; true when it changed. */
export function refreshEmailThreads(db: Database.Database, cardId: string): boolean {
  const next = JSON.stringify(emailThreadViews(db, cardId));
  const result = db.prepare('UPDATE cards SET email_threads = ? WHERE id = ? AND COALESCE(email_threads, \'[]\') != ?')
    .run(next, cardId, next);
  return result.changes > 0;
}

// ---------------------------------------------------------------- migration

interface LegacyEmailCard {
  id: string;
  source_meta: string;
}

function legacyRef(meta: Record<string, unknown>): EmailRef | null {
  const email = meta.email as Record<string, unknown> | undefined;
  if (!email) return null;
  const provider = email.provider;
  if (typeof provider !== 'string' || !(EMAIL_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (typeof email.account !== 'string' || typeof email.message_id !== 'string') return null;
  const ref: EmailRef = { provider: provider as EmailProvider, account: email.account, message_id: email.message_id };
  for (const key of ['thread_id', 'internet_message_id', 'subject', 'from', 'received_at'] as const) {
    if (typeof email[key] === 'string') ref[key] = email[key] as string;
  }
  return ref;
}

/**
 * Give every card made from an email its origin thread row, tie the follow-ups made by
 * `createFollowUp` (they carry `source_meta.follow_up`) to that thread, and refresh the
 * projections. Idempotent; runs in one transaction and throws on any conflict instead
 * of skipping it, so a database it cannot migrate does not boot half-migrated.
 */
export function migrateEmailThreads(db: Database.Database): void {
  const run = db.transaction(() => {
    const cards = db.prepare(`
      SELECT id, source_meta FROM cards
      WHERE source = 'email'
        AND NOT EXISTS (SELECT 1 FROM card_email_threads t WHERE t.card_id = cards.id AND t.origin = 1)
    `).all() as LegacyEmailCard[];
    let unreadable = 0;
    for (const card of cards) {
      const ref = legacyRef(safeJsonParse<Record<string, unknown>>(card.source_meta, {}));
      if (!ref) {
        unreadable++;
        continue;
      }
      const owner = db.prepare('SELECT card_id FROM card_email_threads WHERE source_uid = ?').get(emailSourceUid(ref)) as
        | { card_id: string }
        | undefined;
      if (owner) {
        throw new Error(`card ${card.id}: its email thread already belongs to card ${owner.card_id}`);
      }
      insertThread(db, card.id, ref, true);
    }
    // Such a card never had a thread to follow (follow-ups needed source_meta.email), so it loses nothing.
    if (unreadable > 0) {
      console.warn(`[db] ${unreadable} email card(s) have no readable source_meta.email: no mail thread for them`);
    }

    const followUps = db.prepare(`
      SELECT reminders.id, reminders.card_id, t.id AS thread_id FROM reminders
      LEFT JOIN card_email_threads t ON t.card_id = reminders.card_id AND t.origin = 1
      WHERE reminders.kind = 'follow_up' AND reminders.source = 'email' AND reminders.email_thread_id IS NULL
        AND json_extract(reminders.source_meta, '$.follow_up') IS NOT NULL
    `).all() as Array<{ id: string; card_id: string; thread_id: string | null }>;
    // A follow-up without a thread would silently stop being checked: refuse instead.
    const orphans = followUps.filter((row) => !row.thread_id);
    if (orphans.length > 0) {
      throw new Error(`follow-up(s) ${orphans.map((r) => `${r.id} (card ${r.card_id})`).join(', ')} have no readable email on their card`);
    }
    for (const row of followUps) {
      db.prepare('UPDATE reminders SET email_thread_id = ? WHERE id = ?').run(row.thread_id, row.id);
    }

    const stale = db.prepare(`
      SELECT DISTINCT card_id AS id FROM card_email_threads
      UNION SELECT id FROM cards WHERE COALESCE(email_threads, '[]') != '[]'
    `).all() as Array<{ id: string }>;
    for (const { id } of stale) refreshEmailThreads(db, id);
  });
  try {
    run();
  } catch (err) {
    throw new Error(`Database migration failed (email threads): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- attach / detach

export interface AttachResult {
  thread: EmailThreadRow;
  created: boolean;
}

/**
 * Attach a thread to a live card. The thread's capture key then points at this card,
 * so capturing the thread later returns it instead of making a second card. A thread
 * on another card is refused (409) with that card's id. An explicit attach takes over
 * the key of a capture whose card was deleted: the owner chose this card for it.
 */
export function attachEmailThread(db: Database.Database, cardId: string, ref: EmailRef): AttachResult {
  if (!ref.thread_id) {
    throw new EmailThreadError('An attached email needs its thread id', 400, 'no_thread_id');
  }
  const uid = emailSourceUid(ref);
  const captureKey = emailCaptureKey(uid);
  return db.transaction((): AttachResult => {
    const card = db.prepare('SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL').get(cardId);
    if (!card) throw new EmailThreadError('Card not found', 404, 'card_not_found');

    const existing = db.prepare('SELECT * FROM card_email_threads WHERE source_uid = ?').get(uid) as EmailThreadRow | undefined;
    if (existing) {
      if (existing.card_id === cardId) return { thread: existing, created: false };
      throw new EmailThreadError(`This email thread belongs to card ${existing.card_id}`, 409, 'thread_on_other_card', { card_id: existing.card_id });
    }

    const capture = db.prepare('SELECT card_id, status FROM inbox_captures WHERE capture_key = ?').get(captureKey) as
      | { card_id: string | null; status: string }
      | undefined;
    if (capture?.card_id && capture.card_id !== cardId) {
      throw new EmailThreadError(`This email thread belongs to card ${capture.card_id}`, 409, 'thread_on_other_card', { card_id: capture.card_id });
    }
    if (capture?.status === 'pending') {
      throw new EmailThreadError('This email thread is being captured right now', 409, 'capture_pending');
    }

    const thread = insertThread(db, cardId, ref, false);
    if (capture) {
      db.prepare(`
        UPDATE inbox_captures SET card_id = ?, status = 'completed', updated_at = datetime('now') WHERE capture_key = ?
      `).run(cardId, captureKey);
    } else {
      db.prepare(`
        INSERT INTO inbox_captures (capture_key, card_id, source, source_uid, request_hash, status)
        VALUES (?, ?, 'email', ?, ?, 'completed')
      `).run(captureKey, cardId, uid, createHash('sha256').update(`attach|${uid}`).digest('hex'));
    }
    db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);
    refreshEmailThreads(db, cardId);
    return { thread, created: true };
  })();
}

/**
 * Detach an attached thread: its follow-up stops and its capture key is released, so
 * the thread can be captured or attached again. The origin thread stays: it is the
 * card's provenance and its link lives in Markdown.
 */
export function detachEmailThread(db: Database.Database, cardId: string, threadId: string, nowIso: string): void {
  db.transaction(() => {
    const thread = threadById(db, threadId);
    if (!thread || thread.card_id !== cardId) throw new EmailThreadError('Email thread not found on this card', 404, 'thread_not_found');
    if (thread.origin === 1) {
      throw new EmailThreadError('The card was made from this email; it cannot be detached', 400, 'origin_thread');
    }
    db.prepare(`
      UPDATE reminders SET status = 'dismissed', dismissed_at = ?, updated_at = datetime('now')
      WHERE email_thread_id = ? AND kind = 'follow_up' AND status IN ('scheduled', 'snoozed', 'fired')
    `).run(nowIso, threadId);
    db.prepare('DELETE FROM inbox_captures WHERE capture_key = ? AND card_id = ?').run(emailCaptureKey(thread.source_uid), cardId);
    db.prepare('DELETE FROM card_email_threads WHERE id = ?').run(threadId);
    db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);
    refreshEmailThreads(db, cardId);
  })();
}
