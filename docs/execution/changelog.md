# Execution Changelog

## 2026-06-04

- Added agent task ingestion through `/api/inbox/*`, shared `ingestCard()`, and a dedicated MCP package so Claude/OpenAI/Codex clients can create Kanban tasks through one API contract instead of writing Markdown or SQLite directly.
- Added D++ provenance storage (`source_uid`, `source_url`, bounded `source_meta`, `inbox_captures`) because external captures need idempotency, auditability, and safe source links without mutating `kb:*` markers.
- Added routing config and confidence/margin clarification behavior so desktop agents can choose work, personal, or property boards when confident and ask the user when ambiguous.
- Added fail-closed ingest authentication because external agent write endpoints must not rely on optional local-development API auth.
- Updated reconciler link handling so Markdown remains the canonical link source for existing cards, not only newly inserted cards.
