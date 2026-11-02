# Patch: add the storage doc and bring the feature docs in step

## Metadata

adw_id: `203f77eb`
review_change_request: `Issue #1: Spec step 12 (Docs and profile) and the acceptance criterion 'app_docs/storage.md exists with a Rules section; docs/conditional-docs.md lists it; the other docs and .adw/project.md are in step' are not met. The diff touches no file under app_docs/ or docs/. Add app_docs/storage.md (Overview, How it works, How to Use, Configuration, Testing, Rules, Notes), one line in docs/conditional-docs.md, and update app_docs/studio.md, export.md, pipeline.md and upload.md. No em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-203f77eb-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** Spec step 12 was skipped. `app_docs/storage.md` does not exist, `docs/conditional-docs.md`
has no line for it, `app_docs/export.md:155` still calls deleting rebuildable files and the disk
guard out of scope, `app_docs/studio.md:122` describes the old inline free-disk check,
`app_docs/upload.md` does not say `finish_upload` records the `source` row, and
`app_docs/pipeline.md:115` still points the cleanup at "slice 14". Only `.adw/project.md` was updated.
**Solution:** Documentation only, no code. Write `app_docs/storage.md` from the code already on
the branch (migration `supabase/migrations/20261101233625_storage_records.sql`,
`apps/worker/src/stored-files.ts`, `slimming.ts`, `scratch.ts`, `disk-guard.ts`,
`render/render-call.ts`, `main.ts`, `once.ts`, `apps/studio/src/lib/worker-status.ts`,
`apps/studio/src/components/LiveReel.tsx`) and the spec's Solution Statement and Notes. Add its
index line and make the four touched docs agree with it. `.adw/project.md` is already in step:
do not touch it.

## Files to Modify

- `app_docs/storage.md` (new)
- `docs/conditional-docs.md`
- `app_docs/studio.md`
- `app_docs/export.md`
- `app_docs/pipeline.md`
- `app_docs/upload.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Write `app_docs/storage.md`

Title `# Storage records, slimming, scratch cleanup and the disk guard`. Exactly these `##`
sections in this order: Overview, How it works, How to Use, Configuration, Testing, Rules, Notes.
Check every name, log line and number against the code before writing it.

- **Overview**: every object a job or an upload writes to R2 gets a `stored_files` row; heavy
  rebuildable files go seven days after a reel's last export; expired exports are deleted; each
  job's scratch folder is removed after it; no job is claimed below `WORKER_MIN_FREE_DISK_GB`, and
  the studio shows why under a queued job.
