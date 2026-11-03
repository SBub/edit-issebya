# Feature: studio: delete a reel from the list

## Metadata

issue_number: `136`
adw_id: `0c90e622`
issue_json: `{"number":136,"title":"studio: delete a reel from the list (bin icon, confirm, stops a running job, no storage left behind)"}`

## Feature Description

Every reel card in the studio's reels grid (`/studio`) gets a bin button in the card's bottom-right
corner, always visible (not on hover only) on desktop and phone, labelled "Delete reel", with a
tap target of at least 44 by 44 px on a phone. Pressing it never opens the reel. It opens a small
confirm dialog ("Delete this reel? Its versions and files are removed and cannot be restored.")
with Delete and Cancel; only Delete deletes.

A delete removes the reel row and, through the existing `on delete cascade` foreign keys, all its
versions, jobs, steps, change requests (the `change` and `restore` jobs) and exports. Before the row
goes, every storage key the reel has (every `stored_files` row of the reel, deleted or not, plus the
source key and its in-flight multipart upload id) is copied into a new queue table,
`storage_deletions`, which has no foreign key to the reel, so the cascade cannot drop it. The worker
drains that queue between jobs: it deletes each object that no other live `stored_files` row holds
(a shared pipeline cache output stays for the reels that still need it), removes the queue row on
success and keeps it, with a later `not_before`, on failure, so a failed delete is retried by a later
pass and never forgotten.

A reel that is still processing has its running job deleted with it. The worker's lease renewal
(every `renewEveryMs`, 60 s) then matches no row; a new "is the job row gone?" check turns that into
a `JobGone` abort reason (next to the existing `JobCancelled`), the step runner kills the running
tool's process group (ffmpeg, the transcriber, `claude -p`, the `vseg` mask tool) as it already does
on any abort, and the job ends with a new outcome `deleted`: no failure write, no `stepFailed` or
`jobFailed` capture (so no PostHog exception and no dev error log line), and exactly one log line,
`job <id>: reel deleted, stopped`. A write the worker attempts in the short window before the
renewal notices (a step row, a version row, a stored-file record) fails or is queued for removal, and
that failure is checked against the same "gone" test before anything is recorded as an error. An
object uploaded in that window is queued by `record_stored_file`, which now queues the key instead of
failing when the reel no longer exists, so nothing is left behind in storage.

Only the reel's owner can delete it: the studio's server action calls a `security definer`
function, `delete_reel(p_reel_id)`, that deletes only `where owner_id = auth.uid()` (the
`delete_photo` pattern). The list refreshes at once after a delete; the reel page of a deleted reel
shows the existing "Reel not found" page.

## User Story

As the studio owner
I want to delete a reel from my reels grid, including one that is still processing
So that test reels and failed reels stop cluttering my list and stop costing storage

## Problem Statement

The reels grid (`apps/studio/src/app/page.tsx`, tiles from `apps/studio/src/components/ThumbnailGrid.tsx`)
has no way to remove a reel. Deleting the reel row by hand would also drop its `stored_files` rows
through the cascade (`stored_files.reel_id ... on delete cascade`), losing the only record of the R2
objects it holds, so they would stay in storage for good. A running job on a deleted reel would end
as a lost lease, and any write it attempts before noticing would be reported as a failure (a step
failure capture, a PostHog exception, a dev error log line).

## Solution Statement

- Database (one new migration, created with `supabase migration new reel_deletion`):
  - `public.storage_deletions` queue table (no FK to `reels`), RLS on with no policy, `anon` and
    `authenticated` revoked, `service_role` granted select, insert, update, delete (the grants test's
    rule for every public table).
  - `delete_reel(p_reel_id uuid)`: `security definer`, `authenticated` only; locks the owner's reel
    `for update` (so a concurrent `record_stored_file` either commits first and is queued, or waits
    and then finds the reel gone), queues every key of the reel's `stored_files` rows and the
    reel's `source_key` (with `source_upload_id`), then deletes the reel. Raises `P0002` when the
    reel is not the caller's or does not exist.
  - `record_stored_file` returns `boolean`: `true` when the row was recorded (or already live),
    `false` when the reel no longer exists, in which case the key is queued in `storage_deletions`
    instead of raising a foreign key violation.
  - `pending_storage_deletions(p_prefix, p_limit)`: drops queue rows whose key a live
    `stored_files` row (another reel or a photo) holds now, then returns due rows under the prefix.
  - `finish_storage_deletion(p_id)` and `fail_storage_deletion(p_id, p_error)`; all three
    `service_role` only.
