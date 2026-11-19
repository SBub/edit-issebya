# Export

**Specifications:**

- specs/issue-35-adw-1abe562e-sdlc_planner-export-render-job.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

Export never blocks the studio. The Export button on a reel's page queues a `render` job for the
current version, and the page shows its progress in place (`Exporting… 40%`) with a Cancel button:
no dialog opens. The owner may leave the reel, open other reels, use the photo library or upload a
new reel; the export keeps going. Only Cancel stops it. While a reel exports, editing that reel is
off (other reels are not held) and the page says why. Nothing in the reel page's header moves or
changes size at any moment of an export: Export, the progress with Cancel, `Downloaded` and the
Download button all sit inside one slot of a fixed size. The finished MP4 is kept for 48 hours, and
only the newest one of a reel: a Download icon beside the bin in the reels list and a Download
button on the reel's page give it for as long as it is kept. If the owner is still on the reel's
page when the render finishes, the file also downloads by itself; anywhere else nothing pops up.
There are no notifications of any kind. The worker runs exports in a lane of their own, so an
upload or a photo never waits behind one (`app_docs/studio.md`, "Worker").

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

- The file lived 1 hour (`exports_expiry_check`, added `not valid`). Replaced by the 48 hours
  below.
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

`supabase/migrations/20261118151744_export_kept_48_hours.sql`:

- `export_keep_interval()` returns `interval '48 hours'`: the one named setting for how long an
  export's file is kept. The insert trigger sets `expires_at = created_at + export_keep_interval()`,
  whatever the insert passes. To change the time, replace the function in a new migration; rows
  already made keep the expiry they were given. Only `service_role` may execute it.
- `exports_expiry_check` no longer repeats the value: it only requires `expires_at > created_at`.
- One kept export per reel, the newest. `expire_export_files` returns the file of an export whose
  `expires_at` has passed and also the file of an export that a newer export of the same reel
  replaced (newer by `(created_at, id)`), so the slimming removes a replaced file on its next
  pass. The `exports` rows stay.

### Studio

- `requestExport` (`apps/studio/src/app/export-actions.ts`) reads the reel and its jobs under RLS,
  checks `exportBlockedReason` again and inserts `{ reel_id, kind: "render", version_id }` with the
  reel's `current_version_id`. The browser never picks the version.
