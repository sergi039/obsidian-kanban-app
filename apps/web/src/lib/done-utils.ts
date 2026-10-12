/**
 * Column targets for the card "done" checkbox.
 *
 * The API marks a card done when it moves into the literal `Done` column
 * (see `isDoneColumn` in apps/api/src/parser.ts), so that is the only
 * column the checkbox can close a card into. A board without it gets no
 * done target and the checkbox is disabled instead of guessing.
 */

export const DONE_COLUMN = 'Done';
const PREFERRED_OPEN_COLUMN = 'Backlog';

export function doneTargetColumn(columns: string[]): string | null {
  return columns.includes(DONE_COLUMN) ? DONE_COLUMN : null;
}

/** Column a card returns to when it is unchecked: Backlog, else the first non-Done column. */
export function openTargetColumn(columns: string[]): string | null {
  if (columns.includes(PREFERRED_OPEN_COLUMN)) return PREFERRED_OPEN_COLUMN;
  return columns.find((col) => col !== DONE_COLUMN) ?? null;
}

/** Column to move a card into when its done checkbox is toggled, or null if the board has none. */
export function toggleDoneTargetColumn(isDone: boolean, columns: string[]): string | null {
  return isDone ? openTargetColumn(columns) : doneTargetColumn(columns);
}
