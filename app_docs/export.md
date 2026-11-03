# Export

**Specifications:**

- specs/issue-35-adw-1abe562e-sdlc_planner-export-render-job.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

Export is one action. The Export button on a reel's page queues a `render` job for the current
version and opens a modal that shows the render's live progress. When the render finishes, the MP4
downloads by itself and the modal closes. Nothing is kept or offered afterwards: exporting again
renders again. Closing the modal (Cancel, Escape or the close control) cancels the export. The
uploaded file is only a hand-over and is deleted 1 hour after it was made.

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
  (unique), `bytes` (above 0), `created_at`, `expires_at`. The `exports_before_insert` trigger
  takes `owner_id` from the reel and sets the expiry, whatever the insert passes; a check repeats
  the expiry. `exports_refuse_update` refuses every update, even the service role's. RLS:
  `exports: owner selects own` only, no insert policy (the worker writes with the secret key), no
  anon access. The table is in `supabase_realtime`.

`supabase/migrations/20261103164248_one_step_export.sql`:

- The hand-over file lives 1 hour: the trigger sets `expires_at = created_at + 1 hour` and the new
  `exports_expiry_check` repeats it. The check is added `not valid`, so it holds for every new row
  and rows made before keep their 24 hours.
- A new job status, `cancelled` (`jobs_status_check`: `queued`, `running`, `waiting_ai`, `done`,
  `failed`, `cancelled`).
- `cancel_job(p_job_id uuid) returns boolean`, `security definer`: locks the job row, then cancels
  it only when the caller owns the job and its reel, the job is a `render`, it is `queued`, `running`
  or `waiting_ai`, and no `exports` row records it. The job ends `cancelled` with `finished_at`, its
  lease and waiting columns cleared. Anything else returns false and changes nothing, never saying
  why. `authenticated` may execute it, `anon` never. The owner still has no update right on `jobs`:
  this function is the only way to cancel.
- The insert trigger locks the same job row (`for share`) and refuses an `exports` row for a
  cancelled job (`export refused: the job was cancelled`), even from the service role. Together with
  `cancel_job`'s own check, a render either finishes with its export or is cancelled without one,
  never both.
- `claim_job` is unchanged: it claims only `queued`, `waiting_ai` past its `not_before` and `running`
  with an expired lease, so a cancelled job is never claimed and holds no later job of its reel back.
- `discard_export_file(p_r2_key)` (service role only) marks deleted and returns an export file's
  `stored_files` row only while no `exports` row records the key (see Worker).

### Studio

- `requestExport` (`apps/studio/src/app/export-actions.ts`) reads the reel and its jobs under RLS,
  checks `exportBlockedReason` again and inserts `{ reel_id, kind: "render", version_id }` with the
  reel's `current_version_id`. The browser never picks the version.
- `exportBlockedReason` (`apps/studio/src/lib/exports.ts`) gives one of three reasons: `No version
to export yet.`, `Export opens once the reel is processed.`, or `Exporting this version...` while
  a render of the current version is queued or running. A change, or a render of an older version,
  does not hold the button.
- `loadExport(reelId, exportId)` reads that one export under RLS, checks its key is this reel's
  (`isExportKey`) and signs it with `signDownload(key, { expiresInSeconds: exportLinkSeconds(...),
downloadName: exportFileName(...) })`. The name is `reel-v<N>-<YYYYMMDD-HHMM>.mp4` in UTC and the
  link carries `Content-Disposition: attachment`. The seconds are measured again just before
  signing, so a link is never signed past `expires_at`; an expired export is never signed at all.
