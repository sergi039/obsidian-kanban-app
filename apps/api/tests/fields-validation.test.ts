import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { vi } from 'vitest';

// Isolated mock — only affects this file
let testDb: InstanceType<typeof Database>;

vi.hoisted(() => {
  // Ensure fresh mock scope per file
});

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
  initDb: () => {},
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    PriorityDefSchema: actual.PriorityDefSchema,
    CategoryDefSchema: actual.CategoryDefSchema,
    loadConfig: () => ({
      boards: [{ id: 'b1', name: 'Test', file: 'test.md', columns: ['Todo', 'Done'] }],
    }),
  };
});

// Dynamic import AFTER mocks registered
const { default: fields } = await import('../src/routes/fields.js');

const app = new Hono();
app.route('/api/fields', fields);

function request(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe('fields validation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');

    testDb.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        column_name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        raw_line TEXT NOT NULL DEFAULT '',
        line_number INTEGER NOT NULL DEFAULT 0,
        is_done INTEGER NOT NULL DEFAULT 0,
        priority TEXT DEFAULT NULL,
        labels TEXT DEFAULT '[]',
        due_date TEXT DEFAULT NULL,
        sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT NULL,
        source_fingerprint TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE fields (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'TEXT',
        options TEXT DEFAULT '[]',
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE field_values (
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
        value TEXT,
        PRIMARY KEY (card_id, field_id)
      );
    `);

    // Seed test data
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, title) VALUES (?, ?, ?, ?)`).run('c1', 'b1', 'Todo', 'Test card');
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, title) VALUES (?, ?, ?, ?)`).run('c2', 'b2', 'Todo', 'Other board card');

    testDb.prepare(`INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'f-num', 'b1', 'Story Points', 'NUMBER', '[]', 0
    );
    testDb.prepare(`INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'f-date', 'b1', 'Start Date', 'DATE', '[]', 1
    );
    testDb.prepare(`INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'f-sel', 'b1', 'Sprint', 'SINGLE_SELECT', JSON.stringify([
        { id: 's1', name: 'Sprint 1', color: 'blue' },
        { id: 's2', name: 'Sprint 2', color: 'green' },
      ]), 2
    );
    testDb.prepare(`INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'f-iter', 'b1', 'Iteration', 'ITERATION', '[]', 3
    );
  });

  afterEach(() => {
    testDb.close();
  });

  // --- Board integrity ---
  it('rejects cross-board field assignment', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c2', { value: '5' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/different boards/i);
  });

  it('allows same-board field assignment', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: '5' });
    expect(res.status).toBe(200);
  });

  // --- NUMBER validation ---
  it('rejects Infinity for NUMBER', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: 'Infinity' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/finite/i);
  });

  it('rejects NaN for NUMBER', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('rejects empty string for NUMBER', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: '   ' });
    expect(res.status).toBe(400);
  });

  it('accepts valid NUMBER', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: '42.5' });
    expect(res.status).toBe(200);
  });

  it('accepts negative NUMBER', async () => {
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: '-3' });
    expect(res.status).toBe(200);
  });

  // --- DATE validation ---
  it('rejects invalid calendar date 2026-99-99', async () => {
    const res = await request('PUT', '/api/fields/f-date/values/c1', { value: '2026-99-99' });
    expect(res.status).toBe(400);
  });

  it('rejects Feb 30', async () => {
    const res = await request('PUT', '/api/fields/f-date/values/c1', { value: '2026-02-30' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid calendar/i);
  });

  it('rejects wrong format', async () => {
    const res = await request('PUT', '/api/fields/f-date/values/c1', { value: '02-18-2026' });
    expect(res.status).toBe(400);
  });

  it('accepts valid date', async () => {
    const res = await request('PUT', '/api/fields/f-date/values/c1', { value: '2026-02-18' });
    expect(res.status).toBe(200);
  });

  // --- SINGLE_SELECT canonical storage ---
  it('normalizes name to id for SINGLE_SELECT', async () => {
    const res = await request('PUT', '/api/fields/f-sel/values/c1', { value: 'Sprint 1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe('s1'); // stored as id, not name

    const row = testDb.prepare('SELECT value FROM field_values WHERE card_id = ? AND field_id = ?').get('c1', 'f-sel') as { value: string };
    expect(row.value).toBe('s1');
  });

  it('accepts option id directly for SINGLE_SELECT', async () => {
    const res = await request('PUT', '/api/fields/f-sel/values/c1', { value: 's2' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value).toBe('s2');
  });

  it('rejects unknown option for SINGLE_SELECT', async () => {
    const res = await request('PUT', '/api/fields/f-sel/values/c1', { value: 'Sprint 99' });
    expect(res.status).toBe(400);
  });

  // --- ITERATION validation ---
  it('rejects empty/whitespace for ITERATION', async () => {
    const res = await request('PUT', '/api/fields/f-iter/values/c1', { value: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/non-empty/i);
  });

  it('accepts valid ITERATION string', async () => {
    const res = await request('PUT', '/api/fields/f-iter/values/c1', { value: 'Q1 2026' });
    expect(res.status).toBe(200);
  });

  // --- null clears value ---
  it('null value deletes field_value row', async () => {
    // Set first
    await request('PUT', '/api/fields/f-num/values/c1', { value: '10' });
    const before = testDb.prepare('SELECT value FROM field_values WHERE card_id = ? AND field_id = ?').get('c1', 'f-num');
    expect(before).toBeTruthy();

    // Clear
    const res = await request('PUT', '/api/fields/f-num/values/c1', { value: null });
    expect(res.status).toBe(200);
    const after = testDb.prepare('SELECT value FROM field_values WHERE card_id = ? AND field_id = ?').get('c1', 'f-num');
    expect(after).toBeUndefined();
  });
});
