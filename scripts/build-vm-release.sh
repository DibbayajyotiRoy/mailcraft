#!/usr/bin/env bash
# Build the VM release tarball: bin/{mailcraft-server,mailcraft}, dashboard/ (Next standalone), VERSION.
#   ./scripts/build-vm-release.sh      -> target/vm-dist/mailcraft-vm-<id>.tar.gz (+ .sha256)
# One build for both paths: scripts/deploy-vm.sh (manual) and .github/workflows/vm-build.yml (rolling release
# `vm-latest`, picked up by ops/vm/mailcraft-autodeploy.sh). Rust is built in rust:1.99.1-bookworm so the
# binaries run on Debian 12 (glibc 2.36). Needs Docker, Node + npm.
#
# Env (all optional): MAILCRAFT_RELEASE_ID    default manual-<git sha>[-dirty]-<UTC time>; CI passes the commit sha
#                     MAILCRAFT_CARGO_CACHE   docker volume or host dir for the cargo registry (default mc-vm-cargo)
#                     MAILCRAFT_TARGET_CACHE  docker volume or host dir for the cargo target (default mc-vm-target)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST=$ROOT/target/vm-dist
PACK=$DIST/pack   # becomes the tarball root
say() { echo "==> $*"; }

ID=${MAILCRAFT_RELEASE_ID:-manual-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo nogit)$(git -C "$ROOT" diff --quiet HEAD 2>/dev/null || echo -dirty)-$(date -u +%Y%m%d%H%M%S)}
[[ $ID =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || { echo "bad release id: $ID" >&2; exit 1; }

CARGO_CACHE=${MAILCRAFT_CARGO_CACHE:-mc-vm-cargo}
TARGET_CACHE=${MAILCRAFT_TARGET_CACHE:-mc-vm-target}
for d in "$CARGO_CACHE" "$TARGET_CACHE"; do [[ $d != /* ]] || mkdir -p "$d"; done   # host dirs; anything else is a docker volume name

say "rust (bookworm container, glibc 2.36; incremental via $TARGET_CACHE)"
mkdir -p "$PACK/bin"
docker run --rm -e RUSTUP_TOOLCHAIN=1.99.1 -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -e CARGO_TARGET_DIR=/target \
  -v "$ROOT":/src:ro -v "$CARGO_CACHE":/usr/local/cargo/registry -v "$TARGET_CACHE":/target -v "$PACK/bin":/out -w /src \
  rust:1.99.1-bookworm bash -c 'cargo build --release --locked --bin mailcraft-server --bin mailcraft &&
    install -m755 /target/release/mailcraft-server /target/release/mailcraft /out/ && chown $HOST_UID:$HOST_GID /out/*'

# a no-op `next build` still costs ~40s: skip it when no dashboard source is newer than the last build
STAMP=$DIST/dashboard.stamp
if [ -f "$STAMP" ] && [ -f "$PACK/dashboard/server.js" ] &&
   [ -z "$(find "$ROOT/dashboard" \( -name node_modules -o -name .next \) -prune -o -type f -newer "$STAMP" -print -quit)" ]; then
  say "dashboard unchanged, reusing it"
else
  say "dashboard (next standalone)"
  ( cd "$ROOT/dashboard"
    [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund
    NEXT_TELEMETRY_DISABLED=1 npm run build >"$DIST/dashboard-build.log" 2>&1 ||
      { tail -n 40 "$DIST/dashboard-build.log" >&2; echo "dashboard build failed" >&2; exit 1; } )
  rm -rf "$PACK/dashboard"; mkdir -p "$PACK/dashboard/.next"
  cp -a "$ROOT/dashboard/.next/standalone/." "$PACK/dashboard/"
  cp -a "$ROOT/dashboard/.next/static" "$PACK/dashboard/.next/static"
  [ ! -d "$ROOT/dashboard/public" ] || cp -a "$ROOT/dashboard/public" "$PACK/dashboard/public"
  [ -f "$PACK/dashboard/server.js" ] || { echo "standalone build has no server.js at its root" >&2; exit 1; }
  touch "$STAMP"
fi

say "pack mailcraft-vm-$ID.tar.gz"
echo "$ID" > "$PACK/VERSION"
rm -f "$DIST"/mailcraft-vm-*
tar -C "$PACK" --owner=0 --group=0 --numeric-owner -czf "$DIST/mailcraft-vm-$ID.tar.gz" bin dashboard VERSION
( cd "$DIST" && sha256sum "mailcraft-vm-$ID.tar.gz" > "mailcraft-vm-$ID.tar.gz.sha256" )
ls -lh "$DIST/mailcraft-vm-$ID.tar.gz"
