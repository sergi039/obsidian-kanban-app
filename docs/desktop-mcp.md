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
      "args": ["/path/to/obsidian-kanban-app/apps/mcp/dist/server.js"],
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
  "args": ["/path/to/obsidian-kanban-app/apps/mcp/dist/server.js"],
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

## Tasks from email

When the task comes from an email, the agent passes the email's provider ids in `email` (MCP `kanban_capture_task`, or `POST /api/inbox/capture`):

```json
{
  "title": "Reply to the partner about the renewal",
  "description": "Short summary written by the agent",
  "email": {
    "provider": "gmail",
    "account": "owner@example.com",
    "message_id": "<Gmail API message id or Graph message id>",
    "thread_id": "<Gmail threadId or Graph conversationId>",
    "subject": "Contract renewal",
    "from": "Partner <partner@example.net>",
    "received_at": "2026-10-14T08:30:00Z"
  }
}
```

The server derives the rest, so `source_uid`, `source_url` and `idempotency_key` stay empty:

- `source` is `email`.
- `source_uid` is `<provider>:<mailbox>:thread:<thread_id>`, or `…:message:<message_id>` without a thread id. Capturing the same thread again returns the card it already has, with status `duplicate`, even when the title or message differs. The same thread in another mailbox is another task.
- `source_url` opens the email, in the formats invoice-zero's `buildEmailLink` uses: Gmail `https://mail.google.com/mail/u/<mailbox>/#all/<message_id>`; Outlook work/school `https://outlook.office.com/mail/deeplink/read/<message_id>`; consumer Outlook (outlook.com, hotmail, live, msn) `https://outlook.live.com/mail/0/inbox/id/<thread_id or message_id>`. It is written into the task line as `[from:email](…)`.
- `source_meta.email` keeps only the fields above. Unknown fields in `email` are rejected, and so is a `source_meta` key that looks like an email body (`body`, `html`, `text`, `raw`, …). For every source, a `source_meta` key that looks like a credential (`token`, `secret`, `password`, `api_key`, `cookie`, …) is rejected.

## Routing behavior

- Auto-create requires confidence at or above `clarifyBelowConfidence` and enough margin over the second candidate.
- Exact board names and aliases dominate generic words like `work`.
- Generic work/personal signals ask when multiple boards are plausible.
- Property boards are separate from personal boards.
- Source URLs must be HTTP(S) to become Markdown links.

## Safety model

- Desktop clients use one high-level capture tool instead of separate work/personal write tools.
- The API stores `source_uid`, `source_url`, bounded `source_meta`, and an `inbox_captures` row for idempotency and auditability.
- `source_meta` never carries credentials, and email captures never carry the email body.
- Replays with the same payload return the existing card; replays with the same capture key and different payload are rejected.
- Failed writes can be retried with the same capture key after the underlying file/API issue is fixed.

## Calendar events for a task

When an agent creates a calendar event for a Kanban task, it puts the card link in the event's description:

```text
Kanban: https://kanban.cervantes50.com/?board=<board_id>&card=<card_id>
```

`kanban_capture_task` returns the card with `id` and `board_id`. Within 10 minutes the API's calendar sync links the event to the card (work events through Microsoft Graph, personal ones through Google Calendar), and the card shows it. No other step is needed; titles are not matched.

