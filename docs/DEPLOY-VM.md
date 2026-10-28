# Deploy to a LAN VM (systemd, no Docker)

```bash
./scripts/deploy-vm.sh ubuntu@10.0.0.200
```

Builds on this machine, uploads, swaps binaries, restarts only the mailcraft units, health-checks.
Re-run it after every change; it is idempotent and keeps the existing database, secrets and keys.
A redeploy with no code change takes about 40 s; the Rust build is incremental (Docker volume
`mc-vm-target`) and the dashboard build is skipped when no dashboard file changed.

Needs here: Docker (only to build the Rust binaries in `rust:1.99.1-bookworm`, so they run on Debian 12 /
glibc 2.36), Node + npm. Needs on the VM: Debian 12, systemd, Postgres >= 13 and Redis reachable on
127.0.0.1, `node` >= 20, `openssl`, `curl`, `sudo`. Nothing is built on the VM.

Auth: SSH keys if they work, otherwise a prompt. For scripted use set `MAILCRAFT_VM_PASS` (used for ssh
and sudo; read from the environment, never written to disk or the repo).

| Env | Default | |
|---|---|---|
| `MAILCRAFT_API_PORT` | 8080 | API (`/healthz`, `/readyz`, `/v1/...`) |
| `MAILCRAFT_DASH_PORT` | 3000 | dashboard |
| `MAILCRAFT_REDIS_DB` | 9 | Redis DB index (first run only) |
| `MAILCRAFT_SKIP_BUILD` | | `1` reuses `target/vm-dist` |

The defaults are ports the host firewall already allows (see below). The API port is written to the env file on the first run and read back from it afterwards; the units are regenerated on every deploy, so keep passing the same dashboard port.

## What lives where

| | |
|---|---|
| `/opt/mailcraft/bin/{mailcraft-server,mailcraft}` | binaries (the server embeds the migrations and runs them at start; it is API + send engine + automations in one process) |
| `/opt/mailcraft/dashboard` | Next.js standalone build, run by the system `node` |
| `/etc/mailcraft/mailcraft.env` | `DATABASE_URL`, `REDIS_URL`, `MAILCRAFT_SECRET_KEY`, `MAILCRAFT_PUBLIC_URL` ... (0640 root:mailcraft, generated once; edit it for `OPENROUTER_API_KEY` etc., then `sudo systemctl restart mailcraft-api`) |
| `mailcraft-api`, `mailcraft-dashboard`, `mailcraft.target` | units: user `mailcraft`, `MemoryMax=512M` each, `ProtectSystem=strict`, `NoNewPrivileges`, `Restart=on-failure` |
| database `mailcraft` / role `mailcraft` | in the existing Postgres (only these are created); `pg_trgm` + `pgcrypto` installed in it |
| `~ubuntu/mailcraft-init.txt` on the VM, `~/.config/mailcraft/vm-init-output.txt` here | output of the first-run `mailcraft init` (admin + test API keys), 0600. Sign in to the dashboard with one of those keys. |

Logs: `journalctl -u mailcraft-api -u mailcraft-dashboard`. CLI on the VM:
`MAILCRAFT_API_URL=http://127.0.0.1:8080 /opt/mailcraft/bin/mailcraft ...`.

## LAN access and the firewall

The VM runs a default-drop nftables input chain (table `inet spicrawl_fw`, allow-list of ports). 8080 and 3000
are on that list, hence the defaults, so mailcraft takes them over: **it cannot run next to Spicrawl's API
(8080) or the testbench UI (3000)** — stop and disable those units first (`systemctl disable --now ...`).

Any other port is dropped from the LAN even though the service is healthy (the deploy prints "NOT reachable
from here"). A separate nftables table with an `accept` rule does not help: every base chain on the `input`
hook is evaluated and any one of them may drop, so the port has to be added to the allow-list of the table
that drops (its file under `/etc/nftables.d/`). Until then, tunnel over SSH (port 22 is open):

    ssh -L 18095:127.0.0.1:<api port> -L 13095:127.0.0.1:<dashboard port> ubuntu@10.0.0.200   # then http://localhost:13095
