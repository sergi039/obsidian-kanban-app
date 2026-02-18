import type { BoardSummary, BoardDetail, Card, Comment, View, MoveCardRequest, PatchCardRequest } from '../types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export async function fetchBoards(): Promise<BoardSummary[]> {
  return request<BoardSummary[]>('/boards');
}

export async function fetchBoard(id: string): Promise<BoardDetail> {
  return request<BoardDetail>(`/boards/${id}`);
}

export async function fetchCards(
  boardId: string,
  filters?: { column?: string; priority?: string; search?: string },
): Promise<Card[]> {
  const params = new URLSearchParams();
  if (filters?.column) params.set('column', filters.column);
  if (filters?.priority) params.set('priority', filters.priority);
  if (filters?.search) params.set('search', filters.search);
  const qs = params.toString();
  return request<Card[]>(`/boards/${boardId}/cards${qs ? `?${qs}` : ''}`);
}

export async function createCard(boardId: string, title: string, column?: string): Promise<Card> {
  return request<Card>('/cards', {
    method: 'POST',
    body: JSON.stringify({ board_id: boardId, title, column }),
  });
}

export async function moveCard(cardId: string, move: MoveCardRequest): Promise<Card> {
  return request<Card>(`/cards/${cardId}/move`, {
    method: 'POST',
    body: JSON.stringify(move),
  });
}

export async function patchCard(cardId: string, patch: PatchCardRequest): Promise<Card> {
  return request<Card>(`/cards/${cardId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function reloadSync(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/boards/sync/reload', { method: 'POST' });
}

export async function addColumn(boardId: string, name: string): Promise<{ ok: boolean; columns: string[] }> {
  return request(`/boards/${boardId}/columns`, { method: 'POST', body: JSON.stringify({ name }) });
}

export async function reorderColumns(boardId: string, columns: string[]): Promise<{ ok: boolean; columns: string[] }> {
  return request(`/boards/${boardId}/columns`, { method: 'PUT', body: JSON.stringify({ columns }) });
}

export async function renameColumn(boardId: string, oldName: string, newName: string): Promise<{ ok: boolean; columns: string[] }> {
  return request(`/boards/${boardId}/columns/rename`, { method: 'PATCH', body: JSON.stringify({ oldName, newName }) });
}

export async function deleteColumn(boardId: string, name: string, moveTo?: string): Promise<{ ok: boolean; columns: string[] }> {
  return request(`/boards/${boardId}/columns`, { method: 'DELETE', body: JSON.stringify({ name, moveTo }) });
}

// Comments API
export async function fetchComments(cardId: string): Promise<Comment[]> {
  return request<Comment[]>(`/cards/${cardId}/comments`);
}

export async function addComment(cardId: string, text: string, author = 'user'): Promise<Comment> {
  return request<Comment>(`/cards/${cardId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ text, author }),
  });
}

export async function updateComment(cardId: string, commentId: string, text: string): Promise<Comment> {
  return request<Comment>(`/cards/${cardId}/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

export async function deleteComment(cardId: string, commentId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/cards/${cardId}/comments/${commentId}`, {
    method: 'DELETE',
  });
}

// Views API
export async function fetchViews(boardId: string): Promise<View[]> {
  return request<View[]>(`/views?board_id=${boardId}`);
}

export async function createView(data: {
  board_id: string;
  name: string;
  layout?: 'board' | 'table';
  filter_query?: string;
  sort_field?: string;
  sort_dir?: 'ASC' | 'DESC';
}): Promise<View> {
  return request<View>('/views', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateView(viewId: string, patch: Partial<View>): Promise<View> {
  return request<View>(`/views/${viewId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteView(viewId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/views/${viewId}`, { method: 'DELETE' });
}

export async function fetchViewCards(viewId: string): Promise<Card[]> {
  return request<Card[]>(`/views/${viewId}/cards`);
}
