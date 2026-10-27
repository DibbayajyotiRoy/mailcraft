# mcp/

Placeholder for the standalone MCP package (`mailcraft-mcp`, TypeScript, published to npm with provenance under the official name only).

Plan (SPEC section 7.3):

- Remote MCP is served by `mailcraft-server` at `/mcp` (Streamable HTTP; OAuth 2.1 + PKCE, or `Authorization: Bearer mc_...`).
- This package is the local stdio wrapper (`npx -y mailcraft-mcp`, flags `--tools`, `--read-only`), with tool definitions **generated from `openapi.yaml`** (operation id = tool name) so it cannot drift.
- Agent-key sessions never expose `approval_decide`, `policy_set`, kill-switch-off or go-live approval.
