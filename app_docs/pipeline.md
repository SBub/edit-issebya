# Fixed Pipeline Steps: Convert, Transcribe, Retime, Head Tracking, Previews

**Specifications:**

- specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md
- specs/issue-30-adw-47d9d58e-sdlc_planner-background-removal-head-tracking-previews.md
- specs/issue-94-adw-baceb379-sdlc_planner-remove-cutout-from-pipeline.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

After an upload the worker's `process` job runs five fixed steps as plain TypeScript, with no AI:
`convert` (phone footage to steady H.264), `transcribe` (word timings from HyperFrames), `retime`
(a light speed-up planned from the transcript and the audio), `head_track` (the head position every
0.25 s, from its own sampled person mask) and `preview_copies` (a small copy of the footage for the
studio's live preview). Each step is cached in R2
by a fingerprint of everything it reads, so an input is processed exactly once and a failed job
resumes at the step that failed.

## How it works

The reel goes `converting`, `transcribing`, `retiming`, `tracking_head`,
`making_previews`, then `processed` (or `failed`). The studio's
live status shows one line per step (`name: summary`).

- `apps/worker/src/pipeline/definition.ts`: `PIPELINE = [convert, transcribe, retime, headTrack, previewCopies]` and
  `fingerprintsFor(source)`. A `PipelineStep` declares `name`, `version`, `settings`, `reelStatus`,
  `outputs` (each `{ file, retention }`, see Kept and rebuildable), `reusedWhat`, `inputs(source, fingerprints)` and `run`. A step reads only the local
  paths of its declared inputs.
- `apps/worker/src/pipeline/fingerprint.ts`, `canonical-json.ts`: the fingerprint is the SHA-256
  of the canonical JSON (sorted keys, no whitespace, refuses `undefined` and non-finite numbers) of
  `{ inputs, settings, version }`. The uploaded source is identified by its storage ETag and byte
  size (one HEAD, no download); a cached output by its producer (`{ step, fingerprint, file }`).
  Outputs live at `${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`.
- `apps/worker/src/pipeline/run-pipeline.ts`: for each step it HEADs every output key. All present:
  it sets the reel status, records a hit (`skipped`, `cache_hit = true`, summary `<what>, reused`)
  and spawns nothing. Every output it finds stored also records a `stored_files` row for the job's
  reel, from the `head` it already made. Otherwise it downloads the declared inputs into
  `<WORKER_SCRATCH_DIR>/<job id>/job-<job id>/` (the job's scratch folder, removed after the job), runs the step as one measured row, and uploads each missing
  output with put-if-absent, so a stored output is never replaced. The job folder is removed at the
  end; after a lost lease nothing more is written. A source with no ETag fails the job.
  `PipelineRun.setReelStatus` (default `true`) set to `false` never calls `steps.reelStatus`: the
  export's `runRender` uses it, so a render leaves the reel `processed` (`app_docs/export.md`).
- `apps/worker/src/pipeline/convert.ts`, `probe.ts`: ffprobe, then one ffmpeg encode: H.264 (crf 18,
  medium), constant 30 fps, a keyframe every 1 s, AAC audio copied when it already is AAC (else
  encoded at 256k), `+faststart`. HDR footage (`smpte2084` or `arib-std-b67`) is tone-mapped to SDR
  BT.709 (`zscale`/`tonemap`, hable); a variable frame rate (the two rates differ by more than
  0.5%, or `0/0`) becomes a steady 30. Output `converted.mp4`, written under a temporary name and
  renamed after exit 0.
- `apps/worker/src/pipeline/transcribe.ts`, `transcript.ts`, `tools.ts`: runs the installed
  HyperFrames binary (`process.execPath` plus its `bin/hyperframes.mjs`, `HYPERFRAMES_NO_TELEMETRY=1`
  forced) with `transcribe --engine whisper --model small --language en --json`. The words are
  normalised into the studio format `{ words: [{ id, text, start, end }] }` (seconds, three
  decimals, ids `w0001`... by position). Always the multilingual `small` model told the language:
  `small.en` and `base` drop or merge words on this footage. The HyperFrames version is a setting.
- `apps/worker/src/pipeline/envelope.ts`, `retime-plan.ts`, `retime-encode.ts`, `retime.ts`: a 10 ms
  RMS envelope in dB, a pure planner and one ffmpeg encode. Outputs `source.mp4` (retimed footage),
  `transcript.json` (same ids, new times), `retime.json` (the plan: original to new time map) and
  `envelope.json`.
- `apps/worker/src/pipeline/retime-preset.ts`: `RETIME_PRESET`, every retime setting; each value is
  part of the fingerprint.
- `apps/worker/src/pipeline/person-mask.ts`: the person mask `head_track` reads. It runs HyperFrames'
  own Node on `apps/worker/src/pipeline/remove-background-entry.ts` (`PERSON_MASK_ENTRY`, the
  package's `removeBackground` with the CLI's options, `personMaskArgs`: `--device auto --quality
balanced`), which prints per-frame progress (`app_docs/status.md`) and ends with the CLI's JSON
  result. `parsePersonMaskResult` reads the last stdout line (`ok` true and a positive
  `framesProcessed`, else the step fails). `PERSON_MASK_SETTINGS`: `device`, `quality` and the
  HyperFrames version (the model, `u2net_human_seg`, is HyperFrames' default and is pinned by that
  version).
- `apps/worker/src/pipeline/head-track.ts`: the pure tracker, `HEAD_TRACK_SETTINGS`, `headSample`,
  `withinBounds`, `headTrackWhat`; tested on synthetic frames without ffmpeg.
- `apps/worker/src/pipeline/head-track-step.ts`: reads retime's `source.mp4`. ffmpeg keeps one frame
  per 0.25 s at 270x480, losslessly, in a scratch `samples.mp4` (`headTrackSampleArgs`); the person
  mask runs on that clip into a scratch VP9-alpha `mask.part.webm`; ffmpeg decodes it
  (`headTrackDecodeArgs`, `-c:v libvpx-vp9` before `-i`, so alpha survives) to raw RGBA in a scratch
  `frames.rgba` (stdout through the step runner is capped at 64 KB, so it cannot carry frames), read
  back one frame at a time. All three scratch files are deleted in the step, never uploaded.
  Version 2; its settings are the tracker's plus `mask` (`HEAD_TRACK_STEP_SETTINGS`, the HyperFrames
  version among them, so a HyperFrames upgrade re-runs it). Output `head-track.json` (format
  unchanged). Zero frames or a trailing partial frame fails the step.
- The on-demand cut-out (`apps/worker/src/cutout/`): `ensure-cutouts.ts` makes the person mask of
  each padded span of an edit's big words (`behind` items behind the speaker; a VISUAL needs none)
  that is not stored yet, in one measured `cutout` step, one tool call per span.
  The tool is MODNet portrait matting (the official `modnet_photographic_portrait_matting.onnx` of
  ZHKKKe/MODNet, Apache 2.0 code and weights) run through `onnxruntime-node` on the CPU, on any OS
  (Linux and Docker included): `mask-tool.ts` (`maskToolCall`, `MASK_TOOL_VERSION` 2) runs this
  Node on `modnet-entry.ts` with `--input --start --end --output --model --ffmpeg --ffprobe`.
  The entry checks the model's SHA-256, probes the footage's size and frame rate, and streams:
  ffmpeg decodes exactly `round((end - start) * fps)` frames from the span's first frame (seeking a
  quarter frame early, `-frames:v`) to raw RGB at MODNet's working size (`workingSize` in
  `matte.ts`: the short side 512, both sides rounded down to multiples of 32, the aspect kept, area
  scaling, so 1080x1920 and 720x1280 run at 512x896); each frame is normalised to -1 to 1 (NCHW
  float32) and run; the matte (0 to 1) becomes 8-bit gray, goes through a 3-frame per-pixel
  temporal median (`TemporalMedian`: frame i is the median of frames i - 1, i, i + 1, the first and
  last unchanged; it removes one-frame flicker without the lag a moving average leaves on motion;
  one frame of delay, three mattes held) and into a second ffmpeg, which scales it to the footage's
  size (bicubic) and writes the mask: H.264 High `yuv420p`, full-range gray mapped to video range
  (white = person, chroma neutral), BT.709 tags, crf 12, a keyframe every second, frame i at
  i / fps, the span's frame count. The same format, keys and layout the Apple Vision tool (`vseg`,
  removed) wrote, so the builder, the preview and the export read it unchanged. Written to
  `<output>.part`, renamed when done; one `@hf-progress` line per frame (`app_docs/status.md`); any
  failure exits 1 with one `modnet: ...` line. About 8 s per second of footage on an M3's CPU.
