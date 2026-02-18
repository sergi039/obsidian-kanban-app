import { createServer } from 'node:http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './config.js';
import { getDb } from './db.js';
import { reconcileAll } from './reconciler.js';
import { startWatcher } from './watcher.js';
import { createWsServer } from './ws.js';
import boardRoutes from './routes/boards.js';
import cardRoutes from './routes/cards.js';
import exportRoutes from './routes/export.js';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

app.route('/api/boards', boardRoutes);
app.route('/api/cards', cardRoutes);
app.route('/api/export', exportRoutes);

app.get('/api/health', (c) => c.json({ ok: true }));

// Serve built frontend in production
if (process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC) {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  app.use('/*', serveStatic({ root: '../web/dist' }));
}

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

// HTTP + WebSocket server
const PORT = Number(process.env.PORT) || 4000;

const server = createServer(async (req, res) => {
  const response = await app.fetch(
    new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).reduce(
        (acc, [k, v]) => {
          if (v) acc[k] = Array.isArray(v) ? v.join(', ') : v;
          return acc;
        },
        {} as Record<string, string>,
      ),
      body: ['GET', 'HEAD'].includes(req.method || 'GET')
        ? undefined
        : await new Promise<string>((resolve) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => resolve(body));
          }),
    }),
  );

  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  const body = await response.arrayBuffer();
  res.end(Buffer.from(body));
});

// Attach WebSocket server
createWsServer(server);

server.listen(PORT, () => {
  console.log(`[boot] Server listening on http://localhost:${PORT}`);
  console.log(`[boot] WebSocket available at ws://localhost:${PORT}/ws`);
});
