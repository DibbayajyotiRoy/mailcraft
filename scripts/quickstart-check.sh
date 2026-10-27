#!/usr/bin/env bash
# Runs the README quickstart literally, as a new user would, then "Your first automation".
# Prints OK / FAIL / SKIP per step, exits non-zero if any step failed, always tears down (down -v).
# Everything goes through the CLI the README tells the user to use (compose `cli` service); no SQL, no raw keys.
#
# Needs: docker (compose v2), curl, jq, openssl. Without a compose `cli` service, also cargo.
#
# Overrides (use when the README's commands change; defaults follow the README today):
#   QS_PROJECT       compose project name                        (default mcqs-check-<pid>)
#   QS_API_PORT      host API port, exported as MAILCRAFT_PORT   (default 8080)
#   QS_DASH_PORT     host dashboard port, MAILCRAFT_DASHBOARD_PORT (default 3000)
#   QS_CLI           CLI prefix, e.g. "mailcraft" (default: `docker compose run --rm cli` if the compose file
#                    has a `cli` service, else a cargo-built binary with a temp config dir)
#   QS_ADMIN_FLAG    how to select the admin key                 (default "--profile admin")
#   QS_INIT_ARGS     first-run setup args                        (default "init")
#   QS_SEND_ARGS     test send args    (default send --to delivered@test.mailcraft.local --subject hello --text "it works" --json)
#   QS_FROM          "from" on the automation step               (default qs@test.mailcraft.local)
#   QS_WAIT          seconds per poll                            (default 60)
#   QS_KEEP=1        leave the stack up
# Extra env for a manual LLM run (not CI): OPENROUTER_API_KEY, MAILCRAFT_LLM_* are passed through to compose if already
# exported; by default OPENROUTER_API_KEY is forced empty so the run is key-free and uses fallback copy.
set -uo pipefail
cd "$(dirname "$0")/.."

P=${QS_PROJECT:-mcqs-check-$$}
API_PORT=${QS_API_PORT:-8080}; DASH_PORT=${QS_DASH_PORT:-3000}; WAIT=${QS_WAIT:-60}
FROM=${QS_FROM:-qs@test.mailcraft.local}; ADMIN=${QS_ADMIN_FLAG---profile admin}
export COMPOSE_PROJECT_NAME=$P MAILCRAFT_PORT=$API_PORT MAILCRAFT_DASHBOARD_PORT=$DASH_PORT
export OPENROUTER_API_KEY=${QS_LLM_KEY-}   # LLM off unless QS_LLM_KEY is set (manual run): fallback copy, no key needed
# a dev's own config must never leak into the run
unset MAILCRAFT_API_KEY MAILCRAFT_API_URL MAILCRAFT_PROFILE MAILCRAFT_CONFIG_DIR
TMP=$(mktemp -d); FAILS=0; ENVBAK=""; CLI=(); HEALTH_OK=""
WT=qs-welcome.json; WA=qs-welcome-automation.json   # in the repo dir: the cli service mounts it read-only at /work

