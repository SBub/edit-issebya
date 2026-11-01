# Feature: fixed pipeline steps part two: background removal, head tracking, preview copies

## Metadata

issue_number: `30`
adw_id: `fe4e42f4`
issue_json: `{"number":30,"title":"feat: fixed pipeline steps part two: background removal, head tracking, preview copies"}`

## Feature Description

Reel studio MVP, slice 7 of 17. After `convert`, `transcribe` and `retime` (issue #29) the worker's
`process` job runs three more fixed steps, each cached in R2 under its fingerprint exactly like the
first three:

1. `remove_background`: HyperFrames' `remove-background` (its current u2net model,
   `u2net_human_seg`) on the retimed `source.mp4`, giving the full-size cut-out of the speaker
   `subject.webm` (VP9 with alpha in WebM, about 51 MB for a 50-second reel).
2. `head_track`: a TypeScript port of the old `head_track.py`. ffmpeg decodes the cut-out (with the
   `libvpx-vp9` decoder, so alpha survives) to raw RGBA at 270x480 and 4 fps; a pure function turns
   the frames into `head-track.json`, `[{ t, head_top, cx, head_w } | null, ...]` in source pixel
   coordinates. The builder (slice 8) places captions around the head from it.
3. `preview_copies`: a small H.264 copy of the retimed footage (`preview.mp4`) and a small VP9-alpha
   WebM copy of the cut-out (`preview-subject.webm`), both 540 wide, same frame timing as the
   source, about 18 MB together for a 50-second reel. The studio's live preview (D5) plays them in
   Chrome.

Every step output is tagged `kept` or `rebuildable` in the step definition (B6), so slice 14's
cleanup can delete heavy, rebuildable files and never the preview copies. The reel status moves
`removing_background`, `tracking_head`, `making_previews`, then `processed`.

## User Story

As the studio owner
I want every uploaded reel to come out of the worker with its cut-out, head track and small preview
copies already made, each made only once
So that the builder and the live preview have everything they need, and a retry or re-run never
spends another seven minutes on background removal

## Problem Statement

After #29 a processed reel has retimed footage and a transcript, but no cut-out of the speaker, no
head position for caption placement and nothing small enough for a browser preview. These were made
by hand with the old scripts in another repository. Background removal alone takes about seven
minutes, so it must be cached and never repeated; and later cleanup needs to know which outputs may
be deleted.

## Solution Statement

Add three `PipelineStep`s to `PIPELINE` in `apps/worker/src/pipeline/definition.ts`, following the
existing pattern exactly (declared inputs, settings, version, outputs, `reusedWhat`, `run` through
the measured `tool`). `runPipeline` needs no logic change: it already HEADs outputs, records hits,
downloads declared inputs and uploads put-if-absent. Changes around it:

- `PipelineStep.outputs` becomes `readonly StepOutput[]` with `{ file, keep: "kept" | "rebuildable" }`
  so every output carries its B6 tag; call sites map to `file`.
- The head-track maths is a pure module (`head-track.ts`) tested on synthetic RGBA buffers; the step
  only runs ffprobe and ffmpeg and reads the raw frames from a file frame by frame (never through
  stdout: about 100 MB for a 50-second reel).
- A new migration widens `reels_status_check` with the three statuses; the studio's
  `REEL_STATUSES` and the worker's `PipelineReelStatus` follow.
- `fixtures/pipeline/` is regenerated (still from `short-speech.mp4`) so the E2E upload spec seeds
  six steps and all six are hits.
- Tool tests on `fixtures/footage/short-person.mp4` prove alpha, the head track and the preview
  sizes with the real tools.

Background removal stays on HyperFrames' current model with its default decode (D4): no Apple
Vision, no mask as H.264, no frame-reader patch, no decode-size change (issue #20).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (Yarn only, no em-dashes, migrations through
  `supabase migration new`, conventional commits with no trailers).
- `.adw/project.md`: ports, Protected rules (never touch `fixtures/footage/short-person.mp4`, never
  start the worker, only `.adw/supabase-stack reset` and `supabase migration new`).
- `docs/conditional-docs.md`: the `app_docs/pipeline.md` line is widened to name the three new
  steps; no new line.
- `app_docs/pipeline.md`: the feature doc for the fixed steps; extended in place (its Rules are
  invariants: every step declares everything it reads, never overwrite a stored output, bump the
  version on behaviour change, HyperFrames never through npx and always with
  `HYPERFRAMES_NO_TELEMETRY=1`, never write to the reference repository).
