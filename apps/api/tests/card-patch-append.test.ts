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
vi.mock('../src/obsidian-context.js', () => ({ notifyCardsClosed: vi.fn() }));

const email = { provider: 'gmail', account: 'owner@example.com', message_id: 'msg-1', thread_id: 'thread-1' };

async function call(method: string, url: string, body: unknown) {
  const { default: cardRoutes } = await import('../src/routes/cards.js');
  const app = new Hono();
  app.route('/api/cards', cardRoutes);
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createCard(body: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/cards', { board_id: 'private', title: 'Renew the insurance', ...body });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; links: Array<{ url: string; title: string }> };
}

const patch = (id: string, body: unknown) => call('PATCH', `/api/cards/${id}`, body);

describe('PATCH /api/cards/:id adds to the description and links', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-patch-append-'));
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

  it('appends a paragraph to the description, or sets it when there is none', async () => {
    const card = await createCard();

    const first = await patch(card.id, { append_description: 'Call the broker.' });
    expect(first.status).toBe(200);
    expect((await first.json()).description).toBe('Call the broker.');

    const second = await patch(card.id, { append_description: 'Deadline moved to Friday.' });
    expect((await second.json()).description).toBe('Call the broker.\n\nDeadline moved to Friday.');
  });

  it('adds links after the existing ones and skips a URL the card already has', async () => {
    const card = await createCard({ email });
    expect(card.links).toHaveLength(1);
    const emailLink = card.links[0];

    const res = await patch(card.id, {
      add_links: [
        { url: 'https://example.com/policy', title: 'Policy' },
        { url: emailLink.url, title: 'Same email again' },
        { url: 'https://example.com/policy', title: 'Policy twice' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).links).toEqual([emailLink, { url: 'https://example.com/policy', title: 'Policy' }]);
  });

  it('refuses a replacement and an addition of the same field in one request', async () => {
    const card = await createCard();

    const description = await patch(card.id, { description: 'New', append_description: 'More' });
    expect(description.status).toBe(400);

    const links = await patch(card.id, {
      links: [],
      add_links: [{ url: 'https://example.com', title: 'Example' }],
    });
    expect(links.status).toBe(400);

    const row = testDb.prepare('SELECT description, links FROM cards WHERE id = ?').get(card.id) as {
      description: string | null;
      links: string;
    };
    expect(row.description ?? '').toBe('');
    expect(JSON.parse(row.links)).toEqual([]);
  });
});
