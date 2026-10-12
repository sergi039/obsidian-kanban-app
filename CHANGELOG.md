# Changelog

## 2026-10-12

### Calendar events are automatic
- The card's events now come from the calendars themselves: the API reads the work calendar through Microsoft Graph and the personal one through Google Calendar every 10 minutes and links an event to a card when the event's description carries the card link (or the card quotes the event's link). Nobody pastes links any more — the paste field, account selector and `PATCH calendar_events` are gone.
- Title similarity is deliberately not used: tried on real data, every candidate it produced was a different task.
- "＋ New event" opens the board's calendar with the card link in the event body, so the saved event shows up on the card by itself. `/api/health` reports each calendar's sync state.

### Calendar events
- Cards can carry calendar event links (`calendar_events`, DB-only, up to 20 per card). The card face shows the nearest event as a direct link (`📆 Tomorrow 10:00`); with several events a `+N` toggle expands the full list inline instead of growing the card.
- Each event opens in the right calendar: work events in Outlook (Microsoft 365), personal ones in Google Calendar with `authuser=<email>`, so a personal event no longer opens in the default account and shows "event not found".
- The account comes from the link (Google `eid` email) or the board default (`calendarAccount` per board, `calendarAccounts` in `config.boards.json`); it is stored per event and can be changed when attaching. The card detail adds a Calendar section: paste a link, optional title/time, remove, plus "New event" (prefilled with the card title, due date and a link back to the card) and "Open calendar" for the chosen account.

### Board
- New cards land at the top of their column instead of the bottom — from the board, the table view, MCP and inbox captures alike; "+ Add item" moved above the cards to match. Tasks typed directly into the `.md` file in Obsidian still join the end of their column.
- A reload reopens the board you were on (remembered per browser) instead of always jumping to the first board. A `?board=`/`?card=` deep link still wins, and switching boards clears it from the address bar so the next reload follows the switch.
- The checkbox on a board card now marks it done: ticking moves the card to `Done` (and writes `[x]` to Markdown), unticking moves it back to `Backlog`. It used to only select the card for the bulk bar, so ticking it never closed anything. Bulk selection stays on Cmd/Ctrl-click; the table view's Done checkbox shares the same column logic.

### Cards
- Cards can be deleted from the card detail view (🗑 Move to trash). Trashing removes the task line and its sub-item lines from the board's `.md` file but keeps the card row with its comments, custom fields, and reminders — previously there was no way to delete a card from the UI at all.
- The 🗑 header button opens the board's trash; Restore puts the exact Markdown lines back after the task that preceded them and returns the card to the end of its column. Undoing the deletion in Obsidian (the line with the same `kb:id` reappears) restores the card automatically.
- Trashed cards are hidden from boards, table view, saved views, filters, exports, and card counts; their reminders no longer reach delivery agents (`/api/reminders/due`, board and channel listings).

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
