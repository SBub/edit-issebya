# Chore: ADW runs get their own local Supabase stack (edit-issebya-adw), reset to the worktree's migrations through .adw/worktree-env

## Metadata

issue_number: `62`
adw_id: `518dc931`
issue_json: `{"number":62,"title":"chore: ADW runs get their own local Supabase stack (edit-issebya-adw), reset to the worktree's migrations through .adw/worktree-env"}`

## Chore Description

Every ADW run applies its branch's migrations to the developer's own local Supabase stack
(`edit-issebya`, ports 54430 to 54439) with `supabase migration up --local`, and nothing ever takes
them off. A failed or unmerged branch leaves its schema behind, the next run's `migration up`
refuses ("Remote migration versions not found in local migrations directory"), and the profile
forbids a reset, so the run cannot recover (run `67f9b648` died this way). The shared stack also
carries data between runs (leftover claimable `process` jobs broke `db-tests/jobs.test.ts`).
Migration versions were also hand-picked and future-dated (`YYYYMMDD090000`), and #36 and #37
reused the same version.

The fix:

- **A.** A second stack owned by ADW: project id `edit-issebya-adw`, ports 54450 to 54459 mapped one
  to one from the dev stack (shadow 54450, API 54451, db 54452, studio 54453, inbucket 54454,
  analytics 54457, pooler 54459). Its working directory is generated and gitignored under the
  main checkout: `agents/supabase-adw/`. The committed `supabase/config.toml` is not changed.
