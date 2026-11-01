# Patch: Shared stack still misaligned (third review), owner realigns it, then the run verifies

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #1: Several of the spec's verification criteria are still unverified because of the shared local Supabase stack, the same cause as the last two reviews. supabase migration list --local shows this branch's 20261101120000 as unapplied locally, and 10 remote-only versions (20261102090000 to 20261108090000) that exist neither on origin/develop nor on this branch. supabase migration up --local exits 1 with 'Remote migration versions not found in local migrations directory'. yarn turbo run test:db --filter=./apps/studio exits 1 with 4 failed, 23 passed and 4 skipped tests. The failures are: rls.test.ts finish_upload (the second call errors), upload.test.ts 'queues exactly one job however often it is called' and 'removes the parts, marks the reel failed', and steps-measurements.test.ts (an extra column from the foreign migrations). PORT=9211 STUDIO_PORT=9111 yarn test:e2e exits 1: the landing suite passes 140 tests, and the studio's 'Cancel marks the reel failed' gets 'uploading' instead of 'failed'. In my live check, Cancel likewise left the reel uploading. As a result there is no passing evidence for these acceptance criteria: idempotent finish under repeated and concurrent calls, Cancel and Discard marking the reel failed, user B unable to abort A's upload, and 'every validation command passes'. Resolution: No patch to this branch can resolve this: the cause is the state of the shared local stack, and ADW may not run reset, repair or db push. The owner must bring the stack back in line so that its applied versions are a prefix of this branch's supabase/migrations (for example by reverting the 10 foreign versions, 20261102090000 to 20261108090000, and their schema changes, or by resetting the stack themselves). After that, run supabase migration up --local, then yarn turbo run test:db --filter=./apps/studio and PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e, and confirm both pass. If develop gains a later migration before merge, rename 20261101120000_multipart_upload.sql to sort after it. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md`
**Issue:** For the third review in a row, the shared local Supabase stack (ports 54430 to 54439) holds ten applied versions, 20261102090000 to 20261108090000, that are on neither `origin/develop` nor this branch. `supabase migration up --local` therefore refuses to run, `20261101120000_multipart_upload.sql` stays unapplied, and the stack lacks idempotent `finish_upload` and `abort_upload`. The result is 4 `test:db` failures (`rls.test.ts` finish_upload second call, `upload.test.ts` "queues exactly one job however often it is called" and "removes the parts, marks the reel failed", and `steps-measurements.test.ts` with the extra foreign column) and the E2E failure "Cancel marks the reel failed" (reel stays `uploading`). The earlier plans `patch-adw-67f9b648-realign-shared-stack-migrations.md` and `patch-adw-67f9b648-owner-realign-stack-then-verify.md` reached the same conclusion, and the owner has not acted since.
**Solution:** No source change. The branch is correct as it stands: at plan time `origin/develop` (7d82d00) still ends at `20261101090000_step_measurements.sql`, so `20261101120000_multipart_upload.sql` already sorts after it and needs no rename. The blocker clears only through an owner action outside ADW (Step 1). Once the owner has acted, the run applies the migration with the one permitted database command and reruns the spec's validation commands (Steps 2 and 3). The rename happens only if `develop` has moved past the migration by then (Step 4).

## Files to Modify

Use these files to implement the patch:

- None for the blocker (the defect is the shared stack's state, not a file in this branch).
- Only under Step 4's condition: `supabase/migrations/20261101120000_multipart_upload.sql` (renamed with `git mv`, content unchanged), its filename in `app_docs/upload.md` (line 91) and in `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md` (lines 212, 323 and 665).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Gate on the owner realigning the shared stack (outside ADW)

- ADW never does this itself. `.adw/project.md` Protected allows only `supabase migration up --local`: never `supabase db reset`, `supabase start` or `stop`, `supabase migration repair`, a seed, `supabase db push`, `--include-all`, a hand edit of `supabase_migrations.schema_migrations`, or copying the foreign migrations into this branch.
- The owner brings the stack in line, either by reverting versions 20261102090000 to 20261108090000 and their schema changes from the checkout that added them, or by resetting the stack themselves from this worktree. Afterwards the stack's applied versions must be a prefix of this branch's `supabase/migrations/` (`20261031105245`, `20261031174750`, `20261101090000`, optionally `20261101120000`), and `steps` must have exactly the column set `steps-measurements.test.ts` expects.
- If Step 2 still fails with "Remote migration versions not found in local migrations directory", the owner has not acted yet. Report that the shared stack still holds foreign versions 20261102090000 to 20261108090000, then stop. Do not change any file to work around it, and do not weaken or skip the four failing tests or the Cancel spec.

### Step 2: Apply this branch's migration

- From the worktree root, run `supabase migration up --local`. It must exit 0 and apply `20261101120000_multipart_upload.sql` (or report it as already applied). On any error, report it verbatim and stop. Never reset or repair.

### Step 3: Rerun the spec's validation commands

- Run every command in the Validation section below, in order. The tests that failed before must now pass: `rls.test.ts` finish_upload (repeated and concurrent calls), `upload.test.ts` "queues exactly one job however often it is called" and "removes the parts, marks the reel failed" (including user B unable to abort A's upload), `steps-measurements.test.ts`, and `multipart-upload.spec.ts` "Cancel marks the reel failed".
- If a test still fails once the stack is in line, that is a real defect in this branch. Fix the code under test (the migration's SQL or the studio route), never the test.

### Step 4: Rename the migration only if develop has moved past it

- Run `git fetch origin develop`, then `git ls-tree --name-only origin/develop supabase/migrations/`. If the latest timestamp there is greater than or equal to `20261101120000`, `git mv` the file to a `YYYYMMDDHHMMSS_multipart_upload.sql` that sorts after it, update the filename everywhere listed in Files to Modify, and repeat Steps 2 and 3. Otherwise (as at plan time) change nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a`: load this run's `PORT` and `BACKEND_PORT` (never edit the file).
- `supabase migration up --local`: exits 0 with `20261101120000_multipart_upload.sql` applied. On failure, report and stop; never reset.
- `yarn turbo run test:db --filter=./apps/studio`: every test passes with 0 failed, including idempotent `finish_upload`, `abort_upload`, user B unable to abort A's upload, and the exact `steps` column set.
- `yarn turbo run build --filter=./apps/studio`: `next build` of the studio with no variables.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E suites pass against the `/prepare_app` server (landing first, then the studio's), including "Cancel marks the reel failed".

## Patch Scope

**Lines of code to change:** 0 (a file move and up to four filename references only if Step 4 applies)
**Risk level:** low
**Testing required:** Once the owner has realigned the stack: apply the migration, then run the studio's `test:db`, the studio build and the full E2E run. The acceptance criteria for idempotent finish, Cancel and Discard marking the reel failed, owner isolation of abort and "every validation command passes" count as verified only once all of these pass.
