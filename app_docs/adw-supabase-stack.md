# ADW Supabase stack: each run's own local database, reset to the worktree's migrations

**Specifications:**

- specs/issue-62-adw-518dc931-sdlc_planner-adw-own-supabase-stack.md

## Overview

ADW runs no longer use the developer's local Supabase stack (`edit-issebya`, ports 54430 to 54439).
They get a second local stack, `edit-issebya-adw` on ports 54450 to 54459, which the engine's
worktree hook (`.adw/worktree-env`) provides before each phase and resets to the worktree's
migrations at the start of a run. The developer's stack is never touched by a run.

Why: every run used to apply its branch's migrations to the developer's stack with
`supabase migration up --local`, and nothing took them off. A failed or unmerged branch left its
schema behind, the next run's `migration up` refused ("Remote migration versions not found in local
migrations directory"), and no reset was allowed, so the run could not recover (run `67f9b648` died
this way). Leftover rows crossed runs too (claimable `process` jobs broke `db-tests/jobs.test.ts`).

## What it does

`.adw/supabase-stack` (executable bash) is the only code that touches the ADW stack:

- `up`: take the lock, claim ownership, sync the config, start the stack if it is down, reset it
  when needed, verify the migration list, and print five variables.
- `reset`: the same with a forced reset, printing nothing. Agents run it after adding or editing a
  migration in a run, before `test:db` and E2E.
- `release`: give up this run's ownership (called by the hook's `down`). Never stops the stack.

Step by step:

- **Working directory**: `agents/supabase-adw/` in the main checkout (gitignored), found through
  `ADW_PROJECT_ROOT` or `git rev-parse --git-common-dir`. Every `supabase` command the script runs
  passes `--workdir` pointing there.
