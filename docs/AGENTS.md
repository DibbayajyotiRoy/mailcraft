## mailcraft (email)

This project sends email through mailcraft (self-hosted). Docs index: `llms.txt` (full: `llms-full.txt`).

- Always pass `--json`; read `ok`, `data`, `error.code`, `error.hint`.
- Use test keys (`mc_test_...`) unless a human says otherwise. Test sends: `mailcraft send --to delivered@test.mailcraft.local --subject Hi --text Hi --json`.
- Never print, log or ask for API keys. They come from `MAILCRAFT_API_KEY` or `.mailcraft/`.
- Try `--dry-run` first; add `--idempotency-key` to anything you may retry.
- Never decide approvals, raise limits, go live or turn the kill switch off. Those are human steps. Exit code 4 means wait for a human; 5 means retry with backoff; 7 means a check failed, follow the hint.
- Key commands: `mailcraft doctor`, `domain add|verify`, `send`, `templates import|preview`, `events track`, `automations import|list`, `approvals list`.