- `cancelExport(jobId)` calls `cancel_job` under the owner's session.
- `ExportPanel.tsx` shows only the button and its blocked reason. Pressing Export queues the job
  (`requestExport`, `studio_export_requested`) and opens a native `<dialog>`, "Exporting version N",
  that follows that job. What it shows comes from `exportModalState(jobId, jobs, steps,
latestExport)` (`apps/studio/src/lib/exports.ts`), a pure function of `LiveReel`'s Realtime state:
  - `waiting` before the render step runs (queued: `Waiting to start`; the pipeline's hits or a
    cut-out: `Getting ready`) and after it until the export row arrives (`Finishing`): an
    indeterminate bar;
  - `rendering`: the job's running `render` step, its live `steps.progress_percent` as the bar
    (`Rendering, N%`), 0 before the first write;
  - `ready`: the job's `exports` row arrived (Realtime INSERT): the modal calls `loadExport` once
    and starts the download at once with a programmatic anchor click, sends
    `studio_export_downloaded`, shows `Downloaded` with a `Download` link as the fallback for a
    browser that blocks a download no click started (it cannot be detected, so the link always
    shows), and closes after 4 seconds;
  - `failed`: `The export failed. Try again.` until the owner closes it; `cancelled`: closed.
- Cancel, Escape and the close control all close the modal; while the job is `waiting` or
  `rendering` they also call `cancelExport`. The modal closes at once and the job's row follows
  live; the panel returns to idle. Closing after the download changes nothing.
- A page opened while a render of the current version is live (`liveRenderJobId`) opens the modal
  for that job again, so it can still be followed or cancelled.
- `LiveReel.tsx` follows `exports` INSERTs for the reel over Realtime and keeps the newest export's
  `id` and `job_id` (read once on open and on each ready subscription). No polling.

### Worker

- `job-kinds.ts` dispatches `render` with its `version_id`; a render without one fails the job.
- `runRender` (`apps/worker/src/render/render-step.ts`): an export already recorded for the job is a
  hit (`export kept, reused`). Otherwise it runs the pipeline with `setReelStatus: false`, so every
  step is a hit or the missing rebuildable output is rebuilt, and the reel stays `processed`.
- Then, for a version with `behind` items, `ensureVersionCutouts`
  (`apps/worker/src/cutout/version-cutouts.ts`) makes sure every mask the version names is stored:
  all stored is a `cutout` hit (`cut-out reused`), a mask the slimming cleared is rebuilt in a
  measured `cutout` step under the same fingerprint and key (`app_docs/storage.md`).
- Then one measured `render` step through the step runner: it reads the version (it must belong to
  the job's reel), its edit, transcript and head track, and downloads the full-size footage, each
  mask in `inputs.masks` and the large copy of each library photo the `behind` track names (the
  owner's ready photos, `large_key` from the `photos` row; a photo no longer in the library fails
  the step with `render: photo <id> is no longer in the library`). `render-project.ts` places the
  masks and photos at the builder's paths (`maskPath`, `masks/<fingerprint>.mp4`, and `photoPath`,
  `photos/<id>.jpg`); an asset without its file throws. A stored version naming the old whole-clip
  cut-out builds without it, and it is never downloaded. It builds the page with `packages/edit`'s `build`, the same builder as the preview, never
  a worker copy and never stored, and `render-project.ts` writes `index.html` plus every asset the
  page names into a temporary project.
- The call (`render-call.ts`), with `sampleGroupMemory: true`:

  ```bash
  hyperframes render <project> -o <tmp>/export.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr
  ```

  with `HYPERFRAMES_NO_TELEMETRY=1` and every `PRODUCER_*` variable removed. Why
  (`RENDER_SETTINGS`): the platforms recompress every upload, so a `delivery` source keeps text
  edges sharper; software mode with three workers is faster on the
  worker's machine than the GPU mode with one, and runs without a graphics chip; `--sdr` because
  the platforms show SDR.

  The render also sets `HYPERFRAMES_EXTRACT_CACHE_DIR`, `HYPERFRAMES_HISTORY_ROOT` and `TMPDIR`
  inside the render's folder in the job scratch (`renderScratchEnv`), so removing the job folder
  takes the frame cache, the history and the work folders with it (`app_docs/storage.md`). The
  export write records its `export` row in `stored_files` through `recordingStorage`.

- Sound comes only from the edit's sound track, inside the page. HyperFrames mixes at unity gain
  (no `PRODUCER_AUDIO_GAIN`); the worker tools test measures the voice within 0.5 LU of the source
  and each click within 20 ms of its place on the track.
