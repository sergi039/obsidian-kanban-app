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
  return {
    ...actual,
    loadConfig: () => ({
      vaultRoot: '/tmp/test-vault',
      boards: [{ id: 'b1', name: 'Test', file: 'Tasks/Test.md', columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
    }),
  };
});

vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../src/watcher.js', () => ({ suppressWatcher: vi.fn(), unsuppressWatcher: vi.fn() }));
vi.mock('../src/automations.js', () => ({ fireEvent: vi.fn() }));
vi.mock('../src/obsidian-context.js', () => ({ notifyCardsClosed: vi.fn() }));

const ok = { success: true, changed: true, lineNumber: 1 };
vi.mock('../src/writeback.js', () => ({
  writeBackDoneState: vi.fn(() => ok),
  writeBackPriority: vi.fn(() => ok),
  writeBackColumn: vi.fn(() => ok),
  writeBackTitle: vi.fn(() => ok),
}));

vi.mock('../src/ingest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ingest.js')>();
  return { ...actual, ingestCard: vi.fn() };
});

const failed = (error: string) => ({ success: false, changed: false, lineNumber: 1, error });

async function app() {
  const { default: cardRoutes } = await import('../src/routes/cards.js');
  const a = new Hono();
  a.route('/api/cards', cardRoutes);
  return a;
}

function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('card routes report .md write-back failures', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testDb.prepare(
      `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done)
       VALUES ('c1', 'b1', 'Backlog', 0, 'Task 1', '- [ ] Task 1 <!-- kb:id=c1 -->', 1, 0)`,
    ).run();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    testDb.close();
    vi.restoreAllMocks();
  });

  it('PATCH returns a priority write-back failure instead of a silent 200', async () => {
    const writeback = await import('../src/writeback.js');
    vi.mocked(writeback.writeBackPriority).mockReturnValueOnce(failed('Line not found by kb:id'));
    const res = await (await app()).request('/api/cards/c1', json('PATCH', { priority: 'high' }));

    expect(res.status).toBe(200);
    expect((await res.json())._writeBackWarning).toBe('priority: Line not found by kb:id');
  });

  it('PATCH returns done-state and column failures of a column change', async () => {
    const writeback = await import('../src/writeback.js');
    vi.mocked(writeback.writeBackDoneState).mockReturnValueOnce(failed('Line is not a checkbox'));
    vi.mocked(writeback.writeBackColumn).mockReturnValueOnce(failed('Card has no kb:id marker'));
    const res = await (await app()).request('/api/cards/c1', json('PATCH', { column_name: 'Done' }));

    const body = await res.json();
    expect(body.column_name).toBe('Done');
    expect(body._writeBackWarning).toBe('done state: Line is not a checkbox; column: Card has no kb:id marker');
  });

  it('PATCH without failures carries no warning', async () => {
    const res = await (await app()).request('/api/cards/c1', json('PATCH', { priority: 'high' }));
    expect((await res.json())._writeBackWarning).toBeUndefined();
  });

  it('move returns a column write-back failure', async () => {
    const writeback = await import('../src/writeback.js');
    vi.mocked(writeback.writeBackColumn).mockReturnValueOnce(failed('Line not found by kb:id'));
    const res = await (await app()).request('/api/cards/c1/move', json('POST', { column: 'Done', position: 0 }));

    expect((await res.json())._writeBackWarning).toBe('column: Line not found by kb:id');
  });

  it('a write-back that throws becomes a warning, not a 500 after the DB already changed', async () => {
    const writeback = await import('../src/writeback.js');
    vi.mocked(writeback.writeBackDoneState).mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied, open '/Users/someone/vault/Tasks/Test.md'");
    });
    const res = await (await app()).request('/api/cards/c1/move', json('POST', { column: 'Done', position: 0 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body._writeBackWarning).toBe('done state: unexpected error');
    expect(JSON.stringify(body)).not.toContain('/Users/');
  });
});

describe('card routes keep internals out of 500 responses', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
    vi.restoreAllMocks();
  });

  it('POST /api/cards answers an unexpected failure without the error text', async () => {
    const ingest = await import('../src/ingest.js');
    vi.mocked(ingest.ingestCard).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory, open '/Users/someone/vault/Tasks/Test.md'");
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await (await app()).request('/api/cards', json('POST', { board_id: 'b1', title: 'New task' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to create card' });
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('comment delete', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testDb.prepare(
      `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done)
       VALUES ('c1', 'b1', 'Backlog', 0, 'Task 1', '- [ ] Task 1', 1, 0)`,
    ).run();
    testDb.prepare(`INSERT INTO comments (id, card_id, author, text) VALUES ('cm1', 'c1', 'user', 'Note')`).run();
  });

  afterEach(() => testDb.close());

  it('broadcasts card-updated so other tabs refresh the comment count', async () => {
    const { broadcast } = await import('../src/ws.js');
    vi.mocked(broadcast).mockClear();
    const res = await (await app()).request('/api/cards/c1/comments/cm1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'card-updated', cardId: 'c1', boardId: 'b1' }));
  });
});
