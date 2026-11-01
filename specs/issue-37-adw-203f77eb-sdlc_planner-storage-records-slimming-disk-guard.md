# Feature: storage records, seven-day slimming, scratch cleanup and the disk guard

## Metadata

issue_number: `37`
adw_id: `203f77eb`
issue_json: `{"number":37,"title":"feat: storage records, seven-day slimming, scratch cleanup and the disk guard"}`

## Feature Description

Reel studio MVP, slice 14 of 17. Two places fill up: R2 and the worker machine's disk. This slice
keeps both under control and measures storage as closely as time is measured already.

- Every stored file is recorded in a new `stored_files` table with its size, the step that made
  it, the reel it belongs to, its kind (`source`, `kept`, `rebuildable`, `version`, `export`) and
  when it was deleted.
- Heavy files that can be rebuilt (the pipeline outputs tagged `rebuildable`) are deleted seven days
  after a reel's last export, unless another reel still needs them. Raw footage, previews and
  versions are never deleted. A slimmed reel exported again rebuilds them first.
- Expired exports get their `stored_files` row marked deleted and their object removed (the R2
  lifecycle rule stays as the backstop).
- Every job removes its scratch directory (`WORKER_SCRATCH_DIR/<job_id>`) on success and on
  failure, including the render's frame cache and HyperFrames' own history, and logs the bytes
  freed.
- The worker claims no job while the scratch volume has less than `WORKER_MIN_FREE_DISK_GB` free,
  writes why to a new `worker_status` table, and the studio shows that reason under a queued job,
  live.

## User Story

As the studio owner running the worker on my own machine
I want every stored file recorded, rebuildable files and expired exports cleaned up on a schedule,
job leftovers removed, and the worker to pause (and say so) when the disk is nearly full
So that R2 and my disk never fill up silently, I can see what storage each reel costs, and I know
why a job is not starting.

## Problem Statement

After #35 the worker writes step outputs, versions and exports to R2 and the studio writes raw
footage, but nothing records what is stored, how big it is or who it belongs to. Nothing ever
deletes the heavy rebuildable outputs (`converted.mp4`, retime's `source.mp4`, `subject.webm`), so
R2 grows by about 190 MB per reel for good. Exports past `expires_at` rely on the lifecycle rule
alone. On the worker machine, render scratch folders (with HyperFrames' frame cache, about 3 GB per
render) and decide folders are cleaned per step but there is no per-job folder removed in a
`finally`, and HyperFrames keeps its own history and extract cache outside the job. The disk check
in `apps/worker/src/main.ts` only logs to the console (and `once` has none), so the owner cannot
see in the studio why a queued job does not start.

## Solution Statement

1. **Database** (one new migration, created with `supabase migration new storage_records`):
   - `public.stored_files` (`id`, `reel_id`, `owner_id`, `step`, `r2_key`, `bytes`, `kind`,
     `created_at`, `deleted_at`) with one undeleted row per `(reel_id, r2_key)` (partial unique
     index). A fingerprinted output shared by two reels has one row per reel, so "who still needs
     this object" is a query, not a guess. `owner_id` is set from the reel by a trigger (the
     `exports` pattern). An update trigger allows only `deleted_at` going from null to a value.
     RLS: owner selects own; no insert, update or delete for `authenticated`; nothing for `anon`.
   - `record_stored_file(p_reel_id, p_r2_key, p_step, p_kind, p_bytes)`: inserts unless an
     undeleted row for that reel and key exists (`on conflict ... where deleted_at is null do
nothing`); `service_role` only.
   - `slim_rebuildable_files(p_now timestamptz, p_prefix text)`: in one statement marks
     `deleted_at = p_now` on every undeleted `rebuildable` row whose key is under `p_prefix` and
     for which **every** undeleted row with that key belongs to a reel whose last export (max
     `exports.created_at`) is older than `p_now - interval '7 days'`; returns the distinct
     `(r2_key, bytes)` it marked. A reel never exported, or exported within seven days, holding the
     key keeps it for everyone. `service_role` only.
   - `expire_export_files(p_now timestamptz, p_prefix text)`: marks `deleted_at = p_now` on
     undeleted `export` rows whose `exports.expires_at < p_now` (joined on `r2_key`), returns the
     keys and bytes. `service_role` only.
   - `finish_upload` replaced (`create or replace`, same signature and grants) so the uploading
     branch also inserts the `source` row (`step = 'upload'`, the reel's `source_key`, `p_bytes`,
     the size storage reported). The studio's complete path therefore records the raw footage in
     the same transaction as the reel update, with no new grant to the owner, and a repeated
     complete records nothing more.
   - `public.worker_status` (`worker_id text primary key`, `free_disk_bytes bigint`,
     `waiting_reason text`, `updated_at timestamptz`): `authenticated` selects all rows (no reel
     data in it), only the service role writes, no `anon` access, in `supabase_realtime`.
2. **Record every write (worker)**: `apps/worker/src/stored-files.ts` classifies a key by its
   layout (`<prefix>cache/<step>/<fp>/<file>` gives the step and `kept` or `rebuildable` from the
   step definition's output tag; `<prefix>reels/<reel>/versions/<id>.json` gives `version`;
   `<prefix>exports/<reel>/<id>.mp4` gives `export` with step `render`; an unknown key throws) and
   wraps a `Storage` so every write method (`put`, `putIfAbsent`, `putFileIfAbsent`,
   `completeMultipartUpload`) records a row after it succeeds, both on `written` and on `exists`
   (an object another reel stored is now needed by this reel too). A `Record<keyof Storage, ...>`
   table forces every interface method to be classified, so a new write method cannot skip
   recording without failing typecheck, and the unit test calls every write method. Jobs get the
   wrapped storage; `delete` through it throws (only the slimming task deletes). A pipeline hit
   records each output's row from the `head` it already made.
