/**
 * Write-back: update the source .md file when a card is moved to Done (or un-done).
 * Line-preserving: only changes the specific line, preserves everything else.
 * Validates line identity before modifying to prevent wrong-task toggle.
 * Uses atomic write (write to temp, rename) to prevent data loss.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { suppressWatcher, unsuppressWatcher } from './watcher.js';
import { DEFAULT_PRIORITIES, loadConfig } from './config.js';
import { getDb } from './db.js';
import { extractKbId, injectKbCol } from './parser.js';

export interface WriteBackResult {
  success: boolean;
  changed: boolean;
  lineNumber: number;
  error?: string;
}

const CHECKBOX_RE = /^(\s*- \[)([ xX])(\] .*)$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize a line for fuzzy matching: strip whitespace, checkbox state, and case.
 */
function normalizeForMatch(line: string): string {
  return line.trim().replace(/^- \[[ xX]\]\s*/, '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Toggle done state in the source .md file for a given card.
 * Validates that the line content matches before modifying.
 * Uses atomic write to prevent corruption.
 */
export function writeBackDoneState(
  cardId: string,
  isDone: boolean,
): WriteBackResult {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as
    | { board_id: string; line_number: number; raw_line: string; is_done: number; title: string }
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
    const checkboxMatch = line.match(CHECKBOX_RE);
    if (!checkboxMatch) {
      return { success: false, changed: false, lineNumber: card.line_number, error: 'Line is not a checkbox' };
    }

    // Validate line identity: first try kb:id match, then normalized content
    const fileKbId = extractKbId(line);
    const cardKbId = extractKbId(card.raw_line);
    const identityMatch = (fileKbId && cardKbId && fileKbId === cardKbId) ||
      normalizeForMatch(line) === normalizeForMatch(card.raw_line);

    if (!identityMatch) {
      // Lines shifted — try to find the correct line (search entire file, prefer kb:id match)
      let found = -1;

      // First pass: find by kb:id (most reliable)
      if (cardKbId) {
        for (let si = 0; si < lines.length; si++) {
          if (si === lineIdx) continue;
          const lkb = extractKbId(lines[si]);
          if (lkb === cardKbId) { found = si; break; }
        }
      }

      // Second pass: find by normalized content nearby (±5 lines)
      if (found === -1) {
        const cardLineNorm = normalizeForMatch(card.raw_line);
        for (let offset = -5; offset <= 5; offset++) {
          const searchIdx = lineIdx + offset;
          if (searchIdx < 0 || searchIdx >= lines.length || searchIdx === lineIdx) continue;
          if (normalizeForMatch(lines[searchIdx]) === cardLineNorm) {
            found = searchIdx;
            break;
          }
        }
      }

      if (found === -1) {
        return {
          success: false,
          changed: false,
          lineNumber: card.line_number,
          error: `Line content mismatch: expected "${normalizeForMatch(card.raw_line).slice(0, 40)}…" but found "${normalizeForMatch(line).slice(0, 40)}…"`,
        };
      }

      // Use the found line instead
      const foundMatch = lines[found].match(CHECKBOX_RE);
      if (!foundMatch) {
        return { success: false, changed: false, lineNumber: found + 1, error: 'Found line is not a checkbox' };
      }

      const foundDone = foundMatch[2].toLowerCase() === 'x';
      if (foundDone === isDone) {
        return { success: true, changed: false, lineNumber: found + 1 };
      }

      lines[found] = `${foundMatch[1]}${isDone ? 'x' : ' '}${foundMatch[3]}`;
      atomicWrite(filePath, lines.join('\n'));

      // Update line_number in DB
      db.prepare('UPDATE cards SET line_number = ? WHERE id = ?').run(found + 1, cardId);

      return { success: true, changed: true, lineNumber: found + 1 };
    }

    const currentlyDone = checkboxMatch[2].toLowerCase() === 'x';
    if (currentlyDone === isDone) {
      return { success: true, changed: false, lineNumber: card.line_number };
    }

    // Replace checkbox state
    const newMark = isDone ? 'x' : ' ';
    lines[lineIdx] = `${checkboxMatch[1]}${newMark}${checkboxMatch[3]}`;

    atomicWrite(filePath, lines.join('\n'));

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
 * Write-back priority emoji to .md file.
 * Adds, removes, or changes configured priority emoji in the task line.
 */
export function writeBackPriority(
  cardId: string,
  priority: string | null,
): WriteBackResult {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as
    | { board_id: string; line_number: number; raw_line: string; title: string }
    | undefined;

  if (!card) {
    return { success: false, changed: false, lineNumber: 0, error: 'Card not found' };
  }

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === card.board_id);
  if (!board) {
    return { success: false, changed: false, lineNumber: card.line_number, error: 'Board config not found' };
  }

  const priorityDefs = board.priorities ?? DEFAULT_PRIORITIES;
  const emojiByPriorityId = new Map(priorityDefs.map((p) => [p.id, p.emoji]));
  const priorityEmojis = Array.from(new Set(priorityDefs.map((p) => p.emoji)));
  if (priority !== null && !emojiByPriorityId.has(priority)) {
    return {
      success: false,
      changed: false,
      lineNumber: card.line_number,
      error: `Unknown priority "${priority}" for board "${board.id}"`,
    };
  }

  const filePath = path.join(config.vaultRoot, board.file);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Find the correct line (by kb:id)
    const cardKbId = extractKbId(card.raw_line);
    let lineIdx = card.line_number - 1;

    // Verify or find correct line
    if (cardKbId) {
      const fileKbId = lineIdx >= 0 && lineIdx < lines.length ? extractKbId(lines[lineIdx]) : null;
      if (fileKbId !== cardKbId) {
        // Search for it
        const found = lines.findIndex((l) => extractKbId(l) === cardKbId);
        if (found === -1) {
          return { success: false, changed: false, lineNumber: card.line_number, error: 'Line not found by kb:id' };
        }
        lineIdx = found;
      }
    }

    if (lineIdx < 0 || lineIdx >= lines.length) {
      return { success: false, changed: false, lineNumber: card.line_number, error: 'Line number out of range' };
    }

    const originalLine = lines[lineIdx];
    const checkboxMatch = originalLine.match(/^(\s*- \[[ xX]\]\s*)(.*)$/);
    if (!checkboxMatch) {
      return { success: false, changed: false, lineNumber: lineIdx + 1, error: 'Line is not a checkbox task' };
    }

    const prefix = checkboxMatch[1];
    let tail = checkboxMatch[2];

    // Remove all configured priority emojis from task tail
    for (const emoji of priorityEmojis) {
      tail = tail.replace(new RegExp(`\\s*${escapeRegExp(emoji)}\\s*`, 'g'), ' ');
    }
    tail = tail.replace(/\s+/g, ' ').trim();

    // Add new configured emoji (after checkbox, before title text)
    if (priority !== null) {
      const emoji = emojiByPriorityId.get(priority)!;
      tail = tail.length > 0 ? `${emoji} ${tail}` : emoji;
    }

    const line = `${prefix}${tail}`;
    if (line === originalLine) {
      return { success: true, changed: false, lineNumber: lineIdx + 1 };
    }

    lines[lineIdx] = line;
    atomicWrite(filePath, lines.join('\n'));

    // Update raw_line and line_number in DB
    db.prepare('UPDATE cards SET raw_line = ?, line_number = ? WHERE id = ?').run(line, lineIdx + 1, cardId);

    console.log(`[writeback] Card ${cardId} priority → ${priority ?? 'none'} at line ${lineIdx + 1}`);
    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return { success: false, changed: false, lineNumber: card.line_number, error: String(err) };
  }
}

/**
 * Write-back column name to .md file marker.
 * Updates <!-- kb:id=xxx --> to <!-- kb:id=xxx kb:col=ColName -->.
 * This enables recovery: if DB is lost, reconciler reads kb:col from .md.
 */
export function writeBackColumn(
  cardId: string,
  column: string,
): WriteBackResult {
  const db = getDb();
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as
    | { board_id: string; line_number: number; raw_line: string }
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

    // Find the correct line by kb:id
    const cardKbId = extractKbId(card.raw_line);
    if (!cardKbId) {
      return { success: false, changed: false, lineNumber: card.line_number, error: 'Card has no kb:id marker' };
    }

    let lineIdx = card.line_number - 1;
    const fileKbId = lineIdx >= 0 && lineIdx < lines.length ? extractKbId(lines[lineIdx]) : null;
    if (fileKbId !== cardKbId) {
      const found = lines.findIndex((l) => extractKbId(l) === cardKbId);
      if (found === -1) {
        return { success: false, changed: false, lineNumber: card.line_number, error: 'Line not found by kb:id' };
      }
      lineIdx = found;
    }

    const updatedLine = injectKbCol(lines[lineIdx], column);
    if (updatedLine === lines[lineIdx]) {
      return { success: true, changed: false, lineNumber: lineIdx + 1 };
    }

    lines[lineIdx] = updatedLine;
    atomicWrite(filePath, lines.join('\n'));

    // Update raw_line in DB to keep in sync
    db.prepare('UPDATE cards SET raw_line = ?, line_number = ? WHERE id = ?').run(updatedLine, lineIdx + 1, cardId);

    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return { success: false, changed: false, lineNumber: card.line_number, error: String(err) };
  }
}

