# Patch: Add the reel statuses migration once its CLI stamp can sort last

## Metadata

adw_id: `d6f4b53b`
review_change_request: `Issue #1: Spec step 3 (also the Solution Statement, New Files and Phase 1) requires a migration supabase/migrations/<stamp>_pipeline_background_head_previews.sql that widens reels_status_check with 'removing_background', 'tracking_head' and 'making_previews' before 'processed'. No such file exists, committed or uncommitted: supabase/migrations/ ends at 20261102090000_pipeline_steps.sql. Evidence: ADW_ID=d6f4b53b .adw/supabase-stack reset exits 0, then yarn turbo run test:db --filter=./apps/studio exits 1 with FAIL db-tests/pipeline-statuses.test.ts > accepts each step's reel status: new row for relation "reels" violates check constraint "reels_status_check". Every real process job would fail at remove_background, and yarn test:e2e cannot pass. Resolution: no patch can land this before 2026-11-02 09:00 UTC unless the owner decides otherwise (date -u gave 20261101130606, so supabase migration new would stamp a version sorting before the applied, future-dated 20261102090000_pipeline_steps.sql). Once UTC is past 2026-11-02 09:00, or the owner has approved a version in writing, follow this plan: supabase migration new pipeline_background_head_previews, confirm it sorts last, fill it with a header comment and the widened reels_status_check in REEL_STATUSES order, then .adw/supabase-stack reset, yarn turbo run test:db --filter=./apps/studio (must pass) and the E2E suites with the /prepare_app server up on this run's port. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-30-adw-d6f4b53b-sdlc_planner-pipeline-background-head-track-previews.md`
**Issue:** The worker (`apps/worker/src/pipeline/run-pipeline.ts:83`, `apps/worker/src/step-store.ts`),
the studio (`apps/studio/src/lib/reels.ts`) and the DB test (`apps/studio/db-tests/pipeline-statuses.test.ts`)
already use `removing_background`, `tracking_head` and `making_previews`, but no migration widens
`reels_status_check`. `test:db` fails, every real process job would fail at `remove_background`,
and `yarn test:e2e` cannot reach `processed`. The earlier patch plan
(`patch-adw-d6f4b53b-add-reel-statuses-migration.md`) was correct but stopped at its own ordering
guard: at 2026-11-01 13:00 UTC `supabase migration new` stamps `20261101......`, which sorts before
the applied, future-dated `20261102090000_pipeline_steps.sql`; that file would then re-add the
narrower constraint on every reset.
**Solution:** Same single migration as the earlier plan, behind an explicit time/owner gate. Run it
only when the CLI stamp is guaranteed to sort after `20261102090000` (UTC at or after
2026-11-02 09:00:00), or when the owner has explicitly authorized a version in writing. Never
hand-pick or future-date a version on the agent's own judgment, never edit
`20261102090000_pipeline_steps.sql`. No application code changes. The two uncommitted doc edits
already in the tree (`.adw/project.md`, `app_docs/studio.md`, from
`patch-adw-d6f4b53b-studio-doc-statuses-and-tools-clips.md`) stay as they are.

## Files to Modify

Use these files to implement the patch:

- `supabase/migrations/<stamp>_pipeline_background_head_previews.sql` (new; `<stamp>` is whatever
  `supabase migration new` writes, never typed by hand).

Nothing else.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Check the gate before creating anything

- Run `date -u +%Y%m%d%H%M%S`. Proceed only if the value is greater than `20261102090000`.
- If it is not, proceed only if the owner has explicitly authorized a migration version for this
  change (in the issue, the PR or the run's instructions). If neither holds: create no file, change
  nothing, and stop with this report: "Blocked: `supabase migration new` would stamp `<date -u
value>`, which sorts before the applied, future-dated `20261102090000_pipeline_steps.sql`. Rerun
  this patch after 2026-11-02 09:00 UTC, or have the owner authorize an explicit version."

### Step 2: Create the migration with the CLI and confirm it sorts last

- From the worktree root run exactly `supabase migration new pipeline_background_head_previews`
  (no flags, no `--workdir`; the only other `supabase` command allowed is
  `.adw/supabase-stack reset`).
- Only under an owner-authorized version (Step 1, second branch): rename the created file to that
  exact version, nothing else.
- Run `ls supabase/migrations | tail -1`; it must print the new
  `<stamp>_pipeline_background_head_previews.sql`. If it does not, delete only that new file and
  stop with the Step 1 report.

### Step 3: Write the SQL

- Fill the file with a `--` header in the style of `20261102090000_pipeline_steps.sql` (no
  em-dashes) and the widened constraint, statuses in the order of `REEL_STATUSES` in
  `apps/studio/src/lib/reels.ts`:
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

### Step 4: Apply to the ADW stack and run the DB, gate and E2E suites

- `.adw/supabase-stack reset` (if it fails, report its error and stop; never reset any other way,
  never touch the developer's stack).
- Run the Validation commands below, in order. `test:db` must now pass
  `pipeline-statuses.test.ts > accepts each step's reel status` for all three new statuses, and the
  studio upload spec must show the six `..., reused` lines then `processed`. Fix any failure at its
  cause; never weaken a test, a type or a rule.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `ls supabase/migrations | tail -1`: prints the new `<stamp>_pipeline_background_head_previews.sql`, with `<stamp>` greater than `20261102090000`.
2. `.adw/supabase-stack reset`: exit 0, the new migration applied to the ADW stack.
3. `yarn format:check && yarn lint && yarn typecheck && yarn knip && yarn test && yarn build`: the full unfiltered gate the review noted was not run.
4. `yarn turbo run test:db --filter=./apps/studio`: passes (failed before this patch).
5. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: with the `/prepare_app` server already up on PORT 9210 / STUDIO_PORT 9110 (never `CI=1`), landing then studio suites pass, including the upload spec reaching `processed`.

## Patch Scope

**Lines of code to change:** about 20 (one new SQL file)
**Risk level:** low for the schema widening; the patch is blocked (no change) until 2026-11-02 09:00 UTC or an owner-authorized version (rechecked at `date -u` 20261101131129: still blocked)
**Testing required:** ADW stack reset, the full unfiltered gate, `test:db` for the new statuses, and both E2E suites with the upload spec reaching `processed`
