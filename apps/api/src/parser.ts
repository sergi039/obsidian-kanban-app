import { createHash } from 'node:crypto';
import { DEFAULT_PRIORITIES } from './config.js';
import type { PriorityDef } from './config.js';

export interface ParsedTask {
  title: string;
  rawLine: string;
  lineNumber: number;
  isDone: boolean;
  priority: string | null;
  urls: string[];
  subItems: string[];
  /** Stable ID from <!-- kb:id=xxx --> marker, if present */
  kbId: string | null;
  /** Column name from <!-- kb:id=xxx kb:col=XXX --> marker, if present */
  kbCol: string | null;
}

const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)/;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

/** Regex to extract kb:id (and optional kb:col) from HTML comment marker */
const KB_ID_RE = /<!--\s*kb:id=([a-zA-Z0-9_-]+)(?:\s+kb:col=([A-Za-z0-9+_-]+))?\s*-->/;

/**
 * Generate a new stable kb:id (8 chars, hex).
 * Uses crypto random to avoid collisions.
 */
export function generateKbId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto?.getRandomValues?.(bytes) ??
    bytes.set(createHash('sha256').update(String(Date.now() + Math.random())).digest().subarray(0, 4));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Allocate a unique kb:id that doesn't collide with existing IDs.
 * Retries up to maxAttempts times if collision detected.
 * @param isUsed - function that returns true if an ID is already in use
 */
export function allocateUniqueKbId(isUsed: (id: string) => boolean, maxAttempts = 10): string {
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateKbId();
    if (!isUsed(id)) return id;
  }
  // Fallback: use timestamp + random for near-zero collision chance
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8);
}

/**
 * Extract kb:id from a task line (HTML comment marker).
 * Returns null if no marker found.
 */
export function extractKbId(line: string): string | null {
  const match = line.match(KB_ID_RE);
  return match ? match[1] : null;
}

/**
 * Extract kb:col from a task line (HTML comment marker).
 * Returns null if no marker found.
 * Decodes '+' back to spaces.
 */
export function extractKbCol(line: string): string | null {
  const match = line.match(KB_ID_RE);
  return match?.[2] ? match[2].replace(/\+/g, ' ') : null;
}

/** Encode column name for marker: spaces → '+' */
export function encodeCol(col: string): string {
  return col.replace(/ /g, '+');
}

/**
 * Inject or update kb:col in an existing marker line.
 * If marker has no kb:col, adds it. If it has one, replaces it.
 * If col is null/empty, removes kb:col from marker.
 */
export function injectKbCol(line: string, col: string | null): string {
  const match = line.match(KB_ID_RE);
  if (!match) return line; // no marker to update

  const id = match[1];
  const colPart = col ? ` kb:col=${encodeCol(col)}` : '';
  const newMarker = `<!-- kb:id=${id}${colPart} -->`;
  return line.replace(KB_ID_RE, newMarker);
}

/**
 * Inject or replace <!-- kb:id=xxx --> marker in a task line.
 * Places it at the end of the line (before trailing whitespace).
 * Preserves existing kb:col if present.
 */
export function injectKbId(line: string, kbId: string, col?: string | null): string {
  const existingCol = extractKbCol(line);
  const colVal = col ?? existingCol;
  const colPart = colVal ? ` kb:col=${encodeCol(colVal)}` : '';
  const marker = `<!-- kb:id=${kbId}${colPart} -->`;
  // Replace existing marker if present
  if (KB_ID_RE.test(line)) {
    return line.replace(KB_ID_RE, marker);
  }
  // Append marker at end (before trailing whitespace)
  const trimmed = line.trimEnd();
  return `${trimmed} ${marker}`;
}

/**
 * Strip the kb:id marker from a title string (for display purposes).
 */
