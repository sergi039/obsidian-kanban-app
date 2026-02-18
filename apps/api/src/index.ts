import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { reconcileAll } from './reconciler.js';
import { startWatcher } from './watcher.js';
import boardRoutes from './routes/boards.js';
import cardRoutes from './routes/cards.js';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

app.route('/api/boards', boardRoutes);
app.route('/api/cards', cardRoutes);

app.get('/api/health', (c) => c.json({ ok: true }));

// --- Bootstrap ---
const config = loadConfig();
const db = getDb();

console.log(`[boot] Loaded ${config.boards.length} boards from config`);
console.log(`[boot] Vault root: ${config.vaultRoot}`);

// Initial sync
const results = reconcileAll(config.vaultRoot, config.boards);
for (const r of results) {
  console.log(`[boot] ${r.boardId}: +${r.added} ~${r.updated} -${r.removed}`);
}

// File watcher
startWatcher(config);

const PORT = Number(process.env.PORT) || 4000;
console.log(`[boot] Server listening on http://localhost:${PORT}`);

serve({ fetch: app.fetch, port: PORT });
