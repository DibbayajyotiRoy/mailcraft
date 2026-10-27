#!/usr/bin/env bash
# End-to-end proof against the real compose stack, driven by the real CLI.
#
#   1. docker compose up            (postgres + redis + mailcraft, plus an SMTP sink and a webhook receiver)
#   2. mailcraft init               (first-run setup, sandbox path)
#   3. mailcraft send --to delivered@test.mailcraft.local   -> email reaches `delivered`, an
#      email.delivered event exists, and a signed webhook arrives
#   4. live path: smtp-relay transport -> local SMTP sink, verified domain, go-live approval ->
#      the sink receives a DKIM-signed message (d= the test domain)
#
# Needs docker, jq, curl, python3. MAILCRAFT_BIN=path/to/mailcraft skips the cargo build.
# E2E_KEEP=1 leaves the stack up. Ports are overridable (E2E_API_PORT, E2E_SINK_*_PORT, E2E_HOOK_PORT).
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT=${E2E_API_PORT:-18080}
export MAILCRAFT_PORT=$API_PORT
export MAILCRAFT_SECRET_KEY=${MAILCRAFT_SECRET_KEY:-$(openssl rand -hex 32)}
export E2E_SINK_HTTP_PORT=${E2E_SINK_HTTP_PORT:-18025}
HOOK_PORT=${E2E_HOOK_PORT:-18099}
API=http://127.0.0.1:$API_PORT
SINK=http://127.0.0.1:$E2E_SINK_HTTP_PORT
DOMAIN=mail.e2e.test
COMPOSE="docker compose -p mc-e2e -f docker-compose.yml -f docker-compose.e2e.yml"
TMP=$(mktemp -d)

