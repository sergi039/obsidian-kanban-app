import { Hono } from 'hono';
import { z } from 'zod';
import path from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { getDb } from '../db.js';
import { loadConfig, updateBoardColumns, resetConfigCache, addBoardToConfig, updateBoardInConfig, deleteBoardFromConfig } from '../config.js';
import { parseFilterQuery, compileFilter } from '../filter-engine.js';
import { reconcileBoard } from '../reconciler.js';
import { broadcast } from '../ws.js';
import { writeBackColumn } from '../writeback.js';
import { suppressWatcher, unsuppressWatcher, rebindWatcher } from '../watcher.js';
import { formatCard } from '../utils.js';

const boards = new Hono();

// GET /api/boards — list boards with task counts
// ?archived=true to include archived, ?archived=only for archived only
boards.get('/', (c) => {
  const config = loadConfig();
  const db = getDb();
  const archivedParam = c.req.query('archived');

  let filteredBoards = config.boards;
  if (archivedParam === 'only') {
    filteredBoards = config.boards.filter((b) => b.archived);
  } else if (archivedParam === 'true') {
    // show all
  } else {
    // default: hide archived
    filteredBoards = config.boards.filter((b) => !b.archived);
  }

  const countStmt = db.prepare(
    'SELECT column_name, COUNT(*) as count FROM cards WHERE board_id = ? GROUP BY column_name',
  );

  const list = filteredBoards.map((board) => {
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
      archived: board.archived || false,
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

// GET /api/boards/:id/cards — cards with filter engine
// Supports both legacy params (?column=&priority=&search=) and new ?q= query
boards.get('/:id/cards', (c) => {
  const config = loadConfig();
  const boardId = c.req.param('id');
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const db = getDb();
  const q = c.req.query('q');

  if (q) {
    // New filter engine
    const parsed = parseFilterQuery(q);
    const filter = compileFilter(parsed);

    const sql = `SELECT * FROM cards WHERE board_id = ? AND ${filter.where} ORDER BY position`;
    const params = [boardId, ...filter.params];
    const cards = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return c.json(cards.map(formatCard));
  }

  // Legacy params (backwards compatible)
  const column = c.req.query('column');
  const priority = c.req.query('priority');
  const search = c.req.query('search');

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

// --- Board management ---

const CreateBoardSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1).optional(),
  columns: z.array(z.string()).optional(),
});

const PatchBoardSchema = z.object({
  name: z.string().min(1).optional(),
  archived: z.boolean().optional(),
});

// POST /api/boards — create a new board
boards.post('/', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = CreateBoardSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const { name, file: fileOverride, columns: colOverride } = parsed.data;

  // Generate ID from name
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) return c.json({ error: 'Cannot generate ID from name' }, 400);
  if (config.boards.find((b) => b.id === id)) return c.json({ error: `Board "${id}" already exists` }, 409);

  // File path relative to vault root
  const relFile = fileOverride || `Tasks/${name}.md`;
  const absFile = path.resolve(config.vaultRoot, relFile);
  const columns = colOverride || config.defaultColumns || ['Backlog', 'In Progress', 'Done'];

  // Path traversal protection: resolved path must stay inside vaultRoot
  const normalizedVault = path.resolve(config.vaultRoot);
  if (!absFile.startsWith(normalizedVault + path.sep) && absFile !== normalizedVault) {
    return c.json({ error: 'File path must be within vault root' }, 400);
  }

  // Create .md file if it doesn't exist
  if (!existsSync(absFile)) {
    mkdirSync(path.dirname(absFile), { recursive: true });
    writeFileSync(absFile, `---\ntags:\n  - ${id}\n---\n`, 'utf-8');
  }

  // Add to config
  const added = addBoardToConfig({ id, name, file: relFile, columns });
  if (!added) return c.json({ error: 'Failed to add board to config' }, 500);

  // Reconcile the new board
  resetConfigCache();
  const freshConfig = loadConfig();
  const board = freshConfig.boards.find((b) => b.id === id);
  if (board) {
    const result = reconcileBoard(board, freshConfig.vaultRoot);
    console.log(`[boards] Created "${name}": +${result.added} cards`);
  }

  // Rebind watcher to include new board's file
  rebindWatcher(freshConfig);

  broadcast({ type: 'boards-changed', timestamp: new Date().toISOString() });

  return c.json({ id, name, file: relFile, columns, archived: false, totalCards: 0 }, 201);
});

// PATCH /api/boards/:id — rename or archive a board
boards.patch('/:id', async (c) => {
  const boardId = c.req.param('id');
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const parsed = PatchBoardSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const updated = updateBoardInConfig(boardId, parsed.data);
  if (!updated) return c.json({ error: 'Failed to update board' }, 500);

  const action = parsed.data.archived === true ? 'archived' : parsed.data.archived === false ? 'unarchived' : 'updated';
  console.log(`[boards] Board "${boardId}" ${action}`);

  broadcast({ type: 'boards-changed', timestamp: new Date().toISOString() });

  return c.json({ ok: true, ...parsed.data });
});

// DELETE /api/boards/:id — remove board from config (keeps .md file)
boards.delete('/:id', async (c) => {
  const boardId = c.req.param('id');
  const config = loadConfig();
  const board = config.boards.find((b) => b.id === boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  // Full cleanup: remove all related data from DB
  const db = getDb();
  const cardCount = (db.prepare('SELECT COUNT(*) as c FROM cards WHERE board_id = ?').get(boardId) as { c: number }).c;

  // Cards (cascades to comments and field_values via FK)
  db.prepare('DELETE FROM cards WHERE board_id = ?').run(boardId);
  // Fields (cascades to any remaining field_values)
  db.prepare('DELETE FROM fields WHERE board_id = ?').run(boardId);
  // Views
  db.prepare('DELETE FROM views WHERE board_id = ?').run(boardId);
  // Automations
  db.prepare('DELETE FROM automations WHERE board_id = ?').run(boardId);
  // Sync state
  const absFile = path.resolve(config.vaultRoot, board.file);
  db.prepare('DELETE FROM sync_state WHERE file_path = ?').run(absFile);

  const deleted = deleteBoardFromConfig(boardId);
  if (!deleted) return c.json({ error: 'Failed to delete board' }, 500);

  // Rebind watcher to exclude deleted board's file
  resetConfigCache();
  const freshConfig = loadConfig();
  rebindWatcher(freshConfig);

  console.log(`[boards] Deleted "${boardId}" (${cardCount} cards removed, .md file kept)`);

  broadcast({ type: 'boards-changed', timestamp: new Date().toISOString() });

  return c.json({ ok: true, cardsRemoved: cardCount });
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

  // Sync kb:col markers in .md file
  const affectedCards = db.prepare('SELECT id FROM cards WHERE board_id = ? AND column_name = ?').all(boardId, newName) as Array<{ id: string }>;
  if (affectedCards.length > 0) {
    suppressWatcher();
    try {
      for (const card of affectedCards) {
        writeBackColumn(card.id, newName);
      }
    } finally {
      unsuppressWatcher();
    }
  }

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

  // Sync kb:col markers in .md file for moved cards
  const movedCards = db.prepare('SELECT id FROM cards WHERE board_id = ? AND column_name = ?').all(boardId, target) as Array<{ id: string }>;
  if (movedCards.length > 0) {
    suppressWatcher();
    try {
      for (const card of movedCards) {
        writeBackColumn(card.id, target);
      }
    } finally {
      unsuppressWatcher();
    }
  }

  return c.json({ ok: true, columns: newColumns, movedTo: target });
});

export default boards;