3. **Slimming and export expiry**: `apps/worker/src/slimming.ts` runs at most once an hour, inside
   the drain loop before a claim (so never while this worker runs a job). It calls the two
   functions with `now` and the worker's key prefix, then deletes each returned object (deletion
   recorded first, in the same database statement that selected it; a failed object delete is
   logged and the loop goes on). Logs `slimming: N rebuildable files (X MB), M expired exports (Y MB)
deleted`. `once` never slims.
4. **Scratch cleanup**: `apps/worker/src/scratch.ts` `withJobScratch` creates
   `WORKER_SCRATCH_DIR/<job_id>`, runs the job with it as the job's scratch root, and in a
   `finally` measures it, removes it and logs `job <id>: scratch removed, <size> freed`. The
   pipeline, decide and render folders already live under the scratch root they are given, so all
   of them land inside the job folder. The render call points HyperFrames' extract (frame) cache
   (`HYPERFRAMES_EXTRACT_CACHE_DIR`), history root (`HYPERFRAMES_HISTORY_ROOT`) and `TMPDIR` inside
   the render's own folder, so removing the job folder removes the frame cache, the history and
   the render work dirs. `hyperframes clean` is deliberately not run (see Notes: on 0.8.222 it
   ignores its directory for most of its sweep). At `worker` start-up, stale job folders (UUID
   names) left by a crash are removed.
5. **Disk guard**: `apps/worker/src/disk-guard.ts` with an injected free-space function (default
   `statfs` on `WORKER_SCRATCH_DIR`; under `E2E_MOCK_STORAGE=true` exactly, `E2E_MOCK_FREE_DISK_GB`
   replaces it, inert otherwise). Below the minimum it does not call `claim_job`, upserts
   `worker_status` with `waiting: 7.2 GB free on the worker's disk, needs 10 GB`; at or above it
   upserts a null reason and claims. Used by both `main.ts` and `once.ts`.
6. **Studio**: the reel page reads the newest non-null `waiting_reason` once on the server, the
   catch-up read and Realtime on `worker_status` keep it current, and a `queued` job shows it
   (`data-testid="job-waiting"`).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, the Protected section (no
  `supabase migration up`; `.adw/supabase-stack reset` after adding a migration; never start the
  worker; no em-dashes).
