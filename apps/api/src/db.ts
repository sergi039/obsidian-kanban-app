import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { PROJECT_ROOT } from './config.js';

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  column_name TEXT NOT NULL DEFAULT 'Backlog',
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  raw_line TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  is_done INTEGER DEFAULT 0,
  priority TEXT,
  labels TEXT DEFAULT '[]',
  due_date TEXT,
  sub_items TEXT DEFAULT '[]',
  description TEXT DEFAULT '',
  source_fingerprint TEXT,
  seq_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author TEXT NOT NULL DEFAULT 'user',
  text TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'TEXT',
  options TEXT DEFAULT '[]',
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS field_values (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  value TEXT,
  PRIMARY KEY (card_id, field_id)
);

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT 'board',
  filter_query TEXT DEFAULT '',
  sort_field TEXT DEFAULT 'position',
  sort_dir TEXT DEFAULT 'ASC',
  group_by TEXT DEFAULT '',
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger_json TEXT NOT NULL DEFAULT '{}',
  actions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  last_synced TEXT DEFAULT (datetime('now'))
);
`;

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_cards_board_position ON cards(board_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_board_column ON cards(board_id, column_name)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_priority ON cards(priority)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_due_date ON cards(due_date)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_card ON comments(card_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fields_board ON fields(board_id, position)`,
  `CREATE INDEX IF NOT EXISTS idx_field_values_card ON field_values(card_id)`,
  `CREATE INDEX IF NOT EXISTS idx_field_values_field ON field_values(field_id)`,
  `CREATE INDEX IF NOT EXISTS idx_automations_board ON automations(board_id, enabled)`,
];

const MIGRATIONS = [
  // Add seq_id column — sequential number per board (like GitHub #1, #2, #3)
  `ALTER TABLE cards ADD COLUMN seq_id INTEGER`,
  // Add description column if missing (for existing DBs)
  `ALTER TABLE cards ADD COLUMN description TEXT DEFAULT ''`,
  // Create views table if missing
  `CREATE TABLE IF NOT EXISTS views (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    layout TEXT NOT NULL DEFAULT 'board',
    filter_query TEXT DEFAULT '',
    sort_field TEXT DEFAULT 'position',
    sort_dir TEXT DEFAULT 'ASC',
    group_by TEXT DEFAULT '',
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  // Create fields tables if missing
  `CREATE TABLE IF NOT EXISTS fields (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'TEXT',
    options TEXT DEFAULT '[]',
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS field_values (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    value TEXT,
    PRIMARY KEY (card_id, field_id)
  )`,
  // Create automations table if missing
  `CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_json TEXT NOT NULL DEFAULT '{}',
    actions_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  // Create comments table if missing
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    author TEXT NOT NULL DEFAULT 'user',
    text TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  // Add checklist column for GitHub-style checklists
  `ALTER TABLE cards ADD COLUMN checklist TEXT DEFAULT '[]'`,
  // Add links column for managed link storage
  `ALTER TABLE cards ADD COLUMN links TEXT DEFAULT '[]'`,
];

/**
 * Create an isolated in-memory database for testing.
 * Does NOT set the global singleton — safe for parallel tests.
 */
export function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  testDb.exec(SCHEMA);
  for (const sql of INDEXES) {
    testDb.exec(sql);
  }
  for (const sql of MIGRATIONS) {
    try { testDb.exec(sql); } catch { /* already exists */ }
  }
  return testDb;
}

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolved = dbPath || path.join(PROJECT_ROOT, 'data', 'kanban.db');
  mkdirSync(path.dirname(resolved), { recursive: true });

  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Create indexes
  for (const sql of INDEXES) {
    db.exec(sql);
  }

  // Run migrations for existing DBs
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      // Column/table already exists — safe to ignore
    }
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
