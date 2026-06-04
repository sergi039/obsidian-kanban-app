# ADR 0001 — Provenance storage for inbox/captured tasks

- **Status:** Proposed — consensus pending (Claude position recorded; Codex to add its position to the Consensus log below)
- **Date:** 2026-06-04
- **Deciders:** Sergi (owner), Claude, Codex
- **Scope:** Part of the "personal task hub" initiative — turning the existing Obsidian-Kanban board into a hub that ingests tasks from Telegram / email / web clipper / Claude (MCP) / mobile, all producing identical cards.

---

## Context

The app is a single-user Kanban board over an Obsidian vault: Markdown is the source of truth, SQLite (`data/kanban.db`) is a sidecar, a reconciler/watcher keeps them in sync, and stable identity is carried by an HTML-comment marker on each task line (`<!-- kb:id=ab12 kb:col=In+Progress -->`).

We are adding an **ingestion layer** so external sources can create cards. The agreed shape:

- A single shared service `ingestCard()` is the executable contract; `POST /api/cards` (extended), `POST /api/inbox/capture`, and the future MCP tools are all thin entrypoints over it.
- **Locked decision:** a capture creates **a real card in an `Inbox` board AND a row in an `inbox_captures` log** (the log powers dedup/idempotency + audit). Recorded here so it is not re-litigated.
- **Locked decision:** links are **canonical in Markdown** (a URL in → `[title](url)` in the task text) and mirrored into the DB `cards.links` list — every source converges on the same result.

This ADR decides **one open question: where does *provenance* live** — the metadata describing where an incoming task came from.

### Code constraints (verified, with references)

- `POST /api/cards` today accepts only `board_id, title, column` ([apps/api/src/routes/cards.ts:18](../../apps/api/src/routes/cards.ts)); enrichment (links, description, priority, due, labels) is a separate `PATCH` ([cards.ts:24](../../apps/api/src/routes/cards.ts)). Capture must create + enrich atomically → hence the shared `ingestCard()`.
- The `kb:id`/`kb:col` marker is the **only** recovery channel and is parsed in the hot path. Its regex is `KB_ID_RE` ([apps/api/src/parser.ts:24](../../apps/api/src/parser.ts)); the column value charset is `[A-Za-z0-9+_-]+`.
- Only the API process holds `suppressWatcher()` and is the single SQLite writer ([cards.ts:154](../../apps/api/src/routes/cards.ts)). Any other writer (MCP, bridges) writing `.md`/DB directly would bypass suppression → reconcile echo loop + write contention. **All sources must go through the running API over HTTP.**
- The DB is **backed up on every startup** (`kanban.backup-<ts>.db`, last 3 kept, WAL-checkpointed first) ([apps/api/src/index.ts:88](../../apps/api/src/index.ts)).
- Auth is all-or-nothing: with `API_TOKEN` set everything but `/health` requires Bearer; without it everything is open ([apps/api/src/middleware/security.ts:24](../../apps/api/src/middleware/security.ts)). `HOST` defaults to `127.0.0.1` ([index.ts:175](../../apps/api/src/index.ts)). Request body capped at 1 MB on both layers ([index.ts:149](../../apps/api/src/index.ts), [security.ts:8](../../apps/api/src/middleware/security.ts)).

---

## Decision drivers (criteria)

"Provenance" decomposes into three distinct needs plus one orthogonal concern:

1. **Back-link** — clickable link to the original (Telegram message, email thread, clipped page).
2. **Origin-type** — `telegram | email | web-clipper | …` for a card badge and for filtering.
3. **Rich-meta** — author, timestamp, attachments, raw payload.
4. **Survive catastrophic rebuild** — if `kanban.db` is rebuilt from `.md` *without* a backup, how much provenance survives?
5. **Visible inside Obsidian** — is provenance usable when reading the raw `.md` in Obsidian, not just on the board?
6. **No hot-path risk** — avoid changing the `kb:` marker regex that reconciler/writeback depend on.

> **Orthogonal:** dedup / idempotency (`capture_key`) lives in the `inbox_captures` table in **every** option — it does not discriminate between them.

### Two facts that reframe the decision

1. **DB is backed up on every boot.** So "wipe `kanban.db` → rebuild from `.md`" is the *catastrophic* path; the *normal* recovery is restoring `kanban.backup`, which preserves DB-resident provenance. This weakens the argument that provenance *must* live in Markdown.
2. **The marker charset can't hold a URL** (`:`, `/`, `.` are excluded). A full `kb:ref` back-link in the marker would need extra encoding or a regex rewrite — weakening the "marker-only" option.

---

## Options

- **A — Hybrid:** `kb:src=telegram` added to the marker (origin survives rebuild) + `source` / `source_ref` / `source_meta` columns in the DB.
- **B — DB-only:** `source` / `source_ref` / `source_meta` columns; marker untouched.
- **C — Marker-only:** `kb:src` / `kb:ref` in the comment; no DB schema change.
- **D — Link-in-Markdown + structure-in-DB** *(synthesis; falls out of the locked "links canonical in Markdown" decision)*: the **back-link** is written as a normal `[original](url)` link in the task body via the existing links pipeline (canonical, Obsidian-visible, survives rebuild); **origin-type + rich-meta** live in the DB; **the marker is untouched**.

