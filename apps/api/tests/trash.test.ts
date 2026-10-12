import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import type { AppConfig, BoardConfig } from '../src/config.js';

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
  rebindWatcher: vi.fn(),
}));

vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return { ...actual, loadConfig: () => testConfig };
});

vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

const FILE = 'Tasks/Board.md';

function makeBoard(): BoardConfig {
  return { id: 'b1', name: 'Test Board', file: FILE, columns: ['Backlog', 'In Progress', 'Done'] };
}

function writeMd(content: string) {
  const abs = path.join(vaultRoot, FILE);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

function readMd(): string {
  return readFileSync(path.join(vaultRoot, FILE), 'utf-8');
}

async function reconcile() {
  const { reconcileBoard } = await import('../src/reconciler.js');
  return reconcileBoard(makeBoard(), vaultRoot);
}

function cardByTitle(title: string): Record<string, unknown> {
  const row = testDb.prepare('SELECT * FROM cards WHERE title = ?').get(title) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`no card titled ${title}`);
  return row;
}

function syncHash(): string | undefined {
  const row = testDb.prepare('SELECT file_hash FROM sync_state WHERE file_path = ?').get(path.join(vaultRoot, FILE)) as
    | { file_hash: string }
    | undefined;
  return row?.file_hash;
}

async function makeApp() {
  const { default: cards } = await import('../src/routes/cards.js');
  const { default: boards } = await import('../src/routes/boards.js');
  const { default: reminders } = await import('../src/routes/reminders.js');
  const app = new Hono();
  app.route('/api/cards', cards);
  app.route('/api/boards', boards);
  app.route('/api/reminders', reminders);
  return app;
}

/** Strip kb markers so file assertions read as plain Markdown. */
function plain(content: string): string {
  return content.replace(/ <!-- kb:id=[^>]+-->/g, '');
}

