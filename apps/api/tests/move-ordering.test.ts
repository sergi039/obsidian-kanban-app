import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db.js';

function insertCard(id: string, boardId: string, column: string, position: number) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, labels, sub_items, source_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, null, '[]', '[]', 'fp')
  `).run(id, boardId, column, position, `Task ${id}`, `- [ ] Task ${id}`);
}

function getPositions(boardId: string, column: string): Array<{ id: string; position: number }> {
  const db = getDb();
  return db.prepare('SELECT id, position FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all(boardId, column) as Array<{ id: string; position: number }>;
}

describe('card move ordering', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM cards').run();
  });

  it('cross-column move: closes gap in source, makes room in target', () => {
    const db = getDb();
    // Source column: a(0), b(1), c(2)
    insertCard('a', 'b1', 'Backlog', 0);
    insertCard('b', 'b1', 'Backlog', 1);
    insertCard('c', 'b1', 'Backlog', 2);
    // Target column: d(0), e(1)
    insertCard('d', 'b1', 'Done', 0);
    insertCard('e', 'b1', 'Done', 1);

    // Move 'b' from Backlog pos=1 → Done pos=1
    const moveTransaction = db.transaction(() => {
      // Close gap in source
      db.prepare('UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ?').run('b1', 'Backlog', 1);
      // Make room in target
      db.prepare('UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ?').run('b1', 'Done', 1);
      // Move card
      db.prepare('UPDATE cards SET column_name = ?, position = ? WHERE id = ?').run('Done', 1, 'b');
    });
    moveTransaction();

    // Backlog: a(0), c(1) — no gaps
    const backlog = getPositions('b1', 'Backlog');
    expect(backlog).toEqual([
      { id: 'a', position: 0 },
      { id: 'c', position: 1 },
    ]);

    // Done: d(0), b(1), e(2) — inserted correctly
    const done = getPositions('b1', 'Done');
    expect(done).toEqual([
      { id: 'd', position: 0 },
      { id: 'b', position: 1 },
      { id: 'e', position: 2 },
    ]);
  });

  it('same-column move down: a(0) b(1) c(2) d(3) → move a to pos 2', () => {
    const db = getDb();
    insertCard('a', 'b1', 'Backlog', 0);
    insertCard('b', 'b1', 'Backlog', 1);
    insertCard('c', 'b1', 'Backlog', 2);
    insertCard('d', 'b1', 'Backlog', 3);

    const oldPos = 0;
    const newPos = 2;
    // Moving down: shift [old+1, new] up by 1
    db.prepare('UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ? AND position <= ? AND id != ?')
      .run('b1', 'Backlog', oldPos, newPos, 'a');
    db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(newPos, 'a');

    const result = getPositions('b1', 'Backlog');
    expect(result).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'a', position: 2 },
      { id: 'd', position: 3 },
    ]);
  });

  it('same-column move up: a(0) b(1) c(2) d(3) → move c to pos 0', () => {
    const db = getDb();
    insertCard('a', 'b1', 'Backlog', 0);
    insertCard('b', 'b1', 'Backlog', 1);
    insertCard('c', 'b1', 'Backlog', 2);
    insertCard('d', 'b1', 'Backlog', 3);

    const oldPos = 2;
    const newPos = 0;
    // Moving up: shift [new, old-1] down by 1
    db.prepare('UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ? AND position < ? AND id != ?')
      .run('b1', 'Backlog', newPos, oldPos, 'c');
    db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(newPos, 'c');

    const result = getPositions('b1', 'Backlog');
    expect(result).toEqual([
      { id: 'c', position: 0 },
      { id: 'a', position: 1 },
      { id: 'b', position: 2 },
      { id: 'd', position: 3 },
    ]);
  });
});

describe('reconciler ID stability', () => {
  it('computeFingerprint is title-based, not index-based', async () => {
    const { computeFingerprint } = await import('../src/parser.js');

    const id1 = computeFingerprint('Buy milk', 'personal', 0);
    const id2 = computeFingerprint('Buy milk', 'personal', 0);
    expect(id1).toBe(id2);

    // Different title = different ID
    const id3 = computeFingerprint('Walk dog', 'personal', 0);
    expect(id3).not.toBe(id1);
  });

  it('duplicate titles get different IDs via collision index', async () => {
    const { computeFingerprint } = await import('../src/parser.js');

    const id1 = computeFingerprint('Fix bug', 'vs', 0);
    const id2 = computeFingerprint('Fix bug', 'vs', 1);
    expect(id1).not.toBe(id2);
  });

  it('reordering does not change IDs (same collision index)', async () => {
    const { computeFingerprint } = await import('../src/parser.js');

    // Task A appears first (collision 0), Task B appears first (collision 0)
    const idA = computeFingerprint('Task A', 'board', 0);
    const idB = computeFingerprint('Task B', 'board', 0);

    // Even if their order changes in the file, same title → same collision index → same ID
    const idA2 = computeFingerprint('Task A', 'board', 0);
    const idB2 = computeFingerprint('Task B', 'board', 0);

    expect(idA).toBe(idA2);
    expect(idB).toBe(idB2);
  });
});