export function stripKbIdFromTitle(title: string): string {
  return title.replace(KB_ID_RE, '').trimEnd();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPriorityEmoji(title: string, emoji: string): string {
  return title
    .replace(new RegExp(`\\s*${escapeRegExp(emoji)}\\s*`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect priority by scanning title text for any configured emoji.
 * Returns matching priority ID and emoji, or nulls if no match.
 */
export function detectPriority(
  text: string,
  priorityDefs: PriorityDef[],
): { priority: string | null; emoji: string | null } {
  for (const def of priorityDefs) {
    if (def.emoji && text.includes(def.emoji)) {
      return { priority: def.id, emoji: def.emoji };
    }
  }
  return { priority: null, emoji: null };
}

export function parseMarkdownTasks(content: string, priorityDefs?: PriorityDef[]): ParsedTask[] {
  const lines = content.split('\n');
  const tasks: ParsedTask[] = [];
  let currentTask: ParsedTask | null = null;
  let inFrontmatter = false;
  let hasFoundTask = false;
  const defs = priorityDefs ?? DEFAULT_PRIORITIES;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    const trimmed = line.trim();

    // --- Frontmatter handling (only before first task) ---
    if (trimmed === '---' && !hasFoundTask) {
      if (currentTask) {
        tasks.push(currentTask);
        currentTask = null;
      }
      inFrontmatter = !inFrontmatter;
      continue;
    }

    if (inFrontmatter) {
      if (TASK_RE.test(line)) {
        inFrontmatter = false;
      } else {
        continue;
      }
    }

    // --- Task line ---
    const match = line.match(TASK_RE);
    if (match) {
      if (currentTask) tasks.push(currentTask);
      hasFoundTask = true;

      const isDone = match[2].toLowerCase() === 'x';
      const rawTitleText = match[3].trimEnd();

      // Extract kb:id and kb:col markers (if present) and strip from display title
      const kbId = extractKbId(rawTitleText);
      const kbCol = extractKbCol(rawTitleText);
      const titleText = stripKbIdFromTitle(rawTitleText);

      const { priority, emoji } = detectPriority(titleText, defs);
      const displayTitle = emoji ? stripPriorityEmoji(titleText, emoji) : titleText;

      const urls: string[] = [];
      const mdRe = new RegExp(MD_LINK_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = mdRe.exec(displayTitle)) !== null) {
        urls.push(m[2]);
      }
      const bareRe = new RegExp(BARE_URL_RE.source, 'g');
      while ((m = bareRe.exec(displayTitle)) !== null) {
        if (!urls.includes(m[0])) urls.push(m[0]);
      }

      currentTask = {
        title: displayTitle,
        rawLine: line,
        lineNumber,
        isDone,
        priority,
        urls,
        subItems: [],
        kbId,
        kbCol,
      };
      continue;
    }

    // --- Sub-item: indented non-empty line after a task ---
    if (currentTask && trimmed.length > 0 && (line.startsWith('\t') || line.startsWith('  '))) {
      currentTask.subItems.push(trimmed);
      continue;
    }

    // --- Non-task, non-empty, non-indented content → break sub-item collection ---
    if (trimmed.length > 0 && currentTask) {
      tasks.push(currentTask);
      currentTask = null;
    }
  }

  if (currentTask) tasks.push(currentTask);
  return tasks;
}

/**
 * Check if a column is a "done" column.
 * Centralizes the hardcoded 'Done' check. Supports optional board-level doneColumns list.
 */
export function isDoneColumn(col: string, board?: { doneColumns?: string[] }): boolean {
  if (col === 'Done') return true;
  if (board?.doneColumns?.includes(col)) return true;
  return false;
}

/**
 * Compute a legacy fingerprint for a task (used as fallback when no kb:id exists).
 * Uses title + boardId. For duplicate titles, a collision suffix is appended.
 */
export function computeFingerprint(title: string, boardId: string, collisionIndex: number): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const input = collisionIndex === 0
    ? `${normalized}|${boardId}`
    : `${normalized}|${boardId}|dup${collisionIndex}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}