- **B.** A new committed, executable bash script `.adw/supabase-stack`, the only code that touches
  that stack: `up` (lock, ownership, sync, start, reset when needed, verify, print five variables),
  `reset` (same with a forced reset, nothing on stdout), and `release` (used by the hook's `down`).
- **C.** `.adw/worktree-env up` calls `.adw/supabase-stack up` on every platform and prints its
  lines; the WebKit part keeps its own Darwin-below-24 condition. `down` releases ownership.
- **D.** `turbo.json` passes `NEXT_PUBLIC_SUPABASE_*` through `dev` and `start`, and
  `SUPABASE_DB_URL` through `test:db`, `test:e2e` and `@edit-issebya/studio#test:e2e`. The
  hard-coded `LOCAL_DB_URL` becomes `localDbUrl(env = process.env)`.
- **E.** Rules and docs: `.adw/project.md` (nine headings unchanged), `AGENTS.md`, `README.md`,
  `app_docs/studio.md`, new `app_docs/adw-supabase-stack.md`, `docs/conditional-docs.md`. New
  rule: a migration is created with `supabase migration new <name>` (current UTC time), never a
  hand-picked, copied, future-dated or reused version.

Workspace: root tooling (`.adw/`, `turbo.json`, docs) plus `apps/studio` (test-support and
db-tests). Target for filtered commands: `--filter=./apps/studio`.

## Relevant Files

Use these files to resolve the chore:

- `README.md` - "Run the studio locally" section (lines 31-40): add one sentence that ADW runs use
  their own stack; keep the developer's commands unchanged.
- `AGENTS.md` - Tooling section: add the one-line migration-version rule.
- `.adw/project.md` - ADW profile: Identity `database:` line (28-29), Install step 3 (86-95),
  Workspaces bullet about the studio reading the shared stack (62-65), Tests (159-162), Ports
  (184-185), Protected (200-208). Nine `##` headings stay as they are, in order.
- `.adw/worktree-env` - The engine's hook. `up` exits 0 early on non-Darwin and Darwin 24+
  (lines 35-38); restructure so only the WebKit part is conditional, and call the new script
  first. `down` must also release ownership. WebKit container name, image, port and output line
  stay identical.
- `turbo.json` - Strict env mode: `dev` (47-60) and `start` (61-79) lack `NEXT_PUBLIC_SUPABASE_*`;
  `test:db` (121-125), `test:e2e` (80-120) and `@edit-issebya/studio#test:e2e` (126-151) lack
  `SUPABASE_DB_URL`.
- `apps/studio/test-support/local-supabase.ts` - `LOCAL_DB_URL` constant (line 10) becomes
  `localDbUrl(env)`.
- `apps/studio/test-support/local-supabase.test.ts` - Unit tests for the helpers; extend for
  `localDbUrl`.
- `apps/studio/db-tests/rls.test.ts` (imports at 10-14, use at 18) and
  `apps/studio/db-tests/steps-measurements.test.ts` (import at 10, use at 40) - the two users of
  `LOCAL_DB_URL`.
- `apps/studio/vitest.db.config.ts` - `process.loadEnvFile` never overrides a set variable, so the
  hook's values win; no change, read for context.
- `supabase/config.toml` - Source of the mirrored config. Not edited. Contains 5443x on lines
  10, 29, 31, 41, 87, 98, 100 (commented `smtp_port`), 101 (commented `pop3_port`) and 376;
  `content_path = "./supabase/templates/magic-link.html"` is workdir-relative, so the mirror must
  include `templates/`. `[db.seed]` points at a missing `./seed.sql` (harmless warning on reset).
- `supabase/migrations/` - The worktree's migrations the ADW stack is reset to.
- `.github/workflows/ci.yml` - Reference only (lines 48-69): the `-x` service list and the
  allow-listed export (never `STUDIO_URL`). Not changed.
- `.gitignore` - `agents/` is already ignored (line 25); nothing to add.
- `app_docs/studio.md` - "How to Use" step 1 (lines 130-131), Testing and Configuration sections.
- `app_docs/checkout.md` - Documents the WebKit part of `.adw/worktree-env` (lines 171-186); read
  to make sure the WebKit behaviour and its manual commands stay valid.
- `docs/conditional-docs.md` - Index; add one line for the new doc.
- `knip.json` - `apps/studio` project includes `test-support/**/*.ts`; the removed export and the
  new one must leave knip clean.

### New Files

- `.adw/supabase-stack` - Executable bash script (`chmod +x`, committed with mode 100755), the
  only code that touches the ADW stack.
- `app_docs/adw-supabase-stack.md` - Feature doc for the ADW stack, with a Rules section.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Record the developer's stack before touching anything (verification step 2)

- `supabase migration list --local > /tmp/dev-before.txt` (read only, from the main checkout or
  this worktree; the worktree's config is the dev stack's).
- `docker inspect -f '{{.State.StartedAt}}' supabase_db_edit-issebya > /tmp/dev-started.txt`.
- These are the only `supabase` commands in this run without `--workdir agents/supabase-adw`, and
  both are read only.

### 2. Replace `LOCAL_DB_URL` with `localDbUrl(env)` in `apps/studio/test-support/local-supabase.ts`

- Move the `Env` type above the new function (it is declared after `assertLocalUrl` today).
- Add:
  ```ts
  // The local stack's database. SUPABASE_DB_URL when set (an ADW run's own
  // stack, from .adw/worktree-env), else the shared stack's default
  // credentials of `supabase start` (supabase/config.toml, db port 54432, the
  // developer's and CI's). Local by construction or by assertLocalUrl.
  export function localDbUrl(env: Env = process.env): string {
    return env.SUPABASE_DB_URL
      ? assertLocalUrl(env.SUPABASE_DB_URL)
      : "postgresql://postgres:postgres@127.0.0.1:54432/postgres";
  }
  ```
  (keep the default as a module-level non-exported constant if that reads better; remove the
  exported `LOCAL_DB_URL`). `assertLocalUrl` parses `postgresql://...@127.0.0.1:54452/postgres`
  correctly (WHATWG URL gives hostname `127.0.0.1` for non-special schemes with an authority).
- `apps/studio/db-tests/rls.test.ts`: import `localDbUrl` instead of `LOCAL_DB_URL`; line 18 uses
  `new pg.Client({ connectionString: localDbUrl() })`.
- `apps/studio/db-tests/steps-measurements.test.ts`: same at lines 10 and 40.

### 3. Extend `apps/studio/test-support/local-supabase.test.ts`

- New `describe("localDbUrl")`:
  - returns the 54432 default when `SUPABASE_DB_URL` is absent (`localDbUrl({})`).
  - returns `SUPABASE_DB_URL` when it is local
    (`postgresql://postgres:postgres@127.0.0.1:54452/postgres`, and the `localhost` form).
  - refuses a non-local `SUPABASE_DB_URL` (`postgresql://postgres:x@db.abc.supabase.co:5432/postgres`)
    with `/Refusing non-local Supabase URL/`.

### 4. `turbo.json` env wiring

- Add `"NEXT_PUBLIC_SUPABASE_*"` to `dev.passThroughEnv` and `start.passThroughEnv`.
- Add `"SUPABASE_DB_URL"` to `test:db.passThroughEnv`, `test:e2e.passThroughEnv` and
  `@edit-issebya/studio#test:e2e.passThroughEnv` (next to `SUPABASE_SECRET_KEY`).
- Nothing else changes; `build` already hashes `NEXT_PUBLIC_*`.

### 5. Create `.adw/supabase-stack` (executable bash, `set -u`, `shellcheck` clean)

Header comment: what it is, that it is the only code touching the ADW stack, that it is called by
`.adw/worktree-env` (`up`, `release`) and by agents (`reset` only), and that it never stops the
stack, never touches the dev stack, never uses `--linked` or `db push`.

Structure:

- **Constants:** `PROJECT_ID=edit-issebya-adw`; port map `54430:54450 54431:54451 54432:54452
54433:54453 54434:54454 54437:54457 54439:54459`; the `-x` list
  `storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor`.
- **Paths:** `WORKTREE` = parent of the script's directory (`cd "$(dirname "$0")/.." && pwd -P`).
  `MAIN` = `$ADW_PROJECT_ROOT` when set and a directory, else the parent of
  `git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir`. `STACK=$MAIN/agents/supabase-adw`,
  `LOCK=$MAIN/agents/supabase-adw.lock`, `LOG=$STACK/stack.log`. `mkdir -p "$STACK"`.
- **Output discipline:** every `supabase`, `rsync` and `docker` call appends stdout and stderr to
  `$LOG` (`>>"$LOG" 2>&1`), prefixed by a `log` line (`date -u` + the command, never a value).
  `fail()` prints `supabase-stack: <msg>` to stderr and exits 1. Only `up`'s final block writes to
  stdout.
- **Required env:** `ADW_ID` must be set for `up`, `reset` and `release` (fail otherwise);
  `command -v supabase docker rsync` and `docker info` checked (fail with a clear message).
- **Lock** (`take_lock`): loop up to 120 s: `mkdir "$LOCK"` succeeds, then write `$$` to
  `$LOCK/pid` and `trap 'rm -rf "$LOCK"' EXIT`; else read `$LOCK/pid`, and if it is empty or
  `kill -0` fails, remove the stale lock and retry at once; else `sleep 1`. Fail after 120 s with
  `ADW Supabase stack lock held by pid <pid>`.
- **Ownership** (`claim`): `owner="$(cat "$STACK/owner" 2>/dev/null)"`. If `owner` is non-empty and
  differs from `ADW_ID`, test for a live phase of that run:
  `ps -axo command= | grep -E 'adw_[a-z_]*_iso\.py' | grep -qw -- "$owner"` (same test as
  `queue_ops.ADW_PHASE_RE`: phase script plus the ID as a whole word). If live, fail with exactly
  `ADW Supabase stack is in use by run <owner>`. Otherwise remember `owner_changed=1` and write
  `ADW_ID` to `$STACK/owner`.
- **Sync** (`sync`): `mkdir -p "$STACK/supabase"`;
  `rsync -a --delete --exclude .temp/ --exclude .branches/ "$WORKTREE/supabase/" "$STACK/supabase/"`
  (excluded paths are also protected from `--delete`, so the CLI's own `.temp/` in the workdir
  survives). Then rewrite the copied `config.toml` in place (portable: write to a temp file with
  `sed` and `mv`, no `sed -i` GNU/BSD difference): `project_id = "edit-issebya"` becomes
  `project_id = "edit-issebya-adw"`, and each mapped port `5443N` becomes `5445N`. Because the
  committed config also has the commented examples `# smtp_port = 54435` and `# pop3_port = 54436`,
  map them too (`54435` to `54455`, `54436` to `54456`; inert comments) so that the "no 5443 left"
  check below can be strict; say so in a comment.
- **Refusal** (`check_config`, before any `supabase` command): fail with
  `refusing: the ADW config copy still targets the developer's stack` unless
  `grep -q '^project_id = "edit-issebya-adw"$'`, the `[api]` port is 54451 and the `[db]` port is
  54452 (check with `awk` over sections: `/^\[api\]/`, `/^\[db\]/` then the first `^port = `), and
  `! grep -q 5443` over the whole copy.
- **Fingerprint:** `sha256` helper using `shasum -a 256` when present, else `sha256sum`. Fingerprint
  = sha256 of (sorted file list of `$STACK/supabase/migrations/` with each file's hash) plus the
  hash of the copied `config.toml`. Compare with `$STACK/applied.sha256`.
- **Start:** `supabase status --workdir "$STACK" >>"$LOG" 2>&1` fails, so run
  `supabase start --workdir "$STACK" -x <list> >>"$LOG" 2>&1` (fail with a pointer to `$LOG`), and
  set `started=1`.
- **Reset** when `force`, `owner_changed`, `started` or the fingerprint differs:
  `supabase db reset --local --workdir "$STACK" >>"$LOG" 2>&1` (fail on error). Then verify:
  expected = `ls "$STACK/supabase/migrations" | grep -E '^[0-9]+_.*\.sql$' | cut -d_ -f1 | sort`;
  applied = the database column of `supabase migration list --local --workdir "$STACK"` (parse the
  table: rows with `|`, take the second field trimmed; also collect local-only rows, where the
  second field is empty). Fail naming `missing: <versions>` / `extra: <versions>` unless the two
  sets are equal and no local row is unapplied. Only then write the fingerprint to
  `$STACK/applied.sha256`. A run with nothing changed does none of this and the log has no
  `db reset` line.
- **Print (up only):** `env_out="$(supabase status -o env --workdir "$STACK" 2>>"$LOG")"`, then
  pick `API_URL`, `SECRET_KEY`, `PUBLISHABLE_KEY` and `DB_URL` by exact name with
  `sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p'` (values may be quoted), fail if any is empty,
  and print exactly:
  `SUPABASE_URL=<API_URL>`, `SUPABASE_SECRET_KEY=<SECRET_KEY>`, `NEXT_PUBLIC_SUPABASE_URL=<API_URL>`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY>`, `SUPABASE_DB_URL=<DB_URL>`.
  Never `STUDIO_URL`, never any other line. No value is ever written to the log.
- **Commands:**
  - `up`: lock, claim, sync, check, start if needed, reset if needed, print.
  - `reset`: lock, claim, sync, check, start if needed, forced reset, print nothing.
  - `release`: lock; remove `$STACK/owner` only if its content equals `ADW_ID`; no `supabase`
    command.
  - anything else: usage to stderr, exit 2.
- `chmod +x .adw/supabase-stack` and make sure git records mode 100755
  (`git update-index --chmod=+x` if needed).

### 6. Restructure `.adw/worktree-env`

- Update the header comment: `up` provides this run's ADW Supabase stack (through
  `.adw/supabase-stack up`, every platform) and, on macOS 14, the WebKit server; `down` releases
  the stack's ownership and removes the WebKit container; it never stops the stack.
- `up`:
  1. `[ -n "${ADW_ID:-}" ] || fail "ADW_ID must be set"`.
  2. `stack_env="$("$(dirname "$0")/supabase-stack" up)" || fail "ADW Supabase stack: see agents/supabase-adw/stack.log"`
     (the script's own stderr message, for example the ownership one, already reaches stderr).
     `printf '%s\n' "$stack_env"`.
  3. Wrap the existing WebKit block in a function or an `if`: only when `uname -s` is Darwin and
     the major release is below 24; otherwise skip it (no early `exit 0` before the stack). Its
     `ADW_ID`/`PORT`/`SERVICES_PORT` check, container, image, port, readiness loop and
     `PW_WEBKIT_WS=ws://127.0.0.1:<port>/` line stay byte for byte the same.
- `down`: keep `[ -n "${ADW_ID:-}" ] || exit 0`; run `"$(dirname "$0")/supabase-stack" release || true`
  (never fails `down`); then the docker removal as today.
- `shellcheck .adw/worktree-env .adw/supabase-stack` clean.

### 7. Run the stack verification by hand (issue verification steps 3 to 8)

All from this worktree, all with `--workdir agents/supabase-adw` relative to the main checkout
(use the absolute `$MAIN/agents/supabase-adw`). Check names, never values (`cut -d= -f1`).

- Step 3: `time ADW_ID=probe1 PORT=<free> SERVICES_PORT=<free> .adw/worktree-env up | cut -d= -f1`
  prints exactly the five names (plus `PW_WEBKIT_WS` on this macOS 14 Mac) and never `STUDIO_URL`.
  `docker ps --format '{{.Names}} {{.Ports}}' | grep supabase_db_edit-issebya-adw` shows 54452.
  Record the elapsed time for the PR and the doc (if over 240 s, say so and name
  `ADW_WORKTREE_ENV_TIMEOUT`). Afterwards `ADW_ID=probe1 .adw/worktree-env down` to remove the
  probe's WebKit container.
- Step 4: `supabase migration list --local --workdir <main>/agents/supabase-adw` equals
  `ls supabase/migrations` versions, all applied.
- Step 5: `supabase migration new probe` (creates `supabase/migrations/<now>_probe.sql`; put
  `select 1;` in it), `up` again: listed and applied. Delete the file, `up` again: gone. `git status`
  shows no probe file.
- Step 6: insert a row (for example via `psql "$SUPABASE_DB_URL"` from the printed variables
  exported in a subshell: `create table public.probe_keep(id int); insert ...` is NOT allowed to
  stay; prefer inserting into an existing table with the secret-key admin client, or a temp schema
  row, then remove it after the check), run `up` again: same five names, `stack.log` has no new
  `db reset` line, the row is still there.
- Step 7: `bash -c 'exec -a "uv run adws/adw_test_iso.py 1 probe1" sleep 60' &`, then
  `ADW_ID=probe2 ... .adw/worktree-env up` exits 1 with `ADW Supabase stack is in use by run probe1`.
  Kill only that `sleep` (this run started it); `probe2`'s `up` then succeeds and the log shows a
  reset. Release with `ADW_ID=probe2 .adw/worktree-env down`.
- Step 8 (negative): temporarily make the port rewrite a no-op in `.adw/supabase-stack`, run `up`:
  exits 1 at the refusal, and `stack.log` gains no `supabase` command line. Revert the script
  (`git diff .adw/supabase-stack` shows only the intended content).

### 8. Rules and docs: `.adw/project.md` (nine `##` headings unchanged, in order)

- Identity `database:` line: two local stacks. The developer's (`supabase/config.toml`, project
  `edit-issebya`, 54430 to 54439), the owner's, started and kept by them, never touched by ADW. ADW's
  (`edit-issebya-adw`, 54450 to 54459, workdir `agents/supabase-adw/` in the main checkout),
  provided by `.adw/worktree-env` through `.adw/supabase-stack`, reset to the worktree's
  migrations at the start of a run. Migrations in `supabase/migrations/`.
- Workspaces bullet (62-65): in a run the studio reads the ADW stack through the hook's
  `NEXT_PUBLIC_SUPABASE_*`, which override `apps/studio/.env.development`.
- Install: extend step 3 (or add a step 4 before "Verify", renumbering) saying the hook also
  provides the ADW stack on every platform and five variables (`SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_DB_URL`) that override the copied `.env.development` values; agents never set, unset or
  override them, and never start or stop that stack.
- Tests: `test:db` and the studio specs run against the ADW stack through those variables (no
  longer "the shared local stack" the owner keeps up). Replace "a slice that adds a migration runs
  `supabase migration up --local` before its local E2E" with "after adding or editing a migration
  in the run, run `.adw/supabase-stack reset` before `test:db` and E2E". Also the DB line
  "(after unit; needs the shared local stack)" becomes "needs the ADW stack from the hook".
- Ports: keep the 54430 to 54439 bullet (the developer's stack, never moved, never touched by ADW);
  add "54450 to 54459 belong to the ADW stack (`edit-issebya-adw`: API 54451, DB 54452), fixed,
  never moved".
- Protected: replace the "exactly one database command" bullet and the "one shared local stack"
  bullet with:
  - ADW never runs a `supabase` command against the developer's stack. Any `supabase` command run
    in a worktree without `--workdir` reaches it (the worktree's `config.toml` is the dev stack's),
    so agents run no `supabase` command except `supabase migration new <name>` and
    `.adw/supabase-stack reset`. Never `supabase db reset`, `start`, `stop`, `migration up`, a
    seed, `--linked` or `db push` by hand. Never reset the developer's stack.
  - The ADW stack may be reset freely, and only through `.adw/supabase-stack`. No test points at
    the hosted project (the helpers refuse any host but `127.0.0.1` and `localhost`).
  - A new migration is created with `supabase migration new <name>`, which stamps the current UTC
    time. Never hand-pick, copy or future-date a version, never reuse one, never edit an applied
    migration.
- `grep -n "migration up --local" .adw/project.md` must print nothing afterwards.

### 9. `AGENTS.md`, `README.md`, `app_docs/studio.md`

- `AGENTS.md`, Tooling: one bullet: "Create a migration with `supabase migration new <name>` (it
  stamps the current UTC time). Never hand-pick, copy, future-date or reuse a migration version,
  and never edit an applied migration."
- `README.md`, "Run the studio locally": commands unchanged; add one sentence after the block: ADW
  runs use their own local stack (`edit-issebya-adw`, ports 54450 to 54459, see
  `app_docs/adw-supabase-stack.md`), which the developer does not need to start or stop. No feature
  description beyond that.
- `app_docs/studio.md`: "How to Use" step 1 stays the developer's command plus the same one
  sentence; in Testing, "Needs the local stack" adds "(in ADW runs, the ADW stack through
  `SUPABASE_DB_URL` and the other hook variables)"; in Configuration, mention `SUPABASE_DB_URL`
  (test helpers only, defaults to the 54432 database).

