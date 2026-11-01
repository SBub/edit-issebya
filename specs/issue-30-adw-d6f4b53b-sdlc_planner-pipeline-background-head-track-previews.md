# Feature: fixed pipeline steps part two: background removal, head tracking, preview copies

## Metadata

issue_number: `30`
adw_id: `d6f4b53b`
issue_json: `{"number":30,"title":"feat: fixed pipeline steps part two: background removal, head tracking, preview copies"}`

## Feature Description

Reel studio MVP, slice 7 of 17. After the three fixed steps from #29 (convert, transcribe, retime) the
worker's `process` job runs three more fixed steps, each cached in R2 under its fingerprint exactly
like the first three:

1. `remove_background`: HyperFrames' `remove-background` (its current u2net model,
   `u2net_human_seg`) on the retimed `source.mp4`, giving the full-size cut-out of the speaker,
   `subject.webm` (VP9 with alpha). Heavy (about 51 MB for 50 s) and rebuildable.
2. `head_track`: a TypeScript port of the old `head_track.py`. ffmpeg decodes the cut-out with the
   `libvpx-vp9` decoder (so alpha survives) to raw RGBA at 270x480 and 4 fps; a pure function turns
   the frames into `head-track.json`, `[{ t, head_top, cx, head_w } | null, ...]` in 1080x1920
   coordinates. The old room-specific sanity filter becomes optional settings, off by default.
3. `preview_copies`: a small H.264 copy of the retimed footage (`preview-source.mp4`) and a small
   VP9-alpha copy of the cut-out (`preview-subject.webm`), both 540x960 with the source's frame
   timing, about 18 MB together for a 50 s reel, for the studio's live preview in Chrome. Kept.

Every step output is tagged `kept` or `rebuildable` in the step definition, for slice 14's cleanup.
The reel status continues `removing_background`, `tracking_head`, `making_previews`, then
`processed`, and each step writes a summary line (`background removed, 6 minutes 47 seconds,
51.0 MB`, `head tracked, 197 samples, 3 without a head, ...`, `preview copies made, ..., 18.0 MB`).

## User Story

As the studio owner processing a talking-head reel
I want the worker to cut out the speaker, track their head and make small preview copies once, cached
So that the builder (captions around the head) and the live preview have every input they need
without any step ever running twice

## Problem Statement

After #29 a processed reel has only converted and retimed footage and a transcript. The builder
(slice 8) needs the head's position over time to place captions, and the preview (D5) needs small
copies of the footage and of the cut-out. Background removal is the slowest step (about 7 of the
12 minutes), so it must never be repeated: it has to be part of the fingerprint cache with resume
and hits. Slice 14 must also be able to tell heavy rebuildable outputs from kept ones, which nothing
records yet.

## Solution Statement

Add three `PipelineStep`s to `apps/worker/src/pipeline/` following the existing pattern (`convert.ts`,
`transcribe.ts`, `retime.ts`): each declares its inputs (outputs of earlier steps by fingerprint),
its settings and its version; `runPipeline` is unchanged in shape and already gives hits, resume,
put-if-absent uploads and measurement through `runToolsStep`.

- `remove_background` runs the installed HyperFrames binary (`tools.hyperframes`, forced
  `HYPERFRAMES_NO_TELEMETRY=1`) with `remove-background <source.mp4> -o subject.part.webm --device
auto --quality balanced --json`, then renames to `subject.webm`. Settings
  `{ device, quality, hyperframes: HYPERFRAMES_VERSION }`.
- `head_track` is split into an I/O shell (ffmpeg writes `frames.rgba` into the step folder, read
  back one frame at a time) and a pure module `head-track.ts` (`headSample`, `trackHead`,
  `headTrackWhat`) with unit tests on synthetic frames.
- `preview_copies` runs two ffmpeg encodes (H.264 plus AAC; VP9 `yuva420p` decoded with
  `libvpx-vp9`), both scaled to 540x960, no frame-rate filter (passthrough timing), a keyframe every
  second, written under `.part` names and renamed.
- `PipelineStep.outputs` becomes `readonly StepOutput[]` with `{ file, keep: "kept" | "rebuildable" }`;
  the fingerprint does not include outputs, so the existing fixtures stay valid for the first three
  steps.
- A new migration widens `reels_status_check`; the worker's `PipelineReelStatus` and the studio's
  `REEL_STATUSES` follow.
