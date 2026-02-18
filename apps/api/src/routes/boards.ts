import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db.js';
import { loadConfig, updateBoardColumns, resetConfigCache } from '../config.js';

const boards = new Hono();

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatCard(card: Record<string, unknown>) {
  return {
    ...card,
    is_done: Boolean(card.is_done),
    labels: safeJsonParse<string[]>(card.labels as string, []),
    sub_items: safeJsonParse<string[]>(card.sub_items as string, []),
  };
}

// GET /api/boards — list all boards with task counts
boards.get('/', (c) => {
  const config = loadConfig();
  const db = getDb();

  const countStmt = db.prepare(
    'SELECT column_name, COUNT(*) as count FROM cards WHERE board_id = ? GROUP BY column_name',
  );

  const list = config.boards.map((board) => {
    const rows = countStmt.all(board.id) as Array<{ column_name: string; count: number }>;
    const columnCounts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      columnCounts[r.column_name] = r.count;
      total += r.count;
    }
    return {
      id: board.id,
      name: board.name,
      file: board.file,
      columns: board.columns,
      totalCards: total,
      columnCounts,
    };
  });

  return c.json(list);
});

// GET /api/boards/:id — board detail with columns and cards
boards.get('/:id', (c) => {
  const config = loadConfig();
  const boardId = c.req.param('id');
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const db = getDb();
  const cards = db
    .prepare('SELECT * FROM cards WHERE board_id = ? ORDER BY position')
    .all(boardId) as Array<Record<string, unknown>>;

  const columns = board.columns.map((col) => ({
    name: col,
    cards: cards.filter((card) => card.column_name === col).map(formatCard),
  }));

  return c.json({
    id: board.id,
    name: board.name,
    file: board.file,
    columns,
  });
});

// GET /api/boards/:id/cards — cards with filters
boards.get('/:id/cards', (c) => {
  const config = loadConfig();
  const boardId = c.req.param('id');
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const column = c.req.query('column');
  const priority = c.req.query('priority');
  const search = c.req.query('search');

  const db = getDb();
  let sql = 'SELECT * FROM cards WHERE board_id = ?';
  const params: unknown[] = [boardId];

  if (column) {
    sql += ' AND column_name = ?';
    params.push(column);
  }
  if (priority) {
    sql += ' AND priority = ?';
    params.push(priority);
  }
  if (search) {
    sql += ' AND title LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ' ORDER BY position';

  const cards = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return c.json(cards.map(formatCard));
});

// POST /api/boards/sync/reload — force re-parse all files
boards.post('/sync/reload', async (c) => {
  try {
    resetConfigCache();
    const config = loadConfig();
    const { reconcileAll } = await import('../reconciler.js');
    const results = reconcileAll(config.vaultRoot, config.boards);
    return c.json({ ok: true, results });
  } catch (err) {
    console.error('[sync/reload] Error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// --- Column management ---

const AddColumnSchema = z.object({ name: z.string().min(1) });
const RenameColumnSchema = z.object({ oldName: z.string(), newName: z.string().min(1) });
const DeleteColumnSchema = z.object({ name: z.string(), moveTo: z.string().optional() });
const ReorderColumnsSchema = z.object({ columns: z.array(z.string()).min(1) });

// POST /api/boards/:id/columns — add a column
boards.post('/:id/columns', async (c) => {
  const boardId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = AddColumnSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  if (board.columns.includes(parsed.data.name)) {
    return c.json({ error: 'Column already exists' }, 409);
  }

  const newColumns = [...board.columns, parsed.data.name];
  updateBoardColumns(boardId, newColumns);
  return c.json({ ok: true, columns: newColumns }, 201);
});

// PUT /api/boards/:id/columns — reorder all columns
boards.put('/:id/columns', async (c) => {
  const boardId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = ReorderColumnsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  updateBoardColumns(boardId, parsed.data.columns);
  return c.json({ ok: true, columns: parsed.data.columns });
});

// PATCH /api/boards/:id/columns/rename — rename a column
boards.patch('/:id/columns/rename', async (c) => {
  const boardId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = RenameColumnSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const { oldName, newName } = parsed.data;
  const idx = board.columns.indexOf(oldName);
  if (idx === -1) return c.json({ error: `Column "${oldName}" not found` }, 404);

  const newColumns = [...board.columns];
  newColumns[idx] = newName;
  updateBoardColumns(boardId, newColumns);

  // Update cards in DB
  const db = getDb();
  db.prepare('UPDATE cards SET column_name = ? WHERE board_id = ? AND column_name = ?').run(newName, boardId, oldName);

  return c.json({ ok: true, columns: newColumns });
});

// DELETE /api/boards/:id/columns — delete a column (move cards to another)
boards.delete('/:id/columns', async (c) => {
  const boardId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = DeleteColumnSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const { name, moveTo } = parsed.data;
  if (!board.columns.includes(name)) return c.json({ error: `Column "${name}" not found` }, 404);

  const target = moveTo || board.columns.find((c) => c !== name) || 'Backlog';
  const newColumns = board.columns.filter((c) => c !== name);
  if (newColumns.length === 0) return c.json({ error: 'Cannot delete last column' }, 400);

  updateBoardColumns(boardId, newColumns);

  // Move cards from deleted column
  const db = getDb();
  db.prepare('UPDATE cards SET column_name = ? WHERE board_id = ? AND column_name = ?').run(target, boardId, name);

  return c.json({ ok: true, columns: newColumns, movedTo: target });
});

export default boards;