- `app_docs/measurement.md`: `runToolsStep`, summaries (`stepSummary` appends duration and size).
- `app_docs/studio.md`: reel statuses, the live step log, the worker and storage.
- `apps/worker/src/pipeline/definition.ts`: `PipelineStep`, `PIPELINE`, `fingerprintsFor`; gets
  `StepOutput` and the three steps.
- `apps/worker/src/pipeline/definition.test.ts`: order, outputs, input wiring and per-setting
  fingerprint tests; extended.
- `apps/worker/src/pipeline/run-pipeline.ts`: maps `outputs` to file names; `contentType` gains
  `.webm`.
- `apps/worker/src/pipeline/run-pipeline.test.ts`: the fake tools must play `remove-background`
  and the rawvideo decode.
- `apps/worker/src/pipeline/transcribe.ts`: model for a HyperFrames step (`tools.hyperframes`,
  `hyperframesEnv()`, HyperFrames version as a setting).
- `apps/worker/src/pipeline/convert.ts`, `retime.ts`: model for ffmpeg steps (args builder as a
  pure exported function, temporary `.part` name then rename, `probe.ts`).
- `apps/worker/src/pipeline/probe.ts`: `parseProbe` (width, height, duration) for the cut-out.
- `apps/worker/src/pipeline/tools.ts`: `HYPERFRAMES_VERSION`, `hyperframesEnv`, `ToolPaths`.
- `apps/worker/src/pipeline/atomic.ts`: `writeAtomic` for JSON outputs.
- `apps/worker/src/pipeline/pipeline-fixtures.test.ts`, `apps/worker/src/make-pipeline-fixtures.ts`:
  the committed fixture manifest; both map outputs to file names.
- `apps/worker/src/pipeline/tools-test-support.ts`, `retime.tools.test.ts`,
  `apps/worker/vitest.tools.config.ts`: the `test:tools` layer.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus`.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `Tool`, summary size from `bytes_out`.
- `apps/worker/src/doctor-checks.ts`, `doctor-checks.test.ts`, `doctor.ts`: `yarn doctor` checks
  the tools the fixed steps need; gains the VP9 codec check.
- `apps/studio/src/lib/reels.ts`, `reels.test.ts`: `REEL_STATUSES` mirrors the check constraint.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: accepted reel statuses.
- `apps/studio/e2e/upload.spec.ts`: seeds `fixtures/pipeline/` and runs the worker's `once`.
- `supabase/migrations/20261102090000_pipeline_steps.sql`: the current `reels_status_check`
  (never edited; a new migration replaces the constraint).
- `fixtures/pipeline/`: regenerated by `fixtures:pipeline`.
- `fixtures/footage/short-person.mp4`: the clip with a person (read only, never touched).
- Reference, read only: `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/head_track.py`
  (the algorithm being ported), `subject.webm`, `head-track.json` (manual acceptance only).

### New Files

- `apps/worker/src/pipeline/remove-background.ts`: the `remove_background` step and
  `removeBackgroundArgs`.
- `apps/worker/src/pipeline/remove-background.test.ts`: argument builder and env.
- `apps/worker/src/pipeline/head-track.ts`: pure `headTrack(frames, options)` and the frame reader
  helper types; `HEAD_TRACK_SETTINGS`.
- `apps/worker/src/pipeline/head-track.test.ts`: synthetic RGBA frames.
- `apps/worker/src/pipeline/head-track-step.ts`: the `head_track` step (ffprobe, ffmpeg decode to a
  raw file, frame-by-frame read, `head-track.json`), plus `headTrackDecodeArgs`.
- `apps/worker/src/pipeline/preview-copies.ts`: the `preview_copies` step, `previewFootageArgs`,
  `previewSubjectArgs`, `PREVIEW_SETTINGS`.
- `apps/worker/src/pipeline/preview-copies.test.ts`: argument builders (scale, codecs, alpha, no
  frame-rate change).
- `apps/worker/src/pipeline/cutout.tools.test.ts`: tool tests 4, 5 and 6 on `short-person.mp4`.
- `supabase/migrations/<stamp>_pipeline_steps_part_two.sql`: created with
  `supabase migration new pipeline_steps_part_two`.
- `fixtures/pipeline/remove_background/subject.webm`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/preview_copies/preview.mp4`, `fixtures/pipeline/preview_copies/preview-subject.webm`
  (generated, plus refreshed `manifest.json`).

## Implementation Plan

