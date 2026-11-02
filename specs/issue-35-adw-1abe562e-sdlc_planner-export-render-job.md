# Feature: Export: high-quality render job, 24-hour download link, preview-matches-export test

## Metadata

issue_number: `35`
adw_id: `1abe562e`
issue_json: `{"number":35,"title":"feat: export: high-quality render job, 24-hour download link, preview-matches-export test"}`

## Feature Description

Reel studio MVP, slice 12 of 17. When the live preview looks right, the owner presses **Export** on
the reel page. That inserts a `render` job naming the reel's current version. The worker claims it,
makes sure the full-size inputs exist (it runs the fixed pipeline; every step is a cache hit unless
a rebuildable output was deleted, and then that step is rebuilt), builds the page with the one
shared builder (`packages/edit`, `build`), writes a temporary HyperFrames project in the job's
scratch folder (page, full-size retimed footage, full-size cut-out, fonts, click sounds) and runs
`hyperframes render --quality delivery --workers 3 --no-browser-gpu --sdr` through the step runner
with group memory sampling. The MP4 goes to R2 at `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`,
an `exports` row records it (expiring exactly 24 hours after it was made), and the step line reads
`render: exported, 3 minutes 2 seconds, 74.0 MB`. The reel page shows the latest export with a
download link signed for no longer than the time left until `expires_at`; after that it shows
`expired, export again`. Pressing Export sends `studio_export_requested`, clicking the link sends
`studio_export_downloaded`.

A tools-only guardrail proves that what the owner downloads is what the preview showed: it captures
the studio's live preview and the exported MP4 at the same moments and compares them with ffmpeg's
`ssim` filter, with a negative proof (a caption moved by 60 px falls below the bound). A worker tools
test proves the voice level and the click timing of the export.

## User Story

As the owner of the studio
I want to press Export when the preview looks right and get a download link to a high-quality MP4
So that I can post the reel to TikTok or Instagram knowing the file matches what I approved, while the
file itself disappears 24 hours later

## Problem Statement

The studio can process a reel, make versions and preview them live, but nothing turns a version into
a file the owner can post. The preview is a live HyperFrames page and never renders, so the export
must render on demand, with settings chosen for platforms that recompress every upload, and must be
proven to match the preview: if the exported MP4 differs from what the preview showed, the live
preview cannot replace renders and the approach fails. Renders are large, so they must not be kept:
a browser does not report a finished download, so the file has to expire on a clock.

## Solution Statement

- **Database** (one new migration made with `supabase migration new export_render_jobs`): job kind
  `render` with a new nullable `jobs.version_id` (a render names a version of the same reel through
  a composite foreign key to `versions (id, reel_id)`; no other kind names one), a column-limited
  insert grant and its own insert policy. A new `exports` table, owner-only `select` RLS, written
  only by the worker (service role), never updated, `expires_at` set by a trigger to
  `created_at + interval '24 hours'`, `owner_id` taken from the reel by the same trigger, in the
  `supabase_realtime` publication.
- **Worker**: a `render` job kind dispatched by `runJobKind` to a new `runRender`. It runs
  `runPipeline` with a new `setReelStatus: false` option (a render runs on a processed reel and must
  not move its status), reads the version's edit, transcript and head track, downloads the version's
  full-size footage and cut-out, and runs one `render` step through `runToolsStep` with
  `sampleGroupMemory: true`. A pure `renderCall` gives the exact HyperFrames arguments; under
  `E2E_MOCK_RENDER=true` (exactly) the call is replaced by a `cp` of a small committed MP4 through the
  same step runner, so specs need no Chrome render. The step uploads put-if-absent, inserts the
  `exports` row and finishes. A retried job whose export row already exists is a hit
  (`export kept, reused`).
- **Sound decision (checked in the pinned HyperFrames 0.8.222)**: sounds stay **inside the page**.
  The builder already writes each `tracks.sounds` item as an `<audio class="clip">` with
  `data-start`, `data-duration` and `data-volume`, and the footage `<video>` carries
  `data-has-audio="true"`. HyperFrames' local render mixes every page audio track itself
  (`mixAudioTracksFlat` in `node_modules/hyperframes/dist/chunk-AIXH3V5A.js`: `amix ... normalize=0`
  followed by `volume=<audioGain>` with `audioGain` defaulting to `1`, overridable only through
  `PRODUCER_AUDIO_GAIN`). With `normalize=0` and unity master gain the voice passes at its own level,
  which is what the old setup lacked (its draft render came out at -19.1 LUFS against -18.0). The
  render's environment therefore drops every `PRODUCER_*` variable, so a stray shell variable cannot
  change the mix. No ffmpeg remix and no second copy of the sound logic. The worker tools test proves
  the loudness (within 0.5 LU) and the click times (within 20 ms); if it ever fails, the fallback the
  doc names is an ffmpeg remix of the retimed source's audio plus the clicks resolved from the same
  `tracks.sounds` through `resolveTimeline`, never hard-coded times.
- **Storage**: `signDownload` gains an optional `downloadName`, so the link downloads rather than
  plays (R2: `ResponseContentDisposition: attachment; filename="..."`; the folder fake appends
  `?download=<name>` and the studio's mock route then answers with the same `Content-Disposition`).
- **Studio**: `ExportPanel` on the reel page (Export button, blocked reason, latest export with its
  link or `expired, export again`), server actions `requestExport` and `loadLatestExport` in
  `src/app/export-actions.ts`, pure rules in `src/lib/exports.ts` (`exportBlockedReason`,
  `exportLinkSeconds`, `exportView`, `isExportKey`, `exportFileName`). `LiveReel` follows `INSERT`
  on `exports` through its existing Realtime channel, so the link appears without a reload and
  without polling.
- **Tests**: unit (worker, studio, storage), DB (`exports.test.ts`), E2E (`export.spec.ts`, stubbed
  render), and two tools-only tests on the Mac: the worker's `render.tools.test.ts` (audio and group
  memory) and the studio's `e2e-tools/export-matches-preview.spec.ts` (the guardrail).

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; the Checks section gains the studio's `test:tools`.
- `AGENTS.md`: rules (Yarn only, migrations through `supabase migration new`, no em-dashes, docs layout).
- `.adw/project.md`: the ADW profile. Its Tests section must name the new E2E spec, the studio's tools
  spec and `E2E_MOCK_RENDER`; headings never renamed or reordered.