- The MODNet model (`apps/worker/src/cutout/modnet-model.ts`, `MODNET_MODEL`): pinned by URL (the
  official Google Drive file the MODNet ONNX README links), size (25,888,640 bytes) and SHA-256
  (`07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`). Never committed, never
  downloaded at job time: `yarn workspace @edit-issebya/worker models:install`
  (`src/models-install.ts`) downloads it once into `WORKER_MODELS_DIR` (default
  `~/.edit-issebya-worker/models/`), hashing as it streams, and keeps it only when size and hash
  match (a model already there with the hash is kept). Without the model the `cutout` step fails
  with `cutout: MODNet model not installed at <path>, run yarn workspace @edit-issebya/worker
models:install`; a file with another hash fails the entry, naming both hashes.
- A mask's fingerprint (`maskFingerprint` in `spans.ts`): the footage ref, the span, and
  `MATTE_SETTINGS` (`model`, `modelSha256`, `size` 512, `smoothing` `median3`, `provider` `cpu`,
  `format` `h264-gray`), version `MASK_TOOL_VERSION`. Version 1 was `vseg`; version 2 makes new masks
  for new runs, while stored versions keep naming (and rendering) their version 1 masks. Bump the
  version whenever `modnet-entry.ts` or `matte.ts` changes what a mask looks like. CoreML (in
  `onnxruntime-node` on the Mac) was tried: slower than the CPU on an M3 and with other values, so
  the provider is `cpu` everywhere.
