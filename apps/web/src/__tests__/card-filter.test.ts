import { describe, it, expect } from 'vitest';
import { filterCards } from '../lib/card-filter';
import type { Card, Reminder } from '../types';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id,
    seq_id: null,
    board_id: 'b1',
    column_name: 'Backlog',
    position: 0,
    title: `Task ${id}`,
    raw_line: `- [ ] Task ${id}`,
    line_number: 1,
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
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NO_REMINDERS = new Map<string, Reminder[]>();
const ids = (cards: Card[]) => cards.map((c) => c.id);

describe('filterCards (client filter, parity with the server engine)', () => {
  const cards = [
    card('a', { comment_count: 2, labels: ['bug'], due_date: '2026-03-01' }),
    card('b', { comment_count: 0, column_name: 'Done', is_done: true }),
    card('c'),
  ];

  it('has:comments keeps cards with comments instead of hiding every card', () => {
    expect(ids(filterCards(cards, 'has:comments', NO_REMINDERS))).toEqual(['a']);
    expect(ids(filterCards(cards, '-has:comments', NO_REMINDERS))).toEqual(['b', 'c']);
  });

  it('ignores an unknown has: value, like the server', () => {
    expect(ids(filterCards(cards, 'has:attachments', NO_REMINDERS))).toEqual(['a', 'b', 'c']);
  });

  it('ignores an unknown due: value but still matches a literal date', () => {
    expect(ids(filterCards(cards, 'due:someday', NO_REMINDERS))).toEqual(['a', 'b', 'c']);
    expect(ids(filterCards(cards, 'due:2026-03-01', NO_REMINDERS))).toEqual(['a']);
  });

  it('keeps the existing qualifiers and free text working', () => {
    expect(ids(filterCards(cards, 'status:done', NO_REMINDERS))).toEqual(['b']);
    expect(ids(filterCards(cards, '-label:bug', NO_REMINDERS))).toEqual(['b', 'c']);
    expect(ids(filterCards(cards, 'done:yes', NO_REMINDERS))).toEqual(['b']);
    expect(ids(filterCards(cards, 'due:none', NO_REMINDERS))).toEqual(['b', 'c']);
    expect(ids(filterCards(cards, '"task c"', NO_REMINDERS))).toEqual(['c']);
    expect(ids(filterCards(cards, '   ', NO_REMINDERS))).toEqual(['a', 'b', 'c']);
  });
});
