# Fixed Pipeline Steps: Convert, Transcribe, Retime, Background, Head, Previews

**Specifications:**

- specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md
- specs/issue-30-adw-a6bafcdf-sdlc_planner-background-removal-head-tracking-previews.md

## Overview

After an upload the worker's `process` job runs six fixed steps as plain TypeScript, with no AI:
`convert` (phone footage to steady H.264), `transcribe` (word timings from HyperFrames), `retime`
(a light speed-up planned from the transcript and the audio), `remove_background` (the speaker's
cut-out), `head_track` (the head's position over time) and `preview_copies` (small copies for the
studio's live preview). Each step is cached in R2
by a fingerprint of everything it reads, so an input is processed exactly once and a failed job
resumes at the step that failed.

## How it works

The reel goes `converting`, `transcribing`, `retiming`, `removing_background`, `tracking_head`,
`making_previews`, then `processed` (or `failed`). The studio's
live status shows one line per step (`name: summary`).

- `apps/worker/src/pipeline/definition.ts`: `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]` and
  `fingerprintsFor(source)`. A `PipelineStep` declares `name`, `version`, `settings`, `reelStatus`,
  `outputs` (a list of `{ file, keep }`, `keep` being `kept` or `rebuildable`: slice 14 may delete
  only the heavy rebuildable files, never a kept one; the render is the first reader of the tag,
  see the `run-pipeline.ts` bullet), `reusedWhat`, `inputs(source, fingerprints)` and `run`. A step reads only the local
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
- `runPipeline` takes `moveReelStatus` (default `true`). A `render` job passes `false` when its
  `rebuildable` inputs (`source.mp4`, `subject.webm`) are missing, so the fixed steps up to
  `remove_background` rebuild them (cache hits for every stored output) without writing
  `reels.status`; see `app_docs/export.md`.
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
- `apps/worker/src/pipeline/remove-background.ts`: runs the installed HyperFrames entry with
  `remove-background <source.mp4> -o subject.part.webm --device auto --quality balanced --json`
  (its `u2net_human_seg` model; VP9 with alpha in WebM), parses the last JSON line of stdout, then
  renames to `subject.webm`. Input: the retimed `source.mp4`. Settings: `device`, `quality` and the
  HyperFrames version. About seven minutes for a reel, hence the cache. Output `subject.webm`
  (`rebuildable`).
- `apps/worker/src/pipeline/head-track.ts`, `head-sample.ts`: ffmpeg decodes `subject.webm`
  (`-c:v libvpx-vp9` before `-i`, because ffmpeg's native VP9 decoder drops the alpha) at 4 fps and
  270x480 to a raw RGBA scratch file, read one frame at a time. The pure `headSample` takes the head
  top as the first row with at least `minRowPixels` opaque columns and the head span as the
  median-width span of the rows `bandStart` to `bandEnd` below it, and returns
  `{ t, head_top, cx, head_w }` in 1080x1920 pixels, or `null` with no head. Output `head-track.json`
  (`kept`), one entry per 0.25 s. A track of only `null` is not a failure. The old room-specific
  sanity bounds are optional settings (`bounds`), off by default.
- `apps/worker/src/pipeline/preview-copies.ts`: two ffmpeg encodes at 540x960 keeping every frame
  and timestamp: `footage.mp4` (H.264, crf 23, capped at 1400k, the AAC audio copied) from the
  retimed `source.mp4`, and `subject.webm` (VP9 `yuva420p`, `alpha_mode=1`, `-auto-alt-ref 0`, which
  Chrome needs) from the cut-out. About 18 MB together for a 50 second reel. Both outputs are
  `kept`: they hang off the seven-minute cut-out, so they are not cheap to make again.
- `apps/worker/src/pipeline/record-preview-copies.ts`: after the fixed steps (`preview_copies` run
  or a cache hit) `process-job.ts` writes the `preview_copies` fingerprint to
  `reels.preview_copies_fingerprint` (`step-store.ts`, secret key), so the studio's live preview
  finds the copies under `cache/preview_copies/<fingerprint>/`; after a lost lease nothing is
  written.
- `apps/worker/src/pipeline/tools.ts`: `hyperframesEnv(env, tools)` also passes the worker's ffmpeg
  and ffprobe to HyperFrames (`HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH`) when
  `FFMPEG_PATH` is absolute.
- `apps/worker/src/step-runner.ts`: `runToolsStep` (one row over several tool calls, CPU summed,
  peak memory the maximum) and `recordHit`; see `app_docs/measurement.md`.
- `packages/storage`: `head` returns the ETag, `getFile` streams to `<path>.part` then renames,
  `putFileIfAbsent` never replaces an object (R2 `If-None-Match: *`, 412 means exists; the folder
  fake hard-links a finished temp file), and `keyPrefix` lives here.
- `supabase/migrations/20261102090000_pipeline_steps.sql`: `steps.cache_hit`, step status
  `skipped`, reel statuses `converting`, `transcribing`, `retiming`, `processed` (`received` stays
  allowed for old rows; nothing writes it).
- `supabase/migrations/20261103090000_pipeline_steps_part_two.sql`: reel statuses
  `removing_background`, `tracking_head`, `making_previews`.

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
   `removing_background`, `tracking_head`, `making_previews`, `processed`, with a step line each.
3. Retry a failed job: finished steps show `..., reused` and the run resumes at the failed one.
4. After changing a step's behaviour, bump its `version`, then run
   `yarn workspace @edit-issebya/worker fixtures:pipeline` and commit `fixtures/pipeline/`.

## Configuration

- `FFMPEG_PATH` (default `ffmpeg`; `ffprobe` is taken from beside it), `WORKER_SCRATCH_DIR`,
  `R2_KEY_PREFIX` (a malformed value fails the config, naming the variable). No new variable.
- `HYPERFRAMES_NO_TELEMETRY` is forced to `1` for HyperFrames; the `hyperframes` dependency in
  `apps/worker/package.json` is pinned exactly.
- `yarn doctor` in the worker also checks the ffmpeg filters `zscale`, `tonemap`, `atempo`, `astats`,
  `ametadata`, the `libvpx-vp9` encoder and decoder, and that `hyperframes --version` answers.

## Testing

- `yarn test` (pure, no ffmpeg, HyperFrames, database or network): fingerprints, every settings
  leaf and the version changing the fingerprint, `run-pipeline.test.ts` (hits spawn nothing, a
  missing output re-runs only its step, resume, statuses, clean-up), probe (HDR, VFR), planner on
  synthetic and `testdata/rethink-work/` data, the pure head sampler and the ffmpeg and HyperFrames
  argument builders of the three newer steps, and `pipeline-fixtures.test.ts`, which fails when a
  version or setting change leaves `fixtures/pipeline/` stale.
- `yarn workspace @edit-issebya/worker test:tools` (`*.tools.test.ts`): real ffmpeg and HyperFrames.
  Convert, transcribe and retime use `fixtures/footage/short-speech.mp4`; background removal, head
  tracking and preview copies use `fixtures/footage/short-person.mp4` (a real person, read only).
  The owner's Mac only, never CI; the first run downloads the u2net model.
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
- Never touch `fixtures/footage/short-person.mp4`; tests only read it.
- Never write to the reference repository (`issebya-homes-reels`).
- Never fingerprint a source without its ETag.

## Notes

- The committed `fixtures/pipeline/` is made from `short-speech.mp4`, which has no person: its
  cut-out is fully transparent and its head track all `null`, which is enough for cache hits.
- Faster background removal methods are a separate issue (#20), not this step's.
- Deleting an earlier step's output re-runs that step only; later steps stay hits because their
  fingerprints are unchanged (re-running would overwrite their outputs). A changed version or
  setting re-runs every later step.
- The ffmpeg build is in no fingerprint: after an ffmpeg upgrade that changes output, bump the
  affected versions by hand.
- Single PUT only: an output above 5 GiB fails. Multipart comes with storage records (slice 14).
- Deviations from the old `retime.py`: slow stretches and short-gap frames are chosen by rule, audio
  pieces are trimmed to their video length instead of measured, `fix_words.py` is out of scope.
- Touches `app_docs/studio.md` (worker, statuses, `skipped`, `cache_hit`, storage) and
  `app_docs/measurement.md` (`runToolsStep`, `recordHit`, the `steps` column set, `receive`
  removed); those two docs still describe the placeholder `receive` step in places.
