import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking
const {
  fetchBoards,
  fetchBoard,
  fetchCards,
  moveCard,
  patchCard,
  reloadSync,
  fetchBoardReminders,
  fetchDueReminders,
  createReminder,
  snoozeReminder,
  dismissReminder,
  fireReminder,
} = await import('../api/client');

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

describe('reminders API', () => {
  it('fetches board and due reminders with query params', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));
    await fetchBoardReminders('b1');
    expect(mockFetch.mock.calls[0][0]).toBe('/api/reminders?board_id=b1');

    mockFetch.mockResolvedValueOnce(mockResponse([]));
    await fetchDueReminders({ board_id: 'b1', channel: 'macos', before: '2026-06-04T09:00:00.000Z', limit: 20 });
    const url = mockFetch.mock.calls[1][0] as string;
    expect(url).toContain('/api/reminders/due?');
    expect(url).toContain('board_id=b1');
    expect(url).toContain('channel=macos');
    expect(url).toContain('before=2026-06-04T09%3A00%3A00.000Z');
    expect(url).toContain('limit=20');
  });

  it('creates, snoozes, and dismisses reminders', async () => {
    const reminder = { id: 'r1', card_id: 'c1', trigger_at: '2026-06-04T09:00:00.000Z' };
    mockFetch.mockResolvedValueOnce(mockResponse(reminder));
    await createReminder({ card_id: 'c1', trigger_at: reminder.trigger_at });
    expect(mockFetch.mock.calls[0][0]).toBe('/api/reminders');
    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ card_id: 'c1', trigger_at: reminder.trigger_at });

    mockFetch.mockResolvedValueOnce(mockResponse({ ...reminder, status: 'snoozed' }));
    await snoozeReminder('r1', { minutes: 60 });
    expect(mockFetch.mock.calls[1][0]).toBe('/api/reminders/r1/snooze');
    expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ minutes: 60 });

    mockFetch.mockResolvedValueOnce(mockResponse({ ...reminder, status: 'dismissed' }));
    await dismissReminder('r1');
    expect(mockFetch.mock.calls[2][0]).toBe('/api/reminders/r1/dismiss');

    mockFetch.mockResolvedValueOnce(mockResponse({ ...reminder, status: 'fired' }));
    await fireReminder('r1');
    expect(mockFetch.mock.calls[3][0]).toBe('/api/reminders/r1/fire');
  });
});

describe('error handling', () => {
  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Not found' }, 404));

    await expect(fetchBoard('nope')).rejects.toThrow('API 404');
  });
});
