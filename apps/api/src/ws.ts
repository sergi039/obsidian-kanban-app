/**
 * WebSocket server for push updates.
 * Includes keepalive pings, stale connection cleanup, auth, and connection limits.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { validateWsAuth, MAX_WS_CONNECTIONS } from './middleware/security.js';

let wss: WebSocketServer | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

export interface WsEvent {
  type: 'board-updated' | 'card-moved' | 'card-updated' | 'sync-complete' | 'boards-changed';
  boardId?: string;
  cardId?: string;
  timestamp: string;
}

const PING_INTERVAL_MS = 30_000;

export function createWsServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  const aliveMap = new WeakMap<WebSocket, boolean>();

  // Handle upgrade manually for auth validation
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Auth check
    if (!validateWsAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      console.log('[ws] Rejected unauthenticated connection');
      return;
    }

    // Connection limit
    if (wss && wss.clients.size >= MAX_WS_CONNECTIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      console.warn(`[ws] Rejected connection: max ${MAX_WS_CONNECTIONS} reached`);
      return;
    }

    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  wss.on('connection', (socket) => {
    console.log('[ws] Client connected');
    aliveMap.set(socket, true);

    socket.on('pong', () => {
      aliveMap.set(socket, true);
    });

    socket.on('close', () => console.log('[ws] Client disconnected'));
    socket.on('error', (err) => console.error('[ws] Socket error:', err));

    // Send initial greeting
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  // Keepalive: ping all clients, terminate stale ones
  pingInterval = setInterval(() => {
    if (!wss) return;
    for (const client of wss.clients) {
      if (!aliveMap.get(client)) {
        console.log('[ws] Terminating stale connection');
        client.terminate();
        continue;
      }
      aliveMap.set(client, false);
      client.ping();
    }
  }, PING_INTERVAL_MS);

  console.log('[ws] WebSocket server ready on /ws');
  return wss;
}

export function broadcast(event: WsEvent): void {
  if (!wss) return;

  const data = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function getWss(): WebSocketServer | null {
  return wss;
}

export function closeWsServer(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (wss) {
    wss.close();
    wss = null;
  }
}
