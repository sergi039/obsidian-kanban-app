import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { CalendarAccount, CalendarEvent, Card } from '../types';
import { CalendarSettingsContext } from '../lib/calendar-context';

const patchCard = vi.fn();
vi.mock('../api/client', () => ({
  patchCard: (...args: unknown[]) => patchCard(...args),
}));

const { KanbanCard } = await import('../components/Card');
const { CalendarEventsSection } = await import('../components/CalendarEventsSection');

const WORK: CalendarAccount = { id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example' };
const PERSONAL: CalendarAccount = { id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example' };
const PERSONAL_EID = btoa('abc123 me@home.example').replace(/=+$/, '');
const GOOGLE_URL = `https://www.google.com/calendar/event?eid=${PERSONAL_EID}`;
const OUTLOOK_URL = 'https://outlook.office.com/calendar/item/AAMkAD%3D';

function inFuture(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function makeCard(calendar_events: CalendarEvent[] = []): Card {
  return {
    id: 'card1', seq_id: 7, board_id: 'vs', column_name: 'Backlog', position: 0,
    title: 'Call the client', raw_line: '- [ ] Call the client', line_number: 3, is_done: false,
    priority: null, labels: [], due_date: null, sub_items: [], description: '', checklist: [], links: [],
    calendar_events, source_fingerprint: null, source: null, source_uid: null, source_url: null,
    source_meta: {}, created_at: '2026-10-12 10:00:00', updated_at: '2026-10-12 10:00:00',
  };
}

function withAccounts(node: ReactNode, defaultAccountId: string | null = 'work') {
  return (
    <CalendarSettingsContext.Provider value={{ accounts: [WORK, PERSONAL], defaultAccountId }}>
      {node}
    </CalendarSettingsContext.Provider>
  );
}

describe('card face calendar chip', () => {
  it('shows nothing when the card has no events', () => {
    render(withAccounts(<KanbanCard card={makeCard()} priorities={[]} onClick={vi.fn()} />));
    expect(screen.queryByRole('link', { name: /calendar event/i })).toBeNull();
  });

  it('links the single event straight to its calendar account without opening the card', async () => {
    const onClick = vi.fn();
    const card = makeCard([{ id: 'e1', url: GOOGLE_URL, title: 'Kick-off', start: inFuture(2), account: null }]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    const link = screen.getByRole('link', { name: /Open calendar event: Kick-off/ });
    const href = new URL(link.getAttribute('href')!);
    expect(href.hostname).toBe('calendar.google.com');
    expect(href.searchParams.get('authuser')).toBe('me@home.example');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();

    await userEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('collapses several events behind +N and expands them inline', async () => {
    const onClick = vi.fn();
    const card = makeCard([
      { id: 'later', url: OUTLOOK_URL, title: 'Review', start: inFuture(5), account: 'work' },
      { id: 'soon', url: GOOGLE_URL, title: 'Kick-off', start: inFuture(1), account: 'personal' },
      { id: 'undated', url: 'https://zoom.us/j/1', title: 'Sync', start: null, account: null },
    ]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Kick-off/ })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show all 3 calendar events' });
    expect(toggle).toHaveTextContent('+2');

    await userEvent.click(toggle);
    expect(onClick).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('list', { name: 'Calendar events' });
    const links = Array.from(list.querySelectorAll('a'));
    expect(links.map((a) => a.textContent)).toEqual([
      expect.stringContaining('Kick-off'),
      expect.stringContaining('Review'),
      expect.stringContaining('Sync'),
    ]);
    expect(links[1].getAttribute('href')).toBe(OUTLOOK_URL);

    await userEvent.click(toggle);
    expect(screen.queryByRole('list', { name: 'Calendar events' })).toBeNull();
  });
});

describe('card detail calendar section', () => {
  beforeEach(() => {
    patchCard.mockReset();
  });

  it('attaches a pasted link under the account named in the link', async () => {
    patchCard.mockImplementation(async (_id: string, patch: { calendar_events: CalendarEvent[] }) => makeCard(patch.calendar_events));
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(withAccounts(<CalendarEventsSection card={makeCard()} title="Call the client" dueDate={null} onSaved={onSaved} />));

    await userEvent.type(screen.getByLabelText('Calendar event link'), GOOGLE_URL);
    expect(screen.getByLabelText('Calendar account')).toHaveValue('personal');
    await userEvent.type(screen.getByLabelText('Event title'), 'Kick-off');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [cardId, patch] = patchCard.mock.calls[0] as [string, { calendar_events: CalendarEvent[] }];
    expect(cardId).toBe('card1');
    expect(patch.calendar_events).toEqual([
      { id: expect.any(String), url: GOOGLE_URL, title: 'Kick-off', start: null, account: 'personal' },
    ]);
    expect(screen.getByLabelText('Calendar event link')).toHaveValue('');
  });

  it('restores the list and reports the error when saving fails', async () => {
    patchCard.mockRejectedValue(new Error('Unknown calendar account "x"'));
    const existing: CalendarEvent = { id: 'e1', url: OUTLOOK_URL, title: 'Review', start: null, account: 'work' };
    render(withAccounts(<CalendarEventsSection card={makeCard([existing])} title="t" dueDate={null} onSaved={vi.fn()} />));

    await userEvent.click(screen.getByRole('button', { name: 'Remove event link: Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown calendar account');
    expect(screen.getByRole('link', { name: /Review/ })).toBeInTheDocument();
  });

  it('keeps the saved list when the save lands but the board refresh fails', async () => {
    patchCard.mockImplementation(async (_id: string, patch: { calendar_events: CalendarEvent[] }) => makeCard(patch.calendar_events));
    const onSaved = vi.fn().mockRejectedValue(new Error('network down'));
    const existing: CalendarEvent = { id: 'e1', url: OUTLOOK_URL, title: 'Review', start: null, account: 'work' };
    const card = makeCard([existing]);
    const { rerender } = render(withAccounts(<CalendarEventsSection card={card} title="t" dueDate={null} onSaved={onSaved} />));

    await userEvent.click(screen.getByRole('button', { name: 'Remove event link: Review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Saved, but the board did not refresh');
    expect(screen.queryByRole('link', { name: /Review/ })).toBeNull();

    // A later re-render with the same stale card must not resurrect the removed event.
    rerender(withAccounts(<CalendarEventsSection card={card} title="t" dueDate={null} onSaved={onSaved} />));
    expect(screen.queryByRole('link', { name: /Review/ })).toBeNull();
  });

  it('offers new-event and open-calendar links for the chosen account', async () => {
    render(withAccounts(<CalendarEventsSection card={makeCard()} title="Call the client" dueDate="2026-10-14" onSaved={vi.fn()} />));

    const newEvent = screen.getByRole('link', { name: /New event/ });
    const outlook = new URL(newEvent.getAttribute('href')!);
    expect(outlook.hostname).toBe('outlook.office.com');
    expect(outlook.searchParams.get('subject')).toBe('Call the client');
    expect(outlook.searchParams.get('startdt')).toBe('2026-10-14');
    expect(outlook.searchParams.get('body')).toContain('board=vs&card=card1');

    await userEvent.selectOptions(screen.getByLabelText('Calendar for new events'), 'personal');
    const google = new URL(screen.getByRole('link', { name: /New event/ }).getAttribute('href')!);
    expect(google.hostname).toBe('calendar.google.com');
    expect(google.searchParams.get('authuser')).toBe('me@home.example');
    expect(screen.getByRole('link', { name: /Open calendar/ })).toHaveAttribute(
      'href',
      'https://calendar.google.com/calendar/r?authuser=me%40home.example',
    );
  });

  it('rejects non-https links without saving', async () => {
    render(withAccounts(<CalendarEventsSection card={makeCard()} title="t" dueDate={null} onSaved={vi.fn()} />));
    await userEvent.type(screen.getByLabelText('Calendar event link'), 'http://example.com/e');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Only https links');
    expect(patchCard).not.toHaveBeenCalled();
  });
});
