/**
 * WebSocket server for push updates.
 * When files change (via chokidar) or cards are updated (via API),
 * broadcast events to all connected clients.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

let wss: WebSocketServer | null = null;

export interface WsEvent {
  type: 'board-updated' | 'card-moved' | 'sync-complete';
  boardId?: string;
  cardId?: string;
  timestamp: string;
}

export function createWsServer(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    console.log('[ws] Client connected');
    socket.on('close', () => console.log('[ws] Client disconnected'));
    socket.on('error', (err) => console.error('[ws] Socket error:', err));

    // Send initial ping
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

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
