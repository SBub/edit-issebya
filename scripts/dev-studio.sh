#!/usr/bin/env bash
# One command for the reel studio in local development (the owner's machine only).
#
#   yarn dev:studio                    checks, then runs web + studio + worker until Ctrl-C
#   yarn dev:studio --check            the checks only (also: yarn dev:studio:status)
#   yarn dev:studio add-owner <email>  creates a confirmed user in the LOCAL auth
#
# Works on the owner's local Supabase stack (project `edit-issebya`, supabase/config.toml), never
# on the ADW stack (`edit-issebya-adw`) and never on the hosted project. Reads no `.env*` file: it
# only tests that the three app files exist. Written for the bash 3.2 that ships with macOS.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this from inside the edit-issebya repository" >&2
  exit 1
}
cd "$ROOT" || exit 1

STUDIO_URL="http://localhost:3000/studio"
MAILPIT_URL="http://127.0.0.1:54434"
SUPABASE_STUDIO_URL="http://127.0.0.1:54433"

fail() {
  echo "dev:studio: $1" >&2
  exit 1
}
ok() { echo "ok  $1"; }

check_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed: install Docker Desktop"
  docker info >/dev/null 2>&1 || fail "Docker is not running: start Docker Desktop"
  ok "Docker is running"
}

check_supabase() {
  command -v supabase >/dev/null 2>&1 || fail "The Supabase CLI is not installed: brew install supabase/tap/supabase"
  if supabase status --workdir "$ROOT" >/dev/null 2>&1; then
    ok "Local Supabase stack edit-issebya is up"
  else
    echo "..  Local Supabase stack edit-issebya is down: supabase start"
    supabase start --workdir "$ROOT" || fail "supabase start failed (see the output above)"
    ok "Local Supabase stack edit-issebya started"
  fi
}

apply_migrations() {
  local out
  out="$(supabase migration up --local --workdir "$ROOT" 2>&1)" || {
    echo "$out" >&2
    fail "supabase migration up --local failed (see the output above)"
  }
  ok "Migrations applied"
}

check_env_files() {
  local app
  for app in web studio worker; do
    test -f "apps/$app/.env.development" ||
      fail "apps/$app/.env.development is missing: copy apps/$app/.env.example and fill it"
  done
  ok "Env files exist (web, studio, worker)"
}

run_doctor() {
  local out
  out="$(yarn workspace @edit-issebya/worker doctor 2>&1)" || {
    echo "$out" >&2
    fail "the worker doctor failed (see its output above)"
  }
  ok "Worker doctor passed"
}

run_checks() {
  check_docker
  check_supabase
  apply_migrations
  check_env_files
  run_doctor
}

# add-owner <email>: a confirmed user in the local auth, through the local Auth admin API. The
# login form never creates a user (shouldCreateUser: false), so the owner account must exist.
add_owner() {
  local email="${1:-}" status api_url secret code
  [ -n "$email" ] || fail "usage: yarn dev:studio add-owner <email>"
  case "$email" in *@*.*) ;; *) fail "Not an email address: $email" ;; esac
  case "$email" in *[\"\\\ ]*) fail "Not an email address: $email" ;; esac
  check_docker
  status="$(supabase status --workdir "$ROOT" -o env 2>/dev/null)" ||
    fail "Local Supabase stack edit-issebya is down: run yarn dev:studio --check first"
  api_url="$(printf '%s\n' "$status" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  secret="$(printf '%s\n' "$status" | sed -n 's/^SECRET_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p')"
  case "$api_url" in
    http://127.0.0.1:* | http://localhost:*) ;;
    *) fail "Refusing a non-local Supabase URL: $api_url" ;;
  esac
  [ -n "$secret" ] || fail "supabase status printed no SECRET_KEY"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$api_url/auth/v1/admin/users" \
    -H "apikey: $secret" -H "Authorization: Bearer $secret" -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"email_confirm\":true}")" || fail "Could not reach $api_url"
  case "$code" in
    200 | 201) ok "Created $email in the local auth" ;;
    422) ok "$email already exists in the local auth" ;;
    *) fail "The local Auth admin API answered HTTP $code" ;;
  esac
}

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

PGIDS=()
stopping=0
stop_all() {
  [ "$stopping" = 1 ] && return
  stopping=1
  set +m
  echo
  echo "Stopping web, studio and worker..."
  local pg i
  for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do kill -TERM -- "-$pg" 2>/dev/null; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    local alive=0
    for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do kill -0 -- "-$pg" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && break
    sleep 1
  done
  for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do kill -KILL -- "-$pg" 2>/dev/null; done
  wait 2>/dev/null
  echo "Stopped."
}

# Starts a pipeline in its own process group (job control is on) and records the group id.
start_group() {
  "$@" &
  PGIDS+=("$(ps -o pgid= -p $! | tr -d ' ')")
}

start_all() {
  local port
  for port in 3000 3001; do
    port_in_use "$port" && fail "Port $port is already in use: stop whatever holds it, then retry"
  done

  set -m
  trap 'stop_all; exit 130' INT
  trap 'stop_all; exit 143' TERM
  trap 'stop_all' EXIT

  start_group bash -c 'STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio'
  start_group bash -c 'yarn workspace @edit-issebya/worker worker 2>&1 | awk "{ print \"worker: \" \$0; fflush() }"'

  local ready=0 i pg
  for i in $(seq 1 180); do
    curl -s -o /dev/null --max-time 2 "$STUDIO_URL" && ready=1 && break
    for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do
      kill -0 -- "-$pg" 2>/dev/null || fail "A dev process exited during startup (see the output above)"
    done
    sleep 1
  done
  [ "$ready" = 1 ] || fail "$STUDIO_URL did not answer within 3 minutes"

  cat <<EOF

  Studio:                http://localhost:3000/studio
  Magic link emails:     Mailpit $MAILPIT_URL
  Database:              Supabase Studio $SUPABASE_STUDIO_URL
  Sign in with the owner email; the link arrives in Mailpit.
  Ctrl-C stops web, studio and worker.

EOF

  while :; do
    for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do
      kill -0 -- "-$pg" 2>/dev/null || fail "A dev process exited (see the output above)"
    done
    sleep 1
  done
}

case "${1:-}" in
  --check | check | status) run_checks && echo "All checks passed; yarn dev:studio starts the studio." ;;
  add-owner) add_owner "${2:-}" ;;
  "") run_checks && start_all ;;
  *) fail "unknown argument $1 (use --check or add-owner <email>)" ;;
esac
