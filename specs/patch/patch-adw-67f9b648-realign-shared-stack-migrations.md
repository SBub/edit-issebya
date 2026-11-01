# Patch: Verify the multipart migration once the shared local stack matches this branch

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #3: No patch to this branch can fix this: it is the state of the shared local Supabase stack. supabase migration up --local refuses with 'Remote migration versions not found in local migrations directory'. The shared stack already holds 10 migrations (20261102090000 to 20261108090000) from other unmerged branches, such as feat/issue-29, and they are neither on origin/develop nor on this branch. So 20261101120000_multipart_upload.sql is not applied. As a result, yarn turbo run test:db --filter=./apps/studio exits 1 with 4 failures (rls.test.ts finish_upload twice, upload.test.ts 'queues exactly one job...' and 'aborting...' with PGRST202 for public.abort_upload, steps-measurements.test.ts 20 columns against 19), and yarn test:e2e exits 1 on 'Cancel marks the reel failed'. Resolution: the owner must bring the shared local stack back in line with this branch (ADW may not run repair, reset or db push), then rerun supabase migration up --local, test:db and test:e2e and confirm they pass. Rename the migration to a timestamp after the latest one on develop at merge time if other branches merge first. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md`
**Issue:** The shared local Supabase stack (ports 54430 to 54439) has ten migration versions applied (20261102090000 to 20261108090000) that exist in no migrations directory on `origin/develop` or on this branch. `supabase migration up --local` therefore refuses to run, `20261101120000_multipart_upload.sql` is never applied, and `finish_upload`'s idempotence, `abort_upload` (Cancel marks the reel failed) and owner isolation of abort stay unverified: 4 `test:db` failures and 1 E2E failure, all caused by the stack, not by this branch's code. The extra `steps` column (20 against 19) also comes from those foreign migrations.
**Solution:** No source change on this branch. The branch's migration set is already correct: `origin/develop` ends at `20261101090000_step_measurements.sql`, and `20261101120000_multipart_upload.sql` sorts after it, so no rename is needed today. The fix is an owner action outside ADW (Step 1), after which the run applies the migration with the one permitted command and reruns the DB and E2E suites (Steps 2 and 3). A rename is conditional (Step 4) and happens only if another branch's migration lands on `develop` with a later timestamp before this one merges.

## Files to Modify

Use these files to implement the patch:

- None for the blocker itself (the defect is the shared stack's state, not a file in this branch).
- `supabase/migrations/20261101120000_multipart_upload.sql`: only under Step 4's condition, renamed with `git mv` (content unchanged), plus the one reference to its filename in `app_docs/upload.md` (line 91) and the filename in the original spec's Validation Commands if it is rerun.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Owner realigns the shared local stack (outside ADW, blocking)

- ADW must not perform this step: `.adw/project.md` Protected allows only `supabase migration up --local`, never `supabase db reset`, `supabase start`/`stop`, `supabase migration repair`, a seed or `supabase db push`. If the stack is still out of line when this patch runs, report "shared stack still holds foreign migration versions" and stop; do not attempt a workaround (no `--include-all`, no editing `supabase_migrations.schema_migrations`, no copying other branches' migrations into this branch).
- The owner chooses how: for example, check out the branch that owns 20261102090000 to 20261108090000 (such as `feat/issue-29`) and revert its schema, or run `supabase db reset` from this worktree so the stack holds exactly this branch's four migrations. Either way the stack's applied versions must be a prefix of `supabase/migrations/` on this branch: `20261031105245`, `20261031174750`, `20261101090000` (and, after Step 2, `20261101120000`), and the `steps` table must have the 19 columns `steps-measurements.test.ts` expects.

### Step 2: Apply this branch's migration

- From the worktree root: `supabase migration up --local`. It must report applying `20261101120000_multipart_upload.sql` (or that it is already applied) and exit 0.
- On any failure, report the exact error and stop. Never reset or repair.

### Step 3: Rerun the suites the review could not verify

- `yarn turbo run test:db --filter=./apps/studio`: the four previously failing tests must pass (`rls.test.ts` both `finish_upload` cases, `upload.test.ts` "queues exactly one job..." and "aborting...", `steps-measurements.test.ts`).
- With the `/prepare_app` server up on this run's port (started with the profile's Workspaces dev command), `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: `multipart-upload.spec.ts` "Cancel marks the reel failed" must pass along with every other spec.
- If a test still fails with the stack in line, it is a real defect in this branch: diagnose and fix it in the code under test, never by weakening the test.

### Step 4: Rename the migration only if develop has moved past it (conditional)

- `git fetch origin develop` and list `git ls-tree --name-only origin/develop supabase/migrations/`. If the latest timestamp there is greater than or equal to `20261101120000`, rename with `git mv supabase/migrations/20261101120000_multipart_upload.sql supabase/migrations/<new>_multipart_upload.sql`, where `<new>` is a `YYYYMMDDHHMMSS` later than that latest timestamp, and update the filename in `app_docs/upload.md`.
- If the latest on `origin/develop` is still `20261101090000_step_measurements.sql` (as at plan time), make no change.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a` - load this run's `PORT` and `BACKEND_PORT` (never edit the file).
- `supabase migration up --local` - exits 0 and `20261101120000_multipart_upload.sql` (or its Step 4 name) is applied; on failure report and stop, never reset.
- `yarn turbo run test:db --filter=./apps/studio` - zero failures, including idempotent `finish_upload`, `abort_upload` and B unable to abort A's upload.
- `yarn turbo run build --filter=./apps/studio` - `next build` of the studio with no variables.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - both E2E suites pass, including "Cancel marks the reel failed".

## Patch Scope

**Lines of code to change:** 0 (2 if Step 4's rename applies: the file move and one doc reference)
**Risk level:** low
**Testing required:** Apply the migration to the realigned shared stack, then `test:db` for the studio and the full E2E run; the acceptance criteria for idempotent completion, Cancel marking the reel failed, and owner isolation of abort count as verified only once these pass.
