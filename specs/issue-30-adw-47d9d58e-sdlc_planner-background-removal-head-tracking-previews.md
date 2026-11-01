# Feature: fixed pipeline steps part two: background removal, head tracking, preview copies

## Metadata

issue_number: `30`
adw_id: `47d9d58e`
issue_json: `{"number":30,"title":"feat: fixed pipeline steps part two: background removal, head tracking, preview copies"}`

## Feature Description

Reel studio MVP, slice 7 of 17. After `convert`, `transcribe` and `retime` (slice 6, #29) the
worker's `process` job runs three more fixed steps, all plain TypeScript with no AI, all cached in R2
under a fingerprint exactly like the first three:

1. `remove_background`: HyperFrames' `remove-background` (its current u2net model,
   `u2net_human_seg`) on the retimed `source.mp4`, giving the full-size cut-out of the speaker
   `subject.webm` (VP9 with alpha).
2. `head_track`: a TypeScript port of the old `head_track.py`: ffmpeg decodes the cut-out (the
   `libvpx-vp9` decoder, so alpha survives) to RGBA at 270x480 and 4 fps, and a pure function turns
   each frame into a head sample `{ t, head_top, cx, head_w }` (1080x1920 coordinates) or `null`.
   Output `head-track.json`. The builder (slice 8) places captions around the head from it.
3. `preview_copies`: a small H.264 copy of the retimed footage (`footage-preview.mp4`) and a small
   VP9-alpha copy of the cut-out (`subject-preview.webm`), both 540x960, same frame timing as the
   source, about 18 MB together for a 50 s reel. The studio's live preview (D5) will play them.

Every output is tagged `kept` or `rebuildable` in its step definition, so slice 14's cleanup can act
on the tag. The reel moves through `removing_background`, `tracking_head`, `making_previews`, then
`processed`. After this slice a processed reel has everything the builder and the preview need
except the edit itself.

## User Story

As the studio owner processing a client's reel
I want the worker to cut the speaker out, track their head and make small preview copies once per input
So that the builder can place captions around the head and the studio can preview the reel, without any step ever running twice

## Problem Statement

The pipeline stops at `retime`. The cut-out, the head track and the preview copies are still made by
hand with the old scripts in another repository. Background removal is the slowest step (about seven
minutes for a 50 s reel), so it must be cached and resumable like the others, and slice 14 needs to
know which outputs are cheap to rebuild and which must be kept.

## Solution Statement

Add three `PipelineStep`s to `apps/worker/src/pipeline/` following the exact shape of `convert`,
`transcribe` and `retime`: declared inputs (`FileRef`s to earlier outputs), a settings object that is
part of the fingerprint, a hand-bumped `version`, a reel status, outputs and a `run` that only uses
the `tool` the measuring step runner gives it. `run-pipeline.ts` already does hits, downloads,
put-if-absent uploads and resume; it needs only a `video/webm` content type and the new output shape.

The output list changes from `readonly string[]` to `readonly StepOutput[]`
(`{ file, retention: "kept" | "rebuildable" }`), so the type system forces a tag on every output.
Head tracking is split into a pure module (`head-track.ts`: frame in, sample out, bounds filter)
with ffmpeg-free unit tests, and the step (`head-track-step.ts`) which writes raw RGBA frames to a
file through ffmpeg (stdout through the step runner is capped at 64 KB and line-split, so it cannot
carry frames) and reads it back one frame at a time, so memory stays at one frame.

A new migration adds the three reel statuses. `fixtures/pipeline/` is regenerated (still from
`fixtures/footage/short-speech.mp4`), so the E2E upload spec sees six hits.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (Yarn only, no em-dashes, migrations via
  `supabase migration new`, conventional commits without trailers).
- `.adw/project.md`: profile; Tests (`test:tools` for the worker), Protected (never touch
  `fixtures/footage/short-person.mp4`, only `supabase migration new` and `.adw/supabase-stack reset`).
