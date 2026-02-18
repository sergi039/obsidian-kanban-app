import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db.js';

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
  return c.json({
    ...updated,
    is_done: Boolean(updated.is_done),
    labels: JSON.parse(updated.labels as string),
    sub_items: JSON.parse(updated.sub_items as string),
  });
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

  // Shift positions in the target column to make room
  db.prepare(
    `UPDATE cards SET position = position + 1 WHERE board_id = ? AND column_name = ? AND position >= ?`,
  ).run(existing.board_id, column, position);

  db.prepare(
    `UPDATE cards SET column_name = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(column, position, id);

  const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json({
    ...updated,
    is_done: Boolean(updated.is_done),
    labels: JSON.parse(updated.labels as string),
    sub_items: JSON.parse(updated.sub_items as string),
  });
});

export default cards;