cleanup() {
  local rc=$?
  [ -n "${HOOK_PID:-}" ] && kill "$HOOK_PID" 2>/dev/null || true
  if [ $rc -ne 0 ]; then
    echo "--- FAILED (rc=$rc); server log tail:"; $COMPOSE logs --tail=40 mailcraft 2>&1 || true
  fi
  [ "${E2E_KEEP:-0}" = 1 ] || $COMPOSE down -v >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
ok()   { printf 'OK   %s\n' "$*"; }
die()  { printf 'FAIL %s\n' "$*" >&2; exit 1; }
# poll <seconds> <description> <command...>: retry until the command succeeds
poll() {
  local n=$1 what=$2; shift 2
  for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  die "timed out waiting for: $what"
}

# --- tools -------------------------------------------------------------------------------------
if [ -z "${MAILCRAFT_BIN:-}" ]; then
  step "build the CLI"
  cargo build -q -p mailcraft-cli
  MAILCRAFT_BIN=target/debug/mailcraft
fi
CLI() { "$MAILCRAFT_BIN" "$@"; }
export MAILCRAFT_CONFIG_DIR=$TMP/cfg MAILCRAFT_API_URL=$API
admin_curl() { curl -fsS -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }

# --- webhook receiver (host side) -----------------------------------------------------------
cat >"$TMP/hook.py" <<'PY'
import http.server, json, sys
OUT = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0))).decode()
        with open(OUT, "a") as f:
            f.write(json.dumps({"sig": self.headers.get("webhook-signature"), "id": self.headers.get("webhook-id"), "body": body}) + "\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
PY
python3 "$TMP/hook.py" "$HOOK_PORT" "$TMP/hooks.jsonl" & HOOK_PID=$!

# --- 1. compose --------------------------------------------------------------------------------
step "docker compose up (clean volumes)"
$COMPOSE down -v >/dev/null 2>&1 || true
$COMPOSE up -d --build postgres redis mailcraft sink
poll 90 "server readiness" curl -fsS "$API/readyz"
ok "server ready on $API"

# --- 2. init (sandbox) -------------------------------------------------------------------------
step "mailcraft init"
INIT=$(CLI init --non-interactive --json)
echo "$INIT" | jq -e '.ok == true' >/dev/null || { echo "$INIT"; die "init failed"; }
# init keeps only the test key (the admin key is a human secret); mint an admin key on the host.
ADMIN=$($COMPOSE exec -T mailcraft mailcraft-server bootstrap | sed -n 's/^admin key (shown once): //p')
[ -n "$ADMIN" ] || die "bootstrap returned no admin key"
echo "$INIT" | jq -e '.data.steps[] | select(.step=="test_send") | .status == "pass"' >/dev/null || die "init test send failed"
ok "init: admin + test key created, test send queued"

step "register a webhook (admin)"
admin_curl -XPOST "$API/v1/webhooks" -d "{\"url\":\"http://host.docker.internal:$HOOK_PORT/\",\"events\":[\"email.*\"]}" >/dev/null
ok "webhook endpoint created"

# --- 3. sandbox send ---------------------------------------------------------------------------
step "mailcraft send --to delivered@test.mailcraft.local"
SEND=$(CLI send --to delivered@test.mailcraft.local --subject "e2e hello" --text "It works" --json)
EID=$(echo "$SEND" | jq -r '.data.id')
[ -n "$EID" ] && [ "$EID" != null ] || { echo "$SEND"; die "send returned no id"; }
status_is() { [ "$(CLI emails get "$EID" --json | jq -r '.data.status')" = "$1" ]; }
poll 30 "email $EID to be delivered" status_is delivered
ok "email $EID status = delivered"
EVENTS=$(curl -fsS -H "Authorization: Bearer $ADMIN" "$API/v1/emails/$EID/events")
echo "$EVENTS" | jq -e '[.data[].type] | index("delivered") != null' >/dev/null || die "no delivered event"
ok "email event 'delivered' recorded: $(echo "$EVENTS" | jq -c '[.data[].type]')"
hook_seen() { grep -q "email.delivered" "$TMP/hooks.jsonl" && grep -q "v1," "$TMP/hooks.jsonl"; }
poll 30 "signed email.delivered webhook" hook_seen
ok "webhook received: $(grep -m1 "email.delivered" "$TMP/hooks.jsonl" | jq -c '{id, sig: (.sig|.[0:22]), type: (.body|fromjson|.type)}')"

# --- 4. live path through smtp-relay -> local SMTP sink -----------------------------------------------
step "live: smtp-relay transport -> SMTP sink"
admin_curl -XPOST "$API/v1/transports" \
  -d '{"kind":"smtp-relay","name":"e2e-sink","config":{"host":"127.0.0.1","port":1025,"tls":"none"}}' | jq -e '.ok' >/dev/null
ok "transport added (config encrypted at rest)"

step "mailcraft domain add $DOMAIN"
DOMJ=$(MAILCRAFT_API_KEY=$ADMIN CLI domain add "$DOMAIN" --json)
echo "$DOMJ" | jq -e '.data.records | length > 0' >/dev/null || { echo "$DOMJ"; die "domain add returned no DNS records"; }
ok "records to publish: $(echo "$DOMJ" | jq -r '[.data.records[] | .record] | join(",")')"
# DNS for a throwaway test domain cannot resolve; mark it verified directly. Real verification
# (hickory resolver against live DNS) is covered by the deliverability crate's tests.
$COMPOSE exec -T postgres psql -qU mailcraft -d mailcraft -c \
  "UPDATE domains SET status='verified', verified_at=now() WHERE name='$DOMAIN'" >/dev/null
ok "domain marked verified (DNS bypass, test only)"

step "go-live approval (human step, done by the admin key)"
AP=$(admin_curl -XPOST "$API/v1/go-live-requests" -d '{"note":"e2e"}' | jq -r '.data.approval_id')
admin_curl -XPOST "$API/v1/approvals/$AP/decide" -d '{"decision":"approve"}' | jq -e '.ok' >/dev/null
ok "go-live approved"

step "live send from the verified domain"
LIVE=$(MAILCRAFT_API_KEY=$ADMIN CLI send --from "hello@$DOMAIN" --to rcpt@example.org --subject "live e2e" --text "hello via relay" --json)
LID=$(echo "$LIVE" | jq -r '.data.id')
[ -n "$LID" ] && [ "$LID" != null ] || { echo "$LIVE"; die "live send failed"; }
sink_has() { [ "$(curl -fsS "$SINK/api/v1/messages" | jq '.messages | length')" -ge 1 ]; }
poll 40 "the SMTP sink to receive the message" sink_has
MID=$(curl -fsS "$SINK/api/v1/messages" | jq -r '.messages[0].ID')
RAW=$(curl -fsS "$SINK/api/v1/message/$MID/raw")
HEAD=$(printf '%s\n' "$RAW" | tr -d '\r' | sed '/^$/q' | sed ':a;N;$!ba;s/\n[ \t]\+/ /g')
printf '%s\n' "$HEAD" | grep -iq "^DKIM-Signature:.*d=$DOMAIN" || { printf '%s\n' "$HEAD"; die "no DKIM-Signature with d=$DOMAIN"; }
ok "sink received the message with DKIM-Signature d=$DOMAIN"
printf '%s\n' "$HEAD" | grep -i '^\(From\|To\|Message-ID\|Feedback-ID\):' | sed 's/^/     /'
live_sent() { [ "$(MAILCRAFT_API_KEY=$ADMIN CLI emails get "$LID" --json | jq -r '.data.status')" = sent ]; }
poll 15 "live email status sent" live_sent
ok "live email $LID status = sent"

printf '\nALL E2E CHECKS PASSED\n'
