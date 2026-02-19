# 📋 Obsidian Kanban App

A GitHub Projects-style Kanban board powered by your Obsidian vault. Tasks live in plain Markdown files — edit them in Obsidian or the web UI, changes sync both ways.

![Board View](https://img.shields.io/badge/view-Board-blue) ![Table View](https://img.shields.io/badge/view-Table-green) ![Obsidian Sync](https://img.shields.io/badge/sync-Obsidian-purple)

## ✨ Features

- **Board view** — drag & drop cards between columns (Backlog → In Progress → Done)
- **Table view** — spreadsheet-style with inline editing, sorting, filters
- **Bidirectional sync** — edit in Obsidian or the web UI, both stay in sync
- **Sequential IDs** — GitHub-style `#1`, `#2`, `#3` per board
- **Priority emoji** — 🔺 urgent, ⏫ high — synced to Markdown
- **Column recovery** — column assignments stored in Markdown markers, survives DB loss
- **Custom fields** — add your own fields per board
- **Automations** — trigger actions on card moves (e.g., auto-close when moved to Done)
- **Real-time updates** — WebSocket push, multiple tabs stay in sync
- **Dark mode** — system-aware theme switching

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+ (recommended: 22+)
- **npm** 10+ (comes with Node.js)
- **Obsidian** vault with task files (or create them — see below)

### 1. Clone & Install

```bash
git clone https://github.com/sergi039/obsidian-kanban-app.git
cd obsidian-kanban-app
npm install
```

### 2. Create Your Task Files in Obsidian

Open your Obsidian vault and create a Markdown file for each project/board. The format is simple — just a checklist:

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

**That's it!** Each `- [ ]` line becomes a card. `- [x]` means done.

#### Optional: Priority & Sub-items

```markdown
- [ ] 🔺 Critical security fix
- [ ] ⏫ Refactor auth module
- [ ] Plan Q3 roadmap
      - Research competitors
      - Draft timeline
- [x] Ship v2.0
```

- `🔺` = urgent priority
- `⏫` = high priority
- Indented lines under a task = sub-items (shown on the card)

You can have **frontmatter** (the `---` block) with tags — the app ignores it and preserves it.

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
    },
    {
      "id": "personal",
      "name": "Personal",
      "file": "Tasks/Personal.md",
      "columns": ["Backlog", "In Progress", "Done"]
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

> **Tip:** You can add as many boards as you want. Each board = one `.md` file.

### 4. Build & Run

```bash
# Build the frontend
npm run build --workspace apps/web

# Start the server (serves both API and frontend)
SERVE_STATIC=1 npm start --workspace apps/api
```

Open **http://localhost:4000** in your browser. 🎉

### Development Mode

For active development with hot reload:

```bash
# Terminal 1: API server with auto-restart
npm run dev --workspace apps/api

# Terminal 2: Vite dev server with HMR
npm run dev --workspace apps/web
```

The Vite dev server runs on `http://localhost:3456` and proxies API calls to `:4000`.

## 📁 Project Structure

```
obsidian-kanban-app/
├── config.boards.json      ← Board configuration (edit this!)
├── data/
│   └── kanban.db            ← SQLite database (auto-created)
├── apps/
│   ├── api/                 ← Backend (Hono + SQLite + file watcher)
│   │   └── src/
│   │       ├── index.ts     ← Server entry point
│   │       ├── reconciler.ts ← Markdown ↔ DB sync engine
│   │       ├── parser.ts    ← Markdown task parser
│   │       ├── writeback.ts ← DB → Markdown writer
│   │       ├── watcher.ts   ← File change watcher
│   │       └── routes/      ← API endpoints
│   └── web/                 ← Frontend (React + Tailwind + dnd-kit)
│       └── src/
│           ├── App.tsx
│           └── components/
│               ├── Board.tsx
│               ├── Column.tsx
│               ├── Card.tsx
│               ├── DraggableCard.tsx
│               └── TableView.tsx
```

## 🔄 How Sync Works

```
Obsidian (.md files)  ←→  Reconciler  ←→  SQLite DB  ←→  Web UI
```

1. **Startup:** The reconciler reads your `.md` files and creates/updates cards in SQLite
2. **File watcher:** When you edit a file in Obsidian, changes are detected and synced to DB within ~300ms
3. **Write-back:** When you change a card in the web UI (done, priority, column), the `.md` file is updated
4. **Recovery markers:** Each task gets a hidden marker like `<!-- kb:id=abc kb:col=In+Progress -->` — this means your column assignments survive even if the database is deleted

### What Gets Synced

| Direction | What |
|-----------|------|
| `.md` → DB | Task text, done state, priority emoji, sub-items |
| DB → `.md` | Done checkbox `[x]`/`[ ]`, priority emoji, column marker |
| DB only | Column position, labels, custom fields, comments |

## 🛠 Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `SERVE_STATIC` | — | Set to `1` to serve frontend from `apps/web/dist` |

### Board Columns

Columns are defined per board in `config.boards.json`. The special column name **"Done"** triggers automatic checkbox sync:
- Move card to "Done" → `- [x]` in Markdown
- Move card from "Done" → `- [ ]` in Markdown

## 📝 Creating Your First Board

**Step-by-step for Obsidian beginners:**

1. Open Obsidian → click "New Note" (or `Ctrl+N`)
2. Name it something like `My Tasks` (this creates `My Tasks.md`)
3. Type your tasks as a checklist:
   ```
   - [ ] Buy groceries
   - [ ] Call dentist
   - [ ] Fix leaky faucet
   - [x] Pay rent
   ```
4. Save the file. Note the path — you'll need it for `config.boards.json`
5. Find your vault's root folder:
   - Obsidian → Settings → Files & Links → look at "Vault location"
   - Or right-click any note → "Reveal in Finder/Explorer"
6. Your `file` path in config is relative to the vault root
   - If vault is `/Users/me/Notes` and file is `/Users/me/Notes/Projects/Tasks.md`
   - Then `file` = `"Projects/Tasks.md"`

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
# Find and kill the process using port 4000
lsof -ti:4000 | xargs kill
```

## 📄 License

MIT
