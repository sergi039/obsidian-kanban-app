# Changelog

## 2026-06-12

### Stability
- API now backs up `config.boards.json` to `data/config.boards.backup-<ts>.json` on every successful boot (keeps last 3, skips when unchanged) — the gitignored config previously had no recovery path when it went missing.
- Missing or unparsable `config.boards.json` at boot now logs a clear restore hint (latest backup path + `config.boards.example.json`) and exits cleanly instead of crash-looping on a raw ENOENT stack trace.
- Oversized LaunchAgent logs (`logs/api.stderr.log` / `api.stdout.log` over 5 MB) are rotated to `<name>.1` at boot — a past crash loop had grown stderr to ~222k lines.

## 2026-06-04

### Reminders
- Added per-card reminders with exact `trigger_at` datetimes, status tracking, snooze/dismiss/fire actions, and due polling API for future macOS notification agents.
- Added in-app reminder badges, header reminder count/panel, card-detail reminder creation, and `reminder:*` / `has:reminder` filters.
- Added reminder documentation and timezone-aware API validation.
- Added browser notification delivery for open Kanban tabs and a local macOS delivery agent for Notification Center, Calendar `.ics` handoff, and Mail.app email reminders.
- Added configurable Calendar.app target calendar delivery so reminder events can be created directly in a personal calendar instead of defaulting to a work-calendar import dialog.

### Stability
- Added API typecheck/build script so root `pnpm build` verifies backend TypeScript, not only the web bundle.
- Reused the shared test DB schema in reconciler tests to prevent drift from production migrations.
- Reconciler now respects configured done/open columns instead of writing hardcoded `Done`/`Backlog`.
- `kb:col` markers now percent-encode column names, preserving spaces, punctuation, `+`, and non-Latin text while still reading legacy `+` markers.

### Authentication
- Added frontend API token storage, bearer headers for fetch requests, and WebSocket `?token=` support so `API_TOKEN` deployments remain usable from the UI.

### Automations
- Automation `set_field` actions now reuse the same field value validation and normalization as the fields API.

## 2026-02-19

### Board Management
- **Create boards** from UI — [+] button in header tabs
- **Archive/Restore** — right-click board tab → Archive, 📦 button to restore
- **Rename** — right-click → Rename (inline edit)
- **Delete** — removes from config, keeps .md file

### Recovery System
- **kb:col markers** — column assignments stored in .md files for disaster recovery
- **Safety guards** — reconciler refuses bulk deletes (>80% or all cards)
- **DB backups** — automatic on startup, keeps last 3
- **Test isolation** — fixed critical bug: tests were wiping production DB

### Documentation
- Comprehensive README with setup guide, Obsidian instructions, troubleshooting

## 2026-02-18

### Phase 5: Automations
- Rule engine with triggers (card.created, card.moved) and actions (set_field, add_comment, move_card)
- Automations panel UI

### Phase 4: Custom Fields
- Per-board custom fields (TEXT, NUMBER, SELECT, DATE, CHECKBOX)
- Field values API + validation

### Phase 3: Views
- Board view (Kanban) + Table view (spreadsheet)
- View switcher

### Phase 2: Filter Engine
- Query syntax with qualifiers (status, priority, label, due, done, has)
- Client + server-side filter parity

### Phase 1: Core
- DnD board with cross-column card moves
- Column management (add, rename, delete, reorder)
- Sequential IDs per board (#1, #2, #3)
- Markdown ↔ SQLite bidirectional sync
- Priority writeback (🔺/⏫)
- Real-time WebSocket updates
