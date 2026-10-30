import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AppConfig } from '../../api/src/config.js';
import { createKanbanServer, type KanbanServerOptions } from '../src/tools.js';
import type { FetchLike } from '../src/api.js';

// The tools run against the real board and card routes of apps/api, on a test database
// and a temporary vault, through an in-memory MCP client: the path an agent's call takes.

type TestDb = ReturnType<typeof import('../../api/src/db.js')['createTestDb']>;
let testDb: TestDb;
let testConfig: AppConfig;

vi.mock('../../api/src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/src/db.js')>('../../api/src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../../api/src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/src/config.js')>();
  return { ...actual, loadConfig: () => testConfig };
});
vi.mock('../../api/src/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../api/src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
  rebindWatcher: vi.fn(),
}));
vi.mock('../../api/src/automations.js', () => ({ fireEvent: vi.fn() }));
vi.mock('../../api/src/obsidian-context.js', () => ({ notifyCardsClosed: vi.fn() }));

const APP_URL = 'https://kanban.example.com';
const email = { provider: 'gmail', account: 'owner@example.com', message_id: 'msg-1', thread_id: 'thread-1' };

let app: Hono;
let vaultRoot: string;
const appFetch: FetchLike = async (input, init) => app.request(input, init);

async function connect(options: Partial<KanbanServerOptions> = {}) {
  const server = createKanbanServer({
    apiUrl: 'http://127.0.0.1:4000',
    appUrl: APP_URL,
    fetch: appFetch,
    timeZone: 'Europe/Madrid',
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

/** One tool call as the agent sees it: the parsed JSON, or the error text. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    if (result.isError) return { error: text, data: undefined };
    return { error: undefined, data: JSON.parse(text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), data: undefined };
  }
}

beforeEach(async () => {
  const { createTestDb } = await import('../../api/src/db.js');
  const { default: boardRoutes } = await import('../../api/src/routes/boards.js');
  const { default: cardRoutes } = await import('../../api/src/routes/cards.js');
  const { apiTokenAuth } = await import('../../api/src/middleware/security.js');
  testDb = createTestDb();
  vaultRoot = mkdtempSync(path.join(os.tmpdir(), 'kanban-mcp-'));
  writeFileSync(path.join(vaultRoot, 'Private.md'), '# Private\n', 'utf-8');
  testConfig = {
    vaultRoot,
    boards: [{ id: 'private', name: 'Private', file: 'Private.md', columns: ['Backlog', 'In Progress', 'Done'] }],
    defaultColumns: ['Backlog', 'In Progress', 'Done'],
  };
  app = new Hono();
  app.use('/api/*', apiTokenAuth());
  app.route('/api/boards', boardRoutes);
  app.route('/api/cards', cardRoutes);
});

afterEach(() => {
  delete process.env.API_TOKEN;
  testDb.close();
  rmSync(vaultRoot, { recursive: true, force: true });
});

describe('obsidian-kanban MCP tools', () => {
  it('offers the kanban tools and tells the agent how to use them', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'kanban_add_comment',
      'kanban_attach_email',
      'kanban_create_card',
      'kanban_follow_up',
      'kanban_list_boards',
      'kanban_list_cards',
      'kanban_move_card',
      'kanban_replace_description',
      'kanban_update_card',
    ]);
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);
    expect(destructive).toEqual(['kanban_replace_description']);
    expect(client.getInstructions()).toContain('kanban_list_boards');
  });

  it('creates a card with its details on top of the first column and in the Markdown file', async () => {
    const client = await connect();
    const boards = await call(client, 'kanban_list_boards', {});
    expect(boards.data.map((board: { id: string }) => board.id)).toEqual(['private']);

    const older = await call(client, 'kanban_create_card', { board_id: 'private', title: 'Older task' });
    expect(older.data.status).toBe('created');

    const created = await call(client, 'kanban_create_card', {
      board_id: 'private',
      title: 'Renew the insurance',
      description: 'The policy ends on Nov 30.',
      due_date: '2026-11-30',
      links: [{ url: 'https://example.com/policy' }],
    });
    expect(created.error).toBeUndefined();
    const card = created.data.card;
    expect(card).toMatchObject({
      board_id: 'private',
      column: 'Backlog',
      title: 'Renew the insurance',
      description: 'The policy ends on Nov 30.',
      due_date: '2026-11-30',
      links: [{ url: 'https://example.com/policy', title: 'https://example.com/policy' }],
      card_url: `${APP_URL}/?board=private&card=${card.id}`,
    });

    const listed = await call(client, 'kanban_list_cards', { board_id: 'private' });
    expect(listed.data.cards.map((c: { title: string }) => c.title)).toEqual(['Renew the insurance', 'Older task']);
    expect(readFileSync(path.join(vaultRoot, 'Private.md'), 'utf-8')).toContain('- [ ] Renew the insurance');
  });

  it('returns the card an email thread already has and changes nothing on it', async () => {
    const client = await connect();
    const first = await call(client, 'kanban_create_card', {
      board_id: 'private', title: 'Answer about the renewal', description: 'First summary', email,
    });
    expect(first.data.status).toBe('created');

    const again = await call(client, 'kanban_create_card', {
      board_id: 'private', title: 'Another title', description: 'Second summary', email: { ...email, message_id: 'msg-2' },
    });
    expect(again.data.status).toBe('existing');
    expect(again.data.card.id).toBe(first.data.card.id);
    expect(again.data.card.description).toBe('First summary');
    expect(again.data.card.title).toBe('Answer about the renewal');
  });

  it('attaches an email of another mailbox to the card and refuses a thread another card has', async () => {
    const client = await connect();
    const created = await call(client, 'kanban_create_card', { board_id: 'private', title: 'Renew the insurance', email });
    const other = await call(client, 'kanban_create_card', { board_id: 'private', title: 'Something else' });
    const work = { provider: 'outlook', account: 'owner@work.example', message_id: 'AAMk-1', thread_id: 'conv-1', subject: 'Insurance' };

    const attached = await call(client, 'kanban_attach_email', { card_id: created.data.card.id, email: work });
    expect(attached.data.status).toBe('attached');
    expect(attached.data.card.email_threads).toEqual([
      expect.objectContaining({ mailbox: 'owner@example.com', provider: 'gmail', card_made_from_it: true, follow_up: null }),
      { id: attached.data.email_thread_id, mailbox: 'owner@work.example', provider: 'outlook', subject: 'Insurance', card_made_from_it: false, follow_up: null },
    ]);
    expect((await call(client, 'kanban_attach_email', { card_id: created.data.card.id, email: work })).data.status).toBe('already_attached');

    const refused = await call(client, 'kanban_attach_email', { card_id: other.data.card.id, email: work });
    expect(refused.error).toContain(`belongs to card ${created.data.card.id}`);
  });

  it('adds to the description and links of a card without losing the link to its email, and rewrites on request', async () => {
    const client = await connect();
    const created = await call(client, 'kanban_create_card', { board_id: 'private', title: 'Reply to the partner', email });
    const card = created.data.card;
    expect(card.links).toHaveLength(1);

    const updated = await call(client, 'kanban_update_card', {
      card_id: card.id,
      append_description: 'They asked for a call.',
      add_links: [{ url: 'https://example.com/agenda', title: 'Agenda' }, { url: card.links[0].url }],
    });
    expect(updated.error).toBeUndefined();
    expect(updated.data.description).toBe('They asked for a call.');
    expect(updated.data.links).toEqual([card.links[0], { url: 'https://example.com/agenda', title: 'Agenda' }]);

    const again = await call(client, 'kanban_update_card', { card_id: card.id, append_description: 'Call booked.' });
    expect(again.data.description).toBe('They asked for a call.\n\nCall booked.');

    const rewritten = await call(client, 'kanban_replace_description', { card_id: card.id, description: 'Call on Monday.' });
    expect(rewritten.data.description).toBe('Call on Monday.');
    expect(rewritten.data.links).toHaveLength(2);

    const comment = await call(client, 'kanban_add_comment', { card_id: card.id, text: 'Sent the agenda' });
    expect(comment.data).toMatchObject({ card_id: card.id, author: 'agent', text: 'Sent the agenda' });
  });

  it('refuses a bad date, a non-web link and an empty update before anything is written', async () => {
    const requests: string[] = [];
    const client = await connect({
      fetch: async (input, init) => {
        requests.push(`${init?.method} ${input}`);
        return app.request(input, init);
      },
    });

    const badDate = await call(client, 'kanban_create_card', { board_id: 'private', title: 'X', due_date: '2026-02-30' });
    expect(badDate.error).toMatch(/calendar date/);
    const badLink = await call(client, 'kanban_create_card', {
      board_id: 'private', title: 'X', links: [{ url: 'file:///etc/passwd' }],
    });
    expect(badLink.error).toMatch(/http\(s\)/);
    const empty = await call(client, 'kanban_update_card', { card_id: 'abc' });
    expect(empty.error).toMatch(/Nothing to change/);

    expect(requests).toEqual([]);
  });

  it('closes a card by moving it to Done, hides done cards unless asked, and says when a list is cut', async () => {
    const client = await connect();
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await call(client, 'kanban_create_card', { board_id: 'private', title })).data.card.id);
    }

    const closed = await call(client, 'kanban_move_card', { card_id: ids[0], column: 'Done' });
    expect(closed.data).toMatchObject({ column: 'Done', is_done: true });
    const again = await call(client, 'kanban_move_card', { card_id: ids[0], column: 'Done' });
    expect(again.data.status).toBe('unchanged');

    const open = await call(client, 'kanban_list_cards', { board_id: 'private' });
    expect(open.data).toMatchObject({ total: 2, returned: 2, truncated: false });
    const all = await call(client, 'kanban_list_cards', { board_id: 'private', include_done: true });
    expect(all.data.total).toBe(3);
    const cut = await call(client, 'kanban_list_cards', { board_id: 'private', limit: 1 });
    expect(cut.data).toMatchObject({ total: 2, returned: 1, truncated: true });

    const badColumn = await call(client, 'kanban_move_card', { card_id: ids[1], column: 'Nowhere' });
    expect(badColumn.error).toMatch(/Kanban API 400: Column "Nowhere" not in board/);
  });

  it('sends the API token when the server runs with one', async () => {
    process.env.API_TOKEN = 'test-token';
    const without = await call(await connect(), 'kanban_list_boards', {});
    expect(without.error).toMatch(/Kanban API 401/);
    const withToken = await call(await connect({ token: 'test-token' }), 'kanban_list_boards', {});
    expect(withToken.error).toBeUndefined();
  });

  it('names the board server and its health check when it does not answer', async () => {
    const client = await connect({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const result = await call(client, 'kanban_list_boards', {});
    expect(result.error).toContain('The board server at http://127.0.0.1:4000 does not answer (fetch failed)');
    expect(result.error).toContain('http://127.0.0.1:4000/api/health');
  });

  it('reports a created card whose details failed, so the agent updates it instead of creating it again', async () => {
    const client = await connect({
      fetch: async (input, init) =>
        init?.method === 'PATCH'
          ? new Response(JSON.stringify({ error: 'Failed to update card' }), { status: 500 })
          : app.request(input, init),
    });
    const result = await call(client, 'kanban_create_card', { board_id: 'private', title: 'Pay the bill', due_date: '2026-11-01' });
    const id = (testDb.prepare('SELECT id FROM cards WHERE title = ?').get('Pay the bill') as { id: string }).id;
    expect(result.error).toContain(`The card ${id} was created`);
    expect(result.error).toContain(`call kanban_update_card with card_id "${id}"`);
  });

  it('asks for an email follow-up in this Mac\'s time zone unless told otherwise', async () => {
    const bodies: unknown[] = [];
    const client = await connect({
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ follow_up: { mode: 'await_reply' }, reminder: null }), { status: 200 });
      },
    });
    const result = await call(client, 'kanban_follow_up', { card_id: 'abc', days: 3 });
    expect(result.data.reminder).toBeNull();
    await call(client, 'kanban_follow_up', { card_id: 'abc', email_thread_id: 't1', days: 2, mode: 'owe_reply', timezone: 'UTC' });
    expect(bodies).toEqual([
      { card_id: 'abc', days: 3, mode: 'await_reply', timezone: 'Europe/Madrid' },
      { card_id: 'abc', email_thread_id: 't1', days: 2, mode: 'owe_reply', timezone: 'UTC' },
    ]);
  });
});
