import { useEffect, useRef } from 'react';

interface WsEvent {
  type: string;
  boardId?: string;
  cardId?: string;
  timestamp?: string;
}

export function useWebSocket(onBoardUpdate: (boardId?: string) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbackRef = useRef(onBoardUpdate);

  // Keep callback ref up to date without triggering reconnect
  useEffect(() => {
    callbackRef.current = onBoardUpdate;
  }, [onBoardUpdate]);

  useEffect(() => {
    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[ws] Connected');
      };

      ws.onmessage = (event) => {
        try {
          const data: WsEvent = JSON.parse(event.data);
          if (data.type === 'board-updated' || data.type === 'boards-changed' || data.type === 'card-moved' || data.type === 'card-updated' || data.type === 'sync-complete') {
            callbackRef.current(data.boardId);
          }
        } catch (err) {
          console.warn('[ws] Parse error:', err);
        }
      };

      ws.onclose = () => {
        console.log('[ws] Disconnected, reconnecting in 3s...');
        reconnectTimer.current = setTimeout(connect, 3000);
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
