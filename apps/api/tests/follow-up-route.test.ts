import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  // No mailbox credentials: the route must still work, without touching the network.
  return { ...actual, loadConfig: () => ({ vaultRoot: '/tmp/unused', boards: [], defaultColumns: ['Backlog'], calendarAccounts: [] }) };
});
vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));

async function post(body: unknown) {
  const { default: reminderRoutes } = await import('../src/routes/reminders.js');
  const app = new Hono();
  app.route('/api/reminders', reminderRoutes);
  return app.request('/api/reminders/follow-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/reminders/follow-up', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testDb.prepare(`
      INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, source, source_meta)
      VALUES ('mail0001', 'work', 'Backlog', 0, 'Answer', '- [ ] Answer', 1, 'email', ?)
    `).run(JSON.stringify({ email: { provider: 'outlook', account: 'owner@example.com', message_id: 'm1', thread_id: 'conv-1' } }));
    testDb.prepare(`
      INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number)
      VALUES ('plain001', 'work', 'Backlog', 1, 'Plain', '- [ ] Plain', 2)
    `).run();
  });

  afterEach(() => testDb.close());

  it('creates a follow-up reminder (201) and reports why the thread was not checked', async () => {
    const res = await post({ card_id: 'mail0001', days: 3, timezone: 'Europe/Madrid' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reminder).toMatchObject({ card_id: 'mail0001', kind: 'follow_up', channel: 'macos', status: 'scheduled', card_title: 'Answer' });
    expect(body.follow_up).toMatchObject({ mode: 'await_reply', days: 3, state: 'unchecked', error: 'mailbox owner@example.com is not configured for reading' });
    expect(body.reminder.source_meta.follow_up.state).toBe('unchecked');
  });

  it('answers 200 with the same reminder when asked again', async () => {
    const first = await (await post({ card_id: 'mail0001', days: 3 })).json();
    const again = await post({ card_id: 'mail0001', days: 4 });
    expect(again.status).toBe(200);
    expect((await again.json()).reminder.id).toBe(first.reminder.id);
  });

  it.each([
    [{ card_id: 'plain001', days: 3 }, 400, 'not_an_email_card'],
    [{ card_id: 'nope', days: 3 }, 404, 'card_not_found'],
    [{ card_id: 'mail0001', days: 3, timezone: 'Mars/Olympus' }, 400, 'invalid_timezone'],
  ])('rejects %j with %i %s', async (body, status, code) => {
    const res = await post(body);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it('validates days and mode', async () => {
    expect((await post({ card_id: 'mail0001', days: 0 })).status).toBe(400);
    expect((await post({ card_id: 'mail0001', days: 3, mode: 'whenever' })).status).toBe(400);
  });
});
