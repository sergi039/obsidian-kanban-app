import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../src/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

vi.mock('../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

function createDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
      position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
      line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
      labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
      description TEXT DEFAULT '', source_fingerprint TEXT, links TEXT DEFAULT '[]',
      source TEXT, source_uid TEXT, source_url TEXT, source_meta TEXT DEFAULT '{}', seq_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inbox_captures (
      capture_key TEXT PRIMARY KEY,
      card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      source_uid TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      updated_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function createConfig(vaultRoot: string): AppConfig {
  return {
    vaultRoot,
    boards: [
      {
        id: 'private',
        name: 'Private',
        file: 'Private.md',
        columns: ['Backlog', 'Done'],
      },
    ],
    defaultColumns: ['Backlog', 'Done'],
  };
}

describe('ingestCard', () => {
  let vaultRoot: string;

  beforeEach(() => {
    testDb = createDb();
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-ingest-'));
    writeFileSync(path.join(vaultRoot, 'Private.md'), '# Private\n', 'utf-8');
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('allows retrying the same capture after a failed write', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);

    rmSync(path.join(vaultRoot, 'Private.md'));
    expect(() => ingestCard({
      boardId: 'private',
      title: 'Retryable task',
      source: 'claude',
      sourceUid: 'claude-message-1',
    }, config)).toThrow();

    const failed = testDb.prepare('SELECT status, card_id FROM inbox_captures').get() as { status: string; card_id: string | null };
    expect(failed).toMatchObject({ status: 'failed', card_id: null });

    writeFileSync(path.join(vaultRoot, 'Private.md'), '# Private\n', 'utf-8');
    const result = ingestCard({
      boardId: 'private',
      title: 'Retryable task',
      source: 'claude',
      sourceUid: 'claude-message-1',
    }, config);

    expect(result.created).toBe(true);
    if (!result.created) throw new Error('expected card creation');
    expect(result.duplicate).toBe(false);
    expect(testDb.prepare('SELECT status, card_id FROM inbox_captures').get()).toMatchObject({
      status: 'completed',
      card_id: result.card.id,
    });
    expect(readFileSync(path.join(vaultRoot, 'Private.md'), 'utf-8')).toContain('Retryable task');
  });

  it('returns a duplicate capture before re-routing a completed write', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    const input = {
      boardId: 'private',
      title: 'Existing captured task',
      source: 'claude' as const,
      sourceUid: 'claude-message-duplicate',
    };

    const first = ingestCard(input, config);
    expect(first.created).toBe(true);
    if (!first.created) throw new Error('expected initial card creation');

    const brokenRoutingConfig: AppConfig = {
      ...config,
      boards: [],
    };
    const replay = ingestCard(input, brokenRoutingConfig);

    expect(replay.created).toBe(true);
    if (!replay.created) throw new Error('expected duplicate card');
    expect(replay.duplicate).toBe(true);
    expect(replay.card.id).toBe(first.card.id);
    expect(replay.route.reason).toContain('Existing capture');
  });

  it('does not retry a pending capture with no card', async () => {
    const { ingestCard, IngestError } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    const captureKey = createHash('sha256').update('claude|claude-message-2').digest('hex');

    testDb.prepare(`
      INSERT INTO inbox_captures (capture_key, source, source_uid, request_hash, status)
      VALUES (?, 'claude', 'claude-message-2', '', 'pending')
    `).run(captureKey);

    expect(() => ingestCard({
      boardId: 'private',
      title: 'Pending task',
      source: 'claude',
      sourceUid: 'claude-message-2',
    }, config)).toThrow(IngestError);
  });
});
