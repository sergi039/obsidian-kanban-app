import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { WebSocket } from 'ws';

const PUBLIC_URL = 'https://kanban.example.com';
let testPublicUrl: string | undefined = PUBLIC_URL;

vi.mock('../src/config.js', () => ({
  loadConfig: () => ({ vaultRoot: '/tmp/test-vault', boards: [], defaultColumns: [], publicUrl: testPublicUrl }),
}));

const { apiTokenAuth, getCorsOrigins, hostOriginGuard, hostOriginRefusal } = await import('../src/middleware/security.js');
const { closeWsServer, createWsServer } = await import('../src/ws.js');

const CORS = getCorsOrigins();

describe('hostOriginRefusal', () => {
  const allowed: Array<[string, string | undefined, string | undefined]> = [
    ['curl / MCP / reminder agent: loopback Host, no Origin', '127.0.0.1:4000', undefined],
    ['UI on localhost, same origin', 'localhost:4000', 'http://localhost:4000'],
    ['UI on 127.0.0.1, same origin', '127.0.0.1:4000', 'http://127.0.0.1:4000'],
    ['UI on IPv6 loopback, same origin', '[::1]:4000', 'http://[::1]:4000'],
    ['personal install on another port', 'localhost:4100', 'http://localhost:4100'],
    ['Host in upper case', 'LOCALHOST:4000', undefined],
    ['public host through the tunnel, UI write', 'kanban.example.com', 'https://kanban.example.com'],
    ['public host, GET without Origin', 'kanban.example.com', undefined],
    ['vite dev proxy (changeOrigin): Origin from the CORS allowlist', 'localhost:4000', 'http://localhost:3456'],
    ['vite dev proxy for /ws: Host and Origin of the dev server', 'localhost:3456', 'http://localhost:3456'],
  ];
  it.each(allowed)('allows %s', (_name, host, origin) => {
    expect(hostOriginRefusal(host, origin, PUBLIC_URL, CORS)).toBeNull();
  });

  const refused: Array<[string, string | undefined, string | undefined, string | undefined]> = [
    ['a foreign Origin on loopback (cross-site POST)', 'localhost:4000', 'https://evil.example', PUBLIC_URL],
    ['a foreign Origin on the public host', 'kanban.example.com', 'https://evil.example', PUBLIC_URL],
    ['an HTTP Origin on the HTTPS public host', 'kanban.example.com', 'http://kanban.example.com', PUBLIC_URL],
    ['an HTTPS Origin on the plain-HTTP loopback server', 'localhost:4000', 'https://localhost:4000', PUBLIC_URL],
    ['another loopback port as Origin', 'localhost:4000', 'http://localhost:8080', PUBLIC_URL],
    ['Origin "null" (sandboxed iframe, file:)', 'localhost:4000', 'null', PUBLIC_URL],
    ['an Origin with a path', 'localhost:4000', 'http://localhost:4000/', PUBLIC_URL],
    ['a DNS-rebinding Host without Origin', 'evil.example:4000', undefined, PUBLIC_URL],
    ['a DNS-rebinding Host with its own Origin', 'evil.example:4000', 'http://evil.example:4000', PUBLIC_URL],
    ['0.0.0.0 as Host', '0.0.0.0:4000', undefined, PUBLIC_URL],
    ['userinfo in Host', 'localhost@evil.example', undefined, PUBLIC_URL],
    ['a path in Host', 'localhost/', undefined, PUBLIC_URL],
    ['a non-canonical IPv4 Host', '127.1:4000', undefined, PUBLIC_URL],
    ['a trailing-dot Host', 'localhost.:4000', undefined, PUBLIC_URL],
    ['two Host values joined by the node bridge', 'localhost:4000, evil.example', undefined, PUBLIC_URL],
    ['a missing Host', undefined, undefined, PUBLIC_URL],
    ['the public host when publicUrl is not configured', 'kanban.example.com', 'https://kanban.example.com', undefined],
  ];
  it.each(refused)('refuses %s', (_name, host, origin, publicUrl) => {
    expect(hostOriginRefusal(host, origin, publicUrl, CORS)).not.toBeNull();
  });

  it('does not let a CORS allowlist entry bypass the Host check', () => {
    expect(hostOriginRefusal('evil.example:4000', 'http://localhost:3456', PUBLIC_URL, CORS)).toBe('Host not allowed');
  });
});

