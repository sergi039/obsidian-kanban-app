import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;
let testConfig: AppConfig;
let vaultRoot = '/tmp/unused-vault';

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return { ...actual, loadConfig: () => testConfig };
});

vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../src/watcher.js', () => ({ suppressWatcher: vi.fn(), unsuppressWatcher: vi.fn() }));
vi.mock('../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

const { createTestDb } = await import('../src/db.js');
const { ConfigSchema } = await import('../src/config.js');
const {
  detectCalendarProvider,
  isValidEventStart,
  validateEventAccounts,
} = await import('../src/calendar-events.js');
const { default: cardRoutes } = await import('../src/routes/cards.js');
const { default: boardRoutes } = await import('../src/routes/boards.js');

const ACCOUNTS = [
  { id: 'work', label: 'Work', provider: 'outlook' as const, email: 'me@work.example' },
  { id: 'personal', label: 'Personal', provider: 'google' as const, email: 'me@home.example' },
];

const GOOGLE_URL = 'https://www.google.com/calendar/event?eid=YWJjMTIzIG1lQGhvbWUuZXhhbXBsZQ';
const OUTLOOK_URL = 'https://outlook.office.com/calendar/item/AAMkAD%3D';

function makeConfig(): AppConfig {
  return {
    vaultRoot,
    boards: [
      { id: 'b1', name: 'Work board', file: 'Tasks/Board.md', columns: ['Backlog', 'Done'], calendarAccount: 'work' },
    ],
    defaultColumns: ['Backlog', 'Done'],
    calendarAccounts: ACCOUNTS,
  };
}

function createApp(): Hono {
  const app = new Hono();
  app.route('/api/cards', cardRoutes);
  app.route('/api/boards', boardRoutes);
  return app;
}

function seedCard(id = 'c1') {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number)
    VALUES (?, 'b1', 'Backlog', 0, 'Call the client', '- [ ] Call the client', 1)
  `).run(id);
}

async function patchEvents(app: Hono, events: unknown) {
  const res = await app.request('/api/cards/c1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendar_events: events }),
  });
  return { res, json: await res.json() as Record<string, unknown> };
}

describe('calendar event validation helpers', () => {
  it('accepts all-day dates and timezone-aware datetimes only', () => {
    expect(isValidEventStart('2026-10-14')).toBe(true);
    expect(isValidEventStart('2026-10-14T10:00:00Z')).toBe(true);
    expect(isValidEventStart('2026-10-14T10:00+02:00')).toBe(true);
    expect(isValidEventStart('2026-10-14T10:00:00')).toBe(false); // no zone
    expect(isValidEventStart('2026-02-30')).toBe(false); // not a real date
    expect(isValidEventStart('2026-02-30T10:00:00Z')).toBe(false);
    expect(isValidEventStart('tomorrow')).toBe(false);
  });

  it('classifies provider by exact host', () => {
    expect(detectCalendarProvider(GOOGLE_URL)).toBe('google');
    expect(detectCalendarProvider('https://calendar.google.com/calendar/u/0/r/eventedit/abc')).toBe('google');
    expect(detectCalendarProvider(OUTLOOK_URL)).toBe('outlook');
    expect(detectCalendarProvider('https://outlook.office365.com/owa/?itemid=x&path=/calendar/item')).toBe('outlook');
    expect(detectCalendarProvider('https://www.google.com/search?q=calendar')).toBe('other');
    expect(detectCalendarProvider('https://calendar.google.com.evil.example/x')).toBe('other');
    expect(detectCalendarProvider('https://zoom.us/j/123')).toBe('other');
  });

  it('rejects unknown accounts and provider mismatches', () => {
    const base = { id: 'e1', title: '', start: null };
    expect(validateEventAccounts([{ ...base, url: GOOGLE_URL, account: 'personal' }], ACCOUNTS)).toBeNull();
    expect(validateEventAccounts([{ ...base, url: GOOGLE_URL, account: null }], ACCOUNTS)).toBeNull();
    expect(validateEventAccounts([{ ...base, url: 'https://zoom.us/j/1', account: 'work' }], ACCOUNTS)).toBeNull();
    expect(validateEventAccounts([{ ...base, url: GOOGLE_URL, account: 'nope' }], ACCOUNTS)).toMatch(/Unknown calendar account/);
    expect(validateEventAccounts([{ ...base, url: GOOGLE_URL, account: 'work' }], ACCOUNTS)).toMatch(/google link/);
  });

  it('fails config validation when a board references an unknown account', () => {
    const config = { ...makeConfig(), boards: [{ ...makeConfig().boards[0], calendarAccount: 'missing' }] };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join('; ')).toMatch(/unknown calendar account "missing"/);
    expect(ConfigSchema.safeParse(makeConfig()).success).toBe(true);
    const noCalendars = { vaultRoot: '/v', boards: [{ id: 'b', name: 'B', file: 'b.md', columns: ['A'] }], defaultColumns: ['A'] };
    expect(ConfigSchema.safeParse(noCalendars).success).toBe(true);
  });
});

describe('PATCH /api/cards/:id calendar_events', () => {
  beforeEach(() => {
    vaultRoot = '/tmp/unused-vault';
    testConfig = makeConfig();
    testDb = createTestDb();
    seedCard();
  });

  afterEach(() => testDb.close());

  it('returns an empty list for cards without events', async () => {
    const res = await createApp().request('/api/boards/b1');
    const body = await res.json() as { columns: Array<{ cards: Array<{ calendar_events: unknown }> }> };
    expect(body.columns[0].cards[0].calendar_events).toEqual([]);
  });

  it('stores events and returns them in card and board responses', async () => {
    const app = createApp();
    const events = [
      { id: 'e1', url: GOOGLE_URL, title: 'Kick-off', start: '2026-10-14T08:00:00.000Z', account: 'personal' },
      { id: 'e2', url: OUTLOOK_URL, title: '', start: '2026-10-15', account: 'work' },
      { id: 'e3', url: 'https://zoom.us/j/1', start: null, account: null },
    ];
    const { res, json } = await patchEvents(app, events);
    expect(res.status).toBe(200);
    expect(json.calendar_events).toEqual([
      events[0],
      events[1],
      { id: 'e3', url: 'https://zoom.us/j/1', title: '', start: null, account: null },
    ]);

    const boardRes = await app.request('/api/boards/b1');
    const board = await boardRes.json() as {
      calendarAccount: unknown;
      calendarAccounts: unknown[];
      columns: Array<{ cards: Array<{ calendar_events: unknown[] }> }>;
    };
    expect(board.calendarAccount).toEqual(ACCOUNTS[0]);
    expect(board.calendarAccounts).toEqual(ACCOUNTS);
    expect(board.columns[0].cards[0].calendar_events).toHaveLength(3);
  });

  it('clears events with an empty list', async () => {
    const app = createApp();
    await patchEvents(app, [{ id: 'e1', url: GOOGLE_URL, account: 'personal' }]);
    const { res, json } = await patchEvents(app, []);
    expect(res.status).toBe(200);
    expect(json.calendar_events).toEqual([]);
  });

  it.each([
    ['non-https url', [{ id: 'e1', url: 'http://calendar.google.com/x' }]],
    ['javascript url', [{ id: 'e1', url: 'javascript:alert(1)' }]],
    ['credentials in url', [{ id: 'e1', url: 'https://user:pw@calendar.google.com/x' }]],
    ['naive datetime', [{ id: 'e1', url: GOOGLE_URL, start: '2026-10-14T10:00' }]],
    ['impossible date', [{ id: 'e1', url: GOOGLE_URL, start: '2026-13-01' }]],
    ['duplicate ids', [{ id: 'e1', url: GOOGLE_URL }, { id: 'e1', url: OUTLOOK_URL }]],
    ['bad id', [{ id: 'has space', url: GOOGLE_URL }]],
    ['too long title', [{ id: 'e1', url: GOOGLE_URL, title: 'x'.repeat(201) }]],
    ['too many events', Array.from({ length: 21 }, (_, i) => ({ id: `e${i}`, url: GOOGLE_URL }))],
    ['unknown account', [{ id: 'e1', url: GOOGLE_URL, account: 'nope' }]],
    ['provider mismatch', [{ id: 'e1', url: OUTLOOK_URL, account: 'personal' }]],
  ])('rejects %s with 400 and keeps stored events', async (_label, events) => {
    const app = createApp();
    const { res } = await patchEvents(app, events);
    expect(res.status).toBe(400);
    const row = testDb.prepare('SELECT calendar_events FROM cards WHERE id = ?').get('c1') as { calendar_events: string };
    expect(JSON.parse(row.calendar_events)).toEqual([]);
  });
});

describe('calendar_events migration and preservation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-cal-'));
    vaultRoot = path.join(tmpDir, 'vault');
    testConfig = makeConfig();
  });

  afterEach(() => {
    testDb?.open && testDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds the column to a legacy database and survives repeated startup', async () => {
    const dbPath = path.join(tmpDir, 'legacy.db');
    const legacy = new Database(dbPath);
    // Base cards schema as shipped before calendar_events existed.
    legacy.exec(`CREATE TABLE cards (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
      position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL, line_number INTEGER NOT NULL,
      is_done INTEGER DEFAULT 0, priority TEXT, labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
      description TEXT DEFAULT '', source_fingerprint TEXT, source TEXT, source_uid TEXT, source_url TEXT,
      source_meta TEXT DEFAULT '{}', seq_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    legacy.prepare(`INSERT INTO cards (id, board_id, title, raw_line, line_number) VALUES ('old', 'b1', 'Old', '- [ ] Old', 1)`).run();
    legacy.close();

    const realDb = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
    for (let boot = 0; boot < 2; boot++) {
      const db = realDb.getDb(dbPath);
      const row = db.prepare('SELECT calendar_events FROM cards WHERE id = ?').get('old') as { calendar_events: string };
      expect(row.calendar_events).toBe('[]');
      realDb.closeDb();
    }
  });

  it('keeps events through reconcile and title write-back', async () => {
    testDb = createTestDb();
    const file = path.join(vaultRoot, 'Tasks/Board.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '- [ ] Call the client <!-- kb:id=c1 kb:col=Backlog -->\n- [ ] Other task <!-- kb:id=c2 -->\n', 'utf-8');

    const { reconcileBoard } = await import('../src/reconciler.js');
    const { writeBackTitle } = await import('../src/writeback.js');
    reconcileBoard(testConfig.boards[0], vaultRoot);

    const card = testDb.prepare("SELECT id FROM cards WHERE id = 'c1'").get() as { id: string };
    const events = JSON.stringify([{ id: 'e1', url: GOOGLE_URL, title: 'Call', start: '2026-10-14', account: 'personal' }]);
    testDb.prepare('UPDATE cards SET calendar_events = ? WHERE id = ?').run(events, card.id);

    writeFileSync(file, '- [x] Call the client <!-- kb:id=c1 kb:col=Done -->\n- [ ] Other task changed <!-- kb:id=c2 -->\n', 'utf-8');
    reconcileBoard(testConfig.boards[0], vaultRoot);
    expect(writeBackTitle(card.id, 'Call the client today').success).toBe(true);

    const row = testDb.prepare('SELECT title, calendar_events FROM cards WHERE id = ?').get(card.id) as {
      title: string;
      calendar_events: string;
    };
    expect(row.title).toBe('Call the client today');
    expect(row.calendar_events).toBe(events);
  });
});
