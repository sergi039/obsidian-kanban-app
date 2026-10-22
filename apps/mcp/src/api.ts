/**
 * HTTP access to the Kanban API for the MCP tools: one place for the address, the
 * optional token and the error an agent reads when a call fails.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  /** Origin of the board server, e.g. `http://127.0.0.1:4000` (without `/api`). */
  apiUrl: string;
  /** Bearer token; needed only when the server runs with `API_TOKEN`. */
  token?: string;
  fetch?: FetchLike;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type ApiRequest = (method: string, path: string, body?: unknown) => Promise<ApiResponse>;

export class KanbanApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'KanbanApiError';
  }
}

const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_TEXT_LIMIT = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A request function bound to one board server; `path` is relative to `/api`. */
export function createApi(options: ApiOptions): ApiRequest {
  const base = options.apiUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return async (method, path, body) => {
    let res: Response;
    try {
      res = await doFetch(`${base}/api${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new KanbanApiError(
        `The board server at ${base} does not answer (${reason}). Check that it runs: ${base}/api/health`,
        0,
      );
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      const error = isRecord(parsed) ? parsed : {};
      const message = typeof error.error === 'string' ? error.error : text.slice(0, ERROR_TEXT_LIMIT) || res.statusText;
      const details = error.details === undefined ? '' : ` ${JSON.stringify(error.details)}`;
      const code = typeof error.code === 'string' ? error.code : undefined;
      throw new KanbanApiError(`Kanban API ${res.status}: ${message}${details}`, res.status, code);
    }
    if (parsed === undefined) {
      throw new KanbanApiError(`Kanban API ${res.status}: the answer is not JSON`, res.status);
    }
    return { status: res.status, body: parsed };
  };
}
