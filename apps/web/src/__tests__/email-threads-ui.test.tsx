import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { CalendarAccount, Card, EmailFollowUp, EmailThread } from '../types';
import { CalendarSettingsContext } from '../lib/calendar-context';
import { gmailSearch, groupByMailbox, mailboxLabel, threadStatus } from '../lib/email-threads';
import { KanbanCard } from '../components/Card';
import { EmailThreadsSection } from '../components/EmailThreadsSection';

const api = vi.hoisted(() => ({
  followUpEmailThread: vi.fn(),
  detachEmailThread: vi.fn(),
  dismissReminder: vi.fn(),
  snoozeReminder: vi.fn(),
}));
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), ...api }));

const WORK: CalendarAccount = { id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example' };
const PERSONAL: CalendarAccount = { id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example' };
const NOW = new Date('2026-10-30T12:00:00Z');

function followUp(overrides: Partial<EmailFollowUp> = {}): EmailFollowUp {
  return {
    reminder_id: 'r1', mode: 'await_reply', days: 3, state: 'waiting', status: 'scheduled',
    trigger_at: '2026-11-02T10:00:00.000Z', snoozed_until: null, last_fired_at: null,
    answered_at: null, answered_by: null, error: null, ...overrides,
  };
}

function thread(overrides: Partial<EmailThread> = {}): EmailThread {
  return {
    id: 't-work', provider: 'outlook', account: 'me@work.example', subject: 'Insurance renewal', from: 'Agent',
    received_at: null, internet_message_id: null, url: 'https://outlook.office.com/mail/deeplink/read/AAMk-1',
    origin: true, follow_up: null, ...overrides,
  };
}

function makeCard(email_threads: EmailThread[]): Card {
  return {
    id: 'card1', seq_id: 7, board_id: 'vs', column_name: 'Backlog', position: 0,
    title: 'Renew the insurance', raw_line: '- [ ] Renew the insurance', line_number: 3, is_done: false,
    priority: null, labels: [], due_date: null, sub_items: [], description: '', checklist: [], links: [],
    calendar_events: [], email_threads, source_fingerprint: null, source: null, source_uid: null, source_url: null,
    source_meta: {}, created_at: '2026-10-12 10:00:00', updated_at: '2026-10-12 10:00:00',
  };
}

function withAccounts(node: ReactNode) {
  return (
    <CalendarSettingsContext.Provider value={{ accounts: [WORK, PERSONAL], defaultAccountId: null, publicUrl: null }}>
      {node}
    </CalendarSettingsContext.Provider>
  );
}

let openSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  openSpy = vi.fn(() => null);
  vi.stubGlobal('open', openSpy);
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mail thread state', () => {
  it.each([
    ['no follow-up', null, 'linked'],
    ['waiting before the reminder', followUp(), 'waiting'],
    ['the reminder time passed', followUp({ trigger_at: '2026-10-29T10:00:00.000Z' }), 'overdue'],
    ['snoozed past now', followUp({ status: 'snoozed', trigger_at: '2026-10-29T10:00:00.000Z', snoozed_until: '2026-10-31T10:00:00.000Z' }), 'waiting'],
    ['fired without an answer', followUp({ status: 'fired' }), 'overdue'],
    ['answered', followUp({ status: 'dismissed', state: 'answered', answered_by: 'Agent' }), 'answered'],
    ['stopped by the owner', followUp({ status: 'dismissed' }), 'linked'],
    ['mailbox not readable', followUp({ state: 'unchecked', error: 'mailbox not configured' }), 'error'],
  ])('%s', (_label, follow, expected) => {
    expect(threadStatus(thread({ follow_up: follow }), NOW)).toBe(expected);
  });

  it('groups threads per mailbox and shows the most pressing state', () => {
    const mailboxes = groupByMailbox([
      thread(),
      thread({ id: 'g1', provider: 'gmail', account: 'me@home.example', origin: false, follow_up: followUp({ status: 'dismissed', state: 'answered' }) }),
      thread({ id: 'g2', provider: 'gmail', account: 'ME@home.example', origin: false, follow_up: followUp({ status: 'fired' }) }),
    ], NOW);
    expect(mailboxes.map((m) => [m.account, m.threads.length, m.status])).toEqual([
      ['me@work.example', 1, 'linked'],
      ['me@home.example', 2, 'overdue'],
    ]);
  });

  it('labels a mailbox by its configured account, else by its domain', () => {
    expect(mailboxLabel('ME@work.example', [WORK, PERSONAL])).toBe('Work');
    expect(mailboxLabel('someone@other.example', [WORK])).toBe('other.example');
  });

  it('searches Gmail exactly by Message-ID, else by subject without breaking the query', () => {
    const exact = gmailSearch('Me@Home.example', [
      thread({ internet_message_id: '<a@x>' }),
      thread({ internet_message_id: 'b@x' }),
    ]);
    expect(exact?.exact).toBe(true);
    expect(exact?.url).toBe(`https://mail.google.com/mail/u/me@home.example/#search/${encodeURIComponent('{rfc822msgid:a@x rfc822msgid:b@x}')}`);

    const bySubject = gmailSearch('me@home.example', [thread({ subject: 'Say "yes"' }), thread({ subject: null })]);
    expect(bySubject).toEqual({ exact: false, url: `https://mail.google.com/mail/u/me@home.example/#search/${encodeURIComponent('subject:"Say yes"')}` });

    expect(gmailSearch('me@home.example', [thread({ subject: null })])).toBeNull();
    expect(gmailSearch('me@home.example', [thread({ subject: 'x'.repeat(3000) })])).toBeNull();
  });
});