/**
 * Stamp current column assignments from DB into all .md files.
 * Called on startup to ensure .md files have kb:col markers.
 * Returns number of lines updated.
 */
export function stampAllColumns(): number {
  const db = getDb();
  const config = loadConfig();
  let totalStamped = 0;

  for (const board of config.boards) {
    const filePath = path.join(config.vaultRoot, board.file);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const cards = db.prepare('SELECT id, column_name, raw_line, line_number FROM cards WHERE board_id = ?').all(board.id) as Array<{
      id: string; column_name: string; raw_line: string; line_number: number;
    }>;

    if (cards.length === 0) continue;

    const lines = content.split('\n');
    let changed = false;

    for (const card of cards) {
      const cardKbId = extractKbId(card.raw_line);
      if (!cardKbId) continue;

      // Find line by kb:id
      let lineIdx = card.line_number - 1;
      const fileKbId = lineIdx >= 0 && lineIdx < lines.length ? extractKbId(lines[lineIdx]) : null;
      if (fileKbId !== cardKbId) {
        lineIdx = lines.findIndex((l) => extractKbId(l) === cardKbId);
        if (lineIdx === -1) continue;
      }

      const updatedLine = injectKbCol(lines[lineIdx], card.column_name);
      if (updatedLine !== lines[lineIdx]) {
        lines[lineIdx] = updatedLine;
        changed = true;
        totalStamped++;

        // Update raw_line in DB
        db.prepare('UPDATE cards SET raw_line = ?, line_number = ? WHERE id = ?').run(updatedLine, lineIdx + 1, card.id);
      }
    }

    if (changed) {
      suppressWatcher();
      try {
        atomicWrite(filePath, lines.join('\n'));
        const newHash = createHash('sha256').update(lines.join('\n')).digest('hex');
        db.prepare(`INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`).run(filePath, newHash);
      } finally {
        unsuppressWatcher();
      }
    }
  }

  return totalStamped;
}

/**
 * Atomic write: write to temp file, then rename (prevents corruption on crash).
 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
