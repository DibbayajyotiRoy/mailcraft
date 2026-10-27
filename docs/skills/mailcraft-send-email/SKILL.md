---
name: mailcraft-send-email
description: Send a transactional email with mailcraft (CLI or MCP), test it safely with magic addresses, and react to policy and approval results. Use when the user asks to send, test or debug a single email.
---

# Send an email with mailcraft

## Rules
1. Always pass `--json`; read `ok`, `data`, `error.code`, `error.hint`.
2. Use a test key (`mc_test_`) first. Test sends never leave the box; they land in the sandbox inbox.
3. Never print or ask for the API key. It comes from `MAILCRAFT_API_KEY` or `.mailcraft/`.
4. Run `--dry-run` first, and pass `--idempotency-key` on anything that may be retried.
5. Exit codes: `4` = blocked or `pending_approval` (a human decides; never approve it yourself), `5` = retry with backoff and the same idempotency key, `7` = a check failed, follow `hint`.

## Steps
```
mailcraft send --to delivered@test.mailcraft.local --subject "Hello" --text "Hi" --dry-run --json
mailcraft send --to delivered@test.mailcraft.local --subject "Hello" --text "Hi" \
  --idempotency-key welcome-ana-1 --json
mailcraft emails get <id> --json
```
With a stored template:
```
mailcraft send --to ana@example.org --from hello@example.com --template welcome \
  --data '{"first_name":"Ana","app_url":"https://app.example.com"}' --json
```
Result: `{"ok":true,"data":{"id":"<uuid>","status":"queued","recipients":[{"email":"...","id":"<uuid>"}]},"request_id":"req_...","schema":1}`.

## Magic addresses (test keys, any domain, `+label` allowed)
`delivered@test.mailcraft.local`, `bounced@` (550 5.1.1), `complained@`, `suppressed@`, `deferred@` (4.2.0 then success).

## Pitfalls
- `test_key_live_recipient`: a test key was used with a real address. Use a magic address; going live is a human step.
- `domain_not_verified`: see mailcraft-setup-domain. `From` must be on a verified domain (or your Gmail address if connected via Gmail).
- `template_render_failed`: a variable is missing; undefined variables are errors, not blanks. Pass every variable in `--data`.
- Transactional mail carries no tracking and no unsubscribe header; do not put marketing content in it.
- `pending_approval` is HTTP 202, not an error. Tell the human; poll `mailcraft approvals list` (the `approval_id` is in the result).
