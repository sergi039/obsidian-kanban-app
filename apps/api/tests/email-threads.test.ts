import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, CalendarAccount } from '../src/config.js';
import type { ThreadMessage } from '../src/mail-followup.js';

let testDb: InstanceType<typeof Database>;
let testConfig: AppConfig;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadConfig: () => testConfig };
});
vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../src/watcher.js', () => ({ suppressWatcher: vi.fn(), unsuppressWatcher: vi.fn() }));
vi.mock('../src/automations.js', () => ({ fireEvent: vi.fn() }));
vi.mock('../src/obsidian-context.js', () => ({ notifyCardsClosed: vi.fn() }));

const NOW = new Date('2026-10-14T12:00:00Z');
const WORK: CalendarAccount = {
  id: 'work', label: 'Work', provider: 'outlook', email: 'owner@example.com',
  credentials: { type: 'graph-app', envFile: '/unused' },
};
const WORK_EMAIL = { provider: 'outlook', account: 'owner@example.com', message_id: 'AAMk-1', thread_id: 'conv-1', subject: 'Renewal' } as const;
const GMAIL_EMAIL = { provider: 'gmail', account: 'me@gmail.example', message_id: '18abc', thread_id: '18abc', subject: 'Renewal (personal)' } as const;
const msg = (at: string, outbound: boolean, from = outbound ? 'Owner' : 'Partner'): ThreadMessage => ({ at: new Date(at).toISOString(), outbound, from, auto: false });
const deps = (thread: ThreadMessage[]) => ({ fetchThread: async () => thread, now: () => NOW, config: testConfig });