### 10. New `app_docs/adw-supabase-stack.md` and the index line

- Sections modelled on the other feature docs (Overview, What it does, How to Use, Configuration,
  Rules, Notes):
  - Why: the dev stack collected foreign migrations and data from failed runs (run `67f9b648`).
  - What `.adw/supabase-stack` does: `up`/`reset`/`release`, lock, ownership (live-phase test),
    sync and rewrite, the refusal, start with the CI `-x` list, reset rule (owner changed, just
    started, fingerprint changed, or `reset`), verification of the migration list, the five
    variables, never `STUDIO_URL`, log at `agents/supabase-adw/stack.log`.
  - Ports table (dev vs ADW). Fixed ports are a deliberate exception to the toolkit's
    "bind on `SERVICES_PORT`" rule: one stack, runs serialised by the queue, guarded by ownership.
  - Hook timing: the measured cold `up` time, and that `ADW_WORKTREE_ENV_TIMEOUT` (default 300 s)
    is the owner's knob if it gets close.
  - Inspect: `supabase status --workdir agents/supabase-adw` and
    `supabase migration list --local --workdir agents/supabase-adw` from the main checkout. Free
    the disk by hand: `supabase stop --workdir agents/supabase-adw --no-backup`.
  - Rules: never run a `supabase` command against the developer's stack in a run; never start,
    stop or reset the ADW stack except through `.adw/supabase-stack`; never stop it automatically;
    never print or log a secret value; never put `STUDIO_URL` in the environment; never edit the
    committed `supabase/config.toml` for the ADW stack; never move 54450 to 54459; never
    hand-pick, copy, future-date or reuse a migration version.
