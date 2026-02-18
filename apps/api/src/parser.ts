import { createHash } from 'node:crypto';

export interface ParsedTask {
  title: string;
  rawLine: string;
  lineNumber: number;
  isDone: boolean;
  priority: 'high' | 'urgent' | null;
  urls: string[];
  subItems: string[];
  /** Stable ID from <!-- kb:id=xxx --> marker, if present */
  kbId: string | null;
}

const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)/;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

/** Regex to extract kb:id from HTML comment marker */
const KB_ID_RE = /<!--\s*kb:id=([a-zA-Z0-9_-]+)\s*-->/;

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
 * Extract kb:id from a task line (HTML comment marker).
 * Returns null if no marker found.
 */
export function extractKbId(line: string): string | null {
  const match = line.match(KB_ID_RE);
  return match ? match[1] : null;
}

/**
 * Inject or replace <!-- kb:id=xxx --> marker in a task line.
 * Places it at the end of the line (before trailing whitespace).
 */
export function injectKbId(line: string, kbId: string): string {
  const marker = `<!-- kb:id=${kbId} -->`;
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

export function parseMarkdownTasks(content: string): ParsedTask[] {
  const lines = content.split('\n');
  const tasks: ParsedTask[] = [];
  let currentTask: ParsedTask | null = null;
  let inFrontmatter = false;
  let hasFoundTask = false;

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

      // Extract kb:id marker (if present) and strip from display title
      const kbId = extractKbId(rawTitleText);
      const titleText = stripKbIdFromTitle(rawTitleText);

      let priority: 'high' | 'urgent' | null = null;
      if (titleText.includes('🔺')) priority = 'urgent';
      else if (titleText.includes('⏫')) priority = 'high';

      const urls: string[] = [];
      const mdRe = new RegExp(MD_LINK_RE.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = mdRe.exec(titleText)) !== null) {
        urls.push(m[2]);
      }
      const bareRe = new RegExp(BARE_URL_RE.source, 'g');
      while ((m = bareRe.exec(titleText)) !== null) {
        if (!urls.includes(m[0])) urls.push(m[0]);
      }

      currentTask = {
        title: titleText,
        rawLine: line,
        lineNumber,
        isDone,
        priority,
        urls,
        subItems: [],
        kbId,
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
