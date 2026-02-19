import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../src/db.js';
import type Database from 'better-sqlite3';

let testDb: Database.Database;

function insertCard(
  db: Database.Database,
  id: string,
  boardId: string,
  column: string,
  position: number,
  title: string,
  isDone: boolean,
  priority: string | null = null,
  subItems: string[] = [],
  dueDate: string | null = null,
) {
  db.prepare(`
    INSERT OR REPLACE INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, labels, sub_items, due_date, source_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, '[]', ?, ?, 'fp')
  `).run(id, boardId, column, position, title, `- [${isDone ? 'x' : ' '}] ${title}`, isDone ? 1 : 0, priority, JSON.stringify(subItems), dueDate);
}

describe('export formatters', () => {
  // Test format logic directly
  const cleanTitle = (title: string): string => {
    let cleaned = title.replace(/\[([^\]]*)\]\([^)]+\)/g, '$1');
    cleaned = cleaned.replace(/https?:\/\/[^\s)\]]+/g, '').trim();
    cleaned = cleaned.replace(/[⏫🔺]/g, '').trim();
    cleaned = cleaned.replace(/\s+/g, ' ');
    return cleaned;
  };

  const escapeTelegramMd = (text: string): string => {
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  };

  it('cleanTitle removes markdown links', () => {
    expect(cleanTitle('[Google](https://google.com) task')).toBe('Google task');
  });

  it('cleanTitle removes bare URLs', () => {
    expect(cleanTitle('Check https://example.com now')).toBe('Check now');
  });

  it('cleanTitle removes priority emoji', () => {
    expect(cleanTitle('⏫ Important task')).toBe('Important task');
    expect(cleanTitle('🔺 Urgent task')).toBe('Urgent task');
  });

  it('cleanTitle handles combined', () => {
    expect(cleanTitle('⏫ Fix [bug](https://github.com/issue/1) in API')).toBe('Fix bug in API');
  });

  it('escapeTelegramMd escapes special chars', () => {
    expect(escapeTelegramMd('Hello_world')).toBe('Hello\\_world');
    expect(escapeTelegramMd('*bold*')).toBe('\\*bold\\*');
    expect(escapeTelegramMd('item (1)')).toBe('item \\(1\\)');
  });

  it('escapeTelegramMd handles no special chars', () => {
    expect(escapeTelegramMd('simple text')).toBe('simple text');
  });
});

describe('export route DB integration', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns cards grouped by column', () => {
    insertCard(testDb, 'e1', 'test', 'Backlog', 0, 'Task 1', false);
    insertCard(testDb, 'e2', 'test', 'Backlog', 1, 'Task 2', false, 'high');
    insertCard(testDb, 'e3', 'test', 'Done', 0, 'Task 3', true);

    const cards = testDb.prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY column_name, position').all('test') as Array<{ column_name: string }>;

    const columns = new Map<string, typeof cards>();
    for (const card of cards) {
      if (!columns.has(card.column_name)) columns.set(card.column_name, []);
      columns.get(card.column_name)!.push(card);
    }

    expect(columns.size).toBe(2);
    expect(columns.get('Backlog')!.length).toBe(2);
    expect(columns.get('Done')!.length).toBe(1);
  });

  it('handles board with no cards', () => {
    const card = testDb.prepare('SELECT board_id FROM cards WHERE board_id = ? LIMIT 1').get('empty');
    expect(card).toBeUndefined();
  });

  it('cards have sub_items as JSON', () => {
    insertCard(testDb, 'e4', 'test', 'Backlog', 0, 'Task with subs', false, null, ['sub 1', 'sub 2']);

    const card = testDb.prepare('SELECT sub_items FROM cards WHERE id = ?').get('e4') as { sub_items: string };
    const subs = JSON.parse(card.sub_items);
    expect(subs).toEqual(['sub 1', 'sub 2']);
  });

  it('cards have due_date', () => {
    insertCard(testDb, 'e5', 'test', 'Backlog', 0, 'Task with due', false, null, [], '2026-03-01');

    const card = testDb.prepare('SELECT due_date FROM cards WHERE id = ?').get('e5') as { due_date: string };
    expect(card.due_date).toBe('2026-03-01');
  });
});