- `fixtures/pipeline/` is regenerated (still from `fixtures/footage/short-speech.mp4`, so the E2E
  upload spec's clip and ETag are unchanged) and now holds all six steps' outputs; the E2E spec
  expects six hits.

The background model is not changed in any way (issue #20's options are out of scope).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (Yarn only, no em-dashes, migrations via
  `supabase migration new`, docs layout).
- `.adw/project.md`: profile. Its Tests section describes `test:tools` "on the committed clip" and
  `upload.spec.ts` seeding `fixtures/pipeline/`; widen the `test:tools` sentence to name
  `fixtures/footage/short-person.mp4` too. Never rename or reorder its headings.
- `docs/conditional-docs.md`: widen the `app_docs/pipeline.md` line (no new line).
- `app_docs/pipeline.md`: the pipeline feature doc; extend in place with the three steps.
- `app_docs/studio.md`, `app_docs/measurement.md`: read (they match "changing `apps/worker`", the
  `reels` statuses and summary rules); `studio.md` lists reel statuses, update that list.
- `apps/worker/src/pipeline/definition.ts`: `PipelineStep`, `PIPELINE`, `fingerprintsFor`; add
  `StepOutput`, the three steps.
- `apps/worker/src/pipeline/run-pipeline.ts`: iterates `step.outputs` (switch to `.file`),
  `contentType` (add `.webm` as `video/webm`).
- `apps/worker/src/pipeline/convert.ts`, `transcribe.ts`, `retime.ts`: patterns to copy; their
  `outputs` become tagged objects.
- `apps/worker/src/pipeline/tools.ts`: `HYPERFRAMES_VERSION`, `hyperframesEnv`, `ToolPaths`.
- `apps/worker/src/pipeline/atomic.ts`: `writeAtomic` for `head-track.json`.
- `apps/worker/src/pipeline/fingerprint.ts`: `FileRef`, `cacheKey`.
- `apps/worker/src/pipeline/definition.test.ts`: order and status test, output names, settings-leaf
  and version fingerprint tests (they iterate `PIPELINE`, so they cover the new steps automatically
  once updated for the new output shape).
- `apps/worker/src/pipeline/run-pipeline.test.ts`: fake tools (`fakeTools`) and the step order and
  summary expectations; extend for the new tool calls.
- `apps/worker/src/pipeline/pipeline-fixtures.test.ts`: compares the manifest with `PIPELINE`
  (switch to `step.outputs.map((o) => o.file)`).
- `apps/worker/src/make-pipeline-fixtures.ts`: writes `fixtures/pipeline/`; switch to `.file`.
- `apps/worker/src/pipeline/tools-test-support.ts`: `CLIP`, `REAL_TOOLS`, `realTool`, ffprobe
  helpers; add `PERSON_CLIP` and an alpha probe helper.
- `apps/worker/src/pipeline/retime.tools.test.ts`: whole-pipeline tool test (now runs six steps).
- `apps/worker/src/step-store.ts`: `PipelineReelStatus`.
- `apps/worker/src/step-runner.ts`, `summary.ts`, `format.ts`: `runToolsStep` appends duration and
  output size to `what` (so steps return only `what`).
- `apps/worker/src/doctor-checks.ts`, `apps/worker/src/doctor.ts` (+ `doctor-checks.test.ts`): add a
  check that ffmpeg has the `libvpx-vp9` encoder and decoder.
- `apps/worker/vitest.tools.config.ts`: tool test config (10 minute timeout, enough for 4 s of
  background removal).
- `apps/studio/src/lib/reels.ts`, `apps/studio/src/lib/reels.test.ts`: `REEL_STATUSES` must match the
  check constraint.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: accepts each step's reel status.
- `apps/studio/e2e/upload.spec.ts`: seeds `fixtures/pipeline/`, expects the step lines and hits.
- `supabase/migrations/20261102090000_pipeline_steps.sql`: the current `reels_status_check` (do not
  edit; a new migration supersedes it).
- `fixtures/footage/short-person.mp4`: the person clip for tool tests 4 to 6. Read only; never
  touch, re-encode or replace it. If it is missing, stop and report.
- `fixtures/footage/short-speech.mp4`, `fixtures/pipeline/`: the E2E fixture clip and its committed
  step outputs.
- Read-only reference: `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/head_track.py`
  (the algorithm ported below), `head-track.json` (190 samples, 2 null), `subject.webm` (VP9,
  `ALPHA_MODE=1`, 53 MB). Never write there.

### New Files

- `apps/worker/src/pipeline/remove-background.ts`: the `remove_background` step and
  `removeBackgroundArgs`.
- `apps/worker/src/pipeline/remove-background.test.ts`: argument and settings tests (pure).
- `apps/worker/src/pipeline/head-track.ts`: pure head tracking (`HEAD_TRACK_SETTINGS`, `HeadSample`,
  `headSample`, `trackHead`, `headTrackWhat`).
- `apps/worker/src/pipeline/head-track.test.ts`: synthetic-frame unit tests.
- `apps/worker/src/pipeline/head-track-step.ts`: the `head_track` step (ffmpeg decode args, frame
  reader, writes `head-track.json`).
- `apps/worker/src/pipeline/preview-copies.ts`: the `preview_copies` step, `previewSourceArgs`,
  `previewSubjectArgs`, `PREVIEW_SETTINGS`.
- `apps/worker/src/pipeline/preview-copies.test.ts`: argument tests (pure).
- `apps/worker/src/pipeline/background.tools.test.ts`: tool tests 4 to 6 on `short-person.mp4`.
- `supabase/migrations/<stamp>_pipeline_background_head_previews.sql`: created with
  `supabase migration new pipeline_background_head_previews`.
- `fixtures/pipeline/remove_background/subject.webm`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/preview_copies/preview-source.mp4`, `preview-subject.webm`: regenerated by
  `fixtures:pipeline`, plus the updated `manifest.json`.

## Implementation Plan

### Phase 1: Foundation

- Confirm `fixtures/footage/short-person.mp4` exists (`ls -la`); if not, stop and report. Do not
  generate or download a substitute.
- Output tags: `export type OutputKeep = "kept" | "rebuildable"; export interface StepOutput { file:
string; keep: OutputKeep }`, `outputs: readonly StepOutput[]` in `PipelineStep`. Classification
  rule (B6): `converted.mp4` and `subject.webm` are `rebuildable` (heavy, rebuilt from the upload);
  every other output is `kept` (the transcripts, plan, envelope, head track are small; `source.mp4`
  is the render input; the preview copies cannot be regenerated cheaply). Update `run-pipeline.ts`,
  `make-pipeline-fixtures.ts`, `pipeline-fixtures.test.ts`, `definition.test.ts`,
  `run-pipeline.test.ts` for the new shape (no behaviour change; fingerprints unchanged because
  outputs are not in them).
- Reel statuses: new migration via `supabase migration new pipeline_background_head_previews`,
  dropping and re-adding `reels_status_check` with the existing list plus `removing_background`,
  `tracking_head`, `making_previews` (before `processed`). `PipelineReelStatus` and
  `REEL_STATUSES` (same order as the constraint) follow; `reels.test.ts` and
  `pipeline-statuses.test.ts` list the new statuses. Then `.adw/supabase-stack reset`.

### Phase 2: Core Implementation

- `remove-background.ts`:
  - `REMOVE_BACKGROUND_SETTINGS = { device: "auto", quality: "balanced", hyperframes: HYPERFRAMES_VERSION }`
    (a comment says the model is HyperFrames' current `u2net_human_seg`, fixed by the version, and
    stays until issue #20 is taken up).
  - `removeBackgroundArgs(input, output, settings)` returns `["remove-background", input, "-o",
output, "--device", settings.device, "--quality", settings.quality, "--json"]`.
  - Step: `name: "remove_background"`, `version: 1`, `reelStatus: "removing_background"`,
    `outputs: [{ file: "subject.webm", keep: "rebuildable" }]`, `reusedWhat: "background removed"`,
    input `{ step: "retime", fingerprint, file: "source.mp4" }` as `source.mp4`. `run`: call
    `tool({ file: node, args: [entry, ...removeBackgroundArgs(source, join(dir,
"subject.part.webm"), settings)], env: hyperframesEnv() })`, rename to `subject.webm`, return
    `{ what: "background removed" }` (the runner appends duration and size).
- `head-track.ts` (pure, no Node I/O imports):
  - `HEAD_TRACK_SETTINGS = { analysisWidth: 270, analysisHeight: 480, frameWidth: 1080,
frameHeight: 1920, samplesPerSecond: 4, alphaThreshold: 128, minRowPixels: 4, bandStart: 20,
bandEnd: 50, decoder: "libvpx-vp9", bounds: { minHeadTop: null, minHeadWidth: null,
maxHeadWidth: null } }` typed so bounds are `number | null`.
  - `type HeadSample = { t: number; head_top: number; cx: number; head_w: number } | null`.
  - `headSample(frame: Uint8Array, index, settings)`: exact port of `head_track.py`. For each row
    the opaque xs are those with `frame[(y * W + x) * 4 + 3] > alphaThreshold`; `top` is the first
    row with at least `minRowPixels` opaque; none gives `null`. Spans `(first, last)` of opaque xs
    for rows `top + bandStart` to `min(H, top + bandEnd) - 1` that have any; none gives `null`.
    Sort spans by width (stable), take index `floor(len / 2)`. Scale `sx = frameWidth /
analysisWidth`, `sy = frameHeight / analysisHeight`: `t = round(index / samplesPerSecond, 2)`,
    `head_top = top * sy`, `cx = floor((x0 + x1) / 2) * sx`, `head_w = (x1 - x0) * sx`. Then the
    bounds: each non-null bound that the sample breaks (`head_top < minHeadTop`, `head_w <
minHeadWidth`, `head_w > maxHeadWidth`) makes it `null`. Throws when the frame length is not
    `W * H * 4`.
  - `trackHead(frames: Iterable<Uint8Array>, settings): HeadSample[]`.
  - `headTrackWhat(samples)`: `head tracked, <n> samples, <m> without a head` (use singular
    `sample` for 1).
- `head-track-step.ts`:
  - `headTrackDecodeArgs(input, output, settings)`: `["-hide_banner", "-v", "error", "-y", "-c:v",
settings.decoder, "-i", input, "-vf", "fps=<samplesPerSecond>,scale=<W>:<H>", "-pix_fmt",
"rgba", "-f", "rawvideo", output]` (decoder before `-i`, same filter order as the reference).
  - Step: `name: "head_track"`, `version: 1`, `reelStatus: "tracking_head"`,
    `outputs: [{ file: "head-track.json", keep: "kept" }]`, `reusedWhat: "head tracked"`, input
    `remove_background`'s `subject.webm`. `run`: ffmpeg writes `frames.rgba` in `dir`; read it with a
    `FileHandle` one frame (`W * H * 4` bytes) at a time (a trailing partial frame is ignored, as in
    the reference), feed `trackHead`, `writeAtomic(join(dir, "head-track.json"),
JSON.stringify(samples) + "\n")`, delete `frames.rgba`, return `{ what: headTrackWhat(samples) }`.
  - The raw frames never go through stdout (`Tool` caps stdout at 64 KB).
- `preview-copies.ts`:
  - `PREVIEW_SETTINGS = { width: 540, height: 960, keyframeSeconds: 1, fps: 30, footage: {
codec: "libx264", preset: "medium", crf: 23, maxrate: "1500k", bufsize: "3000k", pixelFormat:
"yuv420p", audioCodec: "aac", audioBitrate: "128k", faststart: true }, cutout: { decoder:
"libvpx-vp9", codec: "libvpx-vp9", pixelFormat: "yuva420p", crf: 32, bitrate: "1300k",
deadline: "good", cpuUsed: 4 } }`. Budget: about 1.6 Mbit/s footage plus about 1.3 Mbit/s
    cut-out, about 18 MB for 50 s; `fps` is only the keyframe interval (`-g = fps *
keyframeSeconds`), never a filter or `-r`.
  - `previewSourceArgs(input, output, s)`: `-i input -map 0:v:0 -map 0:a:0? -vf scale=W:H
-fps_mode passthrough -c:v libx264 -preset -crf -maxrate -bufsize -pix_fmt yuv420p -g
-keyint_min -sc_threshold 0 -c:a aac -b:a 128k -movflags +faststart output`.
  - `previewSubjectArgs(input, output, s)`: `-c:v libvpx-vp9 -i input -map 0:v:0 -an -vf scale=W:H
-fps_mode passthrough -c:v libvpx-vp9 -pix_fmt yuva420p -crf 32 -b:v 1300k -deadline good
-cpu-used 4 -auto-alt-ref 0 -row-mt 1 -g -keyint_min output` (`-auto-alt-ref 0` is required for
    alpha in libvpx; the encoder writes `alpha_mode=1`).
  - Step: `name: "preview_copies"`, `version: 1`, `reelStatus: "making_previews"`, outputs
    `[{ file: "preview-source.mp4", keep: "kept" }, { file: "preview-subject.webm", keep: "kept" }]`,
    `reusedWhat: "preview copies made"`, inputs `retime`'s `source.mp4` and `remove_background`'s
    `subject.webm`. Both encodes to `*.part.*` names, renamed after exit 0. Returns
    `{ what: "preview copies made" }` (the runner appends duration and the two files' size).
- `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.
- `run-pipeline.ts` `contentType`: `.webm` gives `video/webm`.
- Doctor: `DoctorDeps.ffmpegCodecs` (`ffmpeg -hide_banner -encoders` and `-decoders` output) and a
  check line `ffmpeg codecs` failing when `libvpx-vp9` is missing from either; test it in
  `doctor-checks.test.ts` like the filters check.

### Phase 3: Integration

- Regenerate `fixtures/pipeline/` with `yarn workspace @edit-issebya/worker fixtures:pipeline` on the
  Mac (real HyperFrames and ffmpeg, still on `short-speech.mp4`, which has no person: the cut-out is
  transparent and every head sample is `null`, which is fine for an E2E cache seed). Commit the new
  folders and `manifest.json`; `pipeline-fixtures.test.ts` then passes. The convert, transcribe and
  retime fingerprints and files must be unchanged (check with `git diff --stat fixtures/pipeline`).
- `apps/studio/e2e/upload.spec.ts`: expect six step lines (`remove_background: background removed,
reused`, `head_track: head tracked, reused`, `preview_copies: preview copies made, reused`) and
  six `skipped` hits, then `processed`.
- The studio shows the new statuses with no other change (it renders `status` text); nothing to add
  beyond `REEL_STATUSES`.
- Docs and the profile sentence.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Check the person clip

- `ls -la fixtures/footage/short-person.mp4`. Missing: stop and report; never generate, download,
  re-encode or replace it.

### 2. Tag step outputs

- In `definition.ts` add `OutputKeep`, `StepOutput`, change `outputs` to `readonly StepOutput[]`.
- Convert `convert` (`converted.mp4` rebuildable), `transcribe` (`transcript.json` kept), `retime`
  (all four kept).
- Update `run-pipeline.ts` (`step.outputs.map(({ file }) => ...)`), `make-pipeline-fixtures.ts`,
  `pipeline-fixtures.test.ts`, `definition.test.ts` (distinct names over `.file`; inputs check uses
  `.map((o) => o.file)`), `run-pipeline.test.ts` (`outputKeys`, the `withoutConvert` case).
- Add to `definition.test.ts`: "tags heavy rebuildable outputs and keeps the rest": `subject.webm` and
  `converted.mp4` are `rebuildable`; `preview-source.mp4` and `preview-subject.webm` are `kept`;
  every output has a tag.

### 3. Reel statuses migration

- `supabase migration new pipeline_background_head_previews` (the only `supabase` command allowed
  besides `.adw/supabase-stack reset`). In the new file: a header comment as in
  `20261102090000_pipeline_steps.sql`, then `alter table public.reels drop constraint
reels_status_check, add constraint reels_status_check check (status in ('uploading', 'uploaded',
'received', 'converting', 'transcribing', 'retiming', 'removing_background', 'tracking_head',
'making_previews', 'processed', 'failed'));`.
- `step-store.ts`: `PipelineReelStatus` adds the three statuses.
- `apps/studio/src/lib/reels.ts` and `reels.test.ts`: same list, same order.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: accepts the three new statuses.
- `.adw/supabase-stack reset` (if it fails, report its error and stop).

### 4. Pure head tracking with tests

- Create `head-track.ts` as in Phase 2 and `head-track.test.ts`:
  - A helper builds a 270x480 RGBA frame (alpha 0) and draws a filled ellipse (alpha 255) with an
    integer centre `(cx0, cy0)` and integer radii `(rx, ry)`, a pixel opaque when
    `((x - cx0) / rx)^2 + ((y - cy0) / ry)^2 <= 1`.
  - Ellipse at a known position: `head_top` within 4 of `(cy0 - ry) * 4`, `cx` within 4 of `cx0 * 4`,
    `head_w` within 4 of the truth `4 * 2 * floor(rx * sqrt(1 - (dy / ry)^2))` where `dy` is the
    median band row (`top + 35` for a 30-row band) minus `cy0`; `t` of frame index 3 is `0.75`.
  - An empty frame gives `null`; a row with only 3 opaque pixels above the ellipse is ignored
    (`minRowPixels`); a shape with no opaque pixels in the band (a 1-row line of 10 pixels) gives
    `null`.
  - Pixels at alpha exactly 128 count as transparent (`> 128`).
  - Bounds: with `bounds.minHeadTop` above the sample's `head_top`, or `maxHeadWidth` below its
    `head_w`, the sample becomes `null`; with the default (all `null`) the same sample is kept.
  - `trackHead` over `[ellipse, empty, ellipse]` gives `[sample, null, sample]` with `t` `0`, `0.25`,
    `0.5`; a frame of the wrong length throws.
  - `headTrackWhat` text for 197 samples with 3 null: `head tracked, 197 samples, 3 without a head`.

### 5. The three steps

- Create `remove-background.ts`, `head-track-step.ts`, `preview-copies.ts` as in Phase 2, and add
  them to `PIPELINE` in order. Add `.webm` to `contentType`.
- `remove-background.test.ts`: `removeBackgroundArgs` exact array (`-o` path, `--device auto`,
  `--quality balanced`, `--json`); settings carry `HYPERFRAMES_VERSION`.
- `preview-copies.test.ts`: both arg arrays use `scale=540:960`, `-fps_mode passthrough`, no `-r`
  and no `fps=` filter; the WebM decodes with `-c:v libvpx-vp9` before `-i`, encodes `yuva420p`
  with `-auto-alt-ref 0` and `-an`; `-g 30`.
- In `head-track-step.ts` export `headTrackDecodeArgs` and test it in `head-track.test.ts` or a small
  `head-track-step.test.ts`: decoder before `-i`, `fps=4,scale=270:480`, `rgba`, `rawvideo`.
- `definition.test.ts`:
  - order test: six steps with statuses `converting`, `transcribing`, `retiming`,
    `removing_background`, `tracking_head`, `making_previews`.
  - new test "changing the HyperFrames version of background removal changes it and every later
    step": replace `remove_background`'s settings with `{ ...settings, hyperframes: "0.0.0" }`;
    convert, transcribe and retime fingerprints unchanged, `remove_background`, `head_track` and
    `preview_copies` changed (use `expectOnlyFromChanged`). The existing every-leaf and version tests
    cover the other settings automatically.

### 6. Run-pipeline test fakes

- Extend `fakeTools` in `run-pipeline.test.ts`: HyperFrames calls branch on `call.args[1]`
  (`transcribe` writes the transcript as now; `remove-background` writes a file at `-o`); an ffmpeg
  call with `-f rawvideo` writes two frames of `270 * 480 * 4` bytes (one with an opaque block, one
  empty) to its last argument; other ffmpeg calls stay as they are.
- Update every expected status and call shape to the six steps, the hit counts and the first-run
  summary prefixes (`background removed`, `head tracked`, `preview copies made`). The "version bump
  re-runs a step and every later one" and resume tests keep passing with six steps.
- Add an assertion that the stored `head-track.json` is `[{...}, null]` from the fake frames and
  that `subject.webm` was uploaded with content type `video/webm` (if the folder fake exposes it;
  otherwise skip that half).

### 7. Doctor codec check

- Add `ffmpegCodecs` to `DoctorDeps` and `doctor.ts`, the `ffmpeg codecs` line requiring
  `libvpx-vp9` among encoders and decoders, and its pass and fail tests in `doctor-checks.test.ts`.

### 8. Tool tests on the person clip

- `tools-test-support.ts`: `export const PERSON_CLIP = new URL("../../../../fixtures/footage/short-person.mp4", import.meta.url).pathname;`
  and a helper returning the first video stream's `codec_name`, `width`, `height`, `pix_fmt`,
  `tags.alpha_mode` (case-insensitive `ALPHA_MODE`) and the format duration.
- `background.tools.test.ts` (one temp folder in `beforeAll`, steps run directly through their `run`
  with `realTool`, in order, sharing outputs; `PERSON_CLIP` is already H.264 30 fps 1080x1920, so it
  stands in for the retimed `source.mp4`):
  - 4: `removeBackground.run` writes `subject.webm`; ffprobe says `vp9`, and `alpha_mode` is `1` or
    a decode with `-c:v libvpx-vp9` reports `yuva420p`; a middle frame (`-ss 2`) decoded to `rgba`
    rawvideo has both alpha 0 and alpha 255 pixels.
  - 5: `headTrack.run` on that cut-out: at least 80% of samples non-null, every `cx` in `[0, 1080)`.
  - 6: `previewCopies.run`: both outputs 540x960; each duration within `1 / 30` s of the clip's;
    `preview-subject.webm` keeps alpha (same check as 4).
- `retime.tools.test.ts`: its whole-pipeline run now goes through six steps; adjust any assertion
  that lists steps or summaries.

### 9. Regenerate the E2E fixtures and extend the spec

- `yarn workspace @edit-issebya/worker fixtures:pipeline` (Mac). Confirm the first three steps'
  fingerprints and files did not change and the three new folders appeared; commit them.
- `apps/studio/e2e/upload.spec.ts`: six step lines and `hit(...)` rows in order (`convert`,
  `transcribe`, `retime`, `remove_background`, `head_track`, `preview_copies`), then `processed`.
  This fails without the feature (three lines only).

### 10. Documentation

- `app_docs/pipeline.md`: title and overview to six steps; add the specification link for this plan;
  a bullet per new file; the reel statuses; a "Head track" section with the format, the algorithm
  (port of `head_track.py`), settings and the off-by-default bounds; preview sizes and settings and
  the 18 MB target; the `kept` and `rebuildable` tags with the classification; doctor's codec check;
  Testing (new pure tests, `background.tools.test.ts` on `short-person.mp4`, six hits in E2E,
  fixtures still from `short-speech.mp4`); Rules: "Background removal stays on HyperFrames' current
  u2net model (`u2net_human_seg`): no Apple Vision, no mask as H.264, no frame-reader patch, no
  decode-size change, until issue #20 is taken up." and "Never touch
  `fixtures/footage/short-person.mp4`."; Notes: head track on non-9:16 footage is scaled to the
  1080x1920 frame; the scratch `frames.rgba` is about 100 MB for 50 s.
- `docs/conditional-docs.md`: widen the pipeline line to "the pipeline steps (convert, transcribe,
  retime, remove background, head track, preview copies), ... the head-track format, preview copies,
  output kept or rebuildable tags, ...".
