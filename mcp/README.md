# @dibbayajyotiroy/mailcraft-mcp

MCP server for mailcraft: lets an AI agent send email and manage domains, templates, contacts, events and automations through the mailcraft REST API (`/v1`).

> ## WARNING: look-alike packages
> **The only official package is `@dibbayajyotiroy/mailcraft-mcp`.** Anything else called `mailcraft-mcp`, `mailcraft-mcp-server`, etc. is NOT ours.
> An email MCP server sees your API key and every message you send. In 2025 a look-alike `postmark-mcp` package on npm was caught silently BCC-copying all mail to an attacker. Check the scope and name before you install. Releases are published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements); `npm audit signatures` verifies it.

## Run

```sh
MAILCRAFT_API_KEY=mc_test_... npx -y @dibbayajyotiroy/mailcraft-mcp
```

| Setting | Meaning |
|---|---|
| `MAILCRAFT_API_URL` | API base, default `http://localhost:8080` |
| `MAILCRAFT_API_KEY` | `mc_test_...` / `mc_live_...` (stdio mode) |
| `--read-only` | expose only non-mutating tools |
| `--tools a,b` | expose only these tools |
| `--http --port 3333` | Streamable HTTP on `/mcp` instead of stdio. The key comes from each request's `Authorization: Bearer mc_...` (or `x-api-key`) header and is never logged |

Start with a `mc_test_` key: mail goes to the sandbox inbox and never leaves the box.

### Claude Code

```sh
claude mcp add mailcraft -e MAILCRAFT_API_URL=http://localhost:8080 -e MAILCRAFT_API_KEY=mc_test_... -- npx -y @dibbayajyotiroy/mailcraft-mcp
```

### Cursor (`.cursor/mcp.json`)

```json
{"mcpServers":{"mailcraft":{"command":"npx","args":["-y","@dibbayajyotiroy/mailcraft-mcp","--read-only"],
  "env":{"MAILCRAFT_API_URL":"http://localhost:8080","MAILCRAFT_API_KEY":"mc_test_..."}}}}
```

### Remote URL

```json
{"mcpServers":{"mailcraft":{"url":"https://your-instance.example.com/mcp","headers":{"Authorization":"Bearer mc_live_..."}}}}
```

## Tools

`account_status`, `email_send` `email_get` `email_events` `email_cancel` `email_list`, `broadcast_send` `broadcast_preview` `broadcast_list` `broadcast_get`, `domain_add` `domain_check`, `template_create|get|list|update|publish|preview|import|export|versions|version_get|restore|discard_draft`, `content_lint`, `contact_upsert|get|list|update|activity|import|delete`, `segment_create|list|preview|update|delete|add_members`, `event_send` `event_names`, `automation_create|get|list|pause|resume|archive|unarchive|test|run_get|simulate|runs`, `approval_list` `approval_get`, `settings_get_instructions` `settings_set_instructions` (admin), `kill_switch_status` `kill_switch_engage`, `doctor`, `audit_list`, `go_live_request`, `policy_get` `policy_propose`.

Each tool is one row in `src/tools.ts` (name, zod input, HTTP method + path) and maps 1:1 to a REST route. Mutating tools take `idempotency_key` (sent as `Idempotency-Key`); `email_send`, `broadcast_send` and `event_send` also take `dry_run`; run `broadcast_send` with `dry_run: true` first (it lists `skipped` rows and the send `schedule`) and `broadcast_preview` to see one recipient's rendering. Results are the API envelope as JSON text plus `"schema": 1`. API errors come back as `isError` results with `code`, `message` and `hint` intact.

Deliberately absent: `approval_decide`, `policy_set`, turning the kill switch off, go-live approval. An agent can engage the kill switch; only a human disengages it. Annotations: `readOnlyHint` on every non-mutating tool (previews included, so `--read-only` keeps `broadcast_preview`, `segment_preview`, `template_preview`), `destructiveHint` on `contact_delete`, `segment_update`, `segment_delete`, `template_discard_draft` and `settings_set_instructions`.

Sending tools (`email_send`, `broadcast_send`, `automation_test`) mail real people with a `mc_live_` key and sandbox everything with a `mc_test_` key; `automation_test` has no dry run, so keep to test keys. `automation_simulate` has no matching route on the server (it answers `not_found`); use `automation_test`. Not exposed on purpose: transports (SMTP/OAuth credentials stay with a human: `mailcraft connect relay`), webhooks, API keys, suppression removal.

## Develop

`npm run build && npm test` (Node 22).
