#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createKanbanServer } from './tools.js';

const DEFAULT_API_URL = 'http://127.0.0.1:4000';

/** An http(s) origin from the environment, or the process stops with the reason on stderr. */
function originFromEnv(name: string, fallback: string): string {
  const raw = process.env[name] || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[obsidian-kanban-mcp] ${name} is not a URL: ${raw}`);
    process.exit(1);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error(`[obsidian-kanban-mcp] ${name} must be an http(s) address: ${raw}`);
    process.exit(1);
  }
  return raw.replace(/\/+$/, '');
}

const apiUrl = originFromEnv('KANBAN_API_URL', DEFAULT_API_URL);
const server = createKanbanServer({
  apiUrl,
  appUrl: originFromEnv('KANBAN_APP_URL', apiUrl),
  token: process.env.KANBAN_API_TOKEN || process.env.API_TOKEN || undefined,
});

await server.connect(new StdioServerTransport());
