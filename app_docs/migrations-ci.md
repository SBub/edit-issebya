# Hosted migrations in CI: applied on promotion, never by hand

## Overview

The hosted Supabase project (`ykjgyapmrszliovfqjfx`, the studio's production database) gets its
migrations from CI as part of promotion: the PR from `develop` into `master` shows what will be
applied, and its merge applies it. Nobody runs `supabase db push` by hand before a deploy any more.

Why: the owner used to push by hand before deploying, forgot once, and
`20261103115809_failure_kind_reel_size.sql` was missing from hosted until it was applied by hand.

The setup is ported from `issebya-homes-ai-system`'s `.github/workflows/migrations.yml`, whose
header records why `supabase link` was abandoned for a direct session-pooler connection. The
workflow here is `.github/workflows/migrations.yml`; its header lists every difference from the
reference and the reason for each.

## What it does

| Stage                                                                      | Job                               | What it does                                                                                                                                                                       |
| -------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every PR into `develop` or `master`                                        | `check` in `ci.yml` (the dry run) | `supabase start` on CI's own fresh local stack applies the whole history; broken SQL fails the step "Apply all migrations to a fresh local stack (dry run)". Never touches hosted. |
| Every PR into `master`                                                     | `prod-migration-sync` (read only) | Lists the migrations the merge will apply (the PR's files hosted lacks) as the job summary, and fails on drift. Details below.                                                     |
| Push to `master` touching `supabase/migrations/**`, or dispatch `job=push` | `push` (writes)                   | `supabase db push --db-url "$SUPABASE_DB_URL"` from `master`, whatever branch a dispatch picked. The summary lists the files applied. One run at a time, never cancelled midway.   |
| After a green `push`, or dispatch `job=drift-check`                        | `drift-check` (read only)         | Compares `master` as it stands with hosted, both ways; fails on any difference.                                                                                                    |

`prod-migration-sync` checks out the PR's merge commit and `master`, reads hosted's
`supabase_migrations.schema_migrations` with `psql` in a read-only session, and:

1. fails if a migration on `master` is missing from hosted (a push failed or never ran: the next
   promotion must not stack on top of it);
2. fails if hosted holds a version with no file in the PR's tree (history changed outside the repo,
   or the PR deletes an applied migration);
3. lists, without failing, what the merge will apply, and separately the migrations new to `master`
   that hosted already holds (applied outside CI; they will not run again);
4. warns (does not fail) when a pending migration is older than hosted's newest version: `db push`
   refuses those without `--include-all`, so after the merge dispatch `job=push` with `include_all`.

It also runs `supabase db push --dry-run --db-url` so the log shows the CLI's own view.

The pull_request trigger has no `paths:` filter and the job has no `if` on the PR's file list, so it
reports on every PR into `master`, including promotions that carry no SQL.

## Secret

One repository secret, `SUPABASE_DB_URL`, read only by `migrations.yml` (never by `ci.yml`, whose
tests use the same variable name for the local stack and refuse any host but `127.0.0.1` and
`localhost`). Shape:

```
postgresql://postgres.ykjgyapmrszliovfqjfx:<percent-encoded password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

- Where: Supabase dashboard, project `ykjgyapmrszliovfqjfx`, **Connect** (top bar), **Connection
  string**, method **Session pooler**. Copy that URI and put the database password in place of
  `[YOUR-PASSWORD]`, percent-encoded. A forgotten password is reset under **Project Settings,
  Database, Reset database password**; anything else that logs in as `postgres` (for example the
  PostHog warehouse source, if it was set up with that user) then needs the new password too.
- The session pooler host, not `db.<ref>.supabase.co`: the direct host is IPv6-only and GitHub
  runners are IPv4-only. Port 5432 (session mode), not 6543 (transaction mode), which refuses the
  session-level statements migrations issue. The region part may read `aws-1-` instead of `aws-0-`.
- Add it with `gh secret set SUPABASE_DB_URL` (paste at the prompt) or **Settings, Secrets and
  variables, Actions**.

Every job that reads it first fails with a clear error when it is empty or is not a session-pooler
URL for this project (user `postgres.ykjgyapmrszliovfqjfx`, host `*.pooler.supabase.com`, port 5432),
and masks the password (raw and decoded) before any CLI call. An empty `--db-url` would otherwise
dial the runner's own Postgres. The value is never printed, and the push summary carries only the
applied file names.

## Deploy order

On a merge into `master`, in this order:

1. The `push` job applies the pending migrations; `drift-check` then confirms hosted equals `master`.
2. Vercel builds and promotes the studio and the landing page from `master`. Vercel is not gated on
   the migrations job (the reference repository does not gate it either: its Ignored Build Step only
   filters ADW previews and it has no deploy hook), so steps 1 and 2 start together.
3. The worker (the owner's Mac, deployed by hand): only after `push` and `drift-check` are green,
   update the worker's checkout to `master`, `yarn install`, and restart
   `yarn workspace @edit-issebya/worker worker:prod`. Never restart it on new code while `push` is
   running or red.

The race in step 2: the push job is a short job (runner start, CLI install, one connection), while a
production build installs and builds the Next app, so the migration normally lands first; neither
duration has been measured here. When the push fails, the new studio runs against the old schema
until a dispatched `job=push` succeeds. Both cases are covered by one rule: a migration must work
with the code already on `master` (expand first, remove in a later promotion), because the old
studio and the not yet restarted worker run against the new schema too.

## How to Use

- Promote as usual: open the PR from `develop` into `master` and read the `prod-migration-sync`
  summary (PR, Checks, migrations, prod-migration-sync). After the merge, watch the `migrations`
  run on `master`, then restart the worker.
- Re-run `prod-migration-sync` (Re-run job) after fixing hosted; it reads hosted afresh.
- Dispatch by hand (Actions, migrations, Run workflow), or:

  ```bash
  gh workflow run migrations.yml -f job=drift-check          # read only, the default
  gh workflow run migrations.yml -f job=push                 # applies master's pending migrations
  gh workflow run migrations.yml -f job=push -f include_all=true
  ```

  The push always applies `master`'s migrations, whatever `--ref` says.

## Drift recovery

- **On `master`, missing from hosted** (sync or drift-check): dispatch `job=push`. If it refuses a
  migration older than hosted's newest, dispatch again with `include_all=true`.
- **On hosted, no file in the repo**: someone applied a version from a branch that never landed, or
  a file was renamed or deleted after it ran. Restore or land the file through `develop` with the
  same version. If the change must not exist, the owner reverts the schema with a new migration and
  then, from their own shell, runs
  `supabase migration repair --status reverted <version> --db-url "<session pooler url>"`.
- **On hosted ahead of `master`** (applied from `develop` before a promotion): not drift for
  `prod-migration-sync`, which lists them as already on hosted. A dispatched `drift-check` reports
  them until the promotion lands.
- **Applied in the SQL editor without a history row**: the version shows as pending. If its SQL
  re-runs harmlessly, let the push run it. Otherwise the owner records it from their own shell with
  `supabase migration repair --status applied <version> --db-url "<session pooler url>"` before the
  merge.

## Configuration

- `SUPABASE_DB_URL` (repository secret), above.
- `HOSTED_PROJECT_REF` (workflow `env`): `ykjgyapmrszliovfqjfx`, the only project the jobs accept.
- Supabase CLI 2.75.0 in `migrations.yml` and `ci.yml`; bump all pins together.
- To make `prod-migration-sync` block merges, add it as a required status check for `master`
  (Settings, Branches or Rules). Do it only after the secret exists and one promotion has gone
  green; a required check that cannot pass locks `master`.

## Testing

- `actionlint` (with shellcheck) over both workflows.
- The step scripts were replayed locally with stand-in `psql` and `supabase` commands: the first
  promotion's expected state, drift both ways, an out-of-order pending migration, an unreadable
  hosted history, and the secret guard against an empty, wrong-project, direct-host and
  transaction-port URL. Nothing connects to hosted outside CI, and no test points at it.

## Rules

- Never run `supabase db push`, `supabase link` or anything with `--linked` against hosted by hand,
  from an agent or a script; CI applies hosted migrations from `master` only.
- Never give `prod-migration-sync` a `paths:` filter or an `if` on the PR's file list: a skipped
  job satisfies a required check, and a filtered workflow never reports one.
- Never let the push job check out anything but `master`.
- Never print `SUPABASE_DB_URL` or copy CLI output wholesale into a job summary.
- Never reference `SUPABASE_DB_URL`'s secret from `ci.yml` or any test.
- Never restart the production worker on new code before `push` and `drift-check` are green.
- Never write a migration the code already on `master` cannot run against.
