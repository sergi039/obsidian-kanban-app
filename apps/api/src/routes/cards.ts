import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getDb } from '../db.js';
import { loadConfig } from '../config.js';
import { writeBackDoneState } from '../writeback.js';
import { broadcast } from '../ws.js';
import { suppressWatcher, unsuppressWatcher } from '../watcher.js';

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
  priority: z.enum(['high', 'urgent']).nullable().optional(),
  due_date: z.string().nullable().optional(),
});

const MoveCardSchema = z.object({
  column: z.string(),
  position: z.number().int(),
});

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatCard(row: Record<string, unknown>) {
  return {
    ...row,
    is_done: Boolean(row.is_done),
    labels: safeJsonParse<string[]>(row.labels as string, []),
    sub_items: safeJsonParse<string[]>(row.sub_items as string, []),
  };
}

async function safeParseJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
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

  // Append task to .md file
  suppressWatcher();
  try {
    const content = readFileSync(filePath, 'utf-8');
    const newLine = `- [ ] ${title}`;
    const newContent = content.endsWith('\n')
      ? content + newLine + '\n'
      : content + '\n' + newLine + '\n';

    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, newContent, 'utf-8');
    renameSync(tmpPath, filePath);

    const lines = newContent.split('\n');
    const lineNumber = lines.length - 1; // last non-empty line

    // Insert into DB
    const db = getDb();
    const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
    const existingCount = (db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE board_id = ? AND LOWER(title) = ?').get(board_id, normalized) as { cnt: number }).cnt;
    const id = createHash('sha256').update(
      existingCount === 0 ? `${normalized}|${board_id}` : `${normalized}|${board_id}|dup${existingCount}`
    ).digest('hex').slice(0, 8);

    const maxPos = (db.prepare('SELECT MAX(position) as mp FROM cards WHERE board_id = ? AND column_name = ?').get(board_id, colName) as { mp: number | null }).mp ?? -1;

    db.prepare(`
      INSERT INTO cards (id, board_id, column_name, position, title, raw_line, line_number, is_done, priority, labels, sub_items, source_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, null, '[]', '[]', ?)
    `).run(id, board_id, colName, maxPos + 1, title, newLine, lineNumber, createHash('sha256').update(newLine).digest('hex').slice(0, 16));

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

    broadcast({ type: 'board-updated', boardId: board_id, timestamp: new Date().toISOString() });

    return c.json(formatCard(card), 201);
  } catch (err) {
    return c.json({ error: `Failed to create card: ${err}` }, 500);
  } finally {
    unsuppressWatcher();
  }
});

// PATCH /api/cards/:id — update card metadata
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
  const existing = db.prepare('SELECT id FROM cards WHERE id = ?').get(id);
  if (!existing) return c.json({ error: 'Card not found' }, 404);

  const fields = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.column_name !== undefined) {
    sets.push('column_name = ?');
    params.push(fields.column_name);
  }
  if (fields.position !== undefined) {
    sets.push('position = ?');
    params.push(fields.position);
  }
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

  if (sets.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  broadcast({
    type: 'card-moved',
    cardId: id,
    boardId: updated.board_id as string,
    timestamp: new Date().toISOString(),
  });

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

  const { column, position } = parsed.data;
  const oldColumn = existing.column_name as string;
  const oldPosition = existing.position as number;
  const boardId = existing.board_id as string;

  // Atomic move transaction: handles same-column and cross-column moves correctly
  const moveTransaction = db.transaction(() => {
    if (oldColumn === column) {
      // Same column: shift cards between old and new position
      if (oldPosition < position) {
        // Moving down: shift cards in [old+1, new] up by 1
        db.prepare(
          `UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ? AND position <= ? AND id != ?`,
        ).run(boardId, column, oldPosition, position, id);
      } else if (oldPosition > position) {
        // Moving up: shift cards in [new, old-1] down by 1
        db.prepare(
          `UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ? AND position < ? AND id != ?`,
        ).run(boardId, column, position, oldPosition, id);
      }
    } else {
      // Cross-column: close gap in source, make room in target
      db.prepare(
        `UPDATE cards SET position = position - 1 WHERE board_id = ? AND column_name = ? AND position > ?`,
      ).run(boardId, oldColumn, oldPosition);

      db.prepare(
        `UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ?`,
      ).run(boardId, column, position);
    }

    // Set the card's new column and position
    db.prepare(
      `UPDATE cards SET column_name = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(column, position, id);

    // Update is_done based on column
    const movingToDone = column === 'Done' && oldColumn !== 'Done';
    const movingFromDone = column !== 'Done' && oldColumn === 'Done';

    if (movingToDone) {
      db.prepare('UPDATE cards SET is_done = 1 WHERE id = ?').run(id);
    } else if (movingFromDone) {
      db.prepare('UPDATE cards SET is_done = 0 WHERE id = ?').run(id);
    }

    return { movingToDone, movingFromDone };
  });

  const { movingToDone, movingFromDone } = moveTransaction();

  // Write-back to .md file if moving to/from Done (outside transaction)
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

  const final = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  broadcast({
    type: 'card-moved',
    cardId: id,
    boardId: final.board_id as string,
    timestamp: new Date().toISOString(),
  });

  const response = formatCard(final);
  if (writeBackError) {
    return c.json({ ...response, _writeBackWarning: writeBackError });
  }
  return c.json(response);
});

export default cards;
