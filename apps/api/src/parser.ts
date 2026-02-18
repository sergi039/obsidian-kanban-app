import { createHash } from 'node:crypto';

export interface ParsedTask {
  title: string;
  rawLine: string;
  lineNumber: number;
  isDone: boolean;
  priority: 'high' | 'urgent' | null;
  urls: string[];
  subItems: string[];
}

const TASK_RE = /^(\s*)- \[([ xX])\]\s+(.*)/;
const BARE_URL_RE = /https?:\/\/[^\s)\]]+/g;
const MD_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

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
      // Finalize any current task before toggling (shouldn't happen, but safety)
      if (currentTask) {
        tasks.push(currentTask);
        currentTask = null;
      }
      inFrontmatter = !inFrontmatter;
      continue;
    }

    if (inFrontmatter) {
      // Check if this is actually a task inside unclosed frontmatter
      if (TASK_RE.test(line)) {
        inFrontmatter = false;
        // fall through to task processing
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
      const titleText = match[3].trimEnd();

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
 * Compute a stable fingerprint for a task.
 * Uses title + boardId (NOT occurrence index) so that reordering tasks
 * doesn't change IDs and lose sidecar metadata.
 * For duplicate titles, a collision suffix is appended.
 */
export function computeFingerprint(title: string, boardId: string, collisionIndex: number): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const input = collisionIndex === 0
    ? `${normalized}|${boardId}`
    : `${normalized}|${boardId}|dup${collisionIndex}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}
