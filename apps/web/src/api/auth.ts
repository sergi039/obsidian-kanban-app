const TOKEN_STORAGE_KEY = 'kanban-api-token';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getApiToken(): string | null {
  const token = getStorage()?.getItem(TOKEN_STORAGE_KEY)?.trim();
  return token || null;
}

export function setApiToken(token: string): void {
  const normalized = token.trim();
  const storage = getStorage();
  if (!storage) return;

  if (normalized) {
    storage.setItem(TOKEN_STORAGE_KEY, normalized);
  } else {
    storage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function clearApiToken(): void {
  getStorage()?.removeItem(TOKEN_STORAGE_KEY);
}