- `docs/conditional-docs.md`: index; gets one line for the new `app_docs/storage.md`.
- `app_docs/studio.md`: tables, RLS rules, the worker loop line ("skips claiming when free disk is
  below...") and the storage doubles; update the worker and disk lines and the test list.
- `app_docs/pipeline.md`: the `kept` / `rebuildable` tags (the cleanup acts on them), the job
  scratch folder (`<WORKER_SCRATCH_DIR>/job-<job id>/`), `putFileIfAbsent`.
- `app_docs/export.md`: the `exports` table and expiry, the render call and environment (gets the
  scratch-scoped HyperFrames variables), the "Out of scope: deleting rebuildable files and the disk
  guard" note to update.
- `app_docs/upload.md`: `finish_upload` (now also records the `source` row).
- `app_docs/measurement.md`: logging conventions of the worker (step runner, OpenTelemetry).
- `app_docs/adw-supabase-stack.md`: how a run applies a new migration (`.adw/supabase-stack reset`).
- `supabase/migrations/20261101194557_export_render_jobs.sql`: the `exports` table, owner-from-reel
  trigger and refuse-update pattern to copy.
- `supabase/migrations/20261101212954_multipart_upload.sql`: the current `finish_upload` body to
  copy into the replacement, and its grants.
- `apps/worker/src/main.ts`: the drain loop, the inline `enoughDisk` to replace with the guard, the
  place for the hourly slimming and the start-up scratch sweep.
- `apps/worker/src/once.ts`: gets the guard (the E2E spawns it).
- `apps/worker/src/loop.ts`, `loop.test.ts`: `createDrainer`, unchanged; the claim function passed
  in does the guard and the slimming.
- `apps/worker/src/config.ts`, `config.test.ts`: `minFreeDiskGb`, `scratchDir`, `keyPrefix`.
- `apps/worker/src/queue.ts`: `claimJob` (the call the guard must skip).
- `apps/worker/src/process-job.ts`: wires a job to storage and scratch; gets the recording storage
  and `withJobScratch`.
- `apps/worker/src/run-job.ts`: the job lifecycle the scratch `finally` wraps.
- `apps/worker/src/pipeline/run-pipeline.ts`, `run-pipeline.test.ts`: hits (record rows from the
  heads), writes (`putFileIfAbsent`), the rebuild of a deleted rebuildable output.
- `apps/worker/src/pipeline/definition.ts`: `OutputRetention`, `PIPELINE`, `outputFiles`; gets a
  `retentionOf(step, file)` lookup.
- `apps/worker/src/pipeline/fingerprint.ts`: `cacheKey` (the key layout the classifier parses).
- `apps/worker/src/render/render-step.ts`, `render-step.test.ts`, `render-call.ts`,
  `render-call.test.ts`, `render.tools.test.ts`, `export-key.ts`: the export write and the render
  environment.
- `apps/worker/src/decide/run-decide.ts`: its `mkdtemp(join(scratchDir, "decide-"))` folder lands
  inside the job folder once given the job scratch root.
- `apps/worker/src/version-store.ts`: `storageVersionBlobs` writes versions through the storage it
  is given (the wrapped one).
- `apps/worker/src/storage.ts`, `apps/worker/src/supabase.ts`, `apps/worker/src/format.ts`
  (`formatBytes`), `apps/worker/src/recording-steps.ts` (test job and context).
- `apps/worker/.env.example`: `WORKER_MIN_FREE_DISK_GB`, `WORKER_SCRATCH_DIR`; gets
  `E2E_MOCK_FREE_DISK_GB` under the tests-only block.
- `packages/storage/src/storage.ts`, `fake.ts`: the `Storage` interface the wrapper must cover; the
  fake used in unit tests (no change expected).
- `packages/edit/src/versions.ts`: `versionKey` layout (`<prefix>reels/<reel>/versions/<id>.json`).
- `apps/studio/src/components/LiveReel.tsx`: the Realtime channel and the jobs list where the
  waiting reason shows.
- `apps/studio/src/app/reels/[id]/page.tsx`: the server read handed to `LiveReel`.
- `apps/studio/src/lib/jobs.ts`: `pickColumns`, column-list conventions.
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` (default env for the new switch),
  `claimableJobIds`.
- `apps/studio/test-support/pipeline-cache.ts`: `seedProcessedReel`, `seedPipelineCache`.
- `apps/studio/test-support/fixtures.ts`, `local-supabase.ts`: test users, admin client, local-only
  guard, `localDbUrl`.
- `apps/studio/e2e/upload.spec.ts`: the one spec that goes through the real upload path; extended
  with an export and the "every object recorded" check.
- `apps/studio/e2e/export.spec.ts`: model for inserting/handling a render job and the CDN routes.
- `apps/studio/db-tests/rls.test.ts`, `exports.test.ts`, `steps-measurements.test.ts`: DB test
  patterns (RLS on every table, exact column sets, owner isolation).
- `knip.json`, `turbo.json`: dead code and strict env (no change expected: the new switch is set by
  the spec itself on the spawned worker).

### New Files

- `supabase/migrations/<stamp>_storage_records.sql` (made by `supabase migration new storage_records`).
- `apps/worker/src/stored-files.ts`, `apps/worker/src/stored-files.test.ts`: key classification,
  the `StoredFileRecords` interface and its Supabase implementation, `recordingStorage`.
- `apps/worker/src/slimming.ts`, `apps/worker/src/slimming.test.ts`: the hourly task.
- `apps/worker/src/disk-guard.ts`, `apps/worker/src/disk-guard.test.ts`: free space, the waiting
  reason, the guarded claim, the `worker_status` writer.
- `apps/worker/src/scratch.ts`, `apps/worker/src/scratch.test.ts`: `withJobScratch`,
  `directoryBytes`, `sweepStaleScratch`.
- `apps/studio/src/lib/worker-status.ts`, `apps/studio/src/lib/worker-status.test.ts`: column list,
  `waitingReasonOf(rows)`, Realtime merge helper.
- `apps/studio/db-tests/stored-files.test.ts`: the table, its RLS, the three functions with a fixed
  clock, `finish_upload`'s source row, `worker_status` access.
- `apps/studio/e2e/disk-guard.spec.ts`: the waiting reason shown live.
- `app_docs/storage.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

The migration (both tables, the three functions, the replaced `finish_upload`, grants, RLS,
Realtime), applied to the run's ADW stack with `.adw/supabase-stack reset`, and its DB tests. Then
the worker's key classifier and `retentionOf` lookup.

### Phase 2: Core Implementation

Worker modules: `recordingStorage` and the Supabase records store; the pipeline's hit recording;
`withJobScratch` and the render's scratch-scoped HyperFrames environment; the disk guard and
`worker_status` writer; the slimming task. Each with unit tests on the folder fake, injected clocks
and injected free-space functions.

### Phase 3: Integration

Wire them into `process-job.ts`, `main.ts` and `once.ts`; the studio's waiting reason (server read,
catch-up read, Realtime, display); extend `upload.spec.ts` with an export and the per-object row
check; add `disk-guard.spec.ts`; docs, the doc index and the ADW profile's test lists.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Create the migration

- Run `supabase migration new storage_records` (the only `supabase` command allowed besides the
  stack script; it stamps the current UTC time). Never hand-pick the version.
- Header comment saying what the slice adds and why (B5, B6), in the style of the earlier
  migrations. No em-dashes.
- `create table public.stored_files`:
  - `id uuid primary key default gen_random_uuid()`
  - `reel_id uuid not null references public.reels (id) on delete cascade`
  - `owner_id uuid not null references auth.users (id) on delete cascade`
  - `step text not null check (step ~ '^[a-z_]{1,40}$')`
  - `r2_key text not null check (length(r2_key) between 1 and 512)`
  - `bytes bigint not null check (bytes >= 0)`
  - `kind text not null check (kind in ('source', 'kept', 'rebuildable', 'version', 'export'))`
  - `created_at timestamptz not null default now()`
  - `deleted_at timestamptz`, `check (deleted_at is null or deleted_at >= created_at)`
  - `create unique index stored_files_live_idx on public.stored_files (reel_id, r2_key) where deleted_at is null;`
  - `create index stored_files_live_key_idx on public.stored_files (r2_key) where deleted_at is null;`
  - `create index stored_files_reel_idx on public.stored_files (reel_id);`
- Before-insert trigger (security definer, `set search_path = ''`, execute revoked from public,
  anon, authenticated) setting `owner_id` from the reel whatever is passed (copy the `exports`
  trigger).
- Before-update trigger refusing every update except `deleted_at` going from null to non-null with
  every other column unchanged (errcode `55000`, message `stored_files rows only record a deletion`).
- RLS on; `revoke all ... from anon, authenticated`; `grant select ... to authenticated`; policy
  `stored_files: owner selects own` (`(select auth.uid()) = owner_id`). No insert, update or delete
  policy: the worker writes with the secret key, the studio only through `finish_upload`.
- `create function public.record_stored_file(p_reel_id uuid, p_r2_key text, p_step text, p_kind text, p_bytes bigint) returns void`,
  `security definer`, `set search_path = ''`:
  `insert ... on conflict (reel_id, r2_key) where deleted_at is null do nothing`.
  `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;`
