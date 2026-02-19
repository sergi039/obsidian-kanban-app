import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { loadConfig } from '../config.js';
import { parseFilterQuery, compileFilter } from '../filter-engine.js';
import { formatCard } from '../utils.js';

const views = new Hono();

const CreateViewSchema = z.object({
  board_id: z.string(),
  name: z.string().min(1),
  layout: z.enum(['board', 'table']).default('board'),
  filter_query: z.string().default(''),
  sort_field: z.string().default('position'),
  sort_dir: z.enum(['ASC', 'DESC']).default('ASC'),
  group_by: z.string().default(''),
});

const UpdateViewSchema = z.object({
  name: z.string().min(1).optional(),
  layout: z.enum(['board', 'table']).optional(),
  filter_query: z.string().optional(),
  sort_field: z.string().optional(),
  sort_dir: z.enum(['ASC', 'DESC']).optional(),
  group_by: z.string().optional(),
  is_default: z.boolean().optional(),
});

function formatView(row: Record<string, unknown>) {
  return {
    ...row,
    is_default: Boolean(row.is_default),
  };
}

function generateId(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 10);
}


// GET /api/views — list views for a board
views.get('/', (c) => {
  const boardId = c.req.query('board_id');
  if (!boardId) return c.json({ error: 'board_id required' }, 400);

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM views WHERE board_id = ? ORDER BY is_default DESC, created_at ASC')
    .all(boardId) as Array<Record<string, unknown>>;
  return c.json(rows.map(formatView));
});

// POST /api/views — create a view
views.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = CreateViewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === parsed.data.board_id);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO views (id, board_id, name, layout, filter_query, sort_field, sort_dir, group_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parsed.data.board_id,
    parsed.data.name,
    parsed.data.layout,
    parsed.data.filter_query,
    parsed.data.sort_field,
    parsed.data.sort_dir,
    parsed.data.group_by,
  );

  const view = db.prepare('SELECT * FROM views WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json(formatView(view), 201);
});

// GET /api/views/:id — get a view
views.get('/:id', (c) => {
  const db = getDb();
  const view = db.prepare('SELECT * FROM views WHERE id = ?').get(c.req.param('id')) as Record<string, unknown> | undefined;
  if (!view) return c.json({ error: 'View not found' }, 404);
  return c.json(formatView(view));
});

// PATCH /api/views/:id — update a view
views.patch('/:id', async (c) => {
  const viewId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = UpdateViewSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const existing = db.prepare('SELECT * FROM views WHERE id = ?').get(viewId) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'View not found' }, 404);

  const fields = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.name !== undefined) { sets.push('name = ?'); params.push(fields.name); }
  if (fields.layout !== undefined) { sets.push('layout = ?'); params.push(fields.layout); }
  if (fields.filter_query !== undefined) { sets.push('filter_query = ?'); params.push(fields.filter_query); }
  if (fields.sort_field !== undefined) { sets.push('sort_field = ?'); params.push(fields.sort_field); }
  if (fields.sort_dir !== undefined) { sets.push('sort_dir = ?'); params.push(fields.sort_dir); }
  if (fields.group_by !== undefined) { sets.push('group_by = ?'); params.push(fields.group_by); }
  if (fields.is_default !== undefined) {
    if (fields.is_default) {
      // Unset other defaults for this board
      db.prepare("UPDATE views SET is_default = 0 WHERE board_id = ?").run(existing.board_id);
    }
    sets.push('is_default = ?');
    params.push(fields.is_default ? 1 : 0);
  }

  if (sets.length === 0) return c.json(formatView(existing));

  sets.push("updated_at = datetime('now')");
  params.push(viewId);
  db.prepare(`UPDATE views SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM views WHERE id = ?').get(viewId) as Record<string, unknown>;
  return c.json(formatView(updated));
});

// DELETE /api/views/:id — delete a view
views.delete('/:id', (c) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM views WHERE id = ?').get(c.req.param('id'));
  if (!existing) return c.json({ error: 'View not found' }, 404);
  db.prepare('DELETE FROM views WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

// GET /api/views/:id/cards — get cards for a view (applies filter + sort)
views.get('/:id/cards', (c) => {
  const db = getDb();
  const view = db.prepare('SELECT * FROM views WHERE id = ?').get(c.req.param('id')) as
    | { board_id: string; filter_query: string; sort_field: string; sort_dir: string; layout: string }
    | undefined;
  if (!view) return c.json({ error: 'View not found' }, 404);

  const parsed = parseFilterQuery(view.filter_query || '');
  const filter = compileFilter(parsed);

  // Validate sort field to prevent SQL injection
  const SAFE_SORT_FIELDS = new Set(['position', 'title', 'priority', 'due_date', 'created_at', 'updated_at', 'column_name', 'is_done']);
  const sortField = SAFE_SORT_FIELDS.has(view.sort_field) ? view.sort_field : 'position';
  const sortDir = view.sort_dir === 'DESC' ? 'DESC' : 'ASC';

  const sql = `SELECT * FROM cards WHERE board_id = ? AND ${filter.where} ORDER BY ${sortField} ${sortDir}`;
  const params = [view.board_id, ...filter.params];
  const cards = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return c.json(cards.map(formatCard));
});

export default views;
