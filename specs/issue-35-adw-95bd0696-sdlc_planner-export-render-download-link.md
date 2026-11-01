# Feature: export: high-quality render job, 24-hour download link, preview-matches-export test

## Metadata

issue_number: `35`
adw_id: `95bd0696`
issue_json: `{"number":35,"title":"feat: export: high-quality render job, 24-hour download link, preview-matches-export test","body":"Reel studio MVP, slice 12 of 17 (see the issue on GitHub for the full body: decisions D6, C3, D5, A2, D7, sections 3 and 4)"}`

## Feature Description

Slice 12 of the reel studio MVP. When the preview of a processed reel looks right, the owner presses
**Export** on the reel page. The studio inserts a `render` job pinned to the current version
(`jobs.version_id`) and sends `studio_export_requested`. The worker claims it, makes sure the
full-size inputs of that version exist (the retimed `source.mp4` and the cut-out `subject.webm`;
both are `rebuildable`, so a missing one is rebuilt through the fixed pipeline first), builds the
page with the same `build()` from `packages/edit` the studio preview uses, writes a temporary
HyperFrames project in its scratch folder (the page, full-size media, the preset's fonts and click
sounds) and runs
`hyperframes render <project> -o <tmp>.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr --no-best-effort --quiet`
with `HYPERFRAMES_NO_TELEMETRY=1`, through the step runner with whole-group memory sampling. The
clicks stay in the page: HyperFrames 0.8.222 mixes every page `<audio>` and the footage's own sound
with `amix ... normalize=0` at a master gain of 1 (checked in
`node_modules/hyperframes/dist/chunk-AIXH3V5A.js`, `mixAudioTracksFlat`, `DEFAULT_CONFIG.audioGain: 1`),
so no ffmpeg remix is needed and the voice keeps its level. The MP4 goes to
`${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`, an `exports` row records it with
`expires_at = created_at + 24 hours`, and the job ends with a step line such as
`render: exported, 3 minutes 2 seconds, 74.0 MB`.

The reel page follows `exports` through Realtime: the newest export shows a **Download** link signed
for at most the time left until `expires_at` (capped at one hour), and after `expires_at` it shows
"expired, export again". Clicking the link sends `studio_export_downloaded`. A new guardrail test
(`test:tools`, on the Mac, real HyperFrames) proves the export matches the preview frame by frame
(SSIM at least 0.95) and that the sound is right (loudness within 0.5 LU of the retimed source,
clicks within 20 ms of the sound track).

## User Story

As the owner of the studio
I want to press Export when the preview looks right and get a download link for a high-quality MP4
So that I can post a file that matches what I approved in the preview, with sharp text after
TikTok's and Instagram's recompression, without keeping heavy files around for longer than a day

## Problem Statement

