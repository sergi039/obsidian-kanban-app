# Kanban and Obsidian on this Mac

Written by `obsidian-kanban-app/scripts/install-personal-mac.sh`; a rerun rewrites
this file. Help: `~/obsidian-kanban-app/docs/personal-install.md`.

## Kanban

- «добавь (задачу) в канбан», «в канбан: …», "add to kanban" and the like mean a
  card on the board server of this Mac, made with the kanban tools
  (`mcp__{{KANBAN_MCP_NAME}}__*`); their instructions say how to pick the board
  and avoid duplicates. Never edit a board's Markdown file by hand and never
  call the board's API with curl.
- If those tools are missing in this session, say so and suggest a new session.
  If a tool says the board server does not answer, say the board server is not
  running and follow *Troubleshooting* in the help file.
- Column: the board's first column unless the user names one. When the task
  comes from or belongs to an Obsidian note, add `Obsidian: [[exact note title]]`
  to the description.
- Reply with the card's `card_url`; the board page is {{API_URL}}.

## Obsidian

- «обсидиан», «заметки», «моя база», Obsidian, vault mean the Basic Memory
  tools (`mcp__{{MCP_NAME}}__*`), project `{{BM_PROJECT}}`: search and read
  there first; save with `write_note` or `edit_note`, never as a downloadable
  file.
- If those tools are missing in this session, say so and suggest a new session;
  if a new session has none either, follow *Troubleshooting* in the help file.
