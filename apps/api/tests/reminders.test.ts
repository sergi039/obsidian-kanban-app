import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;

const broadcast = vi.fn();

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../src/ws.js', () => ({
  broadcast: (...args: unknown[]) => broadcast(...args),
}));

const { default: reminderRoutes } = await import('../src/routes/reminders.js');

function createApp(): Hono {
  const app = new Hono();
  app.route('/api/reminders', reminderRoutes);
  return app;
}

async function createReminder(app: Hono, body: Record<string, unknown>) {
  const res = await app.request('/api/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() as Record<string, unknown> };
}

describe('reminders routes', () => {
  beforeEach(() => {
    broadcast.mockClear();
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        raw_line TEXT NOT NULL DEFAULT '',
        line_number INTEGER NOT NULL DEFAULT 0,
        is_done INTEGER NOT NULL DEFAULT 0,
        priority TEXT DEFAULT NULL,
        labels TEXT DEFAULT '[]',
        due_date TEXT DEFAULT NULL,
        sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '',
        source_fingerprint TEXT DEFAULT NULL,
        links TEXT DEFAULT '[]',
        source TEXT,
        source_uid TEXT,
        source_url TEXT,
        source_meta TEXT DEFAULT '{}',
        seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE reminders (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        board_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'custom',
        channel TEXT NOT NULL DEFAULT 'in_app',
        status TEXT NOT NULL DEFAULT 'scheduled',
        trigger_at TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        message TEXT DEFAULT '',
        snoozed_until TEXT,
        last_fired_at TEXT,
        dismissed_at TEXT,
        source TEXT,
        source_uid TEXT,
        source_url TEXT,
        source_meta TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    testDb.prepare('CREATE INDEX idx_reminders_due ON reminders(status, trigger_at, snoozed_until)').run();
    testDb.prepare('INSERT INTO cards (id, board_id, title, column_name) VALUES (?, ?, ?, ?)').run('c1', 'b1', 'Reply to customer', 'Backlog');
    testDb.prepare('INSERT INTO cards (id, board_id, title, column_name) VALUES (?, ?, ?, ?)').run('c2', 'b2', 'Personal task', 'Backlog');
  });

  afterEach(() => {
    testDb.close();
  });

  it('creates a reminder for an existing card and derives board_id', async () => {
    const app = createApp();
    const { res, json } = await createReminder(app, {
      card_id: 'c1',
      kind: 'follow_up',
      channel: 'macos',
      trigger_at: '2026-06-04T09:00:00+02:00',
      timezone: 'Europe/Madrid',
      message: 'Check reply',
      source: 'email',
      source_uid: 'email:gmail:me:thread:t1',
      source_url: 'https://mail.google.com/mail/u/0/#all/t1',
      source_meta: { provider: 'gmail' },
    });

    expect(res.status).toBe(201);
    expect(json.id).toBeTruthy();
    expect(json.card_id).toBe('c1');
    expect(json.board_id).toBe('b1');
    expect(json.kind).toBe('follow_up');
    expect(json.channel).toBe('macos');
    expect(json.status).toBe('scheduled');
    expect(json.trigger_at).toBe('2026-06-04T07:00:00.000Z');
    expect(json.card_title).toBe('Reply to customer');
    expect(json.source_meta).toEqual({ provider: 'gmail' });
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'reminder-created', cardId: 'c1', boardId: 'b1' }));
  });

  it('rejects reminders for unknown cards and invalid datetimes', async () => {
    const app = createApp();
    const missing = await createReminder(app, {
      card_id: 'missing',
      trigger_at: '2026-06-04T09:00:00Z',
    });
    expect(missing.res.status).toBe(404);

    const invalid = await createReminder(app, {
      card_id: 'c1',
      trigger_at: 'not-a-date',
    });
    expect(invalid.res.status).toBe(400);

    const dateOnly = await createReminder(app, {
      card_id: 'c1',
      trigger_at: '2026-06-04',
    });
    expect(dateOnly.res.status).toBe(400);
  });

  it('lists reminders by board, card, status, and channel', async () => {
    const app = createApp();
    const r1 = await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T09:00:00Z',
    });
    await createReminder(app, {
      card_id: 'c2',
      channel: 'browser',
      trigger_at: '2026-06-04T10:00:00Z',
    });

    const list = await app.request('/api/reminders?board_id=b1&card_id=c1&status=scheduled&channel=macos');
    expect(list.status).toBe(200);
    const body = await list.json() as Array<Record<string, unknown>>;
    expect(body.map((row) => row.id)).toEqual([r1.json.id]);

    const unscoped = await app.request('/api/reminders');
    expect(unscoped.status).toBe(400);
  });

  it('returns an existing reminder for duplicate source identity', async () => {
    const app = createApp();
    const first = await createReminder(app, {
      card_id: 'c1',
      trigger_at: '2026-06-04T09:00:00Z',
      source: 'email',
      source_uid: 'email:gmail:me:thread:t1',
      message: 'First',
    });
    const second = await createReminder(app, {
      card_id: 'c1',
      trigger_at: '2026-06-05T09:00:00Z',
      source: 'email',
      source_uid: 'email:gmail:me:thread:t1',
      message: 'Second',
    });

    expect(first.res.status).toBe(201);
    expect(second.res.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(second.json.trigger_at).toBe('2026-06-04T09:00:00.000Z');
  });

  it('returns only due scheduled and due snoozed reminders', async () => {
    const app = createApp();
    const due = await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T08:00:00Z',
    });
    await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T10:00:00Z',
    });
    const snoozed = await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T07:00:00Z',
    });
    await app.request(`/api/reminders/${snoozed.json.id}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2026-06-04T08:30:00Z' }),
    });

    const notYet = await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T06:00:00Z',
    });
    await app.request(`/api/reminders/${notYet.json.id}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2026-06-04T09:30:00Z' }),
    });

    const dismissed = await createReminder(app, {
      card_id: 'c1',
      channel: 'macos',
      trigger_at: '2026-06-04T05:00:00Z',
    });
    await app.request(`/api/reminders/${dismissed.json.id}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const res = await app.request('/api/reminders/due?before=2026-06-04T09:00:00Z&channel=macos');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body.map((row) => row.id)).toEqual([due.json.id, snoozed.json.id]);
    expect(body[0].effective_at).toBe('2026-06-04T08:00:00.000Z');
    expect(body[1].effective_at).toBe('2026-06-04T08:30:00.000Z');
  });

  it('snoozes, fires, and dismisses reminders for polling agents', async () => {
    const app = createApp();
    const created = await createReminder(app, {
      card_id: 'c1',
      trigger_at: '2026-06-04T08:00:00Z',
    });

    const snooze = await app.request(`/api/reminders/${created.json.id}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ until: '2026-06-04T12:00:00+02:00' }),
    });
    expect(snooze.status).toBe(200);
    const snoozed = await snooze.json() as Record<string, unknown>;
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozed_until).toBe('2026-06-04T10:00:00.000Z');

    const fire = await app.request(`/api/reminders/${created.json.id}/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: '2026-06-04T10:01:00Z' }),
    });
    expect(fire.status).toBe(200);
    const fired = await fire.json() as Record<string, unknown>;
    expect(fired.status).toBe('fired');
    expect(fired.last_fired_at).toBe('2026-06-04T10:01:00.000Z');

    const dismiss = await app.request(`/api/reminders/${created.json.id}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at: '2026-06-04T10:02:00Z' }),
    });
    expect(dismiss.status).toBe(200);
    const dismissed = await dismiss.json() as Record<string, unknown>;
    expect(dismissed.status).toBe('dismissed');
    expect(dismissed.dismissed_at).toBe('2026-06-04T10:02:00.000Z');
  });

  it('updates and deletes reminders', async () => {
    const app = createApp();
    const created = await createReminder(app, {
      card_id: 'c1',
      trigger_at: '2026-06-04T08:00:00Z',
    });

    const patch = await app.request(`/api/reminders/${created.json.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'due',
        channel: 'browser',
        trigger_at: '2026-06-05T08:00:00Z',
        message: 'New message',
        source_meta: { updated: true },
      }),
    });
    expect(patch.status).toBe(200);
    const updated = await patch.json() as Record<string, unknown>;
    expect(updated.kind).toBe('due');
    expect(updated.channel).toBe('browser');
    expect(updated.message).toBe('New message');
    expect(updated.source_meta).toEqual({ updated: true });

    const del = await app.request(`/api/reminders/${created.json.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const get = await app.request(`/api/reminders/${created.json.id}`);
    expect(get.status).toBe(404);
  });
});
