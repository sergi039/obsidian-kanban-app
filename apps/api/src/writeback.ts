/**
 * Write-back: update the source .md file when a card is moved to Done (or un-done).
 * Line-preserving: only changes the specific line, preserves everything else.
 * Validates line identity before modifying to prevent wrong-task toggle.
 * Uses atomic write (write to temp, rename) to prevent data loss.
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { extractKbId } from './parser.js';

export interface WriteBackResult {
  success: boolean;
  changed: boolean;
  lineNumber: number;
  error?: string;
}

const CHECKBOX_RE = /^(\s*- \[)([ xX])(\] .*)$/;

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
 * Atomic write: write to temp file, then rename (prevents corruption on crash).
 */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