- `docs/conditional-docs.md`: add one line for `app_docs/export.md`.
- `app_docs/studio.md`: jobs kinds and policies, the storage doubles, the reel page; update for
  `render`, `exports` and `E2E_MOCK_RENDER`.
- `app_docs/measurement.md`: step runner, `sampleGroupMemory`, the events table (the two export events
  move from "reserved" to sent).
- `app_docs/pipeline.md`: `runPipeline` (new `setReelStatus` option), kept and rebuildable outputs, the
  HyperFrames rules (never npx, always `HYPERFRAMES_NO_TELEMETRY=1`).
- `app_docs/edit-model.md`: one builder for preview and export; never store a built page.
- `app_docs/preview.md`: the preview the guardrail compares against; `previewPage` drops sound clips.
- `app_docs/change-requests.md`: the one-job-at-a-time rule (`changeBlockedReason`), `jobRequestLabel`,
  job kinds and their insert policy, `job-kinds.ts`.
- `app_docs/adw-supabase-stack.md`: how a run applies a new migration (`.adw/supabase-stack reset`).
- `supabase/migrations/20261101184843_change_restore_jobs.sql`: the pattern for a new job kind (kind
  check, column, column grant, policy).
- `supabase/migrations/20261101153653_versions.sql`: `versions (id, reel_id)` unique (composite FK
  target), the immutability trigger pattern, RLS and publication pattern.
- `supabase/migrations/20261031174750_job_queue.sql`: `claim_job` returns `setof public.jobs`, so the
  new `version_id` column reaches the worker without redefining it.
- `apps/worker/src/process-job.ts`: wires job kinds; add `render`.
- `apps/worker/src/job-kinds.ts` and `job-kinds.test.ts`: dispatch by kind; add `render`.
- `apps/worker/src/queue.ts`: `ClaimedJob` gains `version_id`; only `process` moves the reel status.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `recordHit`, `ToolCall.sampleGroupMemory`, the
  default `runChild` spawner (exported for the tools test).
- `apps/worker/src/pipeline/run-pipeline.ts` and `run-pipeline.test.ts`: add `setReelStatus`.
- `apps/worker/src/pipeline/tools.ts`: `toolPaths`, `hyperframesEnv`.
- `apps/worker/src/pipeline/fingerprint.ts`: `cacheKey`.
- `apps/worker/src/first-version.ts`: how a step reads JSON inputs by `EditInputs` refs and calls
  `build` with `editMeasurer`.
- `apps/worker/src/edit-measurer.ts`: resolving `@edit-issebya/edit/assets/*` files from the worker.
- `apps/worker/src/decide/run-decide.ts`: the `mkdtemp(join(scratchDir, ...))` scratch pattern.
- `apps/worker/src/restore-step.ts`: a small job-kind step module to model `render-step.ts` on.
- `apps/worker/src/version-store.ts`: `supabaseVersionRows` (`get`), to read the version.
- `apps/worker/src/recording-steps.ts`: the recording `StepContext` for unit and tools tests.
- `apps/worker/src/pipeline/tools-test-support.ts`, `apps/worker/vitest.tools.config.ts`: tools tests.
- `apps/worker/src/summary.ts`: `stepSummary` gives `exported, <duration>, <size>`.
- `apps/worker/src/ai.ts`: the exact-`"true"` double flag pattern (`E2E_MOCK_AI`).
- `packages/edit/src/build.ts`: the page (`<video src="source.mp4">`, `<video src="subject.webm" muted>`,
  `@font-face` `assets/fonts/...`, `<audio src="assets/sounds/...">`), `assets` list with roles.
- `packages/edit/src/index.ts`: `build`, `editSchemaFor`, `transcriptSchema`, `headTrackSchema`,
  `resolveTimeline`, `baselineEdit`, `ISSEBYA_PRESET`.
- `packages/storage/src/storage.ts`, `r2.ts`, `fake.ts` and their tests: `signDownload`.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` and `route.test.ts`: GET answers.
- `apps/studio/src/components/LiveReel.tsx`: the Realtime channel and the reel page layout.
- `apps/studio/src/components/ChangeRequestForm.tsx`: button, blocked reason and pending pattern.
- `apps/studio/src/app/change-actions.ts`: server action pattern (own client, RLS, column grant).
- `apps/studio/src/app/preview-actions.ts`: signing downloads in a server action.
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS`, `JOB_KINDS`, `JobRow`.
- `apps/studio/src/lib/change-requests.ts` and test: `changeBlockedReason`, `jobRequestLabel`.
- `apps/studio/src/lib/track.ts`: `STUDIO_EVENTS` (export events already reserved), `capture`.
- `apps/studio/src/lib/storage.ts`: `studioStorage`, `MOCK_UPLOAD_URL_BASE`.
- `apps/studio/src/lib/reels.ts`: `reelName`, `formatBytes`, `formatCreatedAt`.
- `apps/studio/src/components/PreviewPlayer.tsx`: `data-preview`, `data-preview-version`, the
  `Position` slider the guardrail seeks with.
