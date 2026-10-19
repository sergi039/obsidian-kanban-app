# Kanban and Obsidian on this Mac

Written by `obsidian-kanban-app/scripts/install-personal-mac.sh`; a rerun rewrites
this file. Help: `~/obsidian-kanban-app/docs/personal-install.md`.

## Kanban

- «добавь (задачу) в канбан», «в канбан: …», "add to kanban" and the like mean a
  card on the board server of this Mac: API `{{API_URL}}/api`, no token. Never
  edit a board's Markdown file by hand. If `curl -sS {{API_URL}}/api/health`
  fails, say the board server is not running and follow *Troubleshooting* in the
  help file.
- Boards: `GET /boards`, never an archived one. One board: use it. Several and
  the task does not say which: one short question naming them. Column: the
  board's first column unless the user names one.
- Look in `GET /boards/<board>/cards` for the same task first and update it
  rather than duplicate. New: `POST /cards` with `{board_id, title}`, then
  `PATCH /cards/<id>` with `description`, `due_date` (`YYYY-MM-DD`) and `links`
  (`[{url, title}]`, http(s) only). `PATCH` replaces `description` and `links`
  whole: on an existing card send the old content plus the addition.
- The description stands without the chat: what, why, next step and deadline in
  2–6 lines. When the task comes from or belongs to an Obsidian note, add
  `Obsidian: [[exact note title]]`.
- Reply with the card link `{{API_URL}}/?board=<board>&card=<id>`.

## Obsidian

- «обсидиан», «заметки», «моя база», Obsidian, vault mean the Basic Memory
  tools (`mcp__{{MCP_NAME}}__*`), project `{{BM_PROJECT}}`: search and read
  there first; save with `write_note` or `edit_note`, never as a downloadable
  file.
- If those tools are missing in this session, say so and suggest a new session;
  if a new session has none either, follow *Troubleshooting* in the help file.