- **Lock**: `agents/supabase-adw.lock` (a directory holding the holder's pid), waited on for up to
  120 s; a lock whose pid is gone is stale and removed.
- **Ownership**: `agents/supabase-adw/owner` holds the `ADW_ID` that last claimed the stack. A
  different owner keeps it only while a phase of that run is alive (`adw_*_iso.py` with its ID as a
  whole word in `ps`, the same test as the toolkit's `queue_ops.ADW_PHASE_RE`); then `up` fails
  with `ADW Supabase stack is in use by run <id>`. Otherwise the new run takes it over.
- **Sync and rewrite**: `rsync -a --delete` of the worktree's `supabase/` (migrations, `templates/`
  for the magic-link email, `config.toml`; the CLI's `.temp/` survives), then the copied
  `config.toml` gets `project_id = "edit-issebya-adw"` and each 5443x port becomes 5445x (the
  commented `smtp_port` and `pop3_port` examples too, so no 5443x is left). The committed
  `supabase/config.toml` is never changed.
- **Refusal**: before any `supabase` command, the copy must name `edit-issebya-adw`, have API port
  54451 and DB port 54452, and contain no `5443` anywhere, or the script stops with
  `refusing: the ADW config copy still targets the developer's stack`.
- **Start**: if `supabase status` fails, `supabase start -x storage-api,imgproxy,mailpit,
postgres-meta,studio,edge-runtime,logflare,vector,supavisor` (the services CI also excludes).
- **Reset rule**: `supabase db reset --local` when the stack was just started, the owner changed,
  `reset` was asked for, or the fingerprint (each migration file's hash plus the copied
  `config.toml`'s) differs from `agents/supabase-adw/applied.sha256`. A run with nothing changed
  keeps its data and logs no reset.
- **Verification**: after a reset, the applied versions (`supabase migration list --local`, the
  column the CLI calls "Remote") must equal the migration files' versions exactly, naming any
  `missing` or `extra`; only then is the fingerprint written.
- **Output**: `up` prints exactly `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SUPABASE_URL`,
  `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_DB_URL` (from `supabase status -o env`), never
  `STUDIO_URL`. The engine exports the hook's lines into every phase, where they override the
  copied `.env.development` values (Node's env-file loading never overrides a set variable).
- **Log**: `agents/supabase-adw/stack.log` gets a timestamped line per command and the commands'
  stderr (and `rsync` and `db reset` output); the stdout of `status` and `start`, which carries
  keys, is discarded, so no value is ever logged.

`.adw/worktree-env up` runs `.adw/supabase-stack up` on every platform and prints its lines, then
starts the WebKit server only on macOS 14 (`app_docs/checkout.md`). `down` runs `release` (never
failing `down`) and removes the WebKit container.

`turbo.json` passes `NEXT_PUBLIC_SUPABASE_*` through `dev` and `start`, and `SUPABASE_DB_URL`
through `test:db`, `test:e2e` and `@edit-issebya/studio#test:e2e`. `localDbUrl(env)` in
`apps/studio/test-support/local-supabase.ts` returns `SUPABASE_DB_URL` (refusing a non-local host)
or the developer's and CI's 54432 default.

## Ports

| service   | developer's stack (`edit-issebya`) | ADW stack (`edit-issebya-adw`) |
| --------- | ---------------------------------- | ------------------------------ |
| shadow    | 54430                              | 54450                          |
| API       | 54431                              | 54451                          |
| database  | 54432                              | 54452                          |
| studio    | 54433                              | 54453 (not started)            |
| inbucket  | 54434                              | 54454 (not started)            |
| analytics | 54437                              | 54457 (not started)            |
| pooler    | 54439                              | 54459 (not started)            |

Fixed ports are a deliberate exception to the toolkit's "bind on `SERVICES_PORT`" rule: there is
one ADW stack, runs are serialised by the queue, and ownership guards the rest.

## How to Use

- Nothing to do in a run: the engine runs the hook. After adding or editing a migration, run
  `.adw/supabase-stack reset` (with the run's `ADW_ID` in the environment) before `test:db` and
  E2E. Create a migration with `supabase migration new <name>`.
- Inspect, from the main checkout: `supabase status --workdir agents/supabase-adw` and
  `supabase migration list --local --workdir agents/supabase-adw`.
- Free the disk by hand when wanted: `supabase stop --workdir agents/supabase-adw --no-backup`.
  The next run's `up` starts it again.

## Configuration

- `ADW_ID` (required for every command), `ADW_PROJECT_ROOT` (optional, the main checkout).
- Needs `supabase`, `docker` (running) and `rsync` on the machine.
- Hook timing: a cold `up` (images already pulled, stack down) took about 50 s on the owner's Mac,
  including the reset to four migrations; an unchanged `up` takes a few seconds. If it ever gets
  close to the engine's `ADW_WORKTREE_ENV_TIMEOUT` (default 300 s), that variable is the owner's knob.

## Rules

- Never run a `supabase` command against the developer's stack in a run. Any `supabase` command in a
  worktree without `--workdir agents/supabase-adw` reaches it.
- Never start, stop or reset the ADW stack except through `.adw/supabase-stack`; never stop it
  automatically.
- Never print or log a secret value; never put `STUDIO_URL` in the environment.
- Never edit the committed `supabase/config.toml` for the ADW stack.
- Never move 54450 to 54459.
- Never hand-pick, copy, future-date or reuse a migration version; create one with
  `supabase migration new <name>`.

## Notes

- `site_url` and `additional_redirect_urls` in the copy are not ports and stay as committed.
- `[db.seed]` points at a missing `seed.sql`; `db reset` only warns, and no `--no-seed` is passed so
  behaviour matches CI if a seed is ever added.
- The live-phase test reads full command lines, so any process whose command line contains a
  phase script name and the owner's ID counts as live.
- Running `.adw/worktree-env up` by hand (the WebKit commands in `app_docs/checkout.md`) also
  provides the ADW stack and claims it for the given `ADW_ID`; `down` releases it.
- Not covered by an automated test (the profile has no shell-script layer and it needs Docker);
  `shellcheck` covers both scripts.
