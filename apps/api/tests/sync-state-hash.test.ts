import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { AppConfig, BoardConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;
let vaultRoot: string;
let testConfig: AppConfig;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return {
    ...actual,
    getDb: () => testDb,
  };
});

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

function makeBoard(): BoardConfig {
  return {
    id: 'b1',
    name: 'Test Board',
    file: 'Tasks/Board.md',
    columns: ['Backlog', 'In Progress', 'Done'],
  };
}

function writeMd(relPath: string, content: string) {
  const abs = path.join(vaultRoot, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readMd(relPath: string): string {
  return readFileSync(path.join(vaultRoot, relPath), 'utf-8');
}

/** Hash the on-disk file content the same way reconciler does. */
function hashFile(relPath: string): string {
  return createHash('sha256').update(readMd(relPath)).digest('hex');
}

function getSyncHash(relPath: string): string | undefined {
  const filePath = path.join(vaultRoot, relPath);
  const row = testDb.prepare('SELECT file_hash FROM sync_state WHERE file_path = ?').get(filePath) as
    | { file_hash: string }
    | undefined;
  return row?.file_hash;
}

describe('write-back updates sync_state.file_hash', () => {
  beforeEach(async () => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-synchash-'));
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testConfig = {
      vaultRoot,
      boards: [makeBoard()],
      defaultColumns: ['Backlog', 'In Progress', 'Done'],
    };
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('writeBackDoneState stamps sync_state with sha256 of the post-write file', async () => {
    writeMd('Tasks/Board.md', '- [ ] Ship it <!-- kb:id=done0001 -->\n');
    const rawLine = '- [ ] Ship it <!-- kb:id=done0001 -->';
    testDb
      .prepare(
        `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('done0001', 'b1', 'Backlog', 0, 'Ship it', rawLine, 1, 0);

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('done0001', true);

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(readMd('Tasks/Board.md')).toContain('- [x] Ship it');

    // sync_state hash must equal sha256 of the file content on disk.
    expect(getSyncHash('Tasks/Board.md')).toBe(hashFile('Tasks/Board.md'));
  });

  it('writeBackColumn stamps sync_state with sha256 of the post-write file', async () => {
    writeMd('Tasks/Board.md', '- [ ] Move me <!-- kb:id=cola0001 -->\n');
    const rawLine = '- [ ] Move me <!-- kb:id=cola0001 -->';
    testDb
      .prepare(
        `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cola0001', 'b1', 'Backlog', 0, 'Move me', rawLine, 1, 0);

    const { writeBackColumn } = await import('../src/writeback.js');
    const result = writeBackColumn('cola0001', 'In Progress');

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(readMd('Tasks/Board.md')).toContain('kb:col=In+Progress');

    expect(getSyncHash('Tasks/Board.md')).toBe(hashFile('Tasks/Board.md'));
  });

  it('writeBackPriority stamps sync_state with sha256 of the post-write file', async () => {
    writeMd('Tasks/Board.md', '- [ ] Triage <!-- kb:id=prio0001 -->\n');
    const rawLine = '- [ ] Triage <!-- kb:id=prio0001 -->';
    testDb
      .prepare(
        `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('prio0001', 'b1', 'Backlog', 0, 'Triage', rawLine, 1, 0);

    const { writeBackPriority } = await import('../src/writeback.js');
    const result = writeBackPriority('prio0001', 'urgent');

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    expect(getSyncHash('Tasks/Board.md')).toBe(hashFile('Tasks/Board.md'));
  });

  it('sync_state hash lets reconciler skip re-processing a write-back', async () => {
    // Seed the file + card via reconciler so sync_state starts consistent.
    writeMd('Tasks/Board.md', '- [ ] Roundtrip <!-- kb:id=rt000001 -->\n');
    testDb
      .prepare(
        `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('rt000001', 'b1', 'Backlog', 0, 'Roundtrip', '- [ ] Roundtrip <!-- kb:id=rt000001 -->', 1, 0);

    const { writeBackDoneState } = await import('../src/writeback.js');
    writeBackDoneState('rt000001', true);

    // reconcileBoard should see the file hash already recorded and skip.
    const { reconcileBoard } = await import('../src/reconciler.js');
    const result = reconcileBoard(makeBoard(), vaultRoot);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);
  });
});
