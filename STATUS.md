# Project Status — Obsidian Kanban App

**Last updated:** 2026-02-19 13:10 CET
**Commit:** f7b2d29 (main)

## Architecture

- **Monorepo**: `apps/api` (Hono + SQLite + chokidar) + `apps/web` (React + dnd-kit + Tailwind)
- **Data flow**: Obsidian `.md` files ↔ Reconciler ↔ SQLite DB ↔ Web UI
- **Config**: `config.boards.json` — board definitions (vaultRoot, boards[], defaultColumns)
- **DB**: `data/kanban.db` (SQLite WAL mode), auto-created on startup
- **Real-time**: WebSocket push for multi-tab sync

## Completed Features

### Phase 1: Core Kanban Board
- [x] Board view with drag-and-drop (dnd-kit)
- [x] Card DnD between columns (custom `kanbanCollision` detection)
- [x] Column DnD (reorder via drag handle)
- [x] Column management (add, rename, delete, reorder)
- [x] Card creation with sequential IDs (#1, #2, #3 per board)
- [x] Done toggle (checkbox writeback to .md)
- [x] Priority writeback (🔺/⏫ emoji in .md)

### Phase 2: Filter Engine
- [x] Query syntax: `status:`, `priority:`, `label:`, `due:`, `done:`, `has:`, free text
- [x] Client-side + server-side filter parity

### Phase 3: Views
- [x] Board view (Kanban columns)
- [x] Table view (spreadsheet-style with inline editing)
- [x] View switcher in header

### Phase 4: Custom Fields
- [x] Per-board custom fields (TEXT, NUMBER, SELECT, DATE, CHECKBOX)
- [x] Field values CRUD API
- [x] Board-scoped validation

### Phase 5: Automations
- [x] Rule engine: trigger → conditions → actions
- [x] Triggers: card.created, card.moved
- [x] Actions: set_field, add_comment, move_card
- [x] UI panel for managing rules
- [x] Dry-run test endpoint

### Recovery & Safety (2026-02-19)
- [x] **kb:col markers** — column assignments persisted in .md files (`<!-- kb:id=xxx kb:col=In+Progress -->`)
- [x] **Reconciler recovery** — reads kb:col on DB loss, restores correct columns
- [x] **stampAllColumns()** — stamps current columns into .md on every startup
- [x] **Safety guard** — reconciler refuses to delete all cards or >80% at once
- [x] **DB backup** — `kanban.backup-*.db` created on startup (keeps last 3)
- [x] **Test isolation** — `createTestDb()` for in-memory test DB (was root cause of data loss)

### Board Management (2026-02-19)
- [x] **Create board** — [+] button in header, creates .md file + config entry
- [x] **Archive board** — right-click → Archive, 📦 button to view/restore
- [x] **Rename board** — right-click → Rename, inline edit on tab
- [x] **Delete board** — right-click → Delete, keeps .md file

## Known Issues

### DnD Persistence (unconfirmed)
Card cross-column DnD may not persist correctly in some cases. The `dragOriginRef` fix was deployed but user hasn't fully confirmed. The DnD test component (`🧪 Test` button) is still in UI for debugging.

### Architect-GPT Subagent
GPT 5.3 Codex tends to loop on file reads without producing analysis. Multiple code review attempts timed out. Config set to `thinkingDefault: high` for the agent. SOUL.md updated with anti-loop instructions. Issue filed in `/Users/ss/openclaw-codex-issue.md`.

## Running the App

```bash
# Build frontend
npm run build --workspace apps/web

# Start server (API + static frontend)
SERVE_STATIC=1 npm start --workspace apps/api
# → http://localhost:4000

# Dev mode (hot reload)
npm run dev --workspace apps/api    # Terminal 1
npm run dev --workspace apps/web    # Terminal 2 → http://localhost:3456
```

## Key Files

| File | Purpose |
|------|---------|
| `config.boards.json` | Board definitions |
| `apps/api/src/reconciler.ts` | .md ↔ SQLite sync engine |
| `apps/api/src/parser.ts` | Markdown task parser (kb:id, kb:col) |
| `apps/api/src/writeback.ts` | DB → .md writer (done, priority, column) |
| `apps/api/src/watcher.ts` | File change watcher + suppress/replay |
| `apps/api/src/routes/boards.ts` | Board CRUD + column management |
| `apps/api/src/routes/cards.ts` | Card CRUD + move + comments |
| `apps/api/src/db.ts` | Schema + migrations + createTestDb() |
| `apps/web/src/App.tsx` | Main app component |
| `apps/web/src/components/Board.tsx` | DnD board view |
| `apps/web/src/components/BoardSwitcher.tsx` | Board tabs + create/archive/rename |
| `apps/web/src/components/TableView.tsx` | Table view |

## Git History

```
f7b2d29 feat: board management — create, archive, rename, delete from UI
8464ed4 fix: tests were using production DB — switch to in-memory createTestDb()
96b78a5 docs: comprehensive README with setup guide, Obsidian instructions, architecture
07c8962 fix: safety guards against card deletion + DB backup on startup
ae5505f feat: column recovery — persist kb:col markers in .md files
1d58850 fix: Phase 5 review
0ed0c57 feat: Phase 5 — Automations Lite
3af678e fix: Phase 4 review
846b6f2 feat: Phase 4 — Custom Fields
c95b413 fix: Phase 3 review
fc9bc50 feat: Phase 3 — Views (Board + Table)
5734dbb feat: Phase 2 — Filter Engine
53f3df8 fix: Phase 1 review — 4 DnD issues
```

## Next Steps (planned)

- [ ] Table View enhancements: inline due date picker, auto-hide done tasks, settings UI
- [ ] Remove DnD test button once DnD confirmed working
- [ ] `npm run start:static` convenience script
- [ ] File watcher for newly created boards (currently needs server restart)