dc() { docker compose "$@"; }
say() { printf '%s\n' "$*"; }
ok() { say "OK   $*"; }
bad() { say "FAIL $*"; FAILS=$((FAILS + 1)); }
skip() { say "SKIP $* (earlier step failed)"; }
poll() { local n=$1; shift; for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
# stdout only (JSON stays parseable; compose prints "Container ... Started" on stderr); stderr kept for failure messages
cli() { "${CLI[@]}" "$@" < /dev/null 2>"$TMP/err"; }
tail1() { printf '%s' "$1" | tail -3 | tr '\n' ' ' | cut -c1-300; }
# run <description> <cli args...>: OK/FAIL, output left in $OUT
run() { local what=$1; shift; OUT=$(cli "$@"); local rc=$?
  if [ $rc -eq 0 ]; then ok "$what"; else bad "$what (exit $rc): $(tail1 "$OUT$(cat "$TMP/err")")"; fi; return $rc; }

cleanup() {
  local rc=$?
  if [ "${QS_KEEP:-0}" = 1 ]; then say "QS_KEEP=1: stack left up as project $P"; else
    [ $((FAILS + rc)) -ne 0 ] && { say "--- server log tail"; dc logs --tail=30 mailcraft 2>&1 | tail -30; }
    dc --profile cli down -v --remove-orphans >/dev/null 2>&1; say "teardown: project $P removed (down -v)"
  fi
  rm -f .env "$WT" "$WA"; [ -n "$ENVBAK" ] && mv "$ENVBAK" .env
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---- 1. README: secret into .env (a developer's own .env is parked and restored) ----------------
[ -f .env ] && { ENVBAK=$(mktemp .env.bak.XXXX); mv .env "$ENVBAK"; }
echo "MAILCRAFT_SECRET_KEY=$(openssl rand -base64 32)" > .env
grep -q '^MAILCRAFT_SECRET_KEY=.\{20,\}' .env && ok "secret key written to .env" || bad ".env secret"

# ---- 2. docker compose up -d --------------------------------------------------------------------
if dc up -d --build >"$TMP/up.log" 2>&1; then ok "docker compose up -d"; else bad "docker compose up -d"; tail -15 "$TMP/up.log"; fi
if poll 90 curl -fsS "http://localhost:$API_PORT/healthz"; then ok "GET /healthz on :$API_PORT"; HEALTH_OK=1; else bad "/healthz never answered on :$API_PORT"; fi

# ---- 3. the CLI the README instructs ------------------------------------------------------------
if [ -n "${QS_CLI:-}" ]; then read -ra CLI <<<"$QS_CLI"
elif dc --profile cli config --services 2>/dev/null | grep -qx cli; then CLI=(docker compose run --rm cli); say "CLI: docker compose run --rm cli"
else
  say "no compose cli service: building the CLI with cargo"
  if cargo build -q -p mailcraft-cli 2>"$TMP/cargo.log"; then
    CLI=("$PWD/target/debug/mailcraft"); export MAILCRAFT_CONFIG_DIR=$TMP/cfg MAILCRAFT_API_URL=http://localhost:$API_PORT
  else bad "cargo build -p mailcraft-cli"; tail -10 "$TMP/cargo.log"; fi
fi

INIT_OK=""
if [ ${#CLI[@]} -gt 0 ] && [ -n "$HEALTH_OK" ]; then
  # shellcheck disable=SC2086
  run "mailcraft ${QS_INIT_ARGS:-init}" ${QS_INIT_ARGS:-init} && INIT_OK=1
  [ -n "$INIT_OK" ] && { printf '%s' "$OUT" | grep -qiE "won't be shown again|admin key" && ok "init printed the admin key" || bad "init did not print the admin key"; }
else skip "init"; fi

# ---- 4. test send -> delivered ------------------------------------------------------------------
if [ -n "$INIT_OK" ]; then
  # shellcheck disable=SC2086
  run "mailcraft send (test address)" ${QS_SEND_ARGS:-send --to delivered@test.mailcraft.local --subject hello --text "it works" --json}
  EID=$(printf '%s' "$OUT" | jq -r '.data.id // empty' 2>/dev/null)
  if [ -z "$EID" ]; then bad "send returned no email id"; else
    st() { [ "$(cli emails get "$EID" --json | jq -r '.data.status')" = delivered ]; }
    if poll "$WAIT" st; then ok "test email delivered"; else bad "test email not delivered in ${WAIT}s: $(cli emails get "$EID" --json | jq -r '"status=" + .data.status + " last_error=" + (.data.last_error // "none")' 2>&1)"; fi
  fi
else skip "test send"; fi

# ---- 5. dashboard answers on its port -----------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$DASH_PORT/login")
case $code in 200|30?) ok "dashboard answers on :$DASH_PORT/login (HTTP $code)";; *) bad "dashboard on :$DASH_PORT/login returned HTTP $code";; esac

# ---- 6. first automation: sandbox, LLM off -> fallback copy (README commands) -------------------
if [ -n "$INIT_OK" ]; then
  RCPT=delivered+qsauto@test.mailcraft.local
  cat > "$WT" <<'J'
{"version": 1, "subject": "Welcome {{ first_name }}",
 "blocks": [
  {"type": "heading", "text": "Hi {{ first_name }}"},
  {"type": "slot", "name": "intro", "max_len": 240,
   "instructions": "One warm sentence welcoming them and naming the next step.",
   "fallback": "Thanks for signing up. Your account is ready."}]}
J
  jq -n --arg from "$FROM" '{name:"qs-welcome",trigger:"signed_up",approval:"first_n:5",steps:[{key:"mail",type:"send_email",config:{template:"qs-welcome",mode:"llm",from:$from,instructions:"Friendly and brief."}}]}' > "$WA"
  run "templates import (slot + fallback)" templates import "$WT" --name qs-welcome &&
  run "templates publish" templates publish qs-welcome &&
  run "automations import" automations import "$WA" &&
  run "automations publish" automations publish qs-welcome &&
  run "contacts upsert" contacts upsert "$RCPT" --first-name Ana --timezone Europe/Berlin &&
  run "events track signed_up" events track signed_up --contact "$RCPT" &&
  {
    # shellcheck disable=SC2086
    pend() { cli $ADMIN approvals list --json | jq -e '[.data[] | select((.status // "pending") == "pending")] | length > 0'; }
    if poll "$WAIT" pend; then
      # shellcheck disable=SC2086
      for id in $(cli $ADMIN approvals list --json | jq -r '.data[] | select((.status // "pending") == "pending") | .id'); do
        run "admin approves $id" $ADMIN approvals approve "$id"
      done
    else bad "no approval appeared for the first automation send (README: first 5 sends wait for a human)"; fi
    find() { cli emails list --limit 50 --json | jq -e --arg r "$RCPT" '[.data[] | select(tostring | contains($r))][0]' > "$TMP/mail.json"; }
    done_() { find && [ "$(jq -r .status "$TMP/mail.json")" = delivered ]; }
    if poll "$((WAIT * 2))" done_; then ok "automation email delivered (sandbox)"
    else bad "automation email not delivered in $((WAIT * 2))s: $(jq -r '"status=" + .status + " last_error=" + (.last_error // "none")' "$TMP/mail.json" 2>/dev/null || echo 'no email was created')"; fi
  }
else skip "first automation"; fi

say; [ $FAILS -eq 0 ] && say "quickstart-check: PASS" || say "quickstart-check: $FAILS step(s) FAILED"
[ $FAILS -eq 0 ]
