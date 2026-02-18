import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseMarkdownTasks, computeFingerprint } from './parser.js';
import { getDb } from './db.js';
import type { BoardConfig } from './config.js';

export interface ReconcileResult {
  boardId: string;
  added: number;
  removed: number;
  updated: number;
}

export function reconcileBoard(board: BoardConfig, vaultRoot: string): ReconcileResult {
  const filePath = path.join(vaultRoot, board.file);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[reconciler] Cannot read file for board ${board.id}: ${filePath}`, err);
    return { boardId: board.id, added: 0, removed: 0, updated: 0 };
  }
  const fileHash = createHash('sha256').update(content).digest('hex');

  const db = getDb();

  // Check if file changed
  const syncRow = db.prepare('SELECT file_hash FROM sync_state WHERE file_path = ?').get(filePath) as
    | { file_hash: string }
    | undefined;
  if (syncRow && syncRow.file_hash === fileHash) {
    return { boardId: board.id, added: 0, removed: 0, updated: 0 };
  }

  const tasks = parseMarkdownTasks(content);

  const existingCards = db.prepare('SELECT * FROM cards WHERE board_id = ?').all(board.id) as Array<{
    id: string;
    column_name: string;
    is_done: number;
    position: number;
    labels: string;
    due_date: string | null;
  }>;
  const existingMap = new Map(existingCards.map((c) => [c.id, c]));

  const seenIds = new Set<string>();
  let added = 0;
  let updated = 0;

  const insertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, sub_items, source_fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE cards SET
      title = ?, raw_line = ?, line_number = ?, is_done = ?,
      priority = ?, sub_items = ?, source_fingerprint = ?,
      column_name = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  // Track title occurrences for collision-safe fingerprinting
  const titleCounts = new Map<string, number>();

  const upsertAll = db.transaction(() => {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const titleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ') + '|' + board.id;
      const collisionIndex = titleCounts.get(titleKey) || 0;
      titleCounts.set(titleKey, collisionIndex + 1);
      const id = computeFingerprint(task.title, board.id, collisionIndex);
      seenIds.add(id);

      const srcFp = createHash('sha256').update(task.rawLine).digest('hex').slice(0, 16);
      const existing = existingMap.get(id);

      if (existing) {
        let col = existing.column_name;
        if (task.isDone && !existing.is_done) {
          col = 'Done';
        } else if (!task.isDone && existing.is_done && existing.column_name === 'Done') {
          col = 'Backlog';
        }

        updateStmt.run(
          task.title,
          task.rawLine,
          task.lineNumber,
          task.isDone ? 1 : 0,
          task.priority,
          JSON.stringify(task.subItems),
          srcFp,
          col,
          id,
        );
        updated++;
      } else {
        const col = task.isDone ? 'Done' : 'Backlog';
        insertStmt.run(
          id,
          board.id,
          col,
          i,
          task.title,
          task.rawLine,
          task.lineNumber,
          task.isDone ? 1 : 0,
          task.priority,
          JSON.stringify(task.subItems),
          srcFp,
        );
        added++;
      }
    }

    // Remove cards no longer in file
    const toRemove = existingCards.filter((c) => !seenIds.has(c.id)).map((c) => c.id);
    if (toRemove.length > 0) {
      const ph = toRemove.map(() => '?').join(',');
      db.prepare(`DELETE FROM cards WHERE id IN (${ph})`).run(...toRemove);
    }

    // Update sync state
    db.prepare(
      `INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`,
    ).run(filePath, fileHash);
  });

  upsertAll();

  const removed = existingCards.filter((c) => !seenIds.has(c.id)).length;
  return { boardId: board.id, added, removed, updated };
}

export function reconcileAll(vaultRoot: string, boards: BoardConfig[]): ReconcileResult[] {
  return boards.map((b) => reconcileBoard(b, vaultRoot));
}