describe('hostOriginGuard', () => {
  function appWithCardsRoute() {
    const created: unknown[] = [];
    const app = new Hono();
    app.use('*', hostOriginGuard(() => PUBLIC_URL));
    app.use('/api/*', apiTokenAuth());
    app.post('/api/cards', async (c) => {
      created.push(JSON.parse(await c.req.text()));
      return c.json({ ok: true }, 201);
    });
    app.get('/api/boards', (c) => c.json([{ id: 'b1' }]));
    app.get('*', (c) => c.html('<!doctype html>'));
    return { app, created };
  }

  const card = JSON.stringify({ board_id: 'b1', title: 'from another page' });

  it('refuses a cross-site text/plain POST before the route parses it', async () => {
    const { app, created } = appWithCardsRoute();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await app.request('/api/cards', {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: card,
    });
    expect(res.status).toBe(403);
    expect(created).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('origin="https://evil.example"'));
    warn.mockRestore();
  });

  it('refuses DNS-rebinding reads of the API and the SPA', async () => {
    const { app } = appWithCardsRoute();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const path of ['/api/boards', '/']) {
      const res = await app.request(path, { headers: { host: 'evil.example:4000' } });
      expect(res.status).toBe(403);
    }
    vi.mocked(console.warn).mockRestore();
  });

  it('lets the UI write from its own origin, locally and on the public host', async () => {
    const { app, created } = appWithCardsRoute();
    const local = await app.request('/api/cards', {
      method: 'POST',
      headers: { host: 'localhost:4000', origin: 'http://localhost:4000', 'content-type': 'application/json' },
      body: card,
    });
    const remote = await app.request('/api/cards', {
      method: 'POST',
      headers: { host: 'kanban.example.com', origin: 'https://kanban.example.com', 'content-type': 'application/json' },
      body: card,
    });
    expect([local.status, remote.status]).toEqual([201, 201]);
    expect(created).toHaveLength(2);
  });

  it('lets curl and MCP calls without Origin through', async () => {
    const { app, created } = appWithCardsRoute();
    const res = await app.request('/api/cards', {
      method: 'POST',
      headers: { host: '127.0.0.1:4000', 'content-type': 'application/json' },
      body: card,
    });
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
  });

  it('refuses a foreign Origin even with a valid API token', async () => {
    const original = process.env.API_TOKEN;
    process.env.API_TOKEN = 'test-secret-token';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { app, created } = appWithCardsRoute();
      const res = await app.request('/api/cards', {
        method: 'POST',
        headers: { host: 'localhost:4000', origin: 'https://evil.example', authorization: 'Bearer test-secret-token' },
        body: card,
      });
      expect(res.status).toBe(403);
      expect(created).toEqual([]);
    } finally {
      if (original === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = original;
      vi.mocked(console.warn).mockRestore();
    }
  });
});

describe('WebSocket upgrade', () => {
  let server: Server;
  let port: number;
  let originalToken: string | undefined;

  beforeAll(async () => {
    originalToken = process.env.API_TOKEN;
    delete process.env.API_TOKEN;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = createServer();
    createWsServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    closeWsServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalToken !== undefined) process.env.API_TOKEN = originalToken;
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.warn).mockRestore();
  });

  /** 'open' when the server accepted the upgrade, else the HTTP status it answered with. */
  function connect(headers: { host?: string; origin?: string }): Promise<'open' | number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: headers.host ? { host: headers.host } : {},
        ...(headers.origin ? { origin: headers.origin } : {}),
      });
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('unexpected-response', (req, res) => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', reject);
    });
  }

  it('refuses a foreign Origin', async () => {
    expect(await connect({ host: `localhost:${port}`, origin: 'https://evil.example' })).toBe(403);
  });

  it('refuses a DNS-rebinding Host', async () => {
    expect(await connect({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(403);
  });

  it('accepts the local UI from its own origin', async () => {
    expect(await connect({ host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe('open');
  });

  it('accepts the UI on the public host and refuses it without publicUrl', async () => {
    const publicUi = { host: 'kanban.example.com', origin: 'https://kanban.example.com' };
    expect(await connect(publicUi)).toBe('open');
    testPublicUrl = undefined;
    try {
      expect(await connect(publicUi)).toBe(403);
    } finally {
      testPublicUrl = PUBLIC_URL;
    }
  });

  it('accepts a Node client without Origin', async () => {
    expect(await connect({})).toBe('open');
  });

  it('drops an upgrade with a malformed target and keeps serving', async () => {
    const closed = await new Promise<boolean>((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        socket.write(
          'GET http://[/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      socket.on('close', () => resolve(true));
      socket.on('error', reject);
    });
    expect(closed).toBe(true);
    expect(await connect({ host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe('open');
  });
});
