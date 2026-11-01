# Feature: storage records, seven-day slimming, scratch cleanup and the disk guard

## Metadata

issue_number: `37`
adw_id: `e5831ece`
issue_json: `{"number":37,"title":"feat: storage records, seven-day slimming, scratch cleanup and the disk guard"}`

## Feature Description

Reel studio MVP, slice 14 of 17. Two places fill up: R2 and the worker machine's disk. This slice
keeps both under control and measures storage as closely as time is measured:

- Every stored file gets a `stored_files` row: reel, owner, step, R2 key, size, kind (`source`,
  `kept`, `rebuildable`, `version`, `export`), when it was written and when it was deleted.
- Heavy files that can be rebuilt (`rebuildable`) are deleted seven days after a reel's last
  export, never earlier, and never while another reel that shares the fingerprinted object still
  needs it. Raw footage, preview copies and versions are never deleted.
- Expired exports (24 hours) get `deleted_at` and their object is deleted if R2's lifecycle rule
  has not already removed it.
- Every job runs in its own scratch directory `WORKER_SCRATCH_DIR/<job_id>`, removed when the job
  ends, on success and on failure, with the bytes freed logged.
- The worker claims no job while the scratch volume has less than `WORKER_MIN_FREE_DISK_GB` free.
  It writes the reason to `worker_status`, and the studio's reel page shows that reason live under
  a `queued` job.

## User Story

As the studio owner running the worker on my own machine
I want every stored file recorded, rebuildable files and old exports cleaned up on a fixed rule,
temporary files removed after each job, and no job started on a nearly full disk
So that R2 and my disk never fill up silently, storage costs can be measured per reel and per
step, and I can see in the studio why a job is waiting

## Problem Statement

Nothing records what the worker and the studio put in R2, so the space a reel uses cannot be
measured and nothing can safely be deleted. The worker's disk guard in `apps/worker/src/main.ts`
(`enoughDisk`) only logs a warning: it is untested, absent from `once`, and invisible in the
studio. Jobs have no scratch directory of their own, so later video steps (render frame caches of
about 3 GB) would leave files behind on failure.

## Solution Statement

- One migration adds `stored_files` and `worker_status` with RLS, a service-role-only
  `record_stored_file` function (idempotent per reel and key), and extends `finish_upload` so the
  studio's complete-upload path records the raw footage in the same transaction.
- The worker gets a small set of modules, each behind an interface so it is unit tested without a
  database (the `StepStore` pattern):
  - `stored-files.ts`: the `StoredFileStore` (record, list candidates, mark deleted) and
    `recordedStorage`, the only way worker code writes to storage: its `put` requires a `kind` and
    a `step` and records a row after every write.
  - `slimming.ts`: a pure selection with an injected clock (which rebuildable keys and which
    expired exports to delete), and `housekeep`, which marks rows deleted and then deletes the
    objects. It runs inside the existing drain loop between jobs, at most hourly.
  - `scratch.ts`: `runInScratch`, which creates `<root>/<job_id>`, runs the job, and removes the
    directory in a `finally`, logging bytes freed.
  - `disk-guard.ts`: `createDiskGuard` with an injected free-space function; `claimIfRoom`
    never calls `claim_job` below the minimum and writes or clears `worker_status.waiting_reason`.
    Under `E2E_MOCK_STORAGE=true` only, `E2E_MOCK_FREE_DISK_GB` replaces the real free space.
- The studio reads `worker_status` once on the server and follows it through Realtime; a `queued`
  job shows the waiting reason.

### Scope against the current tree (read this first)

The issue says "After #35", but #35 (exports) and the steps it relies on (#29 convert, #30
background removal and previews, #31 versions, #33 decide) are still open on `develop` as of this
plan: the worker has one in-process step, `receive`, and writes nothing to storage; there is no
`exports` table, no `cache/` layout, no step definition carrying `kept`/`rebuildable`, no render
and no HyperFrames dependency. This plan therefore builds every mechanism the issue asks for
against the tree as it is, so later slices plug in without changing the rules:

- The **last export** of a reel is the newest `stored_files` row of kind `export` for that reel
  (every export writes one, rule 2), so slimming needs no `exports` table. An export expires
  `EXPORT_LIFETIME_MS` (24 hours, slice 12's window) after its row's `created_at`.
- Worker writes go through `recordedStorage`, so the export, convert, background-removal and
  version writes of later slices are recorded by construction, and a test fails if any worker or
  studio module writes to storage another way.
- Verification items that need a real export and a rebuild (issue Verification 1's "export" half
  and Verification 3, and the HyperFrames `clean` call) cannot run until those slices land. They
  are listed under Notes as the follow-up hook, not faked here.

If #35 has merged by the time this plan is implemented, stop and re-plan: the export row should
then also be written by its render job, and `expires_at` read from `exports`.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview and how the worker runs.
- `AGENTS.md`: repository rules (Yarn only, no em-dashes, docs layout, `.adw/project.md` upkeep).
- `.adw/project.md`: ADW profile; Tests section lists the DB tests and specs by name and must gain
  the new ones; Protected forbids anything but `supabase migration up --local`.
- `docs/conditional-docs.md`: gains one line for `app_docs/storage.md`.
- `app_docs/studio.md`: the reels, jobs, steps tables, `finish_upload`, `claim_job`, worker and
  doubles; its Rules are invariants (never poll from the studio, never read more than `id` in the
  worker's periodic job check, never create clients at module load, never put large content in
  rows). Its `finish_upload` and Worker paragraphs need a pointer to the new doc.
- `app_docs/measurement.md`: step runner and `StepContext`; Rules on telemetry this change must
  respect (log bytes freed through the existing console logging, no new PostHog event).
- `supabase/migrations/20261031105245_studio_skeleton.sql`, `20261031174750_job_queue.sql`,
  `20261101090000_step_measurements.sql`: the grant, RLS, `security definer` and publication
  patterns to copy; `finish_upload` is redefined (with `create or replace`) by the new migration.
- `apps/worker/src/main.ts`: holds today's inline `enoughDisk`; replaced by the guard and gains the
  housekeeping timer.
- `apps/worker/src/once.ts`: must apply the same guard before `claimJob` so a spec can prove it.
- `apps/worker/src/loop.ts`, `loop.test.ts`: the drainer; housekeeping runs inside its `claim`.
- `apps/worker/src/process-job.ts`: wires a job; wraps it in `runInScratch` and passes the scratch
  dir and `recordedStorage` into the step context.
- `apps/worker/src/step-runner.ts`: `StepContext` gains `scratch: string`.
- `apps/worker/src/recording-steps.ts`: test helper; `stepContext` gains a scratch default.
- `apps/worker/src/step-store.ts`: the store-interface pattern to copy for `StoredFileStore` and
  `WorkerStatusStore`.
- `apps/worker/src/queue.ts`: `claimJob`, which the guard wraps.
- `apps/worker/src/config.ts`, `config.test.ts`: `minFreeDiskGb`, `scratchDir`; gains the
  E2E-only free-space override.
- `apps/worker/src/storage.ts`: `workerStorage()`; unchanged, but it is what `recordedStorage`
  wraps.
- `apps/worker/src/format.ts`: `formatBytes`, used for the bytes-freed log and the waiting reason.
- `apps/worker/.env.example`: documents `WORKER_MIN_FREE_DISK_GB` and `WORKER_SCRATCH_DIR`; gains
  `E2E_MOCK_FREE_DISK_GB`.
- `packages/storage/src/storage.ts`, `fake.ts`: the `Storage` interface and the folder fake used
  by the worker's integration-style unit tests (on a temp root).
- `apps/studio/src/app/upload-actions.ts`: `finishUpload`, the studio's complete-upload path (its
  RPC now records the source row).
- `apps/studio/src/app/reels/[id]/page.tsx`, `apps/studio/src/components/LiveReel.tsx`: server
  read plus Realtime; gain `worker_status`.
- `apps/studio/src/lib/jobs.ts`, `jobs.test.ts`: named column lists and pure helpers; gains the
  worker status columns and `waitingReason`.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: the fake's receiving side (the
  browser's PUT), allow-listed in the write-path scan because it stands in for R2 itself.
- `apps/studio/db-tests/rls.test.ts`, `realtime.test.ts`, `jobs.test.ts`: patterns for the new DB
  tests; `rls.test.ts`'s "every public table" check covers the two new tables automatically.
- `apps/studio/test-support/fixtures.ts`, `worker.ts`, `local-supabase.ts`: `createTestUser`,
  `insertReel`, `runWorkerOnce(env)`, `claimableJobIds`, the local-URL guard.
- `apps/studio/e2e/upload.spec.ts`: extended to assert the source's `stored_files` row and that
  every object under the reel's prefix has exactly one row.
- `turbo.json`: `@edit-issebya/studio#test:e2e` already passes `E2E_MOCK_*` and `WORKER_*`
  through, so no change is expected; check it.
- `knip.json`: worker and studio project globs already cover the new files.

### New Files

- `supabase/migrations/20261101120000_storage_records.sql`: `stored_files`, `worker_status`,
  `record_stored_file`, the new `finish_upload`, grants, RLS, publication.
- `apps/worker/src/stored-files.ts`: `StoredFileKind`, `StoredFileStore`,
  `supabaseStoredFileStore(db)`, `recordedStorage(storage, files, job)`.
- `apps/worker/src/stored-files.test.ts`: recording on put, idempotency, the folder-fake
  integration check, and the write-path scan of `apps/worker/src`.
- `apps/worker/src/slimming.ts`: `selectSlimming`, `housekeep`, `createHousekeeping`,
  `SLIM_AFTER_MS`, `EXPORT_LIFETIME_MS`.
- `apps/worker/src/slimming.test.ts`: the fixed-clock selection cases and the folder-fake run.
- `apps/worker/src/scratch.ts`, `scratch.test.ts`: `runInScratch`.
- `apps/worker/src/disk-guard.ts`, `disk-guard.test.ts`: `createDiskGuard`, `claimIfRoom`,
  `waitingReason`, `freeDiskBytes`, `supabaseWorkerStatusStore`.