- `app_docs/studio.md`: add the three statuses wherever the reel statuses are listed.
- `.adw/project.md` Tests: the tool tests run "on the committed clips (`short-speech.mp4`,
  `short-person.mp4`)". No heading changes.
- No em-dashes anywhere.

### 11. Validation

- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `head-track.test.ts`: the pure function on synthetic RGBA frames (position within 4 px, empty frame,
  thresholds, band, bounds on and off, `t` values, wrong length, summary text), and the decode args.
- `definition.test.ts`: six steps and statuses in order; HyperFrames version change propagates to
  `head_track` and `preview_copies`; output tags; existing leaf and version tests over the new steps.
- `remove-background.test.ts`, `preview-copies.test.ts`: exact tool arguments.
- `run-pipeline.test.ts`: six steps on a first run, hits on a second, resume, version bump, clean-up
  with the extended fake tools.
- `doctor-checks.test.ts`: the codec check.
- `reels.test.ts` (studio): statuses match the new constraint.

### Test Coverage

- Unit (`yarn test`): `head-track.test.ts` catches any wrong head position, width, null handling or
  bounds behaviour in the port; nothing tests head tracking today.
- Unit: `definition.test.ts` "HyperFrames version" case catches a later step not declaring
  `subject.webm` as an input (its fingerprint would not change); the tags case catches a missing or
  wrong `kept`/`rebuildable` tag.