- `apps/worker/src/pipeline/preview-copies.ts`: one encode, `footage-preview.mp4` (H.264, 540x960)
  from the retimed `source.mp4`, version 2; `PREVIEW_SETTINGS` holds every value.
- `apps/worker/src/step-runner.ts`: `runToolsStep` (one row over several tool calls, CPU summed,
  peak memory the maximum) and `recordHit`; see `app_docs/measurement.md`.
- `packages/storage`: `head` returns the ETag, `getFile` streams to `<path>.part` then renames,
  `putFileIfAbsent` never replaces an object (R2 `If-None-Match: *`, 412 means exists; the folder
  fake hard-links a finished temp file), and `keyPrefix` lives here.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: `steps.cache_hit`, step status
  `skipped`, reel statuses `converting`, `transcribing`, `retiming`, `processed` (`received` stays
  allowed for old rows; nothing writes it).
- `supabase/migrations/20261101135426_pipeline_steps_part_two.sql`: adds the reel statuses
  `removing_background`, `tracking_head`, `making_previews`. `tracking_head` and `making_previews`
  are mirrored in `PipelineReelStatus` (`apps/worker/src/step-store.ts`); all three are in
  `REEL_STATUSES` (`apps/studio/src/lib/reels.ts`). `removing_background` stays allowed for old reels
  and in `REEL_STATUSES`, but is no longer in `PipelineReelStatus` and nothing writes it.
- `apps/worker/src/first-version.ts`: after the five steps the worker saves the automatic first
  version, the `first_version` step: version 1 built from the preset alone (no AI) from the retimed
  transcript, `retime.json`'s duration and the head track, its captions placed by the layout
  engine, saved through `save_version` with the engine record. Its step
  line is `version 1 saved, <time>, <size>`, or `first version kept, reused` (a cache hit, nothing
  written) when the reel already has a current version. Failed layout checks are stored on the
  version, never fatal. See `app_docs/edit-model.md`.

### Head-track format

