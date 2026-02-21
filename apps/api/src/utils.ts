/**
 * Shared utility functions used across route handlers and modules.
 */

/** Type-safe JSON parse with fallback — never throws */
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Normalize a DB card row into API response format */
export function formatCard(row: Record<string, unknown>) {
  return {
    ...row,
    is_done: Boolean(row.is_done),
    labels: safeJsonParse<string[]>(row.labels as string, []),
    sub_items: safeJsonParse<string[]>(row.sub_items as string, []),
    checklist: safeJsonParse<{id:string;title:string;done:boolean}[]>(row.checklist as string, []),
    links: safeJsonParse<{url:string;title:string}[]>(row.links as string, []),
  };
}
