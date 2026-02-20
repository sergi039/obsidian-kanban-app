import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import Database from 'better-sqlite3';

let testDb: InstanceType<typeof Database>;

vi.mock('../../src/db.js', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  return {
    PriorityDefSchema: actual.PriorityDefSchema,
    CategoryDefSchema: actual.CategoryDefSchema,
    loadConfig: () => ({
      vaultRoot: '/tmp/test-vault',
      boards: [{ id: 'b1', name: 'Test', file: 'Tasks/Test.md', columns: ['Backlog', 'Done'] }],
      defaultColumns: ['Backlog', 'Done'],
    }),
    DEFAULT_PRIORITIES: [
      { id: 'urgent', emoji: '🔺', label: 'Urgent', color: '#ef4444' },
      { id: 'high', emoji: '⏫', label: 'High', color: '#f59e0b' },
    ],
    PROJECT_ROOT: '/tmp/test',
    resetConfigCache: vi.fn(),
    updateBoardColumns: vi.fn(() => true),
    addBoardToConfig: vi.fn(() => true),
    updateBoardInConfig: vi.fn(() => true),
    deleteBoardFromConfig: vi.fn(() => true),
  };
});

vi.mock('../../src/ws.js', () => ({
  broadcast: vi.fn(),
}));

vi.mock('../../src/reconciler.js', () => ({
  reconcileBoard: vi.fn(() => ({ boardId: 'b1', added: 0, removed: 0, updated: 0, migrated: 0 })),
  reconcileAll: vi.fn(() => []),
}));

vi.mock('../../src/watcher.js', () => ({
  suppressWatcher: vi.fn(),
  unsuppressWatcher: vi.fn(),
  rebindWatcher: vi.fn(),
}));

vi.mock('../../src/writeback.js', () => ({
  writeBackDoneState: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackPriority: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
  writeBackColumn: vi.fn(() => ({ success: true, changed: true, lineNumber: 1 })),
}));

vi.mock('../../src/automations.js', () => ({
  fireEvent: vi.fn(() => ({ rulesFired: 0, totalActions: 0, errors: [] })),
}));

// --- Auth middleware tests ---

