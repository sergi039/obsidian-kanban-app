import { Hono } from 'hono';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { loadConfig } from '../config.js';

const fields = new Hono();

const FieldTypeEnum = z.enum(['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT', 'ITERATION']);

const SelectOption = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
});

const CreateFieldSchema = z.object({
  board_id: z.string(),
  name: z.string().min(1),
  type: FieldTypeEnum.default('TEXT'),
  options: z.array(SelectOption).default([]),
});

const UpdateFieldSchema = z.object({
  name: z.string().min(1).optional(),
  type: FieldTypeEnum.optional(),
  options: z.array(SelectOption).optional(),
  position: z.number().int().optional(),
});

const SetFieldValueSchema = z.object({
  value: z.string().nullable(),
});

function generateId(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 10);
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function formatField(row: Record<string, unknown>) {
  return {
    ...row,
    options: safeJsonParse(row.options as string, []),
  };
}

// GET /api/fields?board_id= — list fields for a board
fields.get('/', (c) => {
  const boardId = c.req.query('board_id');
  if (!boardId) return c.json({ error: 'board_id required' }, 400);

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM fields WHERE board_id = ? ORDER BY position ASC, created_at ASC')
    .all(boardId) as Array<Record<string, unknown>>;

  return c.json(rows.map(formatField));
});

// POST /api/fields — create a field
fields.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = CreateFieldSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === parsed.data.board_id);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const db = getDb();

  // Check for duplicate name
  const existing = db.prepare('SELECT id FROM fields WHERE board_id = ? AND name = ?')
    .get(parsed.data.board_id, parsed.data.name);
  if (existing) return c.json({ error: 'Field with this name already exists' }, 409);

  const id = generateId();
  const maxPos = (db.prepare('SELECT MAX(position) as mp FROM fields WHERE board_id = ?')
    .get(parsed.data.board_id) as { mp: number | null }).mp ?? -1;

  db.prepare(
    'INSERT INTO fields (id, board_id, name, type, options, position) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, parsed.data.board_id, parsed.data.name, parsed.data.type, JSON.stringify(parsed.data.options), maxPos + 1);

  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(id) as Record<string, unknown>;
  return c.json(formatField(field), 201);
});

// PATCH /api/fields/:id — update a field
fields.patch('/:id', async (c) => {
  const fieldId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = UpdateFieldSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const existing = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: 'Field not found' }, 404);

  const sets: string[] = [];
  const params: unknown[] = [];
  const f = parsed.data;

  if (f.name !== undefined) { sets.push('name = ?'); params.push(f.name); }
  if (f.type !== undefined) { sets.push('type = ?'); params.push(f.type); }
  if (f.options !== undefined) { sets.push('options = ?'); params.push(JSON.stringify(f.options)); }
  if (f.position !== undefined) { sets.push('position = ?'); params.push(f.position); }

  if (sets.length === 0) return c.json(formatField(existing));

  params.push(fieldId);
  db.prepare(`UPDATE fields SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown>;
  return c.json(formatField(updated));
});

// DELETE /api/fields/:id — delete a field (and all its values)
fields.delete('/:id', (c) => {
  const fieldId = c.req.param('id');
  const db = getDb();
  const existing = db.prepare('SELECT id FROM fields WHERE id = ?').get(fieldId);
  if (!existing) return c.json({ error: 'Field not found' }, 404);

  db.prepare('DELETE FROM field_values WHERE field_id = ?').run(fieldId);
  db.prepare('DELETE FROM fields WHERE id = ?').run(fieldId);
  return c.json({ ok: true });
});

// GET /api/fields/values?card_id= — get all field values for a card
fields.get('/values', (c) => {
  const cardId = c.req.query('card_id');
  if (!cardId) return c.json({ error: 'card_id required' }, 400);

  const db = getDb();
  const rows = db.prepare(`
    SELECT fv.field_id, fv.value, f.name, f.type, f.options
    FROM field_values fv
    JOIN fields f ON f.id = fv.field_id
    WHERE fv.card_id = ?
    ORDER BY f.position ASC
  `).all(cardId) as Array<Record<string, unknown>>;

  return c.json(rows.map((r) => ({
    field_id: r.field_id,
    field_name: r.name,
    field_type: r.type,
    options: safeJsonParse(r.options as string, []),
    value: r.value,
  })));
});

// PUT /api/fields/:fieldId/values/:cardId — set a field value for a card
fields.put('/:fieldId/values/:cardId', async (c) => {
  const fieldId = c.req.param('fieldId');
  const cardId = c.req.param('cardId');

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = SetFieldValueSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const db = getDb();
  const field = db.prepare('SELECT * FROM fields WHERE id = ?').get(fieldId) as Record<string, unknown> | undefined;
  if (!field) return c.json({ error: 'Field not found' }, 404);
  const card = db.prepare('SELECT id, board_id FROM cards WHERE id = ?').get(cardId) as { id: string; board_id: string } | undefined;
  if (!card) return c.json({ error: 'Card not found' }, 404);

  // Board integrity: field and card must belong to the same board
  if (card.board_id !== field.board_id) {
    return c.json({ error: 'Field and card belong to different boards' }, 400);
  }

  // Validate value against field type
  let value = parsed.data.value;
  if (value !== null) {
    const type = field.type as string;
    if (type === 'NUMBER') {
      if (value.trim().length === 0 || !Number.isFinite(Number(value))) {
        return c.json({ error: 'Value must be a finite number' }, 400);
      }
    }
    if (type === 'DATE') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return c.json({ error: 'Value must be a date (YYYY-MM-DD)' }, 400);
      }
      const [y, m, d] = value.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
        return c.json({ error: 'Invalid calendar date' }, 400);
      }
    }
    if (type === 'ITERATION') {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return c.json({ error: 'Iteration value must be a non-empty string' }, 400);
      }
    }
    if (type === 'SINGLE_SELECT') {
      const options = safeJsonParse<Array<{ id: string; name: string }>>(field.options as string, []);
      const match = options.find((o) => o.id === value || o.name === value);
      if (!match) {
        return c.json({ error: `Value must be one of: ${options.map((o) => o.name).join(', ')}` }, 400);
      }
      // Always normalize to option.id for canonical storage
      value = match.id;
    }
  }

  if (value === null) {
    db.prepare('DELETE FROM field_values WHERE card_id = ? AND field_id = ?').run(cardId, fieldId);
  } else {
    db.prepare(
      'INSERT OR REPLACE INTO field_values (card_id, field_id, value) VALUES (?, ?, ?)'
    ).run(cardId, fieldId, value);
  }

  // Touch card updated_at
  db.prepare("UPDATE cards SET updated_at = datetime('now') WHERE id = ?").run(cardId);

  return c.json({ ok: true, card_id: cardId, field_id: fieldId, value });
});

export default fields;
