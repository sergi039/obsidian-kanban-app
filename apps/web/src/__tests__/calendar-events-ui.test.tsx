import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { CalendarAccount, CalendarEvent, Card } from '../types';
import { CalendarSettingsContext } from '../lib/calendar-context';
import { KanbanCard } from '../components/Card';
import { CalendarEventsSection } from '../components/CalendarEventsSection';

const WORK: CalendarAccount = { id: 'work', label: 'Work', provider: 'outlook', email: 'me@work.example' };
const PERSONAL: CalendarAccount = { id: 'personal', label: 'Personal', provider: 'google', email: 'me@home.example' };
const PERSONAL_EID = btoa('abc123 me@home.example').replace(/=+$/, '');
const GOOGLE_URL = `https://www.google.com/calendar/event?eid=${PERSONAL_EID}`;
const OUTLOOK_URL = 'https://outlook.office365.com/owa/?itemid=AAMkAD%3D&exvsurl=1&path=/calendar/item';

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
    <CalendarSettingsContext.Provider
      value={{ accounts: [WORK, PERSONAL], defaultAccountId, publicUrl: 'https://kanban.example' }}
    >
      {node}
    </CalendarSettingsContext.Provider>
  );
}

let openSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  openSpy = vi.fn(() => null);
  vi.stubGlobal('open', openSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('card face calendar chip', () => {
  it('shows nothing when no event is linked', () => {
    render(withAccounts(<KanbanCard card={makeCard()} priorities={[]} onClick={vi.fn()} />));
    expect(screen.queryByRole('link', { name: /calendar event/i })).toBeNull();
  });

  it('links the nearest event straight into its calendar account without opening the card', async () => {
    const onClick = vi.fn();
    const card = makeCard([{ id: 'e1', url: GOOGLE_URL, title: 'Kick-off', start: inFuture(2), end: null, account: 'personal' }]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    const link = screen.getByRole('link', { name: /Open calendar event: Kick-off/ });
    const href = new URL(link.getAttribute('href')!);
    expect(href.hostname).toBe('calendar.google.com');
    expect(href.searchParams.get('authuser')).toBe('me@home.example');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    await userEvent.click(link);
    expect(onClick).not.toHaveBeenCalled();
    // A separate browser window, not a tab and not the card detail.
    expect(openSpy).toHaveBeenCalledWith(link.getAttribute('href'), '_blank', expect.stringContaining('popup'));
  });

  it('collapses several events behind +N and expands them inline', async () => {
    const onClick = vi.fn();
    const card = makeCard([
      { id: 'later', url: OUTLOOK_URL, title: 'Review', start: inFuture(5), end: null, account: 'work' },
      { id: 'soon', url: GOOGLE_URL, title: 'Kick-off', start: inFuture(1), end: null, account: 'personal' },
    ]);
    render(withAccounts(<KanbanCard card={card} priorities={[]} onClick={onClick} />));

    const toggle = screen.getByRole('button', { name: 'Show all 2 calendar events' });
    expect(toggle).toHaveTextContent('+1');
    await userEvent.click(toggle);
    expect(onClick).not.toHaveBeenCalled();
    const links = Array.from(screen.getByRole('list', { name: 'Calendar events' }).querySelectorAll('a'));
    expect(links.map((a) => a.textContent)).toEqual([expect.stringContaining('Kick-off'), expect.stringContaining('Review')]);
    expect(links[1].getAttribute('href')).toBe(OUTLOOK_URL);

    await userEvent.click(links[1]);
    expect(onClick).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenLastCalledWith(OUTLOOK_URL, '_blank', expect.stringContaining('popup'));
  });
});

describe('card detail calendar section', () => {
  it('lists linked events read-only, with no way to paste links', () => {
    const card = makeCard([{ id: 'e1', url: OUTLOOK_URL, title: 'Review', start: inFuture(1), end: null, account: 'work' }]);
    render(withAccounts(<CalendarEventsSection card={card} title="Call the client" dueDate={null} />));

    const link = screen.getByRole('link', { name: /Review/ });
    expect(link).toHaveAttribute('href', OUTLOOK_URL);
    expect(link).toHaveTextContent('Work');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('opens linked events and new events in a separate window', async () => {
    const card = makeCard([{ id: 'e1', url: OUTLOOK_URL, title: 'Review', start: inFuture(1), end: null, account: 'work' }]);
    render(withAccounts(<CalendarEventsSection card={card} title="Call the client" dueDate={null} />));
    await userEvent.click(screen.getByRole('link', { name: /Review/ }));
    expect(openSpy).toHaveBeenLastCalledWith(OUTLOOK_URL, '_blank', expect.stringContaining('popup'));
    const newEvent = screen.getByRole('link', { name: /New event in Work/ });
    await userEvent.click(newEvent);
    expect(openSpy).toHaveBeenLastCalledWith(newEvent.getAttribute('href'), '_blank', expect.stringContaining('popup'));
  });

  it('creates new events in the board calendar with a link back to the card', () => {
    render(withAccounts(<CalendarEventsSection card={makeCard()} title="Call the client" dueDate="2026-10-14" />));

    expect(screen.getByText('No calendar events linked to this card.')).toBeInTheDocument();
    const outlook = new URL(screen.getByRole('link', { name: /New event in Work/ }).getAttribute('href')!);
    expect(outlook.hostname).toBe('outlook.office.com');
    expect(outlook.searchParams.get('subject')).toBe('Call the client');
    expect(outlook.searchParams.get('startdt')).toBe('2026-10-14');
    expect(outlook.searchParams.get('body')).toBe('Kanban: https://kanban.example/?board=vs&card=card1');
  });

  it('uses the personal Google calendar on personal boards', () => {
    render(withAccounts(<CalendarEventsSection card={makeCard()} title="Buy milk" dueDate={null} />, 'personal'));
    const google = new URL(screen.getByRole('link', { name: /New event in Personal/ }).getAttribute('href')!);
    expect(google.hostname).toBe('calendar.google.com');
    expect(google.searchParams.get('authuser')).toBe('me@home.example');
    expect(google.searchParams.get('details')).toBe('Kanban: https://kanban.example/?board=vs&card=card1');
  });

  it('renders nothing on a board without a calendar when no event is linked', () => {
    const { container } = render(withAccounts(<CalendarEventsSection card={makeCard()} title="t" dueDate={null} />, null));
    expect(container).toBeEmptyDOMElement();
  });
});
