import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
const { fetchBoards, fetchBoard, fetchCards, moveCard, patchCard, reloadSync } = await import(
  '../api/client'
);

function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('fetchBoards', () => {
  it('returns list of boards', async () => {
    const boards = [
      { id: 'vs', name: 'VirtoSoftware', totalCards: 26, columnCounts: { Backlog: 26 } },
    ];
    mockFetch.mockResolvedValueOnce(mockResponse(boards));

    const result = await fetchBoards();
    expect(result).toEqual(boards);
    expect(mockFetch).toHaveBeenCalledWith('/api/boards', expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) }));
  });
});

describe('fetchBoard', () => {
  it('fetches board by id', async () => {
    const board = { id: 'vs', name: 'VS', columns: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(board));

    const result = await fetchBoard('vs');
    expect(result).toEqual(board);
    expect(mockFetch).toHaveBeenCalledWith('/api/boards/vs', expect.anything());
  });
});

describe('fetchCards', () => {
  it('fetches cards without filters', async () => {
    const cards = [{ id: 'abc', title: 'Test' }];
    mockFetch.mockResolvedValueOnce(mockResponse(cards));

    const result = await fetchCards('vs');
    expect(result).toEqual(cards);
    expect(mockFetch).toHaveBeenCalledWith('/api/boards/vs/cards', expect.anything());
  });

  it('appends filter query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await fetchCards('vs', { column: 'Done', priority: 'high', search: 'test' });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('column=Done');
    expect(url).toContain('priority=high');
    expect(url).toContain('search=test');
  });
});

describe('moveCard', () => {
  it('sends POST with move data', async () => {
    const card = { id: 'abc', column_name: 'Done', position: 0 };
    mockFetch.mockResolvedValueOnce(mockResponse(card));

    const result = await moveCard('abc', { column: 'Done', position: 0 });
    expect(result).toEqual(card);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/cards/abc/move');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ column: 'Done', position: 0 });
  });
});

describe('patchCard', () => {
  it('sends PATCH with field updates', async () => {
    const card = { id: 'abc', priority: 'urgent' };
    mockFetch.mockResolvedValueOnce(mockResponse(card));

    await patchCard('abc', { priority: 'urgent' });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/cards/abc');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ priority: 'urgent' });
  });
});

describe('reloadSync', () => {
  it('sends POST to sync/reload', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    const result = await reloadSync();
    expect(result).toEqual({ ok: true });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('/api/boards/sync/reload');
    expect(init.method).toBe('POST');
  });
});

describe('error handling', () => {
  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Not found' }, 404));

    await expect(fetchBoard('nope')).rejects.toThrow('API 404');
  });
});