### Phase 1: Foundation

- Output tags: `StepOutput = { file: string; keep: OutputKeep }`, `OutputKeep = "kept" | "rebuildable"`
  in `definition.ts`; migrate convert, transcribe and retime, and every reader of `outputs`.
- Statuses: new migration, `PipelineReelStatus`, `REEL_STATUSES`, the DB test.
- The pure head-track function with its unit tests (no ffmpeg).

### Phase 2: Core Implementation

- `remove_background`, `head_track`, `preview_copies` step modules, each with a pure args builder
  and unit tests on it.
- `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.

### Phase 3: Integration

- `run-pipeline.test.ts` fakes and expectations for six steps; `contentType` for `.webm`.
- Doctor VP9 check.
- Regenerate `fixtures/pipeline/`; extend the E2E upload spec to six hits.
- Tool tests on `short-person.mp4`; update `retime.tools.test.ts` (six `done` calls).
- Docs: `app_docs/pipeline.md`, `docs/conditional-docs.md`, touch-ups in `app_docs/studio.md`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Check the person clip and read the docs

- Confirm `fixtures/footage/short-person.mp4` exists (`ls -l`). If it is missing, stop and report
  it; never generate, download or re-encode a substitute. Never modify it.
- Read `app_docs/pipeline.md`, `app_docs/measurement.md`, `app_docs/studio.md` (Rules sections are
  invariants).

### 2. Tag every output `kept` or `rebuildable`

- In `apps/worker/src/pipeline/definition.ts` add:
  ```ts
  // B6: a kept output cannot be rebuilt cheaply and is never cleaned up; a
  // rebuildable one is heavy and may be deleted (slice 14), since its step
  // re-runs from its fingerprint.
  export type OutputKeep = "kept" | "rebuildable";
  export interface StepOutput {
    file: string;
    keep: OutputKeep;
  }
  ```
  and change `PipelineStep.outputs` to `readonly StepOutput[]`.
- Classification (record it in `app_docs/pipeline.md`): `convert/converted.mp4` and
  `remove_background/subject.webm` are `rebuildable` (B6 names them as heavy and rebuildable);
  `preview_copies/preview.mp4` and `preview-subject.webm` are `kept` (B6). Every other output
  (`transcript.json`s, `retime.json`, `envelope.json`, `retime/source.mp4`, `head-track.json`) is
  `kept`: B6 does not classify them as rebuildable, so cleanup must not touch them until a decision
  says otherwise.
- Update `convert.ts`, `transcribe.ts`, `retime.ts` to the new shape (their behaviour and versions
  are unchanged: the tag is not in the fingerprint, since `fingerprintsFor` hashes inputs, settings
  and version only).
- Update readers to use `.file`: `run-pipeline.ts` (`outputKeys`, `outputPaths`, the existence check
  and upload loop), `make-pipeline-fixtures.ts` (`files: step.outputs.map((o) => o.file)`),
  `pipeline-fixtures.test.ts`, `definition.test.ts`, `run-pipeline.test.ts` (`outputKeys`).
- `run-pipeline.ts` `contentType`: `.webm` gives `video/webm`.

### 3. Reel statuses

- Run `supabase migration new pipeline_steps_part_two` (the only `supabase` command allowed besides
  `.adw/supabase-stack reset`). In the created file drop and re-add `reels_status_check` with
  `uploading, uploaded, received, converting, transcribing, retiming, removing_background,
tracking_head, making_previews, processed, failed`, with a header comment in the style of
  `20261102090000_pipeline_steps.sql`. Never edit the applied migration.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus` gains the three values.
- `apps/studio/src/lib/reels.ts` `REEL_STATUSES` and `reels.test.ts`: same list and order as the
  constraint.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: "accepts each step's reel status" loops over
  all six step statuses plus `processed`.
- Run `.adw/supabase-stack reset` so the ADW stack has the new constraint before `test:db` and E2E.
  If it fails, report its error and stop.

### 4. Pure head tracking