- `docs/conditional-docs.md`: the `app_docs/pipeline.md` line is widened (no new line).
- `app_docs/pipeline.md`: the feature doc, extended in place (steps, settings, head-track format,
  preview sizes, tags, the background-model rule). Its Rules are invariants: declare every input,
  never overwrite an output, HyperFrames never via npx and always `HYPERFRAMES_NO_TELEMETRY=1`,
  bump versions and re-run `fixtures:pipeline`, never write to `issebya-homes-reels`.
- `app_docs/measurement.md`: the summary line rules (`what, duration, size`) the new summaries use.
- `app_docs/studio.md`: reel statuses and worker description (touch only where statuses are listed).
- `apps/worker/src/pipeline/definition.ts`: `PipelineStep`, `PIPELINE`, `fingerprintsFor`; add
  `StepOutput`, the three steps and a `outputFiles(step)` helper.
- `apps/worker/src/pipeline/definition.test.ts`: order and status test, settings-leaf and version
  fingerprint tests (`expectOnlyFromChanged` must become dependency-aware, see Notes).
- `apps/worker/src/pipeline/run-pipeline.ts`, `run-pipeline.test.ts`: output keys, `contentType`
  (add `.webm`), the fake pipelines in tests that use `outputs: string[]`.
- `apps/worker/src/pipeline/convert.ts`, `transcribe.ts`, `retime.ts`: tag their outputs.
- `apps/worker/src/pipeline/tools.ts`: `HYPERFRAMES_VERSION`, `hyperframesEnv`, `ToolPaths`.
- `apps/worker/src/pipeline/tools-test-support.ts`: add `PERSON_CLIP`, an ffprobe stream helper with
  tags, a raw-frame decode helper.
- `apps/worker/src/pipeline/retime.ts`, `convert.ts`: the patterns to copy (temporary `*.part.*`
  name then rename, `writeAtomic`, eslint disables for scratch-folder fs calls).
- `apps/worker/src/pipeline/atomic.ts`: `writeAtomic` for `head-track.json`.
- `apps/worker/src/pipeline/pipeline-fixtures.test.ts`, `apps/worker/src/make-pipeline-fixtures.ts`,
  `fixtures/pipeline/manifest.json`: the committed outputs; use `outputFiles(step)`.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus` gains the three statuses.
- `apps/worker/src/step-runner.ts`: `runToolsStep` (summary is `what, duration, bytes_out`), the 64 KB
  stdout cap.
- `apps/worker/src/summary.ts`: `stepSummary`, `formatDuration`.
- `apps/worker/src/doctor-checks.ts`, `doctor-checks.test.ts`: add the codec check.
- `apps/worker/vitest.tools.config.ts`: tool tests include pattern (`*.tools.test.ts`).
- `apps/studio/src/lib/reels.ts`, `reels.test.ts`: `REEL_STATUSES` mirrors the check constraint.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: accepts each step's reel status.
- `apps/studio/e2e/upload.spec.ts`: seeds `fixtures/pipeline/` and asserts the step lines and rows.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: the previous status constraint (copy its
  list, never edit it).
- `node_modules/hyperframes/dist/remove-background-*.js`: the CLI's flags and `--json` output
  `{ ok, outputPath, framesProcessed, durationSeconds, avgMsPerFrame, provider, format }`; the
  format is inferred from the output extension, so the temporary name must end in `.webm`.
- Reference, read only: `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/head_track.py`
  and its `head-track.json` (array of `{t, head_top, cx, head_w}` or `null`).

### New Files

- `apps/worker/src/pipeline/remove-background.ts` (+ `remove-background.test.ts`): the step, its
  settings, `removeBackgroundArgs`, `parseRemoveBackgroundResult`.
- `apps/worker/src/pipeline/head-track.ts` (+ `head-track.test.ts`): pure: `HEAD_TRACK_SETTINGS`,
  `HeadSample`, `headSample(rgba, t, settings)`, `withinBounds`, `headTrackWhat`.
- `apps/worker/src/pipeline/head-track-step.ts` (+ `head-track-step.test.ts` for the decode args):
  the step: `headTrackDecodeArgs`, frame-by-frame reading of the raw file.
- `apps/worker/src/pipeline/preview-copies.ts` (+ `preview-copies.test.ts`): the step,
  `PREVIEW_SETTINGS`, `footagePreviewArgs`, `subjectPreviewArgs`.
- `apps/worker/src/pipeline/cutout.tools.test.ts`: tool tests 4 to 6 on `short-person.mp4`.
- `supabase/migrations/<stamped>_pipeline_steps_part_two.sql` via `supabase migration new pipeline_steps_part_two`.
- `fixtures/pipeline/remove_background/subject.webm`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/preview_copies/footage-preview.mp4`, `fixtures/pipeline/preview_copies/subject-preview.webm`
  (generated by `fixtures:pipeline`, never by hand).