`head-track.json` is an array with one entry per 0.25 s (entry `i` is `t = i * 0.25`), each either
`null` (no head found) or `{ t, head_top, cx, head_w }` in 1080x1920 coordinates (the same format as
the old `head_track.py`). A frame is analysed at 270x480 and the numbers are scaled by 4. A pixel is
opaque when alpha is above 128. The top is the first row with at least 4 opaque pixels; for the rows
20 to 49 below it, each row with an opaque pixel gives a span (first to last opaque x); the spans
are sorted by width and the median one gives `cx` and `head_w`. Coordinates stay in 1080x1920 space
for a source of another size. The optional bounds (`minHeadTop`, `minHeadWidth`, `maxHeadWidth`)
default to none: the old values (380, 220, 420) fitted one room and are not a default. A clip with no
person gives all `null` (summary `head tracked, 12 samples, 12 without a head`).

### Preview copies

The footage preview is 540x960 with the source's frame timing (`-fps_mode passthrough`) and a
keyframe every 1 s: H.264 medium, 1200k (max 1500k), AAC 128k, `+faststart`. About 8 MB for a 50 s
reel; made for Chrome.

### Kept and rebuildable

Every output carries a tag, so the slimming (`app_docs/storage.md`) can act on it. `kept` cannot be regenerated
cheaply and stays; `rebuildable` is heavy and may be deleted, since its step re-runs from the
fingerprint. Tags are not part of a fingerprint.

- `rebuildable`: `converted.mp4`, retime's `source.mp4`, the on-demand `backgrounds` step's
  `backgrounds.json` (the footage's luminance grid for readable text, fingerprint of the footage ref,
  `BACKGROUND_SETTINGS` and a version, made by `ensureBackgrounds` before `first_version` and
  `decide`, a hit when stored) and the on-demand `cutout` step's
  `mask.mp4` (`ON_DEMAND_OUTPUTS` in `definition.ts`, read by `retentionOf`): the next export,
  restore or Start over makes it again.
- `kept`: `transcript.json` (transcribe and retime), `retime.json`, `envelope.json`,
  `head-track.json`, `footage-preview.mp4`.
- Retired outputs (`remove_background`'s `subject.webm`, rebuildable, and `preview_copies`'
  `subject-preview.webm`, kept) are still classified by `retentionOf` through `RETIRED_OUTPUTS`
  (`definition.ts`) for old reels' stored files, and never written again.

### Retime rules

1. Silent runs are envelope stretches below `silenceDb`; phrases are the words between silent runs
   of at least `phraseGapSeconds`.
2. A phrase is slow when its words per second are under `slowWordsPerSecond`, it holds a word longer
   than `drawnOutWordSeconds`, or a silent run of `longPauseSeconds` or more follows it. Adjacent
   slow phrases merge; a stretch shorter than `minSlowStretchSeconds` stays at base speed.
3. Every speed boundary sits on a frame point strictly inside a silent run, never on a word join.
4. A silent run shorter than `minGapAfterSeconds` after speed-up that holds a whole frame has that
   middle frame slowed to `gapRate`.
5. Pause cutting, by the audio: when `maxPauseSeconds` is a number (the default, 0.3), every
   silent run of the envelope longer than that once sped up is shortened to it, whatever the
   transcript says (where the audio is silent, nobody speaks; word intervals are never consulted).
   A run between two sounds loses whole frames around its middle, so it plays as `maxPauseSeconds`
   (give or take a frame, about half kept on each side); the run from the clip's start (leading
   silence) and the one reaching the end of the audio (trailing silence) lose the part away from
   the speech, so `maxPauseSeconds` stays next to it. Every cut point is a frame point strictly
   inside its run. A run must be longer than `maxPauseSeconds` at its speed (about 0.32 s) to be
   cut at all, and the part kept guards soft speech at the edges of a silence; `silentRuns` itself
   has no minimum length. A clip silent throughout (one run from start to end) is left whole.
   Audio and video of a piece are trimmed at the same frame, so a cut adds no drift. A pause at a
   speed boundary keeps its boundary inside the silence; its two halves play at their own speeds.
   Short-gap frames (rule 4) never reach the limit, so the two rules never meet. `null` cuts
   nothing. `retime.json` maps original to new time (a time inside a cut maps to the cut point).
