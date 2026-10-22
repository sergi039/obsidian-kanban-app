# Changelog

## 2026-10-22

### Other sites can no longer use the owner's sign-in to kanban.cervantes50.com (backlog B-4)
- The Cloudflare Access cookies of the public address were sent with requests from any other site for the whole 30-day session (Cloudflare's default, SameSite None). They are now SameSite Lax: a page on another site cannot make the browser attach them, while a link to a card from an email, a calendar event or a notification still opens signed in.
- `cloudflare/kanban_access_setup.py audit` now fails when the setting is anything but Lax, including unset. A browser keeps the old cookie until the next sign-in.

### Card times show the local time (backlog B-5)
- "Created" and "Updated" in the card detail, and the "Updated" date in the table view, were off by the viewer's UTC offset: the database stores these times in UTC without a zone, and the page read them as local time, so in Madrid a card created at 07:17 showed 5:17. They now show the local time of the event. Comment times and the table's "hide done after N days" already read them as UTC; all of these now go through one helper.

### Docker works again (backlog B-6)
- `docker compose up` had not worked since February: inside the container the server listened on `127.0.0.1` only, so the published port answered nothing. The image did not build either: `pnpm@latest` now stops at `pnpm install` (`ERR_PNPM_IGNORED_BUILDS`), and `pnpm prune`, which pnpm does not support in a workspace, emptied the API's dependencies. The image now listens on every container interface, and `docker-compose.yml` publishes the board on the host's loopback only (`127.0.0.1:4000`), as the native install does.
- Board and column edits are saved in Docker: the config now lives in a mounted `config/` folder (`KANBAN_CONFIG_PATH=/config/config.boards.json`) instead of a read-only mounted file, which the atomic config write could not replace.
- The image installs a pinned pnpm (10.25.0, the version used in development) on a Node 22 base pinned by digest, keeps production dependencies by reinstalling with `--prod`, starts the API without fetching anything at run time (`tsx` is now a runtime dependency of the API), and no longer copies `.env`, a local `config.boards.json`, logs or databases from the checkout into the image.
- The MCP server stays on the host and talks to the container at `http://localhost:4000`. The Docker option is back in the README.

### Claude Code and Codex work with the board through its MCP server
- The MCP server (`apps/mcp`) no longer needs a token: it calls the same API as the board page, so it works on the owner's Mac mini and on personal installs, which run without `API_TOKEN`. Before, its three tools went through `/api/inbox/*`, which answered 401 without `INGEST_API_TOKEN`, and no client had it registered.
- Eight tools instead of three: list boards, find cards, create a card (with description, due date, links, or from an email), update a card, rewrite its description, move or close it, comment, follow up an email. The routing tools `kanban_route_task` and `kanban_capture_task` and `kanban_list_destinations` are gone; `/api/inbox/*` stays for external sources.
- Adding to a card no longer risks losing what it had: `PATCH /api/cards/:id` takes `append_description` and `add_links`, merged in the same step that reads the card, so an edit made meanwhile in the browser stays and a link is not added twice. Rewriting a whole description is a separate tool, which Codex asks to approve.
- The one-script install builds the server and registers it for Claude Code and, when Codex is on the Mac, for Codex; uninstall removes both. The «в канбан» rule it writes uses the tools instead of `curl`.
- Answers carry each card's link (`card_url`) on `KANBAN_APP_URL` when set, the board's public address, else on the API address.

## 2026-10-19

### Other web pages can no longer change the boards (issue #47, backlog B-3)
- The server runs without `API_TOKEN` on the Mac mini and on personal installs, so any web page open in a browser on the same Mac could create or change cards (a `text/plain` POST needs no CORS preflight), and a DNS-rebinding page could also read the boards. Through `kanban.cervantes50.com` the same worked from any site while the owner was signed in to Cloudflare Access, whose cookie is sent on cross-site requests (SameSite None by default).
- Every request and the WebSocket upgrade are now refused with `403` unless the `Host` is a loopback name or the `publicUrl` host and a present `Origin` is that same address (scheme included) or a `CORS_ORIGIN` entry. The board page, the public address, curl, the MCP server and the reminder agent work as before.
- A WebSocket upgrade with a malformed address (`GET http://[/ws`) threw inside the server's upgrade handler and stopped the process; it is now dropped.

## 2026-10-17

### Work calendar and email follow-ups read the Microsoft secret from its file
- The work account (`graph-app` credentials) stopped syncing on 2026-10-15 when VSDB moved its vendor secrets out of `.env` into one owner-only file per secret (`VSDB_SECRETS_DIR`): `/api/health` → `calendar.work` reported «credentials file is missing M365_CLIENT_SECRET». The loader now takes the client secret from `$VSDB_SECRETS_DIR/M365_CLIENT_SECRET` (the directory named in the same env file) and uses a `M365_CLIENT_SECRET=` line only when that file does not exist; without either, health names the missing secret as before.
- A secret file that is a symlink, a directory, readable by group or others, empty, several lines or oversized is refused by path and reason, never by content, and the env line is not used in its place.

## 2026-10-15

### One command to let Gmail follow-ups notice the answer (backlog B-2)
- `./node_modules/.bin/tsx apps/api/src/cli/google-consent.ts` renews the personal Google grant with read access to email headers (`gmail.metadata`) on top of the calendar. It opens Google's consent page; the owner signs in and allows. The new grant replaces the old one only if it has a refresh token, both permissions and the configured account's verified address.
- The token file is written owner-only and atomically, and only into a directory nobody else can change (mode bits, symlinks and macOS ACLs are checked before the consent page opens).
- The tool always says how long Google lets the refresh token live: an OAuth app still in "Testing" gets 7-day tokens, which would also end the calendar sync. It also checks that Gmail answers, and if the Gmail API is off in the Google Cloud project it gives the link to turn it on.

### Board settings can no longer leave a broken config file (backlog B-1)
- Every change of `config.boards.json` from the app (columns, board create/rename/archive/delete, priorities, categories) now writes a new owner-only file next to it, flushes it to disk and swaps it in at once. A crash, a full disk or a failed write leaves the previous config untouched; before, the file was rewritten in place and could be left cut off, and the API would not start until it was restored from a backup.
- A change that the server could not boot with (for example a board pointing at an unknown calendar account) is refused and nothing is written.
- An unused second writer for priorities was removed; all changes go through one path.

### Reminder links open outside the home network
- Reminder emails, Calendar events and macOS notifications linked the card at `http://127.0.0.1:4000`, which opens only on the Mac mini. They now link it on the public address (`publicUrl`, https://kanban.cervantes50.com behind Cloudflare Access); the local address is used only when no public address is configured.
- Every reminder from the API carries this link as `card_url` (`null` without `publicUrl`).

## 2026-10-14

### Remind me if they don't answer (issue #2, EMAIL-3)
- A card made from an email can get a follow-up: "remind me in N days if nobody answers" (or "remind me to answer"). It is a normal reminder (macOS notification by default) that fires N days after the last message of the side the wait is on.
- Every 10 minutes the Kanban looks at the thread, the way it already looks at the calendars: message headers, never the text. When the answer arrives, the reminder is removed by itself and the card gets a comment "Ответ получен … от …". An out-of-office reply or a bounce is not an answer.
- Works for the work Outlook mailbox now. The personal Gmail needs one more Google consent (read email headers); until then a Gmail follow-up still reminds on time but cannot notice the answer.

### «В канбан» from an email (issue #2, EMAIL-2)
- The card endpoint the agents already use (`POST /api/cards`) takes the same `email` object as the capture endpoints. A card made from an email links to it, and asking again for the same thread returns that card (200) instead of a second one. No token or MCP setup is needed.

### Links added on a card are no longer erased
- A link added on the card (in the app or by an agent: calendar event, tracking, document) was stored on the card only. Any edit of the board file in Obsidian, even of another task, and any rename of the card replaced the card's links with the ones written in its Markdown line, so these links silently disappeared. Now they stay; a link written in the line and deleted from it in Obsidian is still removed.
- At the time of the fix 45 such links on 12 cards were at risk; 5 of them, erased on 2026-10-14 by a sync, were restored from the boot backup.

### Tasks from email keep their link and thread (issue #2, EMAIL-1)
- A capture can say which email it came from: provider (Gmail or Outlook), mailbox, message id and thread id. The card then links to that email (`[from:email](…)` in the task line), in the same link formats invoice-zero uses.
- One email thread is one task: capturing the same thread again returns the card it already has instead of a second card, even with another title or a later message in the thread.
- The card keeps only header-level fields of the email (subject, sender, date, ids). An email body or anything that looks like a credential in the capture's metadata is rejected.
- The MCP tool `kanban_capture_task` takes the same `email` object.

### Sync hardening (issue #9)
- The done checkbox can no longer tick the wrong task. A card is found by its `kb:id` only, and a card without one only on its recorded line while that line still reads the same. The old fallback searched five lines up and down by title and ticked another task with the same title.
- A card whose recorded line now holds a heading or other non-task line is still found by its `kb:id`; before, the write-back stopped with "Line is not a checkbox".
- Editing a card (`PATCH`) or moving it now returns every failed write to the `.md` file in `_writeBackWarning`: priority, done state and column, not only the title. Before, those failures answered 200 while the file and the board disagreed.
- Error responses no longer carry raw exception text with absolute vault paths: card create, inbox capture, sync reload and `.md` write-back failures answer with a short message, and the details stay in the server log.
- Adding, reordering, renaming or deleting a column now refreshes the board in other open tabs.
- Column edits can no longer hide cards: a reorder must keep every column, a rename cannot take another column's name, and a delete only moves cards into a column that stays on the board.
- The filter `has:comments` in the web now shows the cards with comments; it used to hide every card. An unknown `has:` or `due:` value is ignored, as the server filter does, instead of emptying the board.
- "Sync" (reload) now also re-watches the board files, so boards added to `config.boards.json` by hand or a changed `vaultRoot` are picked up without a restart.

## 2026-10-13

### Even icons
- Every icon in the UI is now one SVG line-icon set (toolbar, card meta, column controls, card detail, table, panels, menus) instead of emoji and symbol glyphs, which rendered at different sizes and baselines and looked crooked next to the text.
- On a narrow window the header now wraps onto a second row and the filter field shrinks, instead of squeezing every button so its icon sat on top of its label ("Board", "Sort", "Auto", "Sync" each in two lines).
- Priorities show a flag in the priority color on cards, in the table and in the card's Priority field, instead of the emoji (⏫ rendered as a blue box inside an orange "High" badge). The emoji stays the marker written to the Markdown file; board settings show a flag preview next to each color.

## 2026-10-12

### Done shows 10 cards by default
- With nothing chosen in this browser, Done now shows its 10 newest cards and "Show more" instead of the whole column. Auto, 5 and 20 are still in the "Show" picker, and Auto is now remembered too.

### How many Done cards to show
- Done has a "Show" picker next to "Add item": Auto (the whole column, as tall as the screen, scrolling inside), 5, 10 or 20. With a number, Done shows that many cards from the top (the newest closed) and "Show N more · M hidden" opens the next page; "Show less" goes back to one. The choice is remembered in this browser.
- A card dropped on Done's empty area while cards are hidden lands at the top; a Done card dropped there stays where it was, since the real end of the list is out of sight.

### Collapsible columns, board fits the screen
- The board is now as tall as the window and each column scrolls on its own, as in Trello and GitHub Projects. Before, a long Done (22 cards on `vs`) stretched the page to three screens, stretched every other column to the same height, and pushed the horizontal scrollbar to the very bottom.
- Any column, Done included, collapses to a narrow strip with its name and card count (« in the column header; click the strip to expand). The choice is remembered per board in this browser, like Trello's collapsed lists. A card dropped on a collapsed column lands at its top.

### Obsidian context: fewer surprises
- A note keeps one closing line per card: closing the card again on a later day (or a DB restored from a backup) moves the date in that line instead of adding a second one.
- Backlinks written as Markdown links — `[карточка](https://…/?board=…&card=…)` — are now recognised; the closing `)` used to be read as part of the card id. Calendar links in event bodies benefit the same way.
- The card title in the line is quoted: `[[…]]` and `#tags` from a title no longer become live links or tags, and a card link inside a title no longer ties the note to that other card.
- `updated:` keeps a trailing YAML comment and its time when it had one; a note that is not UTF-8 is left untouched and named on the card; a "note not found" comment is not repeated on every close.

### Obsidian context on close
- Closing a card now updates its context in Obsidian: each note the card links to (`obsidian://` link or `[[wikilink]]`) or that links back to the card gets a dated `✅ Карточка закрыта: «…» — [Board #N](card link)` line in its `## Канбан` section and a fresh frontmatter `updated:` date. The card gets an `obsidian` comment listing the notes, or the references that did not resolve.
- Works for every way of closing: drag to Done, the card checkbox, the table view, bulk close, and `[x]` typed in Obsidian.
- Only explicit references count; a title search was rejected because it matched dozens of unrelated notes in the real vault. Board files and `.trash`/dot-folders are never touched.

### Closed cards on top
- A card closed from the card's status field, by a bulk close, or by ticking `[x]` in Obsidian now lands at the top of Done, as the board checkbox already did. Before, the status field and bulk close appended it to the bottom, and a task ticked in Obsidian kept its old position from the column it left. Dragging still drops the card exactly where it is released.

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
