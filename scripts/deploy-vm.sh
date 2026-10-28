#!/usr/bin/env bash
# Build mailcraft on this machine and (re)deploy it to a Debian 12 VM under systemd. No Docker on the VM.
#   ./scripts/deploy-vm.sh ubuntu@10.0.0.200
# First run also creates the user, database, env file, units and runs `mailcraft init`; later runs only
# swap binaries and restart the mailcraft units. See docs/DEPLOY-VM.md.
#
# Env (all optional): MAILCRAFT_VM_PASS     ssh + sudo password (else key auth, else prompted)
#                     MAILCRAFT_API_PORT    8080     MAILCRAFT_DASH_PORT  3000
#                     MAILCRAFT_REDIS_DB    9        MAILCRAFT_SKIP_BUILD 1 = reuse target/vm-dist
set -euo pipefail

API_PORT=${MAILCRAFT_API_PORT:-8080}
DASH_PORT=${MAILCRAFT_DASH_PORT:-3000}
REDIS_DB=${MAILCRAFT_REDIS_DB:-9}

# ----------------------------------------------------------------------------- on the VM, as root
remote() {
  local stage=$1 api=$2 dash=$3 rdb=$4 host=$5
  local owner=${SUDO_USER:-ubuntu} env=/etc/mailcraft/mailcraft.env opt=/opt/mailcraft
  local node; node=$(command -v node) || { echo "node not found on the VM" >&2; exit 1; }
  cd /tmp
  say() { echo "  [vm] $*"; }

  id mailcraft >/dev/null 2>&1 ||
    useradd --system --user-group --home-dir /var/lib/mailcraft --create-home --shell /usr/sbin/nologin mailcraft
  install -d -m 755 $opt/bin
  install -d -m 750 -o root -g mailcraft /etc/mailcraft

  # Shared Postgres/Redis are only ever read from here: create our own role + database, nothing else.
  if [ ! -f $env ]; then
    say "first run: creating database, role and $env"
    local pw key; pw=$(openssl rand -hex 24); key=$(openssl rand -hex 32)
    pg() { runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"; }
    pg -v pw="$pw" <<<"DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mailcraft') THEN CREATE ROLE mailcraft LOGIN; END IF; END \$\$;
                        ALTER ROLE mailcraft PASSWORD :'pw';"
    [ -n "$(pg -At -c "SELECT 1 FROM pg_database WHERE datname='mailcraft'")" ] || pg -c "CREATE DATABASE mailcraft OWNER mailcraft"
    # migrations also run these; creating them as the superuser keeps that independent of "trusted extension" rules
    pg -d mailcraft -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto"
    ( umask 077; cat > $env <<EOF
DATABASE_URL=postgres://mailcraft:$pw@127.0.0.1:5432/mailcraft
REDIS_URL=redis://127.0.0.1:6379/$rdb
MAILCRAFT_SECRET_KEY=$key
MAILCRAFT_BIND=0.0.0.0:$api
MAILCRAFT_PUBLIC_URL=http://$host:$api
RUST_LOG=info
# optional: OPENROUTER_API_KEY=  CLOUDFLARE_API_TOKEN=  MAILCRAFT_EGRESS_IP=  (then: systemctl restart mailcraft-api)
EOF
    )
    chown root:mailcraft $env; chmod 640 $env
  fi
  # the env file is authoritative once it exists (it is never rewritten), so a redeploy with other port args cannot split api and dashboard
  p=$(sed -n 's/^MAILCRAFT_BIND=.*:\([0-9][0-9]*\)$/\1/p' $env); api=${p:-$api}

  say "installing binaries + dashboard"
  install -m 755 "$stage/mailcraft-server" "$stage/mailcraft" $opt/bin/
  rm -rf $opt/dashboard.new; mkdir $opt/dashboard.new
  tar -xzf "$stage/dashboard.tgz" -C $opt/dashboard.new --no-same-owner
  chown -R root:root $opt/dashboard.new
  install -d -o mailcraft -g mailcraft $opt/dashboard.new/.next/cache
  rm -rf $opt/dashboard.old; [ ! -d $opt/dashboard ] || mv $opt/dashboard $opt/dashboard.old
  mv $opt/dashboard.new $opt/dashboard; rm -rf $opt/dashboard.old

  local harden="NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
Restart=on-failure
RestartSec=3
User=mailcraft
Group=mailcraft"
  cat > /etc/systemd/system/mailcraft-api.service <<EOF
[Unit]
Description=mailcraft API + send engine + automations
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target
PartOf=mailcraft.target

[Service]
EnvironmentFile=$env
ExecStart=$opt/bin/mailcraft-server serve
MemoryMax=512M
ReadWritePaths=/var/lib/mailcraft
$harden

[Install]
WantedBy=mailcraft.target
EOF
  cat > /etc/systemd/system/mailcraft-dashboard.service <<EOF
[Unit]
Description=mailcraft dashboard (Next.js)
After=mailcraft-api.service
PartOf=mailcraft.target

[Service]
Environment=NODE_ENV=production PORT=$dash HOSTNAME=0.0.0.0 MAILCRAFT_API_URL=http://127.0.0.1:$api NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=384
WorkingDirectory=$opt/dashboard
ExecStart=$node $opt/dashboard/server.js
SuccessExitStatus=143
MemoryMax=512M
ReadWritePaths=$opt/dashboard/.next/cache
$harden

[Install]
WantedBy=mailcraft.target
EOF
  cat > /etc/systemd/system/mailcraft.target <<EOF
[Unit]
Description=mailcraft (api + dashboard)
Wants=mailcraft-api.service mailcraft-dashboard.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable mailcraft.target mailcraft-api.service mailcraft-dashboard.service >/dev/null 2>&1
  say "restarting mailcraft-api + mailcraft-dashboard (migrations run at API start)"
  systemctl restart mailcraft-api.service mailcraft-dashboard.service

  local i ok=""
  for i in $(seq 40); do curl -fsS -o /dev/null "http://127.0.0.1:$api/readyz" 2>/dev/null && ok=1 && break; sleep 1; done
  [ -n "$ok" ] || { journalctl -u mailcraft-api -n 25 --no-pager >&2; echo "API did not become ready" >&2; exit 1; }
  ok=""; for i in $(seq 30); do curl -fsS -o /dev/null "http://127.0.0.1:$dash/login" 2>/dev/null && ok=1 && break; sleep 1; done
  [ -n "$ok" ] || { journalctl -u mailcraft-dashboard -n 25 --no-pager >&2; echo "dashboard did not come up" >&2; exit 1; }
  say "api :$api and dashboard :$dash healthy"

  # First-run keys. Output holds the admin key: it goes to a 0600 file, never to this log.
  local init=/home/$owner/mailcraft-init.txt
  if [ ! -s "$init" ]; then
    ( umask 077; : > "$init" ); chown "$owner": "$init"
    if runuser -u "$owner" -- env HOME=/home/$owner MAILCRAFT_API_URL=http://127.0.0.1:$api \
         $opt/bin/mailcraft init --non-interactive --delivery sandbox </dev/null >"$init" 2>&1; then
      say "mailcraft init done -> $init"
    else
      say "mailcraft init FAILED; whatever it printed (possibly keys) is in $init"
    fi
    echo "INIT_CREATED=1"
  fi
  systemctl is-active mailcraft-api mailcraft-dashboard | tr '\n' ' '; echo
  echo "PORTS=$api,$dash"
}

[ "${1:-}" = --remote ] && { shift; remote "$@"; exit; }

# ----------------------------------------------------------------------------- on this machine
TARGET=${1:?usage: scripts/deploy-vm.sh user@host}
HOST=${TARGET#*@}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST=$ROOT/target/vm-dist
TMP=$(mktemp -d); trap 'ssh -O exit -o ControlPath="$TMP/c" "$TARGET" 2>/dev/null || true; rm -rf "$TMP"' EXIT
say() { echo "==> $*"; }

build() {
  say "rust (bookworm container, glibc 2.36; incremental via the mc-vm-target volume)"
  mkdir -p "$DIST"
  docker run --rm -e RUSTUP_TOOLCHAIN=1.99.1 -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e CARGO_TARGET_DIR=/target \
    -v "$ROOT":/src:ro -v mc-vm-cargo:/usr/local/cargo/registry -v mc-vm-target:/target -v "$DIST":/out -w /src \
    rust:1.99.1-bookworm bash -c 'cargo build --release --locked --bin mailcraft-server --bin mailcraft &&
      install -m755 /target/release/mailcraft-server /target/release/mailcraft /out/ && chown $HOST_UID:$HOST_GID /out/*'
  # a no-op `next build` still costs ~40s: skip it (and the repack) when no dashboard source is newer than the last tarball
  if [ -f "$DIST/dashboard.tgz" ] && [ -z "$(find "$ROOT/dashboard" \( -name node_modules -o -name .next \) -prune -o -type f -newer "$DIST/dashboard.tgz" -print -quit)" ]; then
    say "dashboard unchanged, reusing $DIST/dashboard.tgz"; return
  fi
  say "dashboard (next standalone)"
  ( cd "$ROOT/dashboard"
    [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund
    NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null )
  rm -rf "$DIST/dash"; mkdir -p "$DIST/dash/.next"
  cp -a "$ROOT/dashboard/.next/standalone/." "$DIST/dash/"
  cp -a "$ROOT/dashboard/.next/static" "$DIST/dash/.next/static"
  [ ! -d "$ROOT/dashboard/public" ] || cp -a "$ROOT/dashboard/public" "$DIST/dash/public"
  [ -f "$DIST/dash/server.js" ] || { echo "standalone build has no server.js at its root" >&2; exit 1; }
  tar -C "$DIST/dash" -czf "$DIST/dashboard.tgz" .
}
[ "${MAILCRAFT_SKIP_BUILD:-}" = 1 ] || build

# ssh: password via SSH_ASKPASS reading MAILCRAFT_VM_PASS from the environment (nothing secret on disk), else key auth
SSHO=(-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o ControlPath="$TMP/c" -o ControlPersist=120)
if [ -n "${MAILCRAFT_VM_PASS:-}" ] || ! ssh -o BatchMode=yes -o ConnectTimeout=8 "${SSHO[@]}" "$TARGET" true 2>/dev/null; then
  [ -n "${MAILCRAFT_VM_PASS:-}" ] || { read -rsp "Password for $TARGET: " MAILCRAFT_VM_PASS </dev/tty; echo; }
  export MAILCRAFT_VM_PASS SSH_ASKPASS_REQUIRE=force DISPLAY=${DISPLAY:-:0} SSH_ASKPASS="$TMP/askpass"
  printf '#!/bin/sh\nprintf "%%s\\n" "$MAILCRAFT_VM_PASS"\n' > "$TMP/askpass"; chmod 700 "$TMP/askpass"
  SSHO+=(-o PubkeyAuthentication=no)
fi

say "upload to $TARGET"
STAGE=$(ssh "${SSHO[@]}" "$TARGET" 'mktemp -d /tmp/mailcraft-deploy.XXXXXX')
scp -q "${SSHO[@]}" "$DIST/mailcraft-server" "$DIST/mailcraft" "$DIST/dashboard.tgz" "$0" "$TARGET:$STAGE/"

say "install + restart (api :$API_PORT, dashboard :$DASH_PORT)"
CMD="bash $STAGE/$(basename "$0") --remote $STAGE $API_PORT $DASH_PORT $REDIS_DB $HOST"
set +e   # stream the VM's progress, keep a copy to spot INIT_CREATED, and still clean up on failure
if [ -n "${MAILCRAFT_VM_PASS:-}" ]; then   # sudo -S eats the first stdin line; the script itself is a file, not stdin
  printf '%s\n' "$MAILCRAFT_VM_PASS" | ssh "${SSHO[@]}" "$TARGET" "sudo -S -p '' $CMD" 2>&1 | tee "$TMP/out" | sed '/^\(INIT_CREATED\|PORTS\)=/d'
else
  ssh -t "${SSHO[@]}" "$TARGET" "sudo $CMD" 2>&1 | tee "$TMP/out" | sed '/^\(INIT_CREATED\|PORTS\)=/d'
fi
RC=${PIPESTATUS[0]}; set -e
P=$(sed -n 's/^PORTS=\(.*\)\r\{0,1\}$/\1/p' "$TMP/out"); [ -z "$P" ] || { API_PORT=${P%,*}; DASH_PORT=${P#*,}; }   # what the VM really runs
ssh "${SSHO[@]}" "$TARGET" "rm -rf $STAGE"
[ "$RC" = 0 ] || exit "$RC"

if grep -q '^INIT_CREATED=1' "$TMP/out"; then
  mkdir -p ~/.config/mailcraft; ( umask 077; scp -q "${SSHO[@]}" "$TARGET:/home/${TARGET%@*}/mailcraft-init.txt" ~/.config/mailcraft/vm-init-output.txt )
  chmod 600 ~/.config/mailcraft/vm-init-output.txt
  say "first-run keys saved to ~/.config/mailcraft/vm-init-output.txt (also on the VM: ~/mailcraft-init.txt)"
fi

say "health from here"
curl -fsS -m 5 "http://$HOST:$API_PORT/readyz" >/dev/null && echo "  api        http://$HOST:$API_PORT  ok" ||
  echo "  api        http://$HOST:$API_PORT  NOT reachable from here (firewall? see docs/DEPLOY-VM.md)"
curl -fsS -m 5 -o /dev/null "http://$HOST:$DASH_PORT/login" && echo "  dashboard  http://$HOST:$DASH_PORT  ok" ||
  echo "  dashboard  http://$HOST:$DASH_PORT  NOT reachable from here (firewall? see docs/DEPLOY-VM.md)"