## Implementation Plan

### Phase 1: Foundation

- Output tags: `StepOutput = { file: string; retention: OutputRetention }`,
  `OutputRetention = "kept" | "rebuildable"`, `outputFiles(step)`; migrate convert, transcribe,
  retime, `run-pipeline.ts`, `make-pipeline-fixtures.ts` and the tests to it. Existing tags:
  `converted.mp4` rebuildable (B6), `transcript.json` (transcribe) kept, retime's `source.mp4`
  rebuildable (heavy, deterministic from the kept upload), retime's JSON files kept (small).
  Tagging does not change any fingerprint (tags are not in `{ inputs, settings, version }`), so the
  first three fixtures stay valid.
- Reel statuses: migration and the three mirrors (`PipelineReelStatus`, `REEL_STATUSES`, db-test).

### Phase 2: Core Implementation

- `remove_background`, the pure head tracker and its step, `preview_copies`, each with pure tests of
  their arguments and parsing.

### Phase 3: Integration

- `PIPELINE` gains the three steps in order, `run-pipeline.ts` gets `video/webm`, the doctor checks
  the codecs, `fixtures:pipeline` regenerates the fixtures, the E2E spec expects six hits, tool tests
  run on the person clip, docs updated.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Check the test clip is present

- `test -f fixtures/footage/short-person.mp4`. If it is missing, stop and report it; never generate,
  download or re-encode a substitute. Never write to that file at any point.

### 2. Tag outputs in the step definition

- In `definition.ts` add `export type OutputRetention = "kept" | "rebuildable"`,
  `export interface StepOutput { file: string; retention: OutputRetention }`, change
  `PipelineStep.outputs` to `readonly StepOutput[]`, and add
  `export function outputFiles(step: PipelineStep): string[]`.
- Doc comment on `retention`: `kept` cannot be regenerated cheaply and stays; `rebuildable` is heavy
  and may be deleted by slice 14's cleanup, since its step re-runs from the fingerprint.
- `convert.ts`: `[{ file: "converted.mp4", retention: "rebuildable" }]`. `transcribe.ts`:
  `transcript.json` kept. `retime.ts`: `source.mp4` rebuildable, `transcript.json`, `retime.json`,
  `envelope.json` kept.
- `run-pipeline.ts`: use `.file` wherever `step.outputs` is mapped; add
  `if (file.endsWith(".webm")) return "video/webm";` to `contentType`.
- `make-pipeline-fixtures.ts` and `pipeline-fixtures.test.ts`: use `outputFiles(step)`; keep the
  manifest shape (`files: string[]`) unchanged so `upload.spec.ts` keeps reading it.
- `run-pipeline.test.ts` and `definition.test.ts`: update fake steps and output assertions to the new
  shape (for example `outputs: [] as StepOutput[]`).

### 3. Reel statuses

