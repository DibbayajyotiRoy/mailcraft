# mailcraft

**Agent-native, open-source email for apps: transactional sends and event-triggered lifecycle automations, with emails an LLM can write inside guardrails.** An AGPL-3.0 alternative to Resend that you run yourself.

> **Status: pre-alpha.** Do not send production mail with it yet. The spec, architecture, API, engine, deliverability and automations crates and the CLI exist on `main`; anything the CLI or API does not yet implement returns `not_implemented`. Check `mailcraft --help` and [openapi.yaml](openapi.yaml) for what is real today.

**Architecture in one line:** one Rust server (REST API + send engine + automations in one process) on Postgres (source of truth) and Redis (throttles/locks only), driven by a CLI, an MCP server and a dashboard.

## Why

- **Agent-first.** Remote MCP server (OAuth or API key), CLI with `--json` and stable exit codes, `llms.txt`, SKILL.md files, one OpenAPI source of truth, idempotency keys, dry-run on everything, structured errors with hints.
- **Safe for agents.** Test mode with magic addresses, scoped keys, per-key policy (`auto` / `needs_approval` / `blocked`), send caps, recipient allowlists, approval queue, hash-chained audit log, kill switch.
- **Lifecycle built in.** Events API, contacts and segments, automations with `condition`, `delay`, `wait_for_event`, `send_email`, `update_contact`, `add_to_segment`; frequency caps, quiet hours, unsubscribe categories.
- **LLM-written, not LLM-trusted.** The model fills fixed template slots from structured context and returns JSON. A validator checks every number, host and link; a spam score runs before send; two failures fall back to static copy; an approval queue sits in front.
- **Deliverability as a feature.** DKIM (CNAME-delegated selectors, rotation), SPF via return-path subdomain, DMARC guidance, RFC 8058 one-click unsubscribe, separate transactional/marketing streams, bounce/DSN parsing with VERP, complaint handling, suppression, warm-up, per-destination throttling.
- **No hosted relay.** mailcraft never sends your mail through project-run infrastructure. Pick: your own Gmail/Workspace (testing, low volume), a relay you own (SES, Postmark, Mailgun, Brevo, SMTP2GO, any SMTP), or direct send once `mailcraft doctor` passes port 25, reverse DNS and blocklist checks.

## Quickstart

```bash
echo "MAILCRAFT_SECRET_KEY=$(openssl rand -base64 32)" > .env   # the one required secret
docker compose up -d                # postgres, redis, mailcraft (API :8080), dashboard (:3000)
alias mailcraft='docker compose run --rm cli'   # the CLI from the image, nothing to install (see below)
mailcraft init                      # first run only: creates the test + admin keys, saves both, sends a test email
mailcraft domain add example.com    # prints (or auto-creates via a Cloudflare token) SPF / DKIM / DMARC / return-path records, then verifies
```

`mailcraft init` prints the **admin key once** ("store this now, it won't be shown again") and saves both keys in the CLI config as profiles: `default` (the `mc_test_` key) and `admin` (approvals, go-live, dashboard login). Select it with `mailcraft --profile admin ...` or `MAILCRAFT_PROFILE=admin`. `init` works once per database.

No domain? `mailcraft connect gmail` (test/low volume). Have a relay? `mailcraft connect relay <preset>` (SES, Postmark, Mailgun, Brevo, SMTP2GO, any SMTP). Details and honest limits: [docs/QUICKSTART.md](docs/QUICKSTART.md). 

**CLI install, do this before `init`.** Either use the `cli` compose service (the alias above; it points at `http://mailcraft:8080` and keeps `~/.config/mailcraft` in the `mc-config` volume so keys survive `--rm`; files like `welcome.json` are read from the current directory), or build it natively: `cargo install --path crates/mailcraft-cli` (then drop the alias).

Test send, no DNS needed:

```bash
mailcraft send --to delivered@test.mailcraft.local --subject "hello" --text "it works" --json
```

Verified end to end on a fresh clone: compose up, `init`, test send (delivered), dashboard login. Not verified: `domain add` (needs a real domain). Health: `http://localhost:8080/healthz`.

Dashboard: `http://localhost:3000/login` (port: `MAILCRAFT_DASHBOARD_PORT`; API port: `MAILCRAFT_PORT`). Leave the API base URL at the pre-filled `http://mailcraft:8080` (the server-side address) and log in with the **admin key** (profile `admin`) to approve things; the `mc_test_` key only shows data.

### Your first automation

A welcome email whose intro line is written by the LLM inside a fixed slot, with static fallback copy. Needs `OPENROUTER_API_KEY` in `.env` (see `.env.example`); without it the fallback text is sent.

`welcome.json` (template; the `slot` block is where the model writes):

```json
{"version": 1, "subject": "Welcome {{ first_name }}",
 "blocks": [
  {"type": "heading", "text": "Hi {{ first_name }}"},
  {"type": "slot", "name": "intro", "max_len": 240,
   "instructions": "One warm sentence welcoming them and naming the next step.",
   "fallback": "Thanks for signing up. Your account is ready."}]}
```

`welcome-automation.json` (the step takes a plain `instructions` string and a `from`; there is no `llm{}` object):

```json
{"name": "welcome", "trigger": "signed_up", "approval": "first_n:5",
 "steps": [
  {"key": "mail", "type": "send_email", "config": {
    "template": "welcome", "mode": "llm", "from": "hello@example.com",
    "instructions": "Friendly and brief. Mention the product name once."}}]}
```

```bash
mailcraft templates import welcome.json --name welcome      # draft
mailcraft templates publish welcome                          # sends use the published version
mailcraft automations import welcome-automation.json         # draft
mailcraft automations publish welcome                        # activates (add --backfill-suppress to skip existing matches)
mailcraft contacts upsert ana@test.mailcraft.local --first-name Ana --timezone Europe/Berlin
mailcraft events track signed_up --contact ana@test.mailcraft.local
mailcraft --profile admin approvals list                     # the first 5 sends wait for a human with the admin key
```

`from` is required until a domain is verified: without it (and without a verified domain) the run fails immediately with a clear reason, no retries. Until the workspace goes live, automation emails are test-env and go to the sandbox, so a fresh install needs no transport; test-env sends ignore quiet hours. For live sends, quiet hours (09:00-18:00 contact-local, 13:00-17:00 UTC when the contact has no timezone) apply, so set `--timezone` (an invalid zone is a 422). Approving the `automation_first_send` approval releases the email (approve queues it, reject cancels it). `mailcraft automations enable` only resumes a paused automation; a draft needs `publish`.


## Build from source

```bash
cargo build --workspace && cargo test --workspace
cd dashboard && npm install && npm run build
```

## Documentation

- [SPEC.md](SPEC.md): product spec (API, MCP, CLI, data model, guardrails, deliverability mapping, roadmap)
- [ARCHITECTURE.md](ARCHITECTURE.md): components and request flows
- For agents: [docs/llms.txt](docs/llms.txt), [docs/SKILL.md](docs/SKILL.md), [docs/AGENTS.md](docs/AGENTS.md), [docs/agent-setup.md](docs/agent-setup.md), MCP server in [mcp/](mcp/README.md), TypeScript SDK in [sdk/ts/](sdk/ts/README.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[AGPL-3.0-only](LICENSE). If you offer mailcraft as a network service you must offer your users the corresponding source.