- Unit: `run-pipeline.test.ts` catches the new steps not running, not being cached or not resuming.
- DB (`test:db`): `pipeline-statuses.test.ts` catches the constraint rejecting the new statuses.
- Tools (`test:tools`, Mac): `background.tools.test.ts` catches a cut-out without alpha, a broken
  decode for head tracking, wrong preview size, timing or lost alpha.
- E2E (`yarn test:e2e`): `upload.spec.ts` catches the six steps not all being hits or the reel not
  reaching `processed` with the live step lines.

### Edge Cases

- A frame with no opaque pixels, or only a thin top line (no band rows): `null`.
- Alpha exactly at the threshold; a row with fewer than `minRowPixels` opaque pixels above the head.
- A head near the bottom so the band is cut at the frame edge (`min(H, top + bandEnd)`).
- A trailing partial frame in `frames.rgba`: ignored.
- Bounds partially set (only `maxHeadWidth`).
- A cached `subject.webm` with missing previews: only `preview_copies` re-runs (resume).
- HyperFrames failing: the step fails with its tail; the retry resumes at `remove_background`.
- Footage without audio for the preview (`-map 0:a:0?`).
- Footage that is not 1080x1920 (the E2E clip is 720x1280): scaled to 540x960 and the head track to
  1080x1920 coordinates.