- Run `supabase migration new pipeline_steps_part_two` (the only allowed way; never hand-pick the
  version). In the file: a header comment in the style of `20261101100000_pipeline_steps.sql`
  (no em-dashes), then drop and re-add `reels_status_check` with the previous list plus
  `removing_background`, `tracking_head`, `making_previews` (placed after `retiming`, before
  `processed`). `steps.status` is unchanged.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus` adds the three values.
- `apps/studio/src/lib/reels.ts` `REEL_STATUSES` and `reels.test.ts`: the same order as the constraint.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: the accepted list adds the three statuses.
- Run `.adw/supabase-stack reset` (before `test:db` and E2E; if it fails, report and stop).

### 4. `remove_background` step (`remove-background.ts`)

- `REMOVE_BACKGROUND_VERSION = 1`. `REMOVE_BACKGROUND_SETTINGS = { device: "auto", quality: "balanced", hyperframes: HYPERFRAMES_VERSION }`.
  The model is not a flag: HyperFrames 0.8.222's default (`u2net_human_seg`) is pinned by the
  HyperFrames version, which is why that version is a setting. Comment: per D4 the model stays as it
  is in the MVP; faster methods are issue #20, not here.
- `removeBackgroundArgs(input, output, settings)`:
  `["remove-background", input, "-o", output, "--device", settings.device, "--quality", settings.quality, "--json"]`.
- `parseRemoveBackgroundResult(stdout)`: the last non-empty stdout line parsed as JSON; throw with a
  clear message unless `ok === true` and `framesProcessed` is a positive number; return
  `{ framesProcessed, provider }`.
- Step: name `remove_background`, `reelStatus: "removing_background"`,
  `outputs: [{ file: "subject.webm", retention: "rebuildable" }]`, `reusedWhat: "background removed"`,
  input `{ step: "retime", fingerprint: fingerprints.retime, file: "source.mp4" }` as `source.mp4`.
  `run`: `tool({ file: node, args: [entry, ...removeBackgroundArgs(files["source.mp4"], join(dir, "subject.part.webm"), settings)], env: hyperframesEnv() })`,
  parse, `rename` to `subject.webm`, return `{ what: "background removed" }` (the runner appends
  duration and size: `background removed, 6 minutes 47 seconds, 51.0 MB`).
- `remove-background.test.ts` (pure): the exact argument list, the default settings, parsing a good
  line, a `{ ok: false, ... }` line and garbage stdout throwing.

### 5. Pure head tracker (`head-track.ts`)

- `HEAD_TRACK_SETTINGS = { analysisWidth: 270, analysisHeight: 480, frameWidth: 1080, sampleSeconds: 0.25, alphaThreshold: 128, minOpaquePixels: 4, widthBandStart: 20, widthBandEnd: 50, bounds: { minHeadTop: null, minHeadWidth: null, maxHeadWidth: null } }`,
  typed so each bound is `number | null` (`HeadTrackSettings`). `scale = frameWidth / analysisWidth` (4).
- `HeadSample = { t: number; head_top: number; cx: number; head_w: number }`; the file is
  `(HeadSample | null)[]` (the old format, so it compares directly with `rethink-work/head-track.json`).
- `headSample(rgba: Uint8Array, t: number, settings): HeadSample | null`, an exact port of
  `head_track.py`: throw if `rgba.length !== w*h*4`; for each row the opaque xs are those with alpha
  `> alphaThreshold`; the top is the first row with at least `minOpaquePixels` opaque pixels, else
  `null`; for rows `top + widthBandStart` to `min(h, top + widthBandEnd) - 1`, each row with any
  opaque pixel gives the span `(first x, last x)`; none gives `null`; sort spans by width (stable),
  take index `floor(n / 2)`; return
  `{ t: round(t, 2), head_top: top*scale, cx: floor((x0+x1)/2)*scale, head_w: (x1-x0)*scale }`.
- `withinBounds(sample, bounds)`: `null` stays `null`; a sample with `head_top < minHeadTop`,
  `head_w < minHeadWidth` or `head_w > maxHeadWidth` (each only when that bound is a number) becomes
  `null`. Comment: the reference values (380, 220, 420) were for one room (an arch merged into the
  head) and are not the default.
- `headTrackWhat(samples)`: `head tracked, <n> samples, <k> without a head` (plural-safe:
  `1 sample`, `1 without a head`).
- `head-track.test.ts`, synthetic frames built in the test (no ffmpeg): an opaque ellipse (alpha 255,
  rest 0) at a known centre and semi-axes gives `head_top`, `cx`, `head_w` within 4 px of the
  truth computed in 1080 coordinates (top = (cy - ry) * 4, cx = cx * 4, width at the band's middle
  row); an empty frame gives `null`; alpha exactly 128 counts as transparent; a top row with 3
  opaque pixels is skipped; a head reaching the bottom edge (band clipped) still works; a sample
  outside set bounds becomes `null` and the same sample with all bounds `null` is kept; wrong buffer
  length throws; `headTrackWhat` wording.

### 6. `head_track` step (`head-track-step.ts`)

- `HEAD_TRACK_VERSION = 1`, settings `HEAD_TRACK_SETTINGS`, name `head_track`,
  `reelStatus: "tracking_head"`, `outputs: [{ file: "head-track.json", retention: "kept" }]`,
  `reusedWhat: "head tracked"`, input remove_background's `subject.webm`.
- `headTrackDecodeArgs(input, output, settings)`:
  `["-hide_banner", "-v", "error", "-y", "-c:v", "libvpx-vp9", "-i", input, "-an", "-vf", "fps=<1/sampleSeconds>,scale=<w>:<h>", "-pix_fmt", "rgba", "-f", "rawvideo", output]`
  (the decoder before `-i` keeps alpha; `fps=4` for 0.25 s).
- `run`: ffmpeg to `frames.rgba` in the step dir; open it and read `w*h*4` bytes at a time (a
  `FileHandle` loop, never the whole file at once); frame `i` is `t = i * sampleSeconds`; a trailing
  partial frame throws; `withinBounds(headSample(...))` per frame; delete `frames.rgba`; write
  `head-track.json` with `writeAtomic` (`JSON.stringify(samples)` plus a newline); return
  `{ what: headTrackWhat(samples) }`. Zero frames throws (`head_track: the cut-out decoded to no frames`).
- `head-track-step.test.ts`: the exact decode argument list (`-c:v libvpx-vp9` before `-i`,
  `fps=4,scale=270:480`, `rgba`, `rawvideo`).

### 7. `preview_copies` step (`preview-copies.ts`)

- `PREVIEW_VERSION = 1`. `PREVIEW_SETTINGS = { width: 540, height: 960, keyframeSeconds: 1, fps: 30, footage: { videoCodec: "libx264", preset: "medium", videoBitrate: "1200k", maxrate: "1500k", bufsize: "3000k", pixelFormat: "yuv420p", audioCodec: "aac", audioBitrate: "128k", faststart: true }, subject: { videoCodec: "libvpx-vp9", videoBitrate: "1400k", pixelFormat: "yuva420p", deadline: "good", cpuUsed: 4 } }`.
  Comment: about 2.7 Mbit/s together, so about 17 to 18 MB for a 50 s reel (D5); built for Chrome.
- `footagePreviewArgs(input, output, s)`: `-i input -map 0:v:0 -map 0:a:0? -vf scale=W:H -fps_mode passthrough -c:v libx264 -preset -b:v -maxrate -bufsize -pix_fmt yuv420p -g <fps*keyframeSeconds> -keyint_min same -sc_threshold 0 -c:a aac -b:a 128k -movflags +faststart output`.
- `subjectPreviewArgs(input, output, s)`: `-c:v libvpx-vp9 -i input -an -vf scale=W:H,format=yuva420p -fps_mode passthrough -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 1400k -deadline good -cpu-used 4 -row-mt 1 -auto-alt-ref 0 -g <gop> -metadata:s:v:0 alpha_mode=1 output`
  (`-auto-alt-ref 0` is required for VP9 alpha; the decoder before `-i` keeps alpha in).
- Step: name `preview_copies`, `reelStatus: "making_previews"`, outputs
  `footage-preview.mp4` and `subject-preview.webm`, both `kept`; `reusedWhat: "preview copies made"`;
  inputs retime's `source.mp4` and remove_background's `subject.webm`. `run`: both encodes to
  `*.part.mp4` / `*.part.webm`, rename after exit 0, return `{ what: "preview copies made" }`
  (runner appends `, <duration>, 18.0 MB`).
- `preview-copies.test.ts`: both argument lists, same size in both, the alpha flags present on the
  WebM and the GOP from the settings.

### 8. Wire the pipeline

- `definition.ts`: `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.
- `definition.test.ts`:
  - order and statuses test lists six `[name, reelStatus]` pairs.
  - output tags test: `subject.webm` is `rebuildable`, both preview files `kept`, `head-track.json`
    `kept`, `converted.mp4` `rebuildable`; every output of every step has a tag (runtime check too).
  - generalise `expectOnlyFromChanged`: the expected changed set is the changed step plus every step
    whose inputs reference a changed step (transitively, computed from `step.inputs(SOURCE, fps)`),
    others equal. This keeps every existing leaf and version test meaningful.
  - explicit test (verification 2): replacing `remove_background`'s settings with
    `hyperframes: "0.0.0-changed"` changes `remove_background`, `head_track` and `preview_copies`
    fingerprints and leaves `convert`, `transcribe`, `retime` equal (transcribe has its own
    `hyperframes` setting, untouched).