- `docs/conditional-docs.md`: one line: read `app_docs/adw-supabase-stack.md` when changing
  `.adw/supabase-stack`, the Supabase part of `.adw/worktree-env`, the ADW stack's ports or reset
  rule, `SUPABASE_DB_URL`, or how runs apply migrations.
- Also extend the existing checkout.md index line? No: its WebKit wording stays correct.

### 11. DB and app wiring checks against the ADW stack (verification step 9)

- In a subshell with the five variables exported from a fresh `ADW_ID=probe3 .adw/worktree-env up`
  (never echo them): `yarn turbo run test:db --filter=./apps/studio` passes. Then with
  `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:<stopped port>/postgres` it fails
  (proves the variable is read). Release with `ADW_ID=probe3 .adw/worktree-env down`.
- Start the Workspaces dev command on this run's `PORT` with those variables exported and check the
  studio answers at `http://localhost:$PORT/studio` signed out, and that
  `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url` prints a URL naming 54451 (only
  check the host and port, the URL holds a token). Stop only the server this step started.

### 12. Developer's stack untouched and final grep checks (verification steps 10 and 11)

- `supabase migration list --local | diff /tmp/dev-before.txt -` prints nothing, and
  `docker inspect -f '{{.State.StartedAt}}' supabase_db_edit-issebya` equals `/tmp/dev-started.txt`.
