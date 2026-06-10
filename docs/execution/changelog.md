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