- `create function public.slim_rebuildable_files(p_now timestamptz, p_prefix text) returns table (r2_key text, bytes bigint)`,
  `security definer`, `set search_path = ''`, service role only. One statement:
  - `last_export` = `select reel_id, max(created_at) as at from public.exports group by reel_id`;
  - candidate keys: undeleted `rebuildable` rows with `starts_with(r2_key, p_prefix)`, grouped by
    `r2_key`, `having bool_and(<the row's reel has a last_export and at < p_now - interval '7 days'>)`
    over **all** undeleted rows of that key (any kind, any reel);
  - `update public.stored_files set deleted_at = p_now where deleted_at is null and r2_key in (candidates) returning r2_key, bytes`;
  - select the distinct `(r2_key, max(bytes))` from the update's result.
    The selection and the marking are one statement, so a key never gets marked deleted while a
    qualifying reel check is stale.
- `create function public.expire_export_files(p_now timestamptz, p_prefix text) returns table (r2_key text, bytes bigint)`,
  service role only: marks undeleted `export` rows whose key belongs to an `exports` row with
  `expires_at < p_now`, under the prefix, returning keys and bytes.
- `create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)`: the body of
  `20261101212954_multipart_upload.sql` unchanged, plus, in the `v_status = 'uploading'` branch,
  `select source_key` (already locked) and `insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind) values (p_reel_id, auth.uid(), 'upload', v_source_key, p_bytes, 'source')`.
  Repeat the same `revoke` / `grant` lines (authenticated only).
- `create table public.worker_status`:
  - `worker_id text primary key check (length(worker_id) between 1 and 200)`
  - `free_disk_bytes bigint not null check (free_disk_bytes >= 0)`
  - `waiting_reason text check (waiting_reason is null or length(waiting_reason) between 1 and 200)`
  - `updated_at timestamptz not null default now()`
  - RLS on; `revoke all from anon, authenticated`; `grant select to authenticated`; policy
    `worker_status: signed-in users read` (`to authenticated using (true)`): it holds no reel data.
  - `alter publication supabase_realtime add table public.worker_status;`
- Run `.adw/supabase-stack reset` (the profile's rule after adding a migration in a run; never
  `supabase migration up`, `start`, `stop` or `db reset`). If it fails, report its error and stop.

### 2. DB tests for the migration

- New `apps/studio/db-tests/stored-files.test.ts` (patterns from `exports.test.ts` and
  `steps-measurements.test.ts`):
  - exact column set of `stored_files` and of `worker_status` (information_schema);
  - owner reads own rows, another user reads none, `anon` reads none; `authenticated` cannot
    insert, update or delete; the update trigger refuses changing anything but `deleted_at` (and
    refuses un-deleting), even for the service role;
  - `record_stored_file`: `owner_id` taken from the reel; a second call for the same reel and key
    adds nothing; after the row is marked deleted a new call inserts a new row; `authenticated`
    cannot execute it;
  - `slim_rebuildable_files` with a fixed `p_now`: create reels with exports via service-role
    inserts (reel, version, render job and `exports` row; `created_at` set explicitly in the past is
    refused by the expiry check unless `expires_at` follows from the trigger, so insert with the
    wanted `created_at`), and stored rows per reel:
    - reel A exported 8 days before `p_now`: its `rebuildable` keys are returned and marked; its
      `source`, `kept` and `version` rows are untouched;
    - reel B exported 6 days before: nothing marked;
    - reel C never exported: nothing marked;
    - reel D exported 8 days before but sharing one rebuildable key with reel E exported yesterday:
      that shared key is not returned and none of its rows is marked; D's unshared rebuildable key
      is;
    - a key outside `p_prefix` is never touched;
    - calling again returns nothing (idempotent);
  - `expire_export_files` with a fixed `p_now`: an export 25 hours old is marked and returned, one
    1 hour old is not;
  - `finish_upload` records exactly one `source` row with the reel's key and size, and a repeated
    call adds none (extend the existing `finish_upload` tests in `rls.test.ts` or cover it here);
  - `worker_status`: authenticated reads rows, cannot insert or update; anon reads none.
- `rls.test.ts`' "every public table" test covers both tables automatically.

### 3. Pipeline retention lookup

- `apps/worker/src/pipeline/definition.ts`: export `retentionOf(step: string, file: string, pipeline = PIPELINE): OutputRetention | null`.
- Extend `definition.test.ts`: `converted.mp4`, retime's `source.mp4` and `subject.webm` are
  `rebuildable`, the others `kept`, unknown gives null.

### 4. Key classifier, records store and recording storage

- `apps/worker/src/stored-files.ts`:
  - `type StoredFileKind = "source" | "kept" | "rebuildable" | "version" | "export"`.
  - `classifyKey(prefix, key): { kind, step }`: cache keys from `cacheKey`'s layout with
    `retentionOf`; version keys (`<prefix>reels/<uuid>/versions/<uuid>.json`) give
    `{ kind: "version", step: "version" }`; export keys give `{ kind: "export", step: "render" }`;
    source keys give `{ kind: "source", step: "upload" }`; anything else throws
    `stored-files: unknown key layout: <key>` (nothing is written unrecorded).
  - `interface StoredFileRecords { record(row: { reelId, key, step, kind, bytes }): Promise<void>; slimRebuildable(now: Date, prefix: string): Promise<{ key: string; bytes: number }[]>; expireExports(now: Date, prefix: string): Promise<{ key: string; bytes: number }[]> }`
    and `supabaseStoredFiles(db)` calling the three functions through `db.rpc`, throwing on error.
  - `const STORAGE_METHODS: Record<keyof Storage, "read" | "write" | "refused">` (every method of
    the interface must appear, so typecheck fails when one is added unclassified):
    `put`, `putIfAbsent`, `putFileIfAbsent`, `completeMultipartUpload` are `write`; `delete` is
    `refused`; the rest are `read`.
  - `recordingStorage(storage, { records, reelId, keyPrefix }): Storage`: reads pass through;
    `delete` throws (`jobs never delete stored objects; the slimming task does`); each write runs,
    then records `classifyKey` plus the bytes: `put` the body length, `putIfAbsent` the body length
    on `written` and the `head` size on `exists`, `putFileIfAbsent` the file's `stat` size on
    `written` and the `head` size on `exists`, `completeMultipartUpload` the `head` size on
    `completed` (nothing on `missing`). Recording failure throws (the job fails and retries; the
    row is idempotent).
