import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';
import { DEFAULT_PRIORITIES, loadConfig } from '../config.js';
import { writeBackDoneState, writeBackPriority, writeBackColumn } from '../writeback.js';
import { broadcast } from '../ws.js';
import { suppressWatcher, unsuppressWatcher } from '../watcher.js';
import { allocateUniqueKbId, injectKbId, isDoneColumn } from '../parser.js';
import { fireEvent } from '../automations.js';
import { formatCard } from '../utils.js';
import type Database from 'better-sqlite3';

const cards = new Hono();

const CreateCardSchema = z.object({
  board_id: z.string(),
  title: z.string().min(1),
  column: z.string().optional(),
});

const PatchCardSchema = z.object({
  column_name: z.string().optional(),
  position: z.number().int().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  description: z.string().optional(),
});

const CreateCommentSchema = z.object({
  text: z.string().min(1),
  author: z.string().min(1).default('user'),
});

const UpdateCommentSchema = z.object({
  text: z.string().min(1),
});

const MoveCardSchema = z.object({
  column: z.string(),
  position: z.number().int(),
});


async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * Normalize positions in a column to 0,1,2,...,N-1.
 * Called after moves to ensure no gaps.
 */
function normalizePositions(db: Database.Database, boardId: string, column: string): void {
  const rows = db.prepare('SELECT id FROM cards WHERE board_id = ? AND column_name = ? ORDER BY position').all(boardId, column) as Array<{ id: string }>;
  const stmt = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
  for (let i = 0; i < rows.length; i++) {
    stmt.run(i, rows[i].id);
  }
}

/**
 * Execute a card move (same-column or cross-column) inside a transaction.
 * Handles gap closing, room making, done-state toggling, and position normalization.
 */
function executeMoveTransaction(
  db: Database.Database,
  cardId: string,
  boardId: string,
  fromColumn: string,
  fromPosition: number,
  toColumn: string,
  toPosition: number,
  board: { doneColumns?: string[] },
): { movingToDone: boolean; movingFromDone: boolean } {
  const moveTransaction = db.transaction(() => {
    if (fromColumn === toColumn) {
      if (fromPosition < toPosition) {
        db.prepare(
          'UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ? AND position <= ? AND id != ?',
        ).run(boardId, toColumn, fromPosition, toPosition, cardId);
      } else if (fromPosition > toPosition) {
        db.prepare(
          'UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ? AND position < ? AND id != ?',
        ).run(boardId, toColumn, toPosition, fromPosition, cardId);
      }
    } else {
      db.prepare(
        'UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ?',
      ).run(boardId, fromColumn, fromPosition);
      db.prepare(
        'UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ?',
      ).run(boardId, toColumn, toPosition);
    }

    db.prepare(
      "UPDATE cards SET column_name = ?, position = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(toColumn, toPosition, cardId);

    const movingToDone = isDoneColumn(toColumn, board) && !isDoneColumn(fromColumn, board);
    const movingFromDone = !isDoneColumn(toColumn, board) && isDoneColumn(fromColumn, board);

    if (movingToDone) {
      db.prepare('UPDATE cards SET is_done = 1 WHERE id = ?').run(cardId);
    } else if (movingFromDone) {
      db.prepare('UPDATE cards SET is_done = 0 WHERE id = ?').run(cardId);
    }

    // Normalize positions in affected columns
    normalizePositions(db, boardId, fromColumn);
    if (fromColumn !== toColumn) {
      normalizePositions(db, boardId, toColumn);
    }

    return { movingToDone, movingFromDone };
  });

  return moveTransaction();
}

// POST /api/cards — create a new card (appends to .md file + DB)
cards.post('/', async (c) => {
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = CreateCardSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const { board_id, title, column } = parsed.data;
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === board_id);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const filePath = path.join(config.vaultRoot, board.file);
  const colName = column || 'Backlog';

  // Column validation
  if (!board.columns.includes(colName)) {
    return c.json({ error: `Column "${colName}" not in board` }, 400);
  }

  // Append task to .md file with stable kb:id
  suppressWatcher();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const db = getDb();
    const id = allocateUniqueKbId((candidate) =>
      !!(db.prepare('SELECT 1 FROM cards WHERE id = ?').get(candidate)),
    );
    const newLine = injectKbId(`- [ ] ${title}`, id);
    const newContent = content.endsWith('\n')
      ? content + newLine + '\n'
      : content + '\n' + newLine + '\n';

    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, newContent, 'utf-8');
    renameSync(tmpPath, filePath);

    const lines = newContent.split('\n');
    const lineNumber = lines.length - 1; // last non-empty line

    // Insert into DB
    const maxPos = (db.prepare('SELECT MAX(position) as mp FROM cards WHERE board_id = ? AND column_name = ?').get(board_id, colName) as { mp: number | null }).mp ?? -1;

    // Get next seq_id for this board
    const maxSeqRow = db.prepare('SELECT COALESCE(MAX(seq_id), 0) as max_seq FROM cards WHERE board_id = ?').get(board_id) as { max_seq: number };
    const nextSeqId = maxSeqRow.max_seq + 1;

    db.prepare(`
      INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, labels, sub_items, source_fingerprint, seq_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, null, '[]', '[]', ?, ?)
    `).run(id, board_id, colName, maxPos + 1, title, newLine, lineNumber, createHash('sha256').update(newLine).digest('hex').slice(0, 16), nextSeqId);

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

    broadcast({ type: 'board-updated', boardId: board_id, timestamp: new Date().toISOString() });

    // Fire automations for card.created
    try {
      fireEvent({ type: 'card.created', cardId: id, boardId: board_id, column: colName, title });
    } catch (err) {
      console.warn('[automations] Error on card.created:', err);
    }

    return c.json(formatCard(card), 201);
  } catch (err) {
    return c.json({ error: `Failed to create card: ${err}` }, 500);
  } finally {
    unsuppressWatcher();
  }
});

