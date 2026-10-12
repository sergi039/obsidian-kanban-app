/**
 * Columns the viewer collapsed to a narrow strip, remembered per board.
 *
 * Like Trello's collapsed lists this is a per-browser convenience: it never
 * reaches the API, the Markdown files or other viewers. Unreadable storage
 * means every column shows expanded.
 */

const STORAGE_KEY_PREFIX = 'kanban:collapsed-columns:';

export function collapsedColumnsKey(boardId: string): string {
  return `${STORAGE_KEY_PREFIX}${boardId}`;
}

export function loadCollapsedColumns(storage: Storage | undefined, boardId: string): Set<string> {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(collapsedColumnsKey(boardId));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
    return new Set();
  }
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((name): name is string => typeof name === 'string'));
  } catch {
    // A corrupted entry only costs the viewer their collapsed layout.
    return new Set();
  }
}

export function storeCollapsedColumns(
  storage: Storage | undefined,
  boardId: string,
  columns: Set<string>,
): void {
  try {
    if (columns.size === 0) storage?.removeItem(collapsedColumnsKey(boardId));
    else storage?.setItem(collapsedColumnsKey(boardId), JSON.stringify([...columns]));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

/** The collapsed set with `column` flipped; the input set is left untouched. */
export function toggleCollapsedColumn(columns: Set<string>, column: string): Set<string> {
  const next = new Set(columns);
  if (next.has(column)) next.delete(column);
  else next.add(column);
  return next;
}
