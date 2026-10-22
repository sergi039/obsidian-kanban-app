# Personal install: one Mac, one person

This sets up the board, its tools for Claude Code and Codex, and Obsidian access
for Claude Code on another person's Mac. Everything runs on that Mac; nothing connects to the owner's Mac mini,
boards or vault. The owner-specific rules in [AGENTS.md](../AGENTS.md)
(calendars, mailboxes, `~/Skills-runtime`) do not apply to such an install.

| Part | Where it ends up |
|---|---|
| Board server (API + web page), LaunchAgent `com.obsidian-kanban` | `http://localhost:4000`, logs in `~/Library/Logs/ObsidianKanban/` |
| Boards | Markdown files in the vault; the first one is `Задачи.md` |
| Kanban tools for the assistant: MCP server `obsidian-kanban` ([what it offers](desktop-mcp.md#tools)) | Claude Code user scope (`~/.claude.json`); Codex (`~/.codex/config.toml`) when Codex is on the Mac |
| Obsidian access for Claude: Basic Memory, project `obsidian` | Claude Code MCP server `obsidian-basic-memory` (user scope, `~/.claude.json`); it changes notes only when asked to write one (`ensure_frontmatter_on_sync` and `auto_update` are off) |
| Rule for «в канбан: …» and «обсидиан» | `~/.claude/rules/obsidian-kanban.md` |
| Node.js, pnpm, uv (pinned, checksum-verified) | `~/.local/share/obsidian-kanban/` |

No administrator password is needed. The first run downloads about 1 GB, takes
about 1.7 GB of disk and 5–10 minutes. Basic Memory also creates an empty
`~/basic-memory` folder (its default project); leave it.

## For Claude: how to install

The person is not technical. Speak plainly, do the commands yourself, and ask
them only for what the steps below name. Do not paste long output at them.

1. **Check the Mac.** `uname -m` must print `arm64`. Run `git --version`; if
   macOS offers to install the command line developer tools, ask them to click
   *Install*, wait until it finishes, then go on.
2. **Ask about Obsidian.** "Do you already use Obsidian? If so, which vault
   should the tasks live in?" Find the folder of the vault they name (for an
   iCloud vault, `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<name>`).
   If they don't use Obsidian, take `~/Obsidian/Notes`. A vault in Documents,
   Desktop or iCloud Drive works only if macOS lets the background server in:
   the installer checks this and macOS may ask whether "node" may access the
   folder — they click *Allow*.
3. **Get the code.**
   `git clone https://github.com/sergi039/obsidian-kanban-app.git ~/obsidian-kanban-app`,
   or, if that folder exists, `git -C ~/obsidian-kanban-app pull --ff-only`.
4. **Run the installer** in the background (it runs for minutes), with the
   vault from step 2:
   `~/obsidian-kanban-app/scripts/install-personal-mac.sh --vault "<vault folder>"`.
   It stops at the first problem with a line starting `ERROR:` that says what
   to do; fix that and rerun the same command. A rerun is always safe.
5. **Obsidian app.** If `/Applications/Obsidian.app` is missing, ask them to
   download it from <https://obsidian.md> and install it. In Obsidian: *Open
   folder as vault* → the vault folder. They will see `Задачи.md` there.
6. **Show the board.** Open <http://localhost:4000> for them (`open
   http://localhost:4000`) and point out the board «Задачи».
7. **Try it.** Ask them to start a *new* Claude Code session (the rule and the
   Obsidian tools load only in new sessions) and type
   «в канбан: проверить установку». A card must appear on the board. When the
   new session asks for permission to use a kanban or Basic Memory tool, they
   may choose *Always allow*. If they use Codex, the same works in a new Codex
   session.
8. **Report.** If this install started from a GitHub issue, post a short
   comment there: done or the exact `ERROR:` line, and the installer's last
   20 lines.

## Daily use

- «в канбан: позвонить в банк до пятницы» — Claude (or Codex) creates or updates
  a card.
- «обсидиан: найди заметку про …», «запиши в обсидиан …» — Claude works in the
  vault through Basic Memory.
- The board page is <http://localhost:4000>; the same tasks are lines in
  `Задачи.md` in Obsidian, and edits on either side show up on the other.
- A new board: in the board page, the board switcher → create; it can also
  pick an existing Markdown file with `- [ ]` lines from the vault. A file only
  becomes a board this way, not by being created in Obsidian.

## Update

```bash
git -C ~/obsidian-kanban-app pull --ff-only && ~/obsidian-kanban-app/scripts/install-personal-mac.sh
```

The vault, boards and cards stay as they are.

## Troubleshooting

- **The board page does not open.** Check the server:
  `launchctl print gui/$(id -u)/com.obsidian-kanban | grep -E 'state|last exit'`
  and the end of `~/Library/Logs/ObsidianKanban/api.err.log`. Rerunning the
  installer restarts it.
- **Port 4000 is taken** (the installer says so): rerun with `--port 4100`; the
  board is then at `http://localhost:4100`, and the rule follows. Later reruns
  keep that port.
- **"macOS does not let the background board server read and write …"**: the
  vault is in Documents, Desktop or iCloud Drive and the access dialog was
  missed or refused. Either move the vault to `~/Obsidian/Notes` and rerun with
  `--vault` after removing `~/obsidian-kanban-app/config.boards.json`, or add
  the `node` path the message names in System Settings → Privacy & Security →
  Full Disk Access, then rerun.
- **Claude has no Obsidian tools** in a new session: `claude mcp get
  obsidian-basic-memory` (`~/.local/bin/claude` when `claude` is not found)
  must show `Connected`. If it does not, rerun the installer; it re-registers
  the server.
- **Claude does not react to «в канбан»** in a new session: `claude mcp get
  obsidian-kanban` must show `Connected`, and `~/.claude/rules/obsidian-kanban.md`
  must exist; rerun the installer if not.
- **Codex has no kanban tools**: `codex mcp get obsidian-kanban` must list the
  server. Codex installed after the board: rerun the installer.

## Uninstall

```bash
~/obsidian-kanban-app/scripts/install-personal-mac.sh --uninstall
```

It stops the board server and removes the Claude and Codex wiring. The vault with all
boards, the checkout and the downloaded runtimes stay; delete them by hand if
wanted.
