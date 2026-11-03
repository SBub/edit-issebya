# Patch: document deleting a reel (spec step 11)

## Metadata

adw_id: `0c90e622`
review_change_request: `Issue #1: Spec step 11 (Documentation) is largely not done, and one acceptance criterion depends on it: 'app_docs/studio.md and app_docs/storage.md describe the delete'. app_docs/studio.md, app_docs/error-tracking.md, app_docs/studio-reel-layout.md and docs/conditional-docs.md are untouched; app_docs/storage.md has only its Rules changed (no 'Deleting a reel' section, no Database or Testing entries). Resolution: write the docs step 11 lists. No em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-136-adw-0c90e622-sdlc_planner-delete-reel-from-list.md`
**Issue:** The code, tests, migration, storage Rules and `.adw/project.md` Tests update are on the
branch, but the feature docs do not describe the delete: nothing in `app_docs/` (outside the
storage Rules) mentions `delete_reel`, `storage_deletions`, `JobGone`, the `deleted` outcome, the
deletion pass or the bin, and the doc index does not point at them.
**Solution:** Docs only. Add the step 11 content to `app_docs/studio.md`, `app_docs/storage.md`,
`app_docs/error-tracking.md`, `app_docs/studio-reel-layout.md` and `docs/conditional-docs.md`,
describing what the branch actually implements (facts below are taken from the diff). No code,
test, migration or profile change. Keep the storage Rules already on the branch as they are.

Facts to describe (from the branch):

- Migration `supabase/migrations/20261103201352_reel_deletion.sql`: table `public.storage_deletions`
  (`id`, `r2_key` unique, `upload_id`, `reel_id` for tracing only with no foreign key, `queued_at`,
  `not_before`, `attempts`, `last_error` up to 500 characters), RLS on with one `service_role`
  policy, `revoke all ... from anon, authenticated`, `service_role` gets `select`, `insert`,
  `update`, `delete`.
- `delete_reel(p_reel_id)`: `security definer`, executable by `authenticated` only (revoked from
  `public`, `anon`, `service_role`). Locks the caller's own reel (`owner_id = auth.uid()`, `for
update`), else raises `P0002`. Queues every `stored_files` key of the reel (deleted or not) and the
  source key with its `source_upload_id`, then deletes the reel; versions, jobs, steps, change
  requests, exports and `stored_files` rows go through the existing cascades.
- `record_stored_file` now returns `boolean`: `true` as before; when the reel no longer exists it
  queues the key in `storage_deletions` and returns `false` (it takes `for key share` on the reel, so
  it waits for a concurrent `delete_reel`). The worker's `recordingStorage` then throws `TargetGone`
  (`apps/worker/src/stored-files.ts`).
- `pending_storage_deletions(p_prefix, p_limit)` (limit 1 to 1000) first drops every queued key
  another live `stored_files` row holds (a shared pipeline output, a photo's file), then returns the
  due rows under the prefix, oldest first. `finish_storage_deletion(p_id)` removes the row;
  `fail_storage_deletion(p_id, p_error)` keeps it, adds an attempt, stores the error and sets
  `not_before` ten minutes on. All three `security definer`, `service_role` only.
- `apps/worker/src/storage-deletions.ts`: `runStorageDeletions` aborts an open multipart upload,
  deletes the object, removes the row on success, marks it failed otherwise and goes on; logs
  `storage deletions: <n> objects removed, <m> failed` when it had rows. `main.ts` runs it before
  each claim (between jobs) and, when the poll finds a due row with no job waiting, signals the
  drainer so the pass runs; a failed pass is logged and its keys stay queued. `once` does not run it.
- `apps/worker/src/lease.ts`: `keepLease` takes `gone`; a renewal that matched no row asks whether
  the job's row is gone and aborts with `JobGone` instead of a lost lease (within one renewal);
  `checkGone()` and `isJobGone()`. `process-job.ts` passes `gone: () => jobGone(db, job.id)`
  (`queue.ts`). `run-job.ts`: outcome `deleted`, one log line `job <id>: reel deleted, stopped`
  (`photo deleted` for a photo job), no failure written, no capture, also when a final write
  matched no row. `step-runner.ts`: `withStep` writes no failed row and captures nothing when
  `checkGone` says the row is gone.
- Studio: `apps/studio/src/lib/reel-server.ts` `deleteReel` (id check, signed-out, unavailable,
  `P0002` answers `not-found`, other errors captured as `studio: reel not deleted` and answer
  `failed`), `apps/studio/src/app/reel-actions.ts` server action, `DeleteReelButton.tsx` (bin with
  accessible name `Delete reel`, 44 px on a phone and 32 px from `sm`, always visible; native
  `<dialog>` reading `Delete this reel? Its versions and files are removed and cannot be
