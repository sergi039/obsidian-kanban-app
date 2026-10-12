/**
 * Card trash.
 *
 * Trashing removes the card's task block (task line + sub-item lines) from the
 * board's .md file and marks the card row with deleted_at. The row keeps its
 * comments, field values, and reminders, and stores the removed lines so that
 * restore puts back exactly what was there, after the same preceding task.
 *
 * The DB update and the file write run inside one SQLite transaction with the
 * file write last (after the sync_state hash, which is computed from the new
 * content): any failure before it rolls the DB back with the file untouched,
 * so the file and the DB never disagree about whether the card is live.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { loadConfig, type BoardConfig } from './config.js';
import {
  extractKbId,
  getDefaultDoneColumn,
  getDefaultOpenColumn,
  injectKbCol,
  isTaskLine,
  taskBlockEnd,
} from './parser.js';
import { atomicWrite, updateSyncStateHash } from './writeback.js';
import { suppressWatcher, unsuppressWatcher } from './watcher.js';
import { normalizePositions, safeJsonParse } from './utils.js';

export class TrashError extends Error {
  constructor(
    message: string,
    public status: 404 | 409 | 500,
  ) {
    super(message);
  }
}

interface CardRow {
  id: string;
  board_id: string;
  column_name: string;
  raw_line: string;
  line_number: number;
  is_done: number;
  deleted_at: string | null;
  trashed_lines: string | null;
  trashed_after: string | null;
}

function loadCard(cardId: string): CardRow {
  const card = getDb().prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as CardRow | undefined;
  if (!card) throw new TrashError('Card not found', 404);
  return card;
}

function resolveBoard(boardId: string): { board: BoardConfig; filePath: string } {
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) throw new TrashError(`Board "${boardId}" not found`, 404);
  return { board, filePath: path.join(config.vaultRoot, board.file) };
}

function requireKbId(card: CardRow): string {
  const kbId = extractKbId(card.raw_line);
  if (!kbId) throw new TrashError('Card has no kb:id marker; run Sync and retry', 409);
  return kbId;
}

/** Find a task line by kb:id, checking the recorded line number first. */
function findKbLine(lines: string[], kbId: string, lineNumber: number): number {
  const hinted = lineNumber - 1;
  if (hinted >= 0 && hinted < lines.length && extractKbId(lines[hinted]) === kbId) return hinted;
  return lines.findIndex((line) => extractKbId(line) === kbId);
}

/** kb:id of the nearest task above `idx`, or null when the task is the first one. */
function precedingTaskKbId(lines: string[], idx: number): string | null {
  for (let i = idx - 1; i >= 0; i--) {
    if (!isTaskLine(lines[i])) continue;
    const kbId = extractKbId(lines[i]);
    if (kbId) return kbId;
  }
  return null;
}

/**
 * Where restored lines go: after the block of the task that preceded the card
 * when it was trashed; before the first task when the card was the first one;
 * after the last task block when the anchor task no longer exists.
 */
function restoreIndex(lines: string[], anchorKbId: string | null): number {
  if (anchorKbId) {
    const anchorIdx = lines.findIndex((line) => isTaskLine(line) && extractKbId(line) === anchorKbId);
    if (anchorIdx !== -1) return taskBlockEnd(lines, anchorIdx);
  }
  const taskIdxs = lines.flatMap((line, i) => (isTaskLine(line) ? [i] : []));
  if (taskIdxs.length === 0) {
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  }
  return anchorKbId === null ? taskIdxs[0] : taskBlockEnd(lines, taskIdxs[taskIdxs.length - 1]);
}

/** Must be the last step of the enclosing transaction: nothing after it may throw. */
function writeBoardFile(filePath: string, content: string): void {
  suppressWatcher();
  try {
    updateSyncStateHash(filePath, content);
    atomicWrite(filePath, content);
  } finally {
    unsuppressWatcher();
  }
}

/** Move a live card to the trash. Returns the updated card row. */
export function trashCard(cardId: string): Record<string, unknown> {
  const db = getDb();
  const card = loadCard(cardId);
  if (card.deleted_at) throw new TrashError('Card is already in trash', 409);
  const { filePath } = resolveBoard(card.board_id);
  const kbId = requireKbId(card);

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const start = findKbLine(lines, kbId, card.line_number);
  if (start === -1) {
    throw new TrashError('Card line not found in the Markdown file; run Sync and retry', 409);
  }
  const end = taskBlockEnd(lines, start);
  const removed = lines.slice(start, end);
  const anchor = precedingTaskKbId(lines, start);
  lines.splice(start, end - start);

  db.transaction(() => {
    db.prepare(`
      UPDATE cards
      SET deleted_at = ?, trashed_lines = ?, trashed_after = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(new Date().toISOString(), JSON.stringify(removed), anchor, cardId);
    normalizePositions(db, card.board_id, card.column_name);
    writeBoardFile(filePath, lines.join('\n'));
  })();

  console.log(`[trash] Card ${cardId} moved to trash (${removed.length} line(s) removed from ${card.board_id})`);
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
}

/** Restore a trashed card into its board file and column. Returns the updated card row. */
export function restoreCard(cardId: string): Record<string, unknown> {
  const db = getDb();
  const card = loadCard(cardId);
  if (!card.deleted_at) throw new TrashError('Card is not in trash', 409);
  const { board, filePath } = resolveBoard(card.board_id);
  const kbId = requireKbId(card);

  const column = board.columns.includes(card.column_name)
    ? card.column_name
    : card.is_done ? getDefaultDoneColumn(board) : getDefaultOpenColumn(board);

  const lines = readFileSync(filePath, 'utf-8').split('\n');
  let lineIdx = lines.findIndex((line) => extractKbId(line) === kbId);
  const inserting = lineIdx === -1;
  let fileChanged = inserting;
  if (inserting) {
    const stored = safeJsonParse<string[]>(card.trashed_lines, []);
    if (!Array.isArray(stored) || stored.length === 0 || extractKbId(stored[0]) !== kbId) {
      throw new TrashError('Trashed card has no stored Markdown lines to restore', 500);
    }
    lineIdx = restoreIndex(lines, card.trashed_after);
    lines.splice(lineIdx, 0, injectKbCol(stored[0], column), ...stored.slice(1));
  } else {
    // The line came back before the reconciler saw it; its kb:col may predate a column rename.
    const stamped = injectKbCol(lines[lineIdx], column);
    fileChanged = stamped !== lines[lineIdx];
    lines[lineIdx] = stamped;
  }

  db.transaction(() => {
    const maxPos = (db
      .prepare('SELECT MAX(position) AS mp FROM cards WHERE board_id = ? AND column_name = ? AND deleted_at IS NULL')
      .get(card.board_id, column) as { mp: number | null }).mp;
    db.prepare(`
      UPDATE cards
      SET deleted_at = NULL, trashed_lines = NULL, trashed_after = NULL,
          column_name = ?, position = ?, raw_line = ?, line_number = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(column, (maxPos ?? -1) + 1, lines[lineIdx], lineIdx + 1, cardId);
    if (fileChanged) writeBoardFile(filePath, lines.join('\n'));
  })();

  console.log(`[trash] Card ${cardId} restored to ${card.board_id}/${column} at line ${lineIdx + 1}`);
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
}

/** Trashed cards of a board, most recently trashed first. */
export function listTrash(boardId: string): Array<Record<string, unknown>> {
  return getDb()
    .prepare('SELECT * FROM cards WHERE board_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
    .all(boardId) as Array<Record<string, unknown>>;
}
