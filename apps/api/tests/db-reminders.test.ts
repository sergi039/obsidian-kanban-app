import { describe, it, expect } from 'vitest';
import { createTestDb } from '../src/db.js';

describe('reminders database schema', () => {
  it('creates reminders table and indexes in test DB', () => {
    const db = createTestDb();
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminders'").get();
      expect(table).toBeTruthy();

      const indexes = db.prepare('PRAGMA index_list(reminders)').all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
        'idx_reminders_card',
        'idx_reminders_board_status',
        'idx_reminders_due',
        'idx_reminders_source_uid',
        'idx_reminders_source_unique',
      ]));
    } finally {
      db.close();
    }
  });

  it('cascades reminders when a card is deleted', () => {
    const db = createTestDb();
    try {
      db.prepare(`
        INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number)
        VALUES ('c1', 'b1', 'Backlog', 0, 'Task', '- [ ] Task', 1)
      `).run();
      db.prepare(`
        INSERT INTO reminders (id, card_id, board_id, trigger_at)
        VALUES ('r1', 'c1', 'b1', '2026-06-04T09:00:00.000Z')
      `).run();

      db.prepare('DELETE FROM cards WHERE id = ?').run('c1');

      const remaining = db.prepare('SELECT COUNT(*) AS count FROM reminders WHERE id = ?').get('r1') as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      db.close();
    }
  });
});
