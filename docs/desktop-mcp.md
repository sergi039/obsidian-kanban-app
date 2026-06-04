# Desktop MCP setup

This project exposes a single MCP server for desktop agents. The MCP server never writes Markdown or SQLite directly; it calls the running Kanban API.

## Server

Run the API on the project port:

```bash
PORT=4000 NODE_ENV=production SERVE_STATIC=1 API_TOKEN=... INGEST_API_TOKEN=... pnpm --filter @kanban/api start
```

Build the MCP package:

```bash
pnpm --filter @kanban/mcp build
```

The MCP server expects:

```bash
KANBAN_API_URL=http://127.0.0.1:4000
KANBAN_API_TOKEN=...
```

`KANBAN_API_TOKEN` should be the same value as `INGEST_API_TOKEN`. Ingest endpoints fail closed when `INGEST_API_TOKEN` is not configured on the API process.

## Claude Desktop

Add an MCP server entry that points to the built server:

```json
{
  "mcpServers": {
    "obsidian-kanban": {
      "command": "node",
      "args": ["/Users/ss/obsidian-kanban-app/apps/mcp/dist/server.js"],
      "env": {
        "KANBAN_API_URL": "http://127.0.0.1:4000",
        "KANBAN_API_TOKEN": "replace-with-token"
      }
    }
  }
}
```

Recommended agent instruction:

```text
When the user asks to create, write, remember, add, or capture a Kanban task,
use the obsidian-kanban MCP server. Prefer kanban_capture_task. Let the server
route work vs personal. If the server returns needs_clarification, ask one short
question using the returned options.
```

## OpenAI / ChatGPT / Codex surfaces

Use the same MCP server and API contract. For local Codex-style environments, configure this MCP server as a local command. For ChatGPT custom MCP apps, expose the API/MCP endpoint only through an authenticated tunnel or private network.

OpenAI currently documents full MCP connectors/custom MCP apps as a beta capability for eligible ChatGPT workspaces, so verify support in the target OpenAI desktop/web surface before relying on it for writes.

## Tools

- `kanban_list_destinations` lists configured boards, domains, columns, aliases, categories, and priorities.
- `kanban_route_task` dry-runs routing and returns confidence/clarification state.
- `kanban_capture_task` creates exactly one card when routing is confident or explicit; otherwise it returns clarification options without writing.

## Routing behavior

- Auto-create requires confidence at or above `clarifyBelowConfidence` and enough margin over the second candidate.
- Exact board names and aliases dominate generic words like `work`.
- Generic work/personal signals ask when multiple boards are plausible.
- Property boards are separate from personal boards.
- Source URLs must be HTTP(S) to become Markdown links.
