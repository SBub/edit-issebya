#!/usr/bin/env bash
# One command for the reel studio in local development (the owner's machine only).
#
#   yarn dev:studio                    checks, then runs web + studio + the worker in Docker until Ctrl-C
#   yarn dev:studio --check            the checks only (also: yarn dev:studio:status)
#   yarn dev:studio add-owner <email>  creates a confirmed user in the LOCAL auth
#
# Works on the owner's local Supabase stack (project `edit-issebya`, supabase/config.toml), never
# on the ADW stack (`edit-issebya-adw`) and never on the hosted project. Reads no `.env*` file: it
# only tests that the three app files exist. Written for the bash 3.2 that ships with macOS.
#
# The worker runs in Docker (compose.yaml), everything it needs inside the image
# (app_docs/worker-container.md). Local monitoring always starts too.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Run this from inside the edit-issebya repository" >&2
  exit 1
}
cd "$ROOT" || exit 1

STUDIO_URL="http://localhost:3000/studio"
MAILPIT_URL="http://127.0.0.1:54434"
SUPABASE_STUDIO_URL="http://127.0.0.1:54433"
# Local monitoring, from docker-compose.monitoring.yml. Grafana is on 3300, not 3000,
# because the landing page owns 3000.
MONITORING_COMPOSE="$ROOT/docker-compose.monitoring.yml"
MONITORING_UI_URL="http://localhost:3300"
# The worker container reaches the Mac's OTLP port through host.docker.internal.
MONITORING_OTLP_URL="http://host.docker.internal:4318"
# The worker's compose file.
WORKER_COMPOSE="$ROOT/compose.yaml"

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

# Compose never gets the keyboard: its interactive menu puts the terminal in raw mode, and then
# Ctrl-C no longer reaches this script.
export COMPOSE_MENU=false
worker_compose() { docker compose -f "$WORKER_COMPOSE" "$@" </dev/null; }

# Leftovers of a run that did not stop cleanly: the worker container.
clean_leftovers() {
  worker_compose down --remove-orphans >/dev/null 2>&1
}

build_worker_image() {
  worker_compose build worker || fail "docker compose build for the worker failed (see the output above)"
  ok "Worker image built"
}

