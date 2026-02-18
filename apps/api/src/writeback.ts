/**
 * Write-back: update the source .md file when a card is moved to Done (or un-done).
 * Line-preserving: only changes the specific line, preserves everything else.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getDb } from './db.js';

export interface WriteBackResult {
  success: boolean;
  changed: boolean;
  lineNumber: number;
  error?: string;
}

/**
 * Toggle done state in the source .md file for a given card.
 * Only modifies the exact line, preserving all other content.
 */
export function writeBackDoneState(
  cardId: string,
  isDone: boolean,
): WriteBackResult {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as
    | { board_id: string; line_number: number; raw_line: string; is_done: number }
    | undefined;

  if (!card) {
    return { success: false, changed: false, lineNumber: 0, error: 'Card not found' };
  }

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === card.board_id);
  if (!board) {
    return { success: false, changed: false, lineNumber: card.line_number, error: 'Board config not found' };
  }

  const filePath = path.join(config.vaultRoot, board.file);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const lineIdx = card.line_number - 1; // 1-indexed → 0-indexed

    if (lineIdx < 0 || lineIdx >= lines.length) {
      return { success: false, changed: false, lineNumber: card.line_number, error: 'Line number out of range' };
    }

    const line = lines[lineIdx];

    // Verify this is actually a checkbox line
    const checkboxMatch = line.match(/^(\s*- \[)([ xX])(\] .*)$/);
    if (!checkboxMatch) {
      return { success: false, changed: false, lineNumber: card.line_number, error: 'Line is not a checkbox' };
    }

    const currentlyDone = checkboxMatch[2].toLowerCase() === 'x';
    if (currentlyDone === isDone) {
      // Already in the desired state
      return { success: true, changed: false, lineNumber: card.line_number };
    }

    // Replace checkbox state
    const newMark = isDone ? 'x' : ' ';
    lines[lineIdx] = `${checkboxMatch[1]}${newMark}${checkboxMatch[3]}`;

    writeFileSync(filePath, lines.join('\n'), 'utf-8');

    return { success: true, changed: true, lineNumber: card.line_number };
  } catch (err) {
    return {
      success: false,
      changed: false,
      lineNumber: card.line_number,
      error: String(err),
    };
  }
}

/**
 * Check if a file was modified externally since our last known sync.
 * Returns true if there might be a conflict.
 */
export function checkConflict(filePath: string): boolean {
  const db = getDb();
  const syncRow = db
    .prepare('SELECT file_hash FROM sync_state WHERE file_path = ?')
    .get(filePath) as { file_hash: string } | undefined;

  if (!syncRow) return false;

  try {
    const content = readFileSync(filePath, 'utf-8');
    const { createHash } = require('node:crypto');
    const currentHash = createHash('sha256').update(content).digest('hex');
    return currentHash !== syncRow.file_hash;
  } catch {
    return true;
  }
}
