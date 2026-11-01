# Export

## Overview

The Export button on a reel's page renders the current version to an MP4 through a `render` job.
The owner downloads the file through a 24-hour link.

## How it works

### Database

`supabase/migrations/20261101194557_export_render_jobs.sql`:

- `render` joins `jobs_kind_check` (`process`, `change`, `restore`, `render`). `jobs.version_id`
  names a version of the same reel (foreign key on `(version_id, reel_id)`), and
  `jobs_version_check` requires it exactly for `render` and refuses it for every other kind.
- `grant insert (version_id)` and the policy `jobs: owner inserts a render job for own reel`: the
  owner from the session, `status = 'queued'`, `kind = 'render'`, the caller's reel and a version
  of that reel.
- The `exports` table: `id`, `reel_id`, `owner_id`, `job_id` (unique), `version_id`, `r2_key`
  (unique), `bytes` (above 0), `created_at`, `expires_at`. The `exports_before_insert` trigger sets
  `expires_at = created_at + 24 hours` and takes `owner_id` from the reel, whatever the insert
  passes; a check repeats the expiry. `exports_refuse_update` refuses every update, even the
  service role's. RLS: `exports: owner selects own` only, no insert policy (the worker writes with
  the secret key), no anon access. The table is in `supabase_realtime`.

### Studio

- `requestExport` (`apps/studio/src/app/export-actions.ts`) reads the reel and its jobs under RLS,
  checks `exportBlockedReason` again and inserts `{ reel_id, kind: "render", version_id }` with the
  reel's `current_version_id`. The browser never picks the version.
- `exportBlockedReason` (`apps/studio/src/lib/exports.ts`) gives one of three reasons: `No version
to export yet.`, `Export opens once the reel is processed.`, or `Exporting this version...` while
  a render of the current version is queued or running. A change, or a render of an older version,
  does not hold the button.
- `loadLatestExport` reads the newest export, checks its key is this reel's (`isExportKey`) and
  signs it with `signDownload(key, { expiresInSeconds: exportLinkSeconds(...), downloadName:
exportFileName(...) })`. The name is `reel-v<N>-<YYYYMMDD-HHMM>.mp4` in UTC and the link carries
  `Content-Disposition: attachment`. The seconds are measured again just before signing, so a link
  is never signed past `expires_at`; an expired export is never signed at all.
- `ExportPanel.tsx` shows the button, the reason beside it, `Download version N (<size>)` and
  `expires <time>`, and switches to `expired, export again` by one timeout at the expiry, with no
  network. `LiveReel.tsx` follows `exports` INSERTs for the reel over Realtime.

### Worker

- `job-kinds.ts` dispatches `render` with its `version_id`; a render without one fails the job.
- `runRender` (`apps/worker/src/render/render-step.ts`): an export already recorded for the job is a
  hit (`export kept, reused`). Otherwise it runs the pipeline with `setReelStatus: false`, so every
  step is a hit or the missing rebuildable output is rebuilt, and the reel stays `processed`.