# The doctor runs inside the worker container (no --ai: no paid call at startup).
run_doctor() {
  local out
  out="$(worker_compose run --rm --no-deps -T worker node src/doctor.ts 2>&1)" || {
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
  clean_leftovers
  install_traps
  build_worker_image
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
  echo "Stopping web, studio and the worker..."
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
  # Whatever compose left behind (a killed `compose up` may not stop its container).
  worker_compose down >/dev/null 2>&1
  echo "Stopped."
}

# Starts a pipeline in its own process group and records the group id.
# Job control is on only for the launch: left on, every foreground command (each `sleep` of the wait
# loops) would get its own process group and the terminal, and Ctrl-C would reach that command, never
# this script's trap.
start_group() {
  set -m
  "$@" &
  set +m
  PGIDS+=("$(ps -o pgid= -p $! | tr -d ' ')")
}

# Starts the local monitoring containers (otel-lgtm and cAdvisor). They are left running on exit,
# since they are cheap to keep and the data survives; `docker compose -f docker-compose.monitoring.yml down`
# stops them. One stack per machine: every checkout uses the same Compose project name, so a stack
# that already answers on Grafana (from any checkout) and runs every service of this checkout's
# compose file is reused and not started again. A stack that lacks a service (one started by an
# older checkout) gets `up -d`, which adds the service and recreates a container whose settings
# changed (the data volume is kept).
# Up is not the same as working: the image can exit seconds after it starts (one of its programs
# failing at start). So the script waits for Grafana to answer, recreates the container once when it
# does not (the data volume is kept), and otherwise warns: the studio runs without monitoring, but
# the worker's traces and logs are not recorded while it is down.
monitoring_down=0

monitoring_answers() { curl -fsS -o /dev/null --max-time 2 "$MONITORING_UI_URL/api/health"; }

# True when the otel-lgtm container is not running (exited, restarting or missing).
monitoring_not_running() {
  local states
  states="$(docker compose -f "$MONITORING_COMPOSE" ps -a --format '{{.State}}' otel-lgtm 2>/dev/null)" || return 0
  [ "$states" = running ] && return 1
  return 0
}

# True when every service of the compose file has a running container.
monitoring_complete() {
  local wanted running
  wanted="$(docker compose -f "$MONITORING_COMPOSE" config --services 2>/dev/null | sort)" || return 1
  running="$(docker compose -f "$MONITORING_COMPOSE" ps --status running --services 2>/dev/null | sort)" || return 1
  [ -n "$wanted" ] && [ "$wanted" = "$running" ]
}

# Up to 60 seconds, polling every 2 seconds. Stops early when the container has exited.
wait_for_monitoring() {
  local i
  for i in $(seq 1 30); do
    monitoring_answers && return 0
    monitoring_not_running && return 1
    sleep 2
  done
  return 1
}

warn_monitoring_down() {
  monitoring_down=1
  echo "WARNING: local monitoring is DOWN at $MONITORING_UI_URL. Worker traces and logs are not recorded" >&2
  echo "         until it runs again. The studio runs without it. Last lines of its log:" >&2
  docker compose -f "$MONITORING_COMPOSE" logs --tail 10 2>&1 | sed 's/^/         | /' >&2
  echo "         Fix: docker compose -f docker-compose.monitoring.yml up -d --force-recreate" >&2
  echo "         (recreates the container and keeps its data volume)" >&2
}

start_monitoring() {
  if monitoring_answers && monitoring_complete; then
    ok "Local monitoring is already running at $MONITORING_UI_URL (reused)"
    return
  fi
  docker compose -f "$MONITORING_COMPOSE" up -d ||
    fail "docker compose up for the monitoring stack failed (see the output above)"
  if wait_for_monitoring; then
    ok "Local monitoring is up (Grafana, Tempo, Loki, Prometheus, cAdvisor)"
    return
  fi
  echo "..  Local monitoring did not answer: recreating its container once"
  docker compose -f "$MONITORING_COMPOSE" up -d --force-recreate >/dev/null 2>&1 ||
    echo "..  The recreate failed too (docker compose -f docker-compose.monitoring.yml logs)" >&2
  if wait_for_monitoring; then
    ok "Local monitoring is up after a recreate (Grafana, Tempo, Loki, Prometheus, cAdvisor)"
    return
  fi
  warn_monitoring_down
}

# Every process this script starts is stopped on Ctrl-C, on kill, on a closed terminal (HUP) and on
# exit; the worker container too (stop_all ends with compose down).
installed_traps=0
install_traps() {
  [ "$installed_traps" = 1 ] && return
  installed_traps=1
  trap 'stop_all; exit 130' INT
  trap 'stop_all; exit 143' TERM
  trap 'stop_all; exit 129' HUP
  trap 'stop_all' EXIT
}

# Runs before anything starts, so a busy port never leaves containers behind.
check_ports() {
  local port
  for port in 3000 3001; do
    port_in_use "$port" && fail "Port $port is already in use: stop whatever holds it, then retry"
  done
  return 0
}

# A sleeping Mac freezes Docker and every job in it, and the worker in the container cannot run
# caffeinate (Linux): this script keeps the Mac awake for its own life instead (macOS only; it ends
# with the script, Ctrl-C included).
keep_awake() {
  [ "$(uname -s)" = Darwin ] && [ -x /usr/bin/caffeinate ] || return 0
  start_group /usr/bin/caffeinate -i -w $$
}

start_all() {
  keep_awake
  start_monitoring
  # The container exports to local Grafana (compose.yaml reads this; empty turns export off).
  export WORKER_DOCKER_OTLP_ENDPOINT="$MONITORING_OTLP_URL"

  start_group bash -c 'STUDIO_PORT=3001 yarn turbo run dev --filter=./apps/web --filter=./apps/studio'
  start_group bash -c 'docker compose -f "$0" up --no-build --menu=false worker </dev/null 2>&1 | awk "{ print \"worker: \" \$0; fflush() }"' "$WORKER_COMPOSE"

  local ready=0 i pg
  for i in $(seq 1 180); do
    curl -s -o /dev/null --max-time 2 "$STUDIO_URL" && ready=1 && break
    for pg in ${PGIDS[@]+"${PGIDS[@]}"}; do
      kill -0 -- "-$pg" 2>/dev/null || fail "A dev process exited during startup (see the output above)"
    done
    sleep 1
  done
  [ "$ready" = 1 ] || fail "$STUDIO_URL did not answer within 3 minutes"

  local grafana_line="$MONITORING_UI_URL"
  [ "$monitoring_down" = 1 ] &&
    grafana_line="DOWN: $MONITORING_UI_URL does not answer, worker traces and logs are not recorded (see the warning above)"

  cat <<EOF

  Studio:                http://localhost:3000/studio
  Magic link emails:     Mailpit $MAILPIT_URL
  Database:              Supabase Studio $SUPABASE_STUDIO_URL
  Worker errors:         Grafana $MONITORING_UI_URL (Explore, Loki, service edit-issebya-worker-dev, level error)
  Grafana (worker):      $grafana_line
  Worker resources:      $MONITORING_UI_URL/d/worker-resources (CPU, memory, disk, network per step)
  Sign in with the owner email; the link arrives in Mailpit.
  Ctrl-C stops web, studio and the worker container.
  Monitoring keeps running: docker compose -f docker-compose.monitoring.yml down

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
  "") check_ports && run_checks && start_all ;;
  *) fail "unknown argument $1 (use --check or add-owner <email>)" ;;
esac
