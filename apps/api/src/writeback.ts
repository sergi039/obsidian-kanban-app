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
import { extractKbId, injectKbCol, extractTaskLinks } from './parser.js';

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
 * Update sync_state.file_hash for a file after a write-back modifies it.
 * Hashes the exact bytes written so the value matches what reconciler computes
 * (createHash('sha256').update(content)), preventing a redundant re-reconcile of
 * our own change. `content` MUST be the post-write file content.
 */
export function updateSyncStateHash(filePath: string, content: string): void {
  const hash = createHash('sha256').update(content).digest('hex');
  getDb()
    .prepare(`INSERT OR REPLACE INTO sync_state (file_path, file_hash, last_synced) VALUES (?, ?, datetime('now'))`)
    .run(filePath, hash);
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
    const lineIdx = locateDoneStateLine(lines, card.line_number - 1, card.raw_line);
    if (typeof lineIdx === 'string') {
      return { success: false, changed: false, lineNumber: card.line_number, error: lineIdx };
    }

    const checkboxMatch = lines[lineIdx].match(CHECKBOX_RE);
    if (!checkboxMatch) {
      return { success: false, changed: false, lineNumber: lineIdx + 1, error: 'Line is not a checkbox' };
    }

    const currentlyDone = checkboxMatch[2].toLowerCase() === 'x';
    if (currentlyDone === isDone) {
      return { success: true, changed: false, lineNumber: lineIdx + 1 };
    }

    lines[lineIdx] = `${checkboxMatch[1]}${isDone ? 'x' : ' '}${checkboxMatch[3]}`;
    const updatedContent = lines.join('\n');
    atomicWrite(filePath, updatedContent);
    updateSyncStateHash(filePath, updatedContent);

    if (lineIdx + 1 !== card.line_number) {
      db.prepare('UPDATE cards SET line_number = ? WHERE id = ?').run(lineIdx + 1, cardId);
    }

    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return fileFailure(cardId, card.line_number, err);
  }
}

/**
 * Find the line a done-state write-back may toggle (0-based), or an error message.
 *
 * A card with a kb:id is matched by kb:id only: its recorded line first, else
 * anywhere in the file. A card without one may only toggle its recorded line,
 * and only while that line still reads the same: searching nearby lines by
 * text toggled the wrong task when two tasks shared a title.
 */
function locateDoneStateLine(lines: string[], recordedIdx: number, rawLine: string): number | string {
  const cardKbId = extractKbId(rawLine);
  const inRange = recordedIdx >= 0 && recordedIdx < lines.length;

  if (cardKbId) {
    if (inRange && extractKbId(lines[recordedIdx]) === cardKbId) return recordedIdx;
    const found = lines.findIndex((l) => extractKbId(l) === cardKbId);
    return found === -1 ? 'Line not found by kb:id' : found;
  }

  if (!inRange) return 'Line number out of range';
  if (normalizeForMatch(lines[recordedIdx]) !== normalizeForMatch(rawLine)) {
    return 'Line changed since the last sync and the card has no kb:id';
  }
  return recordedIdx;
}

/**
 * A read/write of the board file threw. The full error (it carries absolute
 * vault paths) stays in the server log; callers and API clients get a short
 * message.
 */
function fileFailure(cardId: string, lineNumber: number, err: unknown): WriteBackResult {
  console.error(`[writeback] Board file read/write failed for card ${cardId}:`, err);
  return { success: false, changed: false, lineNumber, error: 'Board file read/write failed' };
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
    const updatedContent = lines.join('\n');
    atomicWrite(filePath, updatedContent);
    updateSyncStateHash(filePath, updatedContent);

    // Update raw_line and line_number in DB
    db.prepare('UPDATE cards SET raw_line = ?, line_number = ? WHERE id = ?').run(line, lineIdx + 1, cardId);

    console.log(`[writeback] Card ${cardId} priority → ${priority ?? 'none'} at line ${lineIdx + 1}`);
    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return fileFailure(cardId, card.line_number, err);
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
    const updatedContent = lines.join('\n');
    atomicWrite(filePath, updatedContent);
    updateSyncStateHash(filePath, updatedContent);

    // Update raw_line in DB to keep in sync
    db.prepare('UPDATE cards SET raw_line = ?, line_number = ? WHERE id = ?').run(updatedLine, lineIdx + 1, cardId);

    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return fileFailure(cardId, card.line_number, err);
  }
}

/** Matches the kb marker (kb:id + optional kb:col) anywhere in the line. */
const KB_MARKER_RE = /<!--\s*kb:id=[a-zA-Z0-9_-]+(?:\s+kb:col=[A-Za-z0-9+_-]+)?\s*-->/;
/** Matches a [from:source](url) source link (first occurrence). */
const SOURCE_LINK_RE = /\[from:[a-z][a-z0-9_-]*\]\((https?:\/\/[^)]+)\)/i;

