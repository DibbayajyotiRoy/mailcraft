#!/usr/bin/env bash
# mailcraft-autodeploy: pull-based deploys for the LAN VM (docs/DEPLOY-VM.md, "Automatic deploys").
#   mailcraft-autodeploy                    poll the GitHub release `vm-latest`, deploy it if it is new (the timer runs this)
#   mailcraft-autodeploy install TGZ ID     install a release tarball: scripts/deploy-vm.sh uses this too, so manual and
#                                           automatic deploys share one layout, health check and rollback
# Layout: /opt/mailcraft/releases/<id>/{bin,dashboard,VERSION}, /opt/mailcraft/current -> releases/<id>,
#         /opt/mailcraft/bin -> current/bin. Only mailcraft-api + mailcraft-dashboard are ever restarted.
# Env: MAILCRAFT_RELEASE_URL  release JSON to poll instead of GitHub's (tests; also allows http://)
# shellcheck disable=SC2015,SC2012,SC2016   # `A && B || die` is deliberate; release dirs are our own ids
set -euo pipefail

OPT=/opt/mailcraft
ENVF=/etc/mailcraft/mailcraft.env
STATE=/var/lib/mailcraft-autodeploy   # lock, etag, handled, backoff-until, status
KEEP=3                                # releases kept on disk, current included
RELEASE_URL=${MAILCRAFT_RELEASE_URL:-https://api.github.com/repos/DibbayajyotiRoy/mailcraft/releases/tags/vm-latest}
PROTO='=https'; [ -z "${MAILCRAFT_RELEASE_URL:-}" ] || PROTO='=http,https'
ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'

say() { echo "mailcraft-autodeploy: $*"; }
quiet() { echo "$(date -u +%FT%TZ) $*" >"$STATE/status"; }   # routine outcome: no journal line every 2 minutes, see `status`
die() { say "$*" >&2; exit 1; }

# ----------------------------------------------------------------------------- install + switch + health + rollback
ports() {
  API=$(sed -n 's/^MAILCRAFT_BIND=.*:\([0-9][0-9]*\)$/\1/p' "$ENVF")
  DASH=$(systemctl show -p Environment --value mailcraft-dashboard.service | tr ' ' '\n' | sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p')
  [ -n "$API" ] && [ -n "$DASH" ] || die "cannot work out the api/dashboard ports from $ENVF and mailcraft-dashboard.service"
}

healthy() {   # api /readyz (migrations ran, Postgres ok), then the dashboard, then both still running a few seconds later
  local i
  for i in $(seq 40); do curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$API/readyz" 2>/dev/null && break; [ "$i" -lt 40 ] || return 1; sleep 1; done
  for i in $(seq 30); do curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$DASH/login" 2>/dev/null && break; [ "$i" -lt 30 ] || return 1; sleep 1; done
  sleep 3
  systemctl is-active --quiet mailcraft-api.service && systemctl is-active --quiet mailcraft-dashboard.service
}

activate() { ln -sfn "releases/$1" "$OPT/current.new" && mv -T "$OPT/current.new" "$OPT/current"; }   # atomic

restart() { systemctl restart mailcraft-api.service mailcraft-dashboard.service; }

legacy() {   # a VM deployed before this layout (real bin/ + dashboard/): keep it as a release, so the first upgrade can roll back
  [ -d "$OPT/dashboard" ] && [ ! -L "$OPT/dashboard" ] && [ ! -e "$OPT/current" ] || return 0
  say "moving the pre-autodeploy bin/ + dashboard/ into releases/pre-autodeploy"
  install -d "$OPT/releases/pre-autodeploy" &&
    mv "$OPT/bin" "$OPT/dashboard" "$OPT/releases/pre-autodeploy/" &&
    echo pre-autodeploy >"$OPT/releases/pre-autodeploy/VERSION" &&
    activate pre-autodeploy || die "could not move the old layout into releases/pre-autodeploy"
}

prune() {   # newest KEEP releases by mtime, never the current one
  local cur d; cur=$(readlink "$OPT/current")
  ls -1dt "$OPT"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r d; do
    [ "${d%/}" = "$OPT/$cur" ] || { say "removing old release ${d%/}"; rm -rf "${d%/}"; }
  done
}

# $1 tarball, $2 id. 0 = healthy on the new release; 1 = failed (rolled back if there was a previous one).
# Callers use it in an `if`, where `set -e` is off inside the function: every step that matters says `|| die`.
install_release() {
  local tgz=$1 id=$2 rel p prev=""
  [[ $id =~ $ID_RE ]] || die "bad release id: $id"
  rel=$OPT/releases/$id
  install -d "$OPT/releases" || die "cannot create $OPT/releases"
  legacy
  prev=$(readlink "$OPT/current" 2>/dev/null || true); prev=${prev#releases/}

  if [ "$prev" != "$id" ]; then   # re-installing the current release only restarts + checks it
    p=$rel.partial
    rm -rf "$p" "$rel"; mkdir "$p" || die "cannot create $p"
    # tar refuses ".." members and strips a leading "/" by default; --no-same-owner keeps everything root:root
    tar -xzf "$tgz" -C "$p" --no-same-owner || { rm -rf "$p"; die "cannot extract $tgz"; }
    { [ -x "$p/bin/mailcraft-server" ] && [ -x "$p/bin/mailcraft" ] && [ -f "$p/dashboard/server.js" ] && [ "$(cat "$p/VERSION" 2>/dev/null)" = "$id" ]; } ||
      { rm -rf "$p"; die "tarball does not look like release $id (need bin/mailcraft-server, bin/mailcraft, dashboard/server.js, VERSION=$id)"; }
    install -d -o mailcraft -g mailcraft "$p/dashboard/.next/cache" &&   # the one place the dashboard may write
      mv "$p" "$rel" && touch "$rel" || die "cannot put release $id in place"
  fi
  [ -L "$OPT/bin" ] || { rm -rf "${OPT:?}/bin"; ln -s current/bin "$OPT/bin" || die "cannot link $OPT/bin"; }

  ports
  say "switching ${prev:-nothing} -> $id"
  activate "$id" || die "cannot switch current -> $id"; restart || true   # a failed restart shows up as unhealthy below
  if healthy; then
    say "release $id healthy (api :$API, dashboard :$DASH)"
    prune
    return 0
  fi
  say "release $id is NOT healthy; last journal lines:"; journalctl -u mailcraft-api -u mailcraft-dashboard -n 20 --no-pager || true
  if [ -n "$prev" ] && [ "$prev" != "$id" ] && [ -d "$OPT/releases/$prev" ]; then
    say "rolling back to $prev"
    activate "$prev" || die "cannot switch current back to $prev"; restart || true
    if healthy; then say "rolled back to $prev, healthy"
    else say "ROLLBACK TO $prev IS ALSO UNHEALTHY. If $id added a migration the older binary refuses the newer schema: fix forward (docs/DEPLOY-VM.md)"; fi
    rm -rf "$rel"
  fi
  return 1
}

# ----------------------------------------------------------------------------- poll GitHub
poll() {
  local W code etag="" now bo ra reset sha tgz_url sum_url fields want got
  W=$(mktemp -d "$STATE/work.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$W'" EXIT   # expand now: $W is local and gone when EXIT fires
  now=$(date +%s)
  if [ -s "$STATE/backoff-until" ] && [ "$now" -lt "$(cat "$STATE/backoff-until")" ]; then
    quiet "rate limited by GitHub, backing off until $(date -u -d "@$(cat "$STATE/backoff-until")" +%FT%TZ)"; return 0
  fi
  [ -s "$STATE/handled" ] && [ -s "$STATE/etag" ] && etag=$(cat "$STATE/etag")   # no `handled` (operator reset it) = ask in full

  code=$(curl -sS -m 30 --proto "$PROTO" -D "$W/hdr" -o "$W/body" -w '%{http_code}' -A mailcraft-autodeploy \
           -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
           ${etag:+-H "If-None-Match: $etag"} "$RELEASE_URL" 2>"$W/err") || code=000
  hdr() { tr -d '\r' <"$W/hdr" | sed -n "s/^$1: *//Ip" | tail -n 1; }
  case $code in
    304) quiet "up to date (release unchanged)"; return 0 ;;
    404) quiet "no vm-latest release yet"; return 0 ;;
    000) quiet "GitHub unreachable: $(head -c 200 "$W/err")"; return 0 ;;
    200) ;;
    403|429)   # rate limit (60/h unauthenticated) or abuse limit
      ra=$(hdr retry-after); reset=$(hdr x-ratelimit-reset)
      [[ $ra =~ ^[0-9]+$ ]] || ra=""; [[ $reset =~ ^[0-9]+$ ]] || reset=""
      if [ -n "$ra" ]; then bo=$((now + ra)); elif [ "$(hdr x-ratelimit-remaining)" = 0 ] && [ -n "$reset" ]; then bo=$reset; else bo=$((now + 900)); fi
      [ "$bo" -ge $((now + 60)) ] || bo=$((now + 60)); [ "$bo" -le $((now + 3600)) ] || bo=$((now + 3600))
      echo "$bo" >"$STATE/backoff-until"; say "GitHub answered HTTP $code: backing off for $((bo - now))s"
      quiet "HTTP $code from GitHub, backing off until $(date -u -d "@$bo" +%FT%TZ)"; return 0 ;;
    *) say "unexpected HTTP $code from $RELEASE_URL"; quiet "unexpected HTTP $code"; return 0 ;;
  esac
  rm -f "$STATE/backoff-until"

  # the release body carries `sha: <40 hex>` and is edited last by the workflow, so the assets it names already exist
  fields=$(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const sha = ((r.body || "").match(/^sha:\s*([0-9a-f]{40})\s*$/m) || [])[1];
    if (!sha) process.exit(2);
    const url = n => ((r.assets || []).find(a => a.name === n) || {}).browser_download_url;
    const t = url(`mailcraft-vm-${sha}.tar.gz`), s = url(`mailcraft-vm-${sha}.tar.gz.sha256`);
    if (!t || !s) process.exit(3);
    console.log(sha, t, s);' "$W/body") || { quiet "vm-latest has no sha/assets yet (build still publishing?)"; return 0; }
  read -r sha tgz_url sum_url <<<"$fields"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "bad sha in release: $sha"
  hdr etag >"$W/etag"

  if [ "$sha" = "$(cut -d' ' -f1 "$STATE/handled" 2>/dev/null)" ] || [ "$sha" = "$(cat "$OPT/current/VERSION" 2>/dev/null)" ]; then
    [ -s "$STATE/handled" ] || echo "$sha ok" >"$STATE/handled"
    cp "$W/etag" "$STATE/etag"; quiet "up to date at ${sha:0:12}"; return 0
  fi

  say "new release ${sha:0:12}, downloading"
  curl -fsSL -m 900 --retry 2 --proto "$PROTO" --proto-redir "$PROTO" -o "$W/r.tgz" "$tgz_url" &&
    curl -fsSL -m 60 --retry 2 --proto "$PROTO" --proto-redir "$PROTO" -o "$W/r.sha256" "$sum_url" ||
    { say "download failed, will retry next run"; quiet "download of ${sha:0:12} failed"; return 0; }
  want=$(awk '{print $1; exit}' "$W/r.sha256"); got=$(sha256sum "$W/r.tgz" | awk '{print $1}')
  [[ $want =~ ^[0-9a-f]{64}$ ]] && [ "$want" = "$got" ] || die "sha256 mismatch for ${sha:0:12} (published $want, downloaded $got): not installing"

  if install_release "$W/r.tgz" "$sha"; then
    echo "$sha ok" >"$STATE/handled"; cp "$W/etag" "$STATE/etag"; quiet "deployed ${sha:0:12}"
  else
    # remembered, so a bad release is not re-downloaded every 2 minutes; the next merge (new sha) is tried normally
    echo "$sha failed" >"$STATE/handled"; cp "$W/etag" "$STATE/etag"; quiet "release ${sha:0:12} FAILED its health check and was rolled back"
    return 1
  fi
}

# ----------------------------------------------------------------------------- main
install -d -m 700 "$STATE"
exec 9>"$STATE/lock"
case ${1:-poll} in
  poll)    flock -n 9 || { echo "another run is in progress"; exit 0; }; poll ;;
  install) [ $# = 3 ] || die "usage: $0 install TARBALL ID"; flock -w 900 9 || die "timed out waiting for another run"; install_release "$2" "$3" ;;
  *)       die "usage: $0 [install TARBALL ID]" ;;
esac