- `apps/studio/e2e/change-requests.spec.ts`, `preview.spec.ts`, `events.ts`: spec patterns (serial
  page, CDN routes to local packages, `recordEvents`, cleanup).
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` (doubles on, OTLP off); gains
  `E2E_MOCK_RENDER: "true"` and a timeout option.
- `apps/studio/test-support/pipeline-cache.ts`, `versions.ts`, `fixtures.ts`: `seedProcessedReel`,
  `saveTestVersion`, users and reels.
- `apps/studio/db-tests/change-jobs.test.ts`, `rls.test.ts`, `realtime.test.ts`: DB test patterns.
- `apps/studio/playwright.config.ts`: base for the tools config.
- `apps/studio/package.json`, `apps/worker/package.json`: scripts.
- `knip.json`: new studio Playwright config and folder.
- `turbo.json`: `E2E_MOCK_*` already passes through for `test:e2e`; no change expected.
- `fixtures/pipeline/`: the committed step outputs (the fixture reel is 2.69 s long, ten words
  `w0001` to `w0010`).
- `node_modules/hyperframes/dist/docs/rendering.md` and `render --help`: the flags used.
- `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/brief.md` and `mix_sfx.py`:
  the old setup's loudness problem (read-only; never write to that repository).
- `node_modules/next/dist/docs/`: read the server actions and client components guides before the
  studio work.

### New Files

- `supabase/migrations/<stamp>_export_render_jobs.sql` (made by `supabase migration new export_render_jobs`).
- `fixtures/render/stub-export.mp4`: a tiny committed MP4 (1 s, 108x192, black, silent AAC) the fake
  render copies.
- `apps/worker/src/render/render-call.ts` and `render-call.test.ts`: `RENDER_SETTINGS`,
  `renderCall`, `renderEnv`.
- `apps/worker/src/render/render-project.ts` and `render-project.test.ts`: writes the HyperFrames project.
- `apps/worker/src/render/export-key.ts` and `export-key.test.ts`: `exportKey`.
- `apps/worker/src/render/export-store.ts`: `ExportStore` and `supabaseExportStore`.
- `apps/worker/src/render/render-step.ts` and `render-step.test.ts`: `runRender` and `renderExport`.
- `apps/worker/src/render/render.tools.test.ts`: real HyperFrames, loudness, click times, group memory.
- `apps/studio/src/lib/exports.ts` and `exports.test.ts`.
- `apps/studio/src/app/export-actions.ts`.
- `apps/studio/src/components/ExportPanel.tsx`.
- `apps/studio/db-tests/exports.test.ts`.
- `apps/studio/e2e/export.spec.ts`.
- `apps/studio/playwright.tools.config.ts`.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`.
- `apps/studio/test-support/frames.ts`: ffmpeg frame extraction and the `ssim` score, for the tools spec.
- `app_docs/export.md`.

## Implementation Plan

### Phase 1: Foundation

Database (migration, then `.adw/supabase-stack reset` in a run), the storage `downloadName` option,
the pipeline's `setReelStatus` option, the stub MP4, and the job kind plumbing (`ClaimedJob.version_id`,
`runJobKind`, studio `JOB_KINDS` and `JOB_COLUMNS`).

### Phase 2: Core Implementation

The worker's render: `renderCall` (exact flags, fake under the flag), `writeRenderProject`,
`renderExport` (build, project, one tool call), `runRender` (ensure inputs, read the version, the
measured `render` step, upload, `exports` row, hit on retry). The studio's pure export rules, the two
server actions and `ExportPanel`.

### Phase 3: Integration