6. Word times by the audio: retime's `transcript.json` (same ids, same order) is the corrected one.
   A word whose start lies inside a silent run that speech follows starts at that run's end (the
   speech onset), whether that part of the run was removed or kept, so a caption never leads the
   voice; then every time goes through `retime.json`. Word ends are not moved (an end inside a cut
   maps to the cut point). A moved word starts at least a frame after the word before and lasts at
   least a frame (whisper's pinned opening words become a frame apart at the onset); no word
   starts later than a frame before the end (a word placed in the trimmed trailing silence still
   shows); starts never decrease and no word ends before it starts. A start in the trailing run is
   not moved (no speech follows).
7. The last piece carries an `endFadeSeconds` audio fade; the end is the duration rounded to a frame,
   or the trailing trim point (still in silence, so the fade falls on silence).

`RETIME_PRESET` defaults: `baseSpeed` 1.05, `slowSpeed` 1.1, `slowWordsPerSecond` 2.7,
`drawnOutWordSeconds` 0.6, `longPauseSeconds` 0.3, `phraseGapSeconds` 0.1,
`minSlowStretchSeconds` 0.8, `silenceDb` -40, `envelopeFrameSeconds` 0.01,
`minGapAfterSeconds` 0.065, `gapRate` 0.6, `maxPauseSeconds` 0.3, `frameRate` 30,
`endFadeSeconds` 0.03, plus the encode settings (`libx264`, `medium`, crf 18, `256k`).

Pause cutting is always on: the owner switched `maxPauseSeconds` from `null` to 0.4 on 2026-11-04
as the first step toward the rough cut (#166), with no per-reel switch, and lowered it to 0.3 on
2026-11-04 (tighter pauses between words and at the clip's start and end; a settings change, so
the fingerprint changes and retime re-runs without a version bump). Retime version 2 added the
leading and trailing trim but trusted the transcript's word intervals (no cut under a word); version
3 (owner decision 2026-11-04) cuts and times words by the audio instead, and replaces a separate
transcript timing fix: whisper (`small`, through HyperFrames) pins the first word at 0 across
leading silence and starts a word after a long pause inside it (reel IMG_2013: "There" at 0 with
speech from about 3.5 s, so version 2 trimmed nothing and captions showed up to 3 s early). A cut
joins two frames of the same take, so the picture may jump slightly at a cut. The setting and the
version are in the fingerprint, so retime and every step after it re-run for a new upload; a reel
processed before keeps its footage, and Start over (which decides again from version 1, whose
inputs name the old retime outputs) does not re-run retime.

## How to Use

1. Upload footage in the studio; the worker claims the `process` job.
2. Watch the reel page: the status moves through `converting`, `transcribing`, `retiming`,
   `processed`, with a step line each.
3. Retry a failed job: finished steps show `..., reused` and the run resumes at the failed one.
4. After changing a step's behaviour, bump its `version`, then run
   `yarn workspace @edit-issebya/worker fixtures:pipeline` and commit `fixtures/pipeline/`.

## Configuration

- `FFMPEG_PATH` (default `ffmpeg`; `ffprobe` is taken from beside it), `WORKER_SCRATCH_DIR`,
  `R2_KEY_PREFIX` (a malformed value fails the config, naming the variable).
- `HYPERFRAMES_NO_TELEMETRY` is forced to `1` for HyperFrames; the `hyperframes` dependency in
  `apps/worker/package.json` is pinned exactly.
- `yarn doctor` in the worker checks that ffmpeg and ffprobe are 7.0 or newer (one line, for
  example `ffmpeg 6.1 found, 7 or newer is needed for HEIC photos (-show_stream_groups)`; a git
  build without a version number passes), and the ffmpeg filters `zscale`, `tonemap`, `atempo`, `astats`,
  `ametadata`, the codecs `libx264` and `libvpx-vp9` (encoders) and the `libvpx-vp9` decoder, and
  that `hyperframes --version` answers. Its `mask tool` line checks the MODNet model is installed
  with its pinned SHA-256, masks the first second of `fixtures/footage/short-speech.mp4` with the
  real entry and checks the mask is H.264 at the sample's size with 30 frames (give or take one),
  for example `modnet 07c308cf, 1 s masked in 9.4 s`; a missing model fails the line with
  `MODNet model not installed at <path>, run yarn workspace @edit-issebya/worker models:install`.
  It checks that `OPENROUTER_API_KEY` is set, fetches the five PostHog prompts by name (no AI call;
  `POSTHOG_PERSONAL_API_KEY`, `app_docs/decide-step.md`, "Prompts"), and makes no AI call; `doctor --ai`
  adds the two paid OpenRouter calls and the image call.
- `WORKER_MODELS_DIR` (default `~/.edit-issebya-worker/models`): where `models:install` puts the
  MODNet model and the `cutout` step and the doctor read it.
- `yarn workspace @edit-issebya/worker models:install` downloads and verifies the model once per
  machine: run it after `yarn install` on a new worker. The worker image bakes the same file in
  at `/opt/edit-issebya/models` (a build stage checks its size and SHA-256), so the container needs
  no install (`app_docs/worker-container.md`).

## Testing

- `yarn test` (pure, no ffmpeg, HyperFrames, database or network): fingerprints, every settings
  leaf and the version changing the fingerprint, `run-pipeline.test.ts` (hits spawn nothing, a
  missing output re-runs only its step, resume, statuses, clean-up), probe (HDR, VFR), planner on
  synthetic and `testdata/rethink-work/` data (pause cuts, leading and trailing trims by the
  audio with a transcript pinned at 0, word starts moved to the speech onset from a removed or a
  kept silence, a cut at a speed boundary, a clip silent throughout; the reference's longest
  silence is 0.31 s, so the default cuts nothing there), `retime-encode.test.ts` (audio and video
  of every planned piece trimmed at the same frame), `head-track-step.test.ts` and `person-mask.test.ts`
  (the sample, mask and decode calls, the person mask's arguments and JSON result), and `pipeline-fixtures.test.ts`, which fails when a
  version or setting change leaves either clip's outputs stale (`fixtures/pipeline/` and
  `fixtures/pipeline/speech-ten/`).
- `yarn workspace @edit-issebya/worker test:tools` (`*.tools.test.ts`): real ffmpeg and HyperFrames
  on `fixtures/footage/short-speech.mp4`; `head-track.tools.test.ts` runs `head_track` and
  `preview_copies` on `fixtures/footage/short-person.mp4` (the real HyperFrames mask with the
  `u2net_human_seg` default model, at least 80 percent of head samples found, no mask, sample clip
  or raw frames left, one 540x960 footage preview of the source's duration);
  `cutout/mask-tool.tools.test.ts` runs the real MODNet entry (the installed model, never a
  download) on 3 seconds of `short-person.mp4` (H.264 1080x1920 `yuv420p`, video range BT.709, 90
  frames, 90 progress lines, the face white and a corner black); `render/render.tools.test.ts`
  renders a big word behind the speaker with a real MODNet mask. The owner's Mac only,
  never CI.
- Unit: `cutout/matte.test.ts` (working size, the model input, the gray matte, the temporal median,
  the frame count and the two ffmpeg calls), `cutout/modnet-model.test.ts` (the model's place, the
  pin, a missing or changed model, the install with a tiny stand-in served by a fake `fetch`, never
  the network), `cutout/mask-tool.test.ts` (the entry's arguments, the missing model line, the
  double), `cutout/spans.test.ts` (every matte setting and the version in the fingerprint).
- `yarn turbo run test:db --filter=./apps/studio`: `pipeline-statuses.test.ts` and the pinned
  `steps` columns (`cache_hit`).
- `apps/studio/e2e/upload.spec.ts` seeds `fixtures/pipeline/` under a per-run key prefix, so every
  step is a hit: five `skipped` rows, reel `processed`, no tool needed in CI.
- `apps/studio/e2e/decide-behind.spec.ts` and the transition test in `apps/studio/e2e/preview.spec.ts`
  seed `speech-ten` (`seedProcessedReel({ clip: "speech-ten" })`), with the scripted answers
  `speechTenVisualAnswerScript` and `speechTenTransitionAnswerScript` (`apps/studio/test-support/ai-script.ts`):
  a VISUAL over w0021 to w0027 and a LIST over w0028 to w0030, both after the hook window (0.2 s to 3 s).
- Manual: run the original `rethink-work` phone file and compare with the old scripts' output
  (format, fps, keyframes, duration, words, segments). The committed reference `retime.json` is
  Draft 02 (1.10 / 1.15); the defaults match Draft 01 (1.05 / 1.1).

## Rules

- No AI in the fixed steps.
- Every step declares everything it reads (inputs, settings, version) and reads nothing else.
- Never overwrite a stored output; uploads are put-if-absent.
- Word ids never change after transcribe; retime keeps them.
- Retime cuts silence by the audio envelope only, never by the transcript's word intervals, and
  never removes a frame of a non-silent run; word starts follow the audio (rule 6), never the
  other way round.
- Bump a step's version whenever its behaviour changes, then re-run `fixtures:pipeline`.
- Never run HyperFrames through `npx` or `yarn dlx`, and always with `HYPERFRAMES_NO_TELEMETRY=1`.
- Never write to the reference repository (`issebya-homes-reels`).
- Never fingerprint a source without its ETag.
- The cut-out is made on demand, only for the padded spans of `behind` items, by MODNet through
  `onnxruntime-node` (the pinned model, `provider` `cpu`, grayscale H.264, any OS, no fallback
  model), fingerprinted by footage, span, `MATTE_SETTINGS` and `MASK_TOOL_VERSION`, stored
  put-if-absent as `rebuildable` and reused by later versions. `head_track` still makes its own
  sampled u2net mask and never stores it.
- Never commit the MODNet model, and never download it at job time or without checking its pinned
  size and SHA-256 (`models:install` only).
- Every output carries a `kept` or `rebuildable` tag.
- Never touch `fixtures/footage/short-person.mp4`.

## Notes

- Deleting an earlier step's output re-runs that step only; later steps stay hits because their
  fingerprints are unchanged (re-running would overwrite their outputs). A changed version or
  setting re-runs every step that reads its outputs, directly or through another step (a
  `head_track` change does not re-run `preview_copies`).
- `device: auto` is fingerprinted as a value, not as the provider chosen (CoreML on the Mac, CPU
  elsewhere); outputs from different providers may differ slightly but share a key.
- The short-speech fixtures stay on `short-speech.mp4` (no person): its head track is all `null`,
  enough for cache hits. `fixtures/pipeline/` has no `remove_background/` and no `subject-preview.webm`.
- `fixtures/footage/speech-ten.mp4` is the second committed clip: 10 s, 720x1280, H.264 and AAC, about
  1.5 MB, with a person speaking (its head track finds the face in every sample). It is cut from the
  owner's own 52 s phone clip (not in the repo) from 18.76 s to 28.76 s, the words w0001 to w0036 of
  its own transcript (two sentences, the first spoken from 0 s, the second ending at the clip's end).
  Made by hand, once: transcribe the source with HyperFrames (whisper `small`, language `en`) to pick
  a stretch that starts and ends on sentence boundaries, then cut it with ffmpeg (`scale=720:1280`,
  `libx264` `-crf 26`, `aac` 96k), and keep the file. Its pipeline outputs are made by the same
  `fixtures:pipeline` run as short-speech's, into `fixtures/pipeline/speech-ten/` with a `manifest.json`
  of its own; the short-speech outputs stay byte-identical. Whisper hears the first word of the cut
  as "Media" (the sentence starts with "Social media"), so its transcript differs from the owner's
  words in places; the fixture's words are the pipeline's, not the speech's.
- The ffmpeg build is in no fingerprint: after an ffmpeg upgrade that changes output, bump the
  affected versions by hand.
- Single PUT only: an output above 5 GiB fails. The storage records (`app_docs/storage.md`) did not add multipart for outputs; it is still to come.
- Deviations from the old `retime.py`: slow stretches and short-gap frames are chosen by rule, audio
  pieces are trimmed to their video length instead of measured, `fix_words.py` is out of scope.
- Touches `app_docs/studio.md` (worker, statuses, `skipped`, `cache_hit`, storage) and
  `app_docs/measurement.md` (`runToolsStep`, `recordHit`, the `steps` column set, `receive`
  removed); those two docs still describe the placeholder `receive` step in places.
