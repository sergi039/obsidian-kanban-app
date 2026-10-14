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
      source TEXT, source_uid TEXT, source_url TEXT, source_meta TEXT DEFAULT '{}', seq_id INTEGER, deleted_at TEXT, trashed_lines TEXT, trashed_after TEXT,
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
    CREATE TABLE IF NOT EXISTS sync_state (
      file_path TEXT PRIMARY KEY,
      file_hash TEXT NOT NULL,
      last_synced TEXT DEFAULT (datetime('now'))
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

  it('stamps sync_state with sha256 of the post-write file on successful capture', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);

    const result = ingestCard({
      boardId: 'private',
      title: 'Hash-stamped task',
      source: 'claude',
      sourceUid: 'claude-message-hash',
    }, config);

    expect(result.created).toBe(true);
    const filePath = path.join(vaultRoot, 'Private.md');
    const onDisk = readFileSync(filePath, 'utf-8');
    const row = testDb.prepare('SELECT file_hash FROM sync_state WHERE file_path = ?').get(filePath) as
      | { file_hash: string }
      | undefined;
    expect(row?.file_hash).toBe(createHash('sha256').update(onDisk).digest('hex'));
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

  it('puts a new card at the top of its column and shifts only live cards', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    const insert = testDb.prepare(
      "INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, deleted_at) VALUES (?, 'private', ?, ?, ?, '', 0, ?)",
    );
    insert.run('old-a', 'Backlog', 0, 'Old A', null);
    insert.run('old-b', 'Backlog', 1, 'Old B', null);
    insert.run('binned', 'Backlog', 7, 'Binned', '2026-10-12T10:00:00Z');
    insert.run('done-a', 'Done', 0, 'Done A', null);

    const result = ingestCard({ boardId: 'private', title: 'Fresh task', column: 'Backlog' }, config);
    if (!result.created) throw new Error('expected card creation');

    const positions = Object.fromEntries(
      (testDb.prepare('SELECT id, position FROM cards').all() as Array<{ id: string; position: number }>)
        .map((row) => [row.id, row.position]),
    );
    expect(positions).toEqual({ [result.card.id]: 0, 'old-a': 1, 'old-b': 2, binned: 7, 'done-a': 0 });
  });
});

describe('ingestCard from an email (EMAIL-1)', () => {
  let vaultRoot: string;
  const email = {
    provider: 'gmail' as const,
    account: 'owner@example.com',
    message_id: 'msg-1',
    thread_id: 'thread-1',
    subject: 'Contract renewal',
    from: 'Partner <partner@example.net>',
  };

  beforeEach(() => {
    testDb = createDb();
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-ingest-email-'));
    writeFileSync(path.join(vaultRoot, 'Private.md'), '# Private\n', 'utf-8');
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('derives source, source_uid, the email link and header-only source_meta', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const result = ingestCard({
      boardId: 'private',
      title: 'Reply about the contract renewal',
      email,
      sourceMeta: { client: 'claude_desktop' },
    }, createConfig(vaultRoot));
    if (!result.created) throw new Error('expected card creation');

    expect(result.card).toMatchObject({
      source: 'email',
      source_uid: 'gmail:owner@example.com:thread:thread-1',
      source_url: 'https://mail.google.com/mail/u/owner@example.com/#all/msg-1',
      title: 'Reply about the contract renewal',
    });
    expect(result.card.source_meta).toEqual({
      client: 'claude_desktop',
      email: {
        provider: 'gmail',
        account: 'owner@example.com',
        message_id: 'msg-1',
        thread_id: 'thread-1',
        subject: 'Contract renewal',
        from: 'Partner <partner@example.net>',
      },
    });
    expect(readFileSync(path.join(vaultRoot, 'Private.md'), 'utf-8')).toContain(
      '- [ ] Reply about the contract renewal [from:email](https://mail.google.com/mail/u/owner@example.com/#all/msg-1)',
    );
  });

  it('returns the existing card when the same thread is captured again with another message and title', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    const first = ingestCard({ boardId: 'private', title: 'Reply about the contract renewal', email }, config);
    if (!first.created) throw new Error('expected card creation');

    const again = ingestCard({
      boardId: 'private',
      title: 'Partner asked again about renewal',
      email: { ...email, message_id: 'msg-2' },
    }, config);

    if (!again.created) throw new Error('expected the existing card');
    expect(again.duplicate).toBe(true);
    expect(again.card.id).toBe(first.card.id);
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(1);
    const file = readFileSync(path.join(vaultRoot, 'Private.md'), 'utf-8');
    expect(file).not.toContain('Partner asked again');
  });

  it('keeps one card per mailbox: the same thread id in another account is another task', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    ingestCard({ boardId: 'private', title: 'First mailbox', email }, config);
    const other = ingestCard({ boardId: 'private', title: 'Second mailbox', email: { ...email, account: 'team@example.com' } }, config);

    if (!other.created) throw new Error('expected card creation');
    expect(other.duplicate).toBe(false);
  });

  it('still rejects a changed payload for a non-email capture key', async () => {
    const { ingestCard, IngestError } = await import('../src/ingest.js');
    const config = createConfig(vaultRoot);
    ingestCard({ boardId: 'private', title: 'One', source: 'claude', sourceUid: 'msg-x' }, config);

    expect(() => ingestCard({ boardId: 'private', title: 'Two', source: 'claude', sourceUid: 'msg-x' }, config))
      .toThrow(expect.objectContaining({ code: 'capture_conflict' }) as unknown as typeof IngestError);
  });

  it.each([
    ['source_uid next to email', { sourceUid: 'custom' }, 'email_provenance_conflict'],
    ['source_url next to email', { sourceUrl: 'https://example.com/x' }, 'email_provenance_conflict'],
    ['a non-email source with email', { source: 'claude' as const }, 'email_source_mismatch'],
    ['an email body in source_meta', { sourceMeta: { body_html: '<p>Dear owner</p>' } }, 'source_meta_email_body'],
    ['an invalid email reference', { email: { ...email, message_id: 'a/b' } }, 'invalid_email_ref'],
  ])('rejects %s', async (_label, extra, code) => {
    const { ingestCard } = await import('../src/ingest.js');
    expect(() => ingestCard({ boardId: 'private', title: 'Task', email, ...extra }, createConfig(vaultRoot)))
      .toThrow(expect.objectContaining({ code }) as unknown as Error);
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM inbox_captures').get() as { n: number }).n).toBe(0);
  });

  it('reserves source_meta.email for the validated email object', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    expect(() => ingestCard({
      boardId: 'private',
      title: 'Task',
      source: 'email',
      sourceMeta: { email: { provider: 'gmail', account: 'me@example.com', thread_id: '.' } },
    }, createConfig(vaultRoot))).toThrow(expect.objectContaining({ code: 'source_meta_email_reserved' }) as unknown as Error);
  });

  it('rejects credentials in source_meta for any source', async () => {
    const { ingestCard } = await import('../src/ingest.js');
    expect(() => ingestCard({
      boardId: 'private',
      title: 'Task',
      source: 'telegram',
      sourceMeta: { chat: { bot_token: '123:abc' } },
    }, createConfig(vaultRoot))).toThrow(expect.objectContaining({ code: 'source_meta_secret', message: expect.stringContaining('chat.bot_token') }) as unknown as Error);
  });
});