- Worker:
  - `lease.ts`: `keepLease` takes an optional `gone()` check. A renewal that matched no row calls it;
    a gone job aborts with `JobGone`, else with "lease lost" as today. `checkGone()` on the keeper
    checks at once (like `checkCancelled`). `isJobGone(signal)` beside `isJobCancelled`.
  - `queue.ts`: `jobGone(db, jobId)` (one read of the job's id; no row means gone).
  - `run-job.ts`: outcome `deleted`; the catch, `finish`, `fail`, `refuse` and `wait` paths check
    `checkGone()` before treating anything as a failure or a lost lease; one log line
    `job <id>: reel deleted, stopped` (`photo deleted` for a `describe_photo` job, whose photo
    `delete_photo` removed).
  - `step-runner.ts`: `StepContext.checkGone`; `withStep`'s catch checks it before writing a failed
    row or calling `errors.stepFailed`.
  - `stored-files.ts`: `record` throws a `TargetGone` error when `record_stored_file` returns false
    (the key is already queued), so the job stops through the gone path.
  - New `storage-deletions.ts`: the queue (`supabaseStorageDeletions`) and `runStorageDeletions`,
    wired into `main.ts` before each claim and into the poll so a quiet worker still drains it.
- Studio:
  - `lib/reel-server.ts`: `deleteReel(deps, { reelId })` (id check, signed in, `delete_reel` RPC,
    `P0002` to `not-found`, other errors reported through `reportFailure`).
  - `app/reel-actions.ts`: the `"use server"` action.
  - `components/DeleteReelButton.tsx`: the bin button, the native confirm `<dialog>`, the action
    call and `router.refresh()`.
  - `ThumbnailGrid.tsx`: an optional `corner` node per item, rendered as a sibling of the tile's
    link (never inside it), absolutely positioned at the card's bottom-right corner.

## Relevant Files

Use these files to implement the feature:

- `AGENTS.md` - repository rules (migration rule, grants per role, no em-dashes, docs and spec rules).
- `.adw/project.md` - the ADW profile; its Tests section lists every DB test and studio spec and
  must name the new ones.
- `docs/conditional-docs.md` - doc index; the `studio.md` and `storage.md` lines get the new terms.
- `app_docs/studio.md` - the studio doc (Reels, Jobs, steps and the lease, Table grants, Worker,
  Testing, Rules): the list's delete, the `deleted` outcome.
- `app_docs/storage.md` - stored files, slimming, Rules ("Never delete a `source`, `kept` or
  `version` file, except a photo's files ..." must gain the reel delete exception in the same commit).
- `app_docs/error-tracking.md` - what is captured; a job stopped because its reel was deleted is not.
- `app_docs/photo-library.md` - `delete_photo`, the precedent for an owner delete through a
  `security definer` function.
- `app_docs/studio-reel-layout.md` - the reels thumbnail grid section (the bin in each tile).
- `app_docs/failures.md` - job outcomes and the lease; mention `deleted` beside `lost` and
  `cancelled` if it lists them.
- `supabase/migrations/20261101233625_storage_records.sql` - `stored_files`, `record_stored_file`,
  slimming functions and their grants (the pattern for the new functions).
- `supabase/migrations/20261102191719_photo_library.sql` - `delete_photo`, `record_photo_file`,
  `stored_files_target_check` (reel or photo), the latest `slim_rebuildable_files`.
- `supabase/migrations/20261102121556_service_role_table_grants.sql` - the per-role table grants
  rule the new table follows.
- `supabase/migrations/20261031174750_job_queue.sql`, `20261101153653_versions.sql`,
  `20261101194557_export_render_jobs.sql`, `20261101212954_multipart_upload.sql` - the cascades the
  delete relies on and `reels.source_upload_id`.
- `apps/worker/src/lease.ts`, `lease.test.ts` - `keepLease`, `JobCancelled`, its tests.
- `apps/worker/src/run-job.ts`, `run-job.test.ts` - outcomes and the lost and cancelled paths.
- `apps/worker/src/step-runner.ts`, `step-runner.test.ts` - `withStep`, `spawnChild` (process group
  kill on abort), the existing "kills the process group on abort" test with its pid file.
- `apps/worker/src/queue.ts` - `renewLease`, `jobCancelled` (pattern for `jobGone`).
- `apps/worker/src/process-job.ts` - wires `runJob`; passes `gone` and `checkGone`.
- `apps/worker/src/stored-files.ts`, `stored-files.test.ts` - `supabaseStoredFiles.record`,
  `recordingStorage`.
- `apps/worker/src/slimming.ts`, `slimming.test.ts` - the pattern for a storage pass and its tests.
- `apps/worker/src/main.ts` - the drain's claim hook (slimmer) and the poll.
- `apps/worker/src/once.ts` - the exit code by outcome.
- `apps/worker/src/telemetry.ts` - `endJobSpan` (only `failed` and `refused` are errors; `deleted`
  stays ok).
- `apps/worker/src/error-tracking.ts`, `dev-error-log.ts` - `stepFailed` and `jobFailed` write the
  dev error log; the gone path must never call them.
- `apps/worker/src/ai.ts`, `cutout/ensure-cutouts.ts`, `photos/describe-photo.ts`,
  `pipeline/run-pipeline.ts`, `render/render-step.ts` - confirm every long tool runs through
  `spawnTool` with `ctx.signal` (so the abort kills it).
- `apps/studio/src/app/page.tsx` - the reels grid; builds `ThumbnailGridItem`s.
- `apps/studio/src/components/ThumbnailGrid.tsx` - the shared grid (reels and photo library).
- `apps/studio/src/components/PhotoDialog.tsx`, `UploadDialog.tsx` - native `<dialog>` and in-dialog
  confirm patterns.
- `apps/studio/src/app/photo-actions.ts`, `apps/studio/src/lib/photo-server.ts`,
  `photo-server.test.ts` - server action wrappers, `deletePhoto`, answers, `reportFailure`, and
  their unit test with a fake Supabase client.
- `apps/studio/src/lib/reels.ts` - `isReelId`.
- `apps/studio/src/app/reels/[id]/page.tsx`, `apps/studio/src/app/not-found.tsx` - the reel page's
  `notFound()` and the "Reel not found" heading.
- `apps/studio/e2e/reels.spec.ts` - the reels grid spec (seeding with `insertReel`, sign in, tiles).
- `apps/studio/test-support/fixtures.ts`, `rows.ts`, `local-supabase.ts` - users, reels, admin client.
- `apps/studio/db-tests/photos.test.ts`, `stored-files.test.ts`, `grants.test.ts`, `rls.test.ts` -
  DB test patterns (`delete_photo` RLS, `record_stored_file`, per-role grants).
- `node_modules/next/dist/docs/` - read the server actions and `router.refresh` guides before the
  studio work.

### New Files

- `supabase/migrations/<stamped>_reel_deletion.sql` - created by `supabase migration new reel_deletion`.
- `apps/worker/src/storage-deletions.ts` - the queue interface, its Supabase implementation and
  `runStorageDeletions`.
- `apps/worker/src/storage-deletions.test.ts` - removes, keeps a failed row for retry, retries it.
- `apps/worker/src/reel-deleted.test.ts` - a job whose row disappears mid-step (real child process).
- `apps/studio/src/lib/reel-server.ts` - `deleteReel`.
- `apps/studio/src/lib/reel-server.test.ts` - its unit test.
- `apps/studio/src/app/reel-actions.ts` - the server action.
- `apps/studio/src/components/DeleteReelButton.tsx` - bin button and confirm dialog.
- `apps/studio/db-tests/reel-deletion.test.ts` - `delete_reel`, RLS, queue, `record_stored_file` on a
  deleted reel, the queue functions.
- `apps/studio/e2e/delete-reel.spec.ts` - the browser spec.

## Implementation Plan

### Phase 1: Foundation

The migration: the `storage_deletions` queue, `delete_reel`, the new `record_stored_file`, and the
three worker queue functions, with explicit grants per role, and the DB test proving the delete,
the RLS, the queue and the retry. Reset the ADW stack and run `test:db` before building on it.

### Phase 2: Core Implementation

The worker: `JobGone` in the lease, `jobGone` in the queue module, the `deleted` outcome in
`runJob`, the gone check in `withStep`, `TargetGone` from `record`, and the storage deletion pass.
Unit tests for each, including the real child process test.

### Phase 3: Integration

The studio: `deleteReel`, the action, `DeleteReelButton`, the `corner` slot in `ThumbnailGrid`, the
reels page wiring, the E2E spec. Then the docs and the profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `AGENTS.md`, `app_docs/studio.md`, `app_docs/storage.md`, `app_docs/error-tracking.md`,
  `app_docs/photo-library.md` (Rules), `app_docs/studio-reel-layout.md` (the reels grid section),
  and the Next 16 guides on server actions and `router.refresh` under `node_modules/next/dist/docs/`.

### 2. Create the migration

- Run `supabase migration new reel_deletion` from the root (the only allowed `supabase` command
  besides `.adw/supabase-stack reset`). Never hand-pick the version.
- In it, with a header comment explaining the design (keys copied into a queue that outlives the
  reel, the worker removes them between jobs, a failed delete is retried):
  - `create table public.storage_deletions`: `id uuid primary key default gen_random_uuid()`,
    `r2_key text not null unique check (length(r2_key) between 1 and 512)`, `upload_id text`
    (same check as `reels.source_upload_id`), `reel_id uuid` (no FK, for tracing only),
    `queued_at timestamptz not null default now()`, `not_before timestamptz not null default now()`,
    `attempts int not null default 0`, `last_error text check (last_error is null or
char_length(last_error) <= 500)`. Index on `(not_before)`.
  - `alter table ... enable row level security;` no policy. `revoke all ... from anon,
authenticated;` `grant select, insert, update, delete ... to service_role;` (the grants test's
    rule: service_role holds all four on every public table, the others what RLS needs: nothing).
    Not in the Realtime publication, not PostHog-synced.
  - `delete_reel(p_reel_id uuid) returns void`, `language plpgsql security definer set search_path
= ''`: `select source_key, source_upload_id into ... from public.reels where id = p_reel_id and
owner_id = (select auth.uid()) for update;` `if not found then raise exception 'no reel of yours
with this id' using errcode = 'P0002';` then `insert into public.storage_deletions (r2_key,
reel_id) select distinct r2_key, p_reel_id from public.stored_files where reel_id = p_reel_id
on conflict (r2_key) do nothing;` then the source key (when not null) with its upload id
    (`on conflict (r2_key) do update set upload_id = coalesce(excluded.upload_id,
storage_deletions.upload_id), not_before = least(...)`), then `delete from public.reels where
id = p_reel_id;`. `revoke execute ... from public, anon, service_role; grant execute ... to
authenticated;`.
  - `drop function public.record_stored_file(uuid, text, text, text, bigint);` and recreate it
    `returns boolean`, `language plpgsql security definer set search_path = ''`: `insert ... on
conflict (reel_id, r2_key) where deleted_at is null do nothing; return true;` with `exception
when foreign_key_violation then insert into public.storage_deletions (r2_key, reel_id) values
(p_r2_key, p_reel_id) on conflict (r2_key) do nothing; return false;`. Re-apply the grants
    (`service_role` only). Keep the same arguments and the same `on conflict` target as
    `20261102191719_photo_library.sql` defines for reel rows (check the live index predicate there).
  - `pending_storage_deletions(p_prefix text, p_limit int) returns table (id uuid, r2_key text,
upload_id text)`, plpgsql: first `delete from public.storage_deletions d where exists (select 1
from public.stored_files f where f.r2_key = d.r2_key and f.deleted_at is null)` (a key another
    reel or a photo holds now stays in storage), then return `starts_with(r2_key, p_prefix) and
not_before <= now()` ordered by `queued_at, id` limited to `p_limit` (checked 1 to 1000).
  - `finish_storage_deletion(p_id uuid) returns void`: deletes the row.
  - `fail_storage_deletion(p_id uuid, p_error text) returns void`: `attempts + 1`,
    `last_error = left(p_error, 500)`, `not_before = now() + interval '10 minutes'`.
  - The three queue functions: `security definer`, `set search_path = ''`, revoke from `public,
anon, authenticated`, grant to `service_role`.
- No em-dashes in comments.

### 3. DB test `apps/studio/db-tests/reel-deletion.test.ts`

- Model it on `photos.test.ts` and `stored-files.test.ts` (users from the admin client, a signed-in
  client per user, rolled back or cleaned up rows; `pg` for direct SQL where they use it).
- Cases:
  - The owner's `delete_reel` removes the reel and its versions, jobs (a running one included), steps,
    exports and stored file rows (seed one of each; reuse the existing seeding helpers).
  - Every key of the reel's `stored_files` rows (live and already deleted) and the `source_key`
    with its `source_upload_id` (an `uploading` reel) has one `storage_deletions` row afterwards.
  - Another user's `delete_reel` on the reel raises `P0002` and changes nothing; `anon` has no
    execute; `authenticated` cannot select, insert, update or delete `storage_deletions`.
  - `record_stored_file` on a deleted reel returns `false` and queues the key; on a live reel it
    returns `true` and records once (a second call adds nothing).
  - `pending_storage_deletions` drops a queued key another reel still holds live (a shared cache
    key), returns only rows under the prefix and due, honours the limit.
  - `fail_storage_deletion` keeps the row with `attempts = 1`, its error and a `not_before` ten
    minutes on (not returned by the next `pending` call); `finish_storage_deletion` removes it.
- Extend `grants.test.ts`: add `storage_deletions` to the table list it checks if that list is
  explicit, and keep its expectations for `anon` and `authenticated` (none).
- Run `.adw/supabase-stack reset` then `yarn turbo run test:db --filter=./apps/studio`.

### 4. Worker: the gone check in the lease and queue

- `apps/worker/src/queue.ts`: `jobGone(db, jobId): Promise<boolean>`: `select id from jobs where
id = jobId limit 1`; no row is `true`; an error throws.
- `apps/worker/src/lease.ts`: `class JobGone extends Error` ("job deleted"), `isJobGone(signal)`.
  `keepLease({ ..., gone? })`: when a renewal returns false and `gone` is given, call it; `true`
  aborts with `JobGone`, `false` or a throw aborts with `lease lost` as today. A renewal that throws
  stays `lease lost`. `LeaseKeeper.checkGone()`: true at once when already gone; without `gone`
  false; otherwise calls it (a failed call is not gone) and aborts with `JobGone` on true.
- `lease.test.ts`: renewal false plus gone true aborts with `JobGone` after one renewal and stops
  the timers; renewal false plus gone false stays `lease lost`; `checkGone` aborts at once.

### 5. Worker: the `deleted` outcome

- `apps/worker/src/run-job.ts`: `JobOutcome` adds `"deleted"`; `RunJobDeps.gone?`;
  `keepLease({ ..., gone })`; `work` also receives `checkGone`. `stopped()` returns `deleted` for a
  `JobGone` reason and logs exactly `job ${job.id}: reel deleted, stopped` (`photo deleted, stopped`
  when `job.reel_id` is null). In the catch, before anything else: `if (lease.signal.aborted ||
(await lease.checkGone())) return stopped();`. When `finish`, `fail`, `refuse` or `wait`
  returns false, check `checkGone()` first and return `deleted` (without the lease lost line).
  `errors.jobFailed` is never called on the gone path.
- `apps/worker/src/step-runner.ts`: `StepContext.checkGone?: () => Promise<boolean>`; in
  `withStep`'s catch, `if (ctx.signal.aborted || (await ctx.checkGone?.())) throw error;` before the
  failed row, the waiting row and `errors.stepFailed`. Update the comments.
- `apps/worker/src/stored-files.ts`: `record` reads the RPC's boolean for a reel row; `false` throws
  `TargetGone` (exported only if a test or caller needs it; knip must stay green). Photo rows
  (`record_photo_file`) unchanged.
- `apps/worker/src/process-job.ts`: pass `gone: () => jobGone(db, job.id)` and put `checkGone` in
  the step context.
- `apps/worker/src/once.ts`: exit 0 for `deleted` as for `done` (the job did not fail); document it
  in the file's header comment.
- Grep every `errors.` and `steps.failed` call under `apps/worker/src` and confirm none runs on the
  gone path; grep for `spawn(` and confirm every long tool (ffmpeg, the transcriber, `claude -p`,
  `vseg`, HyperFrames) runs through `spawnTool` with `ctx.signal`. `plainTool` in `ai.ts` is the
  doctor's only. If any step tool is spawned without the signal, route it through `spawnTool`.
- `run-job.test.ts`: `deleted` when the renewal finds the row gone; `deleted` when the work throws
  (a foreign key error) and `checkGone` is true, with `fail`, `finish`, `refuse`, `wait` and
  `errors.jobFailed` never called; `deleted` when `finish` returns false and the row is gone; the
  log holds exactly one `job <id>: reel deleted, stopped` and no `lease lost` line.
- `step-runner.test.ts`: a step whose body throws while `checkGone` is true writes no failed row
  and calls no `stepFailed`.
- `stored-files.test.ts`: `record` throws `TargetGone` when the RPC answers `false`.

### 6. Worker: the job-gone integration unit test `apps/worker/src/reel-deleted.test.ts`

- Model it on `step-runner.test.ts`'s "kills the process group on abort" test (a node child writing
  its pid to a file, then sleeping 30 s) and `run-job.test.ts`'s `deps()`.
- `runJob` with `renewEveryMs: 100`, a recording fake `StepStore`, a recording fake `ErrorTracker`
  (every method a `vi.fn`), and a `work` that runs `runStep` on the sleeping child. Once the pid
  file exists, flip a `deleted` flag: `renew` returns false and `gone` returns true from then on.
- Assert: the outcome is `deleted` within two renewal periods plus the step runner's kill grace
  (`KILL_AFTER_MS`); `process.kill(pid, 0)` throws (the child is gone); the step store got `start`
  once and nothing after (no `done`, `failed`, `waiting`, no second `start`); every error tracker
  method was never called; `fail` and `finish` were never called; the log holds exactly one
  `job <id>: reel deleted, stopped` line.
- Also assert a stored-file record attempted after the flag (a work variant that calls a fake
  `records.record` throwing `TargetGone`) ends `deleted` with no failure and no capture.

### 7. Worker: the storage deletion pass `apps/worker/src/storage-deletions.ts`

- `interface StorageDeletionQueue { pending(prefix, limit): Promise<PendingDeletion[]>; done(id):
Promise<void>; failed(id, message): Promise<void> }` and `supabaseStorageDeletions(db)` over the
  three RPCs.
- `runStorageDeletions({ queue, storage, keyPrefix, limit = 200, log })`: for each pending row,
  `abortMultipartUpload(key, { uploadId })` when `upload_id` is set (ignore a "no such upload"),
  then `storage.delete(key)` (the raw storage, never a job's `recordingStorage`); success calls
  `done`, a failure calls `failed` with the error's message and logs
  `storage deletions: <key> not deleted: <message>`, and the pass goes on. Log
  `storage deletions: <n> objects removed, <m> failed` only when something was pending. Returns the
  counts; never throws on a single object (a failed `pending` call throws, the caller logs it).
- `apps/worker/src/main.ts`: in the drain's `claim`, run the pass (caught and logged like the
  slimmer, never during a job) before `slimmer.maybeRun()`; in the poll, also `drainer.signal()`
  when `queue.pending(prefix, 1)` returns a row, so a worker with no jobs still drains the queue.
  Update the header comment. `once` stays without it (it never slims either).
- `storage-deletions.test.ts` (model on `slimming.test.ts`, folder fake or a stub `Storage`):
  every pending key is deleted and `done` once; an upload id aborts the multipart upload first; a
  failing delete calls `failed` (not `done`), the other keys still go, and a second pass with a
  working storage deletes it and calls `done`.

### 8. Studio: the server side

- `apps/studio/src/lib/reel-server.ts`: `deleteReel(deps: { supabase, errors }, input: { reelId:
unknown }): Promise<ReelAnswer<{ reelId: string }>>`, the shape of `photo-server.ts`'s answers
  (`ok`, or `not-found`, `failed`, `unavailable`, signed-out). `isReelId` first; signed in; `rpc
("delete_reel", { p_reel_id })`; error code `P0002` is `not-found`; any other error goes to
  `reportFailure` (`studio: reel not deleted`, `reel_id` only) and `failed`. No storage access here:
  the worker removes the objects. No secret key.
- `apps/studio/src/lib/reel-server.test.ts`: a fake Supabase client (as `photo-server.test.ts`):
  bad id, signed out, `P0002`, another error reported, success calling the RPC with the id.
- `apps/studio/src/app/reel-actions.ts`: `"use server"`, `deleteReel(reelId: string)` building the
  client per call (`createSupabaseServerClient`, `serverErrorCapture`), `unavailable` without a
  client.

### 9. Studio: the bin button and the grid

- `apps/studio/src/components/ThumbnailGrid.tsx`: `ThumbnailGridItem.corner?: ReactNode`. The `li`
  becomes `relative`; when `corner` is set, render it after the link or button in a wrapper
  `absolute right-0 bottom-0` (a sibling, never nested in the link, so its click never navigates),
  and give the title and meta lines right padding so text never runs under it. Nothing reel-specific
  in the grid; the photo library is unchanged.
- `apps/studio/src/components/DeleteReelButton.tsx` (`"use client"`, props `reelId`, `title`):
  - The button: `type="button"`, `aria-label="Delete reel"`, `data-testid="delete-reel"`, an inline
    bin SVG (`aria-hidden`), always visible (no `opacity-0`, no `group-hover` gate), at least
    `size-11` (44 px) on a phone, `sm:size-8` allowed above, on a dark rounded background that reads
    on any thumbnail, focus-visible outline. Clicking opens the dialog with `showModal()`.
  - A native `<dialog aria-labelledby>` (the `UploadDialog` pattern): the text
    `Delete this reel? Its versions and files are removed and cannot be restored.`, then Cancel
    (closes, nothing else) and Delete (`data-testid="confirm-delete-reel"`, danger tone). Delete
    disables both buttons while pending (`useTransition`), calls the action, and on `ok` (or
    `not-found`: already gone) closes and calls `router.refresh()`; on failure shows one line
    `The reel was not deleted. Try again.` (`role="alert"`) and stays open. Escape and the backdrop
    close like Cancel.
  - Before writing it, read `no-unnecessary-effects` guidance: no effect for this; event handlers only.
- `apps/studio/src/app/page.tsx`: every reel tile gets `corner: <DeleteReelButton reelId={reel.id}
title={reelName(reel)} />`.

### 10. E2E spec `apps/studio/e2e/delete-reel.spec.ts`

- Model it on `reels.spec.ts` (admin client, `createTestUser`, `insertReel`, `signInLink`, serial,
  cleanup in `afterAll` including the spec's own `storage_deletions` rows by `reel_id`).
- Seed one owner with two reels (`keep-me.mov`, `delete-me.mov`, the latter with a `source_key`
  and a `stored_files` row through the admin client or `record_stored_file`) and a queued `process`
  job on `delete-me.mov` (the cascade case; the worker is not run).
- Tests, each at 1440x900 and at 390x844:
  - The bin is visible on every tile without hover (move the mouse to a corner of the page first),
    has the accessible name `Delete reel`, sits inside the tile's box at its bottom-right (its right
    and bottom edges within 4 px of the `li`'s, measured with `boundingBox()`), and at 390x844 is
    at least 44 by 44 px.
  - Clicking the bin opens the dialog with the exact text and leaves the URL on the list.
  - Cancel closes the dialog; the tile count is unchanged and the reel row is still in the database.
- Then once (at 1440x900): Delete removes the tile from the grid (expect the count to drop without
  a reload), the reel row and its job are gone (`reelStatus` null, no `jobs` row), its source key
  has a `storage_deletions` row, and `page.goto("/studio/reels/<id>")` shows the `Reel not found`
  heading.
- The landing-page address and `workers: 1` as in every studio spec; no worker spawned.

### 11. Documentation and the profile

- `app_docs/studio.md`: Reels (the bin, the confirm, `delete_reel`, the list refresh, the reel page
  of a deleted reel is a 404), Jobs, steps and the lease (`JobGone`, outcome `deleted`, its one log
  line, within one renewal), Table grants (`storage_deletions`), Worker (the deletion pass before
  each claim and on the poll), Testing (the new unit, DB and E2E files), Rules (only the owner
  deletes, through `delete_reel`; a deleted reel's job is never a failure).
- `app_docs/storage.md`: a section "Deleting a reel" (what a delete removes, the queue, the shared
  key rule, the retry with `not_before` ten minutes on, `record_stored_file`'s `false`), Database
  (the new table and functions), Testing, and the Rules: change "Never delete a `source`, `kept` or
  `version` file, except a photo's files when its owner deletes the photo" to also allow a reel's
  files when its owner deletes the reel and no other live row holds the key; add "Never delete a
  queued key's row before its object is deleted" and "Never delete a key another live
  `stored_files` row holds".
- `app_docs/error-tracking.md`: a job stopped because its reel (or photo) was deleted is not
  captured and writes no dev error log line.
- `app_docs/studio-reel-layout.md`: the reels grid section names the bin in each tile's
  bottom-right corner.
- `docs/conditional-docs.md`: add `delete_reel`, the bin, `storage_deletions` and the deletion
  pass to the `studio.md` and `storage.md` lines.
- `.adw/project.md` Tests section: add `reel-deletion.test.ts` to the DB list and
  `delete-reel.spec.ts` to the studio E2E list (no heading changes).
- No em-dashes anywhere.

### 12. Run the validation commands

- Run every command in `Validation Commands`, in order, and fix anything that fails.

## Testing Strategy

### Unit Tests

- `apps/worker/src/lease.test.ts`: `JobGone` after a renewal that found no row; `lease lost`
  otherwise; `checkGone`.
- `apps/worker/src/run-job.test.ts`: the `deleted` outcome from the renewal, from a thrown error,
  from `finish` false; nothing written, nothing captured, one log line.
- `apps/worker/src/step-runner.test.ts`: no failed row and no `stepFailed` when gone.
- `apps/worker/src/reel-deleted.test.ts`: the real child process killed within one renewal.
- `apps/worker/src/stored-files.test.ts`: `TargetGone` on a `false` record.
- `apps/worker/src/storage-deletions.test.ts`: removal, multipart abort, failure kept and retried.
- `apps/studio/src/lib/reel-server.test.ts`: the action's answers.

### Test Coverage

- Unit (worker) `reel-deleted.test.ts`: a job whose row disappears mid-step stops within one renewal,
  its child is killed, no further rows are written and no failure or error is recorded; today it
  ends `lost` and a write in the window is captured as a failure.
- Unit (worker) `lease.test.ts`, `run-job.test.ts`, `step-runner.test.ts`: the `JobGone` reason and
  the `deleted` outcome, which do not exist today.
- Unit (worker) `storage-deletions.test.ts`: a queued key is deleted, and a failed delete is kept and
  retried; there is no deletion pass today.
- Unit (studio) `reel-server.test.ts`: the delete action's answers and its reporting.
- DB `reel-deletion.test.ts`: `delete_reel` deletes everything and queues every key; another user
  cannot delete (RLS test of the issue); `record_stored_file` queues a deleted reel's key; the queue's
  held-key, due and retry rules. None of these functions exist today.
- E2E (studio) `delete-reel.spec.ts`: the bin visible without hover at desktop and phone widths,
  Cancel keeps the reel, Delete removes it from the list, the reel page then shows not found; no
  bin exists today.

### Edge Cases

- A reel deleted while its job is queued (cascade only, the worker never claims it).
- A reel deleted while its job runs a long tool: the tool is killed, the job ends `deleted`.
- A reel deleted between `claim_job` and the first step: `readReelSize` returns unknown, the first
  `steps.start` fails, the gone check stops the job.
- A write in the window before the renewal: a step row insert fails, a `stored_files` record queues
  its key and the job stops, a version save fails; none is captured.
- A reel whose cache outputs another reel shares: the shared keys stay in storage; only the deleted
  reel's own keys go.
- A reel still `uploading`: its multipart upload is aborted and the source key deleted.
- A storage delete that fails: the row stays with `attempts`, `last_error` and `not_before`; a later
  pass retries it.
- Deleting twice (a double click or two tabs): the second call answers `not-found` and the list
  refreshes anyway.
- Another user's reel id or a malformed id: `not-found`, nothing changes.
- A `describe_photo` job whose photo `delete_photo` removed: the same gone path, logged as
  `photo deleted, stopped`.
- The photo library's grid keeps no corner button (no `corner` given).

## Acceptance Criteria

- Every reel card shows a bin button labelled `Delete reel` in its bottom-right corner without
  hover at 1440x900 and 390x844, at least 44 by 44 px on the phone; clicking it does not open the
  reel.
- The confirm dialog reads `Delete this reel? Its versions and files are removed and cannot be
restored.` with Delete and Cancel; Cancel changes nothing.
- Delete removes the reel, its versions, jobs, steps, change requests and exports; the list updates
  at once; the reel page then shows `Reel not found`.
- Every storage key the reel had (and its in-flight upload) has a `storage_deletions` row until the
  worker deletes the object; a key another reel still holds is never deleted; a failed delete is
  retried by a later pass.
- A running job of a deleted reel stops within one lease renewal, its tool's process group is
  killed, it writes nothing more, it records no failure, no PostHog exception and no dev error log
  line, and the worker logs one line `job <id>: reel deleted, stopped` and goes on to the next job.
- Only the owner can delete (`delete_reel` checks `auth.uid()`; another user gets `P0002`; `anon`
  cannot execute it); the migration grants each role explicitly.
- `app_docs/studio.md` and `app_docs/storage.md` describe the delete; the storage Rule is changed in
  the same commit.
- Lint, typecheck, knip, format, unit, DB, build and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker` - lint both changed apps.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker` - types, including the
  new `JobOutcome` member everywhere it is switched on.
- `yarn knip` - no unused export from the new modules.
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker` - unit tests, including the
  migration version guard over the new migration and the worker's real child process test.
- `.adw/supabase-stack reset` - apply the new migration to the ADW stack (the only allowed way).
- `yarn turbo run test:db --filter=./apps/studio` - `reel-deletion.test.ts`, the grants test and
  every existing DB test against the new schema (the changed `record_stored_file` included).
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker` - the studio builds (the
  worker's build check is its typecheck).

## Notes

- No new dependency.
- The worker's step and tool tests (`test:tools`) are not affected: no tool's arguments change.
- The issue's owner acceptance (delete a finished reel and a processing reel in dev, the worker log
  shows the stop and no error) is an owner step after merge, as is applying the migration to the
  hosted project.
- Why a queue table instead of marking `stored_files` deleted: the reel's rows go with the reel
  through the cascade, and `stored_files` must name a reel or a photo (`stored_files_target_check`),
  so the keys need a home with no foreign key to the reel. The queue keeps the "record before
  delete" rule: a row leaves the queue only after its object is gone.
- Why not delete objects in the studio (as `deletePhoto` does): the issue wants a retried, never
  forgotten cleanup, and objects a running job writes after the delete must be caught too; the
  worker already owns slimming.
- A multipart upload a killed tool or an aborted pipeline leaves incomplete (rare, only on a
  lost lease or a delete mid-upload) is not in the queue; the bucket's lifecycle rule for
  incomplete uploads is the backstop, as for a lost lease today.
- Cross-worker race (one worker's deletion pass against another worker's job writing the same
  shared cache key) is the same future work as slimming's; within one worker the pass runs only
  between jobs.
- `once` does not run the deletion pass, so specs never delete objects through the worker; the
  pass is covered by `storage-deletions.test.ts` and the queue rules by the DB test.