- `run-pipeline.test.ts`: the default-pipeline tests (hits spawn nothing, statuses order) now cover six
  steps; add an assertion that a `.webm` output is put with `video/webm`.

### 9. Doctor

- `doctor-checks.ts`: `DoctorDeps` gains `ffmpegCodecs: () => Promise<string>` (`ffmpeg -hide_banner -encoders` and `-decoders`
  joined, wired in `doctor.ts`); a check line `ffmpeg codecs` requires encoders `libx264`,
  `libvpx-vp9` and decoder `libvpx-vp9`, failing with `missing ...`.
- `doctor-checks.test.ts`: present and missing cases.

### 10. Tool tests (`cutout.tools.test.ts`, on the Mac)

- `tools-test-support.ts`: `PERSON_CLIP` (`fixtures/footage/short-person.mp4`, read only), a
  `streamInfo(path)` returning `codec_name`, `width`, `height`, `pix_fmt`, `tags`, a
  `formatDuration(path)` and `decodeFrameRgba(path, seconds, w, h)` (with `-c:v libvpx-vp9` for webm).
- `beforeAll`: copy nothing; run the three steps' `run` in a `mkdtemp` folder with `realTool`, in
  order (`remove_background` on `PERSON_CLIP` as `source.mp4`, then `head_track`, then
  `preview_copies`), keeping outputs for the tests.
