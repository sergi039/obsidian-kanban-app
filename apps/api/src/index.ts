import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  const staticRoot = path.resolve(__dirname, '..', '..', 'web', 'dist');
  const { existsSync, readFileSync: readFs } = await import('node:fs');

  if (existsSync(staticRoot)) {
    // Serve static assets
    app.use('/*', serveStatic({ root: staticRoot }));

    // SPA fallback: serve index.html for non-API, non-asset routes
    app.get('*', (c) => {
      const indexPath = path.join(staticRoot, 'index.html');
      if (existsSync(indexPath)) {
        const html = readFs(indexPath, 'utf-8');
        return c.html(html);
      }
      return c.text('Not found', 404);
    });

    console.log(`[boot] Serving static files from ${staticRoot}`);
  } else {
    console.warn(`[boot] Static root not found: ${staticRoot} — run 'cd apps/web && npx vite build'`);
  }
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

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`[boot] Server listening on http://${HOST}:${PORT}`);
  console.log(`[boot] WebSocket available at ws://${HOST}:${PORT}/ws`);
});
