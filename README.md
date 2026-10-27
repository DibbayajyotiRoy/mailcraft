# mailcraft

**Agent-native, open-source email for apps: transactional sends and event-triggered lifecycle automations, with emails an LLM can write inside guardrails.** An AGPL-3.0 alternative to Resend that you run yourself.

> **Status: pre-alpha.** This repository currently contains the product [spec](SPEC.md), the [architecture](ARCHITECTURE.md), and a compiling workspace scaffold. Most commands return `not_implemented`. Do not send production mail with it yet.

## Why

- **Agent-first.** Remote MCP server (OAuth or API key), CLI with `--json` and stable exit codes, `llms.txt`, SKILL.md files, one OpenAPI source of truth, idempotency keys, dry-run on everything, structured errors with hints.
- **Safe for agents.** Test mode with magic addresses, scoped keys, per-key policy (`auto` / `needs_approval` / `blocked`), send caps, recipient allowlists, approval queue, hash-chained audit log, kill switch.
- **Lifecycle built in.** Events API, contacts and segments, automations with `condition`, `delay`, `wait_for_event`, `send_email`, `update_contact`, `add_to_segment`; frequency caps, quiet hours, unsubscribe categories.
- **LLM-written, not LLM-trusted.** The model fills fixed template slots from structured context and returns JSON. A validator checks every number, host and link; a spam score runs before send; two failures fall back to static copy; an approval queue sits in front.
- **Deliverability as a feature.** DKIM (CNAME-delegated selectors, rotation), SPF via return-path subdomain, DMARC guidance, RFC 8058 one-click unsubscribe, separate transactional/marketing streams, bounce/DSN parsing with VERP, complaint handling, suppression, warm-up, per-destination throttling.
- **No hosted relay.** mailcraft never sends your mail through project-run infrastructure. Pick: your own Gmail/Workspace (testing, low volume), a relay you own (SES, Postmark, Mailgun, Brevo, SMTP2GO, any SMTP), or direct send once `mailcraft doctor` passes port 25, reverse DNS and blocklist checks.

## Quickstart (target experience)

```bash
docker compose up -d
mailcraft init                      # keys, migrations, test-mode key, next steps (an agent can run this)
mailcraft domain add example.com    # prints (or auto-creates via a Cloudflare token) SPF / DKIM / DMARC / return-path records, then verifies
```

Then send in test mode, no DNS needed:

```bash
mailcraft send --to delivered@test.mailcraft.local --subject "hello" --text "it works" --json
```

> In this pre-alpha only `docker compose up -d` (health at `http://localhost:8080/healthz`) and `mailcraft doctor --json` do real work.

## Build from source

```bash
cargo build --workspace && cargo test --workspace
cd dashboard && npm install && npm run build
```

## Documentation

- [SPEC.md](SPEC.md): product spec (API, MCP, CLI, data model, guardrails, deliverability mapping, roadmap)
- [ARCHITECTURE.md](ARCHITECTURE.md): components and request flows
- [docs/llms.txt](docs/llms.txt), [docs/SKILL.md](docs/SKILL.md): agent-facing drafts
- [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[AGPL-3.0-only](LICENSE). If you offer mailcraft as a network service you must offer your users the corresponding source.
