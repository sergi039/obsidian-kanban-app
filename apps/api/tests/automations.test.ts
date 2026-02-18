import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { vi } from 'vitest';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
  initDb: () => {},
}));

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({
    boards: [{ id: 'b1', name: 'Test', file: 'test.md', columns: ['Backlog', 'In Progress', 'Done'] }],
  }),
  PROJECT_ROOT: '/tmp/test',
}));

vi.mock('../src/ws.js', () => ({
  broadcast: vi.fn(),
}));

const { getRules, getRule, createRule, updateRule, deleteRule, fireEvent } = await import('../src/automations.js');

describe('automations engine', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');

    testDb.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        column_name TEXT NOT NULL DEFAULT 'Backlog',
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
      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT 'user',
        text TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE fields (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'TEXT',
        options TEXT DEFAULT '[]',
        position INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE field_values (
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
        value TEXT,
        PRIMARY KEY (card_id, field_id)
      );
      CREATE TABLE automations (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_json TEXT NOT NULL DEFAULT '{}',
        actions_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // Seed
    testDb.prepare(`INSERT INTO cards (id, board_id, column_name, title) VALUES (?, ?, ?, ?)`)
      .run('c1', 'b1', 'Backlog', 'Test task');
    testDb.prepare(`INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('f1', 'b1', 'Sprint', 'SINGLE_SELECT', JSON.stringify([{ id: 's1', name: 'Sprint 1' }]), 0);
  });

  afterEach(() => testDb.close());

  // --- CRUD ---
  it('creates a rule', () => {
    const rule = createRule({
      board_id: 'b1',
      name: 'Auto-comment on move to Done',
      trigger: { type: 'card.moved', to_column: 'Done' },
      actions: [{ type: 'add_comment', text: 'Completed!' }],
    });
    expect(rule.id).toBeTruthy();
    expect(rule.name).toBe('Auto-comment on move to Done');
    expect(rule.enabled).toBe(true);
    expect(rule.trigger.type).toBe('card.moved');
    expect(rule.actions).toHaveLength(1);
  });

  it('lists rules for a board', () => {
    createRule({ board_id: 'b1', name: 'R1', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'x' }] });
    createRule({ board_id: 'b1', name: 'R2', trigger: { type: 'card.created' }, actions: [{ type: 'add_comment', text: 'y' }] });
    const rules = getRules('b1');
    expect(rules).toHaveLength(2);
  });

  it('returns empty for unknown board', () => {
    expect(getRules('nonexistent')).toHaveLength(0);
  });

  it('updates a rule', () => {
    const rule = createRule({ board_id: 'b1', name: 'Old', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'x' }] });
    const updated = updateRule(rule.id, { name: 'New', enabled: false });
    expect(updated!.name).toBe('New');
    expect(updated!.enabled).toBe(false);
  });

  it('deletes a rule', () => {
    const rule = createRule({ board_id: 'b1', name: 'Del', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'x' }] });
    expect(deleteRule(rule.id)).toBe(true);
    expect(getRule(rule.id)).toBeNull();
    expect(deleteRule(rule.id)).toBe(false);
  });

  // --- Trigger matching ---
  it('card.moved trigger matches any column', () => {
    createRule({ board_id: 'b1', name: 'Any move', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'moved' }] });
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'In Progress' });
    expect(result.rulesFired).toBe(1);
    expect(result.totalActions).toBe(1);
  });

  it('card.moved trigger filters by to_column', () => {
    createRule({ board_id: 'b1', name: 'To Done', trigger: { type: 'card.moved', to_column: 'Done' }, actions: [{ type: 'add_comment', text: 'done!' }] });
    
    // Doesn't match
    const r1 = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'In Progress' });
    expect(r1.rulesFired).toBe(0);

    // Matches
    const r2 = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'Done' });
    expect(r2.rulesFired).toBe(1);
  });

  it('card.moved trigger filters by from_column', () => {
    createRule({ board_id: 'b1', name: 'From Blocked', trigger: { type: 'card.moved', from_column: 'Blocked' }, actions: [{ type: 'add_comment', text: 'unblocked!' }] });
    
    const r1 = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'Done' });
    expect(r1.rulesFired).toBe(0);

    const r2 = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Blocked', toColumn: 'Done' });
    expect(r2.rulesFired).toBe(1);
  });

  it('card.created trigger matches', () => {
    createRule({ board_id: 'b1', name: 'New card', trigger: { type: 'card.created' }, actions: [{ type: 'add_comment', text: 'welcome' }] });
    const result = fireEvent({ type: 'card.created', cardId: 'c1', boardId: 'b1', column: 'Backlog', title: 'Test' });
    expect(result.rulesFired).toBe(1);
  });

  it('card.created trigger filters by column', () => {
    createRule({ board_id: 'b1', name: 'In Progress only', trigger: { type: 'card.created', column: 'In Progress' }, actions: [{ type: 'add_comment', text: 'started!' }] });
    
    const r1 = fireEvent({ type: 'card.created', cardId: 'c1', boardId: 'b1', column: 'Backlog', title: 'T' });
    expect(r1.rulesFired).toBe(0);
    
    const r2 = fireEvent({ type: 'card.created', cardId: 'c1', boardId: 'b1', column: 'In Progress', title: 'T' });
    expect(r2.rulesFired).toBe(1);
  });

  // --- Disabled rules ---
  it('disabled rules are not fired', () => {
    const rule = createRule({ board_id: 'b1', name: 'Disabled', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'x' }], enabled: false });
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'A', toColumn: 'B' });
    expect(result.rulesFired).toBe(0);
  });

  // --- Actions ---
  it('add_comment action creates a comment', () => {
    createRule({ board_id: 'b1', name: 'Comment', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'Moved to {{to_column}}' }] });
    fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'Done' });
    
    const comments = testDb.prepare('SELECT * FROM comments WHERE card_id = ?').all('c1') as Array<{ text: string; author: string }>;
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe('Moved to Done');
    expect(comments[0].author).toBe('automation');
  });

  it('set_due_date action sets due date', () => {
    createRule({ board_id: 'b1', name: 'Due', trigger: { type: 'card.moved', to_column: 'In Progress' }, actions: [{ type: 'set_due_date', days_from_now: 7 }] });
    fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'In Progress' });
    
    const card = testDb.prepare('SELECT due_date FROM cards WHERE id = ?').get('c1') as { due_date: string };
    expect(card.due_date).toBeTruthy();
    // Should be 7 days from now
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(card.due_date).toBe(expected.toISOString().slice(0, 10));
  });

  it('set_field action sets a field value', () => {
    createRule({ board_id: 'b1', name: 'Sprint', trigger: { type: 'card.created' }, actions: [{ type: 'set_field', field_id: 'f1', value: 's1' }] });
    fireEvent({ type: 'card.created', cardId: 'c1', boardId: 'b1', column: 'Backlog', title: 'T' });
    
    const fv = testDb.prepare('SELECT value FROM field_values WHERE card_id = ? AND field_id = ?').get('c1', 'f1') as { value: string } | undefined;
    expect(fv).toBeTruthy();
    expect(fv!.value).toBe('s1');
  });

  it('set_field action with null clears the value', () => {
    // Set first
    testDb.prepare('INSERT INTO field_values (card_id, field_id, value) VALUES (?, ?, ?)').run('c1', 'f1', 's1');
    createRule({ board_id: 'b1', name: 'Clear', trigger: { type: 'card.moved' }, actions: [{ type: 'set_field', field_id: 'f1', value: null }] });
    fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'A', toColumn: 'B' });
    
    const fv = testDb.prepare('SELECT value FROM field_values WHERE card_id = ? AND field_id = ?').get('c1', 'f1');
    expect(fv).toBeUndefined();
  });

  // --- Multiple rules ---
  it('fires multiple matching rules', () => {
    createRule({ board_id: 'b1', name: 'R1', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'r1' }] });
    createRule({ board_id: 'b1', name: 'R2', trigger: { type: 'card.moved', to_column: 'Done' }, actions: [{ type: 'add_comment', text: 'r2' }] });
    
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'Done' });
    expect(result.rulesFired).toBe(2);
    expect(result.totalActions).toBe(2);
    
    const comments = testDb.prepare('SELECT text FROM comments WHERE card_id = ? ORDER BY created_at').all('c1') as Array<{ text: string }>;
    expect(comments.map((c) => c.text)).toEqual(['r1', 'r2']);
  });

  // --- Multiple actions per rule ---
  it('executes multiple actions in one rule', () => {
    createRule({
      board_id: 'b1',
      name: 'Multi',
      trigger: { type: 'card.moved', to_column: 'In Progress' },
      actions: [
        { type: 'add_comment', text: 'Started!' },
        { type: 'set_due_date', days_from_now: 14 },
      ],
    });
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'In Progress' });
    expect(result.rulesFired).toBe(1);
    expect(result.totalActions).toBe(2);
    
    const comments = testDb.prepare('SELECT * FROM comments WHERE card_id = ?').all('c1');
    expect(comments).toHaveLength(1);
    
    const card = testDb.prepare('SELECT due_date FROM cards WHERE id = ?').get('c1') as { due_date: string };
    expect(card.due_date).toBeTruthy();
  });

  // --- Error handling ---
  it('reports errors for missing field in set_field', () => {
    createRule({ board_id: 'b1', name: 'Bad field', trigger: { type: 'card.moved' }, actions: [{ type: 'set_field', field_id: 'nonexistent', value: 'x' }] });
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'A', toColumn: 'B' });
    expect(result.rulesFired).toBe(1);
    expect(result.totalActions).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/not found/i);
  });

  // --- Placeholder expansion ---
  it('expands placeholders in comment text', () => {
    createRule({ board_id: 'b1', name: 'Placeholders', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: '{{title}} moved from {{from_column}} to {{to_column}} on {{date}}' }] });
    fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'Backlog', toColumn: 'Done' });
    
    const comments = testDb.prepare('SELECT text FROM comments WHERE card_id = ?').all('c1') as Array<{ text: string }>;
    expect(comments[0].text).toContain('Test task');
    expect(comments[0].text).toContain('Backlog');
    expect(comments[0].text).toContain('Done');
    expect(comments[0].text).toMatch(/\d{4}-\d{2}-\d{2}/); // date
  });

  // --- Cross-board isolation ---
  it('does not fire rules from other boards', () => {
    createRule({ board_id: 'b2', name: 'Other board', trigger: { type: 'card.moved' }, actions: [{ type: 'add_comment', text: 'wrong' }] });
    const result = fireEvent({ type: 'card.moved', cardId: 'c1', boardId: 'b1', fromColumn: 'A', toColumn: 'B' });
    expect(result.rulesFired).toBe(0);
  });
});