- Then one measured `render` step through the step runner: it reads the version (it must belong to
  the job's reel), its edit, transcript and head track, and downloads the full-size footage and
  cut-out. It builds the page with `packages/edit`'s `build`, the same builder as the preview, never
  a worker copy and never stored, and `render-project.ts` writes `index.html` plus every asset the
  page names into a temporary project.
- The call (`render-call.ts`), with `sampleGroupMemory: true`:

  ```bash
  hyperframes render <project> -o <tmp>/export.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr
  ```

  with `HYPERFRAMES_NO_TELEMETRY=1` and every `PRODUCER_*` variable removed. Why
  (`RENDER_SETTINGS`): the platforms recompress every upload, so a `delivery` source keeps text
  edges and the cut-out's outline sharper; software mode with three workers is faster on the
  worker's machine than the GPU mode with one, and runs without a graphics chip; `--sdr` because
  the platforms show SDR.

- Sound comes only from the edit's sound track, inside the page. HyperFrames mixes at unity gain
  (no `PRODUCER_AUDIO_GAIN`); the worker tools test measures the voice within 0.5 LU of the source
  and each click within 20 ms of its place on the track.
- Storage: `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4` (`export-key.ts`), written with
  `putFileIfAbsent`, then the `exports` row. The step log line reads
  `render: exported, <duration>, <size>`.

### Render double

`E2E_MOCK_RENDER` set to exactly `"true"` turns the call into
`/bin/cp fixtures/render/stub-export.mp4 <output>` through the same step runner. The stub was made
once with:

```bash
ffmpeg -f lavfi -i color=c=black:s=108x192:r=30:d=1 -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -movflags +faststart fixtures/render/stub-export.mp4
```

## How to Use

1. Open a processed reel and press Export.
2. Wait for the step log's `render` line.
3. Click `Download version N (...)` within 24 hours. After that the panel reads
   `expired, export again`: press Export again.

## Configuration

- No new variable for production. `R2_KEY_PREFIX` decides where the export is stored.
- `E2E_MOCK_RENDER`: tests only. `apps/studio/test-support/worker.ts` sets it to `"true"` for every
  spec; the tools spec passes it empty to render for real.
- `FFMPEG_PATH` is honoured by `apps/studio/test-support/frames.ts`.
- The owner's R2 lifecycle rule deletes `<prefix>exports/` objects 1 day after creation. It is a
  backstop: `expires_at` is what the owner sees.

## Testing

- Unit (worker): `render-call.test.ts`, `render-project.test.ts`, `export-key.test.ts`,
  `render-step.test.ts` (under `apps/worker/src/render/`), `job-kinds.test.ts` and
  `pipeline/run-pipeline.test.ts` (`setReelStatus: false`).
- Unit (studio): `apps/studio/src/lib/exports.test.ts`, `change-requests.test.ts` (the
  `export of vN` label) and the storage mock's
  `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`.
- Unit (storage): `packages/storage/src/r2.test.ts` and `fake.test.ts` (the download name).
- DB: `apps/studio/db-tests/exports.test.ts`, the render job policy and the `exports` table.
- E2E: `apps/studio/e2e/export.spec.ts`, the stubbed render, the download and the expiry.
- Worker tools: `yarn workspace @edit-issebya/worker test:tools` (`render.tools.test.ts`: format,
  loudness, click times, group memory), on the owner's Mac only.

### Preview matches export guardrail

- Command: `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`), on the owner's Mac only, against the
  run's servers, never in CI.
- Acceptance: every guardrail frame scores at or above `PREVIEW_EXPORT_SSIM_BOUND` (0.99), and the
  probe (a caption moved by 60 px) scores at least one frame below it.
- The bound started at 0.95 and was raised to 0.99 because the probe's minimum (0.982028) was above
  0.95, so the comparison was not proven sensitive. 0.99 sits between the probe minimum and the
  guardrail minimum (0.995609). The bound must never go below 0.9.

Measured scores (SSIM, live preview against the exported MP4):

| Moment | Guardrail | 60 px probe |
| ------ | --------- | ----------- |
| 0.5 s  | 0.995673  | 0.995673    |
| 1.5 s  | 0.995609  | 0.982028    |
| 2.5 s  | 0.997499  | 0.994654    |

The render step's `peak_rss_bytes` in the same run was 1583153152 (above 256 MB).

## Rules

- Never lower `PREVIEW_EXPORT_SSIM_BOUND` below 0.9, and never change it without re-measuring both
  score sets and recording them here.
- Render only on export, never for the preview.
- Software mode with three workers at `delivery` quality; never `--gpu` or `--browser-gpu`.
- Use the same builder as the preview (`packages/edit`'s `build`); never a worker copy, never a
  stored page.
- Never sign a download link past `expires_at`.
- Sounds come only from the edit's sound track.
- Never write an `exports` row from the studio; only the worker does.
- Never turn the render double on unless `E2E_MOCK_RENDER` is exactly `"true"`.

## Notes

- Out of scope: render progress and time left, deleting rebuildable files and the disk guard,
  cloud rendering.
- The pipeline does not verify a full-length render on the worker machine, the platforms'
  recompression or the R2 lifecycle rule.
- The page loads GSAP from jsdelivr, so a real render needs network.
- `--no-best-effort` was considered and not added.
- Owner steps: the R2 lifecycle rule for `dev/` and the production prefix; applying the migration
  to the hosted project after merge; the manual acceptance against `rethink-work-02.mp4` and a
  platform draft upload.
