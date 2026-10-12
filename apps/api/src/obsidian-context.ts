import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getDb } from './db.js';
import { loadConfig, type AppConfig } from './config.js';
import { atomicWrite } from './writeback.js';
import { broadcast } from './ws.js';
import { cardLinksInText, cardUrl, trustedHostsFor } from './card-links.js';
import { safeJsonParse } from './utils.js';

/**
 * Closing a card updates its context in Obsidian: every note the card is linked with
 * gets a dated line in its "## Канбан" section and a fresh frontmatter `updated:` date,
 * and the card gets a comment naming the notes (or the references that did not resolve).
 *
 * A note is context only through an explicit reference — searching the vault for words
 * of the title matched dozens of unrelated notes on real data (81 for one name):
 *  1. the card (title, description, sub-items, checklist, managed links) carries an
 *     `obsidian://open?vault=<vault>&file=<note>` link or a `[[wikilink]]` to the note;
 *  2. the note carries the card's Kanban link (`…/?board=<b>&card=<id>`).
 * `kb:id=<id>` markers do not count: copies of board files (`*_old-vault.md`) carry them.
 * Board files themselves are never context. Nothing else in a note is rewritten.
 */

export const CONTEXT_HEADING = '## Канбан';
export const COMMENT_AUTHOR = 'obsidian';
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_CHARS = 120;
const READ_CONCURRENCY = 32;

export interface VaultIndex {
  /** Vault-relative note path, lowercased → actual path (Obsidian links ignore case). */
  byPath: Map<string, string>;
  /** Note basename without `.md`, lowercased → paths (what a bare `[[Name]]` resolves to). */
  byBasename: Map<string, string[]>;
}

export type NoteResolution = { note: string } | { problem: string };

interface ClosedCard {
  id: string;
  board_id: string;
  seq_id: number | null;
  title: string;
  description: string | null;
  sub_items: string | null;
  checklist: string | null;
  links: string | null;
}

