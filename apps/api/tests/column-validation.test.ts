import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
  createTestDb: () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user', text TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    return db;
  },
}));

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({
    vaultRoot: '/tmp/test-vault',
    boards: [{ id: 'b1', name: 'Test', file: 'Tasks/Test.md', columns: ['Backlog', 'In Progress', 'Done'] }],
    defaultColumns: ['Backlog', 'In Progress', 'Done'],
  }),
  PROJECT_ROOT: '/tmp/test',
  resetConfigCache: vi.fn(),
  updateBoardColumns: vi.fn(() => true),
  addBoardToConfig: vi.fn(() => true),
  updateBoardInConfig: vi.fn(() => true),
  deleteBoardFromConfig: vi.fn(() => true),
}));

vi.mock('../src/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../src/reconciler.js', () => ({
  reconcileBoard: vi.fn(() => ({ boardId: 'b1', added: 0, removed: 0, updated: 0, migrated: 0 })),
  reconcileAll: vi.fn(() => []),
}));

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

vi.mock('../src/writeback.js', () => ({
  writeBackDoneState: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackPriority: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackColumn: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
}));

vi.mock('../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

function seedCard(id: string, boardId: string, column: string, position: number) {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  `).run(id, boardId, column, position, `Task ${id}`, `- [ ] Task ${id}`);
}

describe('column validation on card create', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => testDb.close());

  it('rejects card creation with invalid column', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_id: 'b1', title: 'Test', column: 'NonExistent' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not in board/i);
  });

  it('accepts card creation with valid column', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    // This will fail at file read since /tmp/test-vault doesn't exist,
    // but the column validation should pass (500, not 400)
    const res = await app.request('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_id: 'b1', title: 'Test', column: 'In Progress' }),
    });
    // Should NOT be 400 (column validation). May be 500 due to missing file.
    expect(res.status).not.toBe(400);
  });
});

describe('column validation on card move', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    seedCard('c1', 'b1', 'Backlog', 0);
  });

  afterEach(() => testDb.close());

  it('rejects move to invalid column', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c1/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'NonExistent', position: 0 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not in board/i);
  });

  it('accepts move to valid column', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c1/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'In Progress', position: 0 }),
    });
    expect(res.status).toBe(200);
  });
});

describe('column validation on card PATCH', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    seedCard('c1', 'b1', 'Backlog', 0);
  });

  afterEach(() => testDb.close());

  it('rejects PATCH with invalid column_name', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_name: 'Fantasy' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not in board/i);
  });

  it('accepts PATCH with valid column_name', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_name: 'Done' }),
    });
    expect(res.status).toBe(200);
  });
});

describe('unified move path (PATCH column_name uses move transaction)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    seedCard('c1', 'b1', 'Backlog', 0);
    seedCard('c2', 'b1', 'Backlog', 1);
    seedCard('c3', 'b1', 'Backlog', 2);
    seedCard('c4', 'b1', 'Done', 0);
  });

  afterEach(() => testDb.close());

  it('PATCH column_name closes gap in source column', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    // Move c2 from Backlog to Done via PATCH
    const res = await app.request('/api/cards/c2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_name: 'Done' }),
    });
    expect(res.status).toBe(200);

    // Backlog should have contiguous positions: c1(0), c3(1)
    const backlog = testDb.prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all('b1', 'Backlog') as Array<{ id: string; position: number }>;
    expect(backlog).toEqual([
      { id: 'c1', position: 0 },
      { id: 'c3', position: 1 },
    ]);
  });

  it('PATCH column_name to Done sets is_done = 1', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_name: 'Done' }),
    });
    expect(res.status).toBe(200);

    const card = testDb.prepare('SELECT is_done FROM cards WHERE id = ?').get('c1') as { is_done: number };
    expect(card.is_done).toBe(1);
  });

  it('PATCH column_name from Done clears is_done', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    const res = await app.request('/api/cards/c4', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column_name: 'Backlog' }),
    });
    expect(res.status).toBe(200);

    const card = testDb.prepare('SELECT is_done FROM cards WHERE id = ?').get('c4') as { is_done: number };
    expect(card.is_done).toBe(0);
  });
});

describe('position normalization', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    seedCard('c1', 'b1', 'Backlog', 0);
    seedCard('c2', 'b1', 'Backlog', 1);
    seedCard('c3', 'b1', 'Backlog', 2);
  });

  afterEach(() => testDb.close());

  it('positions are contiguous after cross-column move', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    // Move c1 from Backlog to Done
    await app.request('/api/cards/c1/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'Done', position: 0 }),
    });

    // Backlog should be 0,1 (not 1,2)
    const backlog = testDb.prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all('b1', 'Backlog') as Array<{ id: string; position: number }>;
    expect(backlog).toEqual([
      { id: 'c2', position: 0 },
      { id: 'c3', position: 1 },
    ]);

    // Done should be 0
    const done = testDb.prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all('b1', 'Done') as Array<{ id: string; position: number }>;
    expect(done).toEqual([
      { id: 'c1', position: 0 },
    ]);
  });

  it('positions are contiguous after same-column reorder', async () => {
    const { default: cardRoutes } = await import('../src/routes/cards.js');
    const app = new Hono();
    app.route('/api/cards', cardRoutes);

    // Move c3 to position 0
    await app.request('/api/cards/c3/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ column: 'Backlog', position: 0 }),
    });

    const positions = testDb.prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all('b1', 'Backlog') as Array<{ id: string; position: number }>;
    expect(positions).toEqual([
      { id: 'c3', position: 0 },
      { id: 'c1', position: 1 },
      { id: 'c2', position: 2 },
    ]);
  });
});