describe('card face mail badges', () => {
  it('shows one badge per mailbox and opens a single thread without opening the card', async () => {
    const onClick = vi.fn();
    const card = makeCard([
      thread({ follow_up: followUp({ trigger_at: '2099-01-01T00:00:00.000Z' }) }),
      thread({ id: 't-home', provider: 'gmail', account: 'me@home.example', url: 'https://mail.google.com/mail/u/me@home.example/#all/18a', origin: false }),
    ]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    const work = screen.getByRole('link', { name: /Open the email in Outlook \(Work\): Insurance renewal\. Waiting for their answer/ });
    expect(work).toHaveAttribute('href', 'https://outlook.office.com/mail/deeplink/read/AAMk-1');
    const home = screen.getByRole('link', { name: /Open the email in Gmail \(Personal\)/ });
    expect(home).toHaveTextContent('Personal');

    await userEvent.click(home);
    expect(onClick).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('https://mail.google.com/mail/u/me@home.example/#all/18a', '_blank', expect.any(String));
  });

  it('expands several threads of one mailbox into a list with a Gmail search', async () => {
    const onClick = vi.fn();
    const card = makeCard([
      thread({ id: 'g1', provider: 'gmail', account: 'me@home.example', subject: 'Policy', url: 'https://mail.google.com/mail/u/me@home.example/#all/1' }),
      thread({ id: 'g2', provider: 'gmail', account: 'me@home.example', subject: 'Invoice', url: 'https://mail.google.com/mail/u/me@home.example/#all/2', origin: false }),
    ]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    const toggle = screen.getByRole('button', { name: /Show 2 email threads in Gmail \(Personal\)/ });
    expect(toggle).toHaveTextContent('Personal ×2');
    await userEvent.click(toggle);
    expect(onClick).not.toHaveBeenCalled();

    const list = screen.getByRole('list', { name: 'Email threads in me@home.example' });
    expect(within(list).getByRole('link', { name: /Policy/ })).toHaveAttribute('href', 'https://mail.google.com/mail/u/me@home.example/#all/1');
    expect(within(list).getByRole('link', { name: /Search Gmail by subject/ }).getAttribute('href'))
      .toContain('#search/');
  });
});

describe('card detail mail section', () => {
  it('follows up a thread in the chosen mode and reloads the card', async () => {
    api.followUpEmailThread.mockResolvedValue({ reminder: { id: 'r9' } });
    const onChanged = vi.fn(async () => {});
    render(withAccounts(<EmailThreadsSection card={makeCard([thread()])} onChanged={onChanged} />));

    await userEvent.selectOptions(screen.getByLabelText('What to wait for'), 'owe_reply');
    await userEvent.selectOptions(screen.getByLabelText('Days to wait'), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Follow up' }));

    expect(api.followUpEmailThread).toHaveBeenCalledWith('card1', 't-work', expect.objectContaining({ days: 5, mode: 'owe_reply' }));
    expect(onChanged).toHaveBeenCalled();
    // The card's own email cannot be detached.
    expect(screen.queryByRole('button', { name: 'Detach' })).toBeNull();
  });

  it('says so when the answer is already in the thread', async () => {
    api.followUpEmailThread.mockResolvedValue({ reminder: null });
    render(withAccounts(<EmailThreadsSection card={makeCard([thread()])} onChanged={async () => {}} />));
    await userEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(await screen.findByText(/already in this thread/)).toBeInTheDocument();
  });

  it('snoozes or stops an active follow-up, and detaches an attached thread after asking', async () => {
    api.snoozeReminder.mockResolvedValue({});
    api.dismissReminder.mockResolvedValue({});
    api.detachEmailThread.mockResolvedValue({});
    vi.stubGlobal('confirm', vi.fn(() => true));
    const onChanged = vi.fn(async () => {});
    const attached = thread({ id: 't-home', provider: 'gmail', account: 'me@home.example', origin: false, follow_up: followUp({ reminder_id: 'r5', trigger_at: '2099-01-01T00:00:00.000Z' }) });
    render(withAccounts(<EmailThreadsSection card={makeCard([attached])} onChanged={onChanged} />));

    expect(screen.queryByRole('button', { name: 'Follow up' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Snooze 1 day' }));
    expect(api.snoozeReminder).toHaveBeenCalledWith('r5', { minutes: 24 * 60 });
    await userEvent.click(screen.getByRole('button', { name: 'Stop following up' }));
    expect(api.dismissReminder).toHaveBeenCalledWith('r5');
    await userEvent.click(screen.getByRole('button', { name: 'Detach' }));
    expect(api.detachEmailThread).toHaveBeenCalledWith('card1', 't-home');
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it('shows the server\'s reason when a follow-up is refused', async () => {
    const { ApiError } = await import('../api/client');
    api.followUpEmailThread.mockRejectedValue(new ApiError(404, JSON.stringify({ error: 'Card not found' })));
    render(withAccounts(<EmailThreadsSection card={makeCard([thread()])} onChanged={async () => {}} />));
    await userEvent.click(screen.getByRole('button', { name: 'Follow up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Card not found');
  });
});
