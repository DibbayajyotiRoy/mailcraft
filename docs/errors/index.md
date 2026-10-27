# Errors

Every error is `{"ok": false, "error": {"code", "message", "field?", "hint", "doc_url", "retryable"}, "request_id"}`. `code` strings are stable. Read `hint` first.

| Code | Fix |
|---|---|
| `invalid_request` | Body or flag is malformed; see `error.field`. CLI exit 2. |
| `unauthenticated` | Key missing, wrong or revoked. Set `MAILCRAFT_API_KEY`; do not ask for it in chat. CLI exit 3. |
| `forbidden_scope` | Key lacks the scope (`read`, `send`, `manage`, `admin`). A human must issue a key with the scope. Agent keys never get `admin`. Exit 3. |
| `not_found` | Id or name does not exist (or belongs to another environment). Exit 6. |
| `idempotency_key_reused` | Same key, different request body within 24h. Use a new key for a new request. |
| `rate_limited` | Retryable. Wait for `Retry-After`, then retry with the same idempotency key. Exit 5. |
| `domain_not_verified` | Add the DNS records from `mailcraft domain add`, then `mailcraft domain verify <name>`. Exit 7 while unverified. |
| `recipient_suppressed` | Address bounced, complained or unsubscribed. Do not retry; remove it from the list. |
| `recipient_not_allowed` | Key has a `recipient_allowlist` and the address is not on it. Ask a human to change the allowlist. |
| `blocked_by_policy` | Policy for this action is `blocked`. Do not work around it; tell the human. Exit 4. |
| `pending_approval` | HTTP 202, not a failure. A human must decide; poll `mailcraft approvals list`. Never approve it yourself. Exit 4. |
| `send_cap_exceeded` | Daily or minute cap reached. Wait for the window or ask a human to raise the cap. |
| `kill_switch_active` | Sending is paused. Only a human turns it off (`mailcraft kill-switch off`). |
| `test_key_live_recipient` | A `mc_test_` key was used with a real recipient. Use a magic address (`delivered@test.mailcraft.local`) or get a live key from a human. |
| `template_render_failed` | A variable is missing (undefined variables are errors) or the template is invalid. Pass all variables via `--data`; run `templates preview`. |
| `content_lint_failed` | Fix the issues listed in the error (links, tokens, banned terms, unsubscribe/address on marketing), then retry. |
| `llm_unavailable` | No LLM provider configured or it failed. Automation falls back to static copy; configure a provider or use `mode: static`. Retryable. |
| `not_implemented` | Feature is planned but not built. CLI exit 1. Use the documented alternative. |
