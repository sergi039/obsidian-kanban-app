# Obsidian Kanban Web App — Implementation Plan

## Overview
Standalone web app that reads existing Obsidian markdown checklist files and displays them as GitHub Projects-style Kanban boards with drag-and-drop.

## Source Files (READ-ONLY except checkbox toggling)
Vault: `/Users/ss/Desktop/Private/Obsidian/Notes/Notes/`

4 task files:
1. `Business/VS/Tasks VirtoSoftware.md` — ~25 tasks (VS business)
2. `Private/Tasks Private.md` — ~8 tasks (personal)
3. `Property/Cervantes 50/Task List Cervantes.md` — ~9 tasks (property renovation)
4. `Business/VP/Tasks VP.md` — 1 task

### Real Task Format Examples
```markdown
- [ ] MS Case - EU Commission - track 
- [ ] Marketing plan with Olga and Kri - till 1st June. How to measure
- [ ] https://sam.gov/ 🔺 - delayed because of the passports 
- [ ] Docs Page for Admins - template and what to put on it ⏫ 
- [x] BMW color - ordered ➕ 2025-10-15
- [ ] Led barbacoa 25 1 sm depth 1 sm wide 
	- sub-items with indentation
- [ ] Замена автоматизации полива - https://www.hunterirrigation.com/...
```

Key observations:
- Flat `- [ ]` / `- [x]` checklists, some with YAML frontmatter (tags only)
- Emoji markers: ⏫ (high priority), 🔺 (flagged/urgent), ➕ (date added)
- Inline links: both `[text](url)` and bare URLs
- Sub-items: indented lines under a task
- Mixed languages (EN/RU)
- Free-form text with dates (`till 1st June`)
- Non-task content mixed in (headings, paragraphs, images)
- Files may have duplicate frontmatter blocks (Cervantes file has two)

## Tech Stack
- **Backend**: Node.js + Hono + TypeScript
- **Frontend**: React 19 + Vite + TypeScript + Tailwind CSS + shadcn/ui + dnd-kit
- **Data**: SQLite (better-sqlite3) for sidecar metadata
- **File watching**: chokidar v4
- **Real-time**: WebSocket (ws)
- **Validation**: zod

## Project Structure
```
obsidian-kanban-app/
├── package.json          # workspace root
├── apps/
│   ├── api/              # Hono backend
│   │   ├── src/
│   │   │   ├── index.ts          # entry point
│   │   │   ├── config.ts         # board config loader
│   │   │   ├── db.ts             # SQLite setup + migrations
│   │   │   ├── parser.ts         # markdown checklist parser
│   │   │   ├── writer.ts         # markdown write-back (checkbox only)
│   │   │   ├── watcher.ts        # chokidar file watcher
│   │   │   ├── reconciler.ts     # sync sidecar ↔ markdown
│   │   │   ├── ws.ts             # WebSocket server
│   │   │   └── routes/
│   │   │       ├── boards.ts
│   │   │       ├── cards.ts
│   │   │       └── export.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/              # React frontend
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── api/              # API client
│       │   ├── components/
│       │   │   ├── Board.tsx
│       │   │   ├── Column.tsx
│       │   │   ├── Card.tsx
│       │   │   ├── BoardSwitcher.tsx
│       │   │   ├── CardDetail.tsx
│       │   │   └── Filters.tsx
│       │   ├── hooks/
│       │   └── types/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tailwind.config.ts
│       └── tsconfig.json
├── config.boards.json    # board → file mapping
└── data/
    └── kanban.db         # SQLite sidecar (gitignored)
```

## config.boards.json
```json
{
  "vaultRoot": "/Users/ss/Desktop/Private/Obsidian/Notes/Notes",
  "boards": [
    {
      "id": "vs",
      "name": "VirtoSoftware",
      "file": "Business/VS/Tasks VirtoSoftware.md",
      "columns": ["Backlog", "In Progress", "Blocked", "Done"]
    },
    {
      "id": "private",
      "name": "Private",
      "file": "Private/Tasks Private.md",
      "columns": ["Backlog", "In Progress", "Blocked", "Done"]
    },
    {
      "id": "cervantes",
      "name": "Cervantes 50",
      "file": "Property/Cervantes 50/Task List Cervantes.md",
      "columns": ["Backlog", "In Progress", "Blocked", "Done"]
    },
    {
      "id": "vp",
      "name": "VP",
      "file": "Business/VP/Tasks VP.md",
      "columns": ["Backlog", "In Progress", "Done"]
    }
  ],
  "defaultColumns": ["Backlog", "In Progress", "Blocked", "Done"]
}
```

