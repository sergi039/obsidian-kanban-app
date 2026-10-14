import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
vi.mock('../src/obsidian-context.js', () => ({ notifyCardsClosed: vi.fn() }));

const email = { provider: 'gmail', account: 'owner@example.com', message_id: 'msg-1', thread_id: 'thread-1', subject: 'Renewal' };

async function create(body: unknown) {
  const { default: cardRoutes } = await import('../src/routes/cards.js');
  const app = new Hono();
  app.route('/api/cards', cardRoutes);
  return app.request('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/cards with email (EMAIL-2)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-cards-email-'));
    writeFileSync(path.join(vaultRoot, 'Private.md'), '# Private\n', 'utf-8');
    testConfig = {
      vaultRoot,
      boards: [{ id: 'private', name: 'Private', file: 'Private.md', columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
    };
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('creates a card that links to the email, and answers 200 with that card for the same thread', async () => {
    const first = await create({ board_id: 'private', title: 'Answer about the renewal', email });
    expect(first.status).toBe(201);
    const card = await first.json();
    expect(card).toMatchObject({
      source: 'email',
      source_url: 'https://mail.google.com/mail/u/owner@example.com/#all/msg-1',
      links: [{ title: 'from:email', url: 'https://mail.google.com/mail/u/owner@example.com/#all/msg-1' }],
    });
    expect(readFileSync(path.join(vaultRoot, 'Private.md'), 'utf-8')).toContain('[from:email](https://mail.google.com/mail/u/owner@example.com/#all/msg-1)');

    const again = await create({ board_id: 'private', title: 'Renewal again', email: { ...email, message_id: 'msg-2' } });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(card.id);
    expect((testDb.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n).toBe(1);
  });

  it('answers 409 when the thread had a card that was deleted for good', async () => {
    const first = await create({ board_id: 'private', title: 'Answer about the renewal', email });
    const { id } = await first.json();
    testDb.prepare('DELETE FROM cards WHERE id = ?').run(id);

    const again = await create({ board_id: 'private', title: 'Answer about the renewal', email });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: 'capture_deleted' });
  });

  it('keeps creating plain cards without email as before', async () => {
    const a = await create({ board_id: 'private', title: 'Same title' });
    const b = await create({ board_id: 'private', title: 'Same title' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await a.json()).source).toBe('manual');
  });

  it('rejects an email reference with the body in it', async () => {
    const res = await create({ board_id: 'private', title: 'Task', email: { ...email, body: 'Dear owner' } });
    expect(res.status).toBe(400);
  });
});
