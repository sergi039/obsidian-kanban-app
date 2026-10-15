# Backlog

Standing backlog for findings that are not fixed in the session that found them.
An entry names a searchable anchor, never a line number. A `fixed:` claim names a
commit that is an ancestor of `main`. The owner decides what becomes an issue.

| ID | Priority | Task | Acceptance Criteria | Status |
|----|----------|------|---------------------|--------|
| B-1 | P2 | `config.boards.json` is rewritten in place by every config writer in `apps/api/src/config.ts` (`updateBoardColumns`, `addBoardToConfig`, `updateBoardInConfig`, `deleteBoardFromConfig`, `updateBoardPriorities` call `writeFsSync(p, …)` on the live file). A crash or full disk during a board or column edit leaves a truncated config, and the API cannot boot until it is restored from a `data/config.boards.backup-*` copy. Found 2026-10-14 while working on issue #9. | All config writers go through one helper that writes an owner-only temp file in the same directory, fsyncs it and renames it over the config; a test shows that a write failing midway leaves the previous config intact. | done — fixed: 9a3e76f (#38) |
| B-2 | P3 | Gmail follow-ups cannot dismiss themselves: the personal Google refresh token (`google-oauth` account in `config.boards.json`) has only `calendar.readonly`, so `fetchThreadMessages` in `apps/api/src/mail-followup.ts` gets HTTP 403 and the follow-up stays `state: "unchecked"` (it still fires on time). Needs the owner: run `./node_modules/.bin/tsx apps/api/src/cli/google-consent.ts` (added 2026-10-15) and allow both permissions; if it reports the Gmail API is off, enable it with the link it prints. Left open when issue #2 was closed on 2026-10-15. | After the new consent, a Gmail follow-up's thread read succeeds (`/api/health` → `followUps.failed` is 0 with an active Gmail follow-up) and a real reply dismisses it. | in_progress (tool shipped; waiting for the owner to run it) |