- Test 4: `subject.webm` is `vp9`, and its `ALPHA_MODE`/`alpha_mode` tag is `1` or the libvpx-decoded
  `pix_fmt` is `yuva420p`; the decoded frame at 2 s has at least one alpha 0 pixel and at least one
  alpha 255 pixel; `remove-background --info --json` reports `defaultModel` `u2net_human_seg` (the D4
  rule, caught on a HyperFrames upgrade).
- Test 5: at least 80 percent of samples non-null; every non-null `cx` in `[0, 1080)`; sample count is
  about duration / 0.25 (16 or 17).
- Test 6: both previews are 540x960; each duration equals the source's within 1/30 s; the WebM keeps
  alpha (same check as test 4).

### 11. Regenerate `fixtures/pipeline/`

- `yarn workspace @edit-issebya/worker fixtures:pipeline` (unchanged clip `short-speech.mp4`, which
  has no person: the cut-out is transparent and every head sample `null`, fine for cache hits). Commit
  the four new files and the updated `manifest.json`. The first three steps' files must come out
  byte-identical (their fingerprints did not change); if `git diff --stat fixtures/pipeline/` shows
  them changed, investigate before going on.
- `yarn workspace @edit-issebya/worker test` must pass `pipeline-fixtures.test.ts`.

### 12. E2E: extend `apps/studio/e2e/upload.spec.ts`

- Expected step lines: add `remove_background: background removed, reused`,
  `head_track: head tracked, reused`, `preview_copies: preview copies made, reused`.
- Expected rows: six `hit(...)` entries in order. Reel status still ends `processed`. Seeding is
  manifest-driven, so no seeding code changes. Fails without the feature (three rows only).

### 13. Documentation

