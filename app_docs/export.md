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
to export yet`, `Export opens once the reel is processed`, or `Exporting this version...` while
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
  - `failed`: `The export failed. Try again` until the owner closes it; `cancelled`: closed.
- Cancel, Escape and the close control all close the modal; while the job is `waiting` or
  `rendering` they also call `cancelExport`. The modal closes at once and the job's row follows
  live; the panel returns to idle. Closing after the download changes nothing.
- A page opened while a render of the current version is live (`liveRenderJobId`) opens the modal
  for that job again, so it can still be followed or cancelled.
- `LiveReel.tsx` follows `exports` INSERTs for the reel over Realtime and keeps the newest export's
  `id` and `job_id` (read once on open and on each ready subscription). No polling.

### Worker

- `job-kinds.ts` dispatches `render` with its `version_id`; a render without one fails the job.
- The export's fonts are the version's own pair files: the render measures with `editMeasurer(edit.font_pair)`
  and the build copies that pair's font assets (`app_docs/font-pairs.md`).
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
  cut-out builds without it, and it is never downloaded. Every page the render uses comes from
  `packages/edit`'s `build`, the same builder as the preview, never a worker copy and never stored,
  and `render-project.ts` writes `index.html` plus every asset a page names into a temporary
  project.
- `renderVersion` (`render-step.ts`) then exports the version one of two ways. `renderRoute`
  (`render-route.ts`) picks: the composite (below) when it handles the version, else the single
  call. Both give a 1080x1920, 30 fps H.264 MP4 with AAC sound, encoded with the same settings.

### The route

`renderRoute` is a pure function of the settings, the edit and what ffprobe says of the footage and
of each mask (`parseMediaFacts`, `composite.ts`). It is asked twice: first with the edit alone
(nothing is probed for a version the edit already sends to the single call), then with the probed
files. A version goes to the composite unless one of these holds, checked in this order; the first
that holds is the reason, written to the trace as `render.route_reason`:

| Reason           | The version goes to the single call when                                            |
| ---------------- | ----------------------------------------------------------------------------------- |
| `setting`        | `WORKER_RENDER_PATH=single`                                                         |
| `footage_clips`  | the footage track has no clip, or more than one                                     |
| `footage_style`  | the footage clip has a `style`                                                      |
| `footage_hidden` | the footage clip has `hidden` spans                                                 |
| `footage_span`   | the footage clip does not run from 0 to the reel's end                              |
| `long_reel`      | the reel is 120 s or longer (`COMPOSITE_MAX_SECONDS`)                               |
| `footage_fps`    | the footage is not 30 fps at a constant rate, or its frame count is not in the file |
| `footage_format` | the footage is not 8-bit 4:2:0 (`yuv420p` or `yuvj420p`)                            |
| `no_audio`       | the footage has no sound stream                                                     |
| `mask_fps`       | a mask is not 30 fps at a constant rate, or its frame count is not in the file      |
| `mask_sizes`     | the masks differ in width, height or colour range                                   |

Why 120 s: from there on HyperFrames encodes the sound in segments whose cut points depend on the
padded length, so the sound page's packets may differ near the cuts. The sound's identity is not
verified there. Under the render double nothing is probed: only the edit's own rules are judged.

### The composite

The browser never draws the footage. HyperFrames renders small pages, and one ffmpeg pass decodes
the footage and the masks once, blends, and encodes.

1. `render.build`: the builder's layer pages (`build`'s `layer` option, `app_docs/edit-model.md`),
   each in a project folder of its own under the render's folder: `front/` (everything over the
   speaker), `sound/` (no picture: the footage as an `<audio>` element and the sound track) and,
   for a version with a cut-out span, `behind/` (the big words behind the speaker). The picture
   pages are transparent.
2. `render.encode`, the lanes (`runLanes`, `render-call.ts`), at the same time:
   - the front layer;
   - next to it the sound page, then its cut, then the behind layer (both pages are short, so at
     most three browsers are open at once);
   - in `match` mode, the footage's JPEG pass.

   A lane that fails aborts the others' processes at once, and the failure is thrown once every
   lane has ended.

   ```bash
   hyperframes render <dir>/front/project  -o <dir>/front/frames   --quality delivery --workers 2 --no-browser-gpu --sdr --format png-sequence
   hyperframes render <dir>/behind/project -o <dir>/behind/frames  --quality delivery --workers 1 --no-browser-gpu --sdr --format png-sequence
   hyperframes render <dir>/sound/project  -o <dir>/sound/sound.mp4 --quality delivery --workers 1 --no-browser-gpu --sdr --format mp4 --fps 1
   ```

   `LAYER_SETTINGS`: two front workers, not three. With three the tree's peak memory was at the
   single call's level (5.4 to 5.8 GB on the 7.75 GiB worker VM); with two it is 4.5 to 4.7 GB.
   Each call has its own frame cache and history (`renderScratchEnv` of its own folder) and its
   own Chrome `TMPDIR` (`withChromeTmp`).

3. The sound cut (`soundCutArgs`). The sound page is rendered at 1 fps (HyperFrames mixes the sound
   from the page's elements, whatever the frame rate), so HyperFrames pads its mix to a whole
   second: longer than the reel, but its first AAC packets are the same bytes as the single
   call's. The single call pads its mix to `frames / 30` seconds and keeps
   `ceil(samples / 1024) + 1` packets at 48 kHz, the last one shortened. The cut keeps the same
   count (`soundPackets`: 1533 for 980 frames) by stream copy and shortens the last packet with
   HyperFrames' own `setts` expression:

   ```bash
   ffmpeg -i <dir>/sound/sound.mp4 -map 0:a:0 -c copy -frames:a <packets> \
     -bsf:a "setts=duration='if(gte((PTS+DURATION)*TB,<frames/30>),round(<frames/30>/TB-PTS),DURATION)'" <dir>/sound.m4a
   ```

   Never cut by time (`-t`): that drops packets by timestamp and cannot shorten the last one.

4. `match` mode only, the footage's JPEG pass (`footageJpegArgs`): the footage through HyperFrames'
   own extraction chain (a bt601 full-range JPEG of every frame, `-q:v 2`) into one Motion JPEG
   file, `<dir>/footage.mkv`. The single call shows the footage through that JPEG, the browser and
   a second JPEG, about one level of noise on every frame; without this pass the composite's
   frames are cleaner than the single call's and score a hair lower against them.
5. The composite (`compositeArgs`, `compositeGraph`): one ffmpeg pass over the footage (its JPEG
   copy in `match` mode), the behind layer's frames, the masks (one concat-demuxer input,
   `masks.txt`, so they decode one after the other), the front layer's frames and the cut sound.
   Per pixel, in bt709 limited-range 4:2:0:

   ```
   inside a cut-out span:  frame = (footage with the behind layer over it) x (1 - mask) + footage x mask
   outside:                frame = footage
   then:                   the front layer over it
   ```

   This is the builder's cut-out composite a second time (`app_docs/edit-model.md`: the page does
   it in CSS with the inverted mask multiplied and the person added back). It is encoded with the
   single call's x264 settings (`-preset fast -crf 15 -bf 0 -threads 8`,
   `aq-mode=3:aq-strength=0.8:deblock=1,1`, bt709, 30 fps) and the cut sound is copied in.

The frames follow HyperFrames' own rules for a timed clip (`clipFrames`,
`packages/edit/src/span-frames.ts`): a clip is on output frames `ceil(start x 30)` to
`ceil(end x 30) - 1` and extracts `round(duration x 30)` of its own frames. A cut-out span on screen
one frame longer than it extracts (16.033 to 17.767 s: 53 frames, 52 extracted) shows its last
frame twice in the single call's export: the span's footage copy, person copy and masks all hold.
The composite reproduces that: it drops the footage frame the span never extracts so the frame
before fills its place, and holds the mask the same way. The footage clip itself holds its last
frame the same way when the footage is one frame short of the reel. The preview plays the real
footage and does not repeat the frame.

Modes (`WORKER_RENDER_MODE`):

- `match` (the default): steps 1 to 5. Every frame is within the guardrail's bound of the single
  call's export, and the sound is the same bytes.
- `clean`: no JPEG pass; the composite reads the footage straight from the decoder (range and size
  converted with bicubic). In the experiments it took about half the single call's CPU where
  `match` took two thirds, with a file 14 to 26 percent smaller, closer to the source footage than
  the single call's export is, and the same sound. Against the single call's export its mean SSIM is about 0.003 lower, and on one of three
  measured reels 12 frames scored 0.9844 to 0.9855, a hair under the bound. Not the default until
  the preview guardrail is measured on it.

Measured (worker image, 8 CPUs, 7.75 GiB VM, a busy Mac, one run each, 2026-11-12; CPU is user plus
system of the whole export, the peak is the largest resident memory of the whole process tree,
SSIM is every frame of the composite against the single call's export of the same run):

| Reel                                    | Way               | Wall s | CPU s | Tree peak MB | SSIM mean | SSIM min | Frames under 0.9855 | Sound      |
| --------------------------------------- | ----------------- | ------ | ----- | ------------ | --------- | -------- | ------------------- | ---------- |
| 32.6 s, 980 frames, 6 spans, 1080x1920  | single            | 126    | 679   | 5652         |           |          |                     |            |
|                                         | composite `match` | 80     | 389   | 4536         | 0.99377   | 0.99217  | 0                   | same bytes |
| 48.2 s, 1446 frames, 9 spans, 1080x1920 | single            | 162    | 885   | 5781         |           |          |                     |            |
|                                         | composite `match` | 111    | 544   | 4655         | 0.99227   | 0.98983  | 0                   | same bytes |
| 54.6 s, 1638 frames, 3 spans, 720x1280  | single            | 146    | 793   | 5523         |           |          |                     |            |
|                                         | composite `match` | 105    | 454   | 4569         | 0.99126   | 0.99059  | 0                   | same bytes |

Wall time is down 28 to 36 percent, CPU 39 to 43 percent, the peak about 1.1 GB. The single call
against itself (two runs of the same reel) scores 0.998 to 0.9996 mean and 0.990 to 0.994 min, the
ceiling for any way. Footage that is not the frame's size (the third reel) is scaled with ffmpeg's
bicubic, not Chrome's scaler.

### The single call

For a version the composite does not handle. One HyperFrames call screenshots every frame, the
footage included (`renderExport`, `render-call.ts`), with `sampleGroupMemory: true`:

```bash
hyperframes render <project> -o <tmp>/export.mp4 --quality delivery --workers 3 --no-browser-gpu --sdr
```

with the page built with no `layer` option (the preview's own page).

### Both ways

- Both ways run HyperFrames with `HYPERFRAMES_NO_TELEMETRY=1` and every `PRODUCER_*` variable
  removed (`renderEnv`). Why these settings (`RENDER_SETTINGS`): the platforms recompress every
  upload, so a `delivery` source keeps text edges sharper; software mode is faster on the worker's
  machine than the GPU mode with one worker, and runs without a graphics chip; `--sdr` because the
  platforms show SDR.
- Each call sets `HYPERFRAMES_EXTRACT_CACHE_DIR` and `HYPERFRAMES_HISTORY_ROOT` inside its own
  folder in the job scratch (`renderScratchEnv`: the render's folder for the single call, the
  layer's folder for a layer page), so removing the job folder takes the frame cache and the
  history with it (`app_docs/storage.md`). Chrome's `TMPDIR` is not there: it is a short folder of
  its own per call, `mkdtemp(join(tmpdir(), "hf-"))` (`/tmp` in the container), made by
  `withChromeTmp` around the call and removed after it, on success, failure and cancel alike.
  Why: Chrome listens on a Unix socket at `<TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket`,
  and a socket path holds at most 107 characters. Under the job scratch folder that path was 108
  characters and every export aborted before rendering. Frames and the MP4 stay in the render's
  folder: HyperFrames writes its frame chunks next to the output (`chunk-encode-*`, `.capture-*`).
  Chrome's profile (its disk cache included) is the one large thing that lands in the short folder,
  because HyperFrames creates it under `tmpdir()`; the container's `/tmp` must have room for it
  (up to three profiles at once for the composite).
- Sound comes only from the edit's sound track, inside the page (the full page for the single
  call, the sound page for the composite). HyperFrames mixes at unity gain
  (no `PRODUCER_AUDIO_GAIN`); the worker tools test measures the voice within 0.5 LU of the source
  and each click within 20 ms of its place on the track.
- The step's progress comes from every process (`app_docs/status.md`), its row sums their CPU, and
  its span says which way the render went (`render.path`, `render.mode` or `render.route_reason`;
  `app_docs/measurement.md`).
- The export write records its `export` row in `stored_files` through `recordingStorage`.
- Storage: `${R2_KEY_PREFIX}exports/<reel_id>/<export_id>.mp4` (`export-key.ts`), written with
  `putFileIfAbsent`, then the `exports` row. The step log line reads
  `render: exported, <duration>, <size>`.

### Cancel

- A cancel during the composite kills every process running then (up to two HyperFrames trees and
  an ffmpeg pass, each in its own process group), and the step settles only once all are gone; the
  render's folder (the layer folders, their PNG frames, the JPEG copy, the sound) is removed with
  it, and each Chrome folder by its `withChromeTmp`.
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

`E2E_MOCK_RENDER` set to exactly `"true"` turns every tool call of the render into the double's
process (`fake-render.ts`) through the same step runner, so no spec needs Chrome or ffmpeg. Nothing
is probed and the sound is not cut. The route judges the edit's own rules, so a spec's reel goes
the way a real one would:

- the single call: `fake-render <stub> <output>` prints the committed render sample's
  `@hf-progress` lines, then copies `fixtures/render/stub-export.mp4` to the output;
- the composite: one `fake-render layer <share> <output>` per layer page (the same lines, then a
  placeholder where the page's output goes) and one
  `fake-render ffmpeg <share> <frames> <stub> <output>` per ffmpeg pass (`frame=N` reports and
  `progress=end`, then the stub copied for the composite itself; `-` in the stub's place leaves a
  placeholder). The parts run in the real lanes, each over its share of `E2E_MOCK_RENDER_SECONDS`
  (`DOUBLE_SHARES`, `app_docs/status.md`), and a cancel kills them all.

The stub was made once with:

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

- `R2_KEY_PREFIX` decides where the export is stored.
- `WORKER_RENDER_PATH` (optional): `composite` (the default) or `single`, which sends every version
  to the single call. `WORKER_RENDER_MODE` (optional): `match` (the default) or `clean`
  (`renderSettings`, `render-route.ts`). Any other value fails the render step with a message that
  names the variable. Both are read by the worker when a render starts; neither is needed in an
  env file.
- `E2E_MOCK_RENDER`: tests only. `apps/studio/test-support/worker.ts` sets it to `"true"` for every
  spec; the tools spec passes it empty to render for real.
- `FFMPEG_PATH` is honoured by `apps/studio/test-support/frames.ts`.
- The worker's slimming deletes an export's object once `expires_at` passes
  (`expire_export_files`, see `app_docs/storage.md`), 1 hour after it was made. The owner's R2
  lifecycle rule, which deletes `<prefix>exports/` objects 1 day after creation, stays as a
  backstop.
- `cancelCheckEveryMs` (5000) is fixed in `apps/worker/src/config.ts`, not a variable.

## Testing

- Unit (worker), under `apps/worker/src/render/`: `render-route.test.ts` (the settings, and every
  reason a version goes to the single call, in order), `composite.test.ts` (the filter graph equal
  to the one measured on a real six-span reel, `clean` mode, scaled footage and masks, a reel with
  no cut-out, short and long masks, the sound cut's packet count and expression, the JPEG pass, the
  mask list, the probe), `render-call.test.ts` (the single call's and each layer's arguments and
  environment, the ffmpeg passes, `runLanes` stopping the other lanes on a failure, every part of
  the render double), `render-project.test.ts`, `export-key.test.ts` and `render-step.test.ts` (the
  composite by default and the single call by setting, by the edit and by the probe; the layer
  pages exactly as the builder makes them; the behind layer and the mask list; progress from every
  process; each page's own Chrome folder and scratch folders, all removed; a failed lane stopping
  the others; a cancel during the render killing every real child of the composite's double within
  seconds and leaving no export row, no object and an empty scratch folder; a cancel before the
  render step stopping before it; a refused insert discarding the upload).
  `packages/edit/src/build-layers.test.ts` and `span-frames.test.ts` cover the layer pages and the
  frame rules. `step-runner.test.ts` covers a call's own abort signal. `lease.test.ts`
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
- Worker tools: `yarn workspace @edit-issebya/worker test:tools` (`render.tools.test.ts`: the
  single call's format, loudness, click times, group memory), on the owner's Mac only.

### Composite matches single call (machine check)

- Command: `yarn workspace @edit-issebya/worker test:tools`
  (`apps/worker/src/render/render-compare.tools.test.ts`), on the owner's Mac only (real
  HyperFrames, Chrome, ffmpeg and the MODNet mask tool), never in CI. No database, no storage.
- It exports each of two fixture reels both ways through the step runner (`renderVersion`, the
  single call and the composite in `match` mode) and compares the two MP4s:
  - the short speech (2.69 s) with captions and two clicks on the sound track; its footage has 80
    frames for 81 output frames, so the last frame is one the footage clip holds;
  - the ten-second speech (9.4 s, a person talking) with two big words behind her, so two cut-out
    spans, each with its real MODNet mask: the ffmpeg blend against the page's CSS blend at the
    person's edge over the words.
- Acceptance, for each reel: both files are 1080x1920 H.264 at 30 fps with the reel's frame count
  (`reelFrames`); the container's length, the streams' lengths and their frame counts are equal;
  every frame of the composite scores at or above 0.9855 (SSIM, ffmpeg's `ssim`, against the same
  frame of the single call's export; the bound is the guardrail's below); the decoded sound is
  identical sample for sample, and so are the stored AAC packets.
- It also checks the composite's progress (rising, ending at 100), its measurements, that no Chrome
  folder is left, and that `clean` mode gives the same frame count and the same sound (its frames
  are not held to the bound; its minimum must stay above 0.97).
- Measured 2026-11-12 on the owner's Mac: the short speech's 81 frames scored 0.99948
  mean and 0.99946 min; the ten-second speech's 283 frames 0.99037 mean and 0.98948 min (frame
  120); no frame of either under the bound; the sound identical in both. `clean` on the short
  speech: 0.99988 mean, 0.99986 min, the same sound.
- A HyperFrames update can change the clip frame rules, the sound packet rule or the x264 settings
  this path copies. This test is what catches it: run it after every HyperFrames version change.

### Preview matches export guardrail

- Command: `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`), on the owner's Mac only, against the
  run's servers, never in CI.
- Acceptance (the question's case is described below): every guardrail frame, every frame of the photo behind the speaker (a library photo
  in the `top` spot over the whole speech, cut out with the real MODNet mask tool, its model committed
  at `apps/worker/models/`) and every frame of one
  big word behind the speaker (`WORK`, a second version over the same span, since the fixture's
  speech is too short for both in one version) scores at or above `PREVIEW_EXPORT_SSIM_BOUND`
  (0.9855), and each case's probe (a caption, or the photo, moved by 60 px) scores at least one
  frame below it.
- A QUESTION (`app_docs/edit-model.md`, "The question's look") is a version of its own: "test clip
  for the real studio?" (w0005 to w0010) placed by the layout engine. It is compared twice
  mid-reveal, in the two longest waits between two of its words (one word on screen, then five), and
  once at its end (the whole question with its mark, halfway from its last word to its out-fade); the
  moments come from the version's own word times (`questionReveal`). Before each capture the spec
  reads the words on screen in the preview and expects exactly the words spoken so far. Its probe:
  the export's whole question against the preview with one word must score below the bound, so the
  comparison is proven to see which words are on screen. Measured 2026-11-16 (the composite): 0.995875
  at 1.07 s, 0.993852 at 1.9 s, 0.993295 at 2.25 s; the probe 0.955294. In the same run the guardrail
  scored 0.993226, 0.995332 and 0.996493, its 60 px probe 0.993226, 0.971395 and 0.996492, the visual
  0.991497, 0.994721 and 0.996376, the big word 0.991366, 0.994109 and 0.993578. The bound is unchanged.
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
- The big word is compared at moments taken from its own placed span (one third and two thirds
  into it, and halfway from its end to the reel's end), never at the span's end. In the export an
  item ends exclusively at its end frame: it shows up to that frame and not on it, while the
  preview seeked to exactly the end may still show it. That is a one-frame edge, not a mismatch
  (sampled at 1.5 s, the exact end of the engine's word, the case scored 0.902318).

Measured scores (SSIM, live preview against the exported MP4), composition-box captures:

| Moment | Guardrail | 60 px probe | Photo behind | Photo behind probe | Big word behind |
| ------ | --------- | ----------- | ------------ | ------------------ | --------------- |
| 0.5 s  | 0.999225  | 0.999225    | 0.995645     | 0.920737           | 0.998661        |
| 1.5 s  | 0.999037  | 0.983714    | 0.99658      | 0.934469           | 0.999108        |
| 2.5 s  | 0.999345  | 0.99612     | 0.997241     | 0.922146           | 0.999378        |

The render step's `peak_rss_bytes` in the same run was 1546944512 (above 256 MB). The scores were
the same in every run.

The owner's moves (`app_docs/owner-edits.md`) have their own case, `a moved and a resized component
match between preview and export`: the guardrail's version with its hook resized (110 px to 77 px)
and moved 400 px down and its LIST moved 120 px, saved by a real `owner_edit` job, then exported and
compared with its own preview at the guardrail's moments and bound. Its proof that the comparison
sees the moves: the same export against the previews of the version before the moves must fall
below the bound. Measured 2026-11-16 (the composite): 0.992532, 0.995585 and 0.995803 at 0.5, 1.5
and 2.5 s; against the version before the moves 0.915802, 0.901661 and 0.919066. In the same run the
guardrail scored 0.993226, 0.995332 and 0.996493. The bound is unchanged.

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
- Software mode at `delivery` quality; never `--gpu` or `--browser-gpu`. The single call takes three
  workers; the composite's front layer two, its behind layer and sound page one each. Never raise
  the composite's workers without measuring the tree's peak memory on the worker VM.
- An export is the composite or the single call, picked by `renderRoute` alone, a pure function.
  Never send a version to the composite outside it, and never loosen one of its reasons without
  the machine check passing on a reel of that kind. A new kind of edit the composite cannot draw
  (anything that changes the footage's own picture or timing) gets a reason there in the same
  change.
- The composite's default mode is `match`. Never make `clean` the default before the preview
  guardrail below is measured on it and its scores are recorded here.
- The composite must stay the single call's export to the machine: every frame at or above 0.9855
  against it, the same frame count and length, the same decoded sound. Never change `composite.ts`,
  `span-frames.ts`, the layer pages or a layer's HyperFrames arguments without running
  `render-compare.tools.test.ts`.
- The cut-out blend exists twice, in the builder's page and in `compositeGraph`. Never change one
  without the other.
- The composite's sound is the sound page's own AAC packets, cut by count with HyperFrames' `setts`
  expression. Never re-encode it, and never cut it by time.
- Every process a render starts runs through the step runner's `tool`, in its own process group,
  and every file it writes is under the render's folder or a `withChromeTmp` folder. Never spawn
  one another way: a cancel must kill them all and leave nothing.
- A question's moments in the guardrail are taken inside a wait between two of its words, never on a
  word's own moment: a word cuts in on one frame, and a capture on that frame's edge measures the
  frame clock, not the picture.
- Use the same builder as the preview (`packages/edit`'s `build`) for every page, the composite's
  layer pages included; never a worker copy, never a stored page.
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
- Chrome's TMPDIR must stay short (socket path limit): never point it into the job scratch folder
  or the render's folder; it is the `withChromeTmp` folder, removed after each render call.

## Notes

- Render progress and time left: see `app_docs/status.md`.
- Out of scope: cloud rendering.
- The pipeline does not verify a full-length render on the worker machine, the platforms'
  recompression or the R2 lifecycle rule.
- The page loads GSAP from jsdelivr, so a real render needs network.
- `--no-best-effort` was considered and not added.
- The composite came from four rounds of measured experiments (2026-11). Not built, on purpose:
  streaming the layers' frames into the composite while they render (HyperFrames writes a PNG
  sequence into its output folder only at the end; its capture folder is not a public interface).
  Not yet measured: the preview guardrail on the composite (it runs on it by default now, since the
  spec's real render takes the worker's default path; its scores above are the single call's and
  must be measured again before the bound is touched), `clean` mode against the preview, a reel of
  120 s or more, the front layer rendered in two halves, and an idle-machine timing run.
- The repeated last frame of some cut-out spans is a small defect of the single call's export that
  the composite reproduces to match it. Whether to keep it or show the true frame (as the preview
  does) is the owner's decision.
- Owner steps: the R2 lifecycle rule for `dev/` and the production prefix; applying the migrations
  to the hosted project after merge (`20261103164248_one_step_export.sql` before deploying the
  worker and the studio that use it); the manual acceptance against `rethink-work-02.mp4` and a
  platform draft upload.