- Storage: `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4` (`export-key.ts`), written with
  `putFileIfAbsent`, then the `exports` row. The step log line reads
  `render: exported, <duration>, <size>`.

### Cancel

- A render job's lease keeper (`apps/worker/src/lease.ts`, `keepLease`) also runs one cheap check
  every `cancelCheckEveryMs` (5 seconds, `config.ts`): `jobCancelled` (`queue.ts`) reads only the
  job's `id`, filtered to `status = 'cancelled'`. No other kind runs the check. A cancel aborts the
  job's signal with a `JobCancelled` reason, exactly as a lost lease aborts it: the step runner
  kills the running tool's process group (`SIGTERM`, then `SIGKILL` after 5 seconds) and writes
  nothing more, and `runJob` returns `cancelled` and writes no job state (`cancel_job` already
  ended the job). The worker logs `job <id>: cancelled, leaving it`.
- `runRender` also checks at once (`ctx.checkCancelled`) after the pipeline's hits and cut-outs,
  so a cancel there stops the job before the render step starts, and again just before the upload.
- An MP4 uploaded but not recorded (the `exports` insert was refused for a cancelled job, or
  failed) is removed: `discard_export_file` marks its `stored_files` row deleted and the object is
  deleted from the raw storage (`supabaseDiscardExport` in `stored-files.ts`). This is the one
  removal the worker makes after a cancel; it never touches a recorded export. A refused insert
  for a cancelled job turns into the abort, so the step writes no `failed` row.
- A cancelled render's step rows keep what was written so far: the `render` row stays `running`
  with its last percent, as on any abort. The overlay and the modal show nothing for a cancelled
  job.

### Render double

`E2E_MOCK_RENDER` set to exactly `"true"` turns the call into
`/bin/cp fixtures/render/stub-export.mp4 <output>` through the same step runner. The stub was made
once with:

```bash
ffmpeg -f lavfi -i color=c=black:s=108x192:r=30:d=1 -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k -shortest -movflags +faststart fixtures/render/stub-export.mp4
```

## How to Use

1. Open a processed reel and press Export.
2. Watch the modal's progress. The MP4 downloads by itself when the render finishes, and the modal
   closes. If the browser blocked it, click `Download` in the modal while it shows.
3. To stop an export, press Cancel or Escape, or close the modal.
4. To have the file again, press Export again: it renders again.

## Configuration

- No new variable for production. `R2_KEY_PREFIX` decides where the export is stored.
- `E2E_MOCK_RENDER`: tests only. `apps/studio/test-support/worker.ts` sets it to `"true"` for every
  spec; the tools spec passes it empty to render for real.
- `FFMPEG_PATH` is honoured by `apps/studio/test-support/frames.ts`.
- The worker's slimming deletes an export's object once `expires_at` passes
  (`expire_export_files`, see `app_docs/storage.md`), 1 hour after it was made. The owner's R2
  lifecycle rule, which deletes `<prefix>exports/` objects 1 day after creation, stays as a
  backstop.
- `cancelCheckEveryMs` (5000) is fixed in `apps/worker/src/config.ts`, not a variable.

## Testing

- Unit (worker): `render-call.test.ts`, `render-project.test.ts`, `export-key.test.ts`,
  `render-step.test.ts` (under `apps/worker/src/render/`; a cancel during the render kills the
  render double's real child within seconds and leaves no export row and no object, a cancel
  before the render step stops before it, a refused insert discards the upload), `lease.test.ts`
  and `run-job.test.ts` (the cancel check and the `cancelled` outcome), `job-kinds.test.ts` and
  `pipeline/run-pipeline.test.ts` (`setReelStatus: false`).
- Unit (studio): `apps/studio/src/lib/exports.test.ts` (`exportModalState`, `exportCancellable`,
  `liveRenderJobId`), `change-requests.test.ts` (the `export of vN` label) and the storage mock's
  `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`.
