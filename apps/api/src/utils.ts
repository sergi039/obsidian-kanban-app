import type { CalendarEvent } from './calendar-events.js';

/**
 * Shared utility functions used across route handlers and modules.
 */
import type Database from 'better-sqlite3';

/** Type-safe JSON parse with fallback — never throws */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Normalize a DB card row into API response format */
export function formatCard(row: Record<string, unknown>) {
  // Trash restore bookkeeping stays server-side; deleted_at is exposed.
  const { trashed_lines: _lines, trashed_after: _after, ...card } = row;
  return {
    ...card,
    is_done: Boolean(row.is_done),
    labels: safeJsonParse<string[]>(row.labels as string, []),
    sub_items: safeJsonParse<string[]>(row.sub_items as string, []),
    checklist: safeJsonParse<{id:string;title:string;done:boolean}[]>(row.checklist as string, []),
    links: safeJsonParse<{url:string;title:string}[]>(row.links as string, []),
    calendar_events: safeJsonParse<CalendarEvent[]>(row.calendar_events as string, []),
    source_meta: safeJsonParse<Record<string, unknown>>(row.source_meta as string, {}),
  };
}

/**
 * Normalize positions of the live (not trashed) cards in a column to 0..N-1.
 * Called after moves, trash, and restore to ensure no gaps.
 */
export function normalizePositions(db: Database.Database, boardId: string, column: string): void {
  const rows = db
    .prepare('SELECT id FROM cards WHERE board_id = ? AND column_name = ? AND deleted_at IS NULL ORDER BY position')
    .all(boardId, column) as Array<{ id: string }>;
  const stmt = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
  for (let i = 0; i < rows.length; i++) {
    stmt.run(i, rows[i].id);
  }
}