- `apps/worker/src/stored-files.test.ts` (folder fake in a temp dir, an in-memory records fake):
  - classification of every key layout, and an unknown key throws before anything is written;
  - **no write path skips it**: for every method `STORAGE_METHODS` marks `write`, call it through
    the wrapper and expect exactly one record with the right key, kind, step and bytes; for `exists`
    outcomes too; `delete` throws and the object stays; a test also asserts the set of `write`
    methods equals the known four, so reclassifying one is a visible change.

### 5. Pipeline: record hits

- `apps/worker/src/pipeline/run-pipeline.ts`: add optional `recordHit?: (key: string, bytes: number) => Promise<void>` to `PipelineRun`
  (process-job passes one bound to the records store, kind and step from `classifyKey`). On a hit,
  call it for each output with the size from the `head` already made. Writes need nothing here:
  they go through the wrapped storage.
- `run-pipeline.test.ts`:
  - an all-hit run records every output once with its size;
  - **rebuild after slimming** (Verification 3): store every step's outputs, delete the three
    rebuildable objects (`converted.mp4`, retime's `source.mp4`, `subject.webm`), run with
    `setReelStatus: false` (the render's call): `convert`, `retime` and `remove_background` run
    (spawned, not `skipped`), `transcribe`, `head_track` and `preview_copies` are hits, the kept
    outputs are not re-uploaded (put-if-absent leaves them), and the three rebuildable objects exist
    again.

### 6. Scratch cleanup

- `apps/worker/src/scratch.ts`:
  - `directoryBytes(dir)`: sum of file sizes under it (lstat, no symlink following), 0 when missing.
  - `withJobScratch(scratchDir, jobId, run: (dir) => Promise<T>, log = console.log)`: `mkdir -p
<scratchDir>/<jobId>`, `try { return await run(dir) } finally { bytes = directoryBytes; rm -rf;
log(\`job ${jobId}: scratch removed, ${formatBytes(bytes)} freed\`) }`. The job id is checked to
    be a UUID before any path is built.
  - `sweepStaleScratch(scratchDir, log)`: removes direct children whose names are UUIDs (crashed
    jobs), logging the bytes; leaves everything else.
- `apps/worker/src/process-job.ts`: wrap the `runJob(...)` call in `withJobScratch(config.scratchDir, job.id, (dir) => ...)`
  and pass `dir` as `scratchDir` to `runPipeline`, `runDecide` and `runRender`. Build
  `recordingStorage(storage, { records: supabaseStoredFiles(db), reelId: job.reel_id, keyPrefix })`
  once per job and pass it everywhere `storage` was passed (versions through `storageVersionBlobs`
  too), plus the pipeline's `recordHit`.
- `apps/worker/src/render/render-call.ts`: `renderCall` takes the render folder and sets, in
  `renderEnv`'s result, `HYPERFRAMES_EXTRACT_CACHE_DIR=<dir>/frames-cache`,
  `HYPERFRAMES_HISTORY_ROOT=<dir>/hyperframes-history` and `TMPDIR=<dir>/tmp` (created before the
  call in `renderExport`). Arguments stay exactly as they are. `render-call.test.ts` asserts the
  three variables point inside the given folder and the stub (`E2E_MOCK_RENDER`) is unchanged.
- `apps/worker/src/main.ts`: call `sweepStaleScratch(config.scratchDir)` once at start-up, before
  the first signal. `once.ts` does not sweep (a spec could share the folder).
- `apps/worker/src/scratch.test.ts` (Verification 4): a run that writes files and then throws
  leaves no `<scratch>/<job_id>` and rethrows the error; a successful run leaves none either and
  the log line carries the bytes; a non-UUID id is refused; `sweepStaleScratch` removes UUID
  folders only.
- `apps/worker/src/render/render.tools.test.ts` (owner's Mac only, `test:tools`): after a real
  render through `withJobScratch`, the job folder is gone and the default HyperFrames history root
  (`~/.cache/hyperframes/history`) has no new entry.

### 7. Disk guard and `worker_status`

- `apps/worker/src/disk-guard.ts`:
  - `type FreeBytes = (dir: string) => Promise<number>`; `statfsFreeBytes` (`bavail * bsize`);
  - `freeBytesFn(env)`: when `isE2EMockStorage(env)` and `E2E_MOCK_FREE_DISK_GB` is set, returns
    that many GB (1024^3) whatever the disk says (a malformed value throws); otherwise
    `statfsFreeBytes`. Inert unless `E2E_MOCK_STORAGE` is exactly `"true"`.
  - `waitingReason(freeBytes, minFreeDiskGb)`: `waiting: 7.2 GB free on the worker's disk, needs 10 GB`
    (one decimal for the free space, the minimum as configured).
  - `interface WorkerStatusStore { set(row: { freeDiskBytes: number; waitingReason: string | null }): Promise<void> }`
    and `supabaseWorkerStatus(db, workerId)` (upsert on `worker_id` with `updated_at` now).
  - `guardedClaim<T>({ dir, minFreeDiskGb, freeBytes, status, claim, log })`: reads free bytes;
    below `minFreeDiskGb * 1024^3` it writes the reason, logs it and returns null **without calling
    `claim`**; otherwise it writes a null reason and returns `claim()`.
- `apps/worker/src/disk-guard.test.ts` (Verification 5): at 9 GB with a 10 GB minimum, `claim` is
  never called and the status holds the reason; at 11 GB `claim` is called once, its job returned
  and the reason cleared; exactly at 10 GB claims; `freeBytesFn` ignores `E2E_MOCK_FREE_DISK_GB`
  unless `E2E_MOCK_STORAGE` is exactly `"true"`; `statfsFreeBytes(tmpdir())` is positive.
- Negative proof (record the result in the PR description, not in the code): temporarily make
  `guardedClaim` call `claim` unconditionally, run `yarn turbo run test --filter=./apps/worker`, see
  the 9 GB test fail, restore.
- `apps/worker/src/main.ts`: replace `enoughDisk` with `guardedClaim` (status
  `supabaseWorkerStatus(db, config.workerId)`, free space `freeBytesFn(process.env)`). The poll
  already re-signals while a job is claimable, which re-checks the disk on the next tick.
- `apps/worker/src/once.ts`: claim through `guardedClaim`; when it returns null because of the disk,
  print the reason and exit 0 (the same as "no job").
- `apps/worker/.env.example`: under the tests-only block, `E2E_MOCK_FREE_DISK_GB=` with a comment
  (only read when `E2E_MOCK_STORAGE` is exactly `true`; forces the free space the disk guard sees).

### 8. Slimming task

- `apps/worker/src/slimming.ts`:
  - `runSlimming({ records, storage, keyPrefix, now, log })`: `slimRebuildable(now, prefix)` then
    `expireExports(now, prefix)`; for each returned key `storage.delete(key)` (raw storage, not the
    job wrapper), catching and logging a failure per key and going on; logs one summary line with
    counts and `formatBytes` totals. Returns the counts.
  - `createSlimmer({ everyMs = 3_600_000, clock = () => new Date(), run })`: `maybeRun()` runs
    `run(now)` when at least `everyMs` passed since the last start (first call runs), swallowing and
    logging errors so a failed slimming never blocks a claim.
- `apps/worker/src/slimming.test.ts` (folder fake, records fake returning fixed keys, fixed clock):
  returned keys' objects are gone and others (a `source`, a preview, a version) stay; the records'
  marking is called before the first object delete; one failing delete is logged and the rest
  still go; an object already gone is fine; `maybeRun` runs once per hour with a fixed clock, and an
  error in `run` does not throw out of `maybeRun`.
- `apps/worker/src/main.ts`: the drainer's `claim` becomes
  `async () => { await slimmer.maybeRun(); return guardedClaim(...) }`, so slimming only runs
  between jobs of this worker. `once.ts` never slims.

### 9. Studio: waiting reason

- `apps/studio/src/lib/worker-status.ts`: `WORKER_STATUS_COLUMNS = "worker_id, waiting_reason, updated_at"`,
  `interface WorkerStatusRow`, `upsertWorkerStatus(rows, row)` and `waitingReasonOf(rows)`: the
  newest (by `updated_at`) non-null reason, else null.
- `apps/studio/src/lib/worker-status.test.ts`: newest wins, a later null from the same worker clears
  it, another worker's reason stays, empty gives null.
- `apps/studio/src/app/reels/[id]/page.tsx`: read `worker_status` (named columns, `not("waiting_reason", "is", null)`)
  with the other queries; hand the rows to `LiveReel`.
- `apps/studio/src/components/LiveReel.tsx`: keep the rows in state; the catch-up `readSnapshot`
  reads them too; one more listener on the same channel,
  `{ event: "*", schema: "public", table: "worker_status" }`, merging with `upsertWorkerStatus`.
  Under a job with `status === "queued"` and a reason, render
  `<span data-testid="job-waiting" className="text-amber-800">{reason}</span>`. No timer, no polling.
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` defaults `E2E_MOCK_FREE_DISK_GB` to `"1000"`
  and `WORKER_MIN_FREE_DISK_GB` to `"10"`, so no spec depends on the CI runner's real free space;
  a spec overrides them.

### 10. E2E: every write recorded (extend `upload.spec.ts`)

- After the existing assertions (reel `processed`, versions 1 and 2), insert a render job for the
  current version as the service role (`reel_id`, `owner_id`, `kind: "render"`, `version_id`), run
  `runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER })`, expect
  exit 0 and one `exports` row; add its key to the cleanup list.
- Then (Verification 1): for every key in `await storage.list(CACHE_PREFIX)` plus `sourceKey`,
  exactly one `stored_files` row for this reel with `bytes` equal to `storage.head(key).bytes`, and
  the expected `kind` and `step` (cache keys from the manifest: `kept` or `rebuildable` per the
  pipeline tags and the step name; versions `version`; the export `export` / `render`; the source
  `source` / `upload`); and no undeleted row of this reel whose key has no object.
- Keep the spec's leftover-claimable-jobs guard and its cleanup (delete the export object too).

### 11. E2E: disk guard shown live (new `apps/studio/e2e/disk-guard.spec.ts`)

- Model on `export.spec.ts`: assert no claimable jobs first; create a user; `seedProcessedReel`
  under its own `CACHE_PREFIX`; sign in and open the reel page; wait for
  `[data-realtime="ready"]`.
- Insert a render job for the current version as the service role (the Export button is covered by
  `export.spec.ts`; route the two CDN scripts as that spec does if the page needs them).
- `runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, WORKER_ID: <fixed per spec>, E2E_MOCK_FREE_DISK_GB: "7.2", WORKER_MIN_FREE_DISK_GB: "10" })`:
  exit 0, output contains the waiting line; the job is still `queued` in the database (no claim:
  `attempts` 0, no lease holder).
- Without a reload, `getByTestId("job-waiting")` shows
  `waiting: 7.2 GB free on the worker's disk, needs 10 GB`.
