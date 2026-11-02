# Storage records, slimming, scratch cleanup and the disk guard

**Specifications:**

- specs/issue-37-adw-203f77eb-sdlc_planner-storage-records-slimming-disk-guard.md

## Overview

Every object a job or an upload writes to R2 gets a `stored_files` row: its reel, the step that
made it, its size and kind, and when it was deleted. Heavy rebuildable files are deleted seven days
after the last export of every reel that holds them, and expired exports are deleted. Each job's
scratch folder is removed after the job, whatever happened. No job is claimed while the worker's
disk has less than `WORKER_MIN_FREE_DISK_GB` free, and the studio shows why under a queued job.

## How it works

### Database

`supabase/migrations/20261101233625_storage_records.sql`:

- `stored_files`: `id`, `reel_id`, `owner_id`, `step`, `r2_key`, `bytes`, `kind`, `created_at`,
  `deleted_at`. Kinds: `source`, `kept`, `rebuildable`, `version`, `export`.
- One undeleted row per `(reel_id, r2_key)` (partial unique index `stored_files_live_idx`). An
  output two reels share (the same fingerprint) has a row per reel that needs it, so space per reel
  counts it for each reel, and the total counts distinct live keys.
- `owner_id` is set from the reel by a `before insert` trigger, never trusted from the caller.
- An update trigger allows only `deleted_at` going from null to a value, with every other column
  unchanged; anything else raises. Rows still go with their reel through the cascade.
- RLS: the owner selects their own rows; `authenticated` has no insert, update or delete; `anon`
  has nothing.
- `record_stored_file(p_reel_id, p_r2_key, p_step, p_kind, p_bytes)` inserts unless a live row for
  that reel and key exists (a retried job adds nothing).
- `slim_rebuildable_files(p_now, p_prefix)` and `expire_export_files(p_now, p_prefix)` each select
  what may be deleted under the prefix, mark `deleted_at` and return the keys and bytes, in one
  statement.
- All three functions are `security definer` and executable by `service_role` only.
- `finish_upload` now also records the raw footage's `source` row (step `upload`, the size from
  storage) in the same transaction, once (`app_docs/upload.md`).
- `worker_status`: `worker_id`, `free_disk_bytes`, `waiting_reason`, `updated_at`, one row per
  worker. `authenticated` selects every row (no reel data in it), only the service role writes,
  `anon` has nothing. It is in the `supabase_realtime` publication.

### Recording every write

- `apps/worker/src/stored-files.ts`: `classifyKey(prefix, key)` derives the kind and step from the
  key layout alone: a pipeline output `cache/<step>/<fingerprint>/<file>` (`kept` or `rebuildable`
  by the step's output tag, `retentionOf`), `reels/<reel>/versions/<id>.json` (`version`),
  `exports/<reel>/<id>.mp4` (`export`, step `render`) and `reels/<reel>/source/original.<ext>`
  (`source`, step `upload`). An unknown key throws before anything is written.
- `recordingStorage(storage, { records, reelId, keyPrefix })` wraps `Storage` for a job. Every
  write method (`put`, `putIfAbsent`, `putFileIfAbsent`, `completeMultipartUpload`) records a row
  for the job's reel after it succeeds, on `written` and on `exists` alike (the reel needs the
  object now too). Reads pass through; `delete` through it throws.
- `STORAGE_METHODS` is a `Record<keyof Storage, "read" | "write" | "refused">`, so a new method on
  the interface fails typecheck until it is classified.
- A pipeline cache hit records each output's row from the `head` it already made
  (`run-pipeline.ts`, `recordStored`).
- A failed record fails the job; the row is idempotent, so the retry records it.

### What is kept and what is deleted