- `grep -n "migration up --local" .adw/project.md` prints nothing;
  `grep -n "supabase migration new" .adw/project.md AGENTS.md` prints the rule in both.
- `grep -rn "LOCAL_DB_URL" apps` prints nothing. `git status` shows no probe migration and nothing
  under `agents/`.
- `grep -rn "—" .adw/supabase-stack .adw/worktree-env app_docs/adw-supabase-stack.md` prints
  nothing (no em-dashes).

### 13. Run the Validation Commands

## Test Coverage

- Unit (`apps/studio/test-support/local-supabase.test.ts`, Vitest, `yarn test`): `localDbUrl`
  returns the 54432 default with no `SUPABASE_DB_URL`, returns a local `SUPABASE_DB_URL`
  (127.0.0.1 and localhost on 54452), and refuses a hosted one. Fails without this change (the
  function does not exist) and catches a DB test silently reaching the developer's 54432 database,
  or a hosted database, when the hook points it elsewhere.
- DB integration (`yarn turbo run test:db --filter=./apps/studio`): no new test; the existing
  `rls.test.ts` and `steps-measurements.test.ts` now connect through `localDbUrl()`, proven in
  task 11 by passing against 54452 and failing against a stopped port.
- No automated test for `.adw/supabase-stack` and the hook: the profile has no layer for shell
  scripts (CI never runs the hook), and the behaviour needs Docker and a real Supabase stack. They
  are covered by `shellcheck` and the scripted manual checks in tasks 7, 11 and 12 (verification
  steps 3 to 11), plus step 12 in the run's own later phases (`agents/518dc931/worktree_env.json`
  lists the five names after the test phase).