`processJob` dispatches `render`; `LiveReel` renders `ExportPanel` and follows `exports` inserts;
events; the E2E spec; the DB tests; the two tools tests; the docs and the ADW profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md`, `measurement.md`, `pipeline.md`, `edit-model.md`, `preview.md`,
  `change-requests.md` and `adw-supabase-stack.md`; their Rules are invariants for this change.
- Read the Next.js guides on server actions and client components under `node_modules/next/dist/docs/`.
- Read `node_modules/hyperframes/dist/docs/rendering.md` and run
  `node node_modules/hyperframes/bin/hyperframes.mjs render --help` to confirm the flags
  (`-o`, `--quality`, `--workers`, `--no-browser-gpu`, `--sdr`, `--start`, `--end`, positional `DIR`).

### 2. Migration: `render` jobs and the `exports` table

- Create it with `supabase migration new export_render_jobs` (never hand-pick the version).
- `alter table public.jobs`: drop and re-add `jobs_kind_check` with `('process', 'change', 'restore', 'render')`;
  add `version_id uuid`; add `foreign key (version_id, reel_id) references public.versions (id, reel_id) on delete cascade`
  (a render names a version of its own reel; `versions` has `unique (id, reel_id)`);
  add `jobs_version_check check ((kind = 'render') = (version_id is not null))`.
- `grant insert (version_id) on public.jobs to authenticated;` (the existing `reel_id`, `kind` grant stays).
- Policy `jobs: owner inserts a render job for own reel` (insert, `authenticated`): `(select auth.uid()) = owner_id`,
  `status = 'queued'`, `kind = 'render'`, the reel is the caller's, and
  `exists (select 1 from public.versions v where v.id = jobs.version_id and v.reel_id = jobs.reel_id)`.
  The change/restore policy keeps `kind in ('change', 'restore')`, so a change or restore can never carry
  a `version_id` (the check refuses it too).
- `create table public.exports`: `id uuid primary key`, `reel_id uuid not null references public.reels (id) on delete cascade`,
  `owner_id uuid not null references auth.users (id) on delete cascade`, `job_id uuid not null unique references public.jobs (id) on delete cascade`,
  `version_id uuid not null`, `foreign key (version_id, reel_id) references public.versions (id, reel_id) on delete cascade`,
  `r2_key text not null unique`, `bytes bigint not null check (bytes > 0)`, `created_at timestamptz not null default now()`,
  `expires_at timestamptz not null`, `check (expires_at = created_at + interval '24 hours')`;
  index `exports_reel_idx on (reel_id, created_at desc)`.
- Trigger `exports_before_insert` (plpgsql, `security definer`, `set search_path = ''`): sets
  `new.expires_at := new.created_at + interval '24 hours'` (whatever the caller passed) and
  `new.owner_id := (select owner_id from public.reels where id = new.reel_id)` (the reel's owner, never trusted
  from the caller). Trigger `exports_refuse_update` (like `versions_refuse_update`): an export is never changed.
  Deletes stay possible for the service role (tests, a future cleanup) and through the reel's cascade.
- RLS: enable; `revoke all on public.exports from anon, authenticated; grant select on public.exports to authenticated;`
  policy `exports: owner selects own` (`(select auth.uid()) = owner_id`). The worker inserts with the secret
  key (service role), so no insert policy exists.
- `alter publication supabase_realtime add table public.exports;`
- Header comment saying what the migration does, in the style of the previous ones. No em-dashes.
- In a run: `.adw/supabase-stack reset` (the profile's only allowed way to apply it; see Notes). If it fails,
  report its error and stop.

### 3. Storage: download links that download

- `packages/storage/src/storage.ts`: `signDownload(key, { expiresInSeconds, downloadName? })`. Document that
  `downloadName` makes the response an attachment with that file name.
- `r2.ts`: when `downloadName` is set, `GetObjectCommand` gets `ResponseContentDisposition: attachment; filename="<name>"`.
  Refuse a name outside `/^[A-Za-z0-9._-]{1,128}$/` (throw), so nothing can break the header.
- `fake.ts`: append `?download=<encodeURIComponent(name)>` when set (same check).
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: GET (whole and ranged) adds
  `Content-Disposition: attachment; filename="<name>"` when the `download` search parameter passes the same
  check; otherwise unchanged. Add `.mp4` handling stays as is.
- Tests: `r2.test.ts` (the signed URL carries `response-content-disposition`, a bad name throws),
  `fake.test.ts` (query appended, bad name throws), `route.test.ts` (header present with a good name, absent
  without one or with a bad one).

### 4. Pipeline: run without moving the reel's status

- `apps/worker/src/pipeline/run-pipeline.ts`: `PipelineRun.setReelStatus?: boolean` (default `true`); when
  `false`, `steps.reelStatus` is never called. Everything else unchanged.
- `run-pipeline.test.ts`: with `setReelStatus: false` all hits record six `skipped` rows and no `reelStatus`
  call; a missing rebuildable output (`subject.webm`) still re-runs only `remove_background`.

### 5. Job kind plumbing

- `apps/worker/src/queue.ts`: `ClaimedJob.version_id: string | null` (comment: the version a `render` job
  exports). `reelStatusAfter` already leaves non-`process` jobs alone; extend its comment to name `render`.
- `apps/worker/src/job-kinds.ts`: `KindRunners.render: (versionId: string) => Promise<void>`; `case "render"`
  throws `render job has no version to export` without `version_id`.
- `job-kinds.test.ts`: render dispatches with its version; render without a version throws; existing cases keep.
- Fix every `ClaimedJob` literal in worker tests (add `version_id: null`).
- `apps/studio/src/lib/jobs.ts`: `JOB_KINDS` adds `"render"`; `JOB_COLUMNS` adds `version_id`; `JobRow.version_id`.
- `apps/studio/src/lib/change-requests.ts`: `jobRequestLabel` returns `export of vN` for a render (or
  `export` when the version is unknown); test it. `changeBlockedReason` is unchanged: a queued or running
  render also blocks a change or a going back (the interim one-job-at-a-time rule counts every job).

### 6. The stub MP4

- Make `fixtures/render/stub-export.mp4` once with
  `ffmpeg -f lavfi -i color=c=black:s=108x192:r=30:d=1 -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -movflags +faststart fixtures/render/stub-export.mp4`
  (a few KB) and commit it. `export.md` records the command.

### 7. Worker: render call, project and export key (pure parts)

- `apps/worker/src/render/render-call.ts`:
  - `RENDER_SETTINGS = { quality: "delivery", workers: 3, browserGpu: false, sdr: true } as const`, with a
    comment saying why (platforms recompress every upload, so a cleaner source keeps text edges and the
    cut-out's outline sharper; software mode with three workers is faster here than the GPU mode with one and
    runs the same on a machine without a graphics chip; never `--gpu`, never `--browser-gpu`).
  - `renderArgs({ projectDir, output, range? })`: exactly
    `["render", projectDir, "-o", output, "--quality", "delivery", "--workers", "3", "--no-browser-gpu", "--sdr"]`,
    plus `["--start", s, "--end", e]` only when `range` is given (the tools test).
  - `renderEnv(env)`: `hyperframesEnv(env)` without any `PRODUCER_*` variable (the mix stays at unity gain).
  - `renderCall({ tools, projectDir, output, range?, env })`: the `ToolCall`
    `{ file: tools.hyperframes[0], args: [tools.hyperframes[1], ...renderArgs(...)], env: renderEnv(env), sampleGroupMemory: true }`;
    when `env.E2E_MOCK_RENDER === "true"` exactly, `{ file: "/bin/cp", args: [STUB_EXPORT, output], sampleGroupMemory: true }`
    where `STUB_EXPORT` is `fixtures/render/stub-export.mp4` resolved from `import.meta.url`.
  - `render-call.test.ts`: the exact argument list; no `--gpu` and no `--browser-gpu`; `HYPERFRAMES_NO_TELEMETRY`
    is `"1"` and `PRODUCER_AUDIO_GAIN` is dropped; the range adds `--start`/`--end`; `"TRUE"`, `"1"` and unset do
    not turn the fake on; `"true"` gives the `cp` of the stub (which exists on disk).
- `apps/worker/src/render/render-project.ts`: `writeRenderProject({ dir, html, assets, files: { footage, cutout } })`
  writes `dir/index.html` and puts each `BuildAsset` at `dir/<asset.path>`: `footage` and `cutout` roles from the
  given local files (hard link, falling back to copy), `font` and `sound` roles from
  `import.meta.resolve("@edit-issebya/edit/<path>")` (as `edit-measurer.ts` does). Refuse an asset path that is
  absolute or has a `..` segment. Returns the list of written files (the step's `inputs` for `bytes_in`).
  `render-project.test.ts` builds the baseline fixture page and checks every asset landed at its path, plus the refusal.
- `apps/worker/src/render/export-key.ts`: `exportKey(prefix, reelId, exportId)` returns
  `${prefix}exports/<reelId>/<exportId>.mp4`, passed through `assertStorageKey`. Test it.

### 8. Worker: the export store and the render step

- `apps/worker/src/render/export-store.ts`: `ExportStore` with `forJob(jobId)` (the existing export's id, or null)
  and `insert({ id, reel_id, owner_id, job_id, version_id, r2_key, bytes })` (named columns, `created_at` and
  `expires_at` from the database); `supabaseExportStore(db)`.
- `apps/worker/src/render/render-step.ts`:
  - `renderExport({ tool, tools, dir, edit, transcript, headTrack, files, range?, env })`: `build(edit, transcript,
headTrack, ISSEBYA_PRESET, await editMeasurer())`, `writeRenderProject` into `dir/project`, then
    `tool(renderCall(...))` writing `dir/export.mp4`; checks the file exists and is non-empty; returns its path
    and the project files. No other build logic: the page is exactly what `build` returns, never stored.
  - `runRender({ ctx, storage, db-backed rows, exports, keyPrefix, scratchDir, tools, versionId, ensureInputs?, newId?, spawnTool?, env? })`:
    1. `exports.forJob(job.id)` exists: `recordHit(ctx, { name: "render", summary: "export kept, reused" })`, return.
    2. `ensureInputs` (default: `runPipeline({ ..., setReelStatus: false })`): every pipeline step a hit, or the
       missing rebuildable step rebuilt first (slice 14 relies on this).
    3. `rows.get(versionId)`; refuse a version of another reel. Read the edit from `r2_key`, then the transcript
       and head track from `version.inputs` by `cacheKey` (as `first-version.ts` does); parse with
       `transcriptSchema`, `headTrackSchema`, `editSchemaFor(ISSEBYA_PRESET, transcript)`.
    4. One `runToolsStep` named `render` (`outputs: [<dir>/export.mp4]`, `inputs`: the project files, `sizeOf: "out"`):
       inside `work`, download `version.inputs.footage` and `version.inputs.cutout` by their own refs with
       `storage.getFile` into `mkdtemp(join(scratchDir, "render-"))` (a missing key fails naming it), call
       `renderExport`, then `storage.putFileIfAbsent(exportKey(...), mp4, { contentType: "video/mp4" })`
       and `exports.insert(...)` with `bytes` from `stat`; return `{ what: "exported" }`. The summary is
       `exported, <duration>, <size>`.
    5. `finally`: remove the scratch folder.
  - `render-step.test.ts` (recording steps, fake storage in a temp folder, a fake `spawnTool` that writes a file at
    the `-o` path or copies for `cp`): one `render` row `done` with `exported, ...`; the object at
    `<prefix>exports/<reel>/<id>.mp4`; the insert carries job, version, key and bytes; `ensureInputs` called with
    no reel status; a second run with an existing export is a hit and spawns nothing; a missing cut-out fails the
    step with the key in the tail and inserts nothing; the tool call carries `sampleGroupMemory: true`; the page
    written to the project equals `build(...).html` byte for byte (same builder).
- `apps/worker/src/step-runner.ts`: export the default spawner as `spawnChild` (rename `runChild`), used by the
  tools test to read the single-process report; no behaviour change.

### 9. Worker: wire the kind

- `apps/worker/src/process-job.ts`: `render: (versionId) => runRender({ ctx, storage, rows, exports: supabaseExportStore(db), keyPrefix: config.keyPrefix, scratchDir: config.scratchDir, tools: toolPaths(), versionId })`.
  Update the file's header comment (a `render` job runs the pipeline's hits and the render step and leaves the
  reel's status alone).

### 10. Studio: pure export rules

- `apps/studio/src/lib/exports.ts`:
  - `EXPORT_COLUMNS = "id, reel_id, job_id, version_id, r2_key, bytes, created_at, expires_at"`, `ExportRow`.
  - `exportBlockedReason(reel, jobs)`: `No version to export yet.` without `current_version_id`;
    `Export opens once the reel is processed.` when not `processed`; `Exporting this version...` when a `render`
    job for the current version is `queued` or `running`; else null.
  - `exportLinkSeconds(expiresAt, nowMs)`: whole seconds left (floored); `null` when zero or less, or when the date
    does not parse. The signer never signs past `expires_at`.
  - `exportView(row | null, nowMs)`: `{ kind: "none" }`, `{ kind: "expired" }` or `{ kind: "ready", seconds }`.
  - `isExportKey(key, reelId)`: a storage key ending `exports/<reelId>/<uuid>.mp4`.
  - `exportFileName(versionNumber, createdAt)`: `reel-v<N>-<YYYYMMDD-HHMM>.mp4` (UTC), safe for `downloadName`.
- `exports.test.ts`: each rule, including a render for an older version not blocking, an expired row giving no
  seconds, one second left giving 1, a malformed date giving null, a key of another reel refused.

### 11. Studio: server actions

- `apps/studio/src/app/export-actions.ts` (`"use server"`):
  - `requestExport(reelId)`: valid id; own client; signed in; read the reel (`id, status, current_version_id`) and its
    jobs (`id, kind, status, version_id`) under RLS; `exportBlockedReason` refuses with `blocked`; insert
    `{ reel_id, kind: "render", version_id: current_version_id }` under RLS and return `{ status: "queued", jobId, versionId }`.
    The browser never chooses the version.
  - `loadLatestExport(reelId)`: own client; the newest `exports` row of the reel (`EXPORT_COLUMNS`, ordered
    `created_at desc`, limit 1) and its version's `number`; `none`, `expired` (no signing at all), or `ready` with
    `url` signed through `studioStorage().signDownload(key, { expiresInSeconds: exportLinkSeconds(...), downloadName: exportFileName(...) })`,
    `bytes`, `versionNumber`, `expiresAt`. Refuses a row whose key fails `isExportKey`. `unconfigured`,
    `signed-out` and `failed` as in `preview-actions.ts`. Errors logged without keys or URLs.

### 12. Studio: Export panel and live updates

- `apps/studio/src/components/ExportPanel.tsx` (client), a section `aria-labelledby="export-heading"` with heading
  `Export`, placed in `LiveReel` right after `ReelPreview`:
  - `Export` button (`data-testid="export-button"`), disabled while sending or when `exportBlockedReason` gives a
    reason, shown beside it (`data-testid="export-blocked-reason"`). On `queued` it sends
    `capture("studio_export_requested", { reel_id })`; `signed-out` refreshes; other results show
    `The export was not started. Try again.`.
  - The latest export: calls `loadLatestExport` on mount and whenever `latestExportId` (prop from `LiveReel`)
    changes. `ready`: a link `data-testid="export-link"` (`Download version N (74.0 MB)`, `href` the signed URL,
    `download` attribute with the file name) and `expires <time>`; clicking sends
    `capture("studio_export_downloaded", { reel_id })`. `expired`: `data-testid="export-expired"` reading
    `expired, export again`, no link. One `setTimeout` to the link's expiry switches the view to expired (no
    network, no polling). `none`: nothing.
- `apps/studio/src/components/LiveReel.tsx`: the snapshot also reads the newest export id (`exports`, `id`,
  ordered `created_at desc`, limit 1); the channel adds
  `{ event: "INSERT", schema: "public", table: "exports", filter: "reel_id=eq.<id>" }` setting `latestExportId`;
  pass `reel`, `jobs` and `latestExportId` to `ExportPanel`. Update the component comment.
- `apps/studio/src/app/reels/[id]/page.tsx`: also reads the newest export id on the server and hands it to `LiveReel`.
- `apps/studio/src/lib/track.ts`: the comment lists the two export events as sent.

### 13. Test support

- `apps/studio/test-support/worker.ts`: `runWorkerOnce(env, { timeoutMs = 60_000 } = {})`; the default env adds
  `E2E_MOCK_RENDER: "true"` beside `E2E_MOCK_AI`, so no spec ever starts a real render; the tools spec passes
  `E2E_MOCK_RENDER: ""` and a longer timeout.
- `apps/studio/test-support/frames.ts` (tools spec only): `extractFrame(mp4, seconds, width, height, png)` (ffmpeg
  `-ss <t> -i <mp4> -frames:v 1 -vf scale=W:H`), `ssim(a, b)` (ffmpeg `-i a -i b -lavfi ssim -f null -`, parse
  `All:`), `FFMPEG_PATH` honoured. Never imported by a CI spec.

### 14. E2E: `apps/studio/e2e/export.spec.ts` (fails without the feature)

- Serial, modelled on `change-requests.spec.ts`: refuse leftover claimable jobs; a user; `seedProcessedReel` under a
  per-run prefix; one page with the CDN scripts routed to the local packages; `recordEvents`.
- Test 1, export and download: open the reel, wait `data-realtime="ready"`, set a no-reload marker on `window`.
  `export-button` is enabled; click it. The admin client sees exactly one `render` job, `queued`, `version_id` equal
  to the reel's `current_version_id`; the button is disabled with `Exporting this version...`; one
  `studio_export_requested` with the reel id and `app: "studio"`. `runWorkerOnce()` exits 0. Without a reload
  (marker still set): `export-link` visible, the step log has `render: exported, ...`, the reel status still
  `processed`. The `exports` row: `r2_key` is `<prefix>exports/<reel>/<id>.mp4`, `bytes` equals the stub's size,
  `expires_at - created_at` is exactly 24 hours, the object exists in the storage double. Clicking the link fires a
  Playwright `download` whose suggested file name ends in `.mp4` and whose bytes equal the stub, and one
  `studio_export_downloaded` with the reel id.
- Test 2, expiry: as the admin, delete that export row and insert one for the same job and version with
  `created_at` 25 hours ago (the trigger sets `expires_at` 1 hour ago). Reload: `export-expired` reads
  `expired, export again`, no `export-link`, the Export button enabled.
- Cleanup: every key written (seed, versions, the export object), the user (cascade removes reels, jobs, exports).

### 15. DB tests: `apps/studio/db-tests/exports.test.ts`

- Users A and B, a reel each with a version (saved as `change-jobs.test.ts` does), a render job each.
- A render job: A inserts one for own reel and own version; refused for B's reel, for a version of another of A's
  reels, without `version_id`, with `status` other than `queued`; a `change` or `restore` with a `version_id` is refused.
- Exports, inserted as the service role: `expires_at` equals `created_at + 24 hours` even when the insert passes
  another value, `owner_id` is the reel's owner even when the insert passes B; an update is refused even for the
  service role; A selects own export; **B sees no export of A's reels**; `authenticated` cannot insert, update or
  delete; `anon` sees nothing.
- `realtime.test.ts` (or this file): `exports` is in `supabase_realtime`. `rls.test.ts` already requires RLS on
  every public table, so the new table is covered.

### 16. Worker tools test: `apps/worker/src/render/render.tools.test.ts` (Mac only)

- Inputs: `fixtures/pipeline/` files used directly (retime `source.mp4` and `transcript.json`, `subject.webm`,
  `head-track.json`, `retime.json` duration). Edit A: `baselineEdit` (no sounds). Edit B: A plus two `click`
  sounds anchored on `w0005` and `w0009` starts (at least 0.25 s apart).
- Each render runs the real `renderExport` inside `runToolsStep` with a recording context and a `spawnTool` that
  wraps `spawnChild` to keep the raw `ChildRun`, range `--start 0 --end 3`.
- Loudness: ffmpeg `ebur128` integrated loudness of export A and of `source.mp4` over 0 to 2.69 s; within 0.5 LU.
- Click times: decode export B and `source.mp4` to mono 48 kHz float PCM, subtract, take 1 ms RMS windows; an onset is
  the first window above ten times the median residual (the voice leaves only AAC re-encoding residue, far below a
  click at -13 dB); each expected start from `resolveTimeline(editB, transcript)` has an onset within 20 ms, and no
  onset appears farther than 20 ms from every expected start. Justify the threshold in a comment.
- Group memory: the recorded `done` row's `peak_rss_bytes` equals the `ChildRun.groupPeakBytes` and is larger than
  the single-process max RSS parsed from `ChildRun.report` (`parseTimeReport`), which is the largest single process,
  a Chrome worker or the encoder.
- Also: the MP4 is H.264, 1080x1920, 30 fps, about 2.69 s, has an AAC stream.

### 17. Studio tools spec: the guardrail (Mac only)

- `apps/studio/playwright.tools.config.ts`: the base config's servers and env with `testDir: "./e2e-tools"`,
  a 15-minute test timeout, `workers: 1`, `retries: 0`. `apps/studio/package.json` script
  `"test:tools": "playwright test -c playwright.tools.config.ts"`. Not in `yarn test:e2e`, not in CI.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`:
  1. `seedProcessedReel`, then `saveTestVersion` of a guardrail edit (version 2's edit plus one accent overlay, one
     `dim` transition crossing 1.5 s and one click), the reel's current version.
  2. Open the reel page (CDN routes as in `preview.spec.ts`), wait `data-preview="ready"` with
     `data-preview-version` the guardrail version. For t in 0.5, 1.5, 2.5: set `Position` to t, wait until every
     video in the player's frame has finished seeking with `readyState >= 2` at t, two animation frames, then
     `page.locator("hyperframes-player").screenshot()`.
  3. Click Export; `runWorkerOnce({ E2E_MOCK_RENDER: "" }, { timeoutMs: 10 * 60_000 })` (the real render step;
     the fixture reel is 2.69 s long, so the full render is the issue's seconds 0 to 3).
  4. Read the MP4 from the storage double; `extractFrame` at each t scaled to the screenshot's size; `ssim` per pair;
     each at least `PREVIEW_EXPORT_SSIM_BOUND` (0.95). Log every score.
  5. Negative proof: `saveTestVersion` of a probe copying the guardrail edit with the caption on screen at 1.5 s moved
     60 px down (`position.y` + 60), Export, render; compare its frames with step 2's captures: at least one falls
     below the bound. The probe version goes with the test reel at cleanup (versions are never updated or deleted
     on their own); its blob and export object are deleted from storage.
  6. The render step row of the first export has `peak_rss_bytes` set and above 256 MB.
- Record the measured scores (positive and negative) in `app_docs/export.md`. If the negative proof does not fall
  below 0.95, raise the bound between the two sets with that evidence (never below 0.9) and say so in the doc.

### 18. Configuration and dead code

- `knip.json`, `apps/studio`: `"playwright": { "config": ["playwright.config.ts", "playwright.tools.config.ts"] }`
  and `"e2e-tools/**/*.ts"` in `project`.
- Check `apps/studio/eslint.config.mjs` and `tsconfig.json` cover `e2e-tools/` (the tsconfig includes `**/*.ts`).
- `turbo.json`: no change (`test:e2e` passes `E2E_MOCK_*`; `runWorkerOnce` sets the worker's env explicitly).

### 19. Docs and profile

- New `app_docs/export.md`: Overview; How it works (migration, render job, `version_id`, `runRender` and
  `setReelStatus: false`, the exact flags and why, sound inside the page and the HyperFrames mix evidence, the R2
  location `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`, the 24-hour `expires_at` and the owner's R2
  lifecycle backstop, the download link and `downloadName`, `E2E_MOCK_RENDER` and the stub with its ffmpeg command);
  How to Use; Configuration; Testing (unit, DB, E2E, both tools tests, the guardrail bound and the measured scores);
  Rules: render only on export, never for the preview; software mode with three workers at `delivery` quality, never
  a GPU mode; the same builder, never a worker copy, never a stored page; never a link past `expires_at`; sounds only
  from the edit's sound track; never write an export row from the studio; never turn the render double on unless its
  flag is exactly `"true"`. Notes: out of scope (progress, cleanup and disk guard, cloud rendering), what the
  pipeline does not verify, the owner's steps.
- `docs/conditional-docs.md`: one line for `app_docs/export.md`.
- `app_docs/measurement.md`: the events table (the two export events sent, from `ExportPanel.tsx`), and that the
  render is the step using `sampleGroupMemory`.
- `app_docs/studio.md`: four job kinds and the render policy, the `exports` table, `E2E_MOCK_RENDER` among the doubles.
- `app_docs/pipeline.md`: `setReelStatus`. `app_docs/change-requests.md`: a render also holds the one-job rule, and the
  `export of vN` label.
- `.adw/project.md` Tests section: `export.spec.ts` in the studio E2E list (stubbed render under `E2E_MOCK_RENDER`),
  the studio's `test:tools` (`yarn workspace @edit-issebya/studio test:tools`, the guardrail, the Mac only, needs the
  run's servers) beside the worker's, `db-tests/exports.test.ts`. Keep the nine headings.
- `README.md` Checks: the two `test:tools` commands, Mac only.

### 20. Run the validation commands

- Run every command in `Validation Commands`; all must pass. On the Mac run both tools commands and record the guardrail
  scores in `app_docs/export.md`.

## Testing Strategy

### Unit Tests

- Worker: `render-call.test.ts` (exact flags, env, the fake only under exactly `"true"`), `render-project.test.ts`
  (assets at their paths, path refusal), `export-key.test.ts`, `render-step.test.ts` (row, upload, export row,
  hit on retry, missing input, same builder bytes, group sampling flag), `job-kinds.test.ts` (render),
  `run-pipeline.test.ts` (`setReelStatus: false`).
- Studio: `exports.test.ts` (blocked reasons, link seconds never past expiry, view, key check, file name),
  `change-requests.test.ts` (`export of vN`), the mock route's `route.test.ts` (`Content-Disposition`).
- Storage: `r2.test.ts`, `fake.test.ts` (`downloadName`).

### Test Coverage

- `apps/worker/src/render/render-call.test.ts` (unit): catches a changed render flag (GPU mode, worker count, quality)
  or the render double turning on for anything but `"true"`.
- `apps/worker/src/render/render-step.test.ts` (unit): catches a render that writes the wrong key, skips the export row,
  re-renders on retry, or uses any page but the shared builder's.
- `apps/worker/src/pipeline/run-pipeline.test.ts` (unit, extended): catches a render job moving a processed reel's status.
- `apps/studio/src/lib/exports.test.ts` (unit): catches a link signed past `expires_at` (the signing refusal) and a
  wrong Export enablement.
- `packages/storage` and mock route tests (unit): catch a download link that plays instead of downloading.
- `apps/studio/db-tests/exports.test.ts` (DB): catches user B seeing A's exports, a render job for another reel's
  version, an `expires_at` other than 24 hours, an update of an export.
- `apps/studio/e2e/export.spec.ts` (E2E, CI too): Export creates a `render` job for the current version, the link
  appears after the worker's `once` without a reload, both events carry `reel_id`, and an expired export shows
  `expired, export again` with no link. Fails today: there is no Export button.
- `apps/worker/src/render/render.tools.test.ts` (tools, Mac): catches a quieter voice (over 0.5 LU), clicks off by
  more than 20 ms, and group sampling not reaching the render.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts` (tools, Mac): the guardrail, catches an export that differs
  from the preview (SSIM below the bound), proven sensitive by the 60 px negative probe.

### Edge Cases

- Export pressed twice quickly, or from a stale tab: the server action re-reads jobs and refuses while a render for the
  current version is queued or running.
- A change saved while a render is queued: the render still exports the version it named (`jobs.version_id`).
- The current version changes after an export: Export opens again for the new version; the latest export link stays
  until it expires.
- A retried render job after the export row was written: a hit, nothing rendered or uploaded again.
- A crash after upload but before the row: the retry uploads a new object under a new id; the orphan goes with the R2
  lifecycle rule.
- A rebuildable output deleted (cut-out): the pipeline rebuilds it before the render; the reel's status does not move.
- A version made from older fingerprints whose rebuildable file is gone: the step fails naming the missing key.
- Expiry while the page is open: the view switches to `expired, export again` at `expires_at`.
- One second left: the link is signed for 1 second; zero or negative: no link at all.
- A render job for a version of another reel, or without a version: refused by the policy and the check; the worker
  fails such a job.
- `PRODUCER_AUDIO_GAIN` set in the shell: dropped from the render's environment.
- An export row whose key is not under `exports/<reel_id>/`: the studio refuses to sign it.

## Acceptance Criteria

- Pressing Export on a processed reel with a current version inserts one `render` job with `version_id` equal to
  `reels.current_version_id` and sends `studio_export_requested` with `reel_id`; the button is disabled with a reason
  while that render is queued or running.
- The worker runs `hyperframes render <project> -o <tmp>.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr`
  with `HYPERFRAMES_NO_TELEMETRY=1` through the step runner with `sampleGroupMemory: true`, on a page built by
  `packages/edit`'s `build` and never stored.
- The MP4 lands at `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`, an `exports` row records it with
  `expires_at = created_at + 24 hours`, the job ends `done`, the reel stays `processed`, and the step line reads
  `render: exported, <duration>, <size>`.
- The reel page shows the download link without a reload; the link downloads an `.mp4` and is signed for at most the
  time left; clicking sends `studio_export_downloaded` with `reel_id`; after `expires_at` it shows
  `expired, export again` and no link.
- User B never sees A's exports; owners cannot write exports; exports are never updated.
- The guardrail scores every frame at or above the bound (0.95 unless tuned upward with recorded evidence, never below
  0.9) and the 60 px probe scores at least one frame below it.
- The export's integrated loudness is within 0.5 LU of the retimed source and the clicks land within 20 ms.
- The render step row's `peak_rss_bytes` comes from group sampling and exceeds the largest single process.
- All validation commands pass; no em-dashes; docs and profile updated.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: formatting over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: lint the changed workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: types (the worker and storage build check is typecheck).
- `yarn knip`: no unused files, exports or dependencies (the new Playwright config and folder are registered).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage`: unit tests, including the migration version guard.
- `.adw/supabase-stack reset`: applies the new migration to the ADW stack (the only allowed way in a run; on failure report the error and stop).
- `yarn turbo run test:db --filter=./apps/studio`: RLS, the render job policy and the `exports` table.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with no variables.
- `yarn workspace @edit-issebya/worker test:tools`: on the owner's Mac only, real HyperFrames: loudness, click times, group memory.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`: on the owner's Mac only, against the run's servers: the preview-matches-export guardrail and its negative proof.

## Notes

- **Conflict resolved in favour of the profile**: the issue says ADW runs `supabase migration up --local`; the profile's
  Protected and Tests sections forbid that command in a run and prescribe `.adw/supabase-stack reset` after adding a
  migration. The plan follows the profile. CI applies the migrations to its own fresh stack; the owner applies the
  migration to the hosted project after merge.
- **Range**: the fixture reel is 2.69 s long, so the guardrail renders it whole through the real job path (the issue's
  seconds 0 to 3); `--start 0 --end 3` is exercised by the worker tools test through `renderExport`'s `range`, which no
  production path passes.
- **Considered, not added**: `--no-best-effort` (fail on missing or unready media). The issue fixes the exact flags; the
  guardrail would catch black frames. Worth a follow-up decision.
- The page loads GSAP from jsdelivr, so the real render needs network on the worker's machine (as the preview frame
  does). The E2E spec never renders.
- The interim one-job-at-a-time rule (`changeBlockedReason`) now also holds a change while a render runs; the Export
  button follows only its own rule (a render for the same version), as the issue asks.
- No new dependency. ffmpeg (already required by the worker) does the frame extraction and `ssim` in the tools spec.
- Owner steps, not for the pipeline: the R2 lifecycle rule deleting `<prefix>exports/` objects 1 day after creation for
  `dev/` and the production prefix (R2 works in whole days; `expires_at` is what the owner sees, the rule is the
  backstop); applying the migration to the hosted project after merge; the manual acceptance against
  `rethink-work-02.mp4` and a platform draft upload.
- The pipeline does not verify the full-length render on the worker machine, the platforms' recompression or the R2
  lifecycle rule.
- Out of scope: render progress and time left (slice 15), deleting rebuildable files and the disk guard (slice 14),
  serverless or cloud rendering.