restored.` with Cancel and Delete; Cancel, Escape and the backdrop change nothing; after a delete
  or an already gone reel `router.refresh()`; a failure stays in the dialog as an alert),
  `ThumbnailGrid.tsx` optional `corner` per item (a sibling of the tile's link, never inside it, the
  title and meta padded clear of it), `page.tsx` passing the bin as each reel's `corner`. The reel
  page of a deleted reel is the 404 `Reel not found` (`not-found.tsx`).
- Tests: `apps/studio/src/lib/reel-server.test.ts`, `apps/worker/src/storage-deletions.test.ts`,
  `apps/worker/src/reel-deleted.test.ts`, `apps/studio/db-tests/reel-deletion.test.ts` (owner only,
  the cascade, every key queued, `record_stored_file` on a deleted reel, the queue's functions),
  `apps/studio/e2e/delete-reel.spec.ts` (bin at 1440x900 and 390x844, Cancel and Escape keep the
  reel, Delete removes it and its queued job without a reload, source key queued, page then `Reel
not found`); also extended `lease.test.ts`, `run-job.test.ts`, `step-runner.test.ts`,
  `stored-files.test.ts`, `grants.test.ts`.

## Files to Modify

Use these files to implement the patch:

- `app_docs/studio.md`
- `app_docs/storage.md`
- `app_docs/error-tracking.md`
- `app_docs/studio-reel-layout.md`
- `docs/conditional-docs.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: `app_docs/studio.md`

- Reels: add bullets for the migration `20261103201352_reel_deletion.sql` (`delete_reel`, owner only,
  `P0002`, the cascade), `reel-server.ts` `deleteReel` and `reel-actions.ts`, and
  `DeleteReelButton.tsx` (the bin in each tile's bottom-right corner, the confirm dialog text,
  Cancel, Escape and backdrop change nothing, the list refreshes at once). Extend the
  `reels/[id]/page.tsx` bullet: a deleted reel's page is the same 404, `Reel not found`.
- Jobs, steps and the lease: add a bullet after the cancel bullets for `JobGone` (`lease.ts`
  `gone`, `checkGone`, `isJobGone`; `queue.ts` `jobGone`), outcome `deleted` in `run-job.ts`, its
  one log line `job <id>: reel deleted, stopped` (`photo deleted` for a photo job), within one lease
  renewal, the tool's process group killed, nothing more written, no failure row and no capture,
  and `withStep` not failing a step while the row is gone.
- Table grants: add a bullet that `storage_deletions` has RLS with only a `service_role` policy,
  `anon` and `authenticated` revoked, `service_role` its four data privileges, and its functions
  `service_role` only (`delete_reel` `authenticated` only).
- Worker: extend the `main.ts` bullet: before each claim it runs the deletion pass
  (`storage-deletions.ts`, see `app_docs/storage.md`), and the poll signals the drainer when a due
  row waits and no job does; `once` never runs it.