function insertCard(id: string, extra: { source?: string; source_meta?: unknown; deleted_at?: string } = {}) {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, source, source_meta, deleted_at)
    VALUES (?, 'work', 'Backlog', 0, ?, ?, 1, ?, ?, ?)
  `).run(id, `Task ${id}`, `- [ ] Task ${id}`, extra.source ?? null, JSON.stringify(extra.source_meta ?? {}), extra.deleted_at ?? null);
}

function projection(cardId: string): Array<Record<string, any>> {
  const row = testDb.prepare('SELECT email_threads FROM cards WHERE id = ?').get(cardId) as { email_threads: string };
  return JSON.parse(row.email_threads);
}

async function cardsApp() {
  const { default: cardRoutes } = await import('../src/routes/cards.js');
  const { default: reminderRoutes } = await import('../src/routes/reminders.js');
  const app = new Hono();
  app.route('/api/cards', cardRoutes);
  app.route('/api/reminders', reminderRoutes);
  return app;
}

function request(app: Hono, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { createTestDb } = await import('../src/db.js');
  testDb = createTestDb();
  testConfig = { vaultRoot: '/tmp/unused', boards: [], defaultColumns: ['Backlog'], calendarAccounts: [WORK] };
  const { resetFollowUpSyncForTests } = await import('../src/mail-followup.js');
  resetFollowUpSyncForTests();
});

afterEach(() => testDb.close());

describe('migrateEmailThreads', () => {
  it('gives a card made from an email its origin thread and ties its earlier follow-ups to it', async () => {
    const { migrateEmailThreads } = await import('../src/email-threads.js');
    insertCard('mail0001', { source: 'email', source_meta: { email: WORK_EMAIL } });
    // A finished follow-up from before threads existed, and a plain reminder that must stay untouched.
    testDb.prepare(`
      INSERT INTO reminders (id, card_id, board_id, kind, status, trigger_at, source, source_meta)
      VALUES ('old-fu', 'mail0001', 'work', 'follow_up', 'dismissed', '2026-10-10T00:00:00Z', 'email', ?)
    `).run(JSON.stringify({ follow_up: { mode: 'await_reply', days: 3, state: 'answered', answered_by: 'Partner' } }));
    testDb.prepare(`
      INSERT INTO reminders (id, card_id, board_id, kind, status, trigger_at)
      VALUES ('custom1', 'mail0001', 'work', 'follow_up', 'scheduled', '2026-10-20T00:00:00Z')
    `).run();

    migrateEmailThreads(testDb);
    migrateEmailThreads(testDb); // idempotent

    const threads = testDb.prepare('SELECT * FROM card_email_threads').all() as Array<Record<string, unknown>>;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ card_id: 'mail0001', origin: 1, provider: 'outlook', thread_id: 'conv-1', source_uid: 'outlook:owner@example.com:thread:conv-1' });
    const reminders = testDb.prepare('SELECT id, email_thread_id FROM reminders ORDER BY id').all();
    expect(reminders).toEqual([{ id: 'custom1', email_thread_id: null }, { id: 'old-fu', email_thread_id: threads[0].id }]);
    expect(projection('mail0001')).toEqual([expect.objectContaining({
      origin: true,
      url: 'https://outlook.office.com/mail/deeplink/read/AAMk-1',
      follow_up: expect.objectContaining({ reminder_id: 'old-fu', status: 'dismissed', state: 'answered', answered_by: 'Partner' }),
    })]);
  });

  it('refuses to boot when a follow-up cannot be tied to a thread, but passes an email card without one', async () => {
    const { migrateEmailThreads } = await import('../src/email-threads.js');
    insertCard('bare0001', { source: 'email', source_meta: {} });
    migrateEmailThreads(testDb);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM card_email_threads').get()).toEqual({ n: 0 });

    testDb.prepare(`
      INSERT INTO reminders (id, card_id, board_id, kind, status, trigger_at, source, source_meta)
      VALUES ('lost-fu', 'bare0001', 'work', 'follow_up', 'scheduled', '2026-10-20T00:00:00Z', 'email', ?)
    `).run(JSON.stringify({ follow_up: { mode: 'await_reply', days: 3, state: 'waiting' } }));
    expect(() => migrateEmailThreads(testDb)).toThrow(/follow-up\(s\) lost-fu \(card bare0001\) have no readable email/);
  });

  it('refuses to boot when two cards claim the same thread instead of dropping one', async () => {
    const { migrateEmailThreads } = await import('../src/email-threads.js');
    insertCard('mail0001', { source: 'email', source_meta: { email: WORK_EMAIL } });
    insertCard('mail0002', { source: 'email', source_meta: { email: WORK_EMAIL } });
    expect(() => migrateEmailThreads(testDb)).toThrow(/Database migration failed \(email threads\).*already belongs to card/);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM card_email_threads').get()).toEqual({ n: 0 });
  });
});

describe('attach and detach', () => {
  beforeEach(async () => {
    const { migrateEmailThreads } = await import('../src/email-threads.js');
    insertCard('mail0001', { source: 'email', source_meta: { email: WORK_EMAIL } });
    insertCard('plain001');
    migrateEmailThreads(testDb);
  });

  it('follows a thread of a second mailbox on the same card (201, then 200)', async () => {
    const app = await cardsApp();
    const first = await request(app, 'POST', '/api/cards/mail0001/email-threads', GMAIL_EMAIL);
    expect(first.status).toBe(201);
    const body = await first.json();
    expect(body.card.email_threads.map((t: { account: string; origin: boolean }) => [t.account, t.origin]))
      .toEqual([['owner@example.com', true], ['me@gmail.example', false]]);
    expect(body.card.email_threads[1].url).toBe('https://mail.google.com/mail/u/me@gmail.example/#all/18abc');

    const again = await request(app, 'POST', '/api/cards/mail0001/email-threads', GMAIL_EMAIL);
    expect(again.status).toBe(200);
    expect((await again.json()).email_thread_id).toBe(body.email_thread_id);
  });

  it('refuses a thread that belongs to another card, a trashed card and an email without a thread id', async () => {
    const app = await cardsApp();
    const other = await request(app, 'POST', '/api/cards/plain001/email-threads', WORK_EMAIL);
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: 'thread_on_other_card', card_id: 'mail0001' });

    insertCard('trash001', { deleted_at: '2026-10-13T00:00:00Z' });
    expect((await request(app, 'POST', '/api/cards/trash001/email-threads', GMAIL_EMAIL)).status).toBe(404);

    const { thread_id: _thread, ...noThread } = GMAIL_EMAIL;
    const missing = await request(app, 'POST', '/api/cards/plain001/email-threads', noThread);
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('no_thread_id');
  });

  it('takes over the key of a thread whose card was deleted for good', async () => {
    const { emailCaptureKey } = await import('../src/email-threads.js');
    const uid = 'gmail:me@gmail.example:thread:18abc';
    testDb.prepare(`
      INSERT INTO inbox_captures (capture_key, card_id, source, source_uid, request_hash, status)
      VALUES (?, NULL, 'email', ?, 'h', 'completed')
    `).run(emailCaptureKey(uid), uid);
    const app = await cardsApp();
    expect((await request(app, 'POST', '/api/cards/plain001/email-threads', GMAIL_EMAIL)).status).toBe(201);
    expect(testDb.prepare('SELECT card_id FROM inbox_captures WHERE source_uid = ?').get(uid)).toEqual({ card_id: 'plain001' });
  });

  it('detaches an attached thread: its follow-up stops and the thread can be captured again', async () => {
    const app = await cardsApp();
    const { email_thread_id: threadId } = await (await request(app, 'POST', '/api/cards/mail0001/email-threads', GMAIL_EMAIL)).json();
    const { createFollowUp } = await import('../src/mail-followup.js');
    const { reminderId } = await createFollowUp(
      { cardId: 'mail0001', emailThreadId: threadId, mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      deps([]),
    );

    const origin = projection('mail0001')[0];
    expect((await request(app, 'DELETE', `/api/cards/mail0001/email-threads/${origin.id}`)).status).toBe(400);

    const res = await request(app, 'DELETE', `/api/cards/mail0001/email-threads/${threadId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).email_threads).toHaveLength(1);
    expect(testDb.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId)).toEqual({ status: 'dismissed' });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM inbox_captures WHERE source_uid = 'gmail:me@gmail.example:thread:18abc'").get()).toEqual({ n: 0 });
    expect((await request(app, 'DELETE', `/api/cards/mail0001/email-threads/${threadId}`)).status).toBe(404);

    // Its follow-up would never be read again: it cannot be brought back.
    const snooze = await request(app, 'POST', `/api/reminders/${reminderId}/snooze`, { minutes: 10 });
    expect(snooze.status).toBe(409);
    expect((await snooze.json()).code).toBe('thread_detached');
    expect((await request(app, 'PATCH', `/api/reminders/${reminderId}`, { status: 'scheduled' })).status).toBe(409);
    expect((await request(app, 'PATCH', `/api/reminders/${reminderId}`, { message: 'note' })).status).toBe(200);
    expect(testDb.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId)).toEqual({ status: 'dismissed' });
  });

  it('returns the card with the attached thread when that thread is captured again', async () => {
    const vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-threads-'));
    try {
      writeFileSync(path.join(vaultRoot, 'Work.md'), '# Work\n', 'utf-8');
      testConfig = { ...testConfig, vaultRoot, boards: [{ id: 'work', name: 'Work', file: 'Work.md', columns: ['Backlog', 'Done'] }] };
      const app = await cardsApp();
      await request(app, 'POST', '/api/cards/mail0001/email-threads', GMAIL_EMAIL);
      const capture = await request(app, 'POST', '/api/cards', { board_id: 'work', title: 'Same thread', email: { ...GMAIL_EMAIL, message_id: '18abd' } });
      expect(capture.status).toBe(200);
      expect((await capture.json()).id).toBe('mail0001');
    } finally {
      rmSync(vaultRoot, { recursive: true, force: true });
    }
  });
});