// PATCH /api/cards/:id — update card metadata (unified move path for column/position changes)
cards.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await safeParseJson(c);
  if (body === null) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = PatchCardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Card not found' }, 404);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === existing.board_id);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const fields = parsed.data;

  // Column validation
  if (fields.column_name !== undefined && !board.columns.includes(fields.column_name)) {
    return c.json({ error: `Column "${fields.column_name}" not in board` }, 400);
  }
  if (fields.priority !== undefined && fields.priority !== null) {
    const validPriorityIds = new Set((board.priorities ?? DEFAULT_PRIORITIES).map((p) => p.id));
    if (!validPriorityIds.has(fields.priority)) {
      return c.json({ error: `Priority "${fields.priority}" not in board` }, 400);
    }
  }
  if (fields.labels !== undefined && board.categories && board.categories.length > 0) {
    const validCategoryIds = new Set(board.categories.map((c) => c.id));
    const unknown = fields.labels.filter((l) => !validCategoryIds.has(l));
    if (unknown.length > 0) {
      return c.json({ error: `Unknown category IDs: ${unknown.join(', ')}` }, 400);
    }
  }

  const columnChanging = fields.column_name !== undefined && fields.column_name !== existing.column_name;
  const positionChanging = fields.position !== undefined;
  const hasMetadataChanges = fields.labels !== undefined || fields.priority !== undefined ||
    fields.due_date !== undefined || fields.description !== undefined;

  if (!columnChanging && !positionChanging && !hasMetadataChanges) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // Unified move path: column or position change goes through executeMoveTransaction
  let movingToDone = false;
  let movingFromDone = false;
  const oldColumn = existing.column_name as string;

  if (columnChanging || positionChanging) {
    const fromColumn = oldColumn;
    const fromPosition = existing.position as number;
    const toColumn = fields.column_name ?? fromColumn;

    let toPosition: number;
    if (positionChanging) {
      toPosition = fields.position!;
    } else {
      // Append to end of target column
      const maxPos = (db.prepare('SELECT MAX(position) as mp FROM cards WHERE board_id = ? AND column_name = ?').get(existing.board_id, toColumn) as { mp: number | null }).mp;
      toPosition = (maxPos ?? -1) + 1;
    }

    const result = executeMoveTransaction(db, id, existing.board_id as string, fromColumn, fromPosition, toColumn, toPosition, board);
    movingToDone = result.movingToDone;
    movingFromDone = result.movingFromDone;
  }

  // Apply remaining metadata updates
  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.labels !== undefined) {
    sets.push('labels = ?');
    params.push(JSON.stringify(fields.labels));
  }
  if (fields.priority !== undefined) {
    sets.push('priority = ?');
    params.push(fields.priority);
  }
  if (fields.due_date !== undefined) {
    sets.push('due_date = ?');
    params.push(fields.due_date);
  }
  if (fields.description !== undefined) {
    sets.push('description = ?');
    params.push(fields.description);
  }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  // Write back priority to .md file
  if (fields.priority !== undefined) {
    suppressWatcher();
    try {
      const result = writeBackPriority(id, fields.priority ?? null);
      if (!result.success) {
        console.warn(`[writeback] Priority failed for card ${id}: ${result.error}`);
      }
    } finally {
      unsuppressWatcher();
    }
  }

  // Write back done state and column to .md file
  if (columnChanging) {
    if (movingToDone || movingFromDone) {
      suppressWatcher();
      try {
        const result = writeBackDoneState(id, movingToDone);
        if (!result.success) {
          console.warn(`[writeback] Done state failed for card ${id}: ${result.error}`);
        }
      } finally {
        unsuppressWatcher();
      }
    }
    suppressWatcher();
    try {
      const result = writeBackColumn(id, fields.column_name!);
      if (!result.success) {
        console.warn(`[writeback] Column failed for card ${id}: ${result.error}`);
      }
    } finally {
      unsuppressWatcher();
    }
  }

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  broadcast({
    type: 'card-moved',
    cardId: id,
    boardId: updated.board_id as string,
    timestamp: new Date().toISOString(),
  });

  // Fire automations for card.moved (only if column actually changed)
  if (columnChanging) {
    try {
      fireEvent({ type: 'card.moved', cardId: id, boardId: existing.board_id as string, fromColumn: oldColumn, toColumn: fields.column_name! });
    } catch (err) {
      console.warn('[automations] Error on card.moved:', err);
    }
  }

  return c.json(formatCard(updated));
});

