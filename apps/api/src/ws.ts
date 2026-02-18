/**
 * WebSocket server for push updates.
 * Includes keepalive pings and stale connection cleanup.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

let wss: WebSocketServer | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

export interface WsEvent {
  type: 'board-updated' | 'card-moved' | 'sync-complete';
  boardId?: string;
  cardId?: string;
  timestamp: string;
}

const PING_INTERVAL_MS = 30_000;

export function createWsServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  const aliveMap = new WeakMap<WebSocket, boolean>();

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