describe('API token authentication', () => {
  it('returns 401 for mutating request without token when API_TOKEN is set', async () => {
    const { apiTokenAuth } = await import('../../src/middleware/security.js');

    // Simulate API_TOKEN env
    const originalToken = process.env.API_TOKEN;
    process.env.API_TOKEN = 'test-secret-token';

    try {
      const app = new Hono();
      // We need to re-import to pick up env change
      const middleware = apiTokenAuth();
      app.use('/api/*', middleware);
      app.post('/api/test', (c) => c.json({ ok: true }));
      app.get('/api/test', (c) => c.json({ ok: true }));

      // POST without token -> 401
      const res = await app.request('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toMatch(/authorization/i);
    } finally {
      if (originalToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = originalToken;
    }
  });

  it('allows mutating request with valid token', async () => {
    const { apiTokenAuth } = await import('../../src/middleware/security.js');

    const originalToken = process.env.API_TOKEN;
    process.env.API_TOKEN = 'test-secret-token';

    try {
      const app = new Hono();
      app.use('/api/*', apiTokenAuth());
      app.post('/api/test', (c) => c.json({ ok: true }));

      const res = await app.request('/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret-token',
        },
        body: '{}',
      });
      expect(res.status).toBe(200);
    } finally {
      if (originalToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = originalToken;
    }
  });

  it('allows GET requests without token', async () => {
    const { apiTokenAuth } = await import('../../src/middleware/security.js');

    const originalToken = process.env.API_TOKEN;
    process.env.API_TOKEN = 'test-secret-token';

    try {
      const app = new Hono();
      app.use('/api/*', apiTokenAuth());
      app.get('/api/test', (c) => c.json({ ok: true }));

      const res = await app.request('/api/test', { method: 'GET' });
      expect(res.status).toBe(200);
    } finally {
      if (originalToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = originalToken;
    }
  });

  it('returns 401 for invalid token', async () => {
    const { apiTokenAuth } = await import('../../src/middleware/security.js');

    const originalToken = process.env.API_TOKEN;
    process.env.API_TOKEN = 'test-secret-token';

    try {
      const app = new Hono();
      app.use('/api/*', apiTokenAuth());
      app.post('/api/test', (c) => c.json({ ok: true }));

      const res = await app.request('/api/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      if (originalToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = originalToken;
    }
  });

  it('skips auth when API_TOKEN env is not set', async () => {
    const { apiTokenAuth } = await import('../../src/middleware/security.js');

    const originalToken = process.env.API_TOKEN;
    delete process.env.API_TOKEN;

    try {
      const app = new Hono();
      app.use('/api/*', apiTokenAuth());
      app.post('/api/test', (c) => c.json({ ok: true }));

      const res = await app.request('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
    } finally {
      if (originalToken !== undefined) process.env.API_TOKEN = originalToken;
    }
  });
});

// --- Body size limit tests ---

describe('body size limit', () => {
  it('returns 413 for oversized Content-Length', async () => {
    const { bodyLimit } = await import('../../src/middleware/security.js');

    const app = new Hono();
    app.use('/api/*', bodyLimit());
    app.post('/api/test', (c) => c.json({ ok: true }));

    const res = await app.request('/api/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '999999999',
      },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('allows normal-sized request', async () => {
    const { bodyLimit } = await import('../../src/middleware/security.js');

    const app = new Hono();
    app.use('/api/*', bodyLimit());
    app.post('/api/test', (c) => c.json({ ok: true }));

    const res = await app.request('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'hello' }),
    });
    expect(res.status).toBe(200);
  });

  it('skips GET requests', async () => {
    const { bodyLimit } = await import('../../src/middleware/security.js');

    const app = new Hono();
    app.use('/api/*', bodyLimit());
    app.get('/api/test', (c) => c.json({ ok: true }));

    const res = await app.request('/api/test', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});

// --- CORS origin tests ---

describe('CORS origin allowlist', () => {
  it('returns default localhost origins when CORS_ORIGIN not set', async () => {
    const originalVal = process.env.CORS_ORIGIN;
    delete process.env.CORS_ORIGIN;

    try {
      const { getCorsOrigins } = await import('../../src/middleware/security.js');
      const origins = getCorsOrigins();
      expect(origins).toContain('http://localhost:3456');
      expect(origins).toContain('http://localhost:4000');
    } finally {
      if (originalVal !== undefined) process.env.CORS_ORIGIN = originalVal;
    }
  });

  it('parses comma-separated CORS_ORIGIN', async () => {
    const originalVal = process.env.CORS_ORIGIN;
    process.env.CORS_ORIGIN = 'https://my-app.com, https://other.com';

    try {
      const { getCorsOrigins } = await import('../../src/middleware/security.js');
      const origins = getCorsOrigins();
      expect(origins).toContain('https://my-app.com');
      expect(origins).toContain('https://other.com');
    } finally {
      if (originalVal === undefined) delete process.env.CORS_ORIGIN;
      else process.env.CORS_ORIGIN = originalVal;
    }
  });
});

// --- Path traversal tests ---

describe('path traversal protection', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    testDb.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'Backlog',
        position INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, raw_line TEXT NOT NULL,
        line_number INTEGER NOT NULL, is_done INTEGER DEFAULT 0, priority TEXT,
        labels TEXT DEFAULT '[]', due_date TEXT, sub_items TEXT DEFAULT '[]',
        description TEXT DEFAULT '', source_fingerprint TEXT, seq_id INTEGER,
        created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => testDb.close());

  it('rejects file path with ../ traversal', async () => {
    const { default: boardRoutes } = await import('../../src/routes/boards.js');
    const app = new Hono();
    app.route('/api/boards', boardRoutes);

    const res = await app.request('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Evil', file: '../../../etc/passwd' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/vault root/i);
  });

  it('rejects absolute path outside vault', async () => {
    const { default: boardRoutes } = await import('../../src/routes/boards.js');
    const app = new Hono();
    app.route('/api/boards', boardRoutes);

    const res = await app.request('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Evil', file: '/etc/shadow' }),
    });
    // path.resolve('/tmp/test-vault', '/etc/shadow') = '/etc/shadow'
    expect(res.status).toBe(400);
  });

  it('accepts valid relative path within vault', async () => {
    const { default: boardRoutes } = await import('../../src/routes/boards.js');
    const app = new Hono();
    app.route('/api/boards', boardRoutes);

    // This will fail at file creation since /tmp/test-vault doesn't exist,
    // but the path validation should pass (409/500, not 400)
    const res = await app.request('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Legit', file: 'Projects/Legit.md' }),
    });
    // Should NOT be 400 (path traversal). May be 500 because dir doesn't exist in test,
    // or 201 if the mock lets it through. Just assert it's not 400.
    expect(res.status).not.toBe(400);
  });
});
