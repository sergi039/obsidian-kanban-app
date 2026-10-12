# Execution Changelog

## 2026-06-04

- Added agent task ingestion through `/api/inbox/*`, shared `ingestCard()`, and a dedicated MCP package so Claude/OpenAI/Codex clients can create Kanban tasks through one API contract instead of writing Markdown or SQLite directly.
- Added D++ provenance storage (`source_uid`, `source_url`, bounded `source_meta`, `inbox_captures`) because external captures need idempotency, auditability, and safe source links without mutating `kb:*` markers.
- Added routing config and confidence/margin clarification behavior so desktop agents can choose work, personal, or property boards when confident and ask the user when ambiguous.
- Added fail-closed ingest authentication because external agent write endpoints must not rely on optional local-development API auth.
- Updated reconciler link handling so Markdown remains the canonical link source for existing cards, not only newly inserted cards.
- Accepted Claude Desktop as the primary supported desktop agent and deferred OpenAI/ChatGPT Desktop write support because it likely requires custom/full MCP workspace support plus remote/tunnel infrastructure.
- Added Kanban-owned reminders schema/API/UI because due dates alone cannot support exact-time follow-ups, snooze/dismiss, or macOS polling agents.
- Added timezone-aware reminder validation and source-idempotency because email follow-up reminders must be safe to retry and deterministic across local/desktop agents.
- Added browser notifications and a local macOS reminder agent for Notification Center, Calendar `.ics` handoff, and Mail.app email reminders because all non-in-app channels need an explicit delivery path outside the Kanban web UI.
- Added configurable Calendar.app target calendar delivery because `.ics` import dialogs can default to a work account even for personal-board reminders.
- 2026-10-12: Added calendar event links on cards (`cards.calendar_events`) with per-board default accounts because tasks have meetings in two calendars (Outlook for work, Google for personal) and Google links opened in the wrong signed-in account.
- 2026-10-12: Replaced manual calendar links with an automatic sync (Graph for work, Google for personal) linking events by explicit card references, because the owner will not paste links and fuzzy title matching attached unrelated events on real data.
- 2026-10-12: Closing a card appends a dated line to the `## Канбан` section of the Obsidian notes it is explicitly linked with (and sets `updated:`), because the owner keeps task context in notes that went stale after the task closed; explicit references only, since title search matched dozens of unrelated notes.
- 2026-10-12: Closed cards land at the top of Done on every path without an explicit drop position (status field, bulk close, `[x]` in Obsidian), because the owner looks for just-closed cards at the top like new ones; dragging keeps the drop position.
- 2026-10-12: Obsidian context notes keep one line per card (later closes move the date), Markdown-link backlinks are recognised (the `)` was read into the card id), titles are quoted, `updated:` keeps time/comment, non-UTF-8 notes are left untouched, and repeated problem comments are dropped — closing the review remainders of #20.
- 2026-10-12: The board fits the window with per-column scrolling, and any column collapses to a strip remembered per board in localStorage, because a long Done column stretched the whole page and every column to several screens; Trello/GitHub Projects/Jira bound column height the same way.
- 2026-10-12: Done got a page-size picker (Auto / 5 / 10 / 20, remembered in localStorage) with "Show more", because the owner wants Done shorter than the screen on request while Auto keeps fitting their screen.
- 2026-10-12: Done's default page size is 10 instead of Auto (owner request); Auto is stored explicitly so an empty entry can mean the default.