- `app_docs/pipeline.md`: title and overview to six steps; add the spec path; statuses list; one
  bullet per new module (args, settings, outputs and their tags); a "Head-track format" subsection
  (array per 0.25 s, `{t, head_top, cx, head_w}` in 1080x1920, `null` without a head, the algorithm,
  bounds default none and the old room-specific values); a "Preview copies" subsection (540x960,
  bitrates, about 18 MB per 50 s, same timing, keyframe every 1 s); a "Kept and rebuildable"
  subsection listing every output's tag; Testing gains `cutout.tools.test.ts` on
  `short-person.mp4` and the six-hit E2E; Configuration: doctor's codec check; Rules: add "Background
  removal stays on HyperFrames' current u2net model (`u2net_human_seg`) until issue #20 is taken up:
  no other model, mask format, frame-reader patch or decode size", "Every output carries a `kept` or
  `rebuildable` tag", "Never touch `fixtures/footage/short-person.mp4`"; Notes: replace "A changed
  version or setting re-runs every later step" with "re-runs every step that reads its outputs,
  directly or through another step" (a `head_track` change does not re-run `preview_copies`).
- `docs/conditional-docs.md`: widen the existing pipeline line to name background removal, head
  tracking, preview copies and output tags. No new line.
- `app_docs/studio.md`: where reel statuses are listed, add the three new ones.
- No em-dashes anywhere.

### 14. Run the Validation Commands

## Testing Strategy

### Unit Tests

- `head-track.test.ts`: the pure tracker on synthetic RGBA (ellipse, empty, thresholds, band edge,
  bounds on and off, buffer length, summary wording).
- `remove-background.test.ts`, `head-track-step.test.ts`, `preview-copies.test.ts`: exact tool
  arguments and result parsing.
- `definition.test.ts`: six-step order and statuses, output tags, dependency-aware fingerprint
  propagation, the HyperFrames version test.
- `run-pipeline.test.ts`: six-step hits and statuses, `video/webm` content type.
- `doctor-checks.test.ts`: codec check.
- `pipeline-fixtures.test.ts`: fixtures match the six fingerprints.
- `reels.test.ts` and `pipeline-statuses.test.ts` (DB layer): the new statuses.

### Test Coverage

- Unit (`apps/worker/src/pipeline/head-track.test.ts`): catches a wrong port of `head_track.py`
  (position off by more than one analysis pixel, wrong null handling, bounds applied by default).
- Unit (`definition.test.ts`): catches a step missing from `PIPELINE`, a wrong status, a missing or
  wrong `kept`/`rebuildable` tag, and a HyperFrames bump not re-running head tracking and previews.
- Unit (`remove-background.test.ts`, `head-track-step.test.ts`, `preview-copies.test.ts`): catches a
  dropped `--json`, a missing `-c:v libvpx-vp9` decoder (alpha lost), missing `-auto-alt-ref 0`.