- Create `apps/worker/src/pipeline/head-track.ts`:
  - `HEAD_TRACK_SETTINGS = { analysisWidth: 270, analysisHeight: 480, sampleFps: 4, alphaThreshold: 128,
minOpaquePixels: 4, bandStartRows: 20, bandEndRows: 50, bounds: { minHeadTop: null,
minHeadWidth: null, maxHeadWidth: null } }` with the bounds typed `number | null`. No filtering
    by default: the reference bounds (`head_top >= 380`, `220 <= head_w <= 420`) were for one room
    (an arch merged into the head). Comment that.
  - `export type HeadSample = { t: number; head_top: number; cx: number; head_w: number } | null`.
  - `export function headSample(frame: Uint8Array, index: number, options): HeadSample`, where
    options carry the settings plus `scaleX`, `scaleY` (source size divided by analysis size; 4 and
    4 for 1080x1920). Exact port of `head_track.py`:
    - opaque means alpha (byte 3 of each RGBA pixel) strictly above `alphaThreshold`;
    - `top` is the first row with at least `minOpaquePixels` opaque pixels; none gives `null`;
    - spans: for rows `top + bandStartRows` up to (excluding) `min(height, top + bandEndRows)`,
      each row with any opaque pixel gives `(first opaque x, last opaque x)`; none gives `null`;
    - sort spans by `x1 - x0` (stable), take index `floor(length / 2)`;
    - `t = round(index / sampleFps, 2 decimals)`, `head_top = round(top * scaleY)`,
      `cx = round(floor((x0 + x1) / 2) * scaleX)`, `head_w = round((x1 - x0) * scaleX)`;
    - then the bounds: any non-null bound the sample breaks gives `null`.
  - `export function headTrack(frames: Iterable<Uint8Array>, options): HeadSample[]` mapping
    `headSample` with the frame index; a frame whose length is not `width * height * 4` throws.
  - `export function headTrackWhat(track: HeadSample[]): string` giving
    `head tracked, <n> samples, <k> without a head` (plural rules as in `summary.ts`: `1 sample`).
- Create `apps/worker/src/pipeline/head-track.test.ts` (pure, no ffmpeg), with a helper that paints
  an opaque ellipse into a transparent 270x480 RGBA buffer:
  - an ellipse with known top, centre and width (for example centre x 135, top 100, semi-axes 30 by 40) gives `head_top`, `cx`, `head_w` within 4 px of the truth in 1080x1920 coordinates
    (truth: top 400, cx 540, width 240 at the band rows; compute the expected width at the median
    band row analytically or assert within one analysis pixel of the ellipse's widest span in the
    band);
  - an empty frame gives `null`; a frame with only 3 opaque pixels in its top row and nothing else
    gives `null` (the 4-pixel rule);
  - alpha exactly 128 counts as transparent;
  - `t` of the frame at index 5 with 4 fps is `1.25`;
  - with `bounds.minHeadTop` above the ellipse's top the sample is `null`; with
    `maxHeadWidth` below its width it is `null`; with all bounds `null` it is kept;
  - a frame of the wrong length throws;
  - `headTrackWhat` on `[sample, null, sample]` is `head tracked, 3 samples, 1 without a head`.

### 5. Background removal step

- Create `apps/worker/src/pipeline/remove-background.ts`:
  - `REMOVE_BACKGROUND_SETTINGS = { device: "auto", quality: "balanced", hyperframes: HYPERFRAMES_VERSION }`
    (exactly the settings the issue names; the model is not a CLI option, so HyperFrames' version
    stands for it). Comment: D4, stays on HyperFrames' current u2net model (`u2net_human_seg`)
    until issue #20; no faster method here.
  - `removeBackgroundArgs(input, output, settings)` returns
    `["remove-background", input, "-o", output, "--device", settings.device, "--quality", settings.quality, "--json"]`.
  - `version: 1`, `name: "remove_background"`, `reelStatus: "removing_background"`,
    `outputs: [{ file: "subject.webm", keep: "rebuildable" }]`, `reusedWhat: "background removed"`,
    input `{ step: "retime", fingerprint: fingerprints.retime, file: "source.mp4" }` as `source.mp4`.
  - `run`: `tool({ file: node, args: [entry, ...removeBackgroundArgs(files["source.mp4"], partial, settings)], env: hyperframesEnv() })`
    with `partial = join(dir, "subject.part.webm")` (ends in `.webm`, so HyperFrames infers WebM),
    then rename to `subject.webm`. Returns `{ what: "background removed" }` (the runner appends
    duration and size: `background removed, 6 minutes 47 seconds, 51.0 MB`).
- `remove-background.test.ts`: the args (order, `--device auto`, `--quality balanced`, `--json`, the
  `.webm` output) and that the step's input is the retimed `source.mp4`.

### 6. Head tracking step

