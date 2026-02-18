import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db.js';
import { writeBackDoneState } from '../writeback.js';
import { broadcast } from '../ws.js';
import { suppressWatcher, unsuppressWatcher } from '../watcher.js';

const cards = new Hono();

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

function formatCard(row: Record<string, unknown>) {
  return {
    ...row,
    is_done: Boolean(row.is_done),
    labels: JSON.parse(row.labels as string),
    sub_items: JSON.parse(row.sub_items as string),
  };
}

// PATCH /api/cards/:id — update card metadata
cards.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
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

// POST /api/cards/:id/move — move card to column + position
cards.post('/:id/move', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = MoveCardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const db = getDb();
  const existing = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Card not found' }, 404);

  const { column, position } = parsed.data;
  const oldColumn = existing.column_name as string;

  // Shift positions in the target column to make room
  db.prepare(
    `UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ?`,
  ).run(existing.board_id, column, position);

  db.prepare(
    `UPDATE cards SET column_name = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(column, position, id);

  // Write-back to .md file if moving to/from Done
  const movingToDone = column === 'Done' && oldColumn !== 'Done';
  const movingFromDone = column !== 'Done' && oldColumn === 'Done';

  if (movingToDone || movingFromDone) {
    suppressWatcher();
    const result = writeBackDoneState(id, movingToDone);
    unsuppressWatcher();

    if (!result.success) {
      console.warn(`[writeback] Failed for card ${id}: ${result.error}`);
    } else if (result.changed) {
      console.log(`[writeback] Card ${id} → ${movingToDone ? '[x]' : '[ ]'} at line ${result.lineNumber}`);
    }
  }

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  // Also update is_done in DB to match
  if (movingToDone) {
    db.prepare('UPDATE cards SET is_done = 1 WHERE id = ?').run(id);
  } else if (movingFromDone) {
    db.prepare('UPDATE cards SET is_done = 0 WHERE id = ?').run(id);
  }

  const final = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;

  broadcast({
    type: 'card-moved',
    cardId: id,
    boardId: final.board_id as string,
    timestamp: new Date().toISOString(),
  });

  return c.json(formatCard(final));
});

export default cards;