## Data Model

### SQLite Schema
```sql
CREATE TABLE cards (
  id TEXT PRIMARY KEY,           -- SHA-256 fingerprint (8 chars)
  board_id TEXT NOT NULL,
  column_name TEXT NOT NULL DEFAULT 'Backlog',
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  raw_line TEXT NOT NULL,         -- original markdown line
  line_number INTEGER NOT NULL,   -- line in source file
  is_done BOOLEAN DEFAULT FALSE,
  priority TEXT,                  -- 'high' | 'urgent' | null
  labels TEXT DEFAULT '[]',       -- JSON array
  due_date TEXT,                  -- ISO date if parseable
  sub_items TEXT DEFAULT '[]',    -- JSON array of sub-item texts
  source_fingerprint TEXT,        -- for change detection
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sync_state (
  file_path TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL,
  last_synced TEXT DEFAULT (datetime('now'))
);
```

### Task Identity
- Fingerprint: SHA-256 of `normalize(title) + boardId + occurrenceIndex`
- First 8 hex chars as ID
- On file change: reconciler tries exact match → fuzzy match → mark orphaned

---

## Phase 1: Backend + Parser (THIS PHASE)

### Deliverables
1. Node.js project with Hono HTTP server
2. Markdown checklist parser (line-preserving)
   - Parse `- [ ]` / `- [x]` lines
   - Extract: title, done status, priority (⏫/🔺), links, sub-items
   - Skip non-task lines (headings, paragraphs, images, frontmatter)
   - Handle edge cases: duplicate frontmatter, bare URLs, mixed indentation
3. SQLite sidecar with schema above
4. Reconciler: parse markdown → upsert to SQLite → detect changes
5. Chokidar file watcher: re-parse on .md file change
6. REST API endpoints:
   - `GET /api/boards` — list all boards with task counts
   - `GET /api/boards/:id` — board detail with columns and cards
   - `GET /api/boards/:id/cards` — cards with filters (?column=, ?priority=, ?search=)
   - `PATCH /api/cards/:id` — update card metadata (column, position, labels, priority, due_date)
   - `POST /api/cards/:id/move` — move card to column + position
   - `POST /api/sync/reload` — force re-parse all files
7. Tests for parser (critical edge cases from real files)

### NOT in Phase 1
- No frontend
- No write-back to .md files (read-only)
- No WebSocket yet
- No export endpoints

---

## Phase 2: Frontend — Board UI

### Deliverables
1. React 19 + Vite + TypeScript setup
2. Tailwind CSS + shadcn/ui components
3. Board view with columns (GitHub Projects style)
4. Cards with: title, priority pill, link indicators, sub-item count
5. dnd-kit drag-and-drop between columns
6. Board switcher (tabs or sidebar)
7. Search + filter bar (by column, priority, text search)
8. Card detail panel/drawer (click to expand)
9. API client connecting to Phase 1 backend
10. Vite proxy to backend for dev

---

## Phase 3: Bidirectional Sync

### Deliverables
1. Write-back to .md: toggling done (`[ ]` ↔ `[x]`) updates source file
2. Line-preserving writer (only change the specific line, preserve everything else)
3. Conflict detection: if file changed externally while writing
4. WebSocket server: push updates to frontend on file change
5. Frontend WebSocket client: auto-refresh board on push
6. Optional: HTML comment task IDs (`<!-- kb:id=abc123 -->`) for stable identity

---

## Phase 4: OpenClaw Integration + Export

### Deliverables
1. Export API: `GET /api/export/:boardId?format=telegram|whatsapp|markdown`
2. Formatted output for Telegram (escaped markdown, emoji) and WhatsApp (CAPS headers, plain text)
3. Docker Compose for deployment (app + SQLite volume)
4. Systemd/launchd service config or pm2
5. Update OpenClaw cron jobs to use API instead of direct file parsing