## Acceptance Criteria

- `PIPELINE` is convert, transcribe, retime, remove_background, head_track, preview_copies, with reel
  statuses ending `removing_background`, `tracking_head`, `making_previews`, then `processed`.
- Each new step declares its inputs, settings and version; a changed HyperFrames version changes the
  background, head-track and preview fingerprints and leaves the first three unchanged.
- `subject.webm` and `converted.mp4` are tagged `rebuildable`; both preview copies and every other
  output `kept`.
- The head-tracking function is pure and its tests pass without ffmpeg.
- On `short-person.mp4` (Mac): the cut-out is VP9 with alpha and a middle frame has fully transparent
  and fully opaque pixels; at least 80% of head samples non-null with `cx` inside the frame; both
  previews 540x960, durations within one frame, the WebM keeps alpha.
- The E2E upload spec shows six `..., reused` lines and `processed`.
- Summary lines read `background removed, <duration>, <size>`, `head tracked, <n> samples, <m>
without a head, <duration>, <size>`, `preview copies made, <duration>, <size>`.
- `app_docs/pipeline.md` documents the steps, settings, head-track format, preview sizes, tags and the
  background-model rule; the conditional-docs line is widened, no new line.
- Background removal uses HyperFrames' unchanged `remove-background`; nothing from issue #20.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `ls -la fixtures/footage/short-person.mp4`: the person clip exists (stop if not).
- `.adw/supabase-stack reset`: applies the new migration to the ADW stack before DB and E2E tests.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio`: lint both touched apps.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio`: the new output shape and
  statuses typecheck everywhere.
