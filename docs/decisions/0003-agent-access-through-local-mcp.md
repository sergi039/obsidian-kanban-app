# ADR 0003: Agent access through the local MCP server

## Status

Accepted 2026-10-22 by the owner. Replaces the client strategy of [ADR 0002](0002-desktop-agent-client-strategy.md) where they differ.

## Context

- Agents (Claude Code, Codex) reached the board by `curl` to `http://127.0.0.1:4000/api`, following a rule. A sandboxed agent asks for permission on every `curl` to loopback (Codex keeps command networking off by default), and `PATCH` replaced a card's description and links whole, so adding to a card meant reading it first and sending everything back.
- `apps/mcp` existed with three tools on `/api/inbox/*`, which fail closed without `INGEST_API_TOKEN`. The owner's server and every personal install run without it, so the server answered 401 and was registered in no client.
- Research on 2026-10-22, together with Codex: MCP servers run outside the agents' command sandbox; one repository can also be a Claude Code and a Codex plugin marketplace (`sirkirby/unifi-mcp` does both); Claude Desktop chat needs a separate `.mcpb` extension; claude.ai, the Claude phone app and ChatGPT reach only public HTTPS MCP servers with sign-in. The owner uses the board from Claude Code and Codex, not from Claude Desktop chat.

## Decision

- The MCP server calls the same routes as the web page (`/api/boards`, `/api/cards`, `/api/reminders/follow-up`), with no token on loopback and `KANBAN_API_TOKEN` when the board runs with `API_TOKEN`. Its eight tools find, add, update, move, close and comment on cards and follow up emails; adding to a description or links is merged by the API in one step (`append_description`, `add_links`).
- The one-script install builds it and registers it for Claude Code and, when present, Codex. The rule keeps only what is not in the tools: the trigger, the column and the Obsidian link.
- Not now: Claude Code / Codex plugins from this repository, a `.mcpb` for Claude Desktop chat, a remote MCP endpoint.

## Consequences

- No permission prompt per request in Codex; one tool, `kanban_replace_description`, is marked destructive, and Codex asks before it.
- `/api/inbox/*` with routing and `INGEST_API_TOKEN` stays for external sources; no agent tool uses it.
- A board on another Mac is reached by running the MCP server there over ssh; the API stays on loopback.

## Revisit

- Plugins: when people want the assistant part without the installer, e.g. a board they run some other way.
- `.mcpb`: when Claude Desktop chat is used for the board.
- Remote MCP: when the board must be reached from the phone or the web; it needs authentication on the API first (Tier 2).
