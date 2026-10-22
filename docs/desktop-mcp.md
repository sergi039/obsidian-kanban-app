# AI assistants (MCP)

The board's MCP server (`apps/mcp`) gives Claude Code, Codex and Claude Desktop the board's tools. It calls the running board API over HTTP, as the web page does, and never writes Markdown or SQLite itself: the board server stays the only writer. Why this shape and not plugins or a remote server: [ADR 0003](decisions/0003-agent-access-through-local-mcp.md).

## Tools

| Tool | What it does |
|---|---|
| `kanban_list_boards` | Boards with columns, priorities and card counts; archived ones only when asked |
| `kanban_list_cards` | Cards of a board, done ones left out unless asked; `search` matches the title; a cut list says `truncated` |
| `kanban_create_card` | A card on top of a column, with description, due date, links; a task from an email links to it and its thread keeps one card |
| `kanban_update_card` | Title, due date, priority; adds a paragraph to the description or adds links, keeping what the card has |
| `kanban_replace_description` | Rewrites the whole description; the only tool that removes text, marked destructive |
| `kanban_move_card` | Moves a card to another column; to the done column closes it |
| `kanban_add_comment` | Adds a comment (author `agent`) |
| `kanban_follow_up` | For a card from an email: a reminder if the awaited answer does not come in N days |

The server also hands the assistant short instructions: use these tools for «в канбан» / "add to kanban", ask which board when several fit, look for the same task before adding one, write a description that stands without the chat, and answer with the card's `card_url`.

Every answer carries `card_url`. A change the board saved but could not write into the Markdown file comes back with `write_back_warning`.

## Setup

The [one-script install](personal-install.md) does this on its own: it builds the server and registers it for Claude Code (user scope) and for Codex when Codex is on the Mac. By hand:

```bash
pnpm --filter @kanban/mcp build
claude mcp add --scope user obsidian-kanban -e KANBAN_API_URL=http://127.0.0.1:4000 \
  -- node /path/to/obsidian-kanban-app/apps/mcp/dist/server.js
codex mcp add obsidian-kanban --env KANBAN_API_URL=http://127.0.0.1:4000 \
  -- node /path/to/obsidian-kanban-app/apps/mcp/dist/server.js
```

The Codex app, CLI and IDE extension read the same `~/.codex/config.toml`, and the Code tab of the Claude app uses the same user-scope servers as the `claude` command. Claude Desktop chat: see [the README](../README.md#connect-your-ai-assistant).

| Variable | Default | Description |
|---|---|---|
| `KANBAN_API_URL` | `http://127.0.0.1:4000` | The board server |
| `KANBAN_API_TOKEN` | — | Only when the board runs with `API_TOKEN`: the same value |
| `KANBAN_APP_URL` | `KANBAN_API_URL` | Address the card links open, e.g. the board's public address |

### Asking before a change

- **Claude Code** asks before each tool call until you allow it: *Always allow* in the prompt, or `mcp__obsidian-kanban__*` in the `permissions.allow` list of your settings.
- **Codex** runs the tools without asking, except `kanban_replace_description`, which it asks you to approve; in `codex exec`, where nobody can approve, it refuses that one (seen with Codex CLI 0.162).

### A board on another Mac

The board server listens on `127.0.0.1` only. From another Mac, run the MCP server on the board's Mac over ssh, so it still talks to loopback there. This needs ssh with a key and no password prompt:

```bash
claude mcp add --scope user obsidian-kanban -- /usr/bin/ssh -o BatchMode=yes user@board-mac \
  KANBAN_APP_URL=https://kanban.example.com /path/to/node /path/to/obsidian-kanban-app/apps/mcp/dist/server.js
```

The same arguments go after `codex mcp add obsidian-kanban --`. The login on the board's Mac must print nothing to standard output, or the assistant cannot read the server.

## Tasks from email

When the task comes from an email, the agent passes the email's provider ids in `email`, never its body. Three entry points take it: MCP `kanban_create_card`, `POST /api/cards` (`{board_id, title, email}`, no token) and `POST /api/inbox/capture` (external sources, needs `INGEST_API_TOKEN`):

```json
{
  "board_id": "private",
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

The server derives the rest:

- `source` is `email`. `POST /api/cards` answers 201 for a new card, 200 with the existing card when the thread already has one, and 409 `capture_deleted` when the thread's card was deleted for good. `kanban_create_card` returns the existing card with status `existing` and changes nothing on it; the agent adds to it with `kanban_update_card`.
- `source_uid` is `<provider>:<mailbox>:thread:<thread_id>`, or `…:message:<message_id>` without a thread id. The same thread again returns the card it already has, even when the title or message differs. The same thread in another mailbox is another task.
- `source_url` opens the email, in the formats invoice-zero's `buildEmailLink` uses: Gmail `https://mail.google.com/mail/u/<mailbox>/#all/<message_id>`; Outlook work/school `https://outlook.office.com/mail/deeplink/read/<message_id>`; consumer Outlook (outlook.com, hotmail, live, msn) `https://outlook.live.com/mail/0/inbox/id/<thread_id or message_id>`. It is written into the task line as `[from:email](…)` and is the card's first link.
- `source_meta.email` keeps only the fields above. Unknown fields in `email` are rejected, and so is a `source_meta` key that looks like an email body (`body`, `html`, `text`, `raw`, …). For every source, a `source_meta` key that looks like a credential (`token`, `secret`, `password`, `api_key`, `cookie`, …) is rejected.

## Calendar events for a task

When an agent creates a calendar event for a Kanban task, it puts the card link in the event's description:

```text
Kanban: https://kanban.cervantes50.com/?board=<board_id>&card=<card_id>
```

`kanban_create_card` returns the card with `id`, `board_id` and `card_url`. Within 10 minutes the API's calendar sync links the event to the card (work events through Microsoft Graph, personal ones through Google Calendar), and the card shows it. No other step is needed; titles are not matched.

## Safety model

- One writer: the board server. The MCP server only calls its HTTP API, without `Origin`, which the server's [cross-site check](reference.md#requests-from-other-web-pages) lets through like curl.
- No token on loopback, the same as the web page on that Mac; a board with `API_TOKEN` needs `KANBAN_API_TOKEN`.
- Additions by default: `append_description` and `add_links` are merged by the server in the same step that reads the card, so an edit made in the browser meanwhile is not lost, and a link the card has is not added twice. Replacing the description is its own tool, marked destructive.
- Checked before any request: dates are real `YYYY-MM-DD` days, links are http(s) only, and an update names at least one field.
- Not offered to agents: deleting cards or boards, column and board settings, bulk moves, automations, export, vault search, firing reminders.
- `/api/inbox/*` (routing by `config.routing.json`, capture keys, provenance) stays for external sources with `INGEST_API_TOKEN`; the MCP server does not use it.
