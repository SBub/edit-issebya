# Patch: Add the reel statuses migration for background removal, head tracking and previews

## Metadata

adw_id: `d6f4b53b`
review_change_request: `Issue #1: Spec step 3 (and the Solution Statement and New Files list) requires a new migration created with supabase migration new pipeline_background_head_previews that drops and re-adds reels_status_check with 'removing_background', 'tracking_head' and 'making_previews' before 'processed'. No migration is in the diff: supabase/migrations/ still ends at 20261102090000_pipeline_steps.sql. After ADW_ID=d6f4b53b .adw/supabase-stack reset (exit 0), yarn turbo run test:db --filter=./apps/studio exits 1 with 'FAIL db-tests/pipeline-statuses.test.ts > accepts each step's reel status: removing_background ... new row for relation "reels" violates check constraint "reels_status_check"'. In production, step-store.ts reelStatus throws on that error, so every real process job would fail at remove_background. yarn test:e2e was not run and could not pass as the branch stands. Resolution: run supabase migration new pipeline_background_head_previews (do not hand-pick the version), write a header comment like the one in 20261102090000_pipeline_steps.sql, then alter table public.reels drop constraint reels_status_check, add constraint reels_status_check check (status in ('uploading', 'uploaded', 'received', 'converting', 'transcribing', 'retiming', 'removing_background', 'tracking_head', 'making_previews', 'processed', 'failed')); then .adw/supabase-stack reset, yarn turbo run test:db --filter=./apps/studio (must pass) and the E2E suites with the /prepare_app server up on this run's port. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-d6f4b53b-sdlc_planner-pipeline-background-head-track-previews.md`
**Issue:** The code already writes the three new reel statuses (`apps/worker/src/step-store.ts`
`PipelineReelStatus`, `apps/worker/src/pipeline/remove-background.ts`, `apps/studio/src/lib/reels.ts`,
`apps/studio/db-tests/pipeline-statuses.test.ts`), but no migration widens `reels_status_check`, so
the database rejects `removing_background` (and the two after it). `test:db` fails, every real
process job would fail at its first new step, and the E2E upload spec cannot reach `processed`.
**Solution:** Add the one missing migration (spec step 3), created with
`supabase migration new pipeline_background_head_previews`, that drops and re-adds
`reels_status_check` with the existing list plus the three statuses before `processed`. Reset the
ADW stack and run the DB and E2E suites. No application code changes.

**Ordering hazard (check before writing SQL):** the latest committed migration,
`20261102090000_pipeline_steps.sql`, carries a version later than the current UTC time (today is
2026-11-01; `supabase migration new` currently stamps `20261101......`). A new file stamped earlier
than `20261102090000` sorts and applies BEFORE `pipeline_steps.sql`, which then drops the constraint
and re-adds it without the new statuses, so `test:db` would still fail. That migration is merged to
`develop` (applied), so it must not be edited, and the new version must not be hand-picked or
future-dated (`AGENTS.md`, `.adw/project.md` Protected). Run `fe4e42f4` of the same issue hit exactly
this (`20261101115144_pipeline_steps_part_two.sql` sorting before `20261102090000`). Step 2 guards it.

## Files to Modify

Use these files to implement the patch:

- `supabase/migrations/<stamp>_pipeline_background_head_previews.sql` (new, created by
  `supabase migration new`; `<stamp>` is whatever the CLI writes).

Nothing else. `step-store.ts`, `reels.ts`, `reels.test.ts` and `pipeline-statuses.test.ts` already
carry the three statuses in the right order; `app_docs/pipeline.md` needs no change for a migration
the spec already describes.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Create the migration file with the CLI

- From the worktree root run exactly `supabase migration new pipeline_background_head_previews`.
  This is the only `supabase` command allowed besides `.adw/supabase-stack reset`; add no flags,
  never `--workdir`, never any other `supabase` subcommand.
- Do not rename the file or alter its version afterwards.

### Step 2: Verify the new version sorts after `20261102090000`

- Run `ls supabase/migrations | tail -2` and confirm the new `_pipeline_background_head_previews.sql`
  file is the LAST entry (its 14-digit version is greater than `20261102090000`).
- If it is not last: stop. Delete only the file this step just created (`rm` that one path), make
  no other change, and report the blocker verbatim: "supabase migration new stamped `<stamp>`,
  which sorts before the applied, future-dated `20261102090000_pipeline_steps.sql`; the widened
  constraint would be overwritten on every reset. Rules forbid hand-picking or future-dating a
  version and editing an applied migration. Needs an owner decision: create the migration after
  2026-11-02 09:00 UTC, or authorize an explicit version." Do not hand-pick a version, do not
  touch `20261102090000_pipeline_steps.sql`, do not commit.

### Step 3: Write the SQL (only when Step 2 passed)

- Replace the empty file's content with a header comment in the style of
  `20261102090000_pipeline_steps.sql` (plain `--` lines, no em-dashes), for example:
  ```sql
  -- Background removal, head tracking and preview copies (app_docs/pipeline.md): after retime the
  -- reel moves through removing_background, tracking_head and making_previews, then processed.
  -- Supersedes the list in 20261102090000_pipeline_steps.sql; received stays allowed for existing rows.
  alter table public.reels
    drop constraint reels_status_check,
    add constraint reels_status_check check (
      status in (
        'uploading',
        'uploaded',
        'received',
        'converting',
        'transcribing',
        'retiming',
        'removing_background',
        'tracking_head',
        'making_previews',
        'processed',
        'failed'
      )
    );
  ```
- The status list must match `apps/studio/src/lib/reels.ts` in the same order.
- Run `yarn format` only if `yarn format:check` flags the file (Prettier may not format `.sql`).

### Step 4: Apply it to the ADW stack and run the DB and E2E suites

- `.adw/supabase-stack reset` (if it fails, report its error and stop; never reset any other way).
- `yarn turbo run test:db --filter=./apps/studio` must pass, including
  `pipeline-statuses.test.ts > accepts each step's reel status` for all three new statuses.
- With the `/prepare_app` server already up on this run's port (Workspaces dev command, never
  `CI=1`), run the E2E suites; the upload spec must show the six `..., reused` lines and `processed`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `ls supabase/migrations | tail -1`: prints the new `<stamp>_pipeline_background_head_previews.sql`.
2. `.adw/supabase-stack reset`: exit 0, applies the new migration to the ADW stack.
3. `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio && yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio && yarn knip && yarn format:check`: unchanged checks still pass.
4. `yarn turbo run test --filter=./apps/worker --filter=./apps/studio && yarn turbo run test:db --filter=./apps/studio`: unit and DB suites pass (the latter was failing before this patch).
5. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: landing then studio suites pass against the `/prepare_app` server on this run's port.

## Patch Scope

**Lines of code to change:** about 20 (one new SQL file)
**Risk level:** low (schema widening only), but blocked if the CLI stamp sorts before `20261102090000` (Step 2)
**Testing required:** ADW stack reset, `test:db` for the new statuses, and the full E2E suites including the upload spec reaching `processed`
