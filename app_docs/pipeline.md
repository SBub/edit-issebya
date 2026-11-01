# Fixed Pipeline Steps: Convert, Transcribe, Retime, Background Removal, Head Tracking, Previews

**Specifications:**

- specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md
- specs/issue-30-adw-47d9d58e-sdlc_planner-background-removal-head-tracking-previews.md

## Overview

After an upload the worker's `process` job runs six fixed steps as plain TypeScript, with no AI:
`convert` (phone footage to steady H.264), `transcribe` (word timings from HyperFrames), `retime`
(a light speed-up planned from the transcript and the audio), `remove_background` (the speaker cut
out with alpha), `head_track` (the head position every 0.25 s) and `preview_copies` (small copies
for the studio's live preview). Each step is cached in R2
by a fingerprint of everything it reads, so an input is processed exactly once and a failed job
resumes at the step that failed.

## How it works

The reel goes `converting`, `transcribing`, `retiming`, `removing_background`, `tracking_head`,
`making_previews`, then `processed` (or `failed`). The studio's
live status shows one line per step (`name: summary`).

- `apps/worker/src/pipeline/definition.ts`: `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]` and
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
  and spawns nothing. Otherwise it downloads the declared inputs into
  `<WORKER_SCRATCH_DIR>/job-<job id>/`, runs the step as one measured row, and uploads each missing
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
- `apps/worker/src/pipeline/remove-background.ts`: runs the installed HyperFrames
  `remove-background <source.mp4> -o subject.part.webm --device auto --quality balanced --json`
  (the format follows the `.webm` extension), parses the last stdout line (`ok` true and a positive
  `framesProcessed`, else the step fails), then renames. Output `subject.webm`, the full-size cut-out
  (VP9 with alpha). Settings: `device`, `quality` and the HyperFrames version (the model,
  `u2net_human_seg`, is HyperFrames' default and is pinned by that version). Slowest step (about
  seven minutes for a 50 s reel).
- `apps/worker/src/pipeline/head-track.ts`: the pure tracker, `HEAD_TRACK_SETTINGS`, `headSample`,
  `withinBounds`, `headTrackWhat`; tested on synthetic frames without ffmpeg.
- `apps/worker/src/pipeline/head-track-step.ts`: ffmpeg decodes `subject.webm` (`-c:v libvpx-vp9`
  before `-i`, so alpha survives) at 4 fps to raw RGBA 270x480 in a scratch file (stdout through the
  step runner is capped at 64 KB, so it cannot carry frames), read back one frame at a time and
  deleted. Output `head-track.json`. Zero frames or a trailing partial frame fails the step.
- `apps/worker/src/pipeline/preview-copies.ts`: two encodes, `footage-preview.mp4` (H.264, 540x960)
  from the retimed `source.mp4` and `subject-preview.webm` (VP9 with alpha, 540x960) from
  `subject.webm`; `PREVIEW_SETTINGS` holds every value.
- `apps/worker/src/step-runner.ts`: `runToolsStep` (one row over several tool calls, CPU summed,
  peak memory the maximum) and `recordHit`; see `app_docs/measurement.md`.
- `packages/storage`: `head` returns the ETag, `getFile` streams to `<path>.part` then renames,
  `putFileIfAbsent` never replaces an object (R2 `If-None-Match: *`, 412 means exists; the folder
  fake hard-links a finished temp file), and `keyPrefix` lives here.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: `steps.cache_hit`, step status
  `skipped`, reel statuses `converting`, `transcribing`, `retiming`, `processed` (`received` stays
  allowed for old rows; nothing writes it).
- `supabase/migrations/20261101135426_pipeline_steps_part_two.sql`: adds the reel statuses
  `removing_background`, `tracking_head`, `making_previews`. They are mirrored in
  `PipelineReelStatus` (`apps/worker/src/step-store.ts`) and `REEL_STATUSES`
  (`apps/studio/src/lib/reels.ts`).
- `apps/worker/src/first-version.ts`: after the six steps the worker saves the automatic first
  version, the `first_version` step: version 1 built from the preset alone (no AI) from the retimed
  transcript, `retime.json`'s duration and the head track, saved through `save_version`. Its step
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

Both previews are 540x960 with the source's frame timing (`-fps_mode passthrough`) and a keyframe
every 1 s. Footage: H.264 medium, 1200k (max 1500k), AAC 128k, `+faststart`. Subject: VP9 `yuva420p`,
1400k, `-auto-alt-ref 0` (required for VP9 alpha), `alpha_mode=1`. About 18 MB together for a 50 s
reel; made for Chrome.

### Kept and rebuildable

Every output carries a tag, so the cleanup (slice 14) can act on it. `kept` cannot be regenerated
cheaply and stays; `rebuildable` is heavy and may be deleted, since its step re-runs from the
fingerprint. Tags are not part of a fingerprint.

- `rebuildable`: `converted.mp4`, retime's `source.mp4`, `subject.webm`.
- `kept`: `transcript.json` (transcribe and retime), `retime.json`, `envelope.json`,
  `head-track.json`, `footage-preview.mp4`, `subject-preview.webm`.

### Retime rules

1. Silent runs are envelope stretches below `silenceDb`; phrases are the words between silent runs
   of at least `phraseGapSeconds`.
2. A phrase is slow when its words per second are under `slowWordsPerSecond`, it holds a word longer
   than `drawnOutWordSeconds`, or a silent run of `longPauseSeconds` or more follows it. Adjacent
   slow phrases merge; a stretch shorter than `minSlowStretchSeconds` stays at base speed.
3. Every speed boundary sits on a frame point strictly inside a silent run, never on a word join.
4. A silent run shorter than `minGapAfterSeconds` after speed-up that holds a whole frame has that
   middle frame slowed to `gapRate`.
5. Pause cutting: only when `maxPauseSeconds` is a number; a longer silent run is shortened to it by
   removing its middle. `null` (the default) cuts nothing.
6. The last piece carries an `endFadeSeconds` audio fade; the end is the duration rounded to a frame.

`RETIME_PRESET` defaults: `baseSpeed` 1.05, `slowSpeed` 1.1, `slowWordsPerSecond` 2.7,
`drawnOutWordSeconds` 0.6, `longPauseSeconds` 0.3, `phraseGapSeconds` 0.1,
`minSlowStretchSeconds` 0.8, `silenceDb` -40, `envelopeFrameSeconds` 0.01,
`minGapAfterSeconds` 0.065, `gapRate` 0.6, `maxPauseSeconds` null, `frameRate` 30,
`endFadeSeconds` 0.03, plus the encode settings (`libx264`, `medium`, crf 18, `256k`).

## How to Use

1. Upload footage in the studio; the worker claims the `process` job.
2. Watch the reel page: the status moves through `converting`, `transcribing`, `retiming`,
   `processed`, with a step line each.
3. Retry a failed job: finished steps show `..., reused` and the run resumes at the failed one.
4. After changing a step's behaviour, bump its `version`, then run
   `yarn workspace @edit-issebya/worker fixtures:pipeline` and commit `fixtures/pipeline/`.

## Configuration

- `FFMPEG_PATH` (default `ffmpeg`; `ffprobe` is taken from beside it), `WORKER_SCRATCH_DIR`,
  `R2_KEY_PREFIX` (a malformed value fails the config, naming the variable). No new variable.
- `HYPERFRAMES_NO_TELEMETRY` is forced to `1` for HyperFrames; the `hyperframes` dependency in
  `apps/worker/package.json` is pinned exactly.
- `yarn doctor` in the worker also checks the ffmpeg filters `zscale`, `tonemap`, `atempo`, `astats`,
  `ametadata`, the codecs `libx264` and `libvpx-vp9` (encoders) and the `libvpx-vp9` decoder, and
  that `hyperframes --version` answers.

## Testing

- `yarn test` (pure, no ffmpeg, HyperFrames, database or network): fingerprints, every settings
  leaf and the version changing the fingerprint, `run-pipeline.test.ts` (hits spawn nothing, a
  missing output re-runs only its step, resume, statuses, clean-up), probe (HDR, VFR), planner on
  synthetic and `testdata/rethink-work/` data, and `pipeline-fixtures.test.ts`, which fails when a
  version or setting change leaves `fixtures/pipeline/` stale.
- `yarn workspace @edit-issebya/worker test:tools` (`*.tools.test.ts`): real ffmpeg and HyperFrames
  on `fixtures/footage/short-speech.mp4`; `cutout.tools.test.ts` runs the three new steps on
  `fixtures/footage/short-person.mp4` (alpha present, the `u2net_human_seg` default model, at
  least 80 percent of head samples found, 540x960 previews of the source's duration). The owner's
  Mac only, never CI.
- `yarn turbo run test:db --filter=./apps/studio`: `pipeline-statuses.test.ts` and the pinned
  `steps` columns (`cache_hit`).
- `apps/studio/e2e/upload.spec.ts` seeds `fixtures/pipeline/` under a per-run key prefix, so every
  step is a hit: six `skipped` rows, reel `processed`, no tool needed in CI.
- Manual: run the original `rethink-work` phone file and compare with the old scripts' output
  (format, fps, keyframes, duration, words, segments). The committed reference `retime.json` is
  Draft 02 (1.10 / 1.15); the defaults match Draft 01 (1.05 / 1.1).

## Rules

- No AI in the fixed steps.
- Every step declares everything it reads (inputs, settings, version) and reads nothing else.
- Never overwrite a stored output; uploads are put-if-absent.
- Word ids never change after transcribe; retime keeps them.
- Bump a step's version whenever its behaviour changes, then re-run `fixtures:pipeline`.
- Never run HyperFrames through `npx` or `yarn dlx`, and always with `HYPERFRAMES_NO_TELEMETRY=1`.
- Never write to the reference repository (`issebya-homes-reels`).
- Never fingerprint a source without its ETag.
- Background removal stays on HyperFrames' current u2net model (`u2net_human_seg`) until issue #20
  is taken up: no other model, mask format, frame-reader patch or decode size.
- Every output carries a `kept` or `rebuildable` tag.
- Never touch `fixtures/footage/short-person.mp4`.

## Notes

- Deleting an earlier step's output re-runs that step only; later steps stay hits because their
  fingerprints are unchanged (re-running would overwrite their outputs). A changed version or
  setting re-runs every step that reads its outputs, directly or through another step (a
  `head_track` change does not re-run `preview_copies`).
- `device: auto` is fingerprinted as a value, not as the provider chosen (CoreML on the Mac, CPU
  elsewhere); outputs from different providers may differ slightly but share a key.
- The fixtures stay on `short-speech.mp4` (no person): its cut-out is transparent and its head
  track all `null`, enough for cache hits.
- The ffmpeg build is in no fingerprint: after an ffmpeg upgrade that changes output, bump the
  affected versions by hand.
- Single PUT only: an output above 5 GiB fails. Multipart comes with storage records (slice 14).
- Deviations from the old `retime.py`: slow stretches and short-gap frames are chosen by rule, audio
  pieces are trimmed to their video length instead of measured, `fix_words.py` is out of scope.
- Touches `app_docs/studio.md` (worker, statuses, `skipped`, `cache_hit`, storage) and
  `app_docs/measurement.md` (`runToolsStep`, `recordHit`, the `steps` column set, `receive`
  removed); those two docs still describe the placeholder `receive` step in places.