describe('card trash', () => {
  beforeEach(async () => {
    vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-trash-'));
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    testConfig = { vaultRoot, boards: [makeBoard()], defaultColumns: ['Backlog', 'In Progress', 'Done'] };
  });

  afterEach(() => {
    testDb.close();
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  it('removes the task line with its sub-items and keeps the card data', async () => {
    writeMd('---\ntags: [x]\n---\n- [ ] Alpha\n- [ ] Beta\n  note one\n\n  note two\n\n- [ ] Gamma\n');
    await reconcile();
    const beta = cardByTitle('Beta');
    testDb.prepare("INSERT INTO comments (id, card_id, text) VALUES ('c1', ?, 'keep me')").run(beta.id);

    const { trashCard } = await import('../src/trash.js');
    trashCard(beta.id as string);

    expect(plain(readMd())).toBe('---\ntags: [x]\n---\n- [ ] Alpha\n\n- [ ] Gamma\n');
    const row = cardByTitle('Beta');
    expect(row.deleted_at).toMatch(/Z$/);
    expect(JSON.parse(row.trashed_lines as string)).toHaveLength(4);
    expect(row.trashed_after).toBe(cardByTitle('Alpha').id);
    expect(testDb.prepare("SELECT text FROM comments WHERE id = 'c1'").get()).toEqual({ text: 'keep me' });
    expect(syncHash()).toBe(createHash('sha256').update(readMd()).digest('hex'));
  });

  it('keeps live positions contiguous after trashing', async () => {
    writeMd('- [ ] A\n- [ ] B\n- [ ] C\n');
    await reconcile();
    const { trashCard } = await import('../src/trash.js');
    trashCard(cardByTitle('A').id as string);

    const live = testDb
      .prepare("SELECT title, position FROM cards WHERE deleted_at IS NULL AND column_name = 'Backlog' ORDER BY position")
      .all();
    expect(live).toEqual([{ title: 'B', position: 0 }, { title: 'C', position: 1 }]);
  });

  it('restores the exact lines after the preceding task, stamped with the current column', async () => {
    writeMd('- [ ] Alpha\n- [ ] Beta\n  note\n- [ ] Gamma\n\nSome notes\n');
    await reconcile();
    const beta = cardByTitle('Beta');
    const { trashCard, restoreCard } = await import('../src/trash.js');
    trashCard(beta.id as string);
    // Column renamed while the card sat in the trash.
    testDb.prepare("UPDATE cards SET column_name = 'In Progress' WHERE id = ?").run(beta.id);

    restoreCard(beta.id as string);

    expect(plain(readMd())).toBe('- [ ] Alpha\n- [ ] Beta\n  note\n- [ ] Gamma\n\nSome notes\n');
    expect(readMd()).toContain(`- [ ] Beta <!-- kb:id=${beta.id} kb:col=In+Progress -->`);
    const row = cardByTitle('Beta');
    expect(row.deleted_at).toBeNull();
    expect(row.trashed_lines).toBeNull();
    expect(row.line_number).toBe(2);
    expect(syncHash()).toBe(createHash('sha256').update(readMd()).digest('hex'));
  });

  it('restores the first task before the first task line', async () => {
    writeMd('# Tasks\n- [ ] First\n- [ ] Second\n');
    await reconcile();
    const { trashCard, restoreCard } = await import('../src/trash.js');
    const first = cardByTitle('First').id as string;
    trashCard(first);
    restoreCard(first);
    expect(plain(readMd())).toBe('# Tasks\n- [ ] First\n- [ ] Second\n');
  });

  it('restores after the last task block when the anchor task is gone', async () => {
    writeMd('- [ ] Alpha\n- [ ] Beta\n- [ ] Gamma\n  sub\n\nTrailing notes\n');
    await reconcile();
    const { trashCard, restoreCard } = await import('../src/trash.js');
    const beta = cardByTitle('Beta').id as string;
    trashCard(beta);
    trashCard(cardByTitle('Alpha').id as string);
    restoreCard(beta);
    expect(plain(readMd())).toBe('- [ ] Gamma\n  sub\n- [ ] Beta\n\nTrailing notes\n');
  });

  it('puts a restored card at the end of its column', async () => {
    writeMd('- [ ] A\n- [ ] B\n- [ ] C\n');
    await reconcile();
    const { trashCard, restoreCard } = await import('../src/trash.js');
    const a = cardByTitle('A').id as string;
    trashCard(a);
    restoreCard(a);
    expect(cardByTitle('A').position).toBe(2);
  });

  it('refuses to trash a card whose line is missing, leaving the DB untouched', async () => {
    writeMd('- [ ] Only\n');
    await reconcile();
    const only = cardByTitle('Only').id as string;
    writeFileSync(path.join(vaultRoot, FILE), '- [ ] Something else\n', 'utf-8');

    const { trashCard, TrashError } = await import('../src/trash.js');
    expect(() => trashCard(only)).toThrow(TrashError);
    expect(cardByTitle('Only').deleted_at).toBeNull();
  });

  it('leaves the file untouched when the sync_state write fails inside the transaction', async () => {
    writeMd('- [ ] Keep\n- [ ] Bin\n');
    await reconcile();
    const before = readMd();
    const bin = cardByTitle('Bin').id as string;
    testDb.exec('DROP TABLE sync_state');

    const { trashCard } = await import('../src/trash.js');
    expect(() => trashCard(bin)).toThrow(/sync_state/);
    expect(readMd()).toBe(before);
    expect(cardByTitle('Bin').deleted_at).toBeNull();
  });

  it('re-stamps kb:col when the line is already back in the file at restore time', async () => {
    writeMd('- [ ] Keep\n- [ ] Bin\n');
    await reconcile();
    const original = readMd();
    const bin = cardByTitle('Bin').id as string;
    const { trashCard, restoreCard } = await import('../src/trash.js');
    trashCard(bin);
    testDb.prepare("UPDATE cards SET column_name = 'In Progress' WHERE id = ?").run(bin);
    // Line pasted back before the watcher reconciled it.
    writeFileSync(path.join(vaultRoot, FILE), original, 'utf-8');

    restoreCard(bin);

    expect(readMd()).toContain(`- [ ] Bin <!-- kb:id=${bin} kb:col=In+Progress -->`);
    expect(cardByTitle('Bin').raw_line).toBe(`- [ ] Bin <!-- kb:id=${bin} kb:col=In+Progress -->`);
    expect(syncHash()).toBe(createHash('sha256').update(readMd()).digest('hex'));
  });

  it('rejects trashing twice and restoring a live card', async () => {
    writeMd('- [ ] Once\n');
    await reconcile();
    const id = cardByTitle('Once').id as string;
    const { trashCard, restoreCard } = await import('../src/trash.js');
    expect(() => restoreCard(id)).toThrow('Card is not in trash');
    trashCard(id);
    expect(() => trashCard(id)).toThrow('Card is already in trash');
  });

  describe('reconciler', () => {
    it('does not hard-delete trashed cards on the next reconcile', async () => {
      writeMd('- [ ] Keep\n- [ ] Bin\n');
      await reconcile();
      const bin = cardByTitle('Bin').id as string;
      const { trashCard } = await import('../src/trash.js');
      trashCard(bin);

      // An Obsidian edit forces a full reconcile.
      writeFileSync(path.join(vaultRoot, FILE), readMd() + '- [ ] New\n', 'utf-8');
      await reconcile();

      expect(cardByTitle('Bin').deleted_at).not.toBeNull();
      expect(cardByTitle('New').deleted_at).toBeNull();
    });

    it('revives a trashed card when its line reappears in the file', async () => {
      writeMd('- [ ] Keep\n- [ ] Bin\n');
      await reconcile();
      const original = readMd();
      const bin = cardByTitle('Bin').id as string;
      const { trashCard } = await import('../src/trash.js');
      trashCard(bin);

      writeFileSync(path.join(vaultRoot, FILE), original, 'utf-8'); // Obsidian undo
      await reconcile();

      const row = cardByTitle('Bin');
      expect(row.deleted_at).toBeNull();
      expect(row.trashed_lines).toBeNull();
      expect(row.position).toBe(1);
    });
  });

  describe('routes', () => {
    it('DELETE hides the card from the board and lists it in the trash; restore brings it back', async () => {
      writeMd('- [ ] Keep\n- [ ] Bin\n');
      await reconcile();
      const bin = cardByTitle('Bin').id as string;
      const app = await makeApp();

      const del = await app.request(`/api/cards/${bin}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const trashed = await del.json();
      expect(trashed.deleted_at).toBeTruthy();
      expect(trashed).not.toHaveProperty('trashed_lines');

      const board = await (await app.request('/api/boards/b1')).json();
      const titles = board.columns.flatMap((c: { cards: Array<{ title: string }> }) => c.cards.map((x) => x.title));
      expect(titles).toEqual(['Keep']);
      expect(board.trashCount).toBe(1);

      const summary = await (await app.request('/api/boards')).json();
      expect(summary[0].totalCards).toBe(1);

      const trash = await (await app.request('/api/boards/b1/trash')).json();
      expect(trash.map((c: { id: string }) => c.id)).toEqual([bin]);

      const move = await app.request(`/api/cards/${bin}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ column: 'Done', position: 0 }),
      });
      expect(move.status).toBe(404);

      const restore = await app.request(`/api/cards/${bin}/restore`, { method: 'POST' });
      expect(restore.status).toBe(200);
      expect((await restore.json()).deleted_at).toBeNull();
      expect(plain(readMd())).toBe('- [ ] Keep\n- [ ] Bin\n');
      expect((await (await app.request('/api/boards/b1')).json()).trashCount).toBe(0);
    });

    it('returns 404 for an unknown card and 409 for a double trash', async () => {
      writeMd('- [ ] Bin\n');
      await reconcile();
      const bin = cardByTitle('Bin').id as string;
      const app = await makeApp();

      expect((await app.request('/api/cards/nope', { method: 'DELETE' })).status).toBe(404);
      expect((await app.request(`/api/cards/${bin}`, { method: 'DELETE' })).status).toBe(200);
      const again = await app.request(`/api/cards/${bin}`, { method: 'DELETE' });
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe('Card is already in trash');
    });

    it('stops due reminders of trashed cards from reaching delivery agents', async () => {
      writeMd('- [ ] Bin\n');
      await reconcile();
      const bin = cardByTitle('Bin').id as string;
      testDb.prepare(`
        INSERT INTO reminders (id, card_id, board_id, channel, trigger_at)
        VALUES ('r1', ?, 'b1', 'macos', '2020-01-01T00:00:00.000Z')
      `).run(bin);
      const app = await makeApp();

      const before = await (await app.request('/api/reminders/due?channel=macos')).json();
      expect(before.map((r: { id: string }) => r.id)).toEqual(['r1']);

      await app.request(`/api/cards/${bin}`, { method: 'DELETE' });
      expect(await (await app.request('/api/reminders/due?channel=macos')).json()).toEqual([]);
      expect(await (await app.request('/api/reminders?board_id=b1')).json()).toEqual([]);
      const forCard = await (await app.request(`/api/reminders?card_id=${bin}`)).json();
      expect(forCard).toHaveLength(1);
    });
  });
});
