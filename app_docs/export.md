# Export: render job, 24-hour download link, preview-matches-export guardrail

**Specifications:** [specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md](../specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md)

## Overview

The owner presses Export on a processed reel's page. The studio inserts a `render` job pinned to the
current version (`jobs.version_id`) and sends `studio_export_requested`. The worker makes sure the
version's full-size inputs exist, builds the page with the same `build()` the preview uses, renders
it with HyperFrames, uploads the MP4 and records an `exports` row that expires 24 hours after it is
made. The page shows the newest export's download link without a reload, then "expired, export
again" once it has expired.

## How it works

### Database

- `supabase/migrations/20261108090000_exports.sql`: `jobs_kind_check` adds `render`; the column
  `jobs.version_id uuid references versions (id)` with `jobs_version_check` (a version exactly when
  `kind = 'render'`); the insert grant `(reel_id, kind, request, restore_version_id, version_id)` to
  `authenticated`.
- `reel_has_active_job` now ignores render jobs: a render never moves the current version, so the
  interim ordering rule covers changes and restores only.
- `reel_has_active_render(p_reel_id, p_version_id)`: a new `security definer` SQL function
  (`search_path = ''`) that answers only for the caller's own reels. Execute is revoked from
  `public`, `anon` and `service_role` and granted to `authenticated`.
- The policy "jobs: owner queues a render of a version of own processed reel": own reel,
  `status = 'queued'`, reel `processed`, a version of the same reel, and no `queued` or `running`
  render of that version (one active render per version).
- Table `exports` (`id`, `reel_id`, `owner_id`, `job_id`, `version_id`, `r2_key` unique,
  `bytes > 0`, `created_at`, `expires_at`), index `exports_reel_idx` on `(reel_id, created_at)`.
  The trigger `exports_set_expiry` sets `expires_at = created_at + interval '24 hours'` on every
  insert or update, whatever the writer sends (a trigger, since a generated column cannot use
  `timestamptz + interval`, which is only stable).
- RLS on `exports`: all revoked from `anon` and `authenticated`, `select` granted back, and the
  owner `select` policy "exports: owner selects own". The table is in the `supabase_realtime`
  publication. Only the worker (secret key) writes `exports`.

### Worker

- `apps/worker/src/process-job.ts` routes `render` to `steps/render.ts`. Only a process job moves
  the reel's status: `finishJob` and `failJob` leave `reels.status` and `current_version_id` alone
  for a render.
- `steps/render-inputs.ts` (`ensureRenderInputs`): the two media inputs, the retimed `source.mp4`
  and the cut-out `subject.webm`, are `rebuildable`. Both stored: nothing runs. Either missing: the
  fixed steps up to `remove_background` rebuild them through `runPipeline({ moveReelStatus: false })`
  before the render step row, so the rebuild writes its own step rows first and `reels.status` never
  moves. They must come back under the fingerprints the version was made from, else the step fails
  with "render: the inputs of this version cannot be rebuilt (a step changed since it was made)".
- `steps/render-project.ts` (`writeRenderProject`): a temporary HyperFrames project in
  `<scratchDir>/render-<job id>/` (the built page unchanged as `index.html`, the full-size media
  under the names the page uses, the preset's fonts and click sounds from the edit package),
  removed at the end. The built page is never stored.
- `steps/render-args.ts`: the exact command
  `hyperframes render <project> -o <tmp>.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr --no-best-effort --quiet`,
  run with `HYPERFRAMES_NO_TELEMETRY=1` (`hyperframesEnv`). Why each flag:
  - `--quality delivery`: TikTok and Instagram recompress every upload, and a cleaner source keeps
    caption text and the cut-out's edges sharp after it;
  - `--workers 3 --no-browser-gpu`: three software workers are faster here than the GPU with one
    worker, and give the same frames on a cloud machine without a GPU;
  - `--sdr`: the preview and the platforms are SDR;
  - `--no-best-effort`: a missing font or an unready video fails the step instead of exporting a
    wrong frame;
  - `--quiet`: the step log keeps the errors, not a progress bar.

  `--start`/`--end` exist for the tools test only (`RenderRange`); no job carries a range.
  `exportKey` gives `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4`.

- `steps/render.ts`: one step `render` through the step runner with `sampleGroupMemory: true`
  (HyperFrames spawns Chrome processes) and a one-hour timeout. It uploads with put-if-absent and
  inserts the row through `export-store.ts` (`supabaseExportStore`; `expires_at` comes back from
  the database, never computed by the worker). The step line reads
  `render: exported, <duration>, <size>`. After a lost lease nothing is uploaded or recorded.
- Sound: the clicks stay the page's `<audio>` elements from the sound track. HyperFrames 0.8.222's
  `mixAudioTracksFlat` mixes them with the footage's sound (`amix ... normalize=0`, audio gain 1,
  `PRODUCER_AUDIO_GAIN` never set), so there is no ffmpeg remix and the voice keeps its level. The
  old setup's quieter render (-19.1 LUFS against -18.0, from `amix`'s default normalisation) is what
  this avoids; the tools test's loudness check is the proof.
- `src/fake-render.ts`: `E2E_MOCK_RENDER=true` (exactly) replaces the render call with a copy of
  `fixtures/export/render.mp4` (H.264 and AAC, about a second), so the E2E suite runs without
  Chrome. Anything but a render call is refused; a rebuild still runs the real tools.

### Studio

