import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { loadConfig, type AppConfig } from './config.js';
import { allocateUniqueKbId, injectKbId } from './parser.js';
import { routeTask, type RouteTaskResult } from './routing.js';
import { broadcast } from './ws.js';
import { suppressWatcher, unsuppressWatcher } from './watcher.js';
import { updateSyncStateHash } from './writeback.js';
import { fireEvent } from './automations.js';
import { formatCard } from './utils.js';

export const SOURCE_VALUES = ['telegram', 'email', 'web-clipper', 'claude', 'openai', 'mobile', 'manual'] as const;
export type IngestSource = (typeof SOURCE_VALUES)[number];

export interface IngestLink {
  url: string;
  title?: string;
}

export interface IngestCardInput {
  title: string;
  boardId?: string;
  column?: string;
  description?: string;
  links?: IngestLink[];
  source?: IngestSource;
  sourceUid?: string;
  sourceUrl?: string;
  sourceMeta?: Record<string, unknown>;
  context?: string;
  allowDefaultOnAmbiguous?: boolean;
}

export type IngestCardResult =
  | {
      created: true;
      duplicate: boolean;
      card: ReturnType<typeof formatCard>;
      boardId: string;
      route: RouteTaskResult;
      captureKey: string | null;
    }
  | {
      created: false;
      duplicate: true;
      deleted: boolean;
      card?: ReturnType<typeof formatCard>;
      boardId?: string;
      captureKey: string;
      route?: RouteTaskResult;
    }
  | {
      created: false;
      duplicate: false;
      needsClarification: true;
      question: string;
      route: RouteTaskResult;
    };

const MAX_SOURCE_META_BYTES = 4096;
const MAX_TITLE_BYTES = 1000;

export class IngestError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'ingest_error',
  ) {
    super(message);
  }
}

function safeHostname(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

function assertSource(source: string): asserts source is IngestSource {
  if (!SOURCE_VALUES.includes(source as IngestSource)) {
    throw new Error(`Invalid source "${source}". Use one of: ${SOURCE_VALUES.join(', ')}`);
  }
}

function normalizeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new IngestError('URL must use HTTP(S)', 400, 'invalid_url');
    }
    return url.toString();
  } catch (err) {
    if (err instanceof IngestError) throw err;
    throw new IngestError('URL must be valid', 400, 'invalid_url');
  }
}

function sanitizeTaskTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new IngestError('title is required', 400, 'title_required');
  if (Buffer.byteLength(title, 'utf-8') > MAX_TITLE_BYTES) {
    throw new IngestError(`title must be ${MAX_TITLE_BYTES} bytes or less`, 400, 'title_too_large');
  }
  if (/[\r\n]/.test(title)) {
    throw new IngestError('title must be a single Markdown task line', 400, 'title_newline');
  }
  if (/<!--|-->/.test(title)) {
    throw new IngestError('title must not contain HTML comments', 400, 'title_html_comment');
  }
  if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(title)) {
    throw new IngestError('title must not include a Markdown task prefix', 400, 'title_task_prefix');
  }
  return title;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

function normalizeLinks(links: IngestLink[] | undefined, source: IngestSource, sourceUrl: string | null): Array<{ url: string; title: string }> {
  const normalized: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();

  if (sourceUrl) {
    normalized.push({ url: sourceUrl, title: `from:${source}` });
    seen.add(sourceUrl);
  }

  for (const link of links ?? []) {
    const url = normalizeHttpUrl(link.url);
    if (!url || seen.has(url)) continue;
    normalized.push({ url, title: link.title?.trim() || safeHostname(url) });
    seen.add(url);
  }

  return normalized;
}

function appendCanonicalLinks(title: string, links: Array<{ url: string; title: string }>): string {
  let result = title.trim();
  for (const link of links) {
    if (result.includes(link.url)) continue;
    result += ` [${escapeMarkdownLinkLabel(link.title)}](${link.url})`;
  }
  return result;
}

function boundedSourceMeta(meta: Record<string, unknown> | undefined): string {
  const normalized = meta ?? {};
  const raw = JSON.stringify(normalized);
  if (Buffer.byteLength(raw, 'utf-8') > MAX_SOURCE_META_BYTES) {
    throw new IngestError(`source_meta must be ${MAX_SOURCE_META_BYTES} bytes or less`, 400, 'source_meta_too_large');
  }
  return raw;
}

function makeSourceUid(source: IngestSource, inputUid: string | undefined): string {
  const trimmed = inputUid?.trim();
  if (trimmed) return trimmed;
  return `${source}:${randomUUID()}`;
}

function makeCaptureKey(source: IngestSource, sourceUid: string): string {
  return createHash('sha256').update(`${source}|${sourceUid}`).digest('hex');
}

