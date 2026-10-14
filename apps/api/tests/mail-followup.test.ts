import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig, CalendarAccount } from '../src/config.js';
import type { ThreadMessage } from '../src/mail-followup.js';

let testDb: InstanceType<typeof Database>;

vi.mock('../src/db.js', async () => {
  const actual = await vi.importActual<typeof import('../src/db.js')>('../src/db.js');
  return { ...actual, getDb: () => testDb };
});
vi.mock('../src/ws.js', () => ({ broadcast: vi.fn() }));

const NOW = new Date('2026-10-14T12:00:00Z');
const WORK: CalendarAccount = {
  id: 'work', label: 'Work', provider: 'outlook', email: 'owner@example.com',
  credentials: { type: 'graph-app', envFile: '/unused' },
};
const config: AppConfig = { vaultRoot: '/tmp/unused', boards: [], defaultColumns: ['Backlog'], calendarAccounts: [WORK] };
const msg = (at: string, outbound: boolean, from = outbound ? 'Owner' : 'Partner'): ThreadMessage => ({ at: new Date(at).toISOString(), outbound, from });

function seedEmailCard(id = 'card0001', email: Record<string, unknown> = { provider: 'outlook', account: 'owner@example.com', message_id: 'm1', thread_id: 'conv-1', subject: 'Renewal' }) {
  testDb.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, source, source_meta)
    VALUES (?, 'work', 'Backlog', 0, 'Answer about renewal', '- [ ] Answer about renewal', 1, 'email', ?)
  `).run(id, JSON.stringify({ email }));
}

function reminderRows() {
  return testDb.prepare('SELECT * FROM reminders').all() as Array<Record<string, unknown> & { source_meta: string }>;
}

describe('follow-up rules', () => {
  it('waits from the owner\'s last message and takes their first later message as the answer', async () => {
    const { baselineFor, findAnswer } = await import('../src/mail-followup.js');
    const thread = [msg('2026-10-01T09:00Z', false), msg('2026-10-02T09:00Z', true), msg('2026-10-04T09:00Z', false), msg('2026-10-05T09:00Z', false)];
    const baseline = baselineFor('await_reply', thread, NOW.toISOString());
    expect(baseline).toBe('2026-10-02T09:00:00.000Z');
    expect(findAnswer('await_reply', baseline, thread)?.at).toBe('2026-10-04T09:00:00.000Z');
    expect(findAnswer('await_reply', baseline, thread.slice(0, 2))).toBeNull();
  });

  it('for owe_reply waits from their last message and takes the owner\'s later message as the answer', async () => {
    const { baselineFor, findAnswer } = await import('../src/mail-followup.js');
    const thread = [msg('2026-10-01T09:00Z', true), msg('2026-10-03T09:00Z', false)];
    const baseline = baselineFor('owe_reply', thread, NOW.toISOString());
    expect(baseline).toBe('2026-10-03T09:00:00.000Z');
    expect(findAnswer('owe_reply', baseline, thread)).toBeNull();
    expect(findAnswer('owe_reply', baseline, [...thread, msg('2026-10-05T09:00Z', true)])?.outbound).toBe(true);
  });

  it('falls back when the thread has no message', async () => {
    const { baselineFor } = await import('../src/mail-followup.js');
    expect(baselineFor('await_reply', [], NOW.toISOString())).toBe(NOW.toISOString());
  });
});

describe('fetchThreadMessages', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kanban-mail-'));
    const { clearTokenCache } = await import('../src/calendar-providers.js');
    clearTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a Graph conversation: all pages, sender and dates only, drafts skipped', async () => {
    writeFileSync(path.join(dir, 'm365.env'), 'M365_TENANT_ID=t\nM365_CLIENT_ID=c\nM365_CLIENT_SECRET=s\n');
    const account: CalendarAccount = { ...WORK, credentials: { type: 'graph-app', envFile: path.join(dir, 'm365.env') } };
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/oauth2/')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (!url.includes('page2')) {
        return new Response(JSON.stringify({
          value: [
            { from: { emailAddress: { address: 'Owner@Example.com', name: 'Owner' } }, sentDateTime: '2026-10-02T09:00:00Z', receivedDateTime: '2026-10-02T09:00:01Z' },
            { isDraft: true, from: { emailAddress: { address: 'owner@example.com' } }, sentDateTime: '2026-10-06T09:00:00Z' },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2',
        }));
      }
      return new Response(JSON.stringify({
        value: [{ from: { emailAddress: { address: 'partner@example.net', name: 'Partner' } }, receivedDateTime: '2026-10-04T09:00:00Z' }],
      }));
    }));

    const { fetchThreadMessages } = await import('../src/mail-followup.js');
    const messages = await fetchThreadMessages(account, { provider: 'outlook', account: 'owner@example.com', thread_id: "conv'1" }, AbortSignal.timeout(5000));

    expect(messages).toEqual([
      { at: '2026-10-02T09:00:00.000Z', outbound: true, from: 'Owner' },
      { at: '2026-10-04T09:00:00.000Z', outbound: false, from: 'Partner' },
    ]);
    const list = new URL(urls[1]);
    expect(list.pathname).toBe('/v1.0/users/owner%40example.com/messages');
    expect(list.searchParams.get('$filter')).toBe("conversationId eq 'conv''1'");
    expect(list.searchParams.get('$select')).toBe('from,sentDateTime,receivedDateTime,isDraft');
  });

  it('reads a Gmail thread by labels, and explains a 403 as missing Gmail consent', async () => {
    writeFileSync(path.join(dir, 'google.env'), 'GOOGLE_CLIENT_ID=c\nGOOGLE_CLIENT_SECRET=s\n');
    writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ account: 'me@home.example', refresh_token: 'r' }));
    const account: CalendarAccount = {
      id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example',
      credentials: { type: 'google-oauth', clientEnvFile: path.join(dir, 'google.env'), tokenFile: path.join(dir, 'token.json') },
    };
    let threadStatus = 200;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      if (threadStatus !== 200) return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), { status: 403 });
      return new Response(JSON.stringify({
        messages: [
          { internalDate: String(Date.parse('2026-10-02T09:00:00Z')), labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Me <me@home.example>' }] } },
          { internalDate: String(Date.parse('2026-10-03T09:00:00Z')), labelIds: ['DRAFT'] },
          { internalDate: String(Date.parse('2026-10-04T09:00:00Z')), labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'Shop <shop@example.net>' }] } },
        ],
      }));
    }));

    const { fetchThreadMessages } = await import('../src/mail-followup.js');
    const email = { provider: 'gmail' as const, account: 'me@home.example', thread_id: 't1' };
    expect(await fetchThreadMessages(account, email, AbortSignal.timeout(5000))).toEqual([
      { at: '2026-10-02T09:00:00.000Z', outbound: true, from: 'Me <me@home.example>' },
      { at: '2026-10-04T09:00:00.000Z', outbound: false, from: 'Shop <shop@example.net>' },
    ]);

    threadStatus = 403;
    await expect(fetchThreadMessages(account, email, AbortSignal.timeout(5000))).rejects.toThrow(/gmail\.metadata/);
  });
});

describe('createFollowUp', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it('creates a follow_up reminder that fires N days after the owner\'s last message', async () => {
    seedEmailCard();
    const { createFollowUp } = await import('../src/mail-followup.js');
    const fetchThread = vi.fn(async () => [msg('2026-10-01T09:00Z', false), msg('2026-10-13T10:00Z', true)]);
    const result = await createFollowUp(
      { cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'Europe/Madrid' },
      { fetchThread, now: () => NOW, config },
    );

    expect(result).toMatchObject({ created: true, followUp: { state: 'waiting', baseline_at: '2026-10-13T10:00:00.000Z', error: null } });
    const [row] = reminderRows();
    expect(row).toMatchObject({
      id: result.reminderId, kind: 'follow_up', channel: 'macos', status: 'scheduled', source: 'email',
      trigger_at: '2026-10-16T10:00:00.000Z', timezone: 'Europe/Madrid', message: 'Нет ответа: «Renewal»',
    });
    expect(fetchThread).toHaveBeenCalledWith(WORK, expect.objectContaining({ thread_id: 'conv-1' }), expect.any(AbortSignal));
  });

  it('creates nothing when the answer is already in the thread', async () => {
    seedEmailCard();
    const { createFollowUp } = await import('../src/mail-followup.js');
    const result = await createFollowUp(
      { cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      { fetchThread: async () => [msg('2026-10-10T09:00Z', true), msg('2026-10-11T09:00Z', false)], now: () => NOW, config },
    );
    expect(result).toMatchObject({ reminderId: null, followUp: { state: 'answered', answered_at: '2026-10-11T09:00:00.000Z', answered_by: 'Partner' } });
    expect(reminderRows()).toHaveLength(0);
  });

  it('still reminds on time when the mailbox cannot be read, and says why', async () => {
    seedEmailCard();
    const { createFollowUp } = await import('../src/mail-followup.js');
    const result = await createFollowUp(
      { cardId: 'card0001', mode: 'await_reply', days: 2, channel: 'in_app', timezone: 'UTC' },
      { fetchThread: async () => { throw new Error('HTTP 503'); }, now: () => NOW, config },
    );
    expect(result.followUp).toMatchObject({ state: 'unchecked', error: 'HTTP 503', baseline_at: NOW.toISOString() });
    expect(reminderRows()[0].trigger_at).toBe('2026-10-16T12:00:00.000Z');

    const unconfigured = await createFollowUp(
      { cardId: 'card0001', mode: 'await_reply', days: 2, channel: 'in_app', timezone: 'UTC' },
      { fetchThread: vi.fn(), now: () => NOW, config: { ...config, calendarAccounts: [] } },
    );
    expect(unconfigured.followUp.error).toMatch(/not configured/);
  });

  it('updates the card\'s active follow-up instead of adding a second one', async () => {
    seedEmailCard();
    const { createFollowUp } = await import('../src/mail-followup.js');
    const deps = { fetchThread: async () => [msg('2026-10-13T10:00Z', true)], now: () => NOW, config };
    const first = await createFollowUp({ cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' }, deps);
    const second = await createFollowUp({ cardId: 'card0001', mode: 'await_reply', days: 5, channel: 'macos', timezone: 'UTC' }, deps);
    expect(second).toMatchObject({ reminderId: first.reminderId, created: false });
    expect(reminderRows()).toHaveLength(1);
    expect(reminderRows()[0].trigger_at).toBe('2026-10-18T10:00:00.000Z');
  });

  it.each([
    ['a card that is not from an email', () => testDb.prepare("INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number) VALUES ('card0001', 'work', 'Backlog', 0, 'T', '- [ ] T', 1)").run(), 'not_an_email_card'],
    ['an email without a thread id', () => seedEmailCard('card0001', { provider: 'gmail', account: 'owner@example.com', message_id: 'm1' }), 'no_thread_id'],
    ['a missing card', () => undefined, 'card_not_found'],
  ])('rejects %s', async (_label, seed, code) => {
    seed();
    const { createFollowUp } = await import('../src/mail-followup.js');
    await expect(createFollowUp({ cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' }, { fetchThread: vi.fn(), now: () => NOW, config }))
      .rejects.toMatchObject({ code });
  });

  it('rejects an unknown time zone', async () => {
    seedEmailCard();
    const { createFollowUp } = await import('../src/mail-followup.js');
    await expect(createFollowUp({ cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'Mars/Olympus' }, { config }))
      .rejects.toMatchObject({ code: 'invalid_timezone' });
  });
});

describe('runFollowUpSync', () => {
  beforeEach(async () => {
    const { createTestDb } = await import('../src/db.js');
    testDb = createTestDb();
    const { resetFollowUpSyncForTests } = await import('../src/mail-followup.js');
    resetFollowUpSyncForTests();
    seedEmailCard();
  });

  afterEach(() => testDb.close());

  async function seedFollowUp() {
    const { createFollowUp } = await import('../src/mail-followup.js');
    return createFollowUp(
      { cardId: 'card0001', mode: 'await_reply', days: 3, channel: 'macos', timezone: 'UTC' },
      { fetchThread: async () => [msg('2026-10-13T10:00Z', true)], now: () => NOW, config },
    );
  }

  it('dismisses the reminder and comments on the card when the answer arrives', async () => {
    const { reminderId } = await seedFollowUp();
    const { runFollowUpSync, getFollowUpSyncStatus } = await import('../src/mail-followup.js');
    const { broadcast } = await import('../src/ws.js');
    await runFollowUpSync({
      fetchThread: async () => [msg('2026-10-13T10:00Z', true), msg('2026-10-14T08:30Z', false, 'Partner')],
      now: () => NOW,
      config,
    });

    const [row] = reminderRows();
    expect(row).toMatchObject({ id: reminderId, status: 'dismissed', dismissed_at: NOW.toISOString() });
    expect(JSON.parse(row.source_meta).follow_up).toMatchObject({ state: 'answered', answered_at: '2026-10-14T08:30:00.000Z', answered_by: 'Partner' });
    const comments = testDb.prepare('SELECT author, text FROM comments WHERE card_id = ?').all('card0001') as Array<{ author: string; text: string }>;
    expect(comments).toEqual([{ author: 'kanban', text: 'Ответ получен 14.10.2026, 08:30 от Partner: напоминание о follow-up снято.' }]);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'reminder-dismissed', reminderId }));
    expect(getFollowUpSyncStatus()).toMatchObject({ ok: true, answered: 1, active: 0, failed: 0 });
  });

  it('keeps waiting while no answer is in the thread', async () => {
    await seedFollowUp();
    const { runFollowUpSync } = await import('../src/mail-followup.js');
    await runFollowUpSync({ fetchThread: async () => [msg('2026-10-13T10:00Z', true)], now: () => NOW, config });
    const [row] = reminderRows();
    expect(row.status).toBe('scheduled');
    expect(JSON.parse(row.source_meta).follow_up).toMatchObject({ state: 'waiting', checked_at: NOW.toISOString(), error: null });
  });

  it('records a failed thread read and keeps the reminder', async () => {
    await seedFollowUp();
    const { runFollowUpSync, getFollowUpSyncStatus } = await import('../src/mail-followup.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runFollowUpSync({ fetchThread: async () => { throw new Error('HTTP 503'); }, now: () => NOW, config });
    const [row] = reminderRows();
    expect(row.status).toBe('scheduled');
    expect(JSON.parse(row.source_meta).follow_up.error).toBe('HTTP 503');
    expect(getFollowUpSyncStatus()).toMatchObject({ ok: false, failed: 1, error: 'HTTP 503' });
  });

  it('keeps a follow-up that was re-set while the thread was read', async () => {
    const { reminderId } = await seedFollowUp();
    const { runFollowUpSync } = await import('../src/mail-followup.js');
    const reset = JSON.stringify({ follow_up: { mode: 'await_reply', days: 9, baseline_at: '2026-10-14T11:00:00.000Z', state: 'waiting', checked_at: null, error: null } });
    await runFollowUpSync({
      fetchThread: async () => {
        testDb.prepare('UPDATE reminders SET source_meta = ? WHERE id = ?').run(reset, reminderId);
        return [msg('2026-10-13T10:00Z', true), msg('2026-10-14T08:30Z', false)];
      },
      now: () => NOW,
      config,
    });
    const [row] = reminderRows();
    expect(row.status).toBe('scheduled');
    expect(row.source_meta).toBe(reset);
  });

  it('leaves a reminder alone that the owner dismissed while the thread was read', async () => {
    const { reminderId } = await seedFollowUp();
    const { runFollowUpSync } = await import('../src/mail-followup.js');
    await runFollowUpSync({
      fetchThread: async () => {
        testDb.prepare("UPDATE reminders SET status = 'dismissed', dismissed_at = '2026-10-14T11:59:00.000Z' WHERE id = ?").run(reminderId);
        return [msg('2026-10-13T10:00Z', true), msg('2026-10-14T08:30Z', false)];
      },
      now: () => NOW,
      config,
    });
    const [row] = reminderRows();
    expect(row.dismissed_at).toBe('2026-10-14T11:59:00.000Z');
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
  });
});
