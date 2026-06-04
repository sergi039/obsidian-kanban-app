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

Routing rules live in `config.routing.json`. Restart the API after changing that file; routing config is loaded by the server process.

## Supported client strategy

Claude Desktop is the primary supported desktop agent for Kanban task capture because it supports local stdio MCP and matches this repository's `apps/mcp` server.

OpenAI/ChatGPT Desktop write support is deferred. Do not build a remote/tunnel adapter unless the owner confirms a supported OpenAI workspace/developer-mode path and explicitly reopens that work. See [ADR 0002](decisions/0002-desktop-agent-client-strategy.md).

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

Use the same instruction in local Codex-style clients when they support local MCP tools.

## OpenAI / ChatGPT / Codex surfaces

Use the same MCP server and API contract for local Codex-style environments by configuring this MCP server as a local command.

OpenAI/ChatGPT Desktop is not a supported write path for this milestone. It may require a supported custom/full MCP app workspace plus a remote MCP endpoint or Secure MCP Tunnel. This is intentionally not part of the current implementation.

For local Codex-style use, expose the same command:

```json
{
  "command": "node",
  "args": ["/Users/ss/obsidian-kanban-app/apps/mcp/dist/server.js"],
  "env": {
    "KANBAN_API_URL": "http://127.0.0.1:4000",
    "KANBAN_API_TOKEN": "replace-with-token"
  }
}
```

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

## Safety model

- Desktop clients use one high-level capture tool instead of separate work/personal write tools.
- The API stores `source_uid`, `source_url`, bounded `source_meta`, and an `inbox_captures` row for idempotency and auditability.
- Replays with the same payload return the existing card; replays with the same capture key and different payload are rejected.
- Failed writes can be retried with the same capture key after the underlying file/API issue is fixed.
