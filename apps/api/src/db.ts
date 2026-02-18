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
  source_fingerprint TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  last_synced TEXT DEFAULT (datetime('now'))
);
`;

export function getDb(dbPath?: string): Database.Database {
  if (db) return db;

  const resolved = dbPath || path.join(PROJECT_ROOT, 'data', 'kanban.db');
  mkdirSync(path.dirname(resolved), { recursive: true });

  db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