- `apps/studio/src/lib/storage-writes.test.ts`: the write-path scan of `apps/studio/src`.
- `apps/studio/db-tests/stored-files.test.ts`: RLS, `record_stored_file`, `finish_upload` source
  row, `worker_status` access and Realtime.
- `apps/studio/e2e/disk-guard.spec.ts`: the reel page shows the waiting reason live, then it
  clears.
- `app_docs/storage.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

The migration and the worker's store interfaces: `stored_files` and `worker_status` exist with
RLS, the worker can record and mark rows through `StoredFileStore` and `WorkerStatusStore`, and
`finish_upload` records the source in the same transaction as it queues the job.

### Phase 2: Core Implementation

Pure, unit-tested worker logic: `recordedStorage`, the slimming selection and `housekeep`,
`runInScratch`, the disk guard. Each takes its clock, free-space function and stores as
arguments.

### Phase 3: Integration

Wire them into `processJob`, `main.ts` and `once.ts`; add the studio's waiting reason with server
read and Realtime; extend the upload spec, add the disk-guard spec and the DB tests; write
`app_docs/storage.md`, the index line, and the profile's Tests list.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Migration `supabase/migrations/20261101120000_storage_records.sql`

- Header comment in the style of the existing migrations, pointing to `app_docs/storage.md`.
- `create table public.stored_files`:
  - `id uuid primary key default gen_random_uuid()`
  - `reel_id uuid not null references public.reels (id) on delete cascade`
  - `owner_id uuid not null references auth.users (id) on delete cascade`
  - `step text not null` (`upload` for the raw footage, else the step name, e.g. `convert`,
    `export`)
  - `r2_key text not null`
  - `bytes bigint not null check (bytes >= 0)`
  - `kind text not null constraint stored_files_kind_check check (kind in ('source', 'kept',
'rebuildable', 'version', 'export'))`
  - `created_at timestamptz not null default now()`, `deleted_at timestamptz`
  - `check (deleted_at is null or deleted_at >= created_at)`
- Indexes: `create unique index stored_files_live_key_idx on public.stored_files (reel_id,
r2_key) where deleted_at is null` (one live row per reel and object; a shared fingerprinted
  object has one row per reel using it); `stored_files_key_idx on (r2_key) where deleted_at is
null`; `stored_files_reel_idx on (reel_id, created_at)`.
- RLS on; `revoke all on public.stored_files from anon, authenticated`; `grant select ... to
authenticated`; policy `"stored_files: owner selects own"` `using ((select auth.uid()) =
owner_id)`. No insert, update or delete for `authenticated`.
- `create table public.worker_status` (`worker_id text primary key check (length(trim(worker_id))
  > 0)`, `free_disk_bytes bigint check (free_disk_bytes >= 0)`, `waiting_reason text`, `updated_at
  > timestamptz not null default now()`), the `set_updated_at`trigger from the skeleton migration,
RLS on,`revoke all ... from anon, authenticated`, `grant select ... to authenticated`, policy
`"worker_status: signed-in users select"` `to authenticated using (true)` with a comment that it
  > holds no reel data.
- `create function public.record_stored_file(p_reel_id uuid, p_owner_id uuid, p_step text, p_r2_key
text, p_bytes bigint, p_kind text) returns uuid`, `security definer`, `set search_path = ''`:
  `insert ... on conflict (reel_id, r2_key) where deleted_at is null do update set bytes =
excluded.bytes, step = excluded.step, kind = excluded.kind returning id`. Revoke execute from
  `public, anon, authenticated`; grant to `service_role` (the `claim_job` pattern).
- `create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)`: the same body,
  with the reel update changed to `returning owner_id, source_key into ...`, then
  `insert into public.stored_files (reel_id, owner_id, step, r2_key, bytes, kind) values
(p_reel_id, v_owner, 'upload', v_key, p_bytes, 'source')`, all in the one transaction. Re-apply
  the same revoke and grant lines after it.
- `alter publication supabase_realtime add table public.worker_status;` (`stored_files` stays out
  of the publication: the dashboard of slice 17 reads it, nothing follows it live).
- Run `supabase migration up --local`. If it fails, report the error and stop; never reset.

### 2. Worker stores: `apps/worker/src/stored-files.ts`

- `export type StoredFileKind = "source" | "kept" | "rebuildable" | "version" | "export"`.
- `export interface StoredFileStore { record(row: { reelId; ownerId; step; key; bytes; kind }):
Promise<void>; liveFiles(kinds: StoredFileKind[]): Promise<LiveFile[]>; markDeleted(ids: string[]):
Promise<string[]> }` where `LiveFile = { id, reel_id, r2_key, kind, created_at }` (identifiers and
  times only, B3; no content). `markDeleted` runs `update ... set deleted_at = now() where id in
(...) and deleted_at is null returning id`, so a row already marked is never counted twice.
- `supabaseStoredFileStore(db)`: `record` calls `db.rpc("record_stored_file", ...)`; `liveFiles`
  selects exactly `id, reel_id, r2_key, kind, created_at` with `deleted_at is null` and `kind in
