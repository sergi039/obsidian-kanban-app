export const ACTIVE_BOARD_STORAGE_KEY = 'kanban:active-board';

const DEEP_LINK_PARAMS = ['board', 'card'] as const;

/**
 * Board to open on load: a `?board=` deep link wins, then the board the viewer
 * last had open, then the first board. Ids that no longer exist are skipped.
 */
export function pickInitialBoard(
  boardIds: string[],
  urlBoard: string | null,
  storedBoard: string | null,
): string | null {
  for (const candidate of [urlBoard, storedBoard]) {
    if (candidate && boardIds.includes(candidate)) return candidate;
  }
  return boardIds[0] ?? null;
}

export function loadActiveBoard(storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(ACTIVE_BOARD_STORAGE_KEY) ?? null;
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
    return null;
  }
}

export function storeActiveBoard(storage: Storage | undefined, boardId: string): void {
  try {
    storage?.setItem(ACTIVE_BOARD_STORAGE_KEY, boardId);
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

/**
 * Drop `?board=`/`?card=` once the viewer switches boards, so a reload opens
 * the board they switched to instead of replaying the original deep link.
 */
export function dropDeepLinkParams(win: Window): void {
  const url = new URL(win.location.href);
  if (!DEEP_LINK_PARAMS.some((param) => url.searchParams.has(param))) return;
  for (const param of DEEP_LINK_PARAMS) url.searchParams.delete(param);
  win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
