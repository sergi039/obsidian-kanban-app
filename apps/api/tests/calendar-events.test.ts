import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;
let testConfig: AppConfig;
let tmpDir: string;
const broadcast = vi.fn();

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return { ...actual, loadConfig: () => testConfig };
});
vi.mock('../src/ws.js', () => ({ broadcast: (...args: unknown[]) => broadcast(...args) }));
vi.mock('../src/watcher.js', () => ({ suppressWatcher: vi.fn(), unsuppressWatcher: vi.fn() }));
vi.mock('../src/automations.js', () => ({ fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })) }));
const fetchGraphMock = vi.fn();
const fetchGoogleMock = vi.fn();
vi.mock('../src/calendar-providers.js', async () => {
  const actual = await vi.importActual<typeof import('../src/calendar-providers.js')>('../src/calendar-providers.js');
  return { ...actual, fetchGraphEvents: (...args: unknown[]) => fetchGraphMock(...args), fetchGoogleEvents: (...args: unknown[]) => fetchGoogleMock(...args) };
});

const { createTestDb } = await import('../src/db.js');
const { ConfigSchema } = await import('../src/config.js');
// Provider tests exercise the real fetchers; the sync tests use the mocks above.
const providers = await vi.importActual<typeof import('../src/calendar-providers.js')>('../src/calendar-providers.js');
const sync = await import('../src/calendar-sync.js');
const { default: cardRoutes } = await import('../src/routes/cards.js');
const { default: boardRoutes } = await import('../src/routes/boards.js');

const TRUSTED = new Set(['kanban.example']);
const NOW = Date.parse('2026-10-12T12:00:00Z');

function makeConfig(): AppConfig {
  return {
    vaultRoot: '/tmp/unused-vault',
    boards: [
      { id: 'vs', name: 'Work', file: 'Tasks/Work.md', columns: ['Backlog', 'Done'], calendarAccount: 'work' },
      { id: 'private', name: 'Private', file: 'Tasks/Private.md', columns: ['Backlog', 'Done'], calendarAccount: 'personal' },
    ],
    defaultColumns: ['Backlog', 'Done'],
    publicUrl: 'https://kanban.example',
    calendarAccounts: [
      { id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example', credentials: { type: 'graph-app', envFile: path.join(tmpDir, 'm365.env') } },
      {
        id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example',
        credentials: { type: 'google-oauth', clientEnvFile: path.join(tmpDir, 'google.env'), tokenFile: path.join(tmpDir, 'token.json') },
      },
    ],
  };
}

function card(id: string, board: string, extra: Partial<{ title: string; description: string; links: string; calendar_events: string }> = {}) {
  return { id, board_id: board, title: extra.title ?? `Task ${id}`, description: extra.description ?? '', links: extra.links ?? '[]', calendar_events: extra.calendar_events ?? '[]' };
}

function event(key: string, overrides: Partial<import('../src/calendar-providers.js').ProviderEvent> = {}) {
  return {
    key, seriesKey: key, url: `https://outlook.office365.com/owa/?itemid=${key}&exvsurl=1&path=/calendar/item`,
    title: `Event ${key}`, start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:00:00Z', text: `Event ${key}`, refs: [key],
    ...overrides,
  };
}

function link(cards: ReturnType<typeof card>[], snapshots: Map<string, ReturnType<typeof event>[]>, failed = new Set<string>()) {
  const providerMap = new Map([['work', 'outlook' as const], ['personal', 'google' as const]]);
  return sync.linkEventsToCards(cards, snapshots, providerMap, failed, TRUSTED, NOW).byCard;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-cal-'));
  testConfig = makeConfig();
  broadcast.mockClear();
});