- `yarn knip`: no unused exports from the new modules.
- `yarn format:check`: Prettier over the repository, including the plan and docs.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio`: unit tests (head tracking,
  definition, run-pipeline, fixtures freshness, doctor, statuses).
- `yarn workspace @edit-issebya/worker test:tools`: real HyperFrames and ffmpeg on the committed
  clips (owner's Mac only).
- `yarn turbo run test:db --filter=./apps/studio`: the new reel statuses are accepted.
- `yarn turbo run build --filter=./apps/worker --filter=./apps/studio`: studio build (worker check is
  its typecheck).
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's full gate, unfiltered.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E
  suites, including the six-hit upload spec (with the `/prepare_app` server up on this run's port).

## Notes

- No new dependency: HyperFrames 0.8.222 (pinned) already has `remove-background`; ffmpeg needs
  `libvpx-vp9` (present on the owner's Mac; doctor now checks it).
- Fixtures stay on `short-speech.mp4` so the E2E clip, its ETag and the first three fingerprints do
  not change and the repository grows only by the small transparent cut-out and previews. That clip
  has no person, so its committed head track is all `null`; the person clip is used by tool tests
  only and is never re-encoded.
- The device setting is the literal `auto`, so a CoreML and a CPU run share a fingerprint; acceptable
  for one worker machine, documented in Notes of the doc.
- The preview bitrate settings are a first estimate for the 18 MB target; the owner's manual run on
  `rethink-work` confirms the size (changing them later means a version bump and
  `fixtures:pipeline`).
- Manual acceptance (owner, not the pipeline): compare the cut-out with `rethink-work/subject.webm`
  at 10 s and 25 s, the head track with `rethink-work/head-track.json` (190 samples), and the step
  times with issue #20 (about 7 minutes for background removal).
- No browser review surface changes: the studio only shows new status and step-line text, covered by
  the extended E2E spec; no screenshots needed beyond the profile's standard review.
- Out of scope: faster background removal (#20), background progress percentage (slice 15), deleting
  rebuildable files (slice 14), the builder (slice 8).
