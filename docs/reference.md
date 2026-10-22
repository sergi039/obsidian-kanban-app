# Reference

Everything technical that used to live in the README: manual setup, the Markdown
format, configuration, sync internals, security, reminders, calendars, Obsidian
context and troubleshooting. For the friendly overview start at the
[README](../README.md).

- [Manual setup](#manual-setup)
- [Task files](#task-files)
- [Board configuration](#board-configuration)
- [Development mode](#development-mode)
- [Docker](#docker)
- [AI assistants (MCP)](#ai-assistants-mcp)
- [Public address (Cloudflare Access)](#public-address-cloudflare-access)
- [How sync works](#how-sync-works)
- [Requests from other web pages](#requests-from-other-web-pages)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Tech stack](#tech-stack)
- [Full feature list](#full-feature-list)

## Manual setup

### Prerequisites

- **Node.js 22** (20–23 work; on newer versions `pnpm install` fails, because
  `better-sqlite3` ships no prebuilt binary for them)
- **pnpm** 9+
- **Obsidian** vault with task files (or create them — see below)

### Clone, install, run

```bash
git clone https://github.com/sergi039/obsidian-kanban-app.git
cd obsidian-kanban-app
pnpm install
# create config.boards.json — see Board configuration below
pnpm build
SERVE_STATIC=1 pnpm --filter @kanban/api start
```

Open **http://localhost:4000** in your browser.

## Task files

Open your Obsidian vault and create a Markdown file for each project/board:

**Example: `Tasks/Work.md`**

```markdown
---
tags:
  - work
---
- [ ] Design new landing page
- [ ] Fix login bug
- [ ] Write API documentation
- [x] Set up CI/CD pipeline
```

Each `- [ ]` line becomes a card. `- [x]` means done.

### Priority & sub-items

```markdown
- [ ] 🔺 Critical security fix
- [ ] ⏫ Refactor auth module
- [ ] Plan Q3 roadmap
      - Research competitors
      - Draft timeline
- [x] Ship v2.0
```

- Priority emojis are configurable per board (default: 🔺 urgent, ⏫ high, 🟦 normal)
- Indented lines under a task = sub-items (shown on the card)
- Frontmatter (`---` block) is preserved and ignored

## Board configuration

Create `config.boards.json` in the repository root (it is gitignored;
`config.boards.example.json` shows every option) and point it to your vault and
task files:

```json
{
  "vaultRoot": "/path/to/your/Obsidian/Vault",
  "boards": [
    {
      "id": "work",
      "name": "Work",
      "file": "Tasks/Work.md",
      "columns": ["Backlog", "In Progress", "Review", "Done"]
    }
  ],
  "defaultColumns": ["Backlog", "In Progress", "Done"]
}
```

| Field | Description |
|-------|-------------|
| `vaultRoot` | Absolute path to your Obsidian vault root folder |
| `boards[].id` | Unique short ID (used in URLs, no spaces) |
| `boards[].name` | Display name shown in the UI |
| `boards[].file` | Path to the `.md` file **relative to vaultRoot** |
| `boards[].columns` | Column names for this board (order matters!) |
| `defaultColumns` | Fallback columns for boards without explicit ones |

> **Tip:** You can also create boards from the UI with vault search — it finds `.md` files containing task lists.

## Development mode

```bash
# Terminal 1: API server with auto-restart
pnpm --filter @kanban/api dev

# Terminal 2: Vite dev server with HMR
pnpm --filter @kanban/web dev
```

The Vite dev server runs on `http://localhost:3456` and proxies API calls to `:4000`.

## Docker

> **Not working at the moment** (backlog B-6 in [BACKLOG.md](BACKLOG.md)): inside the container the server listens on `127.0.0.1` only, and board edits cannot save the read-only `config.boards.json`. Use the [Mac install](personal-install.md) or the [manual setup](#manual-setup) instead.

```bash
# config.boards.json must exist in the repository root (see Board configuration);
# inside the container VAULT_ROOT=/vault replaces its vaultRoot
VAULT_PATH=/path/to/vault docker compose up -d
```

Optionally set `API_TOKEN` for authenticated access.

## AI assistants (MCP)

Claude Code, Codex, Claude Desktop and other MCP clients work with the boards through the bundled MCP server (`apps/mcp`). It calls the board API over HTTP like the web page does; it never writes Markdown or SQLite itself.

```bash
pnpm --filter @kanban/mcp build
```

The client runs `node apps/mcp/dist/server.js` with:

| Variable | Default | Description |
|----------|---------|-------------|
| `KANBAN_API_URL` | `http://127.0.0.1:4000` | The board server |
| `KANBAN_API_TOKEN` | — | Only when the board runs with `API_TOKEN`: the same value |
| `KANBAN_APP_URL` | `KANBAN_API_URL` | Address the card links in answers open, e.g. the board's public address |

The one-script install registers it for Claude Code and Codex. See [AI assistants (MCP)](desktop-mcp.md) for the tools and the setup of each client.

## Public address (Cloudflare Access)

The owner's install: `https://kanban.cervantes50.com` reaches the server on the Mac mini through Cloudflare Tunnel `obsidian-kanban` (one route to `127.0.0.1:4000`, any other hostname gets 404) behind Cloudflare Access: a one-time PIN sent only to the addresses in `~/.config/obsidian-kanban-tunnel/allowed_emails`, session 30 days. The server itself still listens on loopback only and runs without `API_TOKEN`, so Access is the only sign-in; the server itself refuses requests from other web pages (see [Requests from other web pages](#requests-from-other-web-pages)). Local clients (MCP server, reminder agent) keep using `http://127.0.0.1:4000`.

```bash
python3 cloudflare/kanban_access_setup.py verify   # API token + one-time PIN login method
python3 cloudflare/kanban_access_setup.py apply    # tunnel -> config -> Access app + policy -> audit -> DNS
python3 cloudflare/kanban_access_setup.py audit    # re-check every invariant, exit 1 on any problem
cp ops/launchd/com.cloudflare.cloudflared.obsidian-kanban.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cloudflare.cloudflared.obsidian-kanban.plist
```

The Cloudflare API token is read from `~/.config/vc-site/cloudflare_api_token` (mode 600); tunnel credentials and config live owner-only in `~/.config/obsidian-kanban-tunnel/`. DNS is created only after the Access app passes the audit, so the name is never public unprotected.

## How sync works

```
Obsidian (.md files)  ←→  Reconciler  ←→  SQLite DB  ←→  Web UI
```

1. **Startup:** The reconciler reads your `.md` files and creates/updates cards in SQLite
2. **File watcher:** When you edit a file in Obsidian, changes sync to DB within ~300ms
3. **Write-back:** When you change a card in the web UI (done, priority, column), the `.md` file is updated
4. **Recovery markers:** Each task gets `<!-- kb:id=abc kb:col=In+Progress -->` — column assignments survive even if the database is deleted

### What gets synced

| Direction | What |
|-----------|------|
| `.md` → DB | Task text, done state, priority emoji, sub-items, links (new cards) |
| DB → `.md` | Done checkbox `[x]`/`[ ]`, priority emoji, column marker |
| DB only | Column position, labels, categories, custom fields, comments, descriptions, checklists, managed links, reminders |
| Trash | Deleting a card removes its task block from `.md` and keeps it in the DB; restore writes the same lines back. Re-adding the line in Obsidian also restores it |
| Context notes | Closing a card appends a dated line to the `## Канбан` section of each linked note and sets its frontmatter `updated:` — see [Obsidian context](#obsidian-context) |

## Requests from other web pages

The server answers only requests addressed to it, on every path and with or without `API_TOKEN`:

- the `Host` must be `localhost`, `127.0.0.1` or `[::1]` (any port) or the host of `publicUrl` — a DNS-rebinding page cannot send these;
- a request that carries `Origin` must come from exactly the address the server is reached at, scheme included (`http://localhost:4000`, `http://127.0.0.1:4100`, the `publicUrl` origin such as `https://kanban.cervantes50.com`) or from `CORS_ORIGIN` (default: the local dev origins `http://localhost:3456` and `:4000`). Browsers send `Origin` on every cross-site write and every WebSocket.

Anything else gets `403` (the WebSocket upgrade too) and one `[security] Refused …` line in the log with the Host and Origin it saw. This keeps a page open in a browser on the same Mac (a cross-site form or `fetch`, DNS rebinding) away from a server without `API_TOKEN`, and a site visited while signed in to Cloudflare Access away from the public address. Clients that send no `Origin` — curl, the MCP server, the reminder agent — are not affected. To open the app under another name (a LAN address, Docker on another host), set that address as `publicUrl`.

## Configuration reference

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `SERVE_STATIC` | — | Set to `1` to serve frontend from `apps/web/dist` |
| `API_TOKEN` | — | Bearer token for API authentication |
| `INGEST_API_TOKEN` | — | Required bearer token for the `/api/inbox/*` capture routes (external sources; the MCP server does not use them) |

### Reminders

Reminders are stored in SQLite as Kanban-owned task metadata. They do not write back to Markdown files.

Supported API surface:

- `GET /api/reminders?board_id=...` — list reminders for a board
- `GET /api/reminders?card_id=...` — list reminders for a card
- `GET /api/reminders/due?before=...&channel=macos` — polling-friendly due lookup
- `POST /api/reminders` — create a reminder for a card
- `POST /api/reminders/:id/snooze` — postpone an active reminder
- `POST /api/reminders/:id/dismiss` — stop showing a reminder
- `POST /api/reminders/:id/fire` — mark delivery by a notification agent

`trigger_at` values must be timezone-aware ISO datetimes (`Z` or explicit offset). See [Reminders](reminders.md).

Delivery channels:

- `In app` shows badges, counts, and reminder panel state inside Kanban.
- `Browser notification` works while the Kanban web app is open and browser notification permission is granted.
- `macOS notification`, `Calendar event`, and `Email via Mail.app` require the local macOS agent. Calendar reminders are marked fired after handoff to Calendar.app:

```bash
KANBAN_API_URL=http://127.0.0.1:4000 \
KANBAN_APP_URL=http://127.0.0.1:4000 \
KANBAN_REMINDER_CALENDAR_NAME="My Calendar" \
KANBAN_REMINDER_EMAIL_TO=you@example.com \
pnpm reminders:macos:install
```

Mail.app delivery from `launchd` requires macOS Automation permission for the Node/osascript process to control Mail. If the log shows `Not authorised to send Apple events to Mail. (-1743)`, grant that permission in System Settings > Privacy & Security > Automation or run `pnpm reminders:agent` from an interactive user session for one-off delivery.

### Calendar accounts

The API links calendar events to cards automatically (every 10 minutes, window −30…+180 days) and stores them in SQLite as `cards.calendar_events` (never written to Markdown, not writable through the API). An event belongs to a card only through an explicit reference — title similarity is not used, because on real data it attached unrelated events:

- the event description contains the card link `https://<publicUrl>/?board=<board>&card=<id>` (or a `kb:id=<id>` marker) — the card's **＋ New event** button and agents that create events for a task put it there;
- or the card's title, description or links contain the event's own link (Outlook `itemid`, Google `eid`).

Accounts, credentials and the public URL live in the gitignored `config.boards.json`:

```json
{
  "publicUrl": "https://kanban.example.com",
  "calendarAccounts": [
    { "id": "work", "label": "Work", "provider": "outlook", "email": "you@company.example",
      "credentials": { "type": "graph-app", "envFile": "/path/to/m365.env" } },
    { "id": "personal", "label": "Personal", "provider": "google", "email": "you@gmail.example",
      "credentials": { "type": "google-oauth", "clientEnvFile": "/path/to/google-client.env", "tokenFile": "~/.config/obsidian-kanban/google-personal-token.json" } }
  ],
  "boards": [
    { "id": "work", "calendarAccount": "work", "...": "..." },
    { "id": "private", "calendarAccount": "personal", "...": "..." }
  ]
}
```

- `graph-app`: an Entra app with `Calendars.Read` (application); the env file holds `M365_TENANT_ID` and `M365_CLIENT_ID`. The client secret is the one-line owner-only file `M365_CLIENT_SECRET` in the directory named by `VSDB_SECRETS_DIR` in that env file (a relative directory counts from the env file; `~/` is the home directory); a `M365_CLIENT_SECRET=` line of the env file is used only when that file does not exist, and a secret file that is a symlink, readable by others, empty or longer than one line is refused by path. Only `GET /users/<email>/calendarView` is called.
- `google-oauth`: the env file holds `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` of a desktop OAuth client; `tokenFile` holds the owner's refresh token (scope `calendar.readonly`, mode 600), created once by an OAuth consent. Without it the account reports `not connected`. The same accounts read email threads for follow-ups ([docs/reminders.md](reminders.md#email-follow-ups)): Graph needs `Mail.Read`, Google needs `gmail.metadata` in the consent as well. To make or renew the Google grant with both scopes, run `./node_modules/.bin/tsx apps/api/src/cli/google-consent.ts` from the repository root: it opens Google's consent page, checks that the grant has a refresh token, both scopes and the configured account's verified address, refuses a token directory that anyone else could write, writes the token file owner-only, reports the refresh-token lifetime (a "Testing" OAuth app gets 7-day tokens) and whether Gmail answers.
- Credentials are read at sync time, never logged and never sent to the browser. `/api/health` → `calendar` shows per account `ok`, `lastSyncAt`, `events`, `linked`, `error`. A failing account keeps the events it had.
- A board's `calendarAccount` (and credentials matching the provider) is validated at boot; restart the API after editing.

### Obsidian context

When a card is closed, the API looks for its context notes in the vault and records the closing there. A note counts only through an explicit reference — searching the vault for words of the title matched dozens of unrelated notes on real data:

- the card's title, description, sub-items, checklist or links carry an `obsidian://open?vault=<vault>&file=<note>` link or a `[[wikilink]]` to the note (attachments such as PDFs and embeds `![[…]]` are ignored; a bare name must match exactly one note);
- or the note carries the card link `https://<publicUrl>/?board=<board>&card=<id>`.

Board files are never context, and `kb:id` markers do not count (copies of board files carry them); a card link quoted inside another card's closing line does not count either. Each note holds one line per card at the end of its `## Канбан` section (the section is created at the end of the note when missing) — a later close of the same card moves the date in that line instead of adding one — and frontmatter `updated:` is set (added if absent; a note without frontmatter keeps none; a datetime value keeps its time and a trailing `# comment` stays). The card title is quoted, so it never becomes a live `[[link]]` or `#tag`. Nothing else in the note changes; a note that is not UTF-8 is left untouched and reported on the card. The card gets an `obsidian` comment with the updated notes and any references that did not resolve (the same problems are not repeated when nothing was written). The update runs in the background after the close (one vault scan per batch, about 0.3 s for 6.4k notes) and is logged as `[obsidian-context]`.

### Board columns

Columns are defined per board in `config.boards.json`. The special column name **"Done"** triggers automatic checkbox sync:

- Move card to "Done" → `- [x]` in Markdown
- Move card from "Done" → `- [ ]` in Markdown

You can also configure `doneColumns` per board for custom done-state column names.

## Troubleshooting

**Server exits with "config file not found"?**
- `config.boards.json` is gitignored — every successful boot backs it up to `data/config.boards.backup-<timestamp>.json`
- The boot error prints the exact `cp` command to restore from the latest backup
- No backups yet? Copy `config.boards.example.json` and edit `vaultRoot` and `boards`

**Empty board after startup?**
- Check that `vaultRoot` and `file` paths in `config.boards.json` are correct
- The `.md` file must have `- [ ]` or `- [x]` checklist items
- Run the server and check console output for reconcile counts

**Cards not updating when I edit in Obsidian?**
- The file watcher needs ~300ms after the last change to trigger
- Check console for `[watcher] Reconciled ...` messages

**Lost column assignments?**
- Column data is stored in `<!-- kb:col=... -->` markers in your `.md` files
- If markers are missing, cards default to "Backlog" (unchecked) or "Done" (checked)
- The server stamps markers on startup — just restart to restore

**`pnpm install` fails in `better-sqlite3` (`gyp ERR!`)?**
- Your Node.js is newer than 23; install Node.js 22 and run `pnpm install` again

**Port already in use?**

```bash
lsof -ti:4000 | xargs kill
```

**The assistant cannot reach the board?**
- A tool error saying the board server does not answer: check `curl http://127.0.0.1:4000/api/health` and that `KANBAN_API_URL` names that server
- `Kanban API 401`: the board runs with `API_TOKEN`; give the MCP server `KANBAN_API_TOKEN` with the same value
- No kanban tools at all: `claude mcp get obsidian-kanban` or `codex mcp get obsidian-kanban`, then start a new session
- Rebuild MCP after code changes: `pnpm --filter @kanban/mcp build`

## Project structure

```
obsidian-kanban-app/
├── config.boards.json       ← Board configuration (edit this!)
├── config.routing.json      ← Desktop agent routing rules (gitignored, copy from example)
├── docker-compose.yml       ← Docker deployment
├── Dockerfile               ← Multi-stage production build
├── data/
│   ├── kanban.db            ← SQLite database (auto-created)
│   ├── kanban.backup-*.db   ← DB backups, last 3 (auto-created on boot)
│   └── config.boards.backup-*.json ← Config backups, last 3 (auto-created on boot)
├── apps/
│   ├── api/                 ← Backend (Hono + SQLite + file watcher)
│   │   └── src/
│   │       ├── index.ts     ← Server entry point
│   │       ├── db.ts        ← SQLite schema + migrations
│   │       ├── reconciler.ts ← Markdown ↔ DB sync engine
│   │       ├── parser.ts    ← Markdown task parser
│   │       ├── writeback.ts ← DB → Markdown writer
│   │       ├── watcher.ts   ← File change watcher
│   │       ├── automations.ts ← Event-driven automation engine
│   │       ├── filter-engine.ts ← Query parser for filters
│   │       ├── utils.ts     ← Shared utilities
│   │       └── routes/      ← API endpoints (cards, boards, views, fields, automations, reminders)
│   ├── mcp/                 ← MCP server: the board tools for Claude and Codex
│   └── web/                 ← Frontend (React 19 + Tailwind + @dnd-kit)
│       └── src/
│           ├── App.tsx
│           ├── api/client.ts ← API client
│           ├── lib/
│           │   └── link-utils.ts ← Shared link handling
│           ├── types/index.ts
│           └── components/
│               ├── Board.tsx          ← Board view with drag-and-drop + sorting
│               ├── Column.tsx         ← Sortable column
│               ├── Card.tsx           ← Card face (badges, priority, links)
│               ├── CardDetail.tsx     ← Card modal (description, checklist, links, comments)
│               ├── TableView.tsx      ← Table view with inline editing
│               ├── BoardSwitcher.tsx  ← Board selector + create/archive
│               ├── BoardSettings.tsx  ← Priorities, categories management
│               ├── BoardSort.tsx      ← Sort dropdown
│               ├── Filters.tsx        ← Filter bar with autocomplete
│               ├── ViewSwitcher.tsx   ← Saved views management
│               ├── AutomationsPanel.tsx ← Automation rules UI
│               └── ColumnManager.tsx  ← Add/rename/delete columns
```

## Tech stack

- **Frontend:** React 19, Tailwind CSS, @dnd-kit, Vite
- **Backend:** Hono, better-sqlite3, Zod, chokidar
- **Infra:** pnpm workspaces, Docker, WebSockets

## Full feature list

**Board & views**
- **Board view** — drag & drop cards between columns (Backlog → In Progress → Done)
- **Table view** — spreadsheet-style with inline editing
- **Saved views** — custom filter/sort/group configurations per board
- **Collapsible columns** — the board fits the window and each column scrolls on its own; the collapse button in a column header folds it (e.g. a long Done) into a narrow strip with its card count, remembered per board in this browser; cards can still be dropped on the strip
- **Done page size** — "Show" next to Done's "Add item": 10 newest cards by default, or 5 / 20, each with "Show more", or Auto (whole column, fits the screen); remembered in this browser
- **Board sorting** — sort cards by priority, category, due date, title, or last updated
- **Filtering** — context-aware autocomplete with dynamic value suggestions

**Card management**
- **Sequential IDs** — GitHub-style `#1`, `#2`, `#3` per board
- **Descriptions** — rich text description field with inline editing
- **Checklists** — GitHub-style task lists with progress bar
- **Managed links** — add/remove clickable links, stored in DB (auto-normalized URLs)
- **Comments** — full CRUD with linkified URLs, author avatars, timestamps
- **Reminders** — per-card reminder records with due/upcoming badges, snooze/dismiss, and polling-friendly API state
- **Calendar events** — events from the work (Outlook, Microsoft Graph) and personal (Google) calendars appear on their card automatically; the card shows the nearest one as a direct link (`+N` expands the rest) and opens each in the right account
- **Custom fields** — TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION types per board
- **Done checkbox** — tick the checkbox on a board card to move it to Done (`[x]` in Markdown); untick to send it back to Backlog
- **Closed cards on top** — a closed card lands at the top of Done, whether it was closed by the checkbox, the card's status, a bulk close, or `[x]` typed in Obsidian; only dragging puts it exactly where it is dropped
- **Bulk actions** — Cmd/Ctrl-click cards to select several, then move or close them at once
- **Trash** — delete a card from its detail view; its Markdown lines leave the file, its comments/fields/reminders stay, and the Trash panel in the toolbar restores it to the same place in the file
- **Obsidian context on close** — when a card is closed (board, table, bulk, or `[x]` typed in Obsidian), the notes it is linked with get a dated `✅ Карточка закрыта` line in their `## Канбан` section and a fresh `updated:` date; the card gets an `obsidian` comment naming them
- **AI assistants** — Claude Code, Codex and Claude Desktop find, add, update, move and close cards through MCP; a task from an email links back to it and one thread stays one card ([desktop-mcp.md](desktop-mcp.md#tasks-from-email))

**Organization**
- **Custom priorities** — configurable per board with emoji, color, and card visibility; the emoji is the marker written to Markdown, the UI shows a flag in the priority color
- **Categories** — color-coded labels with per-board management
- **Automations** — trigger actions on card events (e.g., set field when moved to Done)

**Sync & infrastructure**
- **Bidirectional sync** — edit in Obsidian or the web UI, both stay in sync
- **Column recovery** — column assignments stored in Markdown markers, survives DB loss
- **Real-time updates** — WebSocket push, multiple tabs stay in sync
- **Dark mode** — system-aware theme switching
- **Board management** — create, archive, rename, delete boards from the UI
- **Boot resilience** — config and DB are backed up to `data/` on every boot (last 3 kept); a missing `config.boards.json` prints an exact restore command instead of crashing, and oversized logs rotate automatically
- **Docker ready** — multi-stage Dockerfile + docker-compose
