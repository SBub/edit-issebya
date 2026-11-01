# Patch: Re-stamp the reel status migration so it runs after 20261102090000

## Metadata

adw_id: `fe4e42f4`
review_change_request: `Issue #1: Migration ordering still undoes the reel status widening. supabase/migrations/20261101115144_pipeline_steps_part_two.sql sorts before 20261102090000_pipeline_steps.sql, a future-dated migration already on develop (b8dc78d, not on master). The later one drops and re-adds reels_status_check with only the eight old statuses. Evidence: ADW_ID=fe4e42f4 .adw/supabase-stack reset exits 0, then yarn turbo run test:db --filter=./apps/studio fails on 'pipeline-statuses.test.ts > accepts each step's reel status' with 'new row for relation "reels" violates check constraint "reels_status_check"' (Tests 1 failed, 29 passed). This fails the acceptance criterion 'the constraint accepts them', and every real reel would fail at its removing_background status write. For the same reason the spec's E2E validation command (the six-hit upload.spec.ts, whose worker once writes removing_background) was not run and is unverified. The untracked specs/patch/patch-adw-fe4e42f4-reorder-status-migration.md describes the fix but has not been applied: date -u gives 20261101121958, which is still before its 20261102090000 clock gate. Resolution: This cannot be patched before 2026-11-02T09:00:00Z without the owner's sign-off. Fix (a), after that time: git rm supabase/migrations/20261101115144_pipeline_steps_part_two.sql, run supabase migration new pipeline_steps_part_two so the new stamp sorts after 20261102090000, and paste the same 19 lines of SQL unchanged. Fix (b), only with the owner's written confirmation that 20261102090000 was never applied to the hosted project: put the three statuses into that migration's reels_status_check. Never hand-pick or future-date a version. Then run ADW_ID=fe4e42f4 .adw/supabase-stack reset, yarn turbo run test:db --filter=./apps/studio (expect 30 passed) and set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e with the /prepare_app server up on this run's port. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-fe4e42f4-sdlc_planner-background-removal-head-tracking-previews.md`
**Issue:** Migrations apply in version order. `20261101115144_pipeline_steps_part_two.sql` (stamped
correctly by `supabase migration new` on 2026-11-01) sorts before `20261102090000_pipeline_steps.sql`
(future-dated before this branch, already on `develop` since `b8dc78d`). That later file replaces
`reels_status_check` with the old eight statuses, so it undoes this branch's widening. Every fresh
stack (the ADW stack after reset, CI, a new hosted apply) rejects `removing_background`:
`pipeline-statuses.test.ts > accepts each step's reel status` fails (29 passed, 1 failed), and every
reel would fail at that status write. Two attempts have stopped at the clock gate
(`20261101121452`, then `20261101121958`, and `20261101122312` when this plan was refreshed, all
earlier than `20261102090000`), so nothing changed and `yarn test:e2e` (including the six-hit
`upload.spec.ts`) was not run.
**Solution:** Fix (a), the only one that breaks no rule without the owner's sign-off: once the UTC
clock is past `2026-11-02T09:00:00Z`, delete `20261101115144_pipeline_steps_part_two.sql`, create
the migration again with `supabase migration new pipeline_steps_part_two` (its new stamp then sorts
after `20261102090000`) and put the same SQL in it. No version is hand-picked, copied or
future-dated, and the applied `20261102090000_pipeline_steps.sql` is not edited. The file being
deleted has only ever been applied to the ADW stack, which is reset from the worktree's migrations.
Nothing else in the repository names the file (the spec refers to it as `<stamp>_pipeline_steps_part_two.sql`).

Before the gate opens this patch is blocked by design: a stamp made earlier still sorts before
`20261102090000`, and no rule allows working around that. The run must wait (or be resumed) until
after `2026-11-02T09:00:00Z`.

Fix (b), adding the three statuses to `20261102090000_pipeline_steps.sql`, is out of scope for this
plan: it edits an applied migration (it is on `develop`, though not on `master`) and needs the owner's
explicit written confirmation that it was never applied to the hosted project. Do not take it unless
that approval is in the issue or the run's instructions.

## Files to Modify

Use these files to implement the patch:

- `supabase/migrations/20261101115144_pipeline_steps_part_two.sql`: deleted.
- `supabase/migrations/<new stamp>_pipeline_steps_part_two.sql`: created by
  `supabase migration new pipeline_steps_part_two`, holding the same SQL (the 19 lines of the
  deleted file, unchanged).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Check the clock gate

- Run `date -u +%Y%m%d%H%M%S`. If the result is not greater than `20261102090000`, stop here:
  change nothing and report that the patch cannot be applied before 2026-11-02 09:00 UTC (a stamp
  made earlier still sorts before `20261102090000`), and that fix (b) needs the owner's written
  approval. Never work around the gate by hand-picking, editing or renaming a version, and never
  sleep or loop waiting for it inside the run.

### Step 2: Keep the SQL and delete the misordered migration

- Copy the full contents of `supabase/migrations/20261101115144_pipeline_steps_part_two.sql` (the
  comment header and the `alter table public.reels drop constraint reels_status_check, add constraint
reels_status_check check (status in (...))` statement with the eleven statuses `uploading`,
  `uploaded`, `received`, `converting`, `transcribing`, `retiming`, `removing_background`,
  `tracking_head`, `making_previews`, `processed`, `failed`).
- `git rm supabase/migrations/20261101115144_pipeline_steps_part_two.sql`.

### Step 3: Create the migration again with the CLI

- From the worktree root run `supabase migration new pipeline_steps_part_two` (allowed by the
  Protected section; it only writes a file and touches no stack).
- Confirm the new file's version is greater than `20261102090000`
  (`ls supabase/migrations | sort` lists it last).
- Write the SQL from Step 2 into the new file, unchanged (`git diff --staged -M` shows a rename with
  no content change).

### Step 4: Reset the ADW stack

- Run `ADW_ID=fe4e42f4 .adw/supabase-stack reset` (the only allowed way to apply migrations here).
  If it fails, report its error and stop.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `ls supabase/migrations | sort | tail -1` prints `<new stamp>_pipeline_steps_part_two.sql`, and
   `ls supabase/migrations | grep -c pipeline_steps_part_two` prints `1`; then
   `psql "$SUPABASE_DB_URL" -Atc "select pg_get_constraintdef(oid) from pg_constraint where conname = 'reels_status_check'"`
   lists `removing_background`, `tracking_head` and `making_previews`.
2. `yarn format:check && yarn turbo run lint --filter=./apps/worker --filter=./apps/studio && yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio && yarn knip && yarn turbo run test --filter=./apps/worker --filter=./apps/studio`
3. `yarn turbo run test:db --filter=./apps/studio`: exits 0, `pipeline-statuses.test.ts > accepts each step's reel status` passes (30 passed).
4. `yarn turbo run build --filter=./apps/studio --filter=./apps/web`
5. With the `/prepare_app` server already up on this run's port (started with the Workspaces dev
   command, never `CI=1`): `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`.
   Both suites pass, including the studio `upload.spec.ts`, whose spawned worker `once` writes
   `removing_background`, `tracking_head`, `making_previews` and `processed` on the constrained table.

## Patch Scope

**Lines of code to change:** 0 lines of SQL changed; one 19-line migration file deleted and re-created under a new CLI stamp.
**Risk level:** low
**Testing required:** Clock gate past 2026-11-02T09:00:00Z, ADW stack reset, the studio DB integration suite, build, and both E2E suites against the `/prepare_app` server, plus the commit and push hook checks.
