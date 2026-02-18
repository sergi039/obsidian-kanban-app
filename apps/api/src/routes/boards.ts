import { Hono } from 'hono';
import { getDb } from '../db.js';
import { loadConfig } from '../config.js';
import { reconcileAll } from '../reconciler.js';

const boards = new Hono();

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
    cards: cards
      .filter((card) => card.column_name === col)
      .map((card) => ({
        ...card,
        is_done: Boolean(card.is_done),
        labels: JSON.parse(card.labels as string),
        sub_items: JSON.parse(card.sub_items as string),
      })),
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
  const result = cards.map((card) => ({
    ...card,
    is_done: Boolean(card.is_done),
    labels: JSON.parse(card.labels as string),
    sub_items: JSON.parse(card.sub_items as string),
  }));

  return c.json(result);
});

// POST /api/sync/reload — force re-parse all files
boards.post('/sync/reload', (c) => {
  const config = loadConfig();
  const results = reconcileAll(config.vaultRoot, config.boards);
  return c.json({ ok: true, results });
});

export default boards;
