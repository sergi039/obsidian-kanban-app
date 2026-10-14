#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.KANBAN_API_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const API_TOKEN = process.env.KANBAN_API_TOKEN || process.env.INGEST_API_TOKEN;

const LinkSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

const SourceSchema = z.object({
  client: z.enum(['claude_desktop', 'openai_desktop', 'codex', 'other']).default('other'),
  source_uid: z.string().optional(),
  source_url: z.string().url().optional(),
  captured_at: z.string().optional(),
  author: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

/** The email a task came from. The Kanban API derives the card's link, dedup key and metadata from it. */
const EmailSchema = z.object({
  provider: z.enum(['gmail', 'outlook']).describe('Mailbox provider'),
  account: z.string().describe('Address of the mailbox the email is in'),
  message_id: z.string().describe('Provider message id: Gmail API id, or Microsoft Graph message id'),
  thread_id: z.string().optional().describe('Gmail threadId or Graph conversationId; one card per thread'),
  internet_message_id: z.string().optional().describe('RFC 5322 Message-ID header'),
  subject: z.string().optional(),
  from: z.string().optional(),
  received_at: z.string().optional().describe('ISO 8601 date-time'),
});

function sourceForClient(client: z.infer<typeof SourceSchema>['client']): 'claude' | 'openai' | 'manual' {
  if (client === 'claude_desktop') return 'claude';
  if (client === 'openai_desktop' || client === 'codex') return 'openai';
  return 'manual';
}

async function apiRequest(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!API_TOKEN) {
    throw new Error('KANBAN_API_TOKEN or INGEST_API_TOKEN must be set for the MCP server');
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...init.headers,
    },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : text;
    throw new Error(`Kanban API ${res.status}: ${message}`);
  }
  return body;
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

const server = new McpServer({
  name: 'obsidian-kanban',
  version: '0.1.0',
});

server.tool(
  'kanban_list_destinations',
  'List available Obsidian Kanban destinations and routing aliases.',
  {
    include_archived: z.boolean().optional().default(false),
  },
  async ({ include_archived }) => {
    const qs = include_archived ? '?archived=true' : '';
    return jsonContent(await apiRequest(`/api/inbox/destinations${qs}`));
  },
);

server.tool(
  'kanban_route_task',
  'Dry-run routing for a task. Use this before capture when destination is unclear.',
  {
    title: z.string().min(1),
    description: z.string().optional(),
    links: z.array(LinkSchema).optional(),
    route_hint: z.object({
      domain: z.string().optional(),
      board_id: z.string().optional(),
      column: z.string().optional(),
    }).optional(),
  },
  async ({ title, description, route_hint }) => jsonContent(await apiRequest('/api/inbox/route', {
    method: 'POST',
    body: JSON.stringify({
      title,
      description,
      board_id: route_hint?.board_id,
      context: route_hint?.domain,
    }),
  })),
);

server.tool(
  'kanban_capture_task',
  'Create a task in Obsidian Kanban, auto-routing when confident and returning clarification options when ambiguous. '
    + 'For a task from an email, pass `email` with the provider ids and leave source.source_uid, source.source_url and '
    + 'idempotency_key empty: the server builds the link to the email and returns the existing card (status "duplicate") '
    + 'when the thread was captured before. Put a short summary in description, never the email body.',
  {
    title: z.string().min(1),
    description: z.string().optional(),
    links: z.array(LinkSchema).optional(),
    route: z.object({
      mode: z.enum(['auto', 'explicit']).default('auto'),
      board_id: z.string().optional(),
      domain: z.string().optional(),
      column: z.string().optional(),
    }).default({ mode: 'auto' }),
    source: SourceSchema.default({ client: 'other' }),
    email: EmailSchema.optional(),
    idempotency_key: z.string().optional(),
  },
  async ({ title, description, links, route, source, email, idempotency_key }) => {
    const sourceMeta = {
      ...(source.meta ?? {}),
      client: source.client,
      captured_at: source.captured_at,
      author: source.author,
    };
    const body = {
      title,
      description,
      links,
      board_id: route.mode === 'explicit' ? route.board_id : undefined,
      column: route.column,
      source: email ? 'email' : sourceForClient(source.client),
      source_uid: source.source_uid ?? idempotency_key,
      source_url: source.source_url,
      source_meta: sourceMeta,
      email,
      context: route.domain,
    };
    return jsonContent(await apiRequest('/api/inbox/capture', {
      method: 'POST',
      body: JSON.stringify(body),
    }));
  },
);

await server.connect(new StdioServerTransport());
