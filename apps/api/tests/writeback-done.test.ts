import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type { AppConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;
let vaultRoot: string;
let testConfig: AppConfig;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});

vi.mock('../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
}));

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return { ...actual, loadConfig: () => testConfig };
});

const BOARD_FILE = 'Tasks/Board.md';

function writeMd(content: string) {
  const abs = path.join(vaultRoot, BOARD_FILE);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readMd(): string {
  return readFileSync(path.join(vaultRoot, BOARD_FILE), 'utf-8');
}

function seedCard(id: string, rawLine: string, lineNumber: number) {
  testDb
    .prepare(
      `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done)
       VALUES (?, 'b1', 'Backlog', 0, ?, ?, ?, 0)`,
    )
    .run(id, rawLine.replace(/^- \[ \] /, ''), rawLine, lineNumber);
}

describe('writeBackDoneState line matching', () => {
  beforeEach(async () => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-wbdone-'));
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testConfig = {
      vaultRoot,
      boards: [{ id: 'b1', name: 'Test Board', file: BOARD_FILE, columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
    };
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('does not toggle a nearby task with the same title when the card has no kb:id', async () => {
    // The card's own line is gone; another task with the same title sits one line up.
    const original = '# Tasks\n- [ ] Call supplier\n- [ ] Pay invoice\n';
    writeMd(original);
    seedCard('nokb0001', '- [ ] Call supplier', 3);

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('nokb0001', true);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no kb:id/);
    expect(readMd()).toBe(original);
  });

  it('toggles a card without kb:id on its recorded line when the line still matches', async () => {
    writeMd('# Tasks\n- [ ] Call supplier\n');
    seedCard('nokb0002', '- [ ] Call supplier', 2);

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('nokb0002', true);

    expect(result).toMatchObject({ success: true, changed: true, lineNumber: 2 });
    expect(readMd()).toBe('# Tasks\n- [x] Call supplier\n');
  });

  it('finds a kb:id card by kb:id when a non-task line now sits on its recorded line', async () => {
    writeMd('# Tasks\n## Section\n- [ ] Pay invoice <!-- kb:id=kb000001 -->\n');
    seedCard('kb000001', '- [ ] Pay invoice <!-- kb:id=kb000001 -->', 2);

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('kb000001', true);

    expect(result).toMatchObject({ success: true, changed: true, lineNumber: 3 });
    expect(readMd()).toBe('# Tasks\n## Section\n- [x] Pay invoice <!-- kb:id=kb000001 -->\n');
    const row = testDb.prepare('SELECT line_number FROM cards WHERE id = ?').get('kb000001') as { line_number: number };
    expect(row.line_number).toBe(3);
  });

  it('does not fall back to title matching when the kb:id is missing from the file', async () => {
    const original = '# Tasks\n- [ ] Pay invoice\n';
    writeMd(original);
    seedCard('kb000002', '- [ ] Pay invoice <!-- kb:id=kb000002 -->', 2);

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('kb000002', true);

    expect(result).toMatchObject({ success: false, error: 'Line not found by kb:id' });
    expect(readMd()).toBe(original);
  });

  it('reports a missing board file without the absolute vault path', async () => {
    seedCard('kb000003', '- [ ] Pay invoice <!-- kb:id=kb000003 -->', 1);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { writeBackDoneState } = await import('../src/writeback.js');
    const result = writeBackDoneState('kb000003', true);

    expect(result).toMatchObject({ success: false, error: 'Board file read/write failed' });
    expect(result.error).not.toContain(vaultRoot);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