- Create `apps/worker/src/pipeline/head-track-step.ts`:
  - `headTrackDecodeArgs(input, output, settings)`:
    `["-hide_banner", "-v", "error", "-y", "-c:v", "libvpx-vp9", "-i", input, "-vf", "fps=<sampleFps>,scale=<w>:<h>", "-pix_fmt", "rgba", "-f", "rawvideo", output]`
    (`-c:v libvpx-vp9` before `-i`: the native decoder drops alpha).
  - Step: `name: "head_track"`, `version: 1`, `settings: HEAD_TRACK_SETTINGS`,
    `reelStatus: "tracking_head"`, `outputs: [{ file: "head-track.json", keep: "kept" }]`,
    `reusedWhat: "head tracked"`, input `remove_background/subject.webm` as `subject.webm`.
  - `run`: ffprobe the cut-out (`parseProbe`, `probeArgs`) for its width and height; ffmpeg decodes
    to `join(dir, "frames.rgba")` (a scratch file, not an output, so it is not in `bytes_out`); read
    it frame by frame through a file handle (one `width * height * 4` buffer at a time, never the
    whole file), feed `headTrack`; zero frames, or a trailing partial frame, throws
    (`head_track: ...`). Remove `frames.rgba`, then `writeAtomic(join(dir, "head-track.json"), JSON.stringify(track) + "\n")`.
    `what` is `headTrackWhat(track)`.
- Unit-test `headTrackDecodeArgs` in `head-track.test.ts` (or a small `head-track-step.test.ts`):
  decoder before input, the fps and scale filter, rgba rawvideo.

### 7. Preview copies step

- Create `apps/worker/src/pipeline/preview-copies.ts`:
  - `PREVIEW_SETTINGS = { width: 540, footage: { videoCodec: "libx264", preset: "medium", crf: 26, pixelFormat: "yuv420p", keyframeSeconds: 1, audioCodec: "aac", audioBitrate: "96k", faststart: true }, subject: { videoCodec: "libvpx-vp9", pixelFormat: "yuva420p", crf: 36, deadline: "good", cpuUsed: 4, keyframeSeconds: 1 } }`.
    The values target about 18 MB together for a 50-second reel (about 2.9 Mbit/s for both); tune
    the two `crf`s on the person clip during the tool test run and record the measured sizes in the
    doc. Any tuning before merge is fine (version stays 1); after merge it needs a version bump.
  - `previewFootageArgs(input, output, settings, fps)`: `-i input -map 0:v:0 -map 0:a:0? -vf scale=<width>:-2 -c:v libx264 -preset -crf -pix_fmt yuv420p -g <fps*keyframeSeconds> -keyint_min same -sc_threshold 0 -fps_mode passthrough -c:a aac -b:a 96k -movflags +faststart output`.
  - `previewSubjectArgs(input, output, settings, fps)`: `-c:v libvpx-vp9 -i input -map 0:v:0 -an -vf scale=<width>:-2 -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf <crf> -deadline good -cpu-used 4 -row-mt 1 -auto-alt-ref 0 -g <fps*keyframeSeconds> -fps_mode passthrough output`.
    Both use `scale=<width>:-2` so they have the same size as each other and keep the source
    aspect (540x960 for 1080x1920); neither changes the frame rate or timing. `fps` comes from an
    ffprobe of the retimed source (`rFrameRate`), for the GOP only.
  - Step: `name: "preview_copies"`, `version: 1`, `reelStatus: "making_previews"`,
    `outputs: [{ file: "preview.mp4", keep: "kept" }, { file: "preview-subject.webm", keep: "kept" }]`,
    `reusedWhat: "preview copies made"`, inputs `retime/source.mp4` as `source.mp4` and
    `remove_background/subject.webm` as `subject.webm`. Each encode writes a `.part.mp4` /
    `.part.webm` name and is renamed after exit 0. `what` is `preview copies made` (the runner
    appends duration and total size: `preview copies made, 12 seconds, 18.0 MB`).
- `preview-copies.test.ts`: both use the same `scale=540:-2`; the WebM has `yuva420p`, the VP9
  decoder before `-i`, no audio; the MP4 is H.264 with faststart; neither has an `fps=` filter or
  `-r`.

### 8. Wire the pipeline

