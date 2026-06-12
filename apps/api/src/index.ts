import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import {
  backupConfigFile,
  buildMissingConfigMessage,
  findLatestConfigBackup,
  rotateLogIfOversized,
} from './boot-resilience.js';
import { getDb } from './db.js';
import { reconcileAll } from './reconciler.js';
import { startWatcher } from './watcher.js';
import { stampAllColumns } from './writeback.js';
import { createWsServer } from './ws.js';
import { apiTokenAuth, bodyLimit, getCorsOrigins, securityHeaders } from './middleware/security.js';
import boardRoutes from './routes/boards.js';
import cardRoutes from './routes/cards.js';
import exportRoutes from './routes/export.js';
import inboxRoutes from './routes/inbox.js';
import viewRoutes from './routes/views.js';
import fieldRoutes from './routes/fields.js';
import automationRoutes from './routes/automations.js';
import reminderRoutes from './routes/reminders.js';

const app = new Hono();

// Security middleware
const corsOrigins = getCorsOrigins();
app.use('*', cors({
  origin: corsOrigins,
  allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));
app.use('*', logger());
app.use('*', securityHeaders());
app.use('/api/*', bodyLimit());
app.use('/api/*', apiTokenAuth());

app.route('/api/boards', boardRoutes);
app.route('/api/cards', cardRoutes);
app.route('/api/views', viewRoutes);
app.route('/api/fields', fieldRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/reminders', reminderRoutes);
app.route('/api/export', exportRoutes);
app.route('/api/inbox', inboxRoutes);

function buildHealth() {
  const cfg = loadConfig();
  const boards = cfg.boards.map((board) => {
    const abs = path.join(cfg.vaultRoot, board.file);
    let exists = false;
    let mtime: string | null = null;
    try {
      const stat = statSync(abs);
      exists = true;
      mtime = stat.mtime.toISOString();
    } catch {
      exists = false;
      mtime = null;
    }
    return { id: board.id, file: board.file, exists, mtime };
  });
  return { ok: true, vaultRoot: cfg.vaultRoot, boards };
}

app.get('/api/health', (c) => c.json(buildHealth()));

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
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { PROJECT_ROOT } from './config.js';

const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.boards.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// Rotate oversized LaunchAgent logs — a crash loop can grow them unbounded
for (const logName of ['api.stderr.log', 'api.stdout.log']) {
  const logPath = path.join(PROJECT_ROOT, 'logs', logName);
  try {
    if (rotateLogIfOversized(logPath)) {
      console.log(`[boot] Rotated oversized log: ${logName} → ${logName}.1`);
    }
  } catch (err) {
    console.warn(`[boot] Log rotation failed for ${logName}:`, err);
  }
}

function loadConfigOrExit(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    console.error(buildMissingConfigMessage({
      configPath: CONFIG_PATH,
      backupDir: DATA_DIR,
      examplePath: path.join(PROJECT_ROOT, 'config.boards.example.json'),
    }));
    process.exit(1);
  }
  try {
    return loadConfig();
  } catch (err) {
    console.error(`[boot] FATAL: could not load ${CONFIG_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    const latestBackup = findLatestConfigBackup(DATA_DIR);
    if (latestBackup) {
      console.error(`[boot] A known-good backup may exist: ${latestBackup}`);
    }
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const db = getDb();

// Backup config on startup (keeps last 3, skips if unchanged since last backup)
try {
  const configBackup = backupConfigFile(CONFIG_PATH, DATA_DIR);
  if (configBackup) {
    console.log(`[boot] Config backup: ${path.basename(configBackup)}`);
  }
} catch (err) {
  console.warn(`[boot] Config backup failed:`, err);
}

// Backup DB on startup (keeps last 3 backups)
const DB_PATH = path.join(DATA_DIR, 'kanban.db');
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

if (!existsSync(config.vaultRoot)) {
  console.error(`[boot] ERROR: vault root does not exist: ${config.vaultRoot} — sync will not work until this path is fixed`);
}
for (const board of config.boards) {
  const abs = path.join(config.vaultRoot, board.file);
  if (!existsSync(abs)) {
    console.error(`[boot] ERROR: board "${board.id}" file not found: ${abs} — this board will not sync`);
  }
}

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
  try {
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
          : await new Promise<string>((resolve, reject) => {
              const maxSize = Number(process.env.MAX_BODY_SIZE) || 1_048_576;
              let body = '';
              let size = 0;
              req.on('data', (chunk: Buffer | string) => {
                size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                if (size > maxSize) {
                  req.destroy();
                  reject(new Error('Body too large'));
                  return;
                }
                body += chunk;
              });
              req.on('end', () => resolve(body));
              req.on('error', reject);
            }),
      }),
    );

    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'Body too large';
    console.error('[server] Request handling error:', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = tooLarge ? 413 : 500;
    const message = tooLarge ? 'Body too large' : 'Internal server error';
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[boot] Port ${PORT} already in use — is another instance running?`);
    process.exit(1);
  }
  console.error('[boot] Server error:', err);
  process.exit(1);
});

// Attach WebSocket server
createWsServer(server);

const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`[boot] Server listening on http://${HOST}:${PORT}`);
  console.log(`[boot] WebSocket available at ws://${HOST}:${PORT}/ws`);
});

// Graceful shutdown
import { stopWatcher } from './watcher.js';
function shutdown(signal: string) {
  console.log(`\n[shutdown] ${signal} received, closing…`);
  stopWatcher();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ok */ }
  try { db.close(); } catch { /* ok */ }
  server.close(() => {
    console.log('[shutdown] Clean exit');
    process.exit(0);
  });
  // Force exit after 5s if server.close hangs
  setTimeout(() => { process.exit(1); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
