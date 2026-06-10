import { useEffect, useRef } from 'react';
import { getApiToken } from '../api/auth';

interface WsEvent {
  type: string;
  boardId?: string;
  cardId?: string;
  timestamp?: string;
}

// Reconnect backoff config: start 1s, double per attempt, cap at 30s, ±20% jitter.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;
const RECONNECT_JITTER = 0.2;

function reconnectDelay(attempt: number): number {
  const capped = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_CAP_MS);
  const jitter = capped * RECONNECT_JITTER * (Math.random() * 2 - 1);
  return Math.round(capped + jitter);
}

export function useWebSocket(onBoardUpdate: (boardId?: string) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempt = useRef(0);
  const hasDisconnected = useRef(false);
  const callbackRef = useRef(onBoardUpdate);

  // Keep callback ref up to date without triggering reconnect
  useEffect(() => {
    callbackRef.current = onBoardUpdate;
  }, [onBoardUpdate]);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = new URL(`${protocol}//${window.location.host}/ws`);
      const token = getApiToken();
      if (token) {
        url.searchParams.set('token', token);
      }

      const ws = new WebSocket(url.toString());
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ws] Connected');
        // Reset backoff on a healthy connection.
        reconnectAttempt.current = 0;
        // On a *re*connect (not the first connect), updates broadcast while the
        // socket was down were missed. Trigger a full refetch (no boardId) so
        // the board catches up on anything that changed during the outage.
        if (hasDisconnected.current) {
          hasDisconnected.current = false;
          callbackRef.current();
        }
      };

      ws.onmessage = (event) => {
        try {
          const data: WsEvent = JSON.parse(event.data);
          if (
            data.type === 'board-updated' ||
            data.type === 'boards-changed' ||
            data.type === 'card-moved' ||
            data.type === 'card-updated' ||
            data.type === 'sync-complete' ||
            data.type.startsWith('reminder-')
          ) {
            callbackRef.current(data.boardId);
          }
        } catch (err) {
          console.warn('[ws] Parse error:', err);
        }
      };

      ws.onclose = () => {
        hasDisconnected.current = true;
        const delay = reconnectDelay(reconnectAttempt.current);
        reconnectAttempt.current += 1;
        console.log(`[ws] Disconnected, reconnecting in ${delay}ms...`);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      ws.onerror = (err) => {
        console.error('[ws] Error:', err);
        ws.close();
      };
    }

    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // prevent reconnect
        wsRef.current.close();
      }
    };
  }, []);
}
