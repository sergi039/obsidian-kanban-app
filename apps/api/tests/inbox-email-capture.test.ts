import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.js';

let testDb: InstanceType<typeof Database>;
let testConfig: AppConfig;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, loadConfig: () => testConfig };
});
vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../src/watcher.js', () => ({ suppressWatcher: vi.fn(), unsuppressWatcher: vi.fn() }));
vi.mock('../src/automations.js', () => ({ fireEvent: vi.fn() }));

const TOKEN = 'test-ingest-token';
const email = { provider: 'outlook', account: 'owner@example.com', message_id: 'AAMk-1', thread_id: 'conv-1' };

async function capture(body: unknown) {
  const { default: inboxRoutes } = await import('../src/routes/inbox.js');
  const app = new Hono();
  app.route('/api/inbox', inboxRoutes);
  return app.request('/api/inbox/capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

describe('POST /api/inbox/capture with email', () => {
  let vaultRoot: string;
  let savedToken: string | undefined;

  beforeEach(async () => {
    savedToken = process.env.INGEST_API_TOKEN;
    process.env.INGEST_API_TOKEN = TOKEN;
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-inbox-email-'));
    writeFileSync(path.join(vaultRoot, 'Work.md'), '# Work\n', 'utf-8');
    testConfig = {
      vaultRoot,
      boards: [{ id: 'work', name: 'Work', file: 'Work.md', columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
    };
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.INGEST_API_TOKEN;
    else process.env.INGEST_API_TOKEN = savedToken;
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('creates a card from an email, then answers duplicate for the same thread', async () => {
    const first = await capture({ title: 'Answer the partner', board_id: 'work', email });
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.status).toBe('created');
    expect(created.card).toMatchObject({
      source: 'email',
      source_uid: 'outlook:owner@example.com:thread:conv-1',
      source_url: 'https://outlook.office.com/mail/deeplink/read/AAMk-1',
    });

    const again = await capture({ title: 'Partner wrote again', board_id: 'work', email: { ...email, message_id: 'AAMk-2' } });
    expect(again.status).toBe(200);
    const duplicate = await again.json();
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.card.id).toBe(created.card.id);
  });

  it('accepts the body the MCP capture tool sends for an email', async () => {
    // Recorded from apps/mcp kanban_capture_task with route explicit + email.
    const res = await capture({
      title: 'Answer the partner',
      board_id: 'work',
      source: 'email',
      source_meta: { client: 'claude_desktop' },
      email: { provider: 'gmail', account: 'owner@example.com', message_id: 'msg-1', thread_id: 'thread-1', subject: 'Renewal' },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.card.source_url).toBe('https://mail.google.com/mail/u/owner@example.com/#all/msg-1');
    expect(body.card.source_meta).toMatchObject({ client: 'claude_desktop', email: { subject: 'Renewal' } });
  });

  it('rejects an email reference that carries the body', async () => {
    const res = await capture({ title: 'Answer the partner', board_id: 'work', email: { ...email, body: 'Dear owner' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid body');
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(0);
  });
});