- **How it works**, subsections:
  - `### Database` (the migration file name): `stored_files` columns (`id`, `reel_id`,
    `owner_id`, `step`, `r2_key`, `bytes`, `kind`, `created_at`, `deleted_at`); kinds `source`,
    `kept`, `rebuildable`, `version`, `export`; one undeleted row per `(reel_id, r2_key)` (partial
    unique index), so a shared fingerprinted output has a row per reel that needs it (space per
    reel counts it for each reel; the total counts distinct live keys); `owner_id` from the reel by
    trigger; the update trigger allows only `deleted_at` going from null to a value; RLS: owner
    selects own, no insert, update or delete for `authenticated`, nothing for `anon`.
    `record_stored_file` (insert unless a live row exists), `slim_rebuildable_files(p_now,
p_prefix)` and `expire_export_files(p_now, p_prefix)` (each marks `deleted_at` and returns the
    keys and bytes in one statement), all `service_role` only. `finish_upload` now also records the
    `source` row (step `upload`, size from storage). `worker_status` (`worker_id`,
    `free_disk_bytes`, `waiting_reason`, `updated_at`): `authenticated` selects all rows, only the
    service role writes, no `anon`, in `supabase_realtime`.
  - `### Recording every write`: `classifyKey` derives kind and step from the key layout (cache
    path with the step's output tag, `reels/<reel>/versions/<id>.json`, `exports/<reel>/<id>.mp4`,
    the source key); an unknown key throws before writing. `recordingStorage` wraps `Storage` so
    every write method (`put`, `putIfAbsent`, `putFileIfAbsent`, `completeMultipartUpload`) records
    after success, on `written` and on `exists`; the `Record<keyof Storage, ...>` table makes a new
    method fail typecheck until classified; `delete` through it throws. A pipeline cache hit records
    each output's row from the `head` it already made.
  - `### What is kept and what is deleted`: kept forever: source, previews and every `kept` output,
    versions. Deleted: the three `rebuildable` outputs (`converted.mp4`, retime's `source.mp4`,
    `subject.webm`) once every reel holding the key was last exported more than seven days ago (a
    reel never exported, or exported within seven days, keeps it for everyone); exports after
    `expires_at`. The next export rebuilds missing rebuildable outputs (`convert`, `retime`,
    `remove_background` re-run; kept outputs stay hits).
  - `### Slimming`: `main.ts` runs it at most once an hour between jobs, before a claim, never
    during a job; prefix-scoped to `R2_KEY_PREFIX`; the database marks the deletion first, then each
    returned object is deleted; a failed delete is logged and the pass goes on. Quote the actual log
    line from `slimming.ts`. `once` never slims.
  - `### Scratch cleanup`: `withJobScratch` creates `WORKER_SCRATCH_DIR/<job_id>`, removes it in a
    `finally` (success and failure) and logs `job <id>: scratch removed, <size> freed`;
    `sweepStaleScratch` removes UUID-named folders at `worker` start-up. The render sets
    `HYPERFRAMES_EXTRACT_CACHE_DIR`, `HYPERFRAMES_HISTORY_ROOT` and `TMPDIR` inside its folder
    (`renderScratchEnv`). `hyperframes clean` is not run.
  - `### Disk guard`: `guardedClaim` (used by `main.ts` and `once.ts`) reads free bytes (`statfs`
    on `WORKER_SCRATCH_DIR`); below the minimum it does not call `claim_job` and upserts
    `worker_status` with `waiting: <x> GB free on the worker's disk, needs <n> GB`; at or above it
    clears the reason and claims. `E2E_MOCK_FREE_DISK_GB` replaces the reading only when
    `E2E_MOCK_STORAGE` is exactly `"true"`.
  - `### Studio`: the reel page reads the newest non-null `waiting_reason` on the server, the
    catch-up read and Realtime on `worker_status` keep it current, a `queued` job shows it
    (`data-testid="job-waiting"`).
- **How to Use**: nothing to do for the owner; what they see (the waiting line under a queued
  job; an export older than seven days rebuilds before rendering, so it takes longer).
- **Configuration**: `WORKER_MIN_FREE_DISK_GB` (default 10), `WORKER_SCRATCH_DIR`,
  `R2_KEY_PREFIX` (slimming scope), `E2E_MOCK_FREE_DISK_GB` (tests only). The R2 lifecycle rule on
  `<prefix>exports/` stays as a backstop.
- **Testing**: unit `apps/worker/src/stored-files.test.ts`, `scratch.test.ts`,
  `disk-guard.test.ts`, `slimming.test.ts`, `pipeline/definition.test.ts`,
  `pipeline/run-pipeline.test.ts` (hits recorded, rebuild case), `render/render-call.test.ts`,
  `apps/studio/src/lib/worker-status.test.ts`; DB `apps/studio/db-tests/stored-files.test.ts`;
  E2E the extended `apps/studio/e2e/upload.spec.ts` (every object one row) and
  `apps/studio/e2e/disk-guard.spec.ts`.
- **Rules** (each an invariant):
  - Never delete a `source`, `kept` or `version` file.
  - Never delete a rebuildable file within seven days of the last export of any reel that holds it.
  - Always record a deletion in the same statement that selects it.
  - Remove the job folder on failure too.
  - Never claim a job below `WORKER_MIN_FREE_DISK_GB`.
  - Never run `hyperframes clean` from the worker.
  - Never write storage from a job except through `recordingStorage`.
