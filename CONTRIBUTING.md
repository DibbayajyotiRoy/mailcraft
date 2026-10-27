# Contributing to mailcraft

Pre-alpha: read [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md) first; the spec is the contract.

## Setup

- Rust stable (`rustup`), Node 22, Docker (for Postgres/Redis).
- `cargo build --workspace && cargo test --workspace`
- Migrations: `docker compose up -d postgres`, then run the server with `DATABASE_URL` set (migrations are embedded).
- Dashboard: `cd dashboard && npm install && npm run dev`.

## Before you open a PR

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd dashboard && npm run build)
```

## Rules

- **`openapi.yaml` is the source of truth.** Change it first; routes, CLI and MCP tools follow. CI will fail on drift.
- A schema change is a new file in `migrations/` (never edit an applied migration) and a matching update to SPEC section 8.
- Deliverability behaviour (headers, DKIM, bounce classes, retry schedule) cites the research in SPEC section 12; changing it changes the spec in the same PR.
- Keep crates in their lane: `mailcraft-core` has no I/O; plugins implement traits from core.
- Tests: one small, fast test next to non-trivial logic. No network in unit tests.
- Security issues: do not open a public issue; email the maintainer (address to be added to SECURITY.md before the first release).
- Commits: imperative subject, no attribution trailers.

By contributing you agree your work is licensed under AGPL-3.0-only.