### Scorecard

| Criterion | A Hybrid | B DB-only | C Marker-only | D Link + DB |
|---|---|---|---|---|
| 1. Back-link to original | ✅ | ✅ | ⚠️ URL doesn't fit marker | ✅ MD link |
| 2. Origin-type badge / filter | ✅ DB | ✅ DB | ⚠️ scan markers | ✅ DB |
| 3. Survive catastrophic rebuild | 🟡 type yes, meta no | ❌ all lost | ✅✅ | 🟡 link yes, type/meta no |
| 4. Rich-meta (author/attachments/raw) | ✅ DB | ✅ DB | ❌ no room | ✅ DB |
| 5. Visible inside Obsidian | 🟡 HTML comment hidden in preview | ❌ invisible | 🟡 comment | ✅ ordinary link |
| 6. No hot-path regex risk | ⚠️ marker edit | ✅ | ⚠️⚠️ more edits | ✅ marker untouched |
| (dedup — orthogonal) | ✅ | ✅ | ✅ | ✅ |

---

## Usage scenarios (how it looks in practice under D)

1. **Forwarded a Telegram voice note + a listing link.** Bridge saves the audio to `vault/attachments/`, sends a capture: `title`=transcript, `links`=[listing], body contains `[Original in Telegram](https://t.me/…)`; DB stores `source=telegram`, `source_meta={author, sent_at, attachments:[audio]}`. Card shows a TG badge + two clickable links. Links are visible in Obsidian.
2. **"Show all tasks from email this week."** `filter source:email` against a DB index — instant.
3. **Deleted `kanban.db`.** Normal: restore `kanban.backup` → everything intact. Catastrophic (no backup): rebuild from `.md` → cards and the **back-link in the task text survive**, but the "from Telegram" badge / author / attachment metadata are gone.
4. **Click a card → open the original.** The back-link in body/`links` opens TG / email / page.

---

## Claude's position

**Recommend D.** It satisfies 5 of 6 criteria fully, **leaves the hot-path marker untouched** (removing the main test risk), and the back-link survives even catastrophic rebuild because it rides the already-agreed "links canonical in Markdown" rule. The only concession — origin-type/rich-meta do not survive a rebuild *without* a backup (scenario 3) — is acceptable given the DB is backed up on every boot.

**Flip to A** only if it is a *hard* requirement that the **origin type** survive catastrophic rebuild-without-backup. Then add a minimal `kb:src` to the marker on top of D (but not `kb:ref` — a URL won't fit the charset).

**Not B:** the only option that loses provenance entirely on rebuild and is invisible in Obsidian. **Not C:** blocked by the marker charset for URLs and can't hold rich-meta.

### Concrete shape if D is chosen

- `cards`: add `source TEXT`, `source_ref TEXT` (queryable mirror of the back-link), `source_meta TEXT DEFAULT '{}'` (author, sent_at, attachments[], raw). Added via the `MIGRATIONS` array pattern ([db.ts:99](../../apps/api/src/db.ts)).
- New table `inbox_captures(capture_key TEXT PRIMARY KEY, card_id TEXT, source TEXT, created_at TEXT)`.
- Back-link written as a normal Markdown link by `ingestCard()` and mirrored into `cards.links`.
- `parser.ts` marker regex: **unchanged**.

---

## Consensus log

- **Claude (2026-06-04):** Recommends **D**. Rationale above. Open to **A** under the stated flip condition.
- **Codex (2026-06-04):** Recommends **D++**: keep D's core split (backlink in Markdown, structured provenance in DB/log) but amend the contract before implementation. Use `source_uid` for the opaque stable source identifier used for dedup/audit (email Message-ID, Telegram chat/message id, etc.) and `source_url` for the optional user-openable HTTP(S) backlink; do not overload one `source_ref` field for both. `inbox_captures.card_id` should reference `cards.id ON DELETE SET NULL` so deleting a card does not erase dedup/audit history. The Markdown backlink should use a reserved source-link convention only when `source_url` exists, and the UI/reconciler must strip or classify that reserved link so it does not pollute card titles. **Required implementation constraint:** if links are canonical in Markdown, `reconcileBoard()` must refresh `cards.links` on existing-card updates, not only inserts. Dissent: option A is not a cheap flip with the current marker writer; `injectKbId()` / `injectKbCol()` rebuild the marker and would drop unknown `kb:*` attrs unless the marker parser/writer is refactored and covered by tests.
- **Resolution:** _pending._

---

## Decision

_Pending consensus. Update Status to "Accepted" and record the chosen option here once Claude and Codex converge._

---

## Consequences

To be finalized with the decision. If **D**: small additive migrations, no marker/reconciler risk, provenance reuses the links pipeline; trade-off is loss of structured origin-type/rich-meta on a backup-less catastrophic rebuild.