- `apps/studio/src/lib/exports.ts`: `EXPORT_COLUMNS` (no `r2_key`: the browser only ever sees a
  signed link), `latestExport`, `exportView` (expired from the exact instant of `expires_at`),
  `exportBlockedReason` with its messages "Export opens once processing has finished.", "No version
  to export yet." and "Exporting this version." (mirrors the render insert policy),
  `DOWNLOAD_URL_MAX_SECONDS = 3600`, `downloadSeconds` (the time left in whole seconds, capped at one
  hour, null once less than a second is left), `exportFileName` giving
  `reel-<first 8 of reel id>-<yyyymmdd-hhmm of created_at, UTC>.mp4`, and `signExportDownload`.
- `apps/studio/src/app/export-actions.ts`: `requestExport` inserts the render job of the reel's
  current version under the owner's session (RLS decides; answers `queued`, `no-version`,
  `signed-out` or `refused`), and `exportDownloadUrl` reads the row through RLS and signs the link,
  never past `expires_at`.
- `packages/storage`: `signDownload(key, { expiresInSeconds, fileName })` serves the file as an
  attachment under that name (`isDownloadName` checks the name, `attachmentDisposition` builds the
  header), in R2 and in the folder fake.
- `apps/studio/src/components/ExportPanel.tsx`: the Export button (disabled with the reason under
  `data-testid="export-blocked"`), "Queued: waiting for the worker" until the job arrives, the
  refused message, and the download link (`data-testid="export-download"`, "Download version N
  (size)", "available until" a time). One timeout at `expires_at` flips it to "expired, export
  again" (`data-testid="export-expired"`): no polling, no read. It sends `studio_export_requested`
  after a `queued` answer and `studio_export_downloaded` when the link is clicked, both with
  `reel_id`.
- `apps/studio/src/components/LiveReel.tsx` reads `exports` on open and follows it through the same
  Realtime channel, and renders `ExportPanel` with the newest export.

## How to Use

1. Open a processed reel's page and press Export.
2. Wait for the `render` step line (`render: exported, ...`); the download link appears without a
   reload.
3. Click the link within 24 hours. After that the page says "expired, export again"; press Export
   again for a new file.

## Configuration

- The worker's existing R2 and Supabase variables and `R2_KEY_PREFIX`. No new variable except
  `E2E_MOCK_RENDER`, set by `apps/studio/e2e/export.spec.ts` only.
- The owner's R2 lifecycle rule deletes `<prefix>exports/` after 1 day. Lifecycle rules count whole
  days, so it is a backstop; `expires_at` is the real limit.
- The render needs network: the built page loads GSAP `gsap@3.14.2` from `cdn.jsdelivr.net` (the
  preset names it), like the preview.

## Testing

- Unit: `apps/studio/src/lib/exports.test.ts`; `apps/worker/src/steps/render-args.test.ts`,
  `render-inputs.test.ts` and `render.test.ts`; `apps/worker/src/fake-render.test.ts`;
  `apps/worker/src/pipeline/run-pipeline.test.ts` (`moveReelStatus: false` never writes the
  reel's status); the `signDownload` tests in `packages/storage/src/`.
- DB: `apps/studio/db-tests/exports.test.ts` (the render policy, the check, the expiry trigger, the
  `exports` RLS) and the `exports` case in `realtime.test.ts`.
- E2E: `apps/studio/e2e/export.spec.ts` spawns the worker's `once` with `E2E_MOCK_RENDER=true`.
- Tools (`yarn workspace @edit-issebya/studio test:tools`, the owner's Mac only, real HyperFrames):
  `apps/studio/tools/preview-matches-export.spec.ts` compares the preview and the export at the
  same frame (the export's frame `round(t * fps)`, selected by index, the player seeked to its
  time) and at the export's own 1080x1920 raster (device scale 1080 / 384, the screenshot cut to
  the frame), and requires SSIM >= 0.92 on the whole frame and on the probed caption's region at
  0.5, 1.5 and 2.5 s; the negative proof (that caption moved 60 px, served through `page.route`,
  nothing stored) must fall below the bound on the lowest of those scores. The bound is 0.92, not
  0.95, because every text edge of the preview sits 1 to 1.5 frame px higher than the export's
  (the two Chromes' glyph rasterisation), which a caption region alone scores 0.93 to 0.97. It
  also checks loudness within 0.5 LU of the retimed source (mono measured as dual mono, as the
  stereo export plays it), clicks within 20 ms, and the render step's `peak_rss_bytes` above one
  Chrome process. The matching scores were whole 0.9926 / 0.9930 / 0.9949 and caption region
  0.9478 / 0.9690 / 0.9305, the probe's lowest 0.6853; the rest of the values are recorded in the
  spec's Notes.

## Rules

- Render only on export, never for the preview.
- Render in software mode with three workers at delivery quality; never a GPU mode.
- Use the same builder as the preview; the worker never edits the built page.
- Never store the built page.
- Never sign a download link past `expires_at`.
- A render never moves `reels.status` or `current_version_id`.
- Never hard-code a sound; the clicks come from the version's sound track.
- Do not grant the owner (`authenticated` or `anon`) any write on `exports`; only the worker
  inserts it.

## Notes

- The negative proof uses no stored version: a probe version would rewrite history (versions are
  never deleted) and making it current would move `current_version_id`.
- The range flags stay in `renderArgs` for a future partial render.
- Vendoring GSAP is out of scope.
- Owner steps: the R2 lifecycle rule for `dev/` and the production prefix, and applying the
  migration to the hosted project after merge.
- Out of scope: render progress and time left (slice 15), deleting rebuildable files (slice 14),
  cloud rendering.
