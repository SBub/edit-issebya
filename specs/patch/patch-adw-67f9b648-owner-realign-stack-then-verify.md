# Patch: Owner realigns the shared local stack, then the run verifies the multipart migration

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #1: Several of the spec's validation criteria are still unverified because of the shared local Supabase stack. supabase migration up --local exits 1 with 'Remote migration versions not found in local migrations directory': the stack holds 10 foreign migration versions (20261102090000 to 20261108090000) that are not on origin/develop or on this branch. As a result, 20261101120000_multipart_upload.sql is not applied. yarn turbo run test:db --filter=./apps/studio exits 1 with 4 failures out of 31: rls.test.ts finish_upload (P0002 on the second call), upload.test.ts 'queues exactly one job...' and 'removes the parts, marks the reel failed...' (PGRST202, public.abort_upload not found), and steps-measurements.test.ts (20 columns against 19, from the foreign migrations). In PORT=9211 STUDIO_PORT=9111 yarn test:e2e, 'Cancel marks the reel failed' fails with the reel still 'uploading' because abort_upload is missing. These acceptance criteria therefore have no passing evidence: idempotent completion under repeated and concurrent calls, Cancel and Discard marking the reel failed, user B unable to abort A's upload, and 'every validation command passes'. The cause is unchanged since the last review. Resolution: No patch to this branch can resolve this: it is the state of the shared local stack, and ADW may not run reset, repair or db push. The owner must bring the stack back in line, so that its applied versions are a prefix of this branch's supabase/migrations/ and the 19-column steps table is restored. For example, run supabase db reset from this worktree, or revert the feat/issue-29 schema. Then run supabase migration up --local, yarn turbo run test:db --filter=./apps/studio and PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e, and confirm they pass. If develop gains a migration later than 20261101120000 before merge, rename this one with git mv and update the filename in app_docs/upload.md. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md`
**Issue:** The shared local Supabase stack (ports 54430 to 54439) has ten applied migration versions (20261102090000 to 20261108090000) that exist neither on `origin/develop` nor on this branch, so `supabase migration up --local` refuses to run and `20261101120000_multipart_upload.sql` is never applied. Without it `abort_upload` is missing and `finish_upload` is not idempotent on the stack, which yields 4 `test:db` failures (two from the missing migration's functions, one `finish_upload` P0002, one 20-against-19 `steps` columns from the foreign schema) and the E2E failure "Cancel marks the reel failed". This is the second review with the same cause; the earlier plan `specs/patch/patch-adw-67f9b648-realign-shared-stack-migrations.md` already concluded no branch change fixes it.
**Solution:** No source change. The branch's migrations are correct: re-checked at plan time, `origin/develop` still ends at `20261101090000_step_measurements.sql`, so `20261101120000_multipart_upload.sql` sorts after it and needs no rename. The blocker clears only through an owner action outside ADW (Step 1). After that the run applies the migration with the one permitted database command and reruns the spec's validation commands (Steps 2 and 3). A rename happens only if `develop` gains a later migration before merge (Step 4).

## Files to Modify

Use these files to implement the patch:

- None for the blocker (the defect is the shared stack's state, not a file in this branch).
- Only under Step 4's condition: `supabase/migrations/20261101120000_multipart_upload.sql` (renamed with `git mv`, content unchanged) and its filename in `app_docs/upload.md` (line 91).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Gate on the owner realigning the shared stack (outside ADW)

- ADW never performs this: `.adw/project.md` Protected allows only `supabase migration up --local`; never `supabase db reset`, `supabase start`/`stop`, `supabase migration repair`, a seed, `supabase db push`, `--include-all`, a hand edit of `supabase_migrations.schema_migrations`, or copying another branch's migrations into this one.
- The owner brings the stack in line, for example `supabase db reset` from this worktree, or reverting the `feat/issue-29` schema from its own checkout. Afterwards the stack's applied versions must be a prefix of this branch's `supabase/migrations/` (`20261031105245`, `20261031174750`, `20261101090000`, optionally `20261101120000`) and `steps` must have the 19 columns `steps-measurements.test.ts` expects.
- If Step 2 still fails with "Remote migration versions not found in local migrations directory", the owner has not acted yet: report that the shared stack still holds foreign versions 20261102090000 to 20261108090000 and stop. Do not change any file to work around it.

### Step 2: Apply this branch's migration

- From the worktree root: `supabase migration up --local`. It must exit 0 and apply `20261101120000_multipart_upload.sql` (or report it already applied). On any error, report it verbatim and stop; never reset or repair.

### Step 3: Rerun the spec's validation commands

- Run every command in the Validation section below in order. The previously failing tests must pass: `rls.test.ts` `finish_upload` (repeated and concurrent calls), `upload.test.ts` "queues exactly one job..." and "removes the parts, marks the reel failed...", `steps-measurements.test.ts`, and `multipart-upload.spec.ts` "Cancel marks the reel failed".
- If a test still fails with the stack in line, it is a real defect in this branch: fix the code under test (the migration's SQL or the studio route), never the test.

### Step 4: Rename the migration only if develop has moved past it

- `git fetch origin develop` and `git ls-tree --name-only origin/develop supabase/migrations/`. If the latest timestamp there is greater than or equal to `20261101120000`, `git mv` the file to a `YYYYMMDDHHMMSS_multipart_upload.sql` later than it and update the filename in `app_docs/upload.md`. Otherwise (as at plan time) change nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `set -a; . ./.ports.env; set +a` - load this run's `PORT` and `BACKEND_PORT` (never edit the file).
- `supabase migration up --local` - exits 0 with `20261101120000_multipart_upload.sql` applied; on failure report and stop, never reset.
- `yarn turbo run test:db --filter=./apps/studio` - 31 of 31 pass, including idempotent `finish_upload`, `abort_upload`, and user B unable to abort A's upload.
- `yarn turbo run build --filter=./apps/studio` - `next build` of the studio with no variables.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - both E2E suites pass against the `/prepare_app` server, including "Cancel marks the reel failed".

## Patch Scope

**Lines of code to change:** 0 (a file move and one doc line only if Step 4 applies)
**Risk level:** low
**Testing required:** After the owner realigns the stack: apply the migration, then `test:db` for the studio, the studio build and the full E2E run. The acceptance criteria for idempotent completion, Cancel and Discard marking the reel failed, and owner isolation of abort count as verified only once these pass.
