# 📋 Obsidian Kanban App

A GitHub Projects-style Kanban board synced to your Obsidian vault. Tasks live in plain Markdown files — edit them in Obsidian or the web UI, changes sync both ways.

![Board View](https://img.shields.io/badge/view-Board-blue) ![Table View](https://img.shields.io/badge/view-Table-green) ![Obsidian Sync](https://img.shields.io/badge/sync-Obsidian-purple) ![Docker](https://img.shields.io/badge/deploy-Docker-2496ED)

## ✨ Features

**Board & Views**
- **Board view** — drag & drop cards between columns (Backlog → In Progress → Done)
- **Table view** — spreadsheet-style with inline editing
- **Saved views** — custom filter/sort/group configurations per board
- **Board sorting** — sort cards by priority, category, due date, title, or last updated
- **Filtering** — context-aware autocomplete with dynamic value suggestions

**Card Management**
- **Sequential IDs** — GitHub-style `#1`, `#2`, `#3` per board
- **Descriptions** — rich text description field with inline editing
- **Checklists** — GitHub-style task lists with progress bar
- **Managed links** — add/remove clickable links, stored in DB (auto-normalized URLs)
- **Comments** — full CRUD with linkified URLs, author avatars, timestamps
- **Reminders** — per-card reminder records with due/upcoming badges, snooze/dismiss, and polling-friendly API state
- **Custom fields** — TEXT, NUMBER, DATE, SINGLE_SELECT, ITERATION types per board
- **Desktop agent capture** — Claude/OpenAI/Codex clients can create tasks through MCP with safe routing and provenance

**Organization**
- **Custom priorities** — configurable per board with emoji, color, and card visibility
- **Categories** — color-coded labels with per-board management
- **Automations** — trigger actions on card events (e.g., set field when moved to Done)

**Sync & Infrastructure**
- **Bidirectional sync** — edit in Obsidian or the web UI, both stay in sync
- **Column recovery** — column assignments stored in Markdown markers, survives DB loss
- **Real-time updates** — WebSocket push, multiple tabs stay in sync
- **Dark mode** — system-aware theme switching
- **Board management** — create, archive, rename, delete boards from the UI
- **Docker ready** — multi-stage Dockerfile + docker-compose

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+ (recommended: 22+)
- **pnpm** 9+
- **Obsidian** vault with task files (or create them — see below)

### 1. Clone & Install

```bash
git clone https://github.com/sergi039/obsidian-kanban-app.git
cd obsidian-kanban-app
pnpm install
```

### 2. Create Your Task Files in Obsidian

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

#### Priority & Sub-items

```markdown
- [ ] 🔺 Critical security fix
- [ ] ⏫ Refactor auth module
- [ ] Plan Q3 roadmap
      - Research competitors
      - Draft timeline
- [x] Ship v2.0
```

- Priority emojis are configurable per board (default: 🔺 urgent, ⏫ high, 🔵 normal)
- Indented lines under a task = sub-items (shown on the card)
- Frontmatter (`---` block) is preserved and ignored

### 3. Configure Your Boards

Edit `config.boards.json` to point to your vault and task files:

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

### 4. Build & Run

```bash
# Build everything
pnpm build

# Start the server (serves both API and frontend)
SERVE_STATIC=1 pnpm --filter @kanban/api start
```

Open **http://localhost:4000** in your browser.

### Development Mode

```bash
# Terminal 1: API server with auto-restart
pnpm --filter @kanban/api dev

# Terminal 2: Vite dev server with HMR
pnpm --filter @kanban/web dev
```

The Vite dev server runs on `http://localhost:3456` and proxies API calls to `:4000`.

### Docker

```bash
# Set your vault path and run
VAULT_PATH=/path/to/vault docker compose up -d
```

Optionally set `API_TOKEN` for authenticated access.

### Desktop Agent Capture

Claude Desktop, OpenAI/Codex-style local agents, and other MCP clients can create Kanban cards through the bundled MCP server. The server calls the API only; it does not write Markdown or SQLite directly.

```bash
pnpm --filter @kanban/mcp build
PORT=4000 SERVE_STATIC=1 API_TOKEN=... INGEST_API_TOKEN=... pnpm --filter @kanban/api start
```

Configure the desktop app to run `apps/mcp/dist/server.js` with:

```bash
KANBAN_API_URL=http://127.0.0.1:4000
KANBAN_API_TOKEN=...
```

Routing rules live in `config.routing.json`. Agents auto-create only when routing is confident; otherwise they return clarification options so the user can choose work, personal, or another board.

See [Desktop MCP setup](docs/desktop-mcp.md) for Claude/OpenAI/Codex configuration and agent instructions.

## 📁 Project Structure

```
obsidian-kanban-app/
├── config.boards.json       ← Board configuration (edit this!)
├── config.routing.json      ← Desktop agent routing rules
├── docker-compose.yml       ← Docker deployment
├── Dockerfile               ← Multi-stage production build
├── data/
│   └── kanban.db            ← SQLite database (auto-created)
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
│   ├── mcp/                 ← MCP server for Claude/OpenAI/Codex desktop capture
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

## 🔄 How Sync Works

```
Obsidian (.md files)  ←→  Reconciler  ←→  SQLite DB  ←→  Web UI
```

1. **Startup:** The reconciler reads your `.md` files and creates/updates cards in SQLite
2. **File watcher:** When you edit a file in Obsidian, changes sync to DB within ~300ms
3. **Write-back:** When you change a card in the web UI (done, priority, column), the `.md` file is updated
4. **Recovery markers:** Each task gets `<!-- kb:id=abc kb:col=In+Progress -->` — column assignments survive even if the database is deleted

### What Gets Synced

| Direction | What |
|-----------|------|
| `.md` → DB | Task text, done state, priority emoji, sub-items, links (new cards) |
| DB → `.md` | Done checkbox `[x]`/`[ ]`, priority emoji, column marker |
| DB only | Column position, labels, categories, custom fields, comments, descriptions, checklists, managed links, reminders |

## 🛠 Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `SERVE_STATIC` | — | Set to `1` to serve frontend from `apps/web/dist` |
| `API_TOKEN` | — | Bearer token for API authentication |
| `INGEST_API_TOKEN` | — | Required bearer token for `/api/inbox/*` agent ingestion routes |

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

`trigger_at` values must be timezone-aware ISO datetimes (`Z` or explicit offset). See [Reminders](docs/reminders.md).

Delivery channels:

- `In app` shows badges, counts, and reminder panel state inside Kanban.
- `Browser notification` works while the Kanban web app is open and browser notification permission is granted.
- `macOS notification`, `Calendar event`, and `Email via Mail.app` require the local macOS agent. Calendar reminders are marked fired after handoff to Calendar.app:

```bash
KANBAN_API_URL=http://127.0.0.1:4000 \
KANBAN_APP_URL=http://127.0.0.1:4000 \
KANBAN_REMINDER_EMAIL_TO=you@example.com \
pnpm reminders:macos:install
```

### Board Columns

Columns are defined per board in `config.boards.json`. The special column name **"Done"** triggers automatic checkbox sync:
- Move card to "Done" → `- [x]` in Markdown
- Move card from "Done" → `- [ ]` in Markdown

You can also configure `doneColumns` per board for custom done-state column names.

## 🔧 Troubleshooting

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

**Port already in use?**
```bash
lsof -ti:4000 | xargs kill
```

**Desktop agent cannot create tasks?**
- Confirm the API process was started with `INGEST_API_TOKEN`
- Confirm the MCP process has `KANBAN_API_TOKEN` set to the same value
- Rebuild MCP after code changes: `pnpm --filter @kanban/mcp build`
- Restart the API after editing `config.routing.json`

## Tech Stack

- **Frontend:** React 19, Tailwind CSS, @dnd-kit, Vite
- **Backend:** Hono, better-sqlite3, Zod, chokidar
- **Infra:** pnpm workspaces, Docker, WebSockets

## 📄 License

MIT
