# ADR 0002: Desktop agent client strategy

## Status

Accepted

## Context

The Kanban ingestion API and MCP server can support any MCP-capable client, but desktop clients differ in how they connect to MCP servers.

Claude Desktop supports local stdio MCP servers, which matches the current `apps/mcp` implementation. The implemented and verified path is:

```text
Claude Desktop -> local stdio MCP -> Kanban API /api/inbox/* -> Markdown + SQLite
```

OpenAI/ChatGPT desktop and web surfaces are less certain for this project because write-capable custom/full MCP support depends on the user's OpenAI plan, workspace developer mode, and whether a remote MCP endpoint or Secure MCP Tunnel is available. A local stdio MCP server is not a reliable assumption for those surfaces.

## Decision

Use Claude Desktop as the primary supported desktop agent for Kanban task capture.

Do not build or maintain a custom OpenAI/ChatGPT remote MCP adapter for now. Revisit only if the owner confirms a supported OpenAI workspace/developer-mode path and wants to invest in a remote/tunnel deployment.

Keep the existing `openai` source value and MCP `openai_desktop` mapping because local Codex-style clients can still use the same MCP contract when they support local command MCP. This is compatibility plumbing, not a commitment that ChatGPT/OpenAI Desktop write flows are supported.

## Consequences

- Documentation and setup should optimize for Claude Desktop first.
- Verification should focus on the local stdio MCP path plus the Kanban API contract.
- OpenAI/ChatGPT Desktop should be documented as deferred/unsupported for writes unless a working custom MCP app/tunnel setup is explicitly provided.
- No Cloudflare Tunnel, Secure MCP Tunnel, OAuth proxy, or remote MCP deployment is required for the current milestone.

## Revisit Criteria

Reconsider the decision when all of the following are true:

- The owner has an OpenAI plan/workspace that supports custom/full MCP apps with write actions.
- A supported remote MCP or Secure MCP Tunnel path is available and testable.
- The added operational surface is worth the benefit compared with Claude Desktop.
