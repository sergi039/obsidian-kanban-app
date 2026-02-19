import type {
  BoardSummary,
  BoardDetail,
  Card,
  Comment,
  View,
  Field,
  FieldValue,
  MoveCardRequest,
  PatchCardRequest,
  AutomationRule,
  Trigger,
  AutomationAction,
  PriorityDef,
} from '../types';

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

export async function fetchBoards(includeArchived?: boolean): Promise<BoardSummary[]> {
  const qs = includeArchived ? '?archived=true' : '';
  return request<BoardSummary[]>(`/boards${qs}`);
}

export async function fetchArchivedBoards(): Promise<BoardSummary[]> {
  return request<BoardSummary[]>('/boards?archived=only');
}

export async function createBoard(data: { name: string; file?: string; columns?: string[] }): Promise<BoardSummary> {
  return request<BoardSummary>('/boards', { method: 'POST', body: JSON.stringify(data) });
}

export async function archiveBoard(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
}

export async function unarchiveBoard(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ archived: false }) });
}

export async function renameBoard(id: string, name: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export async function updateBoardPriorities(
  id: string,
  priorities: PriorityDef[],
): Promise<{ ok: boolean; priorities: PriorityDef[] }> {
  return request<{ ok: boolean; priorities: PriorityDef[] }>(
    `/boards/${id}`,
    { method: 'PATCH', body: JSON.stringify({ priorities }) },
  );
}

export async function deleteBoard(id: string): Promise<{ ok: boolean; cardsRemoved: number }> {
  return request<{ ok: boolean; cardsRemoved: number }>(`/boards/${id}`, { method: 'DELETE' });
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

// Fields API
export async function fetchFields(boardId: string): Promise<Field[]> {
  return request<Field[]>(`/fields?board_id=${boardId}`);
}

export async function createField(data: {
  board_id: string;
  name: string;
  type?: string;
  options?: Array<{ id: string; name: string; color?: string }>;
}): Promise<Field> {
  return request<Field>('/fields', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateField(fieldId: string, patch: Partial<Field>): Promise<Field> {
  return request<Field>(`/fields/${fieldId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteField(fieldId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/fields/${fieldId}`, { method: 'DELETE' });
}

export async function fetchFieldValues(cardId: string): Promise<FieldValue[]> {
  return request<FieldValue[]>(`/fields/values?card_id=${cardId}`);
}

export async function setFieldValue(fieldId: string, cardId: string, value: string | null): Promise<unknown> {
  return request(`/fields/${fieldId}/values/${cardId}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

// Automations API
export async function fetchAutomations(boardId: string): Promise<AutomationRule[]> {
  return request<AutomationRule[]>(`/automations?board_id=${boardId}`);
}

export async function createAutomation(data: {
  board_id: string;
  name: string;
  trigger: Trigger;
  actions: AutomationAction[];
  enabled?: boolean;
}): Promise<AutomationRule> {
  return request<AutomationRule>('/automations', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateAutomation(ruleId: string, patch: Partial<{
  name: string;
  enabled: boolean;
  trigger: Trigger;
  actions: AutomationAction[];
}>): Promise<AutomationRule> {
  return request<AutomationRule>(`/automations/${ruleId}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteAutomation(ruleId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/automations/${ruleId}`, { method: 'DELETE' });
}