/** Keys compare in NFC: macOS file names and URL-decoded link targets may differ in normalization. */
function key(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

// ---------------------------------------------------------------- vault

/**
 * Every `.md` note under the vault root; dot-folders (.obsidian, .trash, .stversions) and symlinks
 * are skipped. An unreadable vault root throws; a subfolder that vanishes mid-walk is logged and skipped.
 */
export async function listVaultNotes(vaultRoot: string): Promise<string[]> {
  const notes: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(vaultRoot, rel), { withFileTypes: true });
    } catch (err) {
      if (!rel) throw err;
      console.warn(`[obsidian-context] Skipped folder ${rel}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) notes.push(child.normalize('NFC'));
    }
  };
  await walk('');
  return notes;
}

export function buildVaultIndex(notes: string[]): VaultIndex {
  const byPath = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const note of notes) {
    byPath.set(key(note), note);
    const base = key(path.posix.basename(note, path.posix.extname(note)));
    byBasename.set(base, [...(byBasename.get(base) ?? []), note]);
  }
  return { byPath, byBasename };
}

/**
 * Resolve a link target (vault-relative path or note name, with or without `.md`) the way
 * Obsidian does: exact path first, then the unique note with that name (or path suffix).
 * Returns null for a target that is not a note (an attachment such as `.pdf`).
 */
export function resolveNoteTarget(rawTarget: string, index: VaultIndex): NoteResolution | null {
  const target = rawTarget.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!target) return null;
  const ext = path.posix.extname(target).toLowerCase();
  const withMd = ext === '.md' ? target : `${target}.md`;
  const exact = index.byPath.get(key(withMd));
  if (exact) return { note: exact };

  const base = key(path.posix.basename(withMd, '.md'));
  let candidates = index.byBasename.get(base) ?? [];
  if (target.includes('/')) candidates = candidates.filter((note) => key(note).endsWith(`/${key(withMd)}`));
  if (candidates.length === 1) return { note: candidates[0] };
  // `.2` in "Plan v1.2" is not an attachment extension; `.pdf` is — only a target that names a note can be missing.
  const namesNote = ext === '' || ext === '.md';
  if (candidates.length > 1) return { problem: `ссылка «${target}» неоднозначна — заметок с таким именем: ${candidates.length}` };
  return namesNote ? { problem: `заметка «${target}» не найдена` } : null;
}

// ---------------------------------------------------------------- references

/** Link targets a card points at: `obsidian://open` links to this vault and `[[wikilinks]]` (embeds `![[…]]` excluded). */
export function noteTargetsInCard(card: Pick<ClosedCard, 'title' | 'description' | 'sub_items' | 'checklist' | 'links'>, vaultRoot: string): string[] {
  const vaultName = path.basename(vaultRoot);
  const linkUrls = safeJsonParse<Array<{ url?: string }>>(card.links, []).map((link) => link.url ?? '');
  const text = [
    card.title,
    card.description ?? '',
    ...safeJsonParse<string[]>(card.sub_items, []),
    ...safeJsonParse<Array<{ title?: string }>>(card.checklist, []).map((item) => item.title ?? ''),
  ].join('\n');

  const targets: string[] = [];
  const obsidianUrls = [
    ...linkUrls.filter((url) => url.startsWith('obsidian://')),
    ...[...text.matchAll(/obsidian:\/\/(?:[^\s"'<>()[\]]|\([^\s"'<>()]*\))+/g)].map((m) => m[0]),
  ];
  for (const raw of obsidianUrls) {
    const target = obsidianUrlTarget(raw, vaultRoot, vaultName);
    if (target) targets.push(target);
  }
  for (const match of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
    if (match[1] === '!') continue;
    const target = match[2].split('|')[0].split('#')[0].trim();
    if (target) targets.push(target);
  }
  return [...new Set(targets)];
}

function obsidianUrlTarget(raw: string, vaultRoot: string, vaultName: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'obsidian:' || url.hostname !== 'open') return null;
  const absolute = url.searchParams.get('path');
  if (absolute) {
    const rel = path.relative(vaultRoot, absolute);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  }
  const vault = url.searchParams.get('vault');
  if (vault && vault.normalize('NFC') !== vaultName.normalize('NFC')) return null;
  return url.searchParams.get('file');
}

/** Of `notes`, those that carry a card link to one of `cards` (board must match when the link names one), keyed by card id. */
export async function findBacklinks(
  vaultRoot: string,
  notes: string[],
  cards: Array<{ id: string; board_id: string }>,
  trustedHosts: Set<string>,
): Promise<Map<string, Set<string>>> {
  const boardOf = new Map(cards.map((card) => [card.id, card.board_id]));
  const found = new Map<string, Set<string>>();
  for (let i = 0; i < notes.length; i += READ_CONCURRENCY) {
    await Promise.all(notes.slice(i, i + READ_CONCURRENCY).map(async (note) => {
      const abs = path.join(vaultRoot, note);
      try {
        if ((await stat(abs)).size > MAX_NOTE_BYTES) return;
        const content = await readFile(abs, 'utf-8');
        if (!content.includes('card=')) return;
        for (const ref of cardLinksInText(content, trustedHosts)) {
          const board = boardOf.get(ref.card);
          if (board === undefined || (ref.board !== null && ref.board !== board)) continue;
          found.set(ref.card, (found.get(ref.card) ?? new Set()).add(note));
        }
      } catch (err) {
        // A note deleted or unreadable mid-scan cannot be context; the scan goes on.
        console.warn(`[obsidian-context] Skipped ${note}: ${(err as Error).message}`);
      }
    }));
  }
  return found;
}

// ---------------------------------------------------------------- note update

/** Calendar date in the server's time zone: the line is read by the owner, in their day. */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function closedLine(
  card: Pick<ClosedCard, 'id' | 'board_id' | 'seq_id' | 'title'>,
  boardName: string,
  date: string,
  publicUrl: string | undefined,
): string {
  const chars = Array.from(card.title.replace(/\s+/g, ' ').trim()); // code points: never split an emoji
  const title = chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join('').trimEnd()}…` : chars.join('');
  const label = card.seq_id ? `${boardName} #${card.seq_id}` : boardName;
  const ref = publicUrl ? `[${label}](${cardUrl(publicUrl, card.board_id, card.id)})` : label;
  return `- ${date} ✅ Карточка закрыта: «${title}» — ${ref}`;
}

/** Per line: true inside a fenced code block (``` or ~~~), delimiters included. */
function fencedLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((l) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (fence === null) {
      // CommonMark: a backtick fence's info string has no backtick, so "```npm ci``` text" is inline code.
      const opens = m !== null && !(m[1][0] === '`' && m[2].includes('`'));
      if (opens) fence = m[1];
      return opens;
    }
    if (m && m[1][0] === fence[0] && m[1].length >= fence.length && m[2].trim() === '') fence = null;
    return true;
  });
}

/**
 * The note with `line` added at the end of its "## Канбан" section (created at the end
 * of the note when missing) and frontmatter `updated:` set to `date`. Headings inside code
 * fences do not count. Lines outside the insert keep their bytes, line endings included;
 * only blank lines at the very end of a note without the section are folded into one
 * separator. Null when the note already has this exact line, so a repeated close on the
 * same day changes nothing.
 */
export function withClosedLine(content: string, line: string, date: string): string | null {
  // Split on LF only: a CRLF line keeps its \r, so untouched lines keep their own ending.
  const lines = content.split('\n');
  const text = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (lines.some((l) => text(l).trim() === line)) return null;
  const cr = content.includes('\r\n') ? '\r' : '';
  const fenced = fencedLines(lines.map(text));

  // Up to 3 spaces of indent, as in CommonMark; 4+ is an indented code block, not a heading.
  const headingIdx = lines.findIndex((l, i) => !fenced[i] && /^ {0,3}##\s+Канбан\s*$/i.test(text(l)));
  if (headingIdx === -1) {
    const endsWithNewline = lines.length === 1 ? lines[0] === '' : lines[lines.length - 1] === '';
    while (lines.length > 0 && text(lines[lines.length - 1]).trim() === '') lines.pop();
    if (lines.length > 0) {
      // Only a final line without any newline gets one; a line that had one keeps it as it was.
      if (!endsWithNewline) lines[lines.length - 1] += cr;
      lines.push(cr);
    }
    lines.push(CONTEXT_HEADING + cr, endsWithNewline ? line + cr : line);
    if (endsWithNewline) lines.push('');
  } else {
    let end = lines.findIndex((l, i) => i > headingIdx && !fenced[i] && /^#{1,2}\s/.test(text(l)));
    if (end === -1) end = lines.length;
    let insertAt = headingIdx + 1;
    for (let i = headingIdx + 1; i < end; i++) if (text(lines[i]).trim() !== '') insertAt = i + 1;
    if (insertAt === lines.length) {
      // After the last line of a note with no final newline: that line gets one, the note still ends without.
      if (!lines[insertAt - 1].endsWith('\r')) lines[insertAt - 1] += cr;
      lines.push(line);
    } else {
      lines.splice(insertAt, 0, line + cr);
    }
  }
  return setFrontmatterUpdated(lines, date, cr).join('\n');
}

/** Set `updated:` in an existing frontmatter block (added when absent); a note without frontmatter keeps none. */
function setFrontmatterUpdated(lines: string[], date: string, cr: string): string[] {
  const text = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (text(lines[0] ?? '').trim() !== '---') return lines;
  const close = lines.findIndex((l, i) => i > 0 && text(l).trim() === '---');
  if (close === -1) return lines;
  const idx = lines.findIndex((l, i) => i > 0 && i < close && /^updated:/.test(l));
  if (idx === -1) {
    lines.splice(close, 0, `updated: '${date}'${cr}`);
    return lines;
  }
  const quote = /^updated:\s*(['"])/.exec(lines[idx])?.[1] ?? '';
  lines[idx] = `updated: ${quote}${date}${quote}${lines[idx].endsWith('\r') ? '\r' : ''}`;
  return lines;
}

// ---------------------------------------------------------------- run

interface CardOutcome {
  updated: string[];
  unchanged: string[];
  problems: string[];
}

function updateNote(vaultRoot: string, note: string, line: string, date: string): 'updated' | 'unchanged' {
  const abs = path.join(vaultRoot, note);
  const next = withClosedLine(readFileSync(abs, 'utf-8'), line, date);
  if (next === null) return 'unchanged';
  atomicWrite(abs, next);
  return 'updated';
}

function commentFor(outcome: CardOutcome): string | null {
  const parts: string[] = [];
  if (outcome.updated.length > 0) parts.push(`Obsidian: контекст обновлён — ${outcome.updated.join(', ')}`);
  for (const problem of outcome.problems) parts.push(`Obsidian: ${problem}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

function addComment(cardId: string, text: string): void {
  const db = getDb();
  const id = createHash('sha256').update(`${cardId}|obsidian|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 12);
  db.prepare('INSERT INTO comments (id, card_id, author, text) VALUES (?, ?, ?, ?)').run(id, cardId, COMMENT_AUTHOR, text);
  db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);
}

/**
 * Update the context notes of cards that are (still) closed; returns what happened per card.
 * `active` is re-checked after every await and before each card, so nothing is written after
 * stopObsidianContext() (shutdown closes the DB right after it).
 */
export async function updateContextForClosedCards(
  cardIds: string[],
  now = new Date(),
  active: () => boolean = () => enabled,
): Promise<Map<string, CardOutcome>> {
  const config: AppConfig = loadConfig();
  const db = getDb();
  const placeholders = cardIds.map(() => '?').join(', ');
  const cards = db
    .prepare(`SELECT id, board_id, seq_id, title, description, sub_items, checklist, links FROM cards
      WHERE id IN (${placeholders}) AND is_done = 1 AND deleted_at IS NULL`)
    .all(...cardIds) as ClosedCard[];
  const outcomes = new Map<string, CardOutcome>();
  if (cards.length === 0) return outcomes;

  // Board files resolve (a card may link one) but are never context: their lines belong to the boards.
  const boardFiles = new Set(config.boards.map((board) => key(board.file.replace(/\\/g, '/'))));
  const allNotes = await listVaultNotes(config.vaultRoot);
  const index = buildVaultIndex(allNotes);
  const notes = allNotes.filter((note) => !boardFiles.has(key(note)));
  const backlinks = await findBacklinks(config.vaultRoot, notes, cards, trustedHostsFor(config));
  const date = localDate(now);

  for (const [i, card] of cards.entries()) {
    if (!active()) {
      console.warn(`[obsidian-context] Stopped; ${cards.length - i} closed cards left without a context update`);
      break;
    }
    try {
      outcomes.set(card.id, updateCardContext(card, config, index, backlinks, boardFiles, date));
    } catch (err) {
      console.error(`[obsidian-context] Card ${card.id}: context update failed:`, err);
    }
  }
  return outcomes;
}

function updateCardContext(
  card: ClosedCard,
  config: AppConfig,
  index: VaultIndex,
  backlinks: Map<string, Set<string>>,
  boardFiles: Set<string>,
  date: string,
): CardOutcome {
  const outcome: CardOutcome = { updated: [], unchanged: [], problems: [] };
  const targets = new Set(backlinks.get(card.id) ?? []);
  for (const target of noteTargetsInCard(card, config.vaultRoot)) {
    const resolved = resolveNoteTarget(target, index);
    if (!resolved) continue;
    if (!('note' in resolved)) outcome.problems.push(resolved.problem);
    else if (!boardFiles.has(key(resolved.note))) targets.add(resolved.note);
  }

  const boardName = config.boards.find((board) => board.id === card.board_id)?.name ?? card.board_id;
  const line = closedLine(card, boardName, date, config.publicUrl);
  for (const note of [...targets].sort()) {
    try {
      outcome[updateNote(config.vaultRoot, note, line, date) === 'updated' ? 'updated' : 'unchanged'].push(note);
    } catch (err) {
      outcome.problems.push(`не удалось обновить «${note}»: ${(err as Error).message}`);
      console.error(`[obsidian-context] Card ${card.id}: failed to update ${note}:`, err);
    }
  }

  console.log(
    `[obsidian-context] Card ${card.id}: ${outcome.updated.length} updated, ${outcome.unchanged.length} already current, ${outcome.problems.length} problems`,
  );
  const comment = commentFor(outcome);
  if (comment) {
    addComment(card.id, comment);
    broadcast({ type: 'card-updated', cardId: card.id, boardId: card.board_id, timestamp: new Date().toISOString() });
  }
  return outcome;
}

// ---------------------------------------------------------------- queue

let enabled = false;
const pending = new Set<string>();
let running: Promise<void> | null = null;

/** Closed cards are queued and processed one batch at a time, so notes never see two writers. */
export function notifyCardsClosed(cardIds: string[]): void {
  if (!enabled) return;
  for (const id of cardIds) pending.add(id);
  kick();
}

function kick(): void {
  if (running || !enabled || pending.size === 0) return;
  running = drain().finally(() => {
    running = null;
    kick();
  });
}

async function drain(): Promise<void> {
  while (enabled && pending.size > 0) {
    const batch = [...pending];
    pending.clear();
    try {
      await updateContextForClosedCards(batch);
    } catch (err) {
      console.error(`[obsidian-context] Failed for cards ${batch.join(', ')}:`, err);
    }
  }
}

export function startObsidianContext(): void {
  enabled = true;
}

export function stopObsidianContext(): void {
  enabled = false;
  pending.clear();
}

/** Resolves once queued work is done (tests). */
export async function obsidianContextIdle(): Promise<void> {
  while (running) await running;
}
