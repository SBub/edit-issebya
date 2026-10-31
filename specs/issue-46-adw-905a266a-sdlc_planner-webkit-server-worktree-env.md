# Chore: provide the macOS 14 WebKit server to ADW runs through .adw/worktree-env

## Metadata

issue_number: `46`
adw_id: `905a266a`
issue_json: `{"number":46,"title":"chore: provide the macOS 14 WebKit server to ADW runs through .adw/worktree-env"}`

## Chore Description

On macOS 14 (Darwin 23) Playwright's local WebKit build cannot open a page
(`browserContext.newPage: Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled`),
so the `webkit` project of `apps/web/e2e/dialog_form.spec.ts` fails on every local ADW run. The
known workaround is a `playwright run-server` in `mcr.microsoft.com/playwright:v1.64.0-noble` with
`PW_WEBKIT_WS` pointing at it, but today each test agent improvises it (different containers,
fixed ports such as 3999, forgotten `PW_WEBKIT_WS`, containers that outlive the run).

The toolkit (SBub/adw-toolkit#140, already merged: `adws/PROFILE.md`, "The worktree env hook")
now runs an optional committed executable `.adw/worktree-env`:

- `up` at the start of the build, test, review, document and patch phases, before any agent, cwd =
  the worktree, env = the safe allowlist plus `ADW_ID`, `PORT`, `BACKEND_PORT`, `FRONTEND_PORT`,
  `SERVICES_PORT` (9300 + slot, from `.ports.env`). Its stdout `NAME=value` lines reach every
  `claude` subprocess of the run. It must be idempotent. A non-zero exit, a non-executable file or
  a run longer than `ADW_WORKTREE_ENV_TIMEOUT` (default 300 s) fails the phase with
  `worktree env hook failed: ...` plus the stderr tail.
- `down` when the worktree is reclaimed; idempotent; a failure is only a warning.
- It must never print an engine-owned name (`PORT`, `SERVICES_PORT`, `ADW_*`, ...); a backgrounded
  service never writes to the hook's stdout. Services bind on `SERVICES_PORT`, never a fixed port.

This chore adds that hook for this repository, so the WebKit server is started deterministically
per run on `SERVICES_PORT`, named `pw-webkit-$ADW_ID`, exported as `PW_WEBKIT_WS`, and removed when
the worktree is reclaimed; then it updates the profile and the checkout doc so agents never start,
stop or replace it themselves. `apps/web/playwright.config.ts` already reads `PW_WEBKIT_WS` and
`turbo.json` already passes `PW_*` through to `test:e2e`, so no app code or spec changes.

## Relevant Files

Use these files to resolve the chore:

- `.adw/project.md` - The ADW profile. Install step 3 (WebKit on macOS 14) and the Tests section's
  E2E paragraph must say the server comes from `.adw/worktree-env` and `PW_WEBKIT_WS` is already
  in the environment. Its nine `##` headings must stay unchanged in name and order.
- `app_docs/checkout.md` - Section "Form dialog layout", last bullet, holds the manual
  `run-server` instructions to replace with a pointer to the hook plus the by-hand recipe.
- `docs/conditional-docs.md` - The checkout line should also name the macOS WebKit server, so a
  later agent touching the hook finds `app_docs/checkout.md`.
- `apps/web/playwright.config.ts` - Reads `PW_WEBKIT_WS` into the `webkit` project's
  `connectOptions.wsEndpoint`; read only, must not change.
- `apps/web/e2e/dialog_form.spec.ts` - The only spec the `webkit` project runs; read only.
- `turbo.json` - `test:e2e` and `dev` already list `PW_*` in `passThroughEnv` (lines 81 and 108);
  read only, confirms no change is needed.
- `lefthook.yml` - Pre-commit globs: an extensionless shell file is not matched by lint, typecheck
  or knip, and Prettier runs with `--ignore-unknown`, so the hook file passes the commit hooks.
- `.gitignore` - Confirms `.ports.env`, `agents/` and `adws` stay ignored and `.adw/` is tracked.
- `scripts/vercel-ignore.sh` - The repository's existing shell script; model the style
  (`#!/usr/bin/env bash`, short header comment) on it.
- `adws/PROFILE.md` (symlink into the toolkit, read only) - Section "The worktree env hook", the
  contract the script must follow. Never edit anything under the toolkit.
- `AGENTS.md`, `README.md` - Rules (no em-dashes, no fixed ports, update the profile in the same
  change). `README.md` describes no WebKit detail today and needs no change.

### New Files

- `.adw/worktree-env` - Executable bash script (mode `100755` in git) implementing `up` and
  `down`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the contract

- Read `adws/PROFILE.md`, "The worktree env hook", and `app_docs/checkout.md`, "Form dialog
  layout", end to end before writing anything.

### 2. Create `.adw/worktree-env`

- `#!/usr/bin/env bash` (bash, because the readiness wait and the `case` are simpler in bash; the
  file is run directly, never sourced), `set -u`, a short header comment saying what it is, who
  runs it (the ADW engine, per `adws/PROFILE.md` "The worktree env hook") and that agents never
  call it.
- Constants: `IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble` (must match `@playwright/test`
  `1.64.0` in both apps' `package.json`; say so in a comment), `NAME="pw-webkit-${ADW_ID:-}"`.
- A helper `fail() { printf 'worktree-env: %s\n' "$1" >&2; exit 1; }` so every failure is one
  stderr line. Every `docker` call sends its stdout to `/dev/null` (notably `docker run -d`, which
  prints the container id) so the only stdout line the script ever writes is the final
  `PW_WEBKIT_WS=` line.
- `case "${1:-}"`:
  - `up`:
    1. Platform gate: if `uname -s` is not `Darwin`, exit 0 printing nothing. Take the major
       version from `uname -r` (`${release%%.*}`); if it is 24 or more, exit 0 printing nothing.
       CI (Linux) and macOS 15+ therefore keep using local WebKit exactly as today.
    2. Require `ADW_ID`, `PORT` and `SERVICES_PORT` non-empty, else
       `fail "ADW_ID, PORT and SERVICES_PORT must be set"`.
    3. `docker info >/dev/null 2>&1 || fail "Docker is not running"` (also covers a missing
       `docker` binary: check `command -v docker` first with `fail "docker not found"`).
    4. Idempotency: `state=$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)`. If
       `true`, skip to the readiness wait (step 7) and start nothing. If the container exists but
       is not running (a reboot, a crash), `docker rm -f "$NAME" >/dev/null 2>&1` and continue.
    5. Image: if `docker image inspect "$IMAGE"` fails, `docker pull "$IMAGE" >/dev/null 2>&1 ||
fail "cannot pull $IMAGE"`.
    6. Start, capturing stderr to report it on one line
       (`err=$(docker run ... 2>&1 >/dev/null) || fail "cannot start $NAME: ${err%%$'\n'*}"`):
       `docker run -d --name "$NAME" --init --add-host=host.docker.internal:host-gateway
-p "127.0.0.1:$SERVICES_PORT:$SERVICES_PORT" -e PORT="$PORT" -e SERVICES_PORT="$SERVICES_PORT"
--user pwuser --workdir /home/pwuser "$IMAGE" /bin/sh -c "<forward> & exec npx -y
playwright@1.64.0 run-server --port \$SERVICES_PORT --host 0.0.0.0"`.
       - The forward is a small Node TCP proxy run with `node -e` inside the container (Node ships
         in the image): it listens on `127.0.0.1:$PORT` (and on `::1:$PORT`, ignoring an error
         there when the container has no IPv6 loopback) and pipes each connection to
         `host.docker.internal:$PORT`, destroying both sockets on either side's error. That makes
         `http://localhost:$PORT`, the `baseURL` the specs use, resolve inside the container to
         the run's dev server on the host.
       - `npx` here runs inside the container only (the documented way to start `run-server` in
         the official image); nothing on the host calls `npx`. Add a one-line comment saying so.
       - Publish on `127.0.0.1` only, never `0.0.0.0` on the host. No fixed port anywhere: both
         ports come from the environment.
    7. Readiness wait: poll once per second for up to 240 seconds (inside the engine's 300 s hook
       budget; the first `npx` download dominates). Each iteration: if
       `docker inspect -f '{{.State.Running}}' "$NAME"` is not `true`, take the last log line
       (`docker logs --tail 1 "$NAME" 2>&1`) and `fail "$NAME exited: <that line>"`; if
       `docker logs "$NAME" 2>&1 | grep -q 'Listening on'` and
       `curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SERVICES_PORT/"` returns a code
       other than `000` (Docker Desktop's port proxy accepts a TCP connection before the backend
       listens, so a bare TCP check is not proof), break. On timeout,
       `fail "$NAME did not listen on 127.0.0.1:$SERVICES_PORT within 240s"`.
    8. Print exactly `PW_WEBKIT_WS=ws://127.0.0.1:$SERVICES_PORT/` and exit 0. A second `up` with
       the container running goes 4 -> 7 -> 8 and prints the same line.
  - `down`: if `ADW_ID` is empty or `docker` is missing, exit 0; else
    `docker rm -f "$NAME" >/dev/null 2>&1 || true`; exit 0. Not platform gated (harmless
    everywhere, and it cleans a container left from a run on macOS 14).
  - anything else: `printf 'usage: .adw/worktree-env up|down\n' >&2; exit 2`.
- Never print an environment value other than the endpoint; never print a secret; never read
  `.env*` files.
- No em-dashes in the file.
- `chmod +x .adw/worktree-env`, and make sure git records the mode: after `git add`,
  `git ls-files -s .adw/worktree-env` must start with `100755` (if not,
  `git update-index --chmod=+x .adw/worktree-env`).

### 3. Update `.adw/project.md`

- Install step 3: keep the `playwright install chromium webkit` command; replace the last
  sentence with: on macOS 14 (Darwin below 24) the local WebKit build cannot open a page, so the
  WebKit server (`playwright run-server` in `mcr.microsoft.com/playwright:v1.64.0-noble`, container
  `pw-webkit-<adw_id>` on the run's `SERVICES_PORT`) is provided by `.adw/worktree-env`, which the
  engine runs with `up` before each phase and `down` when the worktree is reclaimed. Agents never
  start, stop, replace or probe that container, and never pick a port for it. Elsewhere (CI's
  Linux, macOS 15+) the hook prints nothing and local WebKit is used.
- Tests, E2E paragraph: after the sentence about `turbo passes ... PW_* ...`, add that on macOS 14
  `PW_WEBKIT_WS` is already in the environment (set by `.adw/worktree-env`) and is passed through
  as is; never set, unset or override it. On other machines it is absent.
- Ports: add one bullet that `SERVICES_PORT` in `.ports.env` (9300 + slot) belongs to this run's
  WebKit server from `.adw/worktree-env`; the same never-write rule as the other `.ports.env`
  values applies.
- Do not rename, add or reorder any `##` heading (still exactly: Identity, Workspaces, Install,
  Build, Tests, Ports, Protected, Documentation, Review).

### 4. Update `app_docs/checkout.md`, "Form dialog layout"

- Replace the last bullet ("Locally on macOS 14 ...") with:
  - On macOS 14 Playwright's own WebKit build is frozen and fails to open a page. In ADW runs
    `.adw/worktree-env` (run by the engine) starts `playwright run-server` in
    `mcr.microsoft.com/playwright:v1.64.0-noble` as `pw-webkit-<adw_id>` on the run's
    `SERVICES_PORT`, forwards the container's `localhost:$PORT` to the host's dev server, and
    exports `PW_WEBKIT_WS`, which `apps/web/playwright.config.ts` reads. Rule: agents never start,
    stop or replace that container, and no port for it is ever fixed.
  - By hand, outside ADW, with the dev server running on `$PORT`:
    `export PW_WEBKIT_WS="$(ADW_ID=local PORT=<dev port> SERVICES_PORT=<free port> .adw/worktree-env up | sed -n 's/^PW_WEBKIT_WS=//p')"`,
    then `yarn workspace @edit-issebya/web test:e2e --project=webkit`, then
    `ADW_ID=local .adw/worktree-env down`. (Write the commands as a fenced block or inline code;
    no literal port numbers.)
  - Keep the image tag in step with `@playwright/test` in both apps' `package.json`; a Playwright
    bump changes the tag in `.adw/worktree-env` in the same commit.

### 5. Update `docs/conditional-docs.md`

- Extend the `app_docs/checkout.md` line: "... or the E2E Stripe mock, or the macOS 14 WebKit
  server (`.adw/worktree-env`)." Keep it one line.

### 6. Check the invariants

- `grep -rn 3999 .adw app_docs apps/web --exclude-dir=node_modules` prints nothing.
- `grep -rn "—" .adw app_docs docs specs/issue-46-*` prints nothing (no em-dashes).
- `bash -n .adw/worktree-env` exits 0.
- `git diff --stat` touches only `.adw/worktree-env`, `.adw/project.md`, `app_docs/checkout.md`,
  `docs/conditional-docs.md` and this plan; nothing under `apps/` or the toolkit.

### 7. Manual verification on this Mac (macOS 14, Darwin 23)

- Take ports from this worktree's `.ports.env` (`set -a; . ./.ports.env; set +a`): `PORT` and
  `SERVICES_PORT` are this run's, so they are free for it. Never kill anything this run did not
  start.
- `ADW_ID=probe .adw/worktree-env up` (with `PORT`, `SERVICES_PORT` exported) prints exactly one
  `PW_WEBKIT_WS=ws://127.0.0.1:<SERVICES_PORT>/` line; run it again: same single line, and
  `docker ps --filter name=pw-webkit-probe --format '{{.Names}}'` shows one container.
- Start the web dev server with the Workspaces dev command, export `PW_WEBKIT_WS` from the line,
  run `yarn workspace @edit-issebya/web test:e2e --project=webkit`: passes. Stop the dev server
  this step started.
- `ADW_ID=probe .adw/worktree-env down` removes it; a second `down` exits 0.
- With Docker Desktop stopped (only if the owner agrees; otherwise simulate with
  `DOCKER_HOST=unix:///nonexistent`), `up` exits non-zero with one stderr line
  (`worktree-env: Docker is not running`) and nothing on stdout.
- `env -u PORT ADW_ID=probe .adw/worktree-env up` exits 1 with the one-line "must be set" reason.

### 8. Run the Validation Commands

## Test Coverage

No test needed: the change is a shell hook run by the ADW engine plus documentation. The repository
has no shell-test layer, and the Vitest unit layer (`apps/*/src/**/*.test.ts`) covers app helpers
only; inventing a layer is out of scope. The hook's behaviour is proven by the manual checks in
step 7 and by this run's own test phase: on macOS 14 the existing `webkit` project of
`apps/web/e2e/dialog_form.spec.ts` (which fails today without `PW_WEBKIT_WS`) must pass with no
agent starting a container, and `agents/905a266a/worktree_env.json` must list `PW_WEBKIT_WS`. In
CI (Linux) the hook is not run and WebKit runs natively, unchanged. No E2E spec is added: no
user-visible flow changes.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `bash -n .adw/worktree-env` - the hook parses.
- `test -x .adw/worktree-env && git ls-files -s .adw/worktree-env` - executable on disk and
  committed as `100755` (after staging).
- `grep -rn 3999 .adw app_docs apps/web --exclude-dir=node_modules; test $? -eq 1` - no fixed port.
- `yarn format:check` - Prettier over the whole repository (the edited Markdown).
- `yarn lint` - root-only change, unfiltered lint stays green.
- `yarn typecheck` - unfiltered typecheck stays green.
- `yarn knip` - dead-code check over the whole repository.
- `yarn test` - unit tests, unfiltered, unchanged.
- `yarn build` - unfiltered build for a root-only change.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - the E2E suites, including the `webkit`
  project of the dialog spec through `PW_WEBKIT_WS` from the hook (run by the test phase against
  the `/prepare_app` server; never with `CI=1`).

## Notes

- `/classify_app` should answer `{"target_apps": []}`: every change is a root file (`.adw/`,
  `app_docs/`, `docs/`, `specs/`), so validation uses the unfiltered root scripts.
- The hook depends on the engine from SBub/adw-toolkit#140, which is present in the toolkit
  checkout (`adws/PROFILE.md` documents it). Nothing under `adws/` or `.claude/` changes.
- `PW_WEBKIT_WS` is not an engine-owned name, so the engine accepts the line. `PORT` and
  `SERVICES_PORT` are engine-owned and must never be printed.
- The dev server's `next dev` listens on all interfaces, so `host.docker.internal:$PORT` (Docker
  Desktop's host gateway; `--add-host=...:host-gateway` makes it work on other engines too) reaches
  it. The dialog spec only loads the landing page, so the studio port needs no forward.
- Docker Desktop's port proxy can accept a connection before `run-server` listens; that is why
  readiness waits for the `Listening on` log line and a real HTTP response, not a bare TCP connect.
- The first `up` on a machine pulls the image and lets `npx` fetch `playwright@1.64.0` inside the
  container; later `up`s reuse the running container in a second or two.
- No em-dashes anywhere; no `Co-Authored-By` or other trailers in commits.