(...)`; `markDeleted` as above. Errors throw with a short message, like `step-store.ts`.
- `recordedStorage(storage: Storage, files: StoredFileStore, job: ClaimedJob)`: returns `{ head,
get, signDownload, put(key, body, { kind, step, contentType }) }`. `put` calls `storage.put`,
  then `files.record({ reelId: job.reel_id, ownerId: job.owner_id, step, key, bytes:
body.byteLength, kind })`. `kind: "source"` is refused (only the studio's `finish_upload` records
  sources). No `delete` and no `signUpload` on it: steps can neither delete nor sign uploads.
- Export type `RecordedStorage = ReturnType<typeof recordedStorage>`.

### 3. Tests for recording: `apps/worker/src/stored-files.test.ts`

- With an in-memory `StoredFileStore` and `fakeStorage` on a `mkdtemp` root: three puts of
  different kinds then `storage.list("")` equals the recorded keys, each recorded once with
  `bytes` equal to the body length, the given `kind` and `step`, the job's reel and owner.
- A second put of the same key records again with the new size (the store's upsert), still one
  live row per key in the in-memory store that mirrors the unique index.
- A failed `storage.put` records nothing; `kind: "source"` throws.
- **Write-path scan** ("no write path skips it"): read every `apps/worker/src/**/*.ts` that is not
  a test (`readdir` recursive, with the same `security/detect-non-literal-fs-filename` disable
  comment as the fake); assert that `.put(` and `signUpload(` on a storage object appear only in
  `stored-files.ts`. A module that writes around the recorder fails this test.

### 4. Studio write-path scan: `apps/studio/src/lib/storage-writes.test.ts`

- Read every non-test `.ts`/`.tsx` file under `apps/studio/src`; assert `signUpload(` appears only
  in `src/app/upload-actions.ts` (whose upload completes through `finish_upload`, which records the
  row) and `.put(` only in `src/app/api/e2e-storage-mock/[...key]/route.ts` (the fake's receiving
  side, standing in for R2). Any other studio write fails it.

### 5. Slimming: `apps/worker/src/slimming.ts`

- Constants: `SLIM_AFTER_MS = 7 * 24 * 3600 * 1000`, `EXPORT_LIFETIME_MS = 24 * 3600 * 1000`,
  `HOUSEKEEPING_EVERY_MS = 3600 * 1000`.
- `selectSlimming(files: LiveFile[], now: Date): { rebuildable: { ids: string[]; keys: string[] };
exports: { ids: string[]; keys: string[] } }`, pure:
  - `lastExport(reel)` = max `created_at` of that reel's rows of kind `export` (live or not: the
    caller passes live rows plus export rows of all states, see `housekeep`).
  - A reel is **eligible** when it has a last export and `now - lastExport > SLIM_AFTER_MS`
    (strictly more than seven days). A never-exported reel is never eligible.
  - A rebuildable key is deleted only when **every** live `rebuildable` row with that key belongs
    to an eligible reel; then all those rows' ids are returned. Otherwise none of its rows is
    touched (a reel exported yesterday, or never exported, still needs it).
  - Only kind `rebuildable` is ever selected under `rebuildable`; `source`, `kept` and `version`
    never appear in the output whatever their age.
  - An export row is expired when `now - created_at > EXPORT_LIFETIME_MS`.
- `housekeep({ files, storage, now, log })`: reads `files.liveFiles(["rebuildable", "export"])`
  plus every export row's `reel_id, created_at` (add `exportTimes()` to the store, selecting only
  those two columns, including deleted rows, so an expired export still dates the last export),
  runs `selectSlimming`, then for each group: `markDeleted(ids)` first, then `storage.delete(key)`
  for each key (the fake and R2 both succeed on a missing object, so an export R2's lifecycle
  already removed is fine). Order matters: the row is marked before the object goes, so a deletion
  is never silent. If a delete throws, log it and leave the row marked (the object is a leak the
  next run cannot see, logged with its key; never an unrecorded delete). Logs `slimmed N files of
M reels` and `expired N exports`.
- `createHousekeeping({ everyMs, now, run })`: `due()` true on first call and then every `everyMs`
  by the injected clock; `maybeRun()` runs `run` when due and swallows and logs its error so a
  housekeeping failure never blocks claiming.

### 6. Tests for slimming: `apps/worker/src/slimming.test.ts`

Fixed clock `NOW = new Date("2026-11-20T12:00:00Z")`.

- Reel A exported 8 days ago with source, kept preview, version, two rebuildable files: both
  rebuildable ids and keys selected, nothing else.
- Reel B exported 6 days ago: nothing selected. Boundary: exactly 7 days, nothing selected.
- Reel C never exported, with rebuildable files 30 days old: nothing selected.
- Shared object: reel A (8 days) and reel D (exported yesterday) both have a live rebuildable row
  for one key: that key and both rows are kept; A's other, unshared rebuildable key is selected.
- Shared with never-exported reel C: kept.
- Export rows 25 hours old selected under `exports`, 23 hours old not.
- `housekeep` with `fakeStorage` on a temp root and the in-memory store: after it runs, the two
  rebuildable objects of A are gone from the folder and their rows have `deleted_at`; the source,
  preview and version objects and rows are untouched; B's files are untouched. Running it twice
  deletes nothing more.
- `markDeleted` is called before `storage.delete` (record the call order).
- `createHousekeeping`: due at start, not again until `everyMs` later; a throwing `run` is logged
  and `maybeRun` resolves.

### 7. Scratch directory: `apps/worker/src/scratch.ts`

- `runInScratch<T>({ root, jobId, log }, work: (dir: string) => Promise<T>): Promise<T>`: refuses a
  `jobId` that is not a UUID (no path out of `root`); `mkdir(join(root, jobId), { recursive: true
})`; `try { return await work(dir) } finally { bytes = await sizeOf(dir); await rm(dir, {
recursive: true, force: true }); log(\`job ${jobId}: scratch cleared, ${formatBytes(bytes)}
  freed\`) }`. A failing `sizeOf`never prevents the`rm`.
- The render's frame cache and intermediate encodes of later slices live inside this directory,
  so this one removal covers them.

### 8. Tests for scratch: `apps/worker/src/scratch.test.ts`

- Success: `work` writes two files into `dir`; afterwards `<root>/<jobId>` does not exist and the
  log names the byte total.
- Failure in the middle: `work` writes a file then throws; the error propagates and the directory
  does not exist.
- A non-UUID id (`../x`) throws before anything is created.

### 9. Disk guard: `apps/worker/src/disk-guard.ts`

- `export interface WorkerStatusStore { write(status: { freeDiskBytes: number; waitingReason:
string | null }): Promise<void> }`; `supabaseWorkerStatusStore(db, workerId)` upserts
  `worker_status` on `worker_id`.
- `waitingReason(freeBytes, minGb)` returns `waiting: 7.2 GB free on the worker's disk, needs 10 GB`
  (free space with one decimal in GB of 1024^3, the minimum as configured).
- `freeDiskBytes(dir, env)`: when `isE2EMockStorage(env)` and `E2E_MOCK_FREE_DISK_GB` is a
  non-negative number, returns that times 1024^3; otherwise `statfs(dir)` (`bavail * bsize`),
  after `mkdir(dir, { recursive: true })`. Outside the mock flag the variable is ignored entirely.
- `createDiskGuard({ freeBytes, minFreeDiskGb, status, log })`: `check()` reads free bytes; when
  below the minimum it writes the reason (only when it differs from the last one written, so idle
  ticks do not churn Realtime) and logs it, returns false; at or above it writes `waitingReason:
null` if the last write was a reason (or on the first check), returns true.
- `claimIfRoom(guard, claim)`: `async () => ((await guard.check()) ? claim() : null)`.
- Remove `enoughDisk` and its `statfs` import from `main.ts`.

### 10. Tests for the disk guard: `apps/worker/src/disk-guard.test.ts`

- At 9 GB free with a 10 GB minimum: `claimIfRoom` resolves null, the injected `claim` spy is
  never called, the status store received `waiting: 9.0 GB free on the worker's disk, needs 10 GB`.
- Then at 11 GB: `claim` is called once and its job returned, the store received `waitingReason:
null`.
- Two low checks in a row write once.
- `freeDiskBytes` with `E2E_MOCK_FREE_DISK_GB=7.2` and `E2E_MOCK_STORAGE=true` returns 7.2 GB;
  with the flag absent or `"1"` it ignores the variable and reads the real volume (assert it is a
  positive number, not 7.2 GB).
- Negative proof (done once while implementing, not committed): replace `claimIfRoom(guard, claim)`
  with `claim` in the test and see the 9 GB case fail because the claim happens; restore.

### 11. Wire the worker

- `step-runner.ts`: add `scratch: string` to `StepContext` (the job's scratch directory) with a
  comment; `recording-steps.ts`'s `stepContext` takes an optional `scratch` defaulting to
  `tmpdir()`.
- `process-job.ts`: wrap the body in `runInScratch({ root: config.scratchDir, jobId: job.id, log:
console.log }, (scratch) => ...)` so the directory is removed after `finish`/`fail` and on a
  lost lease; build `recordedStorage(storage, supabaseStoredFileStore(db), job)` and pass it, with
  `scratch`, in the step context. `receive` keeps using `head` only (it writes nothing).
- `main.ts`: `const guard = createDiskGuard({ freeBytes: () => freeDiskBytes(config.scratchDir),
minFreeDiskGb: config.minFreeDiskGb, status: supabaseWorkerStatusStore(db, config.workerId) })`;
  `const housekeeping = createHousekeeping({ everyMs: HOUSEKEEPING_EVERY_MS, now: () => new Date(),
run: () => housekeep({ files, storage, now: new Date(), log: console.log }) })`; the drainer's
  `claim` becomes `async () => { await housekeeping.maybeRun(); return claimIfRoom(guard, () =>
claimJob(db, config))(); }`, so housekeeping runs inside the loop, between jobs, never during
  one. Add a `setInterval(() => drainer.signal(), HOUSEKEEPING_EVERY_MS)` cleared on stop, so an
  idle worker still housekeeps hourly. The existing poll keeps re-checking the guard while a job is
  queued.
- `once.ts`: claim through the same `claimIfRoom(guard, ...)`; when the guard refuses, print
  `no job: <reason>` and exit 0. `once` does not housekeep (specs must stay fast and touch only
  their own reel).
- `apps/worker/.env.example`: add, in the tests-only block, `E2E_MOCK_FREE_DISK_GB=` with a comment
  that it is read only when `E2E_MOCK_STORAGE` is exactly true and replaces the free space the
  disk guard sees. Update the `WORKER_SCRATCH_DIR` comment: each job gets `<dir>/<job id>`, removed
  when the job ends.
- `config.test.ts`: unchanged behaviour; add nothing unless `config.ts` changes.

### 12. Studio: the waiting reason

- `apps/studio/src/lib/jobs.ts`: `WORKER_STATUS_COLUMNS = "worker_id, waiting_reason, updated_at"`,
  `interface WorkerStatusRow`, and pure `waitingReason(statuses: WorkerStatusRow[]): string | null`
  (the newest non-null reason by `updated_at`, else null). Unit tests in `jobs.test.ts`: empty,
  all null, two reasons picks the newest.
- `apps/studio/src/app/reels/[id]/page.tsx`: read `worker_status` (named columns) in the same
  `Promise.all`, throw on error like the others, pass `workerStatuses` to `LiveReel`.
- `LiveReel.tsx`: hold `workerStatuses` in state; include it in `readSnapshot`; add a
  `postgres_changes` listener `{ event: "*", schema: "public", table: "worker_status" }` that
  upserts by `worker_id` (DELETE removes it). Under a job whose `status === "queued"` and when
  `waitingReason(workerStatuses)` is set, render `<p data-testid="job-waiting"
className="text-sm text-amber-800">{reason}</p>`. No polling, no interval (studio rule).

### 13. DB tests: `apps/studio/db-tests/stored-files.test.ts`

Modelled on `rls.test.ts` and `realtime.test.ts`, local stack only through the existing helpers:

- `finish_upload` on an owner's uploading reel inserts exactly one `stored_files` row: kind
  `source`, step `upload`, `r2_key` equal to `reels.source_key`, `bytes` equal to `p_bytes`,
  `deleted_at` null.
- The owner reads their rows; another user and anon read none; the owner's insert, update and
  delete change nothing.
- `record_stored_file` is refused for `authenticated` and `anon`; through the admin client, two
  calls with the same reel and key leave one live row with the second size; after the row gets
  `deleted_at`, a third call creates a new live row (a rebuild after slimming).
- `worker_status`: an authenticated user reads rows, anon reads nothing, an authenticated insert or
  update is refused; an admin upsert of a `waiting_reason` is delivered over Realtime to a signed-in
  user's channel.
- Clean up the users (cascade) and the test's `worker_status` row in `afterAll`.

### 14. E2E: extend `apps/studio/e2e/upload.spec.ts`

- After the upload finishes and the worker's `once` ran: read `stored_files` for the reel with the
  admin client; expect exactly one row `{ kind: "source", step: "upload", r2_key: sourceKey, bytes:
clipBytes, deleted_at: null }`; and `storage.list(<prefix of sourceKey up to /source/>)` lists
  exactly the keys of the reel's live rows (every object in `.e2e-storage/` for this reel has
  exactly one row). Fails without the migration's `finish_upload` change.

### 15. E2E: new `apps/studio/e2e/disk-guard.spec.ts`

Modelled on `upload.spec.ts` (same leftover-claimable-jobs `beforeAll` check, same cleanup):

- Create a test user, insert an `uploaded` reel with `insertReel` (or the admin client) and a
  `queued` `process` job; put a few bytes at its source key through `fakeStorage` on the
  `.e2e-storage` root so `receive` can succeed.
- Sign in, open `/studio/reels/<id>`, wait for `[data-realtime="ready"]`.
- `runWorkerOnce({ WORKER_ID: id, E2E_MOCK_FREE_DISK_GB: "7.2" })` with one fixed `id` for both
  runs: exit code 0, output contains `no job`; the page shows `job-waiting` with text `waiting: 7.2
GB free on the worker's disk, needs 10 GB` without a reload (the `__noReload` marker of
  `upload.spec.ts`); the job is still `queued` in the database.
- `runWorkerOnce({ WORKER_ID: id, E2E_MOCK_FREE_DISK_GB: "50" })`: exit 0, `job-status` becomes
  `done` and `job-waiting` is gone.
- `afterAll`: delete the source object, the `worker_status` row for `id`, and the user.
- Fails without the feature: no `worker_status` table, no guard in `once`, no `job-waiting`.

### 16. Documentation

- `app_docs/storage.md` with the structure of the other feature docs (Overview, How it works, How
  to Use, Configuration, Testing, Rules, Notes): `stored_files` and its five kinds and who writes
  each (`finish_upload` for `source`, `recordedStorage` for the rest); what is kept and what is
  deleted and when (rebuildable seven days after the last export, exports after 24 hours, never
  the source, previews or versions); one live row per reel and object and how shared fingerprinted
  objects are kept while any user of them is inside its window or never exported; the hourly
  housekeeping inside the drain loop and its mark-then-delete order; per-job scratch directories;
  the disk guard, `worker_status` and the studio's waiting reason; `E2E_MOCK_FREE_DISK_GB`; the
  follow-ups listed in Notes below. Rules section:
  - Never delete a `source`, `kept` or `version` object; only `rebuildable` files and expired
    exports are ever deleted.
  - Never delete a rebuildable file within seven days of its reel's last export, and never one a
    live row of another reel still needs.
  - Never slim a reel that was never exported.
  - Never delete an object without setting `deleted_at` first; never write to storage from the
    worker except through `recordedStorage`, or from the studio except through a signed upload
    that `finish_upload` records.
  - Never leave a job's scratch directory behind, on success or failure.
  - Never claim a job below `WORKER_MIN_FREE_DISK_GB`.
  - Never read `E2E_MOCK_FREE_DISK_GB` unless `E2E_MOCK_STORAGE` is exactly `true`.
- `docs/conditional-docs.md`: one line: read `app_docs/storage.md` when changing `stored_files`,
  `worker_status`, what is kept or deleted, slimming or export expiry, writes to storage from the
  worker or the studio, scratch directories, or the disk guard.
- `app_docs/studio.md`: in Upload, note that `finish_upload` also records the source in
  `stored_files`; in Worker, one line pointing at `app_docs/storage.md` for scratch, the guard and
  housekeeping; list the new DB test and spec under Testing.
- `.adw/project.md` Tests section: add `stored-files.test.ts` to the DB layer list and
  `disk-guard.spec.ts` (spawns `once` with the free space forced low) to the studio specs; keep the
  nine headings unchanged.

### 17. Run the validation commands

Run every command in `Validation Commands` below, in order, and fix anything that fails without
weakening a rule, a type or a test.

## Testing Strategy

### Unit Tests

- `apps/worker/src/stored-files.test.ts`: recording on every put, idempotent re-put, no record on
  failure, the folder-fake "every object has one row" check, the worker write-path scan.
- `apps/worker/src/slimming.test.ts`: fixed-clock selection (8 days, 6 days, exactly 7 days, never
  exported, shared with a recent reel, shared with a never-exported reel, export expiry), the
  folder-fake `housekeep` run, mark-before-delete order, idempotency, housekeeping cadence.
- `apps/worker/src/scratch.test.ts`: removal on success and on failure, id guard.
- `apps/worker/src/disk-guard.test.ts`: no claim at 9 GB with the reason written, claim at 11 GB
  with the reason cleared, write deduplication, the E2E override inert outside the flag.
- `apps/studio/src/lib/storage-writes.test.ts`: the studio write-path scan.
- `apps/studio/src/lib/jobs.test.ts`: `waitingReason`.

### Test Coverage

- Unit (`apps/worker/src/disk-guard.test.ts`): catches a claim below the disk minimum and a missing
  waiting reason; today's `enoughDisk` has no test at all.
- Unit (`apps/worker/src/slimming.test.ts`): catches deleting a kept file, deleting inside seven
  days, slimming a never-exported reel, deleting an object another reel still needs, or deleting
  before recording; nothing deletes or selects today, so all fail without the module.
- Unit (`apps/worker/src/scratch.test.ts`): catches a scratch directory left behind on failure.
- Unit (`apps/worker/src/stored-files.test.ts`, `apps/studio/src/lib/storage-writes.test.ts`):
  catches any new storage write path that skips `stored_files`.
- DB (`apps/studio/db-tests/stored-files.test.ts`): catches `finish_upload` not recording the
  source, an RLS hole on either table, a duplicate live row per reel and key, and `worker_status`
  missing from the Realtime publication.
- E2E (`apps/studio/e2e/upload.spec.ts`, extended): catches an uploaded object with no or several
  rows, end to end through the browser upload.
- E2E (`apps/studio/e2e/disk-guard.spec.ts`): catches the studio not showing the worker's waiting
  reason live, and `once` claiming on a nearly full disk.

### Edge Cases

- Exactly seven days after the last export: not slimmed (strictly more than seven days).
- A reel exported several times: the newest export dates it, including exports already expired
  and marked deleted.
- An object shared by an old reel and a recent or never-exported reel: kept, with every row live.
- Re-put of the same key in one reel (a step rerun): one live row, size updated.
- A rebuild after slimming: a new live row beside the deleted one.
- An export object already removed by R2's lifecycle rule: delete succeeds on a missing object,
  row marked.
- An R2 delete that throws: row stays marked, error logged with the key, housekeeping continues
  and never blocks claiming.
- A lost lease: `runInScratch` still removes the directory.
- A non-UUID job id: refused before any path is built.
- `E2E_MOCK_FREE_DISK_GB` set without `E2E_MOCK_STORAGE=true`: ignored.
- No `worker_status` rows, or reasons from several workers: the newest non-null reason is shown;
  none when the job is `running`, `done` or `failed`.
- `WORKER_SCRATCH_DIR` missing on disk: created before `statfs`.

## Acceptance Criteria

- The migration applies with `supabase migration up --local`; both new tables have RLS and a
  policy; `authenticated` can read only its own `stored_files` rows and all `worker_status` rows,
  and write neither; `anon` reads neither.
- An upload through the studio leaves exactly one `stored_files` row for its source with the
  right `bytes`, `kind` (`source`) and `step` (`upload`).
- No module in `apps/worker/src` or `apps/studio/src` writes to storage outside the recorded paths
  (the scan tests pass, and fail when a raw `put` is added).
- The slimming selection deletes only `rebuildable` files of reels whose last export is more than
  seven days old, keeps any object another live row still needs, never slims a never-exported
  reel, and marks `deleted_at` before deleting. Expired exports are marked and deleted.
- Every job's `WORKER_SCRATCH_DIR/<job_id>` is gone after success, failure and a lost lease, and the
  bytes freed are logged.
- At 9 GB free with a 10 GB minimum no `claim_job` call is made and `waiting_reason` is set; at
  11 GB the job is claimed and the reason cleared, in both `worker` and `once`.
- The reel page shows the waiting reason under a queued job live, without a reload, and hides it
  once the worker has room.
- `app_docs/storage.md` exists with a Rules section, and `docs/conditional-docs.md`,
  `app_docs/studio.md` and `.adw/project.md` are updated.
- Every gate below passes; no em-dash in any changed file.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the one
  database command ADW may run; on failure report and stop, never reset).
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio`: ESLint (security and
  no-secrets rules) for both changed workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio`: `tsc` for the worker,
  `next typegen` plus `tsc` for the studio; this is also the worker's build check.
- `yarn knip`: no unused files, exports or dependencies anywhere.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio`: the new and existing unit
  tests (database-free).
- `yarn turbo run test:db --filter=./apps/studio`: RLS, `finish_upload`, `record_stored_file`,
  `worker_status` and Realtime against the local stack.
- `yarn turbo run build --filter=./apps/studio`: the studio still builds with the new page reads.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's full gate, unfiltered, so nothing outside the two workspaces regressed.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the landing suite then the studio
  suite, including the extended `upload.spec.ts` and the new `disk-guard.spec.ts`, against the
  `/prepare_app` server.
- `grep -rn $'\xe2\x80\x94' app_docs/storage.md specs/issue-37-adw-e5831ece-sdlc_planner-storage-records-slimming-disk-guard.md supabase/migrations/20261101120000_storage_records.sql apps/worker/src apps/studio/src apps/studio/e2e apps/studio/db-tests docs .adw ; test $? -eq 1`:
  no em-dash in any changed file.

## Notes

- No new dependency. Everything uses `node:fs/promises` (`statfs`, `rm`, `readdir`), the existing
  storage package and Supabase client.
- **Deferred to the slices that create the files** (they are open on `develop`; see "Scope against
  the current tree"):
  - The export row: #35's render job writes the MP4 through `recordedStorage.put(key, body, {
kind: "export", step: "export" })`, which also dates the last export for slimming. When it adds
    `exports.expires_at`, `selectSlimming`'s export expiry should read it instead of
    `created_at + EXPORT_LIFETIME_MS`.
  - Converted footage and full-size background removal (#29, #30) put with `kind: "rebuildable"`,
    previews with `kind: "kept"`, versions (#31) with `kind: "version"`, each tag coming from its
    step definition.
  - Rebuild after slimming (issue Verification 3) is #35's render job finding a missing rebuildable
    input and rerunning its step; the new put records a new live row (covered here at the DB layer).
  - HyperFrames `clean`, scoped to the job's project inside the scratch directory, is added with
    the render step (#35), after reading `hyperframes clean --help` and `hyperframes history --help`
    on the pinned version. HyperFrames is not a dependency yet, so nothing calls it here.
  - Issue Verification 1's "process and export the fixture reel" then extends `upload.spec.ts`'s
    "every object has exactly one row" assertion from the reel's source folder to all of its keys.
- Concurrency: housekeeping runs only inside the drainer, between jobs, and the MVP has one worker,
  so no job of this worker can start using a fingerprinted object between selection and deletion.
  A second concurrent worker would need the selection re-checked inside `markDeleted` in SQL; say
  so in `app_docs/storage.md`'s Notes.
- The periodic job check still reads only `id` (studio rule). Housekeeping reads identifiers and
  times (`id`, `reel_id`, `r2_key`, `kind`, `created_at`), never content, hourly, not on the
  job-check tick.
- Space per reel counts each shared object once per reel using it; a total across reels should sum
  distinct live `r2_key` values (for the slice 17 dashboard).
- A worker killed with SIGKILL can leave a scratch directory behind; the disk guard then holds new
  jobs until the owner frees space. Clearing stale job directories on start is a possible
  follow-up, not done here because `WORKER_SCRATCH_DIR` defaults to the OS temp folder.
- Owner steps after merge: apply the migration to the hosted project; decide whether never-exported
  reels should ever be slimmed (follow-up issue).