- `definition.ts`: `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.
- `definition.test.ts`:
  - the order test lists the six `[name, reelStatus]` pairs;
  - the existing "every single setting" and "version" tests cover the new steps automatically;
  - add the explicit B5 case: changing `remove_background`'s `hyperframes` setting changes
    `remove_background`, `head_track` and `preview_copies` fingerprints and leaves the first three
    unchanged;
  - add the output-tag test: `subject.webm` is `rebuildable`, both preview copies are `kept`,
    `converted.mp4` is `rebuildable`, and every output of every step has a `keep` of `kept` or
    `rebuildable`;
  - "reads only outputs of earlier steps" uses `outputs.map((o) => o.file)`.
- `run-pipeline.test.ts` `fakeTools`: HyperFrames `remove-background` (args contain
  `remove-background`) writes a small file at its `-o` path; ffmpeg with `-f rawvideo` writes two
  frames of zero bytes of the size its `scale=` filter names (`270*480*4` each) at its last
  argument; the other ffmpeg calls keep writing a text file at their last argument. ffprobe keeps
  answering `testdata/sdr-cfr.json`. Update the expectations that assume three steps (the first-run
  summaries list, statuses, shape lists, version-bump and resume cases) to six, and add to the
  first-run case that `head_track/head-track.json` is `[null, null]` (transparent frames) and that
  its summary starts `head tracked, 2 samples, 2 without a head`.
- `apps/worker/src/pipeline/retime.tools.test.ts`: `done` calls become 6.

### 9. Doctor check

- `doctor-checks.ts`: add `ffmpegCodecs: () => Promise<string>` (output of
  `ffmpeg -hide_banner -codecs`) to `DoctorDeps` and a check line `ffmpeg vp9` that fails unless
  the listing shows `libvpx-vp9` as both decoder and encoder (the `(decoders: ... libvpx-vp9 ...)`
  and `(encoders: ... libvpx-vp9 ...)` parts of the `vp9` line). Wire it in `doctor.ts` like
  `ffmpegFilters`; extend `doctor-checks.test.ts` (present, missing encoder, missing decoder).

### 10. Regenerate the pipeline fixtures

- Run `yarn workspace @edit-issebya/worker fixtures:pipeline` (real ffmpeg and HyperFrames on
  `short-speech.mp4`, which has no person: the cut-out is mostly transparent and the head track
  mostly `null`; that is fine, the E2E spec only needs every output present under its fingerprint).
  Commit the new `fixtures/pipeline/` folders and `manifest.json`. `pipeline-fixtures.test.ts`
  must pass afterwards. Report the fixture sizes; they should stay small (the clip is 24 KB).

### 11. Extend the E2E upload spec

- `apps/studio/e2e/upload.spec.ts`: the step lines become six:
  `convert: footage converted, reused`, `transcribe: transcribed, reused`, `retime: retimed, reused`,
  `remove_background: background removed, reused`, `head_track: head tracked, reused`,
  `preview_copies: preview copies made, reused`; the `steps` rows equal six `hit(...)`s in that
  order; the reel still ends `processed`. Without this feature the spec fails (three lines and three
  rows only). It already seeds every step listed in the manifest, so no seeding change is needed.

### 12. Tool tests on the person clip

- `tools-test-support.ts`: export `PERSON_CLIP` (`fixtures/footage/short-person.mp4`) and a helper
  `decodeFrameRgba(path, seconds)` (ffmpeg `-c:v libvpx-vp9 -ss <s> -i path -frames:v 1 -pix_fmt rgba -f rawvideo <file>`)
  and a `streamTags`/`videoStream` extension exposing `width`, `height`, `pix_fmt` and
  `tags.alpha_mode` (`-show_streams` already returns them; widen the interface). The test reads
  the clip only.
- Create `apps/worker/src/pipeline/cutout.tools.test.ts`: puts `short-person.mp4` into a temp
  folder fake and runs `runPipeline` with `REAL_TOOLS` (six `done` calls), then: 4. `remove_background/subject.webm`: `codec_name` is `vp9`, and `tags.alpha_mode === "1"` or the
  decoded `pix_fmt` is `yuva420p`; the middle frame (half the probed duration) decoded to RGBA
  has at least one alpha 0 and at least one alpha 255 byte; 5. `head_track/head-track.json`: at least 80% of samples non-null, every non-null `cx` in
  `[0, source width)`, and the sample count equals about `duration * 4` (within 1); 6. `preview.mp4` and `preview-subject.webm`: both 540x960, durations equal the retimed
  `source.mp4` within one frame (1/30 s), the WebM keeps alpha (same check as 4); log the
  combined size and bit rate, and assert the combined bit rate is under 5.8 Mbit/s (twice the
  18 MB per 50 s target) as a guard against an accidental full-size copy.
- Run `yarn workspace @edit-issebya/worker test:tools` on the Mac. If a tool run fails, report the
  output; never weaken the assertions.

### 13. Documentation

- `app_docs/pipeline.md` (updated in place; title becomes "Fixed Pipeline Steps"; add this spec to
  Specifications): overview with six steps and statuses; a section per new step (command,
  settings, outputs); the head-track format (`[{ t, head_top, cx, head_w } | null]`, source pixel
  coordinates, 4 samples per second, analysis 270x480, the algorithm, bounds as settings off by
  default); preview sizes (540 wide, same timing, codecs, the measured size for the person clip and
  the 18 MB per 50 s target); the `kept` / `rebuildable` table for every output; Testing (new unit
  tests, `cutout.tools.test.ts` on `short-person.mp4`, six hits in E2E); Configuration (doctor VP9
  check, `libvpx-vp9` needed); Rules additions: "Background removal stays on HyperFrames' current
  u2net model with its default decode until issue #20 is taken up: no Apple Vision, no mask as
  H.264, no frame-reader patch, no decode-size change.", "Never decode the cut-out without the
  `libvpx-vp9` decoder: the native one drops alpha.", "Every output carries a `kept` or
  `rebuildable` tag; never delete a `kept` output.", "Never touch `fixtures/footage/short-person.mp4`."
  Manual acceptance (owner) under Testing: the `rethink-work` comparison from the issue.
- `docs/conditional-docs.md`: widen the pipeline line to "(convert, transcribe, retime, remove
  background, head track, preview copies), output `kept`/`rebuildable` tags, ...".
- `app_docs/studio.md`: where it lists reel statuses, add the three new ones.
- No em-dashes anywhere.

### 14. Validation

- Run every command in `Validation Commands`, in order, and fix anything that fails.

## Testing Strategy

### Unit Tests

- `head-track.test.ts`: ellipse position within 4 px, empty frame null, the 4-pixel rule, alpha
  threshold, `t` rounding, bounds on and off, wrong frame length, summary text, decode args.
- `definition.test.ts`: six-step order and statuses; HyperFrames-version change cascades from
  `remove_background` to the last step; output tags; every setting leaf of the new steps changes its
  fingerprint and later ones.
- `remove-background.test.ts`, `preview-copies.test.ts`: argument builders.
- `run-pipeline.test.ts`: six steps run on a first run, six hits on the second, resume and version
  cascades with the new steps, `.webm` uploaded.
- `doctor-checks.test.ts`: the VP9 line.
- `reels.test.ts`: `REEL_STATUSES` matches the new constraint.
- `pipeline-fixtures.test.ts`: fails until `fixtures/pipeline/` is regenerated.

### Test Coverage

- Unit (`yarn test`), `head-track.test.ts`: catches a wrong port of the head-track maths
  (coordinates, nulls, bounds); nothing tests it today.
- Unit, `definition.test.ts` additions: catches a step that does not declare the HyperFrames version
  or reads the wrong upstream output, and a missing or wrong `kept`/`rebuildable` tag.
- Unit, `run-pipeline.test.ts` updates: catches the new steps not being cached, resumed or uploaded
  like the first three.
- DB (`test:db`), `pipeline-statuses.test.ts`: catches the constraint rejecting
  `removing_background`, `tracking_head`, `making_previews` (the worker's status write would fail
  the job).
- Tools (`test:tools`, Mac only), `cutout.tools.test.ts`: catches a cut-out without alpha, a decode
  that loses alpha, a head track that misses the head, and wrong preview size or duration, with the
  real ffmpeg and HyperFrames.
- E2E, `upload.spec.ts`: catches the new steps not being hits from seeded outputs, or the live step
  log and the `processed` status not reaching the page.

### Edge Cases

- A frame with no opaque row, or opaque only in rows with no band below (head at the very bottom):
  `null`.
- A head touching the top edge (`top = 0`) and a band that runs past the bottom (clipped at the
  frame height).
- Alpha exactly at the threshold (128) is transparent.
- A cut-out that decodes to zero frames, or a raw file whose size is not a whole number of frames:
  the step fails with a clear message.
- Non-1080x1920 footage: coordinates scale per axis from the probed size; previews keep aspect with
  `-2`.
- A footage with no person (`short-speech.mp4`): the steps succeed, the track is mostly `null`.
- A lost `subject.webm` re-runs only `remove_background`; later steps stay hits (unchanged
  fingerprints, as for convert today).
- A HyperFrames upgrade re-runs `transcribe` and everything after it, including background removal.
- A failed background removal resumes at `remove_background` on retry, with the first three as hits.

## Acceptance Criteria

- `PIPELINE` runs convert, transcribe, retime, remove_background, head_track, preview_copies in
  that order, each a hit when its outputs are stored under its fingerprint.
- `remove_background` runs `hyperframes remove-background <source.mp4> -o <tmp>.webm --device auto --quality balanced --json`
  with `HYPERFRAMES_NO_TELEMETRY=1`, through the step runner; its settings are device, quality and
  the HyperFrames version; no other background method exists in the code.
- `head_track` writes `head-track.json` as `[{ t, head_top, cx, head_w } | null]` from a pure
  function with no filtering by default.
- `preview_copies` writes `preview.mp4` (H.264) and `preview-subject.webm` (VP9 with alpha), both
  540 wide, same timing as the source.
- Every output has a `keep` tag; `subject.webm` and `converted.mp4` are `rebuildable`, both preview
  copies are `kept`.
- The reel status moves `removing_background`, `tracking_head`, `making_previews`, `processed`; the
  constraint accepts them.
- Summaries read like `background removed, 6 minutes 47 seconds, 51.0 MB`,
  `head tracked, 197 samples, 3 without a head, ...`, `preview copies made, ..., 18.0 MB`.
- `fixtures/pipeline/` holds six steps and the E2E spec shows six `reused` lines and `processed`.
- Every validation command passes; `test:tools` passes on the Mac.
- `fixtures/footage/short-person.mp4` is unchanged (`git diff --stat` shows nothing for it).

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `ls -l fixtures/footage/short-person.mp4 && git diff --exit-code -- fixtures/footage/short-person.mp4`: the person clip exists and is untouched.
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio`: lint the two target workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio`: types, including the new `outputs` shape (the worker's build check is its typecheck).
- `yarn knip`: no unused exports or files from the new modules.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio`: unit tests (head track, definition, run-pipeline, args, doctor, statuses list, fixtures freshness).
- `yarn test`: the full unit suite as the pre-push hook runs it.
- `yarn workspace @edit-issebya/worker test:tools`: real ffmpeg and HyperFrames on `short-speech.mp4` and `short-person.mp4` (owner's Mac only).
- `.adw/supabase-stack reset`: apply the new migration to the ADW stack before the DB and E2E layers.
- `yarn turbo run test:db --filter=./apps/studio`: the reel status constraint accepts the new statuses.
- `yarn turbo run build --filter=./apps/studio`: the studio still builds with the widened status list.
- `yarn build`: full build, as CI runs it.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E suites, including the six-hit upload spec (against the `/prepare_app` server already on this run's port).

## Notes

- No new dependency: ffmpeg (with `libvpx-vp9`), ffprobe and the pinned `hyperframes` 0.8.222 are
  already used.
- No new screen and no visual review surface: the change is in `apps/worker` plus a status list in
  the studio; the existing live step log shows the new lines, covered by the E2E spec. The studio's
  reel page needs no change.
- Output tags are not part of any fingerprint, so tagging the existing three steps changes no
  fingerprint and no stored output. Outputs not classified by B6 are `kept` on purpose (cleanup
  must never delete what no decision allowed); slice 14 may revisit `retime/source.mp4`.
- The raw RGBA decode for a 50-second reel is about 100 MB (270x480x4 bytes, 200 frames): it goes to
  a scratch file read frame by frame, never through the tool's stdout (the step runner buffers
  stdout as text).
- `fixtures/pipeline/` stays built from `short-speech.mp4` (24 KB) to keep the committed fixtures
  small; the person clip (1.2 MB) is for `test:tools` only.
- Preview `crf` values are a starting point aimed at about 18 MB per 50 s; the owner's manual
  acceptance on `rethink-work` confirms the real size. Changing them after merge needs a version
  bump and `fixtures:pipeline`.
- Manual acceptance (owner, not the pipeline): run the `rethink-work` footage through all fixed
  steps; compare the cut-out with `rethink-work/subject.webm` at 10 s and 25 s, the head track with
  `rethink-work/head-track.json` (same sample count, positions within a few pixels where the old
  filter kept a sample; set the old bounds to compare like for like), and background removal time
  with issue #20 (about 7 minutes). The pipeline does not verify cut-out quality or the run time on
  the owner's machine.
- Out of scope: faster background removal (issue #20), a progress percentage (slice 15), deleting
  rebuildable files (slice 14), the builder (slice 8).