- `apps/studio/src/lib/exports.ts` holds the state logic, all pure functions of `LiveReel`'s
  Realtime rows:
  - `liveRenderJobId(jobs)`: the reel's export in progress, its newest `render` job that is
    `queued`, `running` or `waiting_ai`, whatever version it exports.
  - `exportBlockedReason`: `No version to export yet`, `Export opens once the reel is processed`,
    or `This reel is already exporting` while one is live. One export of a reel at a time.
  - `exportingReason(jobs)`: `Editing is off while this reel exports. Cancel the export to edit
now` (`EDITING_OFF_WHILE_EXPORTING`) while an export is live, else null.
  - `exportProgress(jobId, jobs, steps, latestExport)`: `waiting` before the render step runs
    (`waiting to start` while queued, `getting ready` during the pipeline's hits or a cut-out) and
    after it until the export row arrives (`finishing`); `rendering` with the running `render`
    step's live `steps.progress_percent` (0 before the first write); `ready` once the job's
    `exports` row arrived; `failed`; `cancelled`.
  - `exportRunning(progress)`: `waiting` or `rendering`. `EXPORTING_LEAD` (`Exporting…`)
    and `exportProgressDetail` (`40%` or `waiting to start`) make the header's one line,
    `Exporting… 40%` or `Exporting… waiting to start`.
  - `keptExports(rows, now)`: per reel, its newest export while `expires_at` has not passed. This
    is the one definition of "a reel has a kept export".
- `ExportPanel.tsx` (the reel page's header) is one slot of a fixed size: 32 px tall (`h-8`) and
  216 px wide (`w-[13.5rem]`), 384 px from `sm` up (`sm:w-[24rem]`), `flex-none`. Everything it
  shows is laid out inside that box from its right edge, so the title beside it, the header and the
  page under the header are the same at every state. It has two states, `data-export-state`:
  - `idle`: the Export button and, left of it while the reel has a kept export, the Download
    button (`DownloadExportButton`): 32 px tall, 128 px wide with the words `Download vN` (N the
    version the export holds) from `sm` up, a 32 px square with the Download icon on a phone (its
    accessible name is still `Download vN`).
  - `exporting`: Cancel in exactly the Export button's box (`ACTION_BOX`: 32 px tall, 72 px wide,
    80 px from `sm` up, for both) and, left of it, the line `Exporting… 40%` with a thin bar tight
    under it (indeterminate until the render step runs). The line and the bar have one fixed width
    (112 px, 192 px from `sm` up), the text starts at the left edge and the digits are
    `tabular-nums`, so `waiting to start`, `0%` and `100%` leave both where they are. Below `sm`
    the word `Exporting…` is only read out (`sr-only`), so a phone shows the percent (or what the
    export waits for), the bar and Cancel. The Export and Download buttons are not shown.

  The notes (`export-notes`) take the room left at the slot's left edge in both states: why Export
  is closed (`export-blocked-reason`), `Downloaded` or a failure (`export-message`) and what a
  click on Download had to say (`export-download-status`). They are small text clipped to the
  slot's two lines (`line-clamp-2`), with the full words as each note's `title`; a note never makes
  the slot or the header larger. The room is 152 px beside Download and 88 px beside the progress
  from `sm` up; on a phone 96 px beside Download and close to none beside the progress (the note is
  still read out).

  The words `You can leave this page, the export keeps going` (`LEAVE_WHILE_EXPORTING`) are not in the
  header: `LiveReel` hands them to `VersionList` as `notice`, and the Versions column's status
  line (`#versions-status`) reads `You can leave this page, the export keeps going. Editing is
off while this reel exports. Cancel the export to edit now` while the reel exports. The status
  line in the header carries the same words as its `title`.

  The panel follows one job: the one Export queued here, or a live one found when the page opens
  or started in another tab. Leaving the page does nothing to the job. Opening the page again
  during the export shows the same state, with Cancel.

- Cancel calls `cancelExport(jobId)`, which calls `cancel_job` under the owner's session. Nothing
  else cancels: not leaving, not closing the tab, not Escape.
- Editing off. `changeBlockedReason(reel, jobs)` (`lib/change-requests.ts`) returns
  `exportingReason(jobs)` after the reel's own reasons, so going back, Start over and the font pair
  picker are disabled with that line (the versions panel shows it under the list, the buttons in
  their `title`). `ReelPreview` gets the same line as `editBlockedReason`: `Move text` cannot be
  opened, and an editor already open is frozen (no drag, no Save, no Cancel) with the line in its
  status, keeping its draft until the export ends. The server checks it too: `openReel` in
  `change-actions.ts` reads the reel's live render jobs and answers `blocked`, so a stale tab
  cannot queue an edit. Why editing is off and not only queued: the reel's jobs run one at a time
  in order, so an edit could only sit behind the export, and the page would show an edit that is
  not in the file being rendered. Playing the preview, the photo library, uploads and every other
  reel stay on.
- `loadExport(reelId, exportId)` reads that one export under RLS, checks its key is this reel's
  (`isExportKey`) and signs it with `signDownload(key, { expiresInSeconds: exportLinkSeconds(...),
downloadName: exportFileName(...) })`. The name is `reel-v<N>-<YYYYMMDD-HHMM>.mp4` in UTC and the
  link carries `Content-Disposition: attachment`. A link is made at the click that uses it and
  lives the seconds left until `expires_at`, an hour at most; the seconds are measured again just
  before signing, so a link is never signed past `expires_at`, and an expired export is never
  signed at all.
- `DownloadExportButton.tsx`: Download as an icon (`variant="icon"`, the reels list, accessible
  name `Download the export`) or a button of a fixed size (the reel's page). One click calls
  `loadExport` and starts the download with a programmatic anchor click
  (`studio_export_downloaded`). An export that expired meanwhile says `This export is no longer
kept. Export again` and the page refreshes, which takes the control away; a failure says `The
file could not be fetched. Try again`. The reel page's button shows no words of its own: it hands
  them to `ExportPanel` (`onProblem`), which shows them in the slot's notes.
- The reels list (`apps/studio/src/app/page.tsx`) reads the owner's exports with `expires_at` in
  the future (RLS: only their own) and gives each reel in `keptExports` a Download icon left of
  the bin (`ThumbnailGrid`'s `corner`, `cornerControls: 2`). `ExportsWatcher.tsx` follows `exports`
  INSERTs over Realtime and reads the list again (`router.refresh()`, once more when the
  subscription is ready), so the icon appears without a reload. It shows nothing itself.
- The download by itself: when the job the reel's page follows becomes `ready` while the page is
  open, `ExportPanel` calls the same download once and shows `Downloaded` in the slot's notes. A
  browser may block a download no click started; the `Download vN` button beside it is the way to
  the file then. A page opened after the export finished downloads nothing by itself.
- `LiveReel.tsx` follows `exports` INSERTs for the reel over Realtime and keeps the reel's kept
  export (`EXPORT_REF_COLUMNS`, read once on open and on each ready subscription, `expires_at` in
  the future). No polling.
- A failed export shows `The export failed. Try again` in the slot's notes, and the progress
  overlay's failure card (`app_docs/status.md`).

#### The replace rule

One kept export per reel: the newest. A newer export of the same reel replaces the older one, even
when it exports another version. The studio only ever offers the newest (`keptExports`, and the
reel page's query), and the worker's slimming deletes the replaced file on its next pass
(`expire_export_files`, above). Until that pass the older object still exists but nothing links to
it. An export that failed or was cancelled replaces nothing: the earlier kept export stays offered.

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
  mask in `inputs.masks` and the large copy of each library photo a VISUAL shows (`inputs.photos`;
  the owner's ready photos, read with the service role and filtered by the job's owner,
  `supabasePhotoLibrary` in `photos/photo-store.ts`, `large_key` from the `photos` row; a photo no
  longer in the library fails the step with `render: photo <id> is no longer in the library`). The
  composite's front layer page names the photos with the stand-ins (`layerNames`), so its project
  holds them too. `render-project.ts` places the
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
   hyperframes render <dir>/sound/project  -o <dir>/sound/sound.mp4 --quality delivery --workers 1 --no-browser-gpu --sdr --format mp4 --fps <soundPageFps(frames)>
   ```

   `LAYER_SETTINGS`: two front workers, not three. With three the tree's peak memory was at the
   single call's level (5.4 to 5.8 GB on the 7.75 GiB worker VM); with two it is 4.5 to 4.7 GB.
   Each call has its own frame cache and history (`renderScratchEnv` of its own folder) and its
   own Chrome `TMPDIR` (`withChromeTmp`).

3. The sound cut (`soundCutArgs`). HyperFrames mixes the sound from the page's elements whatever
   the frame rate, and pads its mix to the page's last frame. The single call pads its mix to
   `frames / 30` seconds and keeps `ceil(samples / 1024) + 1` packets at 48 kHz, the last one
   shortened. The sound page is rendered at the lowest whole rate whose frames end exactly there
   (`soundPageFps`: `30 / gcd(frames, 30)`, so 10 fps for 1683 frames, 2 fps for 3045, 30 fps for
   1013 or 289, 1 fps for a whole number of seconds): the page's `frames / gcd` frames last exactly
   `frames / 30` seconds, so its mix ends at the same sample, the AAC encoder ends its stream at
   the same point, and every packet is the same bytes as the single call's, the last one included.
   At a plain 1 fps the mix ran on to the next whole second: the packet holding the reel's end was
   then encoded mid-stream instead of at the end of the stream, and on the speech-ten reel it came
   out one byte different (decoding to the same samples), which the machine check below caught.
   The rate is always a whole number. A fraction (`190/187` for 1683 frames, the rate that ends
   `ceil(frames / 30)` page frames at the reel's end) is written at timescale 90000; HyperFrames
   then reads the file back at another rate (`317/12`) and trims the sound to the length that rate
   gives the page's frames: 2.158 s of 56.1 s, and the export played silent after it. The page
   draws nothing and renders at about 20 page frames a second, so a 30 fps page takes about 1.3
   times the reel's length. The cut keeps the same
   count (`soundPackets`: 1533 for 980 frames) by stream copy and shortens the last packet with
   HyperFrames' own `setts` expression:

   ```bash
   ffmpeg -i <dir>/sound/sound.mp4 -map 0:a:0 -c copy -frames:a <packets> \
     -bsf:a "setts=duration='if(gte((PTS+DURATION)*TB,<frames/30>),round(<frames/30>/TB-PTS),DURATION)'" <dir>/sound.m4a
   ```

   Never cut by time (`-t`): that drops packets by timestamp and cannot shorten the last one.

   After the cut, ffprobe counts the cut sound's packets (`soundPacketsArgs`), and the export
   fails before the blend when there are fewer than `soundPackets(frames)` (`assertSoundCovers`).
   A sound shorter than the video is never blended into an MP4 with a silent tail. The error:

   ```
   render: the sound is shorter than the video: 103 packets (2.20 s), the reel needs 2631 packets (56.10 s)
   ```

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
`ceil(end x 30) - 1`. A start between two frames is first moved forward to the next frame
(HyperFrames' `alignClipStartToFirstOutputFrame`; the end stays), and the clip extracts
`round((end - first / 30) x 30)` of its own frames, counted from that frame, not from the written
start. A cut-out span on screen one frame longer than it extracts (16.033 to 17.767 s: 53 frames, 52
extracted; 0.867 to 2.367 s: frames 27 to 71, 45 frames, 44 extracted from 0.9 s) shows its last
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
  call, the sound page for the composite). HyperFrames mixes with no gain of ours
  (no `PRODUCER_AUDIO_GAIN`), but may lower the gain of the whole mix to keep its peaks legal
  (about 2.8 dB on a source peaking at +1.1 dBTP); the worker tools test measures the voice within
  0.5 LU of the source and each click within 20 ms of its place on the track.
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
- Only the Cancel button of the reel's page cancels (`cancel_job`); see Studio.
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
  with its last percent, as on any abort. The overlay and the export panel show nothing for a
  cancelled job.

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

1. Open a processed reel and press Export. The header shows `Exporting… N%` and Cancel.
2. Stay, or leave: open another reel, the photo library, upload a new reel. The export keeps going.
3. To stop an export, open the reel and press Cancel.
4. When it is done: if the reel's page is still open, the MP4 downloads by itself. Otherwise, or
   to have the file again, click the Download icon beside the bin in the reels list, or
   `Download vN` on the reel's page. The file is kept for 48 hours.
5. To edit the reel again, wait for the export to end or cancel it. Exporting again replaces the
   kept file.

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
- `export_keep_interval()` (the database, 48 hours): how long an export's file is kept. The
  worker's slimming deletes an export's object once `expires_at` passes, or once a newer export
  of the same reel replaced it (`expire_export_files`, see `app_docs/storage.md`). The slimming
  runs at most once an hour and only while the worker runs no job, so a file may outlive its
  expiry by that long; the studio never signs a link past `expires_at`.
- The owner's R2 lifecycle rule on `<prefix>exports/` is a backstop and must be longer than the
  time kept: 3 days after creation or more. A rule of 1 day (what the 1-hour hand-over had)
  deletes a kept export's object a day before its Download goes away.
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
- Unit (studio): `apps/studio/src/lib/exports.test.ts` (`exportBlockedReason`, `liveRenderJobId`,
  `exportingReason`, `exportProgress`, `exportRunning`, `exportProgressDetail`, `keptExports`, the
  link's hour cap), `change-requests.test.ts` (editing blocked exactly while the reel exports; the
  `export of vN` label) and the storage mock's
  `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`.
- Unit (storage): `packages/storage/src/r2.test.ts` and `fake.test.ts` (the download name).
- DB: `apps/studio/db-tests/exports.test.ts` (the render job policy and the `exports` table, its
  48-hour expiry from `export_keep_interval()`), `cancel-jobs.test.ts` (`cancel_job` on own queued and running renders, refusals,
  no `anon` execute, the refused export of a cancelled job, `claim_job` never taking a cancelled
  job) and `stored-files.test.ts` (`discard_export_file`; `expire_export_files` returning expired
  and replaced exports' files and keeping a reel's newest).
- E2E: `apps/studio/e2e/export.spec.ts`: Export shows `Exporting…` with Cancel in the header and
  no dialog; nothing in the header moves (`expectNoShift`: at 1920, 1280 and 390 px wide, the
  header, each of its children, what is under it, the Export or Cancel box, the progress line, its
  bar and Download have the box they first had, within 0.5 px, at every state the file reaches;
  `watchHeader` measures the same boxes between two states: at once, after every change to the
  header's tree (a `MutationObserver`), on every frame and when the watch ends, and
  `expectNoShiftWhileWatched` also requires the panel's states in order, never a number of frames,
  which a slow machine does not reach); the words about leaving are in the
  Versions column's status line, not in the header; the reel's editing controls are disabled with the reason; the line rises with the
  render double (`E2E_MOCK_RENDER_SECONDS=25`); the owner goes to the reels list while it renders
  and the job is not cancelled; the Download icon appears beside the bin with no reload and no
  download by itself, and a click downloads `reel-v2-<YYYYMMDD-HHMM>.mp4`; the export row expires
  48 hours after it was made; back on the reel `Download v2` gives the file again and editing is
  on. A second test stays on the page and gets the download by itself. A third leaves and comes
  back during a long render, sees the export still running, and Cancel ends it: the job
  `cancelled`, no export row, no object, no download, the earlier kept export still offered. A
  fourth cancels a queued job the worker then never claims (Escape does nothing). A fifth walks
  one export through every state with no worker (it writes the job's and the render step's rows
  itself: `waiting to start`, `getting ready`, `0%`, `7%`, `55%`, `100%`, `finishing`, Cancel) and
  holds each to the same boxes.
- Worker tools: `yarn workspace @edit-issebya/worker test:tools` (`render.tools.test.ts`: the
  single call's format, loudness, click times, group memory), on the owner's Mac only.

### Composite matches single call (machine check)

- Command: `yarn workspace @edit-issebya/worker test:tools`
  (`apps/worker/src/render/render-compare.tools.test.ts`), on the owner's Mac only (real
  HyperFrames, Chrome, ffmpeg and the MODNet mask tool), never in CI. No database, no storage.
- It exports each of two fixture reels both ways through the step runner (`renderVersion`, the
  single call and the composite in `match` mode) and compares the two MP4s:
  - the short speech (2.67 s) with captions and two clicks on the sound track; its footage has 79
    frames for 81 output frames, so the last frames are ones the footage clip holds;
  - the ten-second speech (9.5 s, a person talking) with two big words behind her, so two cut-out
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
- Measured 2026-11-17, after the fixtures were remade with aligned word times (transcribe version 2,
  retime version 4): the ten-second speech's cut-out span of 0.867 to 2.367 s starts between two
  frames. HyperFrames moves such a start to the next frame and extracts from there (44 frames, not
  45), so its export holds frame 70 on frame 71; the composite counted from the written start and
  showed frame 71, and the frame scored 0.97898. With `clipFrames` counting from the moved start
  the composite holds it too. The same reel's last AAC packet was then 7 bytes against the single
  call's 8 (the same decoded samples), fixed by ending the sound page's frames at the reel's end
  (`soundPageFps`, the sound cut above). Then: the short speech's 78 frames 0.99948 mean and
  0.99947 min; the ten-second speech's 289 frames 0.99039 mean and 0.98956 min (frame 144); no
  frame under the bound; the decoded sound and the stored packets identical in both.
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
  moments come from the version's own word times (`wordReveal`). Before each capture the spec
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

The owner's moves (`app_docs/owner-edits.md`) have their own case, `a moved, a resized and a widened
component match between preview and export`: the guardrail's version with its hook resized (110 px to
77 px), moved 400 px down and widened (a 900 px wrap width, so its lines are set again; the preview
draws it no wider than that and on no more lines than before) and its LIST moved 120 px, saved by a real `owner_edit` job, then exported and
compared with its own preview at the guardrail's moments and bound. Its proof that the comparison
sees the moves: the same export against the previews of the version before the moves must fall
below the bound. Measured again 2026-11-17 with the widened hook (the composite): 0.992532, 0.995585
and 0.995803 at 0.5, 1.5 and 2.5 s; against the version before the moves 0.915802, 0.901661 and
0.919066. In the same run the guardrail scored 0.993226, 0.995332 and 0.996493, its 60 px probe
0.993226, 0.971395 and 0.996492, and the question 0.995875, 0.993852 and 0.993295 (its probe
0.955294). The bound is unchanged.

In the behind case, the owner's VISUAL (moved and scaled by a real `owner_edit` job) is then turned
45 degrees by another one (2026-11-17): its preview draws `rotate: 45deg` and no `transform`, its
export is compared with its preview at the same moments and bound, and against the upright card's
previews it must fall below the bound. Measured 2026-11-17 (the composite): the photo behind the
speaker 0.991497, 0.994721 and 0.996376 at 0.5, 1.5 and 2.5 s; the owner's card moved and scaled
0.992318, 0.995543 and 0.996385, against the engine's previews 0.905033, 0.908259 and 0.996385; the
card turned 45 degrees 0.992127, 0.995352 and 0.996383, against the upright card's previews
0.94604, 0.949265 and 0.996383 (at 2.5 s the card is off screen, so both match). The turned case
needs no threshold of its own: its lowest score against the upright previews (0.94604) is well
below `PREVIEW_EXPORT_SSIM_BOUND`, and the check stays that the minimum falls below the bound. The
big word behind scored 0.991366, 0.994109 and 0.993578. The bound is unchanged.

Three more owner cases follow in the behind case (2026-11-17). The card upright with its right
half past the frame's right edge, low over the platform buttons' notch (an owner's card is free of
the safe zone, `app_docs/owner-edits.md`): 0.99299, 0.996222 and 0.996379. The card's picture
swapped for the seeded library photo (the softened sample) by an `owner_edit` job's `photo_id`, the
preview showing the large copy signed from the library and the export downloading it: 0.992643,
0.995869 and 0.996385. A second card added over it by the job's `adds`, both on track 30 at once
and the added one drawn last: 0.992646, 0.995152 and 0.996386; against the one-card previews
0.992646, 0.966814 and 0.996386 (at 0.5 and 2.5 s the added card is not on screen yet or any
more), so the comparison sees the second card. Every case is at or above the bound; the bound is
unchanged.

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

- Nothing in the reel page's header may move or change size at any state of an export (before
  Export, waiting, every percent, done, Download shown, after Cancel), at any width. Never give
  `ExportPanel`'s slot a size that depends on what it shows, never give Export and Cancel
  different boxes, and never put a note, a label or a button outside the slot's 32 px row. A new
  state or control goes inside the slot and into `export.spec.ts`'s `expectNoShift`.
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
- The sound page's rate is a whole number, `30 / gcd(frames, 30)`, for every reel length. Never
  pass HyperFrames a fractional `--fps`: it trims the sound to a few seconds. Never blend a cut
  sound with fewer packets than `soundPackets(frames)`: the export fails instead.
- Every process a render starts runs through the step runner's `tool`, in its own process group,
  and every file it writes is under the render's folder or a `withChromeTmp` folder. Never spawn
  one another way: a cancel must kill them all and leave nothing.
- A question's moments in the guardrail are taken inside a wait between two of its words, never on a
  word's own moment: a word cuts in on one frame, and a capture on that frame's edge measures the
  frame clock, not the picture.
- Use the same builder as the preview (`packages/edit`'s `build`) for every page, the composite's
  layer pages included; never a worker copy, never a stored page.
- Never sign a download link past `expires_at`.
- Export never blocks the studio: never show its progress in a dialog or anything that covers the
  page, and never hold another reel, the photo library or an upload because a reel exports.
- Only Cancel cancels an export, and only through `cancel_job`. Never cancel on leaving the page,
  closing a tab, Escape or unmounting a component; never give the owner an update right on `jobs`.
- While a reel exports, editing that reel is off, in the page (`exportingReason`) and in the
  server actions (`openReel`). Never turn it off without showing the reason, and never turn off
  editing of another reel.
- No notifications for an export: no web push, no email, no toast, nothing that shows on another
  page. The download by itself happens only on the reel's own page, for the export that page was
  following when it finished; never start a download anywhere else without a click.
- One kept export per reel, the newest, offered only while `expires_at` has not passed
  (`keptExports`). Never offer an older export of a reel, and never keep a second file on purpose.
- The time an export is kept is `export_keep_interval()` alone. Never write the 48 hours in a
  second place that decides anything (a check, a query, the worker).
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
- Owner steps: the R2 lifecycle rule for `dev/` and the production prefix, now 3 days or more
  (see Configuration); applying the migrations
  to the hosted project after merge (`20261103164248_one_step_export.sql` and
  `20261118151744_export_kept_48_hours.sql` before deploying the
  worker and the studio that use them); the manual acceptance against `rethink-work-02.mp4` and a
  platform draft upload.