// POST /api/cards/:id/move — move card to column + position (atomic transaction)
cards.post('/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = await safeParseJson(c);
  if (body === null) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = MoveCardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Card not found' }, 404);

  const config = loadConfig();
  const boardId = existing.board_id as string;
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const { column, position } = parsed.data;

  // Column validation
  if (!board.columns.includes(column)) {
    return c.json({ error: `Column "${column}" not in board` }, 400);
  }

  const oldColumn = existing.column_name as string;
  const oldPosition = existing.position as number;

  const { movingToDone, movingFromDone } = executeMoveTransaction(
    db, id, boardId, oldColumn, oldPosition, column, position, board,
  );

  // Write-back to .md file if moving to/from Done
  let writeBackError: string | undefined;
  if (movingToDone || movingFromDone) {
    suppressWatcher();
    try {
      const result = writeBackDoneState(id, movingToDone);
      if (!result.success) {
        writeBackError = result.error;
        console.warn(`[writeback] Failed for card ${id}: ${result.error}`);
      } else if (result.changed) {
        console.log(`[writeback] Card ${id} → ${movingToDone ? '[x]' : '[ ]'} at line ${result.lineNumber}`);
      }
    } catch (err) {
      writeBackError = String(err);
      console.error(`[writeback] Unexpected error for card ${id}:`, err);
    } finally {
      unsuppressWatcher();
    }
  }

  // Always write back column to .md for recovery
  if (oldColumn !== column) {
    suppressWatcher();
    try {
      const colResult = writeBackColumn(id, column);
      if (!colResult.success) {
        console.warn(`[writeback] Column failed for card ${id}: ${colResult.error}`);
      }
    } finally {
      unsuppressWatcher();
    }
  }

  const final = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  broadcast({
    type: 'card-moved',
    cardId: id,
    boardId: final.board_id as string,
    timestamp: new Date().toISOString(),
  });

  // Fire automations for card.moved (only if column actually changed)
  if (oldColumn !== column) {
    try {
      fireEvent({ type: 'card.moved', cardId: id, boardId, fromColumn: oldColumn, toColumn: column });
    } catch (err) {
      console.warn('[automations] Error on card.moved:', err);
    }
  }

  const response = formatCard(final);
  if (writeBackError) {
    return c.json({ ...response, _writeBackWarning: writeBackError });
  }
  return c.json(response);
});

// GET /api/cards/:id/comments — list comments for a card
cards.get('/:id/comments', (c) => {
  const cardId = c.req.param('id');
  const db = getDb();
  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(cardId);
  if (!card) return c.json({ error: 'Card not found' }, 404);

  const comments = db
    .prepare('SELECT * FROM comments WHERE card_id = ? ORDER BY created_at ASC')
    .all(cardId);
  return c.json(comments);
});

// POST /api/cards/:id/comments — add a comment
cards.post('/:id/comments', async (c) => {
  const cardId = c.req.param('id');
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = CreateCommentSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const card = db.prepare('SELECT id, board_id FROM cards WHERE id = ?').get(cardId) as
    | { id: string; board_id: string }
    | undefined;
  if (!card) return c.json({ error: 'Card not found' }, 404);

  const id = createHash('sha256')
    .update(`${cardId}|${Date.now()}|${Math.random()}`)
    .digest('hex')
    .slice(0, 12);

  db.prepare(
    `INSERT INTO comments (id, card_id, author, text) VALUES (?, ?, ?, ?)`,
  ).run(id, cardId, parsed.data.author, parsed.data.text);

  // Touch card updated_at
  db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);

  broadcast({
    type: 'card-updated',
    cardId,
    boardId: card.board_id,
    timestamp: new Date().toISOString(),
  });

  return c.json(comment, 201);
});

// PATCH /api/cards/:id/comments/:commentId — edit a comment
cards.patch('/:id/comments/:commentId', async (c) => {
  const cardId = c.req.param('id');
  const commentId = c.req.param('commentId');
  const body = await safeParseJson(c);
  if (body === null) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = UpdateCommentSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM comments WHERE id = ? AND card_id = ?')
    .get(commentId, cardId);
  if (!existing) return c.json({ error: 'Comment not found' }, 404);

  db.prepare(
    "UPDATE comments SET text = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(parsed.data.text, commentId);

  const updated = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  return c.json(updated);
});

// DELETE /api/cards/:id/comments/:commentId — delete a comment
cards.delete('/:id/comments/:commentId', (c) => {
  const cardId = c.req.param('id');
  const commentId = c.req.param('commentId');

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM comments WHERE id = ? AND card_id = ?')
    .get(commentId, cardId);
  if (!existing) return c.json({ error: 'Comment not found' }, 404);

  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  return c.json({ ok: true });
});

export default cards;