- `runWorkerOnce` again with the same `WORKER_ID` and `E2E_MOCK_FREE_DISK_GB: "11"`: the job ends
  `done`, the page's `job-waiting` disappears and the job shows `done`.
- `afterAll`: delete this spec's `worker_status` row, its storage keys and its user; leave no
  claimable job.
- Fails without the feature: no `job-waiting` element exists, and without the guard the first
  `once` claims and runs the job.

### 12. Docs and profile

- New `app_docs/storage.md`, sections Overview, How it works, How to Use, Configuration, Testing,
  Rules, Notes: `stored_files` and its kinds and steps; one row per reel and key, so a shared
  fingerprinted output has a row per reel needing it (space per reel counts it for each; the total
  counts distinct live keys); what is kept (source, previews and every `kept` output, versions)
  and what is deleted and when (the three `rebuildable` outputs seven days after the last export,
  never while any reel holding the key was exported within seven days or never exported; expired
  exports); the hourly slimming between jobs, prefix-scoped, recording before deleting; rebuild on
  the next export; scratch cleanup and the HyperFrames variables; the disk guard, `worker_status`
  and the studio's display; the `E2E_MOCK_FREE_DISK_GB` switch. Rules: never delete a `source`,
  `kept` or `version` file; never a rebuildable file within seven days of the last export of any
  reel that holds it; always record a deletion in the same statement that selects it; remove the
  job folder on failure too; no claim below `WORKER_MIN_FREE_DISK_GB`; never run `hyperframes
clean` from the worker; never write storage from a job except through `recordingStorage`.
- `docs/conditional-docs.md`: one line for `app_docs/storage.md` (when changing `stored_files`,
  `worker_status`, slimming, export expiry, scratch cleanup, the disk guard, `recordingStorage`,
  or the waiting reason).