- Kept forever: the source, the preview copies and every other `kept` output, and the versions.
- Deleted: the three `rebuildable` outputs (`convert`'s `converted.mp4`, `retime`'s `source.mp4`,
  `remove_background`'s `subject.webm`) once every reel holding the key was last exported more than
  seven days ago. A reel never exported, or exported within seven days, keeps the file for everyone.
- Deleted: export files once their export's `expires_at` has passed.
- The next export rebuilds whatever rebuildable output is missing: `convert`, `retime` and
  `remove_background` re-run from their fingerprints, and the kept outputs stay cache hits.

### Slimming

- `apps/worker/src/slimming.ts`: `runSlimming` calls `slim_rebuildable_files` and
  `expire_export_files` under `R2_KEY_PREFIX`, then deletes each returned object from the raw
  storage (never a job's). The database marks the deletion first; a failed delete is logged
  (`slimming: <key> not deleted: <message>`) and the pass goes on. Each pass logs
  `slimming: <n> rebuildable files (<size>), <n> expired exports (<size>) deleted`.
- `createSlimmer` runs a pass when at least an hour passed since the last one started (the first
  call always runs) and never throws.
- `apps/worker/src/main.ts` calls it between jobs, before each claim, never during a job. `once`
  never slims.

### Scratch cleanup

- `apps/worker/src/scratch.ts`: `withJobScratch` (used by `process-job.ts`) creates
  `WORKER_SCRATCH_DIR/<job id>`, runs the job in it and removes it in a `finally` (success, failure
  or a lost lease), logging `job <id>: scratch removed, <size> freed`. The pipeline's
  `job-<job id>/` folder lives inside it.
- `sweepStaleScratch` runs at `worker` start-up and removes the UUID-named folders a crashed run
  left behind (`worker: stale scratch of job <id> removed, <size> freed`); anything else there
  stays.
- `apps/worker/src/render/render-call.ts`: `renderScratchEnv` sets `HYPERFRAMES_EXTRACT_CACHE_DIR`,
  `HYPERFRAMES_HISTORY_ROOT` and `TMPDIR` inside the render's folder, so the frame cache, the
  history and the work folders go with the job folder. `hyperframes clean` is not run.

### Disk guard

- `apps/worker/src/disk-guard.ts`: `guardedClaim` (used by `main.ts` and `once.ts`) reads the free
  bytes of the volume holding `WORKER_SCRATCH_DIR` (`statfs`, available blocks times block size).
- Below `WORKER_MIN_FREE_DISK_GB` it never calls `claim_job`: it upserts this worker's
  `worker_status` row with
  `waiting: <x> GB free on the worker's disk, needs <n> GB`, logs it and returns no job. At or
  above the minimum it clears the reason and claims.
- `E2E_MOCK_FREE_DISK_GB` replaces the reading only when `E2E_MOCK_STORAGE` is exactly `"true"`;
  anywhere else it is ignored.

### Studio

- `apps/studio/src/app/reels/[id]/page.tsx` reads the workers' non-null waiting reasons on the
  server (`WORKER_STATUS_COLUMNS`, never the free disk).
- `apps/studio/src/components/LiveReel.tsx` keeps them current with the catch-up read and Realtime
  on `worker_status` (`upsertWorkerStatus`), takes the newest non-null reason (`waitingReasonOf` in
  `apps/studio/src/lib/worker-status.ts`) and shows it under a `queued` job
  (`data-testid="job-waiting"`).

## How to Use

Nothing to do for the owner. What they see:

- While the worker's disk is low, a queued job shows the waiting line under it, and it goes away
  once the worker claims again.
- An export of a reel last exported more than seven days ago first rebuilds the deleted
  rebuildable files, so it takes longer.

## Configuration

- `WORKER_MIN_FREE_DISK_GB` (default 10): the free disk below which the worker claims nothing.
- `WORKER_SCRATCH_DIR` (default the OS temp folder): where job folders live and whose volume the
  guard reads.
- `R2_KEY_PREFIX`: the slimming's scope; a worker only slims under its own prefix.
- `E2E_MOCK_FREE_DISK_GB`: tests only, under `E2E_MOCK_STORAGE=true`.
- The owner's R2 lifecycle rule on `<prefix>exports/` stays as a backstop.

## Testing

- Unit (`yarn test`): `apps/worker/src/stored-files.test.ts`, `scratch.test.ts`,
  `disk-guard.test.ts`, `slimming.test.ts`, `pipeline/definition.test.ts`,
  `pipeline/run-pipeline.test.ts` (hits recorded, the rebuild case), `render/render-call.test.ts`
  and `apps/studio/src/lib/worker-status.test.ts`.
- DB (`yarn test:db`): `apps/studio/db-tests/stored-files.test.ts` (`stored_files` and
  `worker_status` RLS, `record_stored_file`, the seven-day slimming and export expiry with a fixed
  clock, `finish_upload`'s source row).
- E2E: `apps/studio/e2e/upload.spec.ts` checks that every object under the run's prefix and the
  source has exactly one `stored_files` row with its size, kind and step;
  `apps/studio/e2e/disk-guard.spec.ts` runs `once` below the minimum (no claim, the reason shown
  live under the queued job) and above it (claimed, the reason gone).

## Rules

- Never delete a `source`, `kept` or `version` file.
- Never delete a rebuildable file within seven days of the last export of any reel that holds it.
- Always record a deletion in the same statement that selects it.
- Remove the job folder on failure too.
- Never claim a job below `WORKER_MIN_FREE_DISK_GB`.
- Never run `hyperframes clean` from the worker.
- Never write storage from a job except through `recordingStorage`.

## Notes

- `hyperframes clean` is not used: on the pinned 0.8.222 it also sweeps every project in the
  default history root, the shared extract cache and abandoned render folders under the OS temp
  folder, other repositories' caches included. Relocating what a render leaves into the job folder
  is the documented equivalent.
- Three rebuildable files, not two: the pipeline also tags `retime`'s `source.mp4` `rebuildable`,
  and the tags are authoritative.
- Slimming runs only between one worker's jobs. A cross-worker rule (a second worker racing a
  render against a slimming) is future work.
- The heartbeat (`heartbeat_at`, every 5 minutes from `main`) and the offline display now exist
  (`app_docs/status.md`). Stale `worker_status` rows (a worker that went away) still stay until
  that worker writes again. Specs delete their own row.
- `apps/worker/src/make-pipeline-fixtures.ts` and the test seeding helpers write storage directly
  on purpose: they are a dev tool and fixtures, not jobs.
- `transcribe` and `remove_background` also run HyperFrames; scoping their environment the same way
  is a follow-up if the owner's `df` check shows leftovers.
- Owner steps: apply the migration to the hosted project after merge; the manual `df` check and the
  re-export of a reel last exported eight days ago; decide whether never-exported reels are ever
  slimmed.
- Not verified by the pipeline: real R2 deletions and the real disk on the worker machine.
