import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseMarkdownTasks, computeFingerprint, generateKbId, injectKbId } from './parser.js';
import { getDb } from './db.js';
import type { BoardConfig } from './config.js';
import { suppressWatcher, unsuppressWatcher } from './watcher.js';

export interface ReconcileResult {
  boardId: string;
  added: number;
  removed: number;
  updated: number;
  migrated: number; // cards that got kb:id markers stamped
}

/**
 * Reconcile a board: parse .md file, sync to SQLite sidecar.
 *
 * ID resolution order:
 * 1. If task has <!-- kb:id=xxx --> → use that as card ID
 * 2. If no kb:id → compute legacy fingerprint, check if existing card matches
 *    → if match found, adopt that card's ID and stamp kb:id into .md
 * 3. If no match → generate new kb:id, stamp into .md, create new card
 */
export function reconcileBoard(board: BoardConfig, vaultRoot: string): ReconcileResult {
  const filePath = path.join(vaultRoot, board.file);
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[reconciler] Cannot read file for board ${board.id}: ${filePath}`, err);
    return { boardId: board.id, added: 0, removed: 0, updated: 0, migrated: 0 };
  }
  const fileHash = createHash('sha256').update(content).digest('hex');

  const db = getDb();

  // Check if file changed
  const syncRow = db.prepare('SELECT file_hash FROM sync_state WHERE file_path = ?').get(filePath) as
    | { file_hash: string }
    | undefined;
  if (syncRow && syncRow.file_hash === fileHash) {
    return { boardId: board.id, added: 0, removed: 0, updated: 0, migrated: 0 };
  }

  const tasks = parseMarkdownTasks(content);

  const existingCards = db.prepare('SELECT * FROM cards WHERE board_id = ?').all(board.id) as Array<{
    id: string;
    column_name: string;
    is_done: number;
    position: number;
    labels: string;
    due_date: string | null;
    description: string | null;
    title: string;
  }>;
  const existingById = new Map(existingCards.map((c) => [c.id, c]));

  const seenIds = new Set<string>();
  let added = 0;
  let updated = 0;
  let migrated = 0;

  // Lines to update with kb:id markers (line index → new line content)
  const lineUpdates = new Map<number, string>();

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

  // For legacy fallback: track title occurrences for collision-safe fingerprinting
  const titleCounts = new Map<string, number>();

  const upsertAll = db.transaction(() => {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const srcFp = createHash('sha256').update(task.rawLine).digest('hex').slice(0, 16);

      let id: string;
      let needsMarkerStamp = false;

      if (task.kbId) {
        // ✅ Task already has a stable kb:id marker
        id = task.kbId;
      } else {
        // No kb:id — try legacy fingerprint match
        const titleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ') + '|' + board.id;
        const collisionIndex = titleCounts.get(titleKey) || 0;
        titleCounts.set(titleKey, collisionIndex + 1);
        const legacyId = computeFingerprint(task.title, board.id, collisionIndex);

        if (existingById.has(legacyId)) {
          // Found existing card by legacy ID — migrate it
          id = legacyId;
          needsMarkerStamp = true;
          migrated++;
        } else {
          // Completely new task — generate fresh kb:id
          id = generateKbId();
          needsMarkerStamp = true;
        }
      }

      seenIds.add(id);

      // Schedule line update to stamp kb:id marker
      if (needsMarkerStamp) {
        const updatedLine = injectKbId(task.rawLine, id);
        lineUpdates.set(task.lineNumber - 1, updatedLine); // 0-indexed
        // Update rawLine for DB storage
        task.rawLine = updatedLine;
      }

      const existing = existingById.get(id);

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
  });

  upsertAll();

  // Write kb:id markers to .md file (outside transaction)
  if (lineUpdates.size > 0) {
    suppressWatcher();
    try {
      // Re-read file to get latest content (may have changed during transaction)
      const freshContent = readFileSync(filePath, 'utf-8');
      const lines = freshContent.split('\n');

      for (const [lineIdx, newLine] of lineUpdates) {
        if (lineIdx >= 0 && lineIdx < lines.length) {
          lines[lineIdx] = newLine;
        }
      }

      const updatedContent = lines.join('\n');
      const updatedHash = createHash('sha256').update(updatedContent).digest('hex');

      // Atomic write
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, updatedContent, 'utf-8');
      renameSync(tmpPath, filePath);

      // Update sync state with new hash (so we don't re-reconcile our own changes)
      db.prepare(
        `INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`,
      ).run(filePath, updatedHash);

      console.log(`[reconciler] Stamped kb:id markers on ${lineUpdates.size} tasks in ${board.id}`);
    } catch (err) {
      console.error(`[reconciler] Failed to write kb:id markers for ${board.id}:`, err);
    } finally {
      unsuppressWatcher();
    }
  } else {
    // No line updates — just update sync state with original hash
    db.prepare(
      `INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`,
    ).run(filePath, fileHash);
  }

  const removed = existingCards.filter((c) => !seenIds.has(c.id)).length;
  return { boardId: board.id, added, removed, updated, migrated };
}

export function reconcileAll(vaultRoot: string, boards: BoardConfig[]): ReconcileResult[] {
  return boards.map((b) => reconcileBoard(b, vaultRoot));
}
