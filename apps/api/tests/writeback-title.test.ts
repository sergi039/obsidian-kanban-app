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
    // Use default priorities so '⏫' (high) is a configured emoji.
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

function seedCard(opts: {
  id: string;
  rawLine: string;
  title: string;
  isDone?: number;
  priority?: string | null;
}) {
  testDb
    .prepare(
      `INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, links)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      'b1',
      'Backlog',
      0,
      opts.title,
      opts.rawLine,
      1,
      opts.isDone ?? 0,
      opts.priority ?? null,
      '[]',
    );
}

describe('writeBackTitle', () => {
  beforeEach(async () => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-wbtitle-'));
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

  it('replaces the display title while preserving the kb marker', async () => {
    const rawLine = '- [ ] Old title <!-- kb:id=t1000001 kb:col=Backlog -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't1000001', rawLine, title: 'Old title' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t1000001', 'Brand new title');

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);

    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [ ] Brand new title <!-- kb:id=t1000001 kb:col=Backlog -->');
    expect(updated).not.toContain('Old title');

    const row = testDb.prepare('SELECT title, raw_line FROM cards WHERE id = ?').get('t1000001') as { title: string; raw_line: string };
    expect(row.title).toBe('Brand new title');
    expect(row.raw_line).toBe('- [ ] Brand new title <!-- kb:id=t1000001 kb:col=Backlog -->');
  });

  it('preserves the priority emoji when a configured emoji is present', async () => {
    const rawLine = '- [ ] ⏫ Important thing <!-- kb:id=t2000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't2000001', rawLine, title: 'Important thing', priority: 'high' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t2000001', 'Renamed thing');

    expect(result.success).toBe(true);
    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [ ] ⏫ Renamed thing <!-- kb:id=t2000001 -->');
  });

  it('preserves the done checkbox state', async () => {
    const rawLine = '- [x] Finished item <!-- kb:id=t3000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't3000001', rawLine, title: 'Finished item', isDone: 1 });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t3000001', 'Finished item renamed');

    expect(result.success).toBe(true);
    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [x] Finished item renamed <!-- kb:id=t3000001 -->');
  });

  it('preserves the [from:source](url) link', async () => {
    const rawLine = '- [ ] Read this [from:telegram](https://t.me/x/1) <!-- kb:id=t4000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't4000001', rawLine, title: 'Read this' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t4000001', 'Read this later');

    expect(result.success).toBe(true);
    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [ ] Read this later [from:telegram](https://t.me/x/1) <!-- kb:id=t4000001 -->');
  });

  it('preserves emoji + from-link + kb marker together', async () => {
    const rawLine = '- [ ] ⏫ Old [from:telegram](https://t.me/x/2) <!-- kb:id=t5000001 kb:col=In+Progress -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't5000001', rawLine, title: 'Old', priority: 'high' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t5000001', 'New name');

    expect(result.success).toBe(true);
    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [ ] ⏫ New name [from:telegram](https://t.me/x/2) <!-- kb:id=t5000001 kb:col=In+Progress -->');
  });

  it('re-extracts links from the new line into the links column', async () => {
    const rawLine = '- [ ] Old [docs](https://example.com/old) <!-- kb:id=t6000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't6000001', rawLine, title: 'Old [docs](https://example.com/old)' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t6000001', 'New [spec](https://example.com/new)');

    expect(result.success).toBe(true);
    const row = testDb.prepare('SELECT links FROM cards WHERE id = ?').get('t6000001') as { links: string };
    const links = JSON.parse(row.links) as Array<{ url: string; title: string }>;
    expect(links).toEqual([{ title: 'spec', url: 'https://example.com/new' }]);
  });

  it('rejects a card without a kb:id marker', async () => {
    const rawLine = '- [ ] No marker here';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 'nomarker', rawLine, title: 'No marker here' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('nomarker', 'Attempted rename');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kb:id/i);
    // File must be untouched.
    expect(readMd('Tasks/Board.md')).toBe(`${rawLine}\n`);
  });

  it('rejects an empty/whitespace title', async () => {
    const rawLine = '- [ ] Keep me <!-- kb:id=t7000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't7000001', rawLine, title: 'Keep me' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t7000001', '   ');

    expect(result.success).toBe(false);
    expect(readMd('Tasks/Board.md')).toContain('Keep me');
  });

  it('stamps sync_state with sha256 of the post-write file', async () => {
    const rawLine = '- [ ] Hash me <!-- kb:id=t8000001 -->';
    writeMd('Tasks/Board.md', `${rawLine}\n`);
    seedCard({ id: 't8000001', rawLine, title: 'Hash me' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t8000001', 'Hashed now');

    expect(result.success).toBe(true);
    expect(getSyncHash('Tasks/Board.md')).toBe(hashFile('Tasks/Board.md'));
  });

  it('locates the line by kb:id even when line_number is stale', async () => {
    const rawLine = '- [ ] Shifted task <!-- kb:id=t9000001 -->';
    // Card claims line 1, but the task is actually on line 3.
    writeMd('Tasks/Board.md', `# Heading\n\n${rawLine}\n`);
    seedCard({ id: 't9000001', rawLine, title: 'Shifted task' });

    const { writeBackTitle } = await import('../src/writeback.js');
    const result = writeBackTitle('t9000001', 'Found by id');

    expect(result.success).toBe(true);
    expect(result.lineNumber).toBe(3);
    const updated = readMd('Tasks/Board.md');
    expect(updated).toContain('- [ ] Found by id <!-- kb:id=t9000001 -->');
  });
});