- Unit (storage): `packages/storage/src/r2.test.ts` and `fake.test.ts` (the download name).
- DB: `apps/studio/db-tests/exports.test.ts` (the render job policy and the `exports` table, its
  1-hour expiry), `cancel-jobs.test.ts` (`cancel_job` on own queued and running renders, refusals,
  no `anon` execute, the refused export of a cancelled job, `claim_job` never taking a cancelled
  job) and `stored-files.test.ts` (`discard_export_file`).
- E2E: `apps/studio/e2e/export.spec.ts`: Export opens the modal, the bar rises with the render
  double (`E2E_MOCK_RENDER_SECONDS=25`), the download starts by itself with the
  `reel-v2-<YYYYMMDD-HHMM>.mp4` name and the modal closes; no download link or expiry in the panel
  before or after; Cancel during the render closes the modal, the job ends `cancelled`, no export
  row, no object, no download, and Export is open again; Escape while queued cancels a job the
  worker then never claims.
- Worker tools: `yarn workspace @edit-issebya/worker test:tools` (`render.tools.test.ts`: format,
  loudness, click times, group memory), on the owner's Mac only.

### Preview matches export guardrail

- Command: `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`), on the owner's Mac only, against the
  run's servers, never in CI.
- Acceptance: every guardrail frame, every frame of the photo behind the speaker (a library photo
  in the `top` spot over the whole speech, cut out with the real mask tool) and every frame of one
  big word behind the speaker (`WORK`, a second version over the same span, since the fixture's
  speech is too short for both in one version) scores at or above `PREVIEW_EXPORT_SSIM_BOUND`
  (0.9855), and each case's probe (a caption, or the photo, moved by 60 px) scores at least one
  frame below it.
- The bound started at 0.95 and was raised to 0.99 because the probe's minimum (0.982028) was above
  0.95, so the comparison was not proven sensitive. 0.99 sat between the probe minimum and the
  guardrail minimum (0.995609).
- The one-screen reel layout shrank the captured preview to 398x706 at the 1920x1080 viewport, and
  both score sets dropped (the guardrail minimum to 0.988583, below 0.99). The bound was lowered to
  0.982, near the middle of the new gap between the probe minimum (0.975669) and the guardrail
  minimum (0.988583). The bound must never go below 0.9.
- The photo behind the speaker first scored 0.937845, 0.949762 and 0.942838, below 0.982. The photo
  sat in the same place to the pixel in both, and the fixture footage is a flat colour (the mask
  cuts nothing out), so the composite and the render's mask frames were not the cause. Three things
  in the measurement were. The capture was the player element, which letterboxes the 9:16
  composition by a fraction of a pixel (at 376x666 the composition is 374.6 px wide), and the
  export frame was stretched to the element's shape, up to a pixel off at the far edge. ffmpeg's
  default yuv420p to RGB scale left a one-pixel ripple at every colour edge (a 4:2:0 round trip of
  one preview capture scored 0.988837 with the defaults, 0.994112 with `full_chroma_int` and
  `accurate_rnd`). And the sample photo's one-pixel steps between saturated colour bars cannot
  survive any 4:2:0 export (the same round trip of the bars scored at most 0.967306). The guardrail
  now captures the composition's own box, crops the export to the same area and scales it with full
  chroma, and the behind case uses the sample photo softened (Gaussian blur, sigma 8) and
  desaturated (0.6). Measured that way the caption probe's minimum (0.983808) was above 0.982, so
  the bound was raised to 0.9855, near the middle of the gap between the highest probe minimum
  (0.983808) and the lowest guardrail score (0.987437).