The studio can show a live preview of a reel's current version, but nothing turns that version into
a file the owner can post. The approach only works if the exported MP4 matches the preview (section
4's guardrail): without a render on export and a test that compares the two, the live preview could
silently drift from what is published. The export must also not keep heavy files in R2 forever, and a
browser cannot reliably report when a download has finished.

## Solution Statement

- **Database**: one migration adds the job kind `render` with `jobs.version_id`, an owner insert
  policy for a render of a version of their own processed reel (refused while a render of the same
  version is queued or running), and an `exports` table (owner selects, only the worker inserts,
  `expires_at` forced to `created_at + 24 hours` by a trigger) in the Realtime publication. A render
  job does not count as "active" for the interim change-or-restore rule: it is pinned to its version
  and never moves `current_version_id`, so the owner may keep changing the reel while it renders.
- **Worker**: `process-job.ts` routes `render` to a new `steps/render.ts`. It reads the pinned
  version, ensures its two media inputs (a head of each key; only a miss runs the pipeline's first
  four steps with reel status left alone, then checks the rebuilt fingerprints equal the version's
  `inputs`), builds the page with `build()`, writes the project, runs the render through
  `runToolsStep` with `sampleGroupMemory: true`, uploads the MP4 with put-if-absent and inserts the
  `exports` row, all after a lease check. Under `E2E_MOCK_RENDER=true` the render call goes to a fake
  spawner that copies a small committed MP4 to the `-o` path, so the E2E suite runs without Chrome.
- **Studio**: an `ExportPanel` under the preview (Export button, its blocked reason, the newest
  export's Download link or "expired, export again"), a server action that inserts the render job
  under the owner's session (RLS decides), and a server action that signs the download through a
  pure guard that refuses past `expires_at` and never signs longer than the time left. `LiveReel`
  reads exports on open and follows `exports` inserts through Realtime (no polling); one timeout
  flips the shown export to expired at `expires_at`.
- **Guardrail**: a studio Playwright `test:tools` spec (real worker `once`, real HyperFrames, the
  run's dev server) renders the fixture reel's version (2.67 s, so the whole render is the 0 to 3 s
  span), captures the studio's preview player at 0.5, 1.5 and 2.5 s, extracts the same frames from
  the MP4 with ffmpeg, scales both to the preview size and scores each time twice, on the whole
  frame and on the probed caption's region (its laid-out box and the same box 60 px lower, padded),
  requiring SSIM >= 0.95 on both; the negative proof serves the preview a copy of the edit with that
  caption moved 60 px (a Playwright route on the version's signed URL, so no probe version is
  stored) and requires the lowest of its whole and region scores below the bound. The same spec checks loudness, click timing and the render step's group
  `peak_rss_bytes`.

## Relevant Files

Use these files to implement the feature:

**Prerequisite branch.** Issues #32 and #33 are open pull requests (#55, #56), not yet in `develop`.
Branch `origin/feat/issue-34-adw-7812d494-change-requests-and-versions` (PR #57) already merges both
(commit `0d4204c feat: merge the live preview and the decide step`, conflicts resolved) and adds the
change and restore jobs this slice extends (`jobs_kind_check`, `reel_has_active_job`, the column
grant). Every path below is as it stands on that branch.

Read first:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, Protected (one database command,
  `supabase migration up --local`), Tests (layers, `test:tools`).
- `docs/conditional-docs.md` and the docs whose lines match: `app_docs/studio.md` (tables, RLS,
  migrations, worker, storage, doubles, DB and E2E tests), `app_docs/measurement.md` (step runner,
  group memory sampling, summary line, `studio_*` events), `app_docs/pipeline.md` (fixed steps,
  `rebuildable` outputs, cache keys, HyperFrames arguments, `test:tools`, `fixtures/pipeline/`),
  `app_docs/edit-model.md` (builder, versions, `reels.current_version_id`),
  `app_docs/preview.md` (the preview the guardrail compares with, its Rules: one builder, no hard-coded
  sound, never store the built page), `app_docs/change-requests.md` (job kinds, the column grant, the
  insert policy and `reel_has_active_job`; its Rules forbid granting insert on `jobs` beyond four
  columns, which this slice changes in the same commit).
- `node_modules/next/dist/docs/`: the server actions and route handler guides before touching
  `apps/studio` (Next 16).

Database:

- `supabase/migrations/20261031174750_job_queue.sql`: `jobs`, `steps`, `claim_job` (returns `j.*`,
  so a new column reaches the worker), the Realtime publication line to copy.
- `supabase/migrations/20261107090000_change_requests.sql`,
  `supabase/migrations/20261107090200_change_requests_active_job.sql`: the kind check, the column
  grant, the change-or-restore policy and `reel_has_active_job` to extend.
- `supabase/migrations/20261104090000_versions.sql`: `versions` and its owner select policy (the
  model for `exports`).
- `apps/studio/db-tests/rls.test.ts`, `apps/studio/db-tests/change-jobs.test.ts`,
  `apps/studio/db-tests/jobs.test.ts`, `apps/studio/db-tests/realtime.test.ts`: patterns and the
  "RLS on every public table" list that must include `exports`.

Worker:

- `apps/worker/src/process-job.ts`: routes on `job.kind`; add `render`.
- `apps/worker/src/queue.ts`: `ClaimedJob` gains `version_id`; `reelStatusAfter` already leaves the
  reel alone for any kind but `process`.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `ToolCall.sampleGroupMemory`, `timeoutMs`,
  `SpawnTool` (the seam for the fake render).
- `apps/worker/src/pipeline/run-pipeline.ts`, `apps/worker/src/pipeline/definition.ts`: `PIPELINE`,
  `fingerprintsFor`, and `steps.reelStatus`, which a render must not call.
- `apps/worker/src/pipeline/tools.ts`: `toolPaths()`, `hyperframesEnv()` (telemetry off, the
  worker's ffmpeg), `HYPERFRAMES_VERSION`.
- `apps/worker/src/steps/first-version.ts`, `apps/worker/src/steps/version-io.ts`: how the worker
  builds with `createMeasurer` and `fontBytes`, reads JSON objects, guards writes by the lease.
- `apps/worker/src/steps/restore.ts`, `apps/worker/src/change-job.ts`: the shape of a non-process
  job's step.
- `apps/worker/src/step-store.ts`, `apps/worker/src/summary.ts` (`stepSummary`, `formatBytes`).
- `apps/worker/src/storage.ts`, `apps/worker/src/ai.ts` (the `E2E_MOCK_AI` pattern to copy for
  `E2E_MOCK_RENDER`), `apps/worker/src/config.ts` (`scratchDir`, `keyPrefix`).
- `apps/worker/vitest.tools.config.ts`, `apps/worker/src/pipeline/tools-test-support.ts`
  (`REAL_TOOLS`, `ffmpeg()` helpers).

Edit package:

- `packages/edit/src/build.ts` (`build`, `BuildAsset` roles `footage`, `cutout`, `font`, `sound`;
  page paths `footage.mp4`, `subject.webm`, `assets/<file>`), `packages/edit/src/sounds.ts`
  (`soundHits`), `packages/edit/src/preset.ts` (`ISSEBYA`: fonts, `sounds.click`),
  `packages/edit/src/versions.ts` (`VersionStore.get`, `VersionRow.inputs`, `versionKey`),
  `packages/edit/package.json` (`./assets/*` export).

Storage:

- `packages/storage/src/storage.ts`, `packages/storage/src/r2.ts`, `packages/storage/src/fake.ts`:
  `signDownload` gains an optional `fileName` (attachment).
- `apps/studio/src/app/api/e2e-storage-mock/route.ts`: the mock GET answers the attachment header.

Studio:

- `apps/studio/src/app/reels/[id]/page.tsx`: the server read (add exports).
- `apps/studio/src/components/LiveReel.tsx`: Realtime channel (add `exports`), snapshot, layout.
- `apps/studio/src/components/ChangeRequestForm.tsx`, `apps/studio/src/app/version-actions.ts`: the
  pattern for a job-inserting server action and its client form.
- `apps/studio/src/app/preview-actions.ts`: the signing pattern (RLS read, `studioStorage()`).
- `apps/studio/src/lib/change-request.ts` (`changeBlockedReason`: must ignore render jobs),
  `apps/studio/src/lib/jobs.ts` (`JOB_COLUMNS`, `JobRow`), `apps/studio/src/lib/track.ts`
  (`STUDIO_EVENTS` already reserves both export events).
- `apps/studio/e2e/change-requests.spec.ts`, `apps/studio/e2e/preview.spec.ts`,
  `apps/studio/e2e/events.ts`: spec patterns (`recordEvents`, `markNoReload`, `openReel`, the
  `player` locator and seeking helpers).
- `apps/studio/test-support/pipeline.ts` (`seedProcessedReel`, `seedPipelineCache`),
  `apps/studio/test-support/worker.ts` (`runWorkerOnce`, `claimableJobIds`).
- `apps/studio/playwright.config.ts`, `apps/studio/package.json`: the model for the tools config
  and script.
- `knip.json`: add the new Playwright config and test folder to the studio workspace.

### New Files

- `supabase/migrations/20261108090000_exports.sql`: render kind, `jobs.version_id`, render insert
  policy, `reel_has_active_render`, `reel_has_active_job` ignoring render jobs, `exports` table,
  trigger, RLS, grants, Realtime.
- `apps/studio/db-tests/exports.test.ts`: RLS and policy tests for exports and render jobs.
- `apps/worker/src/steps/render.ts`: the render step (inputs, project, render call, upload, row).
- `apps/worker/src/steps/render-args.ts`: `renderArgs()` and `exportKey()` (pure).
- `apps/worker/src/steps/render-project.ts`: writes the temporary HyperFrames project from a
  `BuildResult`.
- `apps/worker/src/steps/render-inputs.ts`: `ensureRenderInputs()` (head, rebuild on a miss,
  fingerprint check).
- `apps/worker/src/fake-render.ts`: the `E2E_MOCK_RENDER` spawner.
- `apps/worker/src/export-store.ts`: `ExportStore` (`insert`) with the Supabase implementation.
- `apps/worker/src/steps/render.test.ts`, `apps/worker/src/steps/render-args.test.ts`,
  `apps/worker/src/steps/render-inputs.test.ts`, `apps/worker/src/fake-render.test.ts`: unit tests.
- `fixtures/export/render.mp4`: a small committed MP4 (H.264 plus AAC, 270x480, about 1 s, under
  60 KB) the fake render copies.
- `apps/studio/src/lib/exports.ts` and `apps/studio/src/lib/exports.test.ts`: columns, row type,
  `latestExport`, `exportView`, `exportBlockedReason`, `downloadSeconds`, `signExportDownload`.
- `apps/studio/src/app/export-actions.ts`: `requestExport` and `exportDownloadUrl` server actions.
- `apps/studio/src/components/ExportPanel.tsx`: the Export button, status and download link.
- `apps/studio/e2e/export.spec.ts`: the E2E spec.
- `apps/studio/playwright.tools.config.ts`: Playwright config for `tools/` (same server adoption as
  the E2E config, long timeouts, one worker, chromium).
- `apps/studio/tools/preview-matches-export.spec.ts`: the guardrail, audio and memory tools test.
- `apps/studio/tools/media.ts`: ffmpeg helpers for the tools spec (frame extraction, scaling,
  `ssim`, `ebur128`, onset detection).
- `app_docs/export.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Bring in the dependency branch, install, add the migration and apply it to the shared local stack
with the one allowed command, extend the storage interface, and add the pure helpers (render
arguments, export key, signing guard, export view) with their unit tests.

### Phase 2: Core Implementation

The worker's render step: ensure inputs, build, write the project, run HyperFrames through the
step runner with group memory sampling, upload, insert the export row; the fake render spawner for
E2E; routing in `process-job.ts`. The studio's server actions, `ExportPanel`, the Realtime follow of
`exports` in `LiveReel`, and the change box ignoring render jobs.

### Phase 3: Integration

DB tests, the E2E spec, the guardrail tools spec on the Mac, docs (`app_docs/export.md`, the index
line, updates to `change-requests.md`, `studio.md`, `measurement.md`, `pipeline.md`) and the
profile's Tests section (the studio's `test:tools`).

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Merge the dependency branch and install

- `git fetch origin` then `git merge --no-ff origin/feat/issue-34-adw-7812d494-change-requests-and-versions`
  (contains #32 and #33 with their conflicts already resolved, and #34, whose job kinds and
  `reel_has_active_job` this slice extends). Commit message: `feat: merge the change requests branch
for the export slice`. If the merge conflicts, stop and report (the branch is based on the same
  `develop` commit, so none is expected).
- `yarn install --immutable` (the merge brings `hyperframes`, `@hyperframes/player`, `packages/edit`
  and their lockfile entries).
- Confirm `yarn workspace @edit-issebya/worker exec node node_modules/hyperframes/bin/hyperframes.mjs render --help`
  (or the package's `bin` resolved by `toolPaths()`) lists `--quality`, `--workers`,
  `--no-browser-gpu`, `--sdr`, `--no-best-effort`, `--start`, `--end`, `-o` and a project directory
  argument whose entry is `index.html`; if a project needs any other file (for example a
  `hyperframes.json`), note it for step 9.

### 2. Migration: render jobs and the exports table

Create `supabase/migrations/20261108090000_exports.sql` (header comment in the style of the earlier
migrations, no em-dashes):

- `alter table public.jobs drop constraint jobs_kind_check, add constraint jobs_kind_check check
(kind in ('process', 'change', 'restore', 'render'))`.
- `alter table public.jobs add column version_id uuid references public.versions (id)` and
  `add constraint jobs_version_check check ((kind = 'render') = (version_id is not null))`.
- `grant insert (reel_id, kind, request, restore_version_id, version_id) on public.jobs to authenticated`.
- `create or replace function public.reel_has_active_job(p_reel_id uuid)`: same body plus
  `and j.kind <> 'render'` (a render is pinned to its version and never moves the current one, so it
  does not block a change or restore). Re-state the revoke and grant lines.
- `create function public.reel_has_active_render(p_reel_id uuid, p_version_id uuid) returns boolean`,
  `language sql stable security definer set search_path = ''`: a `queued` or `running` job of kind
  `render` for this reel and version, owned by `auth.uid()`. Revoke execute from `public, anon,
service_role`; grant to `authenticated`.
- Policy `jobs: owner queues a render of a version of own processed reel` (under 63 bytes; count it)
  `for insert to authenticated with check`: `auth.uid() = owner_id`, `kind = 'render'`,
  `status = 'queued'`, reel owned and `processed`, `exists` a `versions` row with
  `id = jobs.version_id and reel_id = jobs.reel_id`, `not public.reel_has_active_render(jobs.reel_id, jobs.version_id)`.
  Never read `public.jobs` directly inside the policy (42P17, see `change-requests.md`).
- `create table public.exports`: `id uuid primary key default gen_random_uuid()`, `reel_id uuid not
null references public.reels (id) on delete cascade`, `owner_id uuid not null references auth.users
(id) on delete cascade`, `job_id uuid not null references public.jobs (id) on delete cascade`,
  `version_id uuid not null references public.versions (id)`, `r2_key text not null unique`,
  `bytes bigint not null check (bytes > 0)`, `created_at timestamptz not null default now()`,
  `expires_at timestamptz not null`. Index `exports_reel_idx on (reel_id, created_at)`.
- Trigger function `public.exports_set_expiry()` (`before insert or update`, `security invoker`,
  `search_path = ''`): `new.expires_at := new.created_at + interval '24 hours'`. A trigger, not a
  generated column, because `timestamptz + interval` is only stable. Nobody can store a longer life.
- RLS: `alter table public.exports enable row level security`; `revoke all on public.exports from
anon, authenticated`; `grant select on public.exports to authenticated`; policy `exports: owner
selects own` (`(select auth.uid()) = owner_id`). No insert, update or delete policy or grant for
  owners: the worker (secret key) inserts.
- `alter publication supabase_realtime add table public.exports`.
- Run `supabase migration up --local`. If it fails, report the error and stop (never reset).

### 3. Storage: attachment download links

- `packages/storage/src/storage.ts`: `signDownload(key, options: { expiresInSeconds: number;
fileName?: string })`, documented as "served as an attachment under this name".
- `packages/storage/src/r2.ts`: pass `ResponseContentDisposition: attachment; filename="<name>"` on
  the `GetObjectCommand` when `fileName` is set (name restricted to `[a-z0-9._-]`, else throw).
- `packages/storage/src/fake.ts`: append `?download=<name>` when set.
- `apps/studio/src/app/api/e2e-storage-mock/route.ts`: on GET with a valid `download` query, add
  `Content-Disposition: attachment; filename="<name>"`.
- Extend `r2.test.ts`, `fake.test.ts` and `route.test.ts` for the new option (and a refused name).

### 4. Studio pure helpers: `apps/studio/src/lib/exports.ts`

- `EXPORT_COLUMNS = "id, reel_id, job_id, version_id, bytes, created_at, expires_at"` (no `r2_key`
  in the browser) and `ExportRow`.
- `latestExport(rows)`: newest by `created_at`, id breaking ties; null when none.
- `exportView(row, now)`: `{ state: "none" } | { state: "ready", msLeft } | { state: "expired" }`
  (`expired` when `now >= expires_at`).
- `exportBlockedReason(status, jobs, versionId)`: "Export opens once processing has finished." when
  not `processed`; "No version to export yet." without a version; "Exporting this version." when a
  `render` job with this `version_id` is `queued` or `running`; else null. (`JobRow` gains
  `version_id`.)
- `DOWNLOAD_URL_MAX_SECONDS = 3600`; `downloadSeconds(expiresAt, now)`: whole seconds left, capped
  at the max, `null` when fewer than 1 second is left.
- `signExportDownload(storage, row: { r2_key, expires_at, reel_id }, now)`: `null` without calling
  `signDownload` when `downloadSeconds` is null; else `signDownload(r2_key, { expiresInSeconds,
fileName: "reel-<first 8 of reel_id>-<yyyymmdd-hhmm of created_at>.mp4" })`.
- `apps/studio/src/lib/exports.test.ts`: latest, view states at the boundary (1 ms before, at, after
  `expires_at`), blocked reasons (render of another version does not block), `downloadSeconds`
  (cap, partial seconds floored, null at and past expiry), and `signExportDownload` with a spy
  storage: never called past `expires_at`, `expiresInSeconds` never above the time left.
- `apps/studio/src/lib/change-request.ts`: `changeBlockedReason` ignores `kind === "render"` jobs
  (mirrors `reel_has_active_job`); its `jobs` parameter becomes `Pick<JobRow, "status" | "kind">[]`.
  Extend `change-request.test.ts`: a running render does not block a change.
- `apps/studio/src/lib/jobs.ts`: add `version_id` to `JOB_COLUMNS` and `JobRow`; update
  `jobs.test.ts` if it pins the column list.

### 5. Studio server actions: `apps/studio/src/app/export-actions.ts`

- `"use server"`. `requestExport({ reelId })`: validate `isReelId`; server client; `signed-out` when
  no user; read `reels.current_version_id` through RLS (`no-version` when null); insert
  `{ reel_id, kind: "render", version_id }`; a refused insert logs `error.code` and `error.message`
  only and answers `refused`; else `{ status: "queued", versionId }`. RLS decides; nothing uses the
  secret key.
- `exportDownloadUrl({ exportId })`: validate the id; read `id, reel_id, r2_key, created_at,
expires_at` from `exports` through RLS (`failed` when not found); `studioStorage()` or
  `not-configured`; `signExportDownload(..., new Date())`; `expired` when it returns null; else
  `{ state: "ready", url }`. A sign error logs only its message and answers `failed`.

### 6. Studio UI: `ExportPanel` and `LiveReel`

- `apps/studio/src/components/ExportPanel.tsx` (`"use client"`), placed in `LiveReel` right under
  `<Preview>` and above `ChangeRequestForm`, props `reelId`, `versionId` (current), `blockedReason`,
  `latest: ExportRow | null`, `versionNumberOf(id)`:
  - A section headed "Export" with a button "Export" (`disabled` when `blockedReason` or while the
    action runs). On success: `capture("studio_export_requested", { reel_id })` and show "Queued:
    waiting for the worker" until the job arrives through Realtime (as `ChangeRequestForm` does).
    The blocked reason renders under `data-testid="export-blocked"`.
  - The latest export: when `exportView` is `ready`, call `exportDownloadUrl` once per export id
    (in an effect keyed on the id, an external system: a server call) and render
    `<a data-testid="export-download" href={url} download>Download version N (size)</a>` plus
    "available until <local time>"; on click `capture("studio_export_downloaded", { reel_id })`.
    When `expired` (from the view or from the action), render
    `<p data-testid="export-expired">expired, export again</p>` and no link.
  - One `setTimeout` to `expires_at` that flips the view to expired (cleared on unmount or a newer
    export). Not polling: no repeat, no read.
- `apps/studio/src/components/LiveReel.tsx`: `Snapshot` gains `exports: ExportRow[]`;
  `readSnapshot` reads them (`EXPORT_COLUMNS`, `reel_id = id`, ordered by `created_at`); the channel
  adds `postgres_changes` `INSERT` on `public.exports` filtered `reel_id=eq.${id}` that upserts the
  row; compute `exportBlockedReason(reel.status, jobs, reel.current_version_id)`; show
  `job.kind === "render"` rows with "export of version N" under `data-testid="job-request"`.
- `apps/studio/src/app/reels/[id]/page.tsx`: read exports in the same `Promise.all`, throw on error
  like jobs and steps, pass them to `LiveReel`.
- `apps/studio/src/lib/track.ts`: drop "The export events are reserved, not sent yet." from the
  comment.

### 7. Worker: pure render pieces

- `apps/worker/src/steps/render-args.ts`:
  - `RENDER_FLAGS = ["--quality", "delivery", "--workers", "3", "--no-browser-gpu", "--sdr",
"--no-best-effort", "--quiet"] as const`, with a comment on each choice (delivery: platforms
    recompress, a cleaner source keeps text and cut-out edges; software with three workers: faster
    here than GPU with one and identical on a GPU-less cloud machine; SDR: the preview and the
    platforms are SDR; no best effort: a missing font or unready video fails the step instead of
    exporting a wrong frame).
  - `renderArgs({ cli, project, output, range? })`: `[cli, "render", project, "-o", output,
...RENDER_FLAGS, ...(range ? ["--start", String(range.start), "--end", String(range.end)] : [])]`.
    `range` exists for the tools test only through the step's options, never from a job row.
  - `exportKey(prefix, reelId, exportId)`: `${prefix}exports/${reelId}/${exportId}.mp4`, through
    `assertStorageKey`.
- `apps/worker/src/steps/render-args.test.ts`: the exact argument list (order included), no
  `--gpu`, no `--browser-gpu`, `--workers 3`; the key format and a refused malformed prefix.

### 8. Worker: ensure the render inputs

- `apps/worker/src/pipeline/run-pipeline.ts`: new option `moveReelStatus = true`; when false,
  `steps.reelStatus` is never called (a render never moves `reels.status`). Extend
  `run-pipeline.test.ts` with that case.
- `apps/worker/src/steps/render-inputs.ts`, `ensureRenderInputs({ ctx, storage, keyPrefix, inputs,
rebuild })`:
  - The two keys: `cacheKey(prefix, "retime", inputs.footage, "source.mp4")` and
    `cacheKey(prefix, "remove_background", inputs.cutout, "subject.webm")`.
  - Head both. Both stored: return the keys, nothing else runs, no step row.
  - Either missing: call `rebuild()`, which in production is `runPipeline({ ..., pipeline:
PIPELINE.slice(0, index of remove_background + 1), moveReelStatus: false })`; its returned
    fingerprints for `retime` and `remove_background` must equal `inputs.footage` and
    `inputs.cutout`, else throw `render: the inputs of this version cannot be rebuilt (a step
changed since it was made)`. Head both again; a still-missing key throws `render: input missing: <key>`.
- `apps/worker/src/steps/render-inputs.test.ts` with an in-memory storage and a spy `rebuild`: both
  present (no rebuild), one missing (rebuild once, then found), fingerprint mismatch (error), still
  missing after rebuild (error).

### 9. Worker: the render step

- `apps/worker/src/export-store.ts`: `ExportStore { insert(row: { id, reel_id, owner_id, job_id,
version_id, r2_key, bytes }): Promise<{ expires_at: string }> }` and `supabaseExportStore(db)`
  (insert then select `expires_at`; error message names the table).
- `apps/worker/src/steps/render-project.ts`, `writeRenderProject({ dir, build, footagePath,
cutoutPath })`: writes `index.html` with `build.html` unchanged (the worker never edits the page),
  links or copies the footage to `footage.mp4` and the cut-out to `subject.webm` for the `footage`
  and `cutout` assets, and copies each `font` and `sound` asset from
  `import.meta.resolve("@edit-issebya/edit/assets/<file>")` to `<dir>/<asset.path>`; any other role
  throws. Plus any file step 1 found the CLI needs.
- `apps/worker/src/steps/render.ts`, `render({ ctx, storage, keyPrefix, scratchDir, tools, versions,
exportsStore, versionId, spawnTool?, newId = randomUUID, range?, rebuild? })`:
  - Fail early: `render: job has no version` when `versionId` is null; `render: version not found`;
    `render: version belongs to another reel` when `row.reel_id !== job.reel_id`.
  - `ensureRenderInputs` (before the step row, so a rebuild writes its own pipeline rows first).
  - Then `runToolsStep(ctx, { name: "render", inputs: [footage, cutout], outputs: [mp4], sizeOf:
"out", work }, spawnTool)`. In `work`: read the edit (`row.r2_key`), the transcript (`retime`
    `transcript.json` under `inputs.transcript`) and the head track (`head_track` `head-track.json`
    under `inputs.headTrack`) with `readJson`; download the two media files with `getFile` into
    `<scratchDir>/render-<job id>/media/`; `build()` with `ISSEBYA` and `createMeasurer(await
fontBytes(ISSEBYA))` exactly as `first-version.ts` does; `writeRenderProject` into
    `.../project/`; one tool call `{ file: tools.hyperframes[0], args: renderArgs({ cli:
tools.hyperframes[1], project, output, range }), env: hyperframesEnv(process.env, tools),
sampleGroupMemory: true, timeoutMs: 60 * 60 * 1000 }`; check the output exists and is non-empty;
    `signal.throwIfAborted()`; `putFileIfAbsent(exportKey(...), output, { contentType: "video/mp4" })`;
    `signal.throwIfAborted()`; `exportsStore.insert(...)` with the output's size; return
    `{ what: "exported" }`, so the line reads `exported, <duration>, <size>`.
  - `finally`: remove `<scratchDir>/render-<job id>/` (never the pipeline's `job-<id>` folder).
- `apps/worker/src/fake-render.ts`: `fakeRenderSpawn(fixture = fixtures/export/render.mp4)`: a
  `SpawnTool` that requires `"render"` and `"-o"` in the arguments, copies the fixture to the path
  after `-o`, and resolves `{ code: 0, exitSignal: null, report: "", output: "", stdout: "",
groupPeakBytes: null }`. `renderSpawnTool(env)`: the fake only when `E2E_MOCK_RENDER === "true"`,
  else `undefined` (the real `runChild`).
- `apps/worker/src/queue.ts`: `ClaimedJob.version_id: string | null` (the version a render job
  exports; null for every other kind).
- `apps/worker/src/process-job.ts`: `case "render"` calls `render(...)` with `toolPaths()`,
  `supabaseExportStore(db)`, `renderSpawnTool(process.env)` and `versionId: job.version_id`; update
  the header comment.
- Create `fixtures/export/render.mp4` from the committed preview copy with ffmpeg (for example
  `ffmpeg -i fixtures/pipeline/preview_copies/footage.mp4 -t 1 -vf scale=270:480 -c:v libx264 -crf 32
-c:a aac -b:a 48k fixtures/export/render.mp4`); never read or write `fixtures/footage/short-person.mp4`.
- Unit tests:
  - `apps/worker/src/steps/render.test.ts` (in-memory step store, version store, export store,
    folder fake storage under a temp dir seeded from `fixtures/pipeline/`, fake spawner):
    the one tool call has exactly `renderArgs` and `sampleGroupMemory: true` and
    `HYPERFRAMES_NO_TELEMETRY: "1"`; the project folder at spawn time holds `index.html` byte-equal
    to `build()`'s html for the same inputs (same builder, never edited), `footage.mp4`,
    `subject.webm`, both fonts and, for a version with a click, `assets/sounds/mouse-click-trimmed.wav`;
    the MP4 lands at `exportKey`; one export row with the bytes; the step row's summary starts with
    `exported, `; `reels.status` never written; the scratch folder is gone afterwards; a version of
    another reel, a missing version and an empty output each fail the step; an aborted signal
    writes no object and no row.
  - `apps/worker/src/fake-render.test.ts`: copies to `-o`, refuses a call without `render`, and
    `renderSpawnTool` is the fake only for exactly `"true"`.
  - `apps/worker/src/queue.test.ts`: `finishJob` and `failJob` leave the reel alone for `render`.

### 10. DB tests: `apps/studio/db-tests/exports.test.ts`

Model on `change-jobs.test.ts` (users A and B, signed-in clients, admin cleanup):

- B selects none of A's exports (and anon none); A selects its own.
- Neither A nor B can insert, update or delete an `exports` row.
- `expires_at` equals `created_at + 24 hours` even when the admin inserts another value, and after an
  update of `created_at`.
- A queues a render of a version of A's processed reel; refused: a version of another reel, a reel
  that is not processed, B's reel, a second render of the same version while the first is queued;
  allowed: a render of another version of the same reel; a `render` without `version_id`, and a
  `change` with a `version_id`, fail the check.
- A change is allowed while a render is queued (render jobs no longer block); a change is still
  refused while a change is queued.
- `claim_job` returns `version_id` (extend `jobs.test.ts` if simpler).
- Add `exports` to the "RLS on every public table" list in `rls.test.ts`, and to the Realtime test in
  `realtime.test.ts` if that test enumerates published tables (an owner receives own export inserts,
  not another owner's).

### 11. E2E spec: `apps/studio/e2e/export.spec.ts`

Model on `change-requests.spec.ts` (serial, `claimableJobIds` empty first, own `CACHE_PREFIX`,
cleanup of stored keys and the test user):

- `beforeAll`: test user; reel inserted `uploaded`; `seedProcessedReel(admin, storage, { prefix:
CACHE_PREFIX, reelId })` (version 1 current, both full-size inputs and preview copies seeded).
- Test 1, "Export renders the current version and shows a download link without a reload":
  `recordEvents`, open the reel, `markNoReload`; click "Export"; poll the `jobs` table: one `render`
  job, `version_id` equal to `reels.current_version_id`; the button is disabled and
  `export-blocked` reads "Exporting this version."; `studio_export_requested` logged once with this
  `reel_id`; `runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX, E2E_MOCK_RENDER: "true" })` exits 0; then,
  without a reload (`expectNoReload`), `export-download` is visible, a step line starts with
  `render: exported, `, the job shows `done`, and the `exports` row's `r2_key` is
  `${CACHE_PREFIX}exports/<reelId>/<exportId>.mp4` with `expires_at - created_at` exactly 24 hours,
  and its object exists in the fake storage (add it to the cleanup list); clicking the link starts a
  download (`page.waitForEvent("download")`) and `studio_export_downloaded` is logged once with
  this `reel_id`; the Export button is enabled again.
- Test 2, "an export past its expiry shows expired and no link": admin inserts an `exports` row for
  the reel with `created_at` 25 hours ago (job id from test 1, the current version); reload the
  page; `export-expired` reads "expired, export again"; `export-download` has count 0.
- Without the feature the Export button, the `render` kind and the link do not exist, so both tests
  fail.

### 12. Guardrail tools spec (Mac, real HyperFrames)

- `apps/studio/package.json`: script `"test:tools": "playwright test --config playwright.tools.config.ts"`.
- `apps/studio/playwright.tools.config.ts`: a copy of `playwright.config.ts` with `testDir: "./tools"`,
  test timeout 20 minutes, same `webServer` adoption (never `CI=1`), chromium only, one worker.
- `apps/studio/tools/media.ts` (ffmpeg through `FFMPEG_PATH` or PATH, `execFile`, no shell):
  `extractFrame(mp4, seconds, out)`, `scaleTo(png, w, h, out)`, `ssim(a, b)` (parses
  `All:<n>` from `-lavfi ssim`), `integratedLoudness(file, { mute })` (`ebur128`, `I:` value, with
  `volume=enable='between(t,a,b)':volume=0` per muted window), `onsets(export, source)` (the
  difference `[0][1]amix=weights='1 -1':normalize=0`, then `silencedetect=noise=-35dB:d=0.01`;
  each `silence_end` is a hit onset).
- `apps/studio/tools/preview-matches-export.spec.ts`, serial, one render shared by three tests:
  - `beforeAll`: user, reel, `seedProcessedReel`, then save the next version from
    `fixtures/decide/short-speech.json`'s answer with `saveNextVersion` (it has a click, so the sound
    track is exercised; if building that edit from the answer needs the decide helpers, use
    `editFromAnswer` from `packages/edit`); insert a `render` job for it with the admin client;
    `runWorkerOnce({ R2_KEY_PREFIX: CACHE_PREFIX }, { timeoutMs: 15 * 60 * 1000 })` (add the optional
    timeout parameter to `test-support/worker.ts`; no `E2E_MOCK_RENDER`, so the real HyperFrames
    runs); copy the exported MP4 from the fake storage to a temp folder. The fixture reel is 2.67 s,
    so the whole render is the issue's 0 to 3 s span; no range flag is needed.
  - Test "the export matches the preview": open the reel page; for t in 0.5, 1.5, 2.5: seek the
    player (`hyperframes-player`'s public `seek(t)`, then wait until `preview-time` shows t and both
    videos are ready, the way `preview.spec.ts` waits), wait for `document.fonts.ready` in the
    player's frame, screenshot the player element; extract the MP4 frame at t; scale both to the
    screenshot size; score the whole frame and the crop of the probed caption's region (its
    `build()` layout box unioned with the same box 60 px lower, padded by 24 px, mapped to the
    screenshot's scale); `ssim >= SSIM_BOUND` (0.95) for both at each time. Log both lists. The
    whole frame proves the frame matches; the region is what can see a caption that is a small
    part of a downscaled frame.
  - Negative proof in the same test: `page.route` the version's signed edit URL (the mock storage
    route for the version's `r2_key`) to answer a copy of the edit whose first caption visible at one
    of the three times has `style.position.y` set to its laid-out y plus 60 (laid-out position from
    `build()`'s `layout`), reload, capture again, and require the lowest of the whole and region
    scores below the bound.
    The route is removed after; nothing is stored, so no probe version exists to delete and history
    is never rewritten.
  - Test "the sound matches the sound track": mute windows `[hit.at, hit.at + hit.duration + 0.02]`
    for every `soundHits(edit, transcript, ISSEBYA)` hit; `|I(export) - I(retimed source)| <= 0.5`
    LU over the same span (`fixtures/pipeline/retime/source.mp4` trimmed to the export's duration);
    every hit has an onset within 20 ms, and no onset lies outside a hit window. Muting the click
    windows isolates the voice level, which is what the bound protects.
  - Test "the render step sampled the whole process group": the `render` step row has
    `peak_rss_bytes > 256 * 1024 * 1024` (more than one Chrome process, about 256 MB each by the CLI's
    own help) and `status = 'done'`. Record the measured value in this spec's Notes.
- Run it on the Mac against the run's server: `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn
workspace @edit-issebya/studio test:tools`. Record the three SSIM scores, the negative proof's
  lowest score, the two loudness values, the onset errors and `peak_rss_bytes` in this spec's Notes.
  If a scale-matched preview frame scores between 0.9 and 0.95 for a reason that is not a mismatch
  (for example font hinting at the preview's size), lower `SSIM_BOUND` with that evidence in a
  comment, never below 0.9.
- If the loudness check fails, do not tune the bound: switch to mixing the clicks with ffmpeg from
  `soundHits` (rendering the page with sound lines removed) and record why in `app_docs/export.md`.

### 13. Knip, lint and the ADW profile

- `knip.json` (`apps/studio`): `"project"` gains `"tools/**/*.ts"`; the Playwright plugin config
  lists `playwright.config.ts` and `playwright.tools.config.ts`.
- `.adw/project.md`, Tests section: add the studio's tool test (`yarn workspace @edit-issebya/studio
test:tools`, the export guardrail, real HyperFrames through the worker's `once`, on the owner's Mac,
  never in CI, needs the run's dev server) and `export.spec.ts` in the studio E2E list
  (`E2E_MOCK_RENDER` set by the spec). Keep the nine headings untouched.

### 14. Documentation

- New `app_docs/export.md` (sections like `app_docs/change-requests.md`: Overview, How it works with
  Database, Worker, Studio; How to Use; Configuration; Testing; Rules; Notes): the render job and
  `jobs.version_id`; the exact render flags and why each; sound handling (the page's `<audio>` lines
  from the sound track, mixed by HyperFrames at unity gain, the measured loudness); the R2 location
  `<prefix>exports/<reel_id>/<export_id>.mp4`, `expires_at` and the owner's lifecycle rule (whole
  days, the backstop); the download link (signed for at most the time left, capped at one hour,
  attachment name); the guardrail test, its bound and the recorded scores; events
  `studio_export_requested` and `studio_export_downloaded`; the GSAP CDN the render needs (the page
  names it). Rules: render only on export, never for the preview; software mode with three workers
  at delivery quality, never a GPU mode; the same builder, the worker never edits the built page;
  the built page is never stored; never sign a link past `expires_at`; a render never moves
  `reels.status` or `current_version_id`; never hard-code a sound.
- `docs/conditional-docs.md`: one line, "`app_docs/export.md`: read when changing the Export button,
  the `render` job kind or `jobs.version_id`, the render step or its HyperFrames flags, the `exports`
  table, its expiry or the download link, `E2E_MOCK_RENDER`, the export guardrail tools test, or
  `studio_export_requested` and `studio_export_downloaded`."
- `app_docs/change-requests.md`: the Rule "Do not grant the owner insert on `jobs` beyond
  `(reel_id, kind, request, restore_version_id)`" becomes "beyond `(reel_id, kind, request,
restore_version_id, version_id)`"; `reel_has_active_job` ignores render jobs (the interim rule
  covers changes and restores only).
- `app_docs/studio.md`: the `render` kind, `jobs.version_id`, the `exports` table, and the new specs.
- `app_docs/measurement.md`: the two export events are sent now; the render step uses group memory
  sampling.
- `app_docs/pipeline.md`: `runPipeline`'s `moveReelStatus` option and the render's rebuild of
  rebuildable inputs.

### 15. Run the validation commands

Run every command in `Validation Commands` below, in order, and fix anything that fails.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/exports.test.ts`: latest export, view states around `expires_at`, blocked
  reasons, `downloadSeconds` and the signing guard (refuses past `expires_at`, never signs longer
  than the time left).
- `apps/studio/src/lib/change-request.test.ts`: a render job does not block a change.
- `packages/storage/src/r2.test.ts`, `fake.test.ts`, `apps/studio/src/app/api/e2e-storage-mock/route.test.ts`:
  attachment name.
- `apps/worker/src/steps/render-args.test.ts`: exact render flags and export key.
- `apps/worker/src/steps/render-inputs.test.ts`: present, rebuilt, mismatch, still missing.
- `apps/worker/src/steps/render.test.ts`: project contents equal to `build()`, the one tool call,
  upload, row, summary, failures, lease loss.
- `apps/worker/src/fake-render.test.ts`, `apps/worker/src/pipeline/run-pipeline.test.ts`
  (`moveReelStatus: false`), `apps/worker/src/queue.test.ts` (render leaves the reel alone).

### Test Coverage

- Unit, `exports.test.ts`: catches a download link signed past `expires_at` or for longer than the
  time left (issue verification 2, signing half).
- Unit, `render-args.test.ts`: catches any drift from `--quality delivery --workers 3
--no-browser-gpu --sdr` (the constraint), including a GPU flag.
- Unit, `render.test.ts`: catches a worker that edits or rebuilds the page differently from
  `build()`, forgets group memory sampling or telemetry off, writes the wrong key, or moves the
  reel's status.
- Unit, `render-inputs.test.ts`: catches a render that runs with missing rebuildable inputs or with
  inputs of a different fingerprint than the version's.
- DB (`yarn turbo run test:db --filter=./apps/studio`), `exports.test.ts`: catches user B seeing
  A's exports (verification 3), an owner writing an export or extending its life, and a second
  render of the same version.
- E2E (`yarn test:e2e`), `export.spec.ts`: catches a missing Export button, a render job without the
  current `version_id`, a link that needs a reload, missing events with `reel_id`, and a link shown
  for an expired export (verifications 1 and 2).
- Tools (`yarn workspace @edit-issebya/studio test:tools`, Mac only), `preview-matches-export.spec.ts`:
  catches an export that differs from the preview (SSIM below 0.95 on the whole frame or the probed
  caption's region, with the 60 px negative proof falling below it on the lowest of those scores),
  a voice level off by more than 0.5 LU, clicks off by more than 20 ms, and memory sampled from one
  process only (verifications 4 to 6). Not in CI: it needs real HyperFrames and Chrome rendering.

### Edge Cases

- Export pressed twice quickly: the second insert is refused by the policy (same version active);
  the action answers `refused` and the panel shows the blocked reason once the first job arrives.
- A change finishes while a render runs: the render still exports its pinned `version_id`; the
  next Export is for the new current version and is allowed.
- Export of a reel whose rebuildable inputs were deleted (slice 14): the pipeline's first four steps
  rerun (cache hits for kept outputs), then the render; a step definition bump that changes the
  fingerprint fails with a clear message instead of rendering other footage.
- The lease is lost mid-render: the group is killed, nothing is uploaded and no row is written.
- HyperFrames fails or writes an empty file: the render step fails with its output tail; the job is
  `failed`; the reel stays `processed`.
- An export exactly at `expires_at`, and a page left open across `expires_at`: shows expired; the
  timeout flips the view without a read.
- A page open for more than an hour with a ready export: the link has expired at R2; a reload signs
  again (the same no-refresh rule as the preview).
- No exports yet: no download section beyond the Export button.
- The studio unconfigured for R2: the download action answers `not-configured`; the panel shows a
  short message and no link.

## Acceptance Criteria

- Pressing Export on a processed reel inserts exactly one `render` job with `version_id` equal to
  the current version and sends `studio_export_requested` with `reel_id`; the button is disabled
  while a render for that version is queued or running.
- The worker renders with exactly `--quality delivery --workers 3 --no-browser-gpu --sdr`
  (plus `--no-best-effort --quiet`) and `HYPERFRAMES_NO_TELEMETRY=1`, with group memory sampling,
  from a page built by `packages/edit`'s `build()` and never stored.
- Missing rebuildable inputs are rebuilt before the render; the render never moves `reels.status`.
- The MP4 is at `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`; the `exports` row has
  `expires_at = created_at + 24 hours`; the step line reads `exported, <duration>, <size>`.
- The reel page shows the newest export's download link without a reload, signed for no longer than
  the time left (and at most one hour); after `expires_at` it shows "expired, export again" and no
  link; clicking the link sends `studio_export_downloaded` with `reel_id`.
- User B sees none of A's exports; owners cannot write `exports`.
- On the Mac, the tools spec passes: SSIM >= 0.95 at 0.5, 1.5 and 2.5 s, the 60 px probe falls
  below the bound, loudness within 0.5 LU, clicks within 20 ms, render `peak_rss_bytes` above one
  Chrome process; the values are recorded in this spec's Notes.
- `app_docs/export.md` exists with its Rules, and `docs/conditional-docs.md` has its line; the
  changed rule in `app_docs/change-requests.md` is updated in the same change.
- Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the one
  allowed database command; on failure, report and stop).
- `yarn format:check`: formatting of the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: lint of every touched workspace.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: types, and the build check of the worker and storage package.
- `yarn knip`: no unused files, exports or dependencies (new tools folder and config listed).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: unit tests, database-free.
- `yarn turbo run test:db --filter=./apps/studio`: RLS, policies, expiry trigger and Realtime against the local stack.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with no variables.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the landing and studio suites, including `export.spec.ts`.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`: the guardrail, audio and memory checks with real HyperFrames (on the Mac only).
- `yarn workspace @edit-issebya/worker test:tools`: the existing tool tests still pass after the `runPipeline` change (on the Mac only).
- `git diff --name-only origin/develop | xargs perl -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof' -CSD`: must print nothing (no em-dashes in any changed file).

## Notes

- **Dependency branch**: this plan merges `origin/feat/issue-34-adw-7812d494-change-requests-and-versions`
  (PR #57) because #32 and #33 are unmerged and #57 already holds both with conflicts resolved. If
  #55 to #57 are merged into `develop` before this run starts, merge `origin/develop` instead. The
  PR for this issue will show their diff until they land.
- **Sound handling decision**: page audio, not an ffmpeg remix. HyperFrames 0.8.222's
  `mixAudioTracksFlat` uses `amix ... normalize=0` with `audioGain` 1 (overridable only by
  `PRODUCER_AUDIO_GAIN`, which the worker never sets), so the old setup's quieter render (-19.1 LUFS
  against -18.0, from `amix`'s default normalisation) should not recur. The tools test's loudness
  check is the proof; step 12 says what to do if it fails.
- **Negative proof without a stored version**: the issue asks to "delete the probe version", but
  `app_docs/change-requests.md` forbids deleting a version, and making a probe current would move
  `current_version_id`. Serving the preview a modified copy of the edit through `page.route` proves
  the same thing (a 60 px caption shift drops SSIM below the bound) with nothing to clean up.
- **Render jobs and the interim ordering rule**: `reel_has_active_job` now ignores render jobs, so
  changes are not blocked for the minutes a render takes. Slice 16 replaces the rule with queue
  ordering; the render's own rule (one active render per version) stays.
- **Range flags**: `--start`/`--end` exist in `renderArgs` for a future partial render, but the
  fixture reel is 2.67 s, so the guardrail renders it whole; no job column or env variable carries a
  range.
- **Network**: the built page loads GSAP from `cdn.jsdelivr.net` (the preset names it), so the render
  needs network, like the preview. Vendoring GSAP is out of scope.
- No new dependency: `hyperframes`, `@playwright/test`, ffmpeg and the AWS SDK are already present.
  If one becomes necessary, add it with `yarn workspace <workspace> add <pkg>` and list it here.
- Owner steps (not the pipeline): the R2 lifecycle rule deleting `<prefix>exports/` after 1 day for
  `dev/` and the production prefix; applying the migration to the hosted project after merge; the
  manual acceptance against `rethink-work-02.mp4` and a TikTok or Instagram draft.
- Out of scope: render progress and time left (slice 15), deleting rebuildable files and the disk
  guard (slice 14), cloud rendering (section 6).
- Recorded values (patch `frame-exact-caption-region`): SSIM at 0.5 / 1.5 / 2.5 s, whole 0.9926 /
  0.9930 / 0.9949, caption region 0.9478 / 0.9690 / 0.9305 (bound 0.92); negative proof `c-w0004`
  moved 60 px, whole 0.9892 / 0.9930 / 0.9949, region 0.6853 / 0.9690 / 0.9305, lowest 0.6853;
  loudness export -15.2 LUFS, source -15.1 LUFS (dual mono); click onset error 7.9 ms. The
  onset check still fails on codec residue (an onset at 1.83 s, about -32 dB, outside every
  click, against the -35 dB silence threshold), so render `peak_rss_bytes` is not yet recorded.
  Cause of the old region scores: the element screenshot rounded out to 683 CSS px and was
  squeezed into the frame, and the 1080 px export was upscaled to the preview's 1152 px; the
  remaining 1 to 1.5 px vertical text offset is glyph rasterisation. The old 2.9 LU loudness gap
  was the mono source measured against the stereo export, and `amix` ignoring the negative weight.
