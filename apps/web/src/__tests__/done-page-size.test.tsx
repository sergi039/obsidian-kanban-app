import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '../components/Board';
import {
  DONE_PAGE_SIZE_STORAGE_KEY,
  loadDonePageSize,
  parseDonePageSize,
  storeDonePageSize,
} from '../lib/done-page-size';
import type { BoardDetail, Card } from '../types';

function makeCard(id: string, title: string, column: string): Card {
  return {
    id,
    seq_id: 1,
    board_id: 'vs',
    column_name: column,
    position: 0,
    title,
    raw_line: `- [ ] ${title}`,
    line_number: 1,
    is_done: column === 'Done',
    priority: null,
    labels: [],
    due_date: null,
    sub_items: [],
    description: '',
    checklist: [],
    links: [],
    calendar_events: [],
    source_fingerprint: null,
    source: null,
    source_uid: null,
    source_url: null,
    source_meta: {},
    created_at: '2026-10-12 10:00:00',
    updated_at: '2026-10-12 10:00:00',
  };
}

const DONE_COUNT = 12;

function makeBoard(): BoardDetail {
  return {
    id: 'vs',
    name: 'vs',
    file: 'vs.md',
    priorities: [],
    categories: [],
    calendarAccount: null,
    calendarAccounts: [],
    columns: [
      { name: 'Backlog', cards: [makeCard('b1', 'Write the spec', 'Backlog')] },
      {
        name: 'Done',
        cards: Array.from({ length: DONE_COUNT }, (_, i) => makeCard(`d${i + 1}`, `Closed task ${i + 1}`, 'Done')),
      },
    ],
    trashCount: 0,
  };
}

const noop = async () => {};

function renderBoard() {
  return render(
    <Board
      board={makeBoard()}
      sortField="position"
      filterCards={(cards) => cards}
      onCardMove={noop}
      onCardClick={() => {}}
      onCardAdd={noop}
      onColumnAdd={noop}
      onColumnRename={noop}
      onColumnDelete={noop}
      onPrioritiesChange={noop}
      onCategoriesChange={noop}
    />,
  );
}

const shownDoneTitles = () => screen.queryAllByText(/^Closed task \d+$/).map((el) => el.textContent);

afterEach(() => {
  window.localStorage.clear();
});

describe('Done page size storage', () => {
  it('accepts only the offered sizes and falls back to auto', () => {
    expect(parseDonePageSize('5')).toBe(5);
    expect(parseDonePageSize('20')).toBe(20);
    expect(parseDonePageSize('7')).toBe('auto');
    expect(parseDonePageSize('auto')).toBe('auto');
    expect(parseDonePageSize(null)).toBe('auto');
  });

  it('round-trips a size and clears the entry for auto', () => {
    storeDonePageSize(window.localStorage, 10);
    expect(loadDonePageSize(window.localStorage)).toBe(10);
    storeDonePageSize(window.localStorage, 'auto');
    expect(window.localStorage.getItem(DONE_PAGE_SIZE_STORAGE_KEY)).toBeNull();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(loadDonePageSize(broken)).toBe('auto');
    expect(() => storeDonePageSize(broken, 5)).not.toThrow();
  });
});

describe('Done page size on the board', () => {
  it('shows every Done card on Auto and offers the picker only in Done', () => {
    renderBoard();
    expect(shownDoneTitles()).toHaveLength(DONE_COUNT);
    expect(screen.getByRole('combobox', { name: 'Cards shown in Done' })).toHaveValue('auto');
    expect(screen.queryByRole('combobox', { name: 'Cards shown in Backlog' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();
  });

  it('pages Done from the top and remembers the size', async () => {
    const user = userEvent.setup();
    const first = renderBoard();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Cards shown in Done' }), '5');
    expect(shownDoneTitles()).toEqual(['Closed task 1', 'Closed task 2', 'Closed task 3', 'Closed task 4', 'Closed task 5']);
    expect(screen.getByText('Write the spec')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show 5 more · 7 hidden' }));
    expect(shownDoneTitles()).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show 2 more · 2 hidden' }));
    expect(shownDoneTitles()).toHaveLength(DONE_COUNT);
    expect(screen.queryByRole('button', { name: /more/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(shownDoneTitles()).toHaveLength(5);
    expect(loadDonePageSize(window.localStorage)).toBe(5);

    first.unmount();
    renderBoard();
    expect(shownDoneTitles()).toHaveLength(5);
    expect(screen.getByRole('combobox', { name: 'Cards shown in Done' })).toHaveValue('5');
  });

  it('starts from one page again when the size changes', async () => {
    const user = userEvent.setup();
    storeDonePageSize(window.localStorage, 5);
    renderBoard();

    await user.click(screen.getByRole('button', { name: 'Show 5 more · 7 hidden' }));
    expect(shownDoneTitles()).toHaveLength(10);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Cards shown in Done' }), '10');
    expect(shownDoneTitles()).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Show 2 more · 2 hidden' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Cards shown in Done' }), 'auto');
    expect(shownDoneTitles()).toHaveLength(DONE_COUNT);
  });
});
