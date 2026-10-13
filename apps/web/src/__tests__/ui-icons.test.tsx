import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { KanbanCard } from '../components/Card';
import { ViewSwitcher } from '../components/ViewSwitcher';
import { ThemeToggle } from '../components/ThemeToggle';
import { BoardSort } from '../components/BoardSort';
import type { Card, PriorityDef } from '../types';

// UI icons are SVG; emoji and symbol glyphs rendered at uneven sizes and baselines.
// Priority emoji stay in the Markdown file only; the card shows a flag in the priority color.
const GLYPH_ICON = /[\p{Extended_Pictographic}\u2190-\u21FF\u25A0-\u25FF\u2600-\u27BF]/u;

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

describe('UI icons', () => {
  it('card meta row uses SVG icons, not emoji', () => {
    const priorities: PriorityDef[] = [{ id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b' }];
    const card = makeCard({
      priority: 'high',
      due_date: '2026-03-27',
      description: 'Details',
      sub_items: ['one'],
      checklist: [{ id: 'c1', title: 'Step', done: false }],
      links: [{ title: 'Spec', url: 'https://example.com' }],
    });
    const { container } = render(<KanbanCard card={card} priorities={priorities} onClick={() => {}} />);

    expect(container.textContent).not.toMatch(GLYPH_ICON);
    expect(container.textContent).toContain('2026-03-27');
    expect(container.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThanOrEqual(6);

    const badge = [...container.querySelectorAll('span')].find((el) => el.textContent === 'High')!;
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge).toHaveStyle({ color: '#f59e0b' });
  });

  it('toolbar controls carry an SVG icon and no glyph text', () => {
    const { container } = render(
      <>
        <ViewSwitcher layout="board" onLayoutChange={() => {}} />
        <ThemeToggle theme="dark" onCycle={() => {}} />
        <BoardSort value="position" onChange={() => {}} />
      </>,
    );

    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(4);
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.textContent).not.toMatch(GLYPH_ICON);
    }
  });
});
