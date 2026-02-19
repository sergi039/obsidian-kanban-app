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
import { stampAllColumns } from './writeback.js';
import { createWsServer } from './ws.js';
import boardRoutes from './routes/boards.js';
import cardRoutes from './routes/cards.js';
import exportRoutes from './routes/export.js';
import viewRoutes from './routes/views.js';
import fieldRoutes from './routes/fields.js';
import automationRoutes from './routes/automations.js';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());

app.route('/api/boards', boardRoutes);
app.route('/api/cards', cardRoutes);
app.route('/api/views', viewRoutes);
app.route('/api/fields', fieldRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/export', exportRoutes);

app.get('/api/health', (c) => c.json({ ok: true }));

// Serve built frontend in production
if (process.env.NODE_ENV === 'production' || process.env.SERVE_STATIC) {
  const { serveStatic } = await import('@hono/node-server/serve-static');
  const staticRoot = path.resolve(__dirname, '..', '..', 'web', 'dist');
  const { existsSync, readFileSync: readFs } = await import('node:fs');

  if (existsSync(staticRoot)) {
    // Serve static assets (including /about/index.html etc.)
    app.use('/*', serveStatic({ root: staticRoot }));

    // SPA fallback: serve index.html for non-API, non-asset routes
    // Skip paths that have their own index.html (like /about/)
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      const pathname = url.pathname.replace(/\/$/, '') || '';

      // Check if there's a specific index.html for this path
      const subIndex = path.join(staticRoot, pathname, 'index.html');
      if (pathname && existsSync(subIndex)) {
        const html = readFs(subIndex, 'utf-8');
        return c.html(html);
      }

      // Default SPA fallback
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

// Backup DB on startup (keeps last 3 backups)
import { copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { PROJECT_ROOT } from './config.js';
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'kanban.db');
try {
  if (existsSync(DB_PATH)) {
    const backupDir = path.dirname(DB_PATH);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `kanban.backup-${ts}.db`);
    // Checkpoint WAL before backup
    db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(DB_PATH, backupPath);
    console.log(`[boot] DB backup: ${path.basename(backupPath)}`);
    // Keep only last 3 backups
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith('kanban.backup-') && f.endsWith('.db'))
      .sort()
      .reverse();
    for (const old of backups.slice(3)) {
      unlinkSync(path.join(backupDir, old));
    }
  }
} catch (err) {
  console.warn(`[boot] DB backup failed:`, err);
}

console.log(`[boot] Loaded ${config.boards.length} boards from config`);
console.log(`[boot] Vault root: ${config.vaultRoot}`);

// Initial sync
const results = reconcileAll(config.vaultRoot, config.boards);
for (const r of results) {
  console.log(`[boot] ${r.boardId}: +${r.added} ~${r.updated} -${r.removed}${r.migrated ? ` 🔑${r.migrated} migrated` : ''}`);
}

// Stamp column assignments into .md files (recovery markers)
const stamped = stampAllColumns();
if (stamped > 0) {
  console.log(`[boot] Stamped kb:col markers on ${stamped} cards`);
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