- Testing: add `reel-server.test.ts`, `storage-deletions.test.ts` and `reel-deleted.test.ts` to
  Unit, `reel-deletion.test.ts` to DB integration, `delete-reel.spec.ts` to E2E (with one sentence of
  what it checks).
- Rules: add "Only the owner deletes a reel, and only through `delete_reel`; never delete a `reels`
  row any other way." and "A job whose reel or photo was deleted is never a failure: it ends
  `deleted`, writes no failed row and captures nothing."

### Step 2: `app_docs/storage.md`

- Add a `### Deleting a reel` section under How it works (after "What is kept and what is deleted"
  or after Slimming): what a delete removes (the rows by cascade; every key the reel had, deleted or
  not, plus the source and its open multipart upload, queued in `storage_deletions`), the queue and
  the worker's pass between jobs and on the poll, the shared-key rule (`pending_storage_deletions`
  drops a key another live `stored_files` row holds, so its object stays), the retry
  (`fail_storage_deletion` sets `not_before` ten minutes on, the pass goes on), and
  `record_stored_file` returning `false` and queuing the key when the reel is gone (`TargetGone`,
  the job then ends `deleted`). Note that `once` does not run the pass.
- Database: add the `storage_deletions` table and its columns and grants, change the
  `record_stored_file` bullet to say it returns `boolean` (`false` when the reel is gone, key
  queued), and add `delete_reel`, `pending_storage_deletions`, `finish_storage_deletion` and
  `fail_storage_deletion` with who may execute each.
- Testing: add `apps/worker/src/storage-deletions.test.ts` and `reel-deleted.test.ts` to Unit,
  `apps/studio/db-tests/reel-deletion.test.ts` to DB, `apps/studio/e2e/delete-reel.spec.ts` (source
  key queued) to E2E. Leave the Rules as they are on the branch.

### Step 3: `app_docs/error-tracking.md` and `app_docs/studio-reel-layout.md`

- `error-tracking.md` Worker: add a bullet that a job stopped because its reel or photo was deleted
  (`JobGone`, outcome `deleted`) is not captured, neither as `worker: step failed` nor as `worker:
job failed`, and in Local development error log that it writes no line to `errors.jsonl`. Also
  mention `studio: reel not deleted` where the studio's handled server failures are listed, if such
  a list exists in the Studio and landing page server section or Stable messages.
- `studio-reel-layout.md` Thumbnails and the reels grid: in the `ThumbnailGrid.tsx` bullet, name the
  optional `corner` (a sibling of the tile's link, the title and meta padded clear of it), and in
  the `page.tsx` bullet say the reels pass `DeleteReelButton` as each tile's corner: the bin in
  the bottom-right corner, always visible (no hover), 44 px on a phone (see `app_docs/studio.md`).

### Step 4: `docs/conditional-docs.md`

- `studio.md` line: add `delete_reel`, the reels list's bin (`DeleteReelButton`), `storage_deletions`
  and the worker's deletion pass.
- `storage.md` line: add `delete_reel`, `storage_deletions` and its functions, and the deletion pass
  (`storage-deletions.ts`).
- Optionally add the bin to the `studio-reel-layout.md` line's reels grid clause.
- Check no em-dash was added: `git diff | grep -n "$(printf '\342\200\224')"` prints nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check` - Prettier over the whole repository (the docs are Markdown).
- `yarn knip` - unchanged, confirms nothing else moved.
- `git diff origin/develop...HEAD --stat -- app_docs docs` lists all five doc files, and
  `grep -c "delete_reel\|storage_deletions" app_docs/studio.md app_docs/storage.md` is nonzero for
  both.
- `grep -rn "$(printf '\342\200\224')" app_docs docs .adw/project.md` prints nothing.

No code changes, so lint, typecheck, unit, DB, build and E2E need no rerun beyond what the branch
already passed.

## Patch Scope

**Lines of code to change:** about 60 to 90 lines of Markdown across five files, no code
**Risk level:** low
**Testing required:** format check and the grep checks above; docs only
