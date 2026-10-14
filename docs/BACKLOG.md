# Backlog

Standing backlog for findings that are not fixed in the session that found them.
An entry names a searchable anchor, never a line number. A `fixed:` claim names a
commit that is an ancestor of `main`. The owner decides what becomes an issue.

| ID | Priority | Task | Acceptance Criteria | Status |
|----|----------|------|---------------------|--------|
| B-1 | P2 | `config.boards.json` is rewritten in place by every config writer in `apps/api/src/config.ts` (`updateBoardColumns`, `addBoardToConfig`, `updateBoardInConfig`, `deleteBoardFromConfig`, `updateBoardPriorities` call `writeFsSync(p, …)` on the live file). A crash or full disk during a board or column edit leaves a truncated config, and the API cannot boot until it is restored from a `data/config.boards.backup-*` copy. Found 2026-10-14 while working on issue #9. | All config writers go through one helper that writes an owner-only temp file in the same directory, fsyncs it and renames it over the config; a test shows that a write failing midway leaves the previous config intact. | backlog |
