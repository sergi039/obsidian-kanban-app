/**
 * How many Done cards the board shows before "Show more".
 *
 * `auto` shows the whole column, as tall as the window and scrolling inside;
 * a number shows that many cards from the top (the newest closed ones) and
 * hides the rest behind "Show more". A per-browser choice, like collapsed
 * columns; unreadable storage means `auto`.
 */

export const DONE_PAGE_SIZES = [5, 10, 20] as const;
export type DonePageSize = 'auto' | (typeof DONE_PAGE_SIZES)[number];

export const DONE_PAGE_SIZE_STORAGE_KEY = 'kanban:done-page-size';

export function parseDonePageSize(raw: string | null | undefined): DonePageSize {
  const size = DONE_PAGE_SIZES.find((candidate) => String(candidate) === raw);
  return size ?? 'auto';
}

export function loadDonePageSize(storage: Storage | undefined): DonePageSize {
  try {
    return parseDonePageSize(storage?.getItem(DONE_PAGE_SIZE_STORAGE_KEY));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
    return 'auto';
  }
}

export function storeDonePageSize(storage: Storage | undefined, size: DonePageSize): void {
  try {
    if (size === 'auto') storage?.removeItem(DONE_PAGE_SIZE_STORAGE_KEY);
    else storage?.setItem(DONE_PAGE_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}
