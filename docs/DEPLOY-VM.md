# Deploy to a LAN VM (systemd, no Docker)

```bash
./scripts/deploy-vm.sh ubuntu@10.0.0.200
```

Builds on this machine, uploads, puts the release in place, restarts only the mailcraft units, health-checks
(and rolls back if the new release is unhealthy). It also installs the [auto-deploy timer](#automatic-deploys).
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
| `MAILCRAFT_NO_AUTODEPLOY` | | `1` does not enable the auto-deploy timer, and switches it off if it was on |

The defaults are ports the host firewall already allows (see below). The API port is written to the env file on the first run and read back from it afterwards; the units are regenerated on every deploy, so keep passing the same dashboard port.

## What lives where

| | |
|---|---|
| `/opt/mailcraft/releases/<id>/` | one directory per release (the last 3 are kept): `bin/{mailcraft-server,mailcraft}` (the server embeds the migrations and runs them at start; it is API + send engine + automations in one process), `dashboard/` (Next.js standalone build, run by the system `node`), `VERSION` (the commit sha, or `manual-<sha>-<time>` for a `deploy-vm.sh` build) |
| `/opt/mailcraft/current` | symlink to the live release; the units run from it, switching it is atomic. `/opt/mailcraft/bin` is a symlink to `current/bin`, so the CLI path below keeps working |
| `/usr/local/sbin/mailcraft-autodeploy`, `mailcraft-autodeploy.{service,timer}` | the pull agent, see below. State in `/var/lib/mailcraft-autodeploy/` |
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

## Automatic deploys

Merging to `main` deploys to the VM within a few minutes. The VM is on a private LAN and the repo is public,
so GitHub never connects to it (no self-hosted runner, no SSH secrets): the VM pulls.

1. **`.github/workflows/vm-build.yml`** runs on every push to `main` (and by hand, `workflow_dispatch`, on `main`
   only; never on pull requests). It runs `scripts/build-vm-release.sh`, the same build `deploy-vm.sh` uses
   (Rust in `rust:1.99.1-bookworm`, dashboard `next build` with node 22), and publishes
   `mailcraft-vm-<sha>.tar.gz` + `.sha256` to the rolling prerelease **`vm-latest`**, replacing the previous
   assets. The release body carries `sha: <commit>`; it is edited last, so the assets it names exist. It uses
   only the built-in `GITHUB_TOKEN` (`contents: write`). If `main` moved on while it built, it publishes nothing.
2. **`mailcraft-autodeploy.timer`** runs `mailcraft-autodeploy` (root, oneshot) 2 minutes after the previous run
   finished. A run:
   - asks `https://api.github.com/repos/DibbayajyotiRoy/mailcraft/releases/tags/vm-latest` (no token; `ETag` /
     `If-None-Match`, so an unchanged release answers 304 and does not count against the 60 requests/hour; on
     403/429 it backs off for `Retry-After` or the rate-limit reset, 1 to 60 minutes). No release yet, GitHub
     unreachable, or nothing new are quiet outcomes: `status` below, nothing in the journal.
   - if the release sha is new (not the current `VERSION`, not the last one it handled): downloads the tarball
     and `.sha256` over HTTPS, verifies the checksum, unpacks to `releases/<sha>`, repoints `current`,
     restarts **only** `mailcraft-api` and `mailcraft-dashboard`, and waits for `http://127.0.0.1:<api>/readyz`
     and `http://127.0.0.1:<dashboard>/login` (ports read from `/etc/mailcraft/mailcraft.env` and the dashboard
     unit) and for both units to stay up.
   - if that fails it points `current` back at the previous release, restarts, checks again, and remembers the
     bad sha (`handled` = `<sha> failed`), so it is not retried every 2 minutes; the next merge is tried normally.
   - a checksum mismatch installs nothing and is not remembered (the build may still be publishing), so the unit
     shows as failed and the next run tries again.
   - keeps the last 3 releases, holds `flock` so runs (and a manual `deploy-vm.sh`) never overlap, and logs to the journal.

`deploy-vm.sh` installs the same agent and uses it to put its own build in place, so a manual and an automatic
deploy share one layout, one health check and one rollback. A manual deploy stays until the next merge to `main`
(the agent only acts on a sha it has not handled yet); on a VM where the timer was just installed, the first run
converges to the latest `main` build.

```bash
systemctl list-timers mailcraft-autodeploy.timer          # next / last run
journalctl -u mailcraft-autodeploy -n 50                  # what it deployed, rolled back, or refused
cat /var/lib/mailcraft-autodeploy/status                  # outcome of the latest run, incl. the quiet ones
cat /opt/mailcraft/current/VERSION; ls /opt/mailcraft/releases
```

**Pause** (hold the VM on what it runs now, e.g. while testing a branch with `deploy-vm.sh`):
`sudo systemctl disable --now mailcraft-autodeploy.timer`; resume with `enable --now`. To install without it,
deploy with `MAILCRAFT_NO_AUTODEPLOY=1`.

**Roll back / pin** to an older kept release: pause the timer, then
`sudo ln -sfn releases/<id> /opt/mailcraft/current && sudo systemctl restart mailcraft-api mailcraft-dashboard`.
The agent does not undo that on its own: it only acts on a sha it has not handled, so with the timer on again
the VM stays pinned until the next merge to `main`. To make it retry a release it marked `failed` (or re-fetch),
`sudo rm /var/lib/mailcraft-autodeploy/handled` and `sudo systemctl start mailcraft-autodeploy`.

**Migrations and rollback.** The server applies the embedded migrations when it starts, so a deploy that adds
one migrates the shared database before the health check. Rollback swaps binaries only; it cannot un-migrate.
If the new release fails *because* its migration failed, the migration ran in a transaction and rolls back with
it, so the old release comes back fine. If the migration succeeded and something else failed, the old binary
refuses to start against a schema with a migration it does not know (sqlx `VersionMissing`): the agent logs
"ROLLBACK ... ALSO UNHEALTHY" and the API stays down until a fixed release is merged (or the migration is reverted
by hand). Keep migrations backward compatible (add, then use, then drop in a later release) so the previous
release can still run on the new schema.

**What it does not do.** It swaps binaries and the dashboard only. Changes to the units, the env file, ports or
the agent itself still need `./scripts/deploy-vm.sh`. The checksum comes from the same release as the tarball, so
it catches corruption, not tampering: whoever can push to `main` (or edit the release) deploys code to this VM
as user `mailcraft`; keep branch protection on `main`.