- `app_docs/studio.md`: the worker line about free disk (now `worker_status` and the studio
  display), the tables list, the test lists (new DB test and spec) and point to `storage.md`.
- `app_docs/export.md`: the render environment's three scratch variables; remove "deleting
  rebuildable files and the disk guard" from out of scope; export expiry now also deletes the
  object (the lifecycle rule stays as backstop).
- `app_docs/pipeline.md`: "the cleanup (slice 14)" now points to `storage.md`; hits record rows.
- `app_docs/upload.md`: `finish_upload` also records the `source` row.
- `.adw/project.md`: in Tests, add `stored-files.test.ts` to the DB layer list and
  `disk-guard.spec.ts` (and the extended `upload.spec.ts`) to the studio E2E description. Do not
  rename or reorder its headings.

### 13. Run the validation commands

- Run every command in `Validation Commands` in order; fix anything that fails without weakening a
  test, a type or a rule.

## Testing Strategy

### Unit Tests

- `apps/worker/src/stored-files.test.ts`: key classification; every `write` method records once
  with the right row (`written` and `exists`); `delete` refused; unknown key refused before writing.
- `apps/worker/src/pipeline/definition.test.ts`: `retentionOf`.
- `apps/worker/src/pipeline/run-pipeline.test.ts`: hits recorded; rebuild of the three deleted
  rebuildable outputs while kept outputs stay hits or untouched.
- `apps/worker/src/scratch.test.ts`: cleanup on failure and success, bytes logged, stale sweep.
- `apps/worker/src/render/render-call.test.ts`: the scratch-scoped HyperFrames variables.
- `apps/worker/src/disk-guard.test.ts`: no claim at 9 GB, claim at 11 GB, reason set and cleared,
  the switch inert outside `E2E_MOCK_STORAGE=true`.
- `apps/worker/src/slimming.test.ts`: returned objects deleted on the fake, others kept, failures
  logged, hourly cadence with a fixed clock.
- `apps/studio/src/lib/worker-status.test.ts`: the reason shown.

### Test Coverage

- Unit (`yarn test`), `stored-files.test.ts`: catches a storage write that leaves no `stored_files`
  row; nothing checks recording today.
- Unit, `disk-guard.test.ts`: catches a claim made below the minimum and a reason not cleared; the
  current inline check has no test.
- Unit, `scratch.test.ts`: catches a job folder left behind after a failure.
- Unit, `slimming.test.ts`: catches deleting objects the database did not return, or deleting
  before recording.
- Unit, `run-pipeline.test.ts` rebuild case: catches a render that fails or skips after
  rebuildable outputs were deleted.
- Unit, `render-call.test.ts`: catches the render writing its frame cache or history outside the
  job folder.
