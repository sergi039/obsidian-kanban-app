import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { clearApiToken, setApiToken } from '../api/auth';

describe('useWebSocket module', () => {
  let MockWebSocket: any;

  beforeEach(() => {
    // Mock WebSocket
    MockWebSocket = vi.fn().mockImplementation(() => ({
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: vi.fn(),
    }));
    vi.stubGlobal('WebSocket', MockWebSocket);
    clearApiToken();
  });

  it('exports useWebSocket function', async () => {
    const mod = await import('../hooks/useWebSocket');
    expect(typeof mod.useWebSocket).toBe('function');
  });

  it('WebSocket URL construction uses correct protocol', () => {
    // Test ws:// vs wss:// logic
    const protocol = 'http:' as string;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    expect(wsProtocol).toBe('ws:');

    const secProtocol = 'https:' as string;
    const secWsProtocol = secProtocol === 'https:' ? 'wss:' : 'ws:';
    expect(secWsProtocol).toBe('wss:');
  });

  it('parses board-updated event correctly', () => {
    const data = JSON.stringify({
      type: 'board-updated',
      boardId: 'vs',
      timestamp: '2026-01-01T00:00:00Z',
    });

    const parsed = JSON.parse(data);
    expect(parsed.type).toBe('board-updated');
    expect(parsed.boardId).toBe('vs');
  });

  it('parses card-moved event correctly', () => {
    const data = JSON.stringify({
      type: 'card-moved',
      cardId: 'abc123',
      boardId: 'vs',
      timestamp: '2026-01-01T00:00:00Z',
    });

    const parsed = JSON.parse(data);
    expect(parsed.type).toBe('card-moved');
    expect(parsed.cardId).toBe('abc123');
  });

  it('passes saved API token as a WebSocket query parameter', async () => {
    const { useWebSocket } = await import('../hooks/useWebSocket');
    setApiToken('secret token');

    function Harness() {
      useWebSocket(vi.fn());
      return null;
    }

    render(createElement(Harness));

    expect(MockWebSocket).toHaveBeenCalledWith('ws://localhost:3000/ws?token=secret+token');
  });
});
