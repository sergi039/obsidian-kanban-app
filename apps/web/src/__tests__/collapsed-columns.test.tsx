import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Board } from '../components/Board';
import {
  collapsedColumnsKey,
  loadCollapsedColumns,
  storeCollapsedColumns,
  toggleCollapsedColumn,
} from '../lib/collapsed-columns';
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

function makeBoard(id: string): BoardDetail {
  return {
    id,
    name: id,
    file: `${id}.md`,
    priorities: [],
    categories: [],
    calendarAccount: null,
    calendarAccounts: [],
    columns: [
      { name: 'Backlog', cards: [makeCard('b1', 'Write the spec', 'Backlog')] },
      {
        name: 'Done',
        cards: [makeCard('d1', 'Shipped release', 'Done'), makeCard('d2', 'Fixed login', 'Done')],
      },
    ],
    trashCount: 0,
  };
}

const noop = async () => {};

function renderBoard(board: BoardDetail) {
  const props = {
    sortField: 'position' as const,
    filterCards: (cards: Card[]) => cards,
    onCardMove: noop,
    onCardClick: () => {},
    onCardAdd: noop,
    onColumnAdd: noop,
    onColumnRename: noop,
    onColumnDelete: noop,
    onPrioritiesChange: noop,
    onCategoriesChange: noop,
  };
  const view = render(<Board board={board} {...props} />);
  return {
    ...view,
    switchTo: (next: BoardDetail) => view.rerender(<Board board={next} {...props} />),
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('collapsed column storage', () => {
  it('round-trips the collapsed columns of each board separately', () => {
    storeCollapsedColumns(window.localStorage, 'vs', new Set(['Done']));
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set(['Done']));
    expect(loadCollapsedColumns(window.localStorage, 'private')).toEqual(new Set());
  });

  it('drops the entry once nothing is collapsed', () => {
    storeCollapsedColumns(window.localStorage, 'vs', new Set(['Done']));
    storeCollapsedColumns(window.localStorage, 'vs', new Set());
    expect(window.localStorage.getItem(collapsedColumnsKey('vs'))).toBeNull();
  });

  it('treats a corrupted or foreign entry as nothing collapsed', () => {
    window.localStorage.setItem(collapsedColumnsKey('vs'), '{not json');
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set());
    window.localStorage.setItem(collapsedColumnsKey('vs'), '{"Done":true}');
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set());
    window.localStorage.setItem(collapsedColumnsKey('vs'), '["Done",7]');
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set(['Done']));
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    } as unknown as Storage;
    expect(loadCollapsedColumns(broken, 'vs')).toEqual(new Set());
    expect(() => storeCollapsedColumns(broken, 'vs', new Set(['Done']))).not.toThrow();
  });

  it('toggles without mutating the given set', () => {
    const before = new Set(['Done']);
    expect(toggleCollapsedColumn(before, 'Done')).toEqual(new Set());
    expect(toggleCollapsedColumn(before, 'Backlog')).toEqual(new Set(['Done', 'Backlog']));
    expect(before).toEqual(new Set(['Done']));
  });
});

describe('collapsing a board column', () => {
  it('folds Done into a strip with its count and remembers it for the board', async () => {
    const user = userEvent.setup();
    const first = renderBoard(makeBoard('vs'));

    expect(screen.getByText('Shipped release')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse column Done' }));

    expect(screen.queryByText('Shipped release')).not.toBeInTheDocument();
    expect(screen.queryByText('Fixed login')).not.toBeInTheDocument();
    const strip = screen.getByRole('button', { name: 'Expand column Done' });
    expect(strip).toHaveTextContent('Done');
    expect(strip).toHaveTextContent('2');
    // Other columns stay as they were.
    expect(screen.getByText('Write the spec')).toBeInTheDocument();
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set(['Done']));

    first.unmount();
    renderBoard(makeBoard('vs'));
    expect(screen.queryByText('Shipped release')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand column Done' })).toBeInTheDocument();
  });

  it('expands the strip on click and on Enter', async () => {
    const user = userEvent.setup();
    storeCollapsedColumns(window.localStorage, 'vs', new Set(['Done']));
    renderBoard(makeBoard('vs'));

    await user.click(screen.getByRole('button', { name: 'Expand column Done' }));
    expect(screen.getByText('Shipped release')).toBeInTheDocument();
    expect(loadCollapsedColumns(window.localStorage, 'vs')).toEqual(new Set());

    await user.click(screen.getByRole('button', { name: 'Collapse column Done' }));
    screen.getByRole('button', { name: 'Expand column Done' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Shipped release')).toBeInTheDocument();
  });

  it('shows each board its own collapsed columns when switching boards', () => {
    storeCollapsedColumns(window.localStorage, 'vs', new Set(['Done']));
    const view = renderBoard(makeBoard('vs'));
    expect(screen.queryByText('Shipped release')).not.toBeInTheDocument();

    view.switchTo(makeBoard('private'));
    expect(screen.getByText('Shipped release')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand column Done' })).not.toBeInTheDocument();
  });
});
