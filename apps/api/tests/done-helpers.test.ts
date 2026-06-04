import { describe, it, expect } from 'vitest';
import { getDefaultDoneColumn, getDefaultOpenColumn, isDoneColumn } from '../src/parser.js';

describe('isDoneColumn', () => {
  it('returns true for "Done"', () => {
    expect(isDoneColumn('Done')).toBe(true);
  });

  it('returns false for other columns', () => {
    expect(isDoneColumn('Backlog')).toBe(false);
    expect(isDoneColumn('In Progress')).toBe(false);
    expect(isDoneColumn('Review')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isDoneColumn('done')).toBe(false);
    expect(isDoneColumn('DONE')).toBe(false);
  });

  it('returns true for board-level doneColumns', () => {
    const board = { doneColumns: ['Completed', 'Archived'] };
    expect(isDoneColumn('Completed', board)).toBe(true);
    expect(isDoneColumn('Archived', board)).toBe(true);
  });

  it('returns true for "Done" even without doneColumns', () => {
    const board = { doneColumns: ['Completed'] };
    expect(isDoneColumn('Done', board)).toBe(true);
  });

  it('returns false for unlisted columns with doneColumns set', () => {
    const board = { doneColumns: ['Completed'] };
    expect(isDoneColumn('Backlog', board)).toBe(false);
    expect(isDoneColumn('In Progress', board)).toBe(false);
  });

  it('handles empty doneColumns array', () => {
    const board = { doneColumns: [] as string[] };
    expect(isDoneColumn('Done', board)).toBe(true);
    expect(isDoneColumn('Backlog', board)).toBe(false);
  });

  it('handles undefined board', () => {
    expect(isDoneColumn('Done', undefined)).toBe(true);
    expect(isDoneColumn('Backlog', undefined)).toBe(false);
  });
});

describe('default board columns', () => {
  it('uses the first configured done column that exists on the board', () => {
    const board = {
      columns: ['Todo', 'Doing', 'Complete', 'Archived'],
      doneColumns: ['Complete', 'Archived'],
    };

    expect(getDefaultDoneColumn(board)).toBe('Complete');
  });

  it('falls back to literal Done when no configured done column exists', () => {
    const board = {
      columns: ['Backlog', 'In Progress', 'Done'],
      doneColumns: ['Complete'],
    };

    expect(getDefaultDoneColumn(board)).toBe('Done');
  });

  it('uses the first non-done column as the default open column', () => {
    const board = {
      columns: ['Complete', 'Todo', 'Doing'],
      doneColumns: ['Complete'],
    };

    expect(getDefaultOpenColumn(board)).toBe('Todo');
  });

  it('falls back to Backlog when no board columns are available', () => {
    expect(getDefaultOpenColumn(undefined)).toBe('Backlog');
  });
});