- The big word behind the speaker first scored 0.983279, 0.986733 and 0.986025, below 0.9855 at
  0.5 s. Its glyphs sat in the same place to the pixel, and the loss was luma, not chroma: over the
  word's box Y 0.929059, U 0.992416 and V 0.979932 at 0.5 s (0.935316, 0.996211, 0.98872 at 1.5 s),
  the rest of the frame 0.998 or more, and the preview's word about 3% brighter over its box. The
  preview rasterised the 400 px word at the player's scale (about 0.35) with the browser's text
  anti-aliasing, while the export rasterises it at 1080 px and the frame is scaled down by ffmpeg.
  The preview is now captured at device scale 3 (about the composition's own size) and scaled down
  to the captured box with the export frame's flags, for every case. The word's box then scored Y
  0.999684 at 0.5 s, and every case rose; the caption probe's minimum (0.983714) stayed below
  0.9855, so the bound stayed.

Measured scores (SSIM, live preview against the exported MP4), composition-box captures:

| Moment | Guardrail | 60 px probe | Photo behind | Photo behind probe | Big word behind |
| ------ | --------- | ----------- | ------------ | ------------------ | --------------- |
| 0.5 s  | 0.999225  | 0.999225    | 0.995645     | 0.920737           | 0.998661        |
| 1.5 s  | 0.999037  | 0.983714    | 0.99658      | 0.934469           | 0.999108        |
| 2.5 s  | 0.999345  | 0.99612     | 0.997241     | 0.922146           | 0.999378        |

The render step's `peak_rss_bytes` in the same run was 1546944512 (above 256 MB). The scores were
the same in every run.

Composition-box captures at device scale 1 (before the big word):

| Moment | Guardrail | 60 px probe | Photo behind | Photo behind probe |
| ------ | --------- | ----------- | ------------ | ------------------ |
| 0.5 s  | 0.998655  | 0.998655    | 0.987437     | 0.923527           |
| 1.5 s  | 0.998293  | 0.983808    | 0.991179     | 0.937396           |
| 2.5 s  | 0.998843  | 0.995779    | 0.99071      | 0.926636           |

One-screen layout, player-element captures (the 0.982 bound):

| Moment | Guardrail | 60 px probe |
| ------ | --------- | ----------- |
| 0.5 s  | 0.988583  | 0.988583    |
| 1.5 s  | 0.989767  | 0.975669    |
| 2.5 s  | 0.988849  | 0.985728    |

Before the one-screen layout (the 0.99 bound):

| Moment | Guardrail | 60 px probe |
| ------ | --------- | ----------- |
| 0.5 s  | 0.995673  | 0.995673    |
| 1.5 s  | 0.995609  | 0.982028    |
| 2.5 s  | 0.997499  | 0.994654    |

## Rules

- Never lower `PREVIEW_EXPORT_SSIM_BOUND` below 0.9, and never change it without re-measuring both
  score sets and recording them here.
- The guardrail compares the composition's own box, never the player element: the export frame is
  cropped to the captured area and scaled with `full_chroma_int` and `accurate_rnd`. The preview is
  captured at device scale 3 and scaled down to the captured box with the same flags, never compared
  as the browser rasterised it at the player's scale.
- Render only on export, never for the preview.
- Software mode with three workers at `delivery` quality; never `--gpu` or `--browser-gpu`.
- Use the same builder as the preview (`packages/edit`'s `build`); never a worker copy, never a
  stored page.
- Never sign a download link past `expires_at`.
- Never offer a finished export again (no download link, no expiry in the panel): exporting again
  renders again.
- Closing the export modal while its render is live always cancels it, only through `cancel_job`;
  never give the owner an update right on `jobs`.
- Never let `anon` execute `cancel_job`; only a `render` job can be cancelled.
- The worker writes nothing after a cancel, except removing its own unrecorded upload through
  `discard_export_file`; never record an export for a cancelled job.
- Sounds come only from the edit's sound track.
- Never write an `exports` row from the studio; only the worker does.
- Never turn the render double on unless `E2E_MOCK_RENDER` is exactly `"true"`.

## Notes

- Render progress and time left: see `app_docs/status.md`.
- Out of scope: cloud rendering.
- The pipeline does not verify a full-length render on the worker machine, the platforms'
  recompression or the R2 lifecycle rule.
- The page loads GSAP from jsdelivr, so a real render needs network.
- `--no-best-effort` was considered and not added.
- Owner steps: the R2 lifecycle rule for `dev/` and the production prefix; applying the migrations
  to the hosted project after merge (`20261103164248_one_step_export.sql` before deploying the
  worker and the studio that use it); the manual acceptance against `rethink-work-02.mp4` and a
  platform draft upload.