- **Notes**: why `hyperframes clean` is not used (0.8.222 sweeps the default history root, the
  shared extract cache and OS temp folders); three rebuildable files, not two; slimming is per
  worker, the cross-worker rule is slice 15; stale `worker_status` rows stay until the worker
  writes again; `make-pipeline-fixtures.ts` and test seeding write storage directly on purpose;
  `transcribe` and `remove_background` HyperFrames env not yet scoped (follow-up); owner steps
  (apply the migration to the hosted project, the manual `df` check and 8-days-back re-export,
  whether never-exported reels are ever slimmed); not verified: real R2 deletions and the real disk.

### Step 2: Index line in `docs/conditional-docs.md`

- Append after the upload line: ``- Read `app_docs/storage.md` when changing `stored_files`,
`worker_status`, `record_stored_file`, the slimming or export expiry, scratch cleanup, the disk
guard, `recordingStorage`, `E2E_MOCK_FREE_DISK_GB` or the studio's waiting reason.``

### Step 3: `app_docs/studio.md`

- Line 121 to 123 (Worker, `main.ts`): replace "skips claiming when free disk is below
  `WORKER_MIN_FREE_DISK_GB`" with: skips claiming below `WORKER_MIN_FREE_DISK_GB` and records the
  reason in `worker_status`, which the reel page shows under a queued job; slims storage at most
  hourly between jobs and removes each job's scratch folder (see `app_docs/storage.md`).
- Name the new tables where the doc lists tables (Overview or the Jobs section): `stored_files`
  and `worker_status`, pointing to `app_docs/storage.md`.
- Configuration: add `E2E_MOCK_FREE_DISK_GB` to the worker's tests-only variables.
- Testing: DB list adds `stored-files.test.ts` (`stored_files`, `worker_status`, slimming, export
  expiry, `finish_upload`'s source row); E2E list adds `disk-guard` and notes `upload.spec.ts` now
  checks one `stored_files` row per object.

### Step 4: `app_docs/export.md`

- Worker section (after the `HYPERFRAMES_NO_TELEMETRY=1` paragraph): the render also sets
  `HYPERFRAMES_EXTRACT_CACHE_DIR`, `HYPERFRAMES_HISTORY_ROOT` and `TMPDIR` inside the render's
  folder in the job scratch, so the job folder's removal takes the frame cache, history and work
  dirs (`app_docs/storage.md`). The export write records its `export` row through
  `recordingStorage`.
- Configuration line 102 to 103: the worker's slimming now deletes the object once `expires_at`
  passes (`expire_export_files`); the owner's lifecycle rule stays as a backstop.
- Notes line 155: drop "deleting rebuildable files and the disk guard" so it reads
  "Out of scope: render progress and time left, cloud rendering."

### Step 5: `app_docs/pipeline.md` and `app_docs/upload.md`

- `pipeline.md:115`: replace "so the cleanup (slice 14) can act on it" with "so the slimming
  (`app_docs/storage.md`) can act on it"; in the hit description (line 34) add that a hit also
  records a `stored_files` row per output, from the `head` it already made.
- `upload.md` Database section (line 68 to 72): `finish_upload` also records the raw footage's
  `source` row in `stored_files` (step `upload`, the size from storage) in the same transaction,
  once; the repeat records nothing more. Name `20261101233625_storage_records.sql` as the
  migration that replaced it, and point to `app_docs/storage.md`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check` - Prettier over the repository, including the new and edited docs (run
  `yarn format` and re-check if it fails).
- `grep -rn $'\u2014' app_docs docs` - prints nothing (no em-dashes).
- `grep -n '^## ' app_docs/storage.md` - prints exactly Overview, How it works, How to Use,
  Configuration, Testing, Rules, Notes, in that order.
- `grep -c 'app_docs/storage.md' docs/conditional-docs.md` - prints `1`; and
  `grep -n 'deleting rebuildable files and the disk guard\|slice 14' app_docs/export.md app_docs/pipeline.md`
  prints nothing.
- `yarn knip` - unaffected by docs, confirms the tree still passes the commit hook.

## Patch Scope

**Lines of code to change:** about 170 lines of Markdown (about 140 new in `storage.md`, about 30
across the five edited docs); no code.
**Risk level:** low
**Testing required:** formatting and content checks only; no code changes, so the unit, DB and
E2E suites are unaffected.
