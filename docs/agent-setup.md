# Agent setup

## MCP

Remote (Streamable HTTP): `https://<your-host>/mcp`. Auth: OAuth browser consent, or `Authorization: Bearer mc_...` for headless/CI. Discovery: `/.well-known/mcp`.

Local stdio via npx:

```json
{"mcpServers": {"mailcraft": {
  "command": "npx",
  "args": ["-y", "@dibbayajyotiroy/mailcraft-mcp"],
  "env": {"MAILCRAFT_API_URL": "http://localhost:8080", "MAILCRAFT_API_KEY": "mc_test_..."}}}}
```

Warning: install only the scoped package `@dibbayajyotiroy/mailcraft-mcp`. Look-alike packages (e.g. unscoped `mailcraft-mcp`) are not ours; they would receive your API key. Use a test key in the config. Flags `--tools a,b` and `--read-only` shrink the tool surface.

Agent sessions never get `approval_decide`, `policy_set`, `go_live_approve`, or kill-switch-off.

## Init flow

1. `mailcraft init --all --non-interactive --json` (secret key, migrations, admin, test key to `.mailcraft/` mode 0600, port probes, skills, MCP registration, AGENTS.md snippet).
2. Define events and templates; import an automation with `approval: first_n:5`.
3. `mailcraft send --to delivered@test.mailcraft.local ... --json`; `events track ... --dry-run`.
4. `mailcraft domain add example.com`; apply DNS if you hold a token, otherwise give the human the block; `mailcraft domain verify` until verified.
5. Ask the human to go live.
6. First sends of each automation wait in `pending_approval` until N are approved.

## Human-only steps

Consent/OTP, go-live approval, approval decisions, raising limits or caps, issuing `admin` keys, turning the kill switch off, Google OAuth client setup and consent.
