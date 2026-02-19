import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;
let vaultRoot: string;

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
    position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
    line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
    labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
    description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_state (
    file_path TEXT PRIMARY KEY, file_hash TEXT NOT NULL,
    last_synced TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cards_board_position ON cards(board_id, position);
  CREATE INDEX IF NOT EXISTS idx_cards_board_column ON cards(board_id, column_name);
`;

function makeBoard(id = 'b1', file = 'Tasks/Board.md', columns = ['Backlog', 'In Progress', 'Done']) {
  return { id, name: 'Test Board', file, columns };
}

function writeMd(relPath: string, content: string) {
  const abs = path.join(vaultRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readMd(relPath: string): string {
  return readFileSync(path.join(vaultRoot, relPath), 'utf-8');
}

function getCards(boardId = 'b1'): Array<Record<string, unknown>> {
  return testDb.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY position').all(boardId) as Array<Record<string, unknown>>;
}

describe('reconciler', () => {
  beforeEach(() => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(SCHEMA);
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('inserts new tasks from .md into DB', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Buy milk\n- [ ] Walk dog\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    const result = reconcileBoard(board, vaultRoot);

    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.updated).toBe(0);

    const cards = getCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].title).toBe('Buy milk');
    expect(cards[1].title).toBe('Walk dog');
    expect(cards[0].column_name).toBe('Backlog');
    expect(cards[0].is_done).toBe(0);
  });

  it('marks done tasks as is_done=1 with column=Done', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Open task\n- [x] Completed task\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    const open = cards.find((c) => c.title === 'Open task');
    const done = cards.find((c) => c.title === 'Completed task');

    expect(open!.is_done).toBe(0);
    expect(open!.column_name).toBe('Backlog');
    expect(done!.is_done).toBe(1);
    expect(done!.column_name).toBe('Done');
  });

  it('stamps kb:id markers into .md file', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] New task\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const content = readMd('Tasks/Board.md');
    expect(content).toMatch(/<!-- kb:id=[a-f0-9]{8} -->/);
  });

  it('preserves existing kb:id markers', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Existing task <!-- kb:id=abcd1234 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('abcd1234');

    // Marker should be preserved
    const content = readMd('Tasks/Board.md');
    expect(content).toContain('kb:id=abcd1234');
  });

  it('updates existing cards when title changes in .md', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Original title <!-- kb:id=abc12345 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    expect(getCards()[0].title).toBe('Original title');

    // Change title in .md
    writeMd('Tasks/Board.md', '- [ ] Updated title <!-- kb:id=abc12345 -->\n');
    const result = reconcileBoard(board, vaultRoot);

    expect(result.updated).toBe(1);
    expect(getCards()[0].title).toBe('Updated title');
  });

  it('removes cards that are no longer in .md', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task A <!-- kb:id=aaaa1111 -->\n- [ ] Task B <!-- kb:id=bbbb2222 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);
    expect(getCards()).toHaveLength(2);

    // Remove Task A
    writeMd('Tasks/Board.md', '- [ ] Task B <!-- kb:id=bbbb2222 -->\n');
    const result = reconcileBoard(board, vaultRoot);

    expect(result.removed).toBe(1);
    const remaining = getCards();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('bbbb2222');
  });

  it('detects done→undone transition (un-checking a task)', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [x] Was done <!-- kb:id=done1234 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    let cards = getCards();
    expect(cards[0].is_done).toBe(1);
    expect(cards[0].column_name).toBe('Done');

    // Uncheck the task
    writeMd('Tasks/Board.md', '- [ ] Was done <!-- kb:id=done1234 -->\n');
    reconcileBoard(board, vaultRoot);

    cards = getCards();
    expect(cards[0].is_done).toBe(0);
    expect(cards[0].column_name).toBe('Backlog');
  });

  it('preserves column assignment for existing cards (not in Done)', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task <!-- kb:id=col12345 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    // Manually move card to "In Progress"
    testDb.prepare('UPDATE cards SET column_name = ? WHERE id = ?').run('In Progress', 'col12345');

    // Re-reconcile (task unchanged, still open)
    writeMd('Tasks/Board.md', '- [ ] Task <!-- kb:id=col12345 -->\n');
    // Clear sync state to force re-reconcile
    testDb.prepare('DELETE FROM sync_state').run();
    reconcileBoard(board, vaultRoot);

    // Column should be preserved
    const card = getCards()[0];
    expect(card.column_name).toBe('In Progress');
  });

  it('respects kb:col marker for new cards', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task with col <!-- kb:id=kbcol123 kb:col=In+Progress -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const card = getCards()[0];
    expect(card.column_name).toBe('In Progress');
  });

  it('ignores invalid kb:col (column not in board)', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task <!-- kb:id=bad_col1 kb:col=Fantasy -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const card = getCards()[0];
    // Should fall back to Backlog since Fantasy is not in board.columns
    expect(card.column_name).toBe('Backlog');
  });

  it('regenerates duplicate kb:id in same file (copy/paste)', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task A <!-- kb:id=dupe1234 -->\n- [ ] Task B <!-- kb:id=dupe1234 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    expect(cards).toHaveLength(2);
    // IDs should be different
    expect(cards[0].id).not.toBe(cards[1].id);
  });

  it('regenerates kb:id that collides with another board', async () => {
    // Seed a card in a different board
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('cross123', 'other-board', 'Backlog', 0, 'Other task', '- [ ] Other task', 1, 0);

    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] New task <!-- kb:id=cross123 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    expect(cards).toHaveLength(1);
    // ID should be regenerated to avoid collision
    expect(cards[0].id).not.toBe('cross123');
  });

  it('skips reconcile when file hash unchanged', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Static task <!-- kb:id=stat1234 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    const first = reconcileBoard(board, vaultRoot);
    expect(first.added).toBe(1);

    // Second reconcile should skip (hash unchanged)
    const second = reconcileBoard(board, vaultRoot);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.removed).toBe(0);
  });

  it('safety guard: refuses to delete all cards when file is empty', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] Task A <!-- kb:id=safe1111 -->\n- [ ] Task B <!-- kb:id=safe2222 -->\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);
    expect(getCards()).toHaveLength(2);

    // Write empty file
    writeMd('Tasks/Board.md', '');
    reconcileBoard(board, vaultRoot);

    // Cards should NOT be deleted (safety guard)
    expect(getCards()).toHaveLength(2);
  });

  it('safety guard: refuses to delete >80% of cards at once', async () => {
    const board = makeBoard();
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`- [ ] Task ${i} <!-- kb:id=bulk${String(i).padStart(4, '0')} -->`);
    }
    writeMd('Tasks/Board.md', lines.join('\n') + '\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);
    expect(getCards()).toHaveLength(10);

    // Keep only 1 task (would delete 9/10 = 90% > 80%)
    writeMd('Tasks/Board.md', '- [ ] Task 0 <!-- kb:id=bulk0000 -->\n');
    reconcileBoard(board, vaultRoot);

    // Should NOT delete 9 cards (safety guard)
    expect(getCards()).toHaveLength(10);
  });

  it('parses priority from emoji markers', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] 🔺 Urgent task\n- [ ] ⏫ High task\n- [ ] Normal task\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    const urgent = cards.find((c) => (c.title as string).includes('Urgent'));
    const high = cards.find((c) => (c.title as string).includes('High'));
    const normal = cards.find((c) => (c.title as string).includes('Normal'));

    expect(urgent!.priority).toBe('urgent');
    expect(high!.priority).toBe('high');
    expect(normal!.priority).toBeNull();
  });

  it('handles frontmatter correctly', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '---\ntags:\n  - kanban\n---\n- [ ] After frontmatter\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('After frontmatter');
  });

  it('assigns sequential seq_id to new cards', async () => {
    const board = makeBoard();
    writeMd('Tasks/Board.md', '- [ ] First\n- [ ] Second\n- [ ] Third\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    reconcileBoard(board, vaultRoot);

    const cards = getCards();
    const seqIds = cards.map((c) => c.seq_id as number);
    expect(seqIds[0]).toBe(1);
    expect(seqIds[1]).toBe(2);
    expect(seqIds[2]).toBe(3);
  });

  it('reconcileAll processes multiple boards', async () => {
    const boards = [
      makeBoard('b1', 'Tasks/B1.md'),
      makeBoard('b2', 'Tasks/B2.md'),
    ];
    writeMd('Tasks/B1.md', '- [ ] Board 1 task\n');
    writeMd('Tasks/B2.md', '- [ ] Board 2 task\n');

    const { reconcileAll } = await import('../src/reconciler.js');
    const results = reconcileAll(vaultRoot, boards);

    expect(results).toHaveLength(2);
    expect(results[0].added).toBe(1);
    expect(results[1].added).toBe(1);

    expect(testDb.prepare('SELECT COUNT(*) as c FROM cards').get()).toEqual({ c: 2 });
  });

  it('returns zero counts when file cannot be read', async () => {
    const board = makeBoard('missing', 'Tasks/Missing.md');

    const { reconcileBoard } = await import('../src/reconciler.js');
    const result = reconcileBoard(board, vaultRoot);

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.migrated).toBe(0);
  });

  it('legacy fingerprint migration: adopts existing card ID and stamps kb:id', async () => {
    const board = makeBoard();
    const { computeFingerprint } = await import('../src/parser.js');

    // Pre-seed a card with legacy fingerprint ID (no kb:id in file)
    const legacyId = computeFingerprint('Legacy task', board.id, 0);
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(legacyId, board.id, 'In Progress', 0, 'Legacy task', '- [ ] Legacy task', 1, 0);

    // Write .md file WITHOUT kb:id marker
    writeMd('Tasks/Board.md', '- [ ] Legacy task\n');

    const { reconcileBoard } = await import('../src/reconciler.js');
    const result = reconcileBoard(board, vaultRoot);

    expect(result.migrated).toBe(1);

    // Card should retain its original ID
    const cards = getCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe(legacyId);

    // Column should be preserved from before
    expect(cards[0].column_name).toBe('In Progress');

    // File should now have kb:id marker
    const content = readMd('Tasks/Board.md');
    expect(content).toContain(`kb:id=${legacyId}`);
  });
});