- Unit (studio), `worker-status.test.ts`: catches showing a stale or cleared reason.
- DB (`yarn turbo run test:db --filter=./apps/studio`), `stored-files.test.ts`: catches wrong
  slimming selection (8 days, 6 days, never exported, shared with yesterday's export, prefix),
  wrong export expiry, owner leaks, writes by `authenticated`, an un-delete, and `finish_upload`
  not recording the source.
- E2E (`yarn test:e2e`), extended `upload.spec.ts`: catches any object in the run's storage
  without exactly one correct row after a real process and export.
- E2E, `disk-guard.spec.ts`: catches the studio not showing the waiting reason live, and the
  worker claiming below the minimum.
- Worker tools (`test:tools`, owner's Mac only): a real render leaves nothing in the default
  HyperFrames history and no job folder.

### Edge Cases

- A fingerprinted output shared by two reels: one exported 8 days ago, the other yesterday, or
  never: kept.
- The same key re-stored after slimming (a rebuild): a new undeleted row; the old row keeps its
  `deleted_at`.
- `putIfAbsent` / `putFileIfAbsent` answering `exists` (another reel or an earlier attempt stored
  it): a row for this reel all the same.
- A retried job: recording is idempotent per reel and key.
- Object delete fails after marking: logged; the row stays deleted; a later export HEADs the key,
  finds it and records a fresh row (no silent delete ever).
- Free space exactly at the minimum: claims.
- `E2E_MOCK_FREE_DISK_GB` set without `E2E_MOCK_STORAGE=true`: ignored; malformed with it: throws.
- Worker killed mid-job: the next `worker` start removes the UUID-named folder.
- A lost lease: the scratch folder is still removed.
- Keys under another prefix (dev vs production, or a spec's prefix): never slimmed by this worker.
- A reel deleted: its rows go with it (cascade).
- Several `worker_status` rows (spec workers, a second machine): the newest non-null reason shows.

## Acceptance Criteria

- `stored_files` and `worker_status` exist with the columns, constraints, RLS, grants and Realtime
  membership above; `yarn turbo run test:db --filter=./apps/studio` passes.
- After processing and exporting the fixture reel, every object in the run's `.e2e-storage/`
  prefix, plus the source, has exactly one `stored_files` row with the right `bytes`, `kind` and
  `step`.
- `slim_rebuildable_files` marks and returns only rebuildable keys of reels whose last export is
  more than 7 days old and that no other reel within its window (or never exported) holds; the
  worker deletes exactly those objects; source, previews, kept outputs and versions are never
  deleted.
- Expired exports are marked and their objects deleted.
- Exporting a slimmed reel re-runs `convert`, `retime` and `remove_background` and succeeds;
  `transcribe`, `head_track` and `preview_copies` are hits; versions untouched.
- No `WORKER_SCRATCH_DIR/<job_id>` remains after a job, on success or on failure; the bytes freed
  are logged; the render's frame cache and HyperFrames history live inside the job folder.
- At 9 GB free with a 10 GB minimum no `claim_job` call is made and `worker_status.waiting_reason`
  is set; at 11 GB the job is claimed and the reason cleared.
- The reel page shows the waiting reason under a queued job without a reload, and hides it once the
  worker claims.
- `app_docs/storage.md` exists with a Rules section; `docs/conditional-docs.md` lists it; the other
  docs and `.adw/project.md` are in step.
- All gates pass; no em-dashes added anywhere.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset` - applies the new migration to the run's ADW stack (the profile's
  rule after adding a migration; never `supabase migration up`, `start`, `stop` or `db reset`). If
  it fails, report the error and stop.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` - lint the two changed
  workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio` - types, including the
  `Record<keyof Storage, ...>` exhaustiveness check.
- `yarn knip` - no unused export or file from the new modules.
- `yarn format:check` - Prettier over the repository (includes the new doc and spec).
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio` - unit tests, including the
  migration version guard.
- `yarn turbo run test:db --filter=./apps/studio` - the new DB tests against the ADW stack.
- `yarn turbo run build --filter=./apps/worker --filter=./apps/studio` - studio build (the worker's
  build check is its typecheck).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - the landing and studio suites,
  including the extended `upload.spec.ts` and the new `disk-guard.spec.ts` (servers from
  `/prepare_app`, sourced from `.ports.env`).
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build` - the
  issue's full gate, unfiltered, before the E2E run above.
- `yarn workspace @edit-issebya/worker test:tools` - owner's Mac only, never CI: a real render
  leaves no job folder and nothing in HyperFrames' default history.

## Notes

- **`hyperframes clean` is not used.** On the pinned 0.8.222 its `DIR` only adds one project to a
  sweep that also covers every project in the default history root (`~/.cache/hyperframes/history`,
  a constant in `clean`), the shared extract cache and abandoned render folders under the OS temp
  directory. A dry run on an empty folder listed caches of the reference repository
  (`issebya-homes-reels`), which the pipeline rules forbid writing to. The equivalent the pinned
  version documents is to relocate what a render leaves: `render --frames-cache-dir` /
  `HYPERFRAMES_EXTRACT_CACHE_DIR` for the frame cache and `HYPERFRAMES_HISTORY_ROOT` for history
  (read by the render's history code), plus `TMPDIR` for its work folders. All three point inside
  the job folder, which the `finally` removes. `transcribe` and `remove_background` also run
  HyperFrames; scoping their environment the same way is a small follow-up if the owner's `df`
  check shows leftovers.
- **Three rebuildable files, not two.** The issue names converted footage and the full-size
  background removal; the pipeline (slice 7) also tags retime's `source.mp4` `rebuildable`. The
  tags are authoritative, so slimming deletes all three and a re-export re-runs `convert`, `retime`
  and `remove_background`.
- **Database command.** The issue says to run `supabase migration up --local`; the profile's
  Protected section forbids that in a run and prescribes `.adw/supabase-stack reset` after adding a
  migration. The plan follows the profile.
- Recording the raw footage happens inside `finish_upload` (security definer, size from storage),
  which is the studio's complete-upload path; the owner gets no write grant on `stored_files`.
- Slimming runs only between jobs of one worker. A second worker on the same database could race a
  render against a slimming; the heartbeat slice (15) is the place for a cross-worker rule.
- Stale `worker_status` rows (a worker that went away) stay until that worker writes again; the
  heartbeat and offline display are slice 15. Specs delete their own row.
- `make-pipeline-fixtures.ts` and the test seeding helpers write storage directly on purpose (dev
  tool and test fixtures, not jobs).
- No new dependency.
- Owner steps (not for the pipeline): apply the migration to the hosted project after merge; the
  manual `df` check and the 8-days-back re-export comparison from the issue; deciding whether
  never-exported reels are ever slimmed (follow-up).
- Not verified by the pipeline: real R2 deletions and the real disk on the worker machine.
