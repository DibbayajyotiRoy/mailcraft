#!/usr/bin/env bash
# Build mailcraft on this machine and (re)deploy it to a Debian 12 VM under systemd. No Docker on the VM.
#   ./scripts/deploy-vm.sh ubuntu@10.0.0.200
# First run also creates the user, database, env file, units and runs `mailcraft init`; later runs only
# put a new release in place and restart the mailcraft units. Every run also (re)installs the pull agent
# ops/vm/mailcraft-autodeploy.* and enables its timer, which deploys whatever lands on main (the agent
# is also what installs the release here, so manual and automatic deploys are one code path).
# See docs/DEPLOY-VM.md.
#
# Env (all optional): MAILCRAFT_VM_PASS     ssh + sudo password (else key auth, else prompted)
#                     MAILCRAFT_API_PORT    8080     MAILCRAFT_DASH_PORT  3000
#                     MAILCRAFT_REDIS_DB    9        MAILCRAFT_SKIP_BUILD 1 = reuse target/vm-dist
#                     MAILCRAFT_NO_AUTODEPLOY 1 = do not enable (and switch off) the auto-deploy timer
set -euo pipefail

API_PORT=${MAILCRAFT_API_PORT:-8080}
DASH_PORT=${MAILCRAFT_DASH_PORT:-3000}
REDIS_DB=${MAILCRAFT_REDIS_DB:-9}

# ----------------------------------------------------------------------------- on the VM, as root
remote() {
  local stage=$1 api=$2 dash=$3 rdb=$4 host=$5 noauto=$6
  local owner=${SUDO_USER:-ubuntu} env=/etc/mailcraft/mailcraft.env opt=/opt/mailcraft
  local node; node=$(command -v node) || { echo "node not found on the VM" >&2; exit 1; }
  cd /tmp
  say() { echo "  [vm] $*"; }

  id mailcraft >/dev/null 2>&1 ||
    useradd --system --user-group --home-dir /var/lib/mailcraft --create-home --shell /usr/sbin/nologin mailcraft
  install -d -m 755 $opt/releases
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

  # The agent owns "unpack a release, switch /opt/mailcraft/current, restart, health-check, roll back" for manual
  # and automatic deploys alike. The units below run everything from `current`.
  install -m 755 "$stage/mailcraft-autodeploy.sh" /usr/local/sbin/mailcraft-autodeploy
  install -m 644 "$stage/mailcraft-autodeploy.service" "$stage/mailcraft-autodeploy.timer" /etc/systemd/system/

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
ExecStart=$opt/current/bin/mailcraft-server serve
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
WorkingDirectory=$opt/current/dashboard
ExecStart=$node $opt/current/dashboard/server.js
SuccessExitStatus=143
MemoryMax=512M
ReadWritePaths=$opt/current/dashboard/.next/cache
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
  local tgz id; tgz=$(ls "$stage"/mailcraft-vm-*.tar.gz); id=${tgz##*/mailcraft-vm-}; id=${id%.tar.gz}
  say "installing release $id, restarting mailcraft-api + mailcraft-dashboard (migrations run at API start)"
  /usr/local/sbin/mailcraft-autodeploy install "$tgz" "$id" || { echo "release $id did not become healthy" >&2; exit 1; }

  # First-run keys. Output holds the admin key: it goes to a 0600 file, never to this log.
  local init=/home/$owner/mailcraft-init.txt
  if [ ! -s "$init" ]; then
    ( umask 077; : > "$init" ); chown "$owner": "$init"
    if runuser -u "$owner" -- env HOME=/home/$owner MAILCRAFT_API_URL=http://127.0.0.1:$api \
         $opt/current/bin/mailcraft init --non-interactive --delivery sandbox </dev/null >"$init" 2>&1; then
      say "mailcraft init done -> $init"
    else
      say "mailcraft init FAILED; whatever it printed (possibly keys) is in $init"
    fi
    echo "INIT_CREATED=1"
  fi
  if [ "$noauto" = 1 ]; then
    systemctl disable --now mailcraft-autodeploy.timer >/dev/null 2>&1 || true
    say "auto-deploy is off (MAILCRAFT_NO_AUTODEPLOY=1)"
  else
    systemctl enable --now mailcraft-autodeploy.timer >/dev/null 2>&1
    say "auto-deploy is on: this VM follows the GitHub release vm-latest (pause: systemctl disable --now mailcraft-autodeploy.timer)"
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

[ "${MAILCRAFT_SKIP_BUILD:-}" = 1 ] || "$ROOT/scripts/build-vm-release.sh"
TGZ=$(ls "$DIST"/mailcraft-vm-*.tar.gz 2>/dev/null | head -n 1)
[ -n "$TGZ" ] || { echo "no $DIST/mailcraft-vm-*.tar.gz to deploy (run without MAILCRAFT_SKIP_BUILD)" >&2; exit 1; }
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
scp -q "${SSHO[@]}" "$TGZ" "$ROOT"/ops/vm/mailcraft-autodeploy.{sh,service,timer} "$0" "$TARGET:$STAGE/"

say "install + restart (api :$API_PORT, dashboard :$DASH_PORT)"
CMD="bash $STAGE/$(basename "$0") --remote $STAGE $API_PORT $DASH_PORT $REDIS_DB $HOST ${MAILCRAFT_NO_AUTODEPLOY:-0}"
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
