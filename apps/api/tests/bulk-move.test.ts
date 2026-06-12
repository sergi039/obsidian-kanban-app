import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    PriorityDefSchema: actual.PriorityDefSchema,
    CategoryDefSchema: actual.CategoryDefSchema,
    loadConfig: () => ({
      vaultRoot: '/tmp/test-vault',
      boards: [{
        id: 'b1',
        name: 'Test',
        file: 'Tasks/Test.md',
        columns: ['Backlog', 'In Progress', 'Done'],
      }],
      defaultColumns: ['Backlog', 'In Progress', 'Done'],
    }),
    DEFAULT_PRIORITIES: [
      { id: 'urgent', emoji: '🔺', label: 'Urgent', color: '#ef4444' },
      { id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b' },
    ],
    PROJECT_ROOT: '/tmp/test',
    resetConfigCache: vi.fn(),
    updateBoardColumns: vi.fn(() => true),
    addBoardToConfig: vi.fn(() => true),
    updateBoardInConfig: vi.fn(() => true),
    deleteBoardFromConfig: vi.fn(() => true),
  };
});

vi.mock('../src/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

vi.mock('../src/writeback.js', () => ({
  writeBackDoneState: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackPriority: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackColumn: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackTitle: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
}));

vi.mock('../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
    position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
    line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
    labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
    description TEXT DEFAULT '', source_fingerprint TEXT, links TEXT DEFAULT '[]', source TEXT, source_uid TEXT, source_url TEXT, source_meta TEXT DEFAULT '{}', seq_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
`;

function seedCard(id: string, boardId: string, column: string, position: number, isDone = 0) {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, boardId, column, position, `Task ${id}`, `- [ ] Task ${id}`, isDone);
}

function getPositions(boardId: string, column: string): Array<{ id: string; position: number }> {
  return testDb
    .prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position')
    .all(boardId, column) as Array<{ id: string; position: number }>;
}

async function makeApp() {
  const { default: cardRoutes } = await import('../src/routes/cards.js');
  const app = new Hono();
  app.route('/api/cards', cardRoutes);
  return app;
}

function bulkMove(app: Hono, cardIds: string[], column: string) {
  return app.request('/api/cards/bulk-move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card_ids: cardIds, column }),
  });
}

describe('POST /api/cards/bulk-move', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(SCHEMA);
    vi.clearAllMocks();
  });

  afterEach(() => testDb.close());

  it('moves multiple cards to the target column appended at the end', async () => {
    seedCard('a', 'b1', 'Backlog', 0);
    seedCard('b', 'b1', 'Backlog', 1);
    seedCard('c', 'b1', 'Backlog', 2);
    seedCard('d', 'b1', 'In Progress', 0);
    seedCard('e', 'b1', 'Done', 0, 1);

    const app = await makeApp();
    const res = await bulkMove(app, ['a', 'c'], 'In Progress');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.moved).toBe(2);
    expect(body.cards).toHaveLength(2);

    // Source column closed gaps: b(0)
    expect(getPositions('b1', 'Backlog')).toEqual([{ id: 'b', position: 0 }]);
    // Target column: d(0) keeps place, a/c appended in original order
    expect(getPositions('b1', 'In Progress')).toEqual([
      { id: 'd', position: 0 },
      { id: 'a', position: 1 },
      { id: 'c', position: 2 },
    ]);
  });

  it('sets is_done when moving to Done and clears it when moving out', async () => {
    seedCard('a', 'b1', 'Backlog', 0);
    seedCard('b', 'b1', 'Done', 0, 1);

    const app = await makeApp();

    const res = await bulkMove(app, ['a'], 'Done');
    expect(res.status).toBe(200);
    expect((testDb.prepare('SELECT is_done FROM cards WHERE id = ?').get('a') as { is_done: number }).is_done).toBe(1);

    const res2 = await bulkMove(app, ['b'], 'Backlog');
    expect(res2.status).toBe(200);
    expect((testDb.prepare('SELECT is_done FROM cards WHERE id = ?').get('b') as { is_done: number }).is_done).toBe(0);
  });

  it('writes back done state and column for each moved card', async () => {
    seedCard('a', 'b1', 'Backlog', 0);
    seedCard('b', 'b1', 'In Progress', 0);

    const writeback = await import('../src/writeback.js');
    const app = await makeApp();

    const res = await bulkMove(app, ['a', 'b'], 'Done');
    expect(res.status).toBe(200);

    expect(writeback.writeBackDoneState).toHaveBeenCalledWith('a', true);
    expect(writeback.writeBackDoneState).toHaveBeenCalledWith('b', true);
    expect(writeback.writeBackColumn).toHaveBeenCalledWith('a', 'Done');
    expect(writeback.writeBackColumn).toHaveBeenCalledWith('b', 'Done');
  });

  it('fires card.moved automation per moved card and broadcasts once', async () => {
    seedCard('a', 'b1', 'Backlog', 0);
    seedCard('b', 'b1', 'Backlog', 1);

    const { fireEvent } = await import('../src/automations.js');
    const { broadcast } = await import('../src/ws.js');
    const app = await makeApp();

    const res = await bulkMove(app, ['a', 'b'], 'Done');
    expect(res.status).toBe(200);

    expect(fireEvent).toHaveBeenCalledTimes(2);
    expect(fireEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'card.moved', cardId: 'a', fromColumn: 'Backlog', toColumn: 'Done' }),
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'card-moved', boardId: 'b1' }));
  });

  it('skips cards already in the target column (no-op move)', async () => {
    seedCard('a', 'b1', 'Done', 0, 1);
    seedCard('b', 'b1', 'Backlog', 0);

    const { fireEvent } = await import('../src/automations.js');
    const app = await makeApp();

    const res = await bulkMove(app, ['a', 'b'], 'Done');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.moved).toBe(1);
    // 'a' stays at its position, 'b' appended after it
    expect(getPositions('b1', 'Done')).toEqual([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ]);
    expect(fireEvent).toHaveBeenCalledTimes(1);
  });

  it('returns 404 with missing ids listed when some cards do not exist', async () => {
    seedCard('a', 'b1', 'Backlog', 0);

    const app = await makeApp();
    const res = await bulkMove(app, ['a', 'ghost'], 'Done');
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain('ghost');
    // Nothing moved
    expect(getPositions('b1', 'Backlog')).toEqual([{ id: 'a', position: 0 }]);
  });

  it('rejects cards from different boards', async () => {
    seedCard('a', 'b1', 'Backlog', 0);
    seedCard('x', 'b2', 'Backlog', 0);

    const app = await makeApp();
    const res = await bulkMove(app, ['a', 'x'], 'Done');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toMatch(/same board/i);
  });

  it('rejects an invalid target column', async () => {
    seedCard('a', 'b1', 'Backlog', 0);

    const app = await makeApp();
    const res = await bulkMove(app, ['a'], 'Fantasy');
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toMatch(/not in board/i);
  });

  it('rejects an empty card_ids list', async () => {
    const app = await makeApp();
    const res = await bulkMove(app, [], 'Done');
    expect(res.status).toBe(400);
  });

  it('deduplicates repeated card ids', async () => {
    seedCard('a', 'b1', 'Backlog', 0);

    const app = await makeApp();
    const res = await bulkMove(app, ['a', 'a', 'a'], 'Done');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.moved).toBe(1);
    expect(getPositions('b1', 'Done')).toEqual([{ id: 'a', position: 0 }]);
  });
});