afterEach(() => {
  sync.resetCalendarSyncForTests();
  providers.clearTokenCache();
  vi.unstubAllGlobals();
  fetchGraphMock.mockReset();
  fetchGoogleMock.mockReset();
  if (testDb?.open) testDb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('explicit references', () => {
  it('finds card links on the public host or localhost, decoding HTML entities', () => {
    const text = [
      'Kanban: https://kanban.example/?board=vs&card=abc12345',
      '<a href="http://127.0.0.1:4000/?board=private&amp;card=def67890">card</a>',
      'https://evil.example/?board=vs&card=zzz99999',
      'marker kb:id=ghi13579 done',
    ].join('\n');
    expect(sync.cardRefsInText(text, TRUSTED)).toEqual([
      { board: 'vs', card: 'abc12345' },
      { board: 'private', card: 'def67890' },
      { board: null, card: 'ghi13579' },
    ]);
  });

  it('reads Outlook itemids and Google eids that a card quotes', () => {
    const eid = Buffer.from('evt123 me@home.example').toString('base64url');
    const refs = sync.eventRefsInCard({
      title: 'Follow up',
      description: `See https://outlook.office365.com/owa/?itemid=AAMk%2Bx%3D&exvsurl=1 and https://www.google.com/calendar/event?eid=${eid}`,
      links: '[]',
    });
    expect([...refs].sort()).toEqual(['google:evt123', 'outlook:AAMk+x=']);
  });
});

describe('linking events to cards', () => {
  it('links an event to the card its body points at, and nothing else', () => {
    const cards = [card('abc12345', 'vs'), card('other001', 'vs', { title: 'Call the client about pricing' })];
    const linked = event('E1', { text: 'Call the client\nKanban: https://kanban.example/?board=vs&card=abc12345' });
    const unrelated = event('E2', { title: 'Call the client', text: 'Call the client about pricing' });
    const byCard = link(cards, new Map([['work', [linked, unrelated]]]));
    expect(byCard.get('abc12345')?.map((e) => e.title)).toEqual(['Event E1']);
    expect(byCard.get('other001')).toEqual([]);
    expect(byCard.get('abc12345')?.[0]).toMatchObject({ account: 'work', start: '2026-10-14T08:00:00Z', end: '2026-10-14T09:00:00Z' });
  });

  it('ignores a link whose board does not own the card', () => {
    const byCard = link([card('abc12345', 'vs')], new Map([['work', [event('E1', { text: 'https://kanban.example/?board=private&card=abc12345' })]]]));
    expect(byCard.get('abc12345')).toEqual([]);
  });

  it('ignores event links on look-alike hosts', () => {
    const refs = sync.eventRefsInCard({
      title: 't',
      description: 'https://outlook.evil.example/?itemid=E7 https://www.google.com/search?eid=ZXZ0MTIz',
      links: '[]',
    });
    expect([...refs]).toEqual([]);
    const byCard = link([card('abc12345', 'vs', { description: 'https://outlook.evil.example/?itemid=E7' })], new Map([['work', [event('E7')]]]));
    expect(byCard.get('abc12345')).toEqual([]);
  });

  it('links an event that the card quotes', () => {
    const cards = [card('abc12345', 'vs', { description: 'meeting: https://outlook.office365.com/owa/?itemid=E7&exvsurl=1' })];
    const byCard = link(cards, new Map([['work', [event('E7')]]]));
    expect(byCard.get('abc12345')?.map((e) => e.title)).toEqual(['Event E7']);
  });

  it('keeps one entry per recurring series: the next occurrence', () => {
    const text = 'https://kanban.example/?board=vs&card=abc12345';
    const occurrences = [
      event('O1', { seriesKey: 'S', start: '2026-10-05T08:00:00Z', end: '2026-10-05T09:00:00Z', text }),
      event('O2', { seriesKey: 'S', start: '2026-10-19T08:00:00Z', end: '2026-10-19T09:00:00Z', text }),
      event('O3', { seriesKey: 'S', start: '2026-10-26T08:00:00Z', end: '2026-10-26T09:00:00Z', text }),
    ];
    const byCard = link([card('abc12345', 'vs')], new Map([['work', occurrences]]));
    expect(byCard.get('abc12345')?.map((e) => e.start)).toEqual(['2026-10-19T08:00:00Z']);
  });

  it('keeps the previous events of an account whose fetch failed', () => {
    const previous = JSON.stringify([
      { id: 'w', url: 'u', title: 'old work', start: '2026-10-20', end: null, account: 'work' },
      { id: 'p', url: 'u', title: 'old personal', start: '2026-10-21', end: null, account: 'personal' },
    ]);
    const byCard = link([card('abc12345', 'vs', { calendar_events: previous })], new Map([['personal', []]]), new Set(['work']));
    expect(byCard.get('abc12345')?.map((e) => e.title)).toEqual(['old work']);
  });

  it('never lets fresh events push out the preserved events of a failed account', () => {
    const previous = JSON.stringify([{ id: 'w', url: 'u', title: 'old work', start: '2026-10-20', end: null, account: 'work' }]);
    const text = 'https://kanban.example/?board=vs&card=abc12345';
    const fresh = Array.from({ length: 20 }, (_, i) =>
      event(`P${String(i).padStart(2, '0')}`, { start: `2026-11-${String(i + 1).padStart(2, '0')}T08:00:00Z`, end: null, text }));
    const stored = link([card('abc12345', 'vs', { calendar_events: previous })], new Map([['personal', fresh]]), new Set(['work'])).get('abc12345')!;
    expect(stored).toHaveLength(20);
    expect(stored.some((e) => e.title === 'old work')).toBe(true);
  });

  it('orders upcoming before past and caps the list', () => {
    const text = 'https://kanban.example/?board=vs&card=abc12345';
    const many = Array.from({ length: 25 }, (_, i) =>
      event(`E${String(i).padStart(2, '0')}`, { start: `2026-11-${String(i + 1).padStart(2, '0')}T08:00:00Z`, end: null, text }));
    const past = event('PAST', { start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z', text });
    const stored = link([card('abc12345', 'vs')], new Map([['work', [past, ...many]]])).get('abc12345')!;
    expect(stored).toHaveLength(20);
    expect(stored[0].title).toBe('Event E00');
    expect(stored.some((e) => e.title === 'Event PAST')).toBe(false);
  });
});

describe('providers', () => {
  it('reads only requested keys from an env file and reports missing ones', () => {
    const file = path.join(tmpDir, 'x.env');
    writeFileSync(file, '# c\nM365_TENANT_ID="t"\nM365_CLIENT_ID=\'c\'\nOTHER=$(rm -rf /)\n');
    expect(providers.readEnvValues(file, ['M365_TENANT_ID', 'M365_CLIENT_ID'])).toEqual({ M365_TENANT_ID: 't', M365_CLIENT_ID: 'c' });
    expect(() => providers.readEnvValues(file, ['M365_CLIENT_SECRET'])).toThrow(/missing M365_CLIENT_SECRET/);
    writeFileSync(file, 'M365_TENANT_ID=old\nM365_TENANT_ID=\n');
    expect(() => providers.readEnvValues(file, ['M365_TENANT_ID'])).toThrow(/missing M365_TENANT_ID/);
  });

  describe('readGraphCredentials', () => {
    const SECRET_FROM_FILE = 'file-secret-9f3a';
    const SECRET_FROM_ENV = 'env-secret-1b2c';
    let secretsDir: string;
    beforeEach(() => {
      secretsDir = path.join(tmpDir, 'secrets');
      mkdirSync(secretsDir, { mode: 0o700 });
    });
    const writeEnv = (lines: string[]) => {
      const file = path.join(tmpDir, 'm365.env');
      writeFileSync(file, `${lines.join('\n')}\n`);
      return file;
    };
    const writeSecret = (content: string, mode = 0o600) => writeFileSync(path.join(secretsDir, 'M365_CLIENT_SECRET'), content, { mode });

    it('takes the secret from $VSDB_SECRETS_DIR/M365_CLIENT_SECRET, over an env line', () => {
      writeSecret(`${SECRET_FROM_FILE}\n`);
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=${secretsDir}`, `M365_CLIENT_SECRET=${SECRET_FROM_ENV}`]);
      expect(providers.readGraphCredentials(file)).toEqual({ tenantId: 't', clientId: 'c', clientSecret: SECRET_FROM_FILE });
    });

    it('resolves a relative VSDB_SECRETS_DIR against the env file and expands ~', () => {
      writeSecret(SECRET_FROM_FILE);
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', 'VSDB_SECRETS_DIR=secrets']);
      expect(providers.readGraphCredentials(file).clientSecret).toBe(SECRET_FROM_FILE);
      const home = path.relative(os.homedir(), secretsDir);
      if (!home.startsWith('..')) {
        const tilde = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=~/${home}`]);
        expect(providers.readGraphCredentials(tilde).clientSecret).toBe(SECRET_FROM_FILE);
      }
    });

    it('falls back to the env line only when the secret file does not exist', () => {
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=${secretsDir}`, `M365_CLIENT_SECRET="${SECRET_FROM_ENV}"`]);
      expect(providers.readGraphCredentials(file).clientSecret).toBe(SECRET_FROM_ENV);
      const noDir = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `M365_CLIENT_SECRET=${SECRET_FROM_ENV}`]);
      expect(providers.readGraphCredentials(noDir).clientSecret).toBe(SECRET_FROM_ENV);
    });

    it('reports a missing secret by name when neither the file nor the env line exists', () => {
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=${secretsDir}`]);
      expect(() => providers.readGraphCredentials(file)).toThrow(/^credentials file is missing M365_CLIENT_SECRET/);
      const plain = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c']);
      expect(() => providers.readGraphCredentials(plain)).toThrow('credentials file is missing M365_CLIENT_SECRET');
      expect(() => providers.readGraphCredentials(writeEnv(['M365_CLIENT_SECRET=x']))).toThrow('credentials file is missing M365_TENANT_ID, M365_CLIENT_ID');
    });

    it('refuses an unsafe secret file instead of the env line, naming the file and never a value', () => {
      writeSecret(SECRET_FROM_FILE, 0o640);
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=${secretsDir}`, `M365_CLIENT_SECRET=${SECRET_FROM_ENV}`]);
      let message = '';
      try { providers.readGraphCredentials(file); } catch (err) { message = (err as Error).message; }
      expect(message).toContain(path.join(secretsDir, 'M365_CLIENT_SECRET'));
      expect(message).toMatch(/readable by group or others/);
      expect(message).not.toContain(SECRET_FROM_FILE);
      expect(message).not.toContain(SECRET_FROM_ENV);
    });

    it('treats a dangling symlink at the secret path as an error, not as a missing file', () => {
      symlinkSync(path.join(secretsDir, 'gone'), path.join(secretsDir, 'M365_CLIENT_SECRET'));
      const file = writeEnv(['M365_TENANT_ID=t', 'M365_CLIENT_ID=c', `VSDB_SECRETS_DIR=${secretsDir}`, `M365_CLIENT_SECRET=${SECRET_FROM_ENV}`]);
      expect(() => providers.readGraphCredentials(file)).toThrow(/is not a regular file/);
    });
  });

  it('pages through Graph, skips cancelled events and normalizes times', async () => {
    writeFileSync(path.join(tmpDir, 'm365.env'), 'M365_TENANT_ID=t\nM365_CLIENT_ID=c\nM365_CLIENT_SECRET=s\n');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (!url.includes('page2')) {
        return new Response(JSON.stringify({
          value: [
            { id: 'A', subject: 'Timed', isAllDay: false, start: { dateTime: '2026-10-14T08:00:00.0000000' }, end: { dateTime: '2026-10-14T09:00:00.0000000' }, webLink: 'https://outlook.office365.com/owa/?itemid=A%3D&exvsurl=1', body: { content: 'body' } },
            { id: 'B', subject: 'Cancelled', isCancelled: true, start: { dateTime: '2026-10-14T08:00:00.0000000' } },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2',
        }));
      }
      return new Response(JSON.stringify({ value: [
        { id: 'C', subject: 'All day', isAllDay: true, seriesMasterId: 'M', start: { dateTime: '2026-10-15T00:00:00.0000000' }, end: { dateTime: '2026-10-16T00:00:00.0000000' } },
      ] }));
    }));
    const window = { from: new Date(NOW), to: new Date(NOW + 86400000), signal: new AbortController().signal };
    const events = await providers.fetchGraphEvents(testConfig.calendarAccounts![0], window);
    expect(events.map((e) => [e.key, e.seriesKey, e.start, e.end])).toEqual([
      ['A', 'A', '2026-10-14T08:00:00Z', '2026-10-14T09:00:00Z'],
      ['C', 'M', '2026-10-15', '2026-10-16'],
    ]);
    expect(events[0].refs).toEqual(['A', 'A=']);
    expect(calls[1]).toContain('/users/me%40work.example/calendarView');
  });

  it('fails the whole Graph fetch on an HTTP error instead of returning a partial list', async () => {
    writeFileSync(path.join(tmpDir, 'm365.env'), 'M365_TENANT_ID=t\nM365_CLIENT_ID=c\nM365_CLIENT_SECRET=s\n');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/oauth2/')
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }))
      : new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: 403 }))));
    const window = { from: new Date(NOW), to: new Date(NOW + 86400000), signal: new AbortController().signal };
    await expect(providers.fetchGraphEvents(testConfig.calendarAccounts![0], window)).rejects.toThrow('HTTP 403 ErrorAccessDenied');
  });

  it('reports Google as not connected until consent has stored a token', async () => {
    writeFileSync(path.join(tmpDir, 'google.env'), 'GOOGLE_CLIENT_ID=c\nGOOGLE_CLIENT_SECRET=s\n');
    const window = { from: new Date(NOW), to: new Date(NOW + 86400000), signal: new AbortController().signal };
    await expect(providers.fetchGoogleEvents(testConfig.calendarAccounts![1], window)).rejects.toThrow(/not connected/);
  });

  it('pages through Google single events and skips cancelled ones', async () => {
    writeFileSync(path.join(tmpDir, 'google.env'), 'GOOGLE_CLIENT_ID=c\nGOOGLE_CLIENT_SECRET=s\n');
    writeFileSync(path.join(tmpDir, 'token.json'), JSON.stringify({ account: 'me@home.example', refresh_token: 'r' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (!url.includes('pageToken')) {
        return new Response(JSON.stringify({ items: [
          { id: 'g1_20261014', recurringEventId: 'g1', summary: 'Weekly', start: { dateTime: '2026-10-14T10:00:00+02:00' }, end: { dateTime: '2026-10-14T11:00:00+02:00' }, htmlLink: 'https://www.google.com/calendar/event?eid=x', description: 'd' },
          { id: 'gx', status: 'cancelled', start: { date: '2026-10-14' } },
        ], nextPageToken: 'p2' }));
      }
      return new Response(JSON.stringify({ items: [{ id: 'g2', summary: 'All day', start: { date: '2026-10-15' }, end: { date: '2026-10-16' } }] }));
    }));
    const window = { from: new Date(NOW), to: new Date(NOW + 86400000), signal: new AbortController().signal };
    const events = await providers.fetchGoogleEvents(testConfig.calendarAccounts![1], window);
    expect(events.map((e) => [e.key, e.seriesKey, e.start, e.end, e.refs])).toEqual([
      ['g1_20261014', 'g1', '2026-10-14T10:00:00+02:00', '2026-10-14T11:00:00+02:00', ['g1_20261014', 'g1']],
      ['g2', 'g2', '2026-10-15', '2026-10-16', ['g2']],
    ]);
  });
});

describe('sync run', () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, updated_at)
      VALUES ('abc12345', 'vs', 'Backlog', 0, 'Call', '- [ ] Call', 1, '2026-01-01 00:00:00')`).run();
  });

  it('stores linked events without touching updated_at, broadcasts, and reports health', async () => {
    fetchGraphMock.mockResolvedValue([event('E1', { text: 'https://kanban.example/?board=vs&card=abc12345' })]);
    fetchGoogleMock.mockRejectedValue(new Error('not connected: Google consent token file is missing'));
    await sync.runCalendarSync();

    const row = testDb.prepare('SELECT calendar_events, updated_at FROM cards WHERE id = ?').get('abc12345') as { calendar_events: string; updated_at: string };
    expect(JSON.parse(row.calendar_events).map((e: { title: string }) => e.title)).toEqual(['Event E1']);
    expect(row.updated_at).toBe('2026-01-01 00:00:00');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'card-updated', boardId: 'vs' }));

    const health = sync.getCalendarSyncStatus();
    expect(health.work).toMatchObject({ ok: true, events: 1, linked: 1, error: null });
    expect(health.personal).toMatchObject({ ok: false, error: 'not connected: Google consent token file is missing' });
  });

  it('does not rewrite or broadcast when nothing changed', async () => {
    fetchGraphMock.mockResolvedValue([]);
    fetchGoogleMock.mockResolvedValue([]);
    await sync.runCalendarSync();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('API surface', () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number)
      VALUES ('abc12345', 'vs', 'Backlog', 0, 'Call', '- [ ] Call', 1)`).run();
  });

  it('does not let clients write calendar events', async () => {
    const app = new Hono();
    app.route('/api/cards', cardRoutes);
    const res = await app.request('/api/cards/abc12345', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendar_events: [{ id: 'x', url: 'https://evil.example', title: 't', start: null, account: null }] }),
    });
    expect(res.status).toBe(400);
    const row = testDb.prepare('SELECT calendar_events FROM cards WHERE id = ?').get('abc12345') as { calendar_events: string };
    expect(row.calendar_events).toBe('[]');
  });

  it('exposes accounts and the public URL without credentials', async () => {
    const app = new Hono();
    app.route('/api/boards', boardRoutes);
    const body = await (await app.request('/api/boards/vs')).json() as Record<string, unknown>;
    expect(body.calendarAccount).toEqual({ id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example' });
    expect(body.publicUrl).toBe('https://kanban.example');
    expect(JSON.stringify(body)).not.toMatch(/envFile|tokenFile|credentials/);
  });
});

describe('config', () => {
  it('rejects credentials that do not fit the provider', () => {
    const config = makeConfig();
    config.calendarAccounts![0] = { ...config.calendarAccounts![0], credentials: { type: 'google-oauth', clientEnvFile: 'a', tokenFile: 'b' } };
    const result = ConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join('; ')).toMatch(/needs graph-app credentials/);
  });

  it('still fails boot when a board names an unknown account', () => {
    const config = makeConfig();
    config.boards[0] = { ...config.boards[0], calendarAccount: 'missing' };
    expect(ConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('migration', () => {
  it('adds calendar_events to a legacy database and survives repeated startup', async () => {
    const dbPath = path.join(tmpDir, 'legacy.db');
    const legacy = new Database(dbPath);
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
    mkdirSync(tmpDir, { recursive: true });

    const realDb = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
    for (let boot = 0; boot < 2; boot++) {
      const db = realDb.getDb(dbPath);
      const row = db.prepare('SELECT calendar_events FROM cards WHERE id = ?').get('old') as { calendar_events: string };
      expect(row.calendar_events).toBe('[]');
      realDb.closeDb();
    }
  });
});