describe('follow-ups per thread', () => {
  let gmailThread: string;

  beforeEach(async () => {
    const { migrateEmailThreads, attachEmailThread } = await import('../src/email-threads.js');
    insertCard('mail0001', { source: 'email', source_meta: { email: WORK_EMAIL } });
    migrateEmailThreads(testDb);
    gmailThread = attachEmailThread(testDb, 'mail0001', { ...GMAIL_EMAIL }).thread.id;
  });

  it('asks which thread when the card follows several, and follows each on its own', async () => {
    const { createFollowUp } = await import('../src/mail-followup.js');
    const input = { cardId: 'mail0001', mode: 'await_reply' as const, days: 3, channel: 'macos', timezone: 'UTC' };
    await expect(createFollowUp(input, deps([]))).rejects.toMatchObject({
      code: 'thread_required',
      details: { threads: [expect.objectContaining({ account: 'owner@example.com' }), expect.objectContaining({ id: gmailThread })] },
    });

    const originThread = projection('mail0001')[0].id;
    const work = await createFollowUp({ ...input, emailThreadId: originThread }, deps([msg('2026-10-13T10:00Z', true)]));
    const personal = await createFollowUp({ ...input, emailThreadId: gmailThread, mode: 'owe_reply' }, deps([]));
    expect(work.reminderId).not.toBe(personal.reminderId);
    expect(projection('mail0001').map((t) => [t.id, t.follow_up?.status, t.follow_up?.mode])).toEqual([
      [originThread, 'scheduled', 'await_reply'],
      [gmailThread, 'scheduled', 'owe_reply'],
    ]);
  });

  it('follows a thread again after its earlier follow-up was answered', async () => {
    const { createFollowUp, runFollowUpSync } = await import('../src/mail-followup.js');
    const input = { cardId: 'mail0001', emailThreadId: gmailThread, mode: 'await_reply' as const, days: 3, channel: 'macos', timezone: 'UTC' };
    testConfig = { ...testConfig, calendarAccounts: [WORK, { id: 'me', label: 'Personal', provider: 'google', email: 'me@gmail.example', credentials: { type: 'google-oauth', clientEnvFile: '/unused', tokenFile: '/unused' } }] };
    const first = await createFollowUp(input, deps([msg('2026-10-13T10:00Z', true)]));
    await runFollowUpSync(deps([msg('2026-10-13T10:00Z', true), msg('2026-10-14T09:00Z', false)]));
    expect(testDb.prepare('SELECT status FROM reminders WHERE id = ?').get(first.reminderId)).toEqual({ status: 'dismissed' });

    const second = await createFollowUp(input, deps([msg('2026-10-13T10:00Z', true), msg('2026-10-14T09:00Z', false), msg('2026-10-14T11:00Z', true)]));
    expect(second).toMatchObject({ created: true });
    expect(second.reminderId).not.toBe(first.reminderId);
  });

  it('sees an answer that arrives after the reminder fired, within the late-answer window', async () => {
    const { createFollowUp, runFollowUpSync } = await import('../src/mail-followup.js');
    const originThread = projection('mail0001')[0].id;
    const { reminderId } = await createFollowUp(
      { cardId: 'mail0001', emailThreadId: originThread, mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      deps([msg('2026-10-01T10:00Z', true)]),
    );
    testDb.prepare("UPDATE reminders SET status = 'fired', last_fired_at = '2026-10-04T10:00:00.000Z' WHERE id = ?").run(reminderId);
    expect(projection('mail0001')[0].follow_up.status).toBe('scheduled'); // stale until something refreshes it

    await runFollowUpSync(deps([msg('2026-10-01T10:00Z', true), msg('2026-10-12T09:00Z', false, 'Partner')]));
    const row = testDb.prepare('SELECT status, source_meta FROM reminders WHERE id = ?').get(reminderId) as { status: string; source_meta: string };
    expect(row.status).toBe('dismissed');
    expect(JSON.parse(row.source_meta).follow_up).toMatchObject({ state: 'answered', answered_by: 'Partner' });
    expect(projection('mail0001')[0].follow_up).toMatchObject({ status: 'dismissed', state: 'answered' });
  });

  it('stops reading a fired follow-up after the late-answer window', async () => {
    const { createFollowUp, runFollowUpSync } = await import('../src/mail-followup.js');
    const originThread = projection('mail0001')[0].id;
    const { reminderId } = await createFollowUp(
      { cardId: 'mail0001', emailThreadId: originThread, mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      deps([msg('2026-08-01T10:00Z', true)]),
    );
    testDb.prepare("UPDATE reminders SET status = 'fired', last_fired_at = '2026-08-04T10:00:00.000Z' WHERE id = ?").run(reminderId);
    const fetchThread = vi.fn(async () => [msg('2026-08-01T10:00Z', true), msg('2026-10-12T09:00Z', false)]);
    await runFollowUpSync({ fetchThread, now: () => NOW, config: testConfig });
    expect(fetchThread).not.toHaveBeenCalled();
    expect(testDb.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId)).toEqual({ status: 'fired' });
  });

  it('does not follow a thread detached while it was being read', async () => {
    const { createFollowUp } = await import('../src/mail-followup.js');
    const { detachEmailThread } = await import('../src/email-threads.js');
    const fetchThread = async () => {
      detachEmailThread(testDb, 'mail0001', gmailThread, NOW.toISOString());
      return [];
    };
    await expect(createFollowUp(
      { cardId: 'mail0001', emailThreadId: gmailThread, mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      { fetchThread, now: () => NOW, config: { ...testConfig, calendarAccounts: [{ ...WORK, provider: 'google', email: 'me@gmail.example' }] } },
    )).rejects.toMatchObject({ code: 'thread_detached' });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM reminders').get()).toEqual({ n: 0 });
  });

  it('keeps the badge in step with the reminder routes, and refuses a second active follow-up on a thread', async () => {
    const app = await cardsApp();
    const created = await request(app, 'POST', '/api/reminders/follow-up', { card_id: 'mail0001', email_thread_id: gmailThread, days: 3 });
    expect(created.status).toBe(201);
    const first = (await created.json()).reminder.id;
    expect((await request(app, 'POST', `/api/reminders/${first}/dismiss`, {})).status).toBe(200);
    expect(projection('mail0001')[1].follow_up).toMatchObject({ reminder_id: first, status: 'dismissed' });

    const again = await request(app, 'POST', '/api/reminders/follow-up', { card_id: 'mail0001', email_thread_id: gmailThread, days: 5 });
    expect(again.status).toBe(201);
    const revive = await request(app, 'PATCH', `/api/reminders/${first}`, { status: 'scheduled' });
    expect(revive.status).toBe(409);
    expect((await revive.json()).code).toBe('thread_follow_up_active');
  });
});
