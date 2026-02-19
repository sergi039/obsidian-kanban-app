import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseMarkdownTasks, computeFingerprint, allocateUniqueKbId, injectKbId, isDoneColumn } from './parser.js';
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

  // Lines to update with kb:id markers (line index → { oldLine, newLine })
  const lineUpdates = new Map<number, { oldLine: string; newLine: string }>();

  // All IDs in DB for global collision check
  const allDbIds = new Set(
    (db.prepare('SELECT id FROM cards').all() as Array<{ id: string }>).map((r) => r.id),
  );

  const insertStmt = db.prepare(`
    INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, sub_items, source_fingerprint, seq_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Get next seq_id for this board
  const maxSeqRow = db.prepare('SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM cards WHERE board_id = ?').get(board.id) as { max_seq: number };
  let nextSeqId = maxSeqRow.max_seq;

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

      // Helper: check if ID is already used in this run or globally
      const isIdUsed = (candidate: string) => seenIds.has(candidate) || allDbIds.has(candidate);

      if (task.kbId) {
        if (seenIds.has(task.kbId)) {
          // Duplicate kb:id in same file (copy/paste) — regenerate
          console.warn(`[reconciler] Duplicate kb:id "${task.kbId}" in ${board.id}, regenerating`);
          id = allocateUniqueKbId(isIdUsed);
          needsMarkerStamp = true;
        } else if (allDbIds.has(task.kbId) && !existingById.has(task.kbId)) {
          // kb:id collides with a card in ANOTHER board — regenerate
          console.warn(`[reconciler] Cross-board kb:id collision "${task.kbId}" in ${board.id}, regenerating`);
          id = allocateUniqueKbId(isIdUsed);
          needsMarkerStamp = true;
        } else {
          // ✅ Task already has a unique stable kb:id marker
          id = task.kbId;
        }
      } else {
        // No kb:id — try legacy fingerprint match
        const titleKey = task.title.trim().toLowerCase().replace(/\s+/g, ' ') + '|' + board.id;
        const collisionIndex = titleCounts.get(titleKey) || 0;
        titleCounts.set(titleKey, collisionIndex + 1);
        const legacyId = computeFingerprint(task.title, board.id, collisionIndex);

        if (existingById.has(legacyId) && !seenIds.has(legacyId)) {
          // Found existing card by legacy ID — migrate it
          id = legacyId;
          needsMarkerStamp = true;
          migrated++;
        } else {
          // Completely new task — generate fresh unique kb:id
          id = allocateUniqueKbId(isIdUsed);
          needsMarkerStamp = true;
        }
      }

      seenIds.add(id);
      allDbIds.add(id); // Prevent cross-board collisions within same boot

      // Schedule line update to stamp kb:id marker (store old line for safe matching)
      if (needsMarkerStamp) {
        const updatedLine = injectKbId(task.rawLine, id);
        lineUpdates.set(task.lineNumber - 1, { oldLine: task.rawLine, newLine: updatedLine });
        task.rawLine = updatedLine;
      }

      const existing = existingById.get(id);

      if (existing) {
        let col = existing.column_name;
        if (task.isDone && !existing.is_done) {
          col = 'Done';
        } else if (!task.isDone && existing.is_done && isDoneColumn(existing.column_name, board)) {
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
        // Use kb:col from .md marker if available, otherwise default by done state
        // Validate kb:col is a known column; fall back to Done/Backlog if not
        let col = task.kbCol && board.columns.includes(task.kbCol) ? task.kbCol : null;
        if (!col) col = task.isDone ? 'Done' : 'Backlog';
        nextSeqId++;
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
          nextSeqId,
        );
        added++;
      }
    }

    // Remove cards no longer in file — with safety guard
    const toRemove = existingCards.filter((c) => !seenIds.has(c.id)).map((c) => c.id);
    if (toRemove.length > 0) {
      // Safety: if ALL existing cards would be deleted and we found 0 tasks,
      // something is wrong (empty/truncated file read). Abort deletion.
      if (toRemove.length === existingCards.length && tasks.length === 0) {
        console.error(`[reconciler] 🛡️ SAFETY: Refusing to delete all ${toRemove.length} cards from ${board.id} — file appears empty/corrupt`);
      } else if (toRemove.length >= existingCards.length * 0.8 && existingCards.length >= 5) {
        // Also guard against losing >80% of cards at once (likely a bug, not intentional)
        console.warn(`[reconciler] ⚠️ SAFETY: Would delete ${toRemove.length}/${existingCards.length} cards from ${board.id} — skipping bulk delete. Manual reconcile needed.`);
      } else {
        const ph = toRemove.map(() => '?').join(',');
        db.prepare(`DELETE FROM cards WHERE id IN (${ph})`).run(...toRemove);
      }
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
      let stamped = 0;

      for (const [lineIdx, { oldLine, newLine }] of lineUpdates) {
        // Safety: verify the line at this index matches what we parsed
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx] === oldLine) {
          lines[lineIdx] = newLine;
          stamped++;
        } else {
          // Line shifted or changed — search entire file for exact match
          const foundIdx = lines.findIndex((l) => l === oldLine);
          if (foundIdx !== -1) {
            lines[foundIdx] = newLine;
            stamped++;
          } else {
            console.warn(`[reconciler] Skipped unsafe stamp for line ${lineIdx + 1} in ${board.id} — line not found`);
          }
        }
      }

      if (stamped === 0) {
        console.warn(`[reconciler] No lines stamped in ${board.id}, skipping file write`);
        // Still record sync state so we don't re-reconcile
        db.prepare(
          `INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`,
        ).run(filePath, fileHash);
      } else {
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

        console.log(`[reconciler] Stamped ${stamped}/${lineUpdates.size} kb:id markers in ${board.id}`);
      }
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