- Unit (`pipeline-fixtures.test.ts`, existing): fails until `fixtures/pipeline/` holds the new outputs.
- DB (`pipeline-statuses.test.ts`): fails without the migration (constraint rejects the statuses).
- Tools (`cutout.tools.test.ts`, owner's Mac): real HyperFrames and ffmpeg give alpha, a head track
  with at least 80 percent samples and 540x960 previews of the right duration.
- E2E (`apps/studio/e2e/upload.spec.ts`): fails without the feature (three step lines and rows, not
  six). No new screen: this is a worker change, the reel page only shows more step lines, so no
  review screenshots beyond the profile's standard studio pages are needed.

### Edge Cases

- A cut-out frame with no person (whole fixture clip): every sample `null`, summary
  `head tracked, 12 samples, 12 without a head`, step still succeeds.
- Head touching the frame's bottom: band clipped to the last row.
- A trailing partial raw frame or zero frames: the step fails with a clear message.
- HyperFrames printing `{ ok: false }` with exit 0, or non-JSON stdout: the step fails.
- Retry after a failed `head_track`: `remove_background` is a hit (no seven-minute rerun), its
  `subject.webm` is downloaded as `head_track`'s input.
- Deleting only `subject.webm` re-runs `remove_background`; later steps stay hits (unchanged
  fingerprints).
- A source not 1080x1920 (the 720x1280 fixture): head coordinates are still in 1080x1920 space,
  previews still 540x960.

## Acceptance Criteria

- `PIPELINE` is convert, transcribe, retime, remove_background, head_track, preview_copies; the reel
  status goes `removing_background`, `tracking_head`, `making_previews`, then `processed`.
- `remove_background` runs the installed HyperFrames `remove-background ... --device auto --quality balanced --json`
  with `HYPERFRAMES_NO_TELEMETRY=1` through the step runner; its fingerprint holds device, quality and
  the HyperFrames version; output `subject.webm`, `rebuildable`.
- `head_track` output `head-track.json` in the old format; the tracker is a pure function with
  ffmpeg-free tests; bounds default to none.
- `preview_copies` outputs a 540x960 H.264 MP4 and a 540x960 VP9-alpha WebM, same timing as the
  source, both `kept`.
- Every output of every step has a `kept` or `rebuildable` tag.
- Summaries read `background removed, <duration>, <size>`, `head tracked, <n> samples, <k> without a head, <duration>, <size>`,
  `preview copies made, <duration>, <size>`; hits read `<what>, reused`.
- No faster background method, other model, mask format, frame-reader patch or decode-size change.
- `fixtures/footage/short-person.mp4` is unchanged; `fixtures/pipeline/` regenerated and committed.
- All validation commands pass, `test:tools` passes on the Mac.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `test -f fixtures/footage/short-person.mp4 && git diff --quiet HEAD -- fixtures/footage/` : the person clip exists and is untouched.
- `.adw/supabase-stack reset` : applies the new migration to the ADW stack before DB and E2E tests.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` : lint both touched apps.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio` : types, including the new `StepOutput` shape (this is also the worker's build check).
- `yarn knip` : no unused exports or files from the new modules.
- `yarn format:check` : Prettier over the repository, including the regenerated manifest.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio` : unit tests (head tracker, definition, run-pipeline, fixtures, doctor, statuses mirror, migration version guard).
- `yarn workspace @edit-issebya/worker test:tools` : real HyperFrames and ffmpeg on `short-person.mp4` (owner's Mac).
- `yarn turbo run test:db --filter=./apps/studio` : the new reel statuses are accepted by the constraint.
- `yarn turbo run build --filter=./apps/studio` : the studio still builds with the new statuses.
- `yarn build` : full build, as the issue's gates list.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` : the upload spec sees six hits and `processed` (from `.ports.env`; the `/prepare_app` server must already be up).

## Notes

- No new dependency: HyperFrames 0.8.222 and ffmpeg are already used.
- Fixtures stay on `short-speech.mp4` (24 KB, no person) so the repository stays small; its cut-out is
  transparent and its head track all `null`, which is enough for cache hits. `short-person.mp4` is
  for the tool tests only.
- Fingerprint propagation follows the declared inputs: a `head_track` setting or version change
  re-runs `head_track` only, since `preview_copies` does not read the head track. That is the honest
  reading of "a code-version bump re-runs that step and the ones after it" (B5): only the ones after
  it that depend on it. Steps still run in list order.
- `device: auto` is in the fingerprint as a value, not as the provider actually chosen (CoreML on
  the Mac, CPU elsewhere); outputs from different providers may differ slightly but share a key.
  Acceptable for a single worker machine; recorded in the doc's Notes.
- Tags chosen for the first three steps (not decided by the issue): `converted.mp4` rebuildable (B6),
  retime's `source.mp4` rebuildable (heavy, rebuilt from the kept upload), every JSON output kept.
  Slice 14 may revisit.
- Raw frames go to a file, not stdout: the runner caps stdout at 64 KB and splits it into lines. For
  a 50 s reel the file is about 100 MB in the job's scratch folder, read one frame (518 KB) at a time
  and deleted before the step ends.
- Out of scope: faster background removal (#20), progress percentage (slice 15), deleting
  rebuildable files (slice 14), the builder (slice 8). The pipeline does not verify the cut-out's
  visual quality against `rethink-work/subject.webm` or the run time on the owner's machine: that is
  the owner's manual acceptance (compare at 10 s and 25 s, head track sample count and positions,
  about 7 minutes for background removal).