function makeRequestHash(input: {
  title: string;
  boardId?: string;
  column?: string;
  description?: string;
  links: Array<{ url: string; title: string }>;
  source: IngestSource;
  sourceUid: string;
  sourceUrl: string | null;
  sourceMeta: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function routeForExistingCard(card: Record<string, unknown>): RouteTaskResult {
  return {
    boardId: card.board_id as string,
    column: card.column_name as string,
    confidence: 1,
    needsClarification: false,
    reasonCode: 'idempotent_duplicate',
    reason: `Existing capture already created card "${String(card.id)}"`,
    candidates: [{ boardId: card.board_id as string, score: 100, matched: ['idempotent'] }],
  };
}

export function ingestCard(input: IngestCardInput, config: AppConfig = loadConfig()): IngestCardResult {
  const title = sanitizeTaskTitle(input.title);

  const source = input.source ?? 'manual';
  assertSource(source);

  const sourceUrl = normalizeHttpUrl(input.sourceUrl);
  const sourceUid = makeSourceUid(source, input.sourceUid);
  const captureKey = makeCaptureKey(source, sourceUid);
  const links = normalizeLinks(input.links, source, sourceUrl);
  const sourceMeta = boundedSourceMeta(input.sourceMeta);
  const requestHash = makeRequestHash({
    title,
    boardId: input.boardId,
    column: input.column,
    description: input.description,
    links,
    source,
    sourceUid,
    sourceUrl,
    sourceMeta,
  });

  const db = getDb();
  const existingCapture = db.prepare('SELECT card_id, request_hash, status FROM inbox_captures WHERE capture_key = ?').get(captureKey) as
    | { card_id: string | null; request_hash?: string; status?: string }
    | undefined;
  let retryFailedCapture = false;
  if (existingCapture) {
    if (existingCapture.request_hash && existingCapture.request_hash !== requestHash) {
      throw new IngestError('capture_key already exists with a different payload', 409, 'capture_conflict');
    }
    if (existingCapture.status === 'failed' && !existingCapture.card_id) {
      retryFailedCapture = true;
    } else if (existingCapture.status === 'pending' && !existingCapture.card_id) {
      throw new IngestError('capture_key is already being processed', 409, 'capture_pending');
    } else {
      if (existingCapture.card_id) {
        const existingCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(existingCapture.card_id) as Record<string, unknown> | undefined;
        if (existingCard) {
          return {
            created: true,
            duplicate: true,
            card: formatCard(existingCard),
            boardId: existingCard.board_id as string,
            route: routeForExistingCard(existingCard),
            captureKey,
          };
        }
      }
      return {
        created: false,
        duplicate: true,
        deleted: true,
        captureKey,
      };
    }
  }

  const route = routeTask(`${title} ${input.description ?? ''} ${input.context ?? ''}`, {
    boardId: input.boardId,
    config,
    allowDefaultOnAmbiguous: input.allowDefaultOnAmbiguous,
  });
  if (route.needsClarification || !route.boardId) {
    return {
      created: false,
      duplicate: false,
      needsClarification: true,
      question: route.question ?? 'Which Kanban board should I use?',
      route,
    };
  }

  const board = config.boards.find((b) => b.id === route.boardId);
  if (!board) throw new Error(`Board "${route.boardId}" not found`);
  const column = input.column ?? route.column ?? board.columns[0] ?? 'Backlog';
  if (!board.columns.includes(column)) {
    throw new IngestError(`Column "${column}" not in board "${board.id}"`, 400, 'invalid_column');
  }

  const filePath = path.join(config.vaultRoot, board.file);
  const markdownTitle = appendCanonicalLinks(title, links);

  if (retryFailedCapture) {
    db.prepare(`
      UPDATE inbox_captures
      SET card_id = null, request_hash = ?, status = 'pending', updated_at = datetime('now')
      WHERE capture_key = ? AND status = 'failed'
    `).run(requestHash, captureKey);
  } else {
    db.prepare(`
      INSERT INTO inbox_captures (capture_key, card_id, source, source_uid, request_hash, status)
      VALUES (?, null, ?, ?, ?, 'pending')
    `).run(captureKey, source, sourceUid, requestHash);
  }

  suppressWatcher();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const id = allocateUniqueKbId((candidate) =>
      !!(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(candidate)),
    );
    const newLine = injectKbId(`- [ ] ${markdownTitle}`, id, column);
    const newContent = content.endsWith('\n')
      ? content + newLine + '\n'
      : content + '\n' + newLine + '\n';

    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, newContent, 'utf-8');
    renameSync(tmpPath, filePath);
    updateSyncStateHash(filePath, newContent);

    const lines = newContent.split('\n');
    const lineNumber = lines.length - 1;
    const maxPos = (db.prepare('SELECT MAX(position) as mp FROM cards WHERE board_id = ? AND column_name = ?').get(board.id, column) as { mp: number | null }).mp ?? -1;
    const maxSeqRow = db.prepare('SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM cards WHERE board_id = ?').get(board.id) as { max_seq: number };
    const nextSeqId = maxSeqRow.max_seq + 1;
    const srcFp = createHash('sha256').update(newLine).digest('hex').slice(0, 16);

    const insert = db.transaction(() => {
      db.prepare(`
        INSERT INTO cards (
          id, board_id, column_name, position, title, raw_line, line_number,
          is_done, priority, labels, sub_items, source_fingerprint, seq_id,
          description, links, source, source_uid, source_url, source_meta
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, null, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        board.id,
        column,
        maxPos + 1,
        title,
        newLine,
        lineNumber,
        srcFp,
        nextSeqId,
        input.description ?? '',
        JSON.stringify(links),
        source,
        sourceUid,
        sourceUrl,
        sourceMeta,
      );

      db.prepare(`
        UPDATE inbox_captures
        SET card_id = ?, status = 'completed', updated_at = datetime('now')
        WHERE capture_key = ?
      `).run(id, captureKey);
    });
    insert();

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;
    broadcast({ type: 'board-updated', boardId: board.id, timestamp: new Date().toISOString() });
    try {
      fireEvent({ type: 'card.created', cardId: id, boardId: board.id, column, title });
    } catch (err) {
      console.warn('[automations] Error on card.created:', err);
    }

    return {
      created: true,
      duplicate: false,
      card: formatCard(card),
      boardId: board.id,
      route,
      captureKey,
    };
  } catch (err) {
    try {
      db.prepare(`
        UPDATE inbox_captures
        SET status = 'failed', updated_at = datetime('now')
        WHERE capture_key = ? AND status = 'pending'
      `).run(captureKey);
    } catch {
      // Preserve original error.
    }
    throw err;
  } finally {
    unsuppressWatcher();
  }
}
