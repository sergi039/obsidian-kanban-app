import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KanbanCard } from '../components/Card';
import { doneTargetColumn, openTargetColumn, toggleDoneTargetColumn } from '../lib/done-utils';
import type { Card } from '../types';

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'abc12345',
    seq_id: 7,
    board_id: 'vs',
    column_name: 'In Progress',
    position: 0,
    title: 'Ship the release',
    raw_line: '- [ ] Ship the release',
    line_number: 3,
    is_done: false,
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
    ...overrides,
  };
}

describe('done target columns', () => {
  const vsColumns = ['On Hold', 'Backlog', 'In Progress', 'Live Test', 'Done'];

  it('closes an open card into Done', () => {
    expect(toggleDoneTargetColumn(false, vsColumns)).toBe('Done');
  });

  it('reopens a done card into Backlog even when it is not the first column', () => {
    expect(toggleDoneTargetColumn(true, vsColumns)).toBe('Backlog');
  });

  it('reopens into the first non-Done column when the board has no Backlog', () => {
    expect(openTargetColumn(['Todo', 'Doing', 'Done'])).toBe('Todo');
    expect(openTargetColumn(['Done', 'Doing'])).toBe('Doing');
  });

  it('has no target when the board lacks a Done column or any open column', () => {
    expect(doneTargetColumn(['Backlog', 'Completed'])).toBeNull();
    expect(openTargetColumn(['Done'])).toBeNull();
  });
});

describe('KanbanCard done checkbox', () => {
  it('calls onToggleDone without opening the card', async () => {
    const onToggleDone = vi.fn().mockResolvedValue(undefined);
    const onClick = vi.fn();
    render(<KanbanCard card={makeCard()} priorities={[]} onClick={onClick} onToggleDone={onToggleDone} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Mark as done: Ship the release' });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);

    expect(onToggleDone).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is checked for a done card and offers to reopen it', () => {
    render(
      <KanbanCard card={makeCard({ is_done: true, column_name: 'Done' })} priorities={[]} onClick={vi.fn()} onToggleDone={vi.fn()} />,
    );
    expect(screen.getByRole('checkbox', { name: 'Mark as not done: Ship the release' })).toBeChecked();
  });

  it('ignores repeat clicks while the move is in flight', async () => {
    let resolveMove: () => void = () => {};
    const onToggleDone = vi.fn(() => new Promise<void>((resolve) => { resolveMove = resolve; }));
    render(<KanbanCard card={makeCard()} priorities={[]} onClick={vi.fn()} onToggleDone={onToggleDone} />);

    const checkbox = screen.getByRole('checkbox', { name: 'Mark as done: Ship the release' });
    await userEvent.click(checkbox);
    expect(checkbox).toBeDisabled();
    await userEvent.click(checkbox);
    expect(onToggleDone).toHaveBeenCalledTimes(1);

    resolveMove();
    await vi.waitFor(() => expect(checkbox).toBeEnabled());
  });

  it('renders no checkbox when the board cannot toggle done', () => {
    render(<KanbanCard card={makeCard()} priorities={[]} onClick={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('keeps Cmd/Ctrl-click for bulk selection', async () => {
    const onToggleSelect = vi.fn();
    const onClick = vi.fn();
    render(<KanbanCard card={makeCard()} priorities={[]} onClick={onClick} onToggleSelect={onToggleSelect} onToggleDone={vi.fn()} />);

    const user = userEvent.setup();
    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('button', { name: 'Ship the release' }));
    await user.keyboard('{/Meta}');

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