- No E2E spec: nothing user-visible changes (no rendered page, copy or flow); the studio specs
  simply run against a different local stack. No `e2e/*.md` journey.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `shellcheck .adw/worktree-env .adw/supabase-stack` - both scripts lint clean.
- `test -x .adw/supabase-stack && git ls-files -s .adw/supabase-stack | grep -q '^100755'` - the
  new script is executable and committed as such.
- `yarn format:check` - Prettier over the whole repository (docs, `turbo.json`, TS).
- `yarn turbo run lint --filter=./apps/studio` - ESLint for the changed studio test helpers.
- `yarn turbo run typecheck --filter=./apps/studio` - the removed `LOCAL_DB_URL` export has no
  stale importer.
- `yarn knip` - no unused or dangling export after the rename (whole repository).
- `yarn turbo run test --filter=./apps/studio` - the new `localDbUrl` unit tests.
- `yarn test` - the full unit layer the pre-push hook runs.
- `yarn turbo run test:db --filter=./apps/studio` - with the ADW stack's variables exported (task
  11), the DB layer passes on the ADW stack.
- `yarn build` - root-only and studio changes; the unfiltered build stays green with
  `turbo.json`'s changed pass-through lists.
- `grep -n "migration up --local" .adw/project.md; test $? -eq 1` - the old rule is gone.
- `grep -n "supabase migration new" .adw/project.md AGENTS.md` - the new rule is in both.
- `supabase migration list --local | diff /tmp/dev-before.txt -` - the developer's stack is
  unchanged (read only).

## Notes

- The ADW stack's `config.toml` keeps `site_url = "http://localhost:3000"` and
  `additional_redirect_urls`; they are not ports and need no rewrite. The magic-link template's
  `content_path` is relative to the workdir, which is why `templates/` is mirrored.
- `[db.seed]` points at a missing `seed.sql`; `db reset` only warns. Do not add `--no-seed`, so
  behaviour matches CI's `supabase start` if a seed is ever added.
- `supabase migration list --local` labels the database column "Remote"; parse that column as
  "applied".
- `ps -axo command=` works on both macOS and Linux procps. The ownership test only looks at a
  different ADW ID, so the current run's own engine process never blocks it.
- Never run `supabase stop` on either stack in this run; the ADW stack stays up afterwards by
  design (the owner frees it by hand if wanted).
- This worktree already contains `20261101100000_pipeline_steps.sql` (merged from #29 via PR #52),
  so the ADW stack is reset to four migrations; renumbering the future-dated versions on other
  branches is out of scope, as are cleaning the developer's stack, a CI or lefthook version check,
  leftover `pw-webkit-*` containers, and anything under `adws/`.
- Conventional commit, e.g. `chore: give ADW runs their own local Supabase stack`; no trailers.