/**
 * Write-back a new display title to the .md file for a given card.
 *
 * The line is rebuilt preserving (in original order):
 *   leading whitespace + `- [ ]`/`- [x]` checkbox state, the priority emoji
 *   (if one of the board's configured priority emojis is present in the old line),
 *   the `[from:source](url)` link, and the kb marker (kb:id + kb:col) exactly.
 * Only the display-title text portion is replaced by `newTitle`.
 *
 * Primary line matching is by kb:id (like writeBackColumn). If the card has no
 * kb:id, this returns a failure result rather than fuzzy-matching.
 *
 * Also re-extracts links from the rebuilt line text (same as the parser) and
 * updates the card's title, raw_line, and links columns for consistency.
 */
export function writeBackTitle(
  cardId: string,
  newTitle: string,
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

  // Primary matching is by kb:id only — no fuzzy fallback (parity with writeBackColumn).
  const cardKbId = extractKbId(card.raw_line);
  if (!cardKbId) {
    return { success: false, changed: false, lineNumber: card.line_number, error: 'Card has no kb:id marker' };
  }

  const trimmedTitle = newTitle.trim();
  if (trimmedTitle.length === 0) {
    return { success: false, changed: false, lineNumber: card.line_number, error: 'Title cannot be empty' };
  }

  const priorityDefs = board.priorities ?? DEFAULT_PRIORITIES;
  const priorityEmojis = Array.from(new Set(priorityDefs.map((p) => p.emoji)));

  const filePath = path.join(config.vaultRoot, board.file);

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Locate the line by kb:id (verify expected index, else search whole file).
    let lineIdx = card.line_number - 1;
    const fileKbId = lineIdx >= 0 && lineIdx < lines.length ? extractKbId(lines[lineIdx]) : null;
    if (fileKbId !== cardKbId) {
      const found = lines.findIndex((l) => extractKbId(l) === cardKbId);
      if (found === -1) {
        return { success: false, changed: false, lineNumber: card.line_number, error: 'Line not found by kb:id' };
      }
      lineIdx = found;
    }

    const originalLine = lines[lineIdx];
    const checkboxMatch = originalLine.match(/^(\s*- \[[ xX]\]\s*)(.*)$/);
    if (!checkboxMatch) {
      return { success: false, changed: false, lineNumber: lineIdx + 1, error: 'Line is not a checkbox task' };
    }

    const prefix = checkboxMatch[1];
    const tail = checkboxMatch[2];

    // Preserve the kb marker and the [from:source](url) link exactly.
    const kbMarkerMatch = tail.match(KB_MARKER_RE);
    const kbMarker = kbMarkerMatch ? kbMarkerMatch[0] : null;
    const sourceLinkMatch = tail.match(SOURCE_LINK_RE);
    const sourceLink = sourceLinkMatch ? sourceLinkMatch[0] : null;

    // Preserve the priority emoji only if a configured one is present in the old line.
    const presentEmoji = priorityEmojis.find((emoji) => emoji && tail.includes(emoji)) ?? null;

    // Rebuild: prefix + [emoji ] + newTitle + [ sourceLink] + [ kbMarker]
    const parts: string[] = [];
    if (presentEmoji) parts.push(presentEmoji);
    parts.push(trimmedTitle);
    if (sourceLink) parts.push(sourceLink);
    if (kbMarker) parts.push(kbMarker);
    const line = `${prefix}${parts.join(' ')}`;

    if (line === originalLine) {
      return { success: true, changed: false, lineNumber: lineIdx + 1 };
    }

    suppressWatcher();
    try {
      lines[lineIdx] = line;
      const updatedContent = lines.join('\n');
      atomicWrite(filePath, updatedContent);
      updateSyncStateHash(filePath, updatedContent);
    } finally {
      unsuppressWatcher();
    }

    // Re-extract links from the rebuilt line text (same logic as parser/reconciler).
    const { links } = extractTaskLinks(line);

    db.prepare('UPDATE cards SET title = ?, raw_line = ?, line_number = ?, links = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(trimmedTitle, line, lineIdx + 1, JSON.stringify(links), cardId);

    console.log(`[writeback] Card ${cardId} title updated at line ${lineIdx + 1}`);
    return { success: true, changed: true, lineNumber: lineIdx + 1 };
  } catch (err) {
    return fileFailure(cardId, card.line_number, err);
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

    const cards = db.prepare('SELECT id, column_name, raw_line, line_number FROM cards WHERE board_id = ? AND deleted_at IS NULL').all(board.id) as Array<{
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
        const updatedContent = lines.join('\n');
        atomicWrite(filePath, updatedContent);
        updateSyncStateHash(filePath, updatedContent);
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
export function atomicWrite(filePath: string, content: string): void {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
