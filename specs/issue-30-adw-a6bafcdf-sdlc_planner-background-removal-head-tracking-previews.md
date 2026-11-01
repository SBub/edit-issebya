# Feature: fixed pipeline steps part two: background removal, head tracking, preview copies

## Metadata

issue_number: `30`
adw_id: `a6bafcdf`
issue_json: `{"number":30,"title":"feat: fixed pipeline steps part two: background removal, head tracking, preview copies"}`

## Feature Description

Reel studio MVP, slice 7 of 17. The worker's `process` job already runs `convert`, `transcribe` and
`retime` (issue #29), each cached in R2 under a fingerprint of everything it reads. This slice adds
the last three fixed steps after `retime`:

1. `remove_background`: the cut-out of the speaker, HyperFrames' `remove-background` on the retimed
   `source.mp4` with its current `u2net_human_seg` model, VP9 with alpha in WebM.
2. `head_track`: the head's top, centre and width over time, read from the cut-out's alpha every
   0.25 s, a TypeScript port of the old `head_track.py`. Captions are later placed around the head
   (decision C3, slice 8's builder).
3. `preview_copies`: small copies of the retimed footage (H.264) and of the cut-out (VP9 alpha WebM),
   540x960, same frame timing as the source, about 18 MB together for a 50 second reel, for the
   studio's live preview in Chrome (decision D5).

Each step goes through the same fingerprint cache (decision B5), so none runs twice; a failed job
resumes at the failed step; a version bump re-runs that step and the ones after it. Every output of
every step is tagged `kept` or `rebuildable` in the step definition (decision B6), so slice 14 can
delete the heavy rebuildable files. The reel status continues `removing_background`,
`tracking_head`, `making_previews`, then `processed`.

## User Story

As the studio owner
I want every uploaded reel to come out of the worker with its cut-out, its head track and its small
preview copies, each computed once and reused afterwards
So that the builder and the live preview have everything they need except the edit itself, without
paying seven minutes of background removal twice.

## Problem Statement

After #29 a processed reel has retimed footage and a retimed transcript, but no cut-out of the
speaker (needed for text behind the subject), no head position (needed to place captions) and nothing
small enough for a browser preview. These steps were done by hand in the old setup
(`rethink-work/subject.webm`, `head_track.py`); background removal alone takes about seven minutes,
so it must never run twice for the same input, and slice 14 needs to know which outputs it may delete.

## Solution Statement

Add three `PipelineStep`s to `apps/worker/src/pipeline/` following the exact shape of `convert`,
`transcribe` and `retime`: declared inputs (earlier outputs by `{ step, fingerprint, file }`),
settings (every value in the fingerprint), a hand-bumped `version`, a `reelStatus`, outputs and a
`run` that writes under temporary names and renames on success. `PIPELINE` becomes six steps;
`runPipeline` needs no change in logic beyond a `.webm` content type and reading output file names
through the new output type.

- `remove_background` runs the installed HyperFrames entry (never npx) with
  `remove-background <source.mp4> -o subject.part.webm --device auto --quality balanced --json`,
  `HYPERFRAMES_NO_TELEMETRY=1`, and the worker's ffmpeg passed through `HYPERFRAMES_FFMPEG_PATH` /
  `HYPERFRAMES_FFPROBE_PATH` when `FFMPEG_PATH` is absolute. Settings: `device`, `quality`,
  `hyperframes` (the installed version). It parses the `--json` result line, then renames to
  `subject.webm`.
- `head_track` decodes `subject.webm` with ffmpeg (`-c:v libvpx-vp9` before `-i`, so alpha is kept)
  through `fps=4,scale=270:480` to raw RGBA in a scratch file, reads it frame by frame and hands each
  frame to a **pure** function that returns `{ t, head_top, cx, head_w } | null` in 1080x1920
  coordinates. The old room-specific sanity filter becomes optional bounds, off by default. Output
  `head-track.json`.
- `preview_copies` makes `footage.mp4` (H.264, 540x960, AAC copied) from the retimed `source.mp4` and
  `subject.webm` (VP9 `yuva420p`, `alpha_mode=1`, 540x960) from the cut-out, both keeping every frame
  and its timestamp, with bitrate caps chosen so 50 seconds total about 18 MB.
- `PipelineStep.outputs` becomes a list of `{ file, keep: "kept" | "rebuildable" }`. Heavy and
  rebuildable: `converted.mp4`, the retimed `source.mp4`, the full-size `subject.webm`. Everything
  else is `kept` (small JSON, and the preview copies, which cannot be regenerated cheaply because they
  hang off the seven-minute cut-out).
- A migration adds the three reel statuses; the studio's `REEL_STATUSES` and the worker's
  `PipelineReelStatus` follow.
- `fixtures/pipeline/` is regenerated with the six steps on `fixtures/footage/short-speech.mp4`
  (unchanged fixture clip; no person, so the cut-out is fully transparent and the head track all
  `null`, which is fine for cache hits), and `upload.spec.ts` expects six hits.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; nothing to change (it describes no feature).
- `AGENTS.md`: rules (Yarn only, no em-dashes, conventional commits without trailers, docs in
  `app_docs/`, the profile kept in step).
- `.adw/project.md`: the ADW profile. Its Tests section describes `test:tools` and the fixture clip;
  update it to say the background, head-track and preview tool tests run on
  `fixtures/footage/short-person.mp4`. Protected: never touch (modify, re-encode, replace)
  `fixtures/footage/short-person.mp4`; reading it in a test is fine. Never start the worker; only the
  spec spawns `once`.
- `docs/conditional-docs.md`: widen the `app_docs/pipeline.md` line (background removal, head
  tracking, preview copies, kept and rebuildable tags). No new line.
- `app_docs/pipeline.md`: the pipeline feature doc (from #29). Extend in place.
- `app_docs/studio.md`: lists reel statuses and the worker; add the three new statuses where they
  are listed.
- `app_docs/measurement.md`: the step runner and summaries; read for `runToolsStep`,
  `sampleGroupMemory` and the summary rule (`what, duration, size`). Touch only if it lists step names
  or statuses.
- `apps/worker/src/pipeline/definition.ts`: `PipelineStep`, `PIPELINE`, `fingerprintsFor`. Add the
  output type and the three steps.
- `apps/worker/src/pipeline/definition.test.ts`: order, outputs, inputs and fingerprint tests; extend.
- `apps/worker/src/pipeline/run-pipeline.ts`: reads `step.outputs`; switch to file names, add the
  `.webm` content type.
- `apps/worker/src/pipeline/run-pipeline.test.ts`: the fake tools (`fakeTools`) must play the new
  HyperFrames call and the new ffmpeg calls; status lists grow to six.
- `apps/worker/src/pipeline/convert.ts`, `transcribe.ts`, `retime.ts`: existing steps; their
  `outputs` get `keep` tags. `transcribe.ts` is the pattern for running HyperFrames; `retime.ts` for
  several tool calls, partial names and `writeAtomic`.
- `apps/worker/src/pipeline/retime-encode.ts`: pattern for an ffmpeg argument builder (pure,
  unit-tested).
- `apps/worker/src/pipeline/tools.ts`: `ToolPaths`, `HYPERFRAMES_VERSION`, `hyperframesEnv`; extend
  `hyperframesEnv` with the ffmpeg paths.
- `apps/worker/src/pipeline/tools.test.ts`: tests for `toolPaths`/`hyperframesEnv`; extend.
- `apps/worker/src/pipeline/atomic.ts`: `writeAtomic` for `head-track.json`.
- `apps/worker/src/pipeline/fingerprint.ts`, `canonical-json.ts`: fingerprint and cache key (no
  change; `null` is valid canonical JSON).
- `apps/worker/src/pipeline/pipeline-fixtures.test.ts`: fails while `fixtures/pipeline/` is stale;
  adapt to the new output type.
- `apps/worker/src/make-pipeline-fixtures.ts`: regenerates `fixtures/pipeline/`; adapt to the new
  output type.
- `apps/worker/src/pipeline/tools-test-support.ts`: `CLIP`, `REAL_TOOLS`, `realTool`, `ffmpeg`,
  `videoStream`; add `PERSON_CLIP` and helpers for frame counts, stream tags and raw frames.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `Tool`, `ToolCall.sampleGroupMemory`.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus`; add the three statuses.
- `apps/worker/src/recording-steps.ts`: test helper; uses `PipelineReelStatus` (type only).
- `apps/worker/src/doctor-checks.ts` (and its test): add the `libvpx-vp9` encoder and decoder check.
- `apps/worker/vitest.tools.config.ts`: tool tests config (10 min timeout already enough for a 4 s
  clip; the first run downloads the u2net model).
- `apps/studio/src/lib/reels.ts`, `apps/studio/src/lib/reels.test.ts`: `REEL_STATUSES`.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: accepts each step's reel status; add the three.
- `apps/studio/e2e/upload.spec.ts`: seeds `fixtures/pipeline/` and expects the step lines and hit
  rows; extend to six steps.
- `supabase/migrations/20261102090000_pipeline_steps.sql`: the current `reels_status_check`, to copy.
- `fixtures/pipeline/manifest.json` and `fixtures/pipeline/<step>/`: regenerated.
- `fixtures/footage/short-person.mp4`: read-only input of the new tool tests.
- `knip.json`: worker workspace already covers `src/**/*.ts` and both vitest configs; no change
  expected.
- Read-only reference: `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/head_track.py`
  (ported below), `subject.webm`, `head-track.json`. Never write there.
- HyperFrames 0.8.222 source (installed `node_modules/hyperframes/dist/remove-background-*.js` and
  the background-removal chunk): `--json` prints one line
  `{"ok":true,"outputPath","framesProcessed","durationSeconds","avgMsPerFrame","provider","format"}`;
  the output format is inferred from the `-o` extension (so the partial name must end in `.webm`);
  the WebM encode is `libvpx-vp9 -b:v 0 -crf <fast 30|balanced 18|best 12> -pix_fmt yuva420p
-metadata:s:v:0 alpha_mode=1 -an`; it finds ffmpeg through `HYPERFRAMES_FFMPEG_PATH` /
  `HYPERFRAMES_FFPROBE_PATH`, else PATH; the model is `u2net_human_seg`, cached in
  `~/.cache/hyperframes/background-removal/models/`.

### New Files

- `apps/worker/src/pipeline/remove-background.ts`: the `remove_background` step, its settings,
  `removeBackgroundArgs` and `parseRemoveBackgroundResult`.
- `apps/worker/src/pipeline/remove-background.test.ts`: pure tests of the argument builder and the
  result parser.
- `apps/worker/src/pipeline/remove-background.tools.test.ts`: real HyperFrames on
  `short-person.mp4` (verification 4).
- `apps/worker/src/pipeline/head-sample.ts`: the pure head-tracking functions.
- `apps/worker/src/pipeline/head-sample.test.ts`: synthetic RGBA frames (verification 1).
- `apps/worker/src/pipeline/head-track.ts`: the `head_track` step (decode, read frames, write JSON).
- `apps/worker/src/pipeline/head-track.tools.test.ts`: on the real cut-out of `short-person.mp4`
  (verification 5).
- `apps/worker/src/pipeline/preview-copies.ts`: the `preview_copies` step, settings and the two
  argument builders.
- `apps/worker/src/pipeline/preview-copies.test.ts`: pure argument tests.
- `apps/worker/src/pipeline/preview-copies.tools.test.ts`: real ffmpeg (verification 6).
- `supabase/migrations/20261103090000_pipeline_steps_part_two.sql`: the three reel statuses.
- `fixtures/pipeline/remove_background/subject.webm`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/preview_copies/footage.mp4`, `fixtures/pipeline/preview_copies/subject.webm`:
  generated by `fixtures:pipeline`, never by hand.

## Implementation Plan

### Phase 1: Foundation

- Make sure #29 is in the branch (it is not at `7d82d00`: `apps/worker/src/pipeline/` and
  `app_docs/pipeline.md` are missing). This slice is built on it.
- Make sure `fixtures/footage/short-person.mp4` exists (stop and report if not; never generate or
  download a substitute).
- Introduce the output type with `keep` tags and move every existing reader of `step.outputs` to it.
- Add the three reel statuses (migration, worker type, studio list, DB test).
- Extend `hyperframesEnv` so HyperFrames uses the worker's ffmpeg.

### Phase 2: Core Implementation

- `remove_background`: arguments, result parsing, the step.
- Pure head tracking (`head-sample.ts`) with unit tests, then the `head_track` step around it.
- `preview_copies`: two argument builders and the step.
- Pure tests for every builder and parser; tool tests on `short-person.mp4`.

### Phase 3: Integration

- `PIPELINE` gets the three steps in order; `runPipeline` gains the `.webm` content type.
- `run-pipeline.test.ts` fakes the new tools; definition tests cover order, statuses, tags and the
  HyperFrames-version fingerprint chain.
- `doctor` checks `libvpx-vp9`.
- Regenerate `fixtures/pipeline/`, extend `upload.spec.ts` to six hits.
- Docs: `app_docs/pipeline.md`, `app_docs/studio.md`, `docs/conditional-docs.md`, `.adw/project.md`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Check the base and the test clip

- `test -f apps/worker/src/pipeline/definition.ts && test -f app_docs/pipeline.md`. If either is
  missing, bring #29 in first: `git fetch origin` and, if `origin/develop` contains the #29 merge,
  `git merge --no-edit origin/develop`; otherwise `git merge --no-edit
feat/issue-29-adw-4a47b364-pipeline-convert-transcribe-retime` (the local branch exists). Then
  `yarn install --immutable` (HyperFrames 0.8.222 arrives with #29; an install that would change
  `yarn.lock` is a finding, report it).
- `test -f fixtures/footage/short-person.mp4`. If missing, stop and report it. Never modify that file.
- Run `supabase migration up --local` after the merge so #29's migration is applied before any DB or
  E2E test (the only database command ADW may run).

### 2. Tag every output `kept` or `rebuildable`

- In `definition.ts` add:
  ```ts
  // Slice 14 deletes `rebuildable` outputs (heavy, cheap to make again from a
  // kept input); `kept` outputs are never deleted.
  export type OutputKeep = "kept" | "rebuildable";
  export interface StepOutput {
    file: string;
    keep: OutputKeep;
  }
  ```
  and change `PipelineStep.outputs` to `readonly StepOutput[]`. Add
  `export function outputFiles(step: PipelineStep): string[]` (the file names in order).
- Tag existing outputs: `convert` `converted.mp4` rebuildable; `transcribe` `transcript.json` kept;
  `retime` `source.mp4` rebuildable, `transcript.json`, `retime.json`, `envelope.json` kept.
- Update `run-pipeline.ts` (`step.outputs.map(({ file }) => ...)`, `entries()` loops),
  `make-pipeline-fixtures.ts` and `pipeline-fixtures.test.ts` (manifest `files` stays a list of
  names: `outputFiles(step)`), and `definition.test.ts`'s output assertions. Tags are not in the
  fingerprint, so the three existing fingerprints do not change.
- `contentType` in `run-pipeline.ts`: `.webm` gives `video/webm`.

### 3. New reel statuses

- `supabase/migrations/20261103090000_pipeline_steps_part_two.sql`: a header comment in the style of
  `20261102090000_pipeline_steps.sql`, then drop and re-add `reels_status_check` with `uploading`,
  `uploaded`, `received`, `converting`, `transcribing`, `retiming`, `removing_background`,
  `tracking_head`, `making_previews`, `processed`, `failed`.
- `apps/worker/src/step-store.ts`: `PipelineReelStatus` adds the three.
- `apps/studio/src/lib/reels.ts` `REEL_STATUSES` adds them after `retiming`; update
  `reels.test.ts`.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: the accepted list adds the three.
- `supabase migration up --local`.

### 4. HyperFrames uses the worker's ffmpeg

- `tools.ts`: `hyperframesEnv(env = process.env, tools?: ToolPaths)` keeps forcing
  `HYPERFRAMES_NO_TELEMETRY=1` and, when `tools` is given and `tools.ffmpeg` is absolute, sets
  `HYPERFRAMES_FFMPEG_PATH` and `HYPERFRAMES_FFPROBE_PATH` to `tools.ffmpeg` / `tools.ffprobe`
  (a bare `ffmpeg` is left to PATH: HyperFrames requires a configured path to exist).
- `transcribe.ts` passes `tools` as well. Extend `tools.test.ts` (absolute path sets both, bare name
  sets neither, telemetry always `1` even if the env says otherwise).

### 5. `remove_background`

- `remove-background.ts`:
  ```ts
  const REMOVE_BACKGROUND_VERSION = 1;
  // HyperFrames' current u2net model (u2net_human_seg), fixed by its version:
  // faster methods are issue #20's, not this step's (app_docs/pipeline.md).
  export const REMOVE_BACKGROUND_SETTINGS = {
    device: "auto",
    quality: "balanced",
    hyperframes: HYPERFRAMES_VERSION,
  };
  ```
  `removeBackgroundArgs(input, output, settings)` returns
  `["remove-background", input, "-o", output, "--device", settings.device, "--quality",
settings.quality, "--json"]`.
  `parseRemoveBackgroundResult(stdout)` takes the last stdout line that parses as a JSON object,
  requires `ok === true` and `format === "webm"`, returns `{ framesProcessed, provider }`; anything
  else throws a message naming what was missing.
- The step: `name: "remove_background"`, `reelStatus: "removing_background"`,
  `outputs: [{ file: "subject.webm", keep: "rebuildable" }]`, `reusedWhat: "background removed"`,
  input `{ step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" }` as `source.mp4`.
  `run`: one `tool` call `{ file: node, args: [entry, ...removeBackgroundArgs(files["source.mp4"],
join(dir, "subject.part.webm"), settings)], env: hyperframesEnv(process.env, tools),
sampleGroupMemory: true }` (HyperFrames spawns ffmpeg and the model runtime), parse the result,
  `rename` the partial to `subject.webm`, return `{ what: "background removed" }` (the runner appends
  the duration and the size: `background removed, 6 minutes 47 seconds, 51.0 MB`).
- No other model, no Apple Vision, no mask as H.264, no frame-reader patch, no decode size change.
- `remove-background.test.ts`: the exact argument list; the parser accepts a real-shaped line after
  other output, rejects `ok: false`, a non-webm format, no JSON at all.

### 6. Pure head tracking

- `head-sample.ts`, a port of `head_track.py`, no I/O:
  ```ts
  export const HEAD_TRACK_SETTINGS = {
    analysisWidth: 270,
    analysisHeight: 480,
    // Analysis pixels to 1080x1920 output pixels.
    scale: 4,
    samplesPerSecond: 4,
    alphaThreshold: 128,
    minRowPixels: 4,
    bandStart: 20,
    bandEnd: 50,
    // The old filter's bounds were one room's (an arch merged into the head):
    // off by default, each a number to turn it on.
    bounds: { minHeadTop: null, minHeadWidth: null, maxHeadWidth: null },
  };
  export interface HeadSample {
    t: number;
    head_top: number;
    cx: number;
    head_w: number;
  }
  ```
  (bounds typed `number | null`).
  - `headSample(frame: Uint8Array, index: number, settings): HeadSample | null`. For each analysis
    row, the opaque columns are those with alpha (`frame[(y * W + x) * 4 + 3]`) strictly above
    `alphaThreshold`. The head top is the first row with at least `minRowPixels` opaque columns;
    none gives `null`. For rows `top + bandStart` up to (excluding) `min(H, top + bandEnd)`, every
    row with any opaque column contributes the span `(first, last)`; none gives `null`. Sort spans by
    `last - first` (stable), take `spans[Math.floor(spans.length / 2)]`. Output
    `t = round(index / samplesPerSecond, 2)`, `head_top = top * scale`,
    `cx = Math.floor((x0 + x1) / 2) * scale`, `head_w = (x1 - x0) * scale`. Then the bounds: a sample
    with `head_top < minHeadTop`, `head_w < minHeadWidth` or `head_w > maxHeadWidth` (each only when
    not `null`) becomes `null`.
  - `trackHead(frames: Iterable<Uint8Array>, settings): (HeadSample | null)[]` maps `headSample`.
  - A frame whose length is not `W * H * 4` throws.
- `head-sample.test.ts` (verification 1), all with frames built in the test:
  - an opaque ellipse (centre and radii chosen, for example centre (135, 200), radii 40 x 55, in
    analysis pixels) gives `head_top`, `cx` and `head_w` within 4 px of the truth computed from the
    ellipse in 1080x1920 coordinates;
  - a fully transparent frame gives `null`; a row of 3 opaque pixels does not count as a top;
    alpha exactly 128 is transparent;
  - with `bounds.minHeadTop` above the ellipse's top the sample becomes `null`, likewise
    `maxHeadWidth` below its width and `minHeadWidth` above it; with the default bounds it is kept;
  - `t` is `index / 4` rounded to two decimals; a wrong frame length throws.

### 7. `head_track`

- `head-track.ts`, version 1, settings `HEAD_TRACK_SETTINGS`, `reelStatus: "tracking_head"`,
  `outputs: [{ file: "head-track.json", keep: "kept" }]`, `reusedWhat: "head tracked"`, input
  `{ step: "remove_background", ..., file: "subject.webm" }` as `subject.webm`.
- `headTrackDecodeArgs(input, output, settings)`: `-hide_banner -v error -y -c:v libvpx-vp9 -i
<input> -vf fps=<samplesPerSecond>,scale=<W>:<H> -pix_fmt rgba -f rawvideo <output>` (the
  `libvpx-vp9` decoder before `-i`: ffmpeg's native VP9 decoder drops alpha). Pure test of the list.
- `run`: decode to `frames.rgba` in the step folder (`cwd: dir`), read it with a file handle one
  frame (`W * H * 4` bytes) at a time into `headSample` (a 50 s reel is about 100 MB of raw frames:
  never read it whole), throw when the size is not a whole number of frames, remove `frames.rgba`,
  `writeAtomic(join(dir, "head-track.json"), JSON.stringify(track) + "\n")`. The format is the old
  one: a JSON array, one entry per 0.25 s, each `{ "t", "head_top", "cx", "head_w" }` in 1080x1920
  pixels or `null`.
- An all-`null` track is not a failure (no person in frame); return
  `{ what: \`head tracked, ${n} samples, ${missing} without a head\` }`.

### 8. `preview_copies`

- `preview-copies.ts`, version 1:
  ```ts
  // About 18 MB together for a 50 second reel (2.9 Mbit/s): the footage's video
  // and its copied 256k AAC, plus the cut-out.
  export const PREVIEW_SETTINGS = {
    width: 540,
    height: 960,
    keyframeSeconds: 1,
    frameRate: 30,
    footage: { codec: "libx264", preset: "medium", crf: 23, maxrate: "1400k", bufsize: "2800k" },
    subject: { codec: "libvpx-vp9", crf: 34, bitrate: "1000k", deadline: "good", cpuUsed: 2 },
  };
  ```
  (starting values; the owner's run on `rethink-work` confirms the 18 MB, and a change bumps the
  fingerprint by itself because every value is a setting).
- `previewFootageArgs(input, output, settings)`: `-hide_banner -v error -y -i <source.mp4> -map 0:v:0
-map 0:a:0? -vf scale=540:960:flags=lanczos -fps_mode passthrough -c:v libx264 -preset medium
-crf 23 -maxrate 1400k -bufsize 2800k -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p
-c:a copy -movflags +faststart <output>` (g from `keyframeSeconds * frameRate`).
- `previewSubjectArgs(input, output, settings)`: `-hide_banner -v error -y -c:v libvpx-vp9 -i
<subject.webm> -vf scale=540:960:flags=lanczos -fps_mode passthrough -c:v libvpx-vp9 -crf 34
-b:v 1000k -deadline good -cpu-used 2 -row-mt 1 -auto-alt-ref 0 -g 30 -pix_fmt yuva420p
-metadata:s:v:0 alpha_mode=1 -an <output>` (`-auto-alt-ref 0` and `alpha_mode=1` are what Chrome
  needs to play the alpha).
- The step: `name: "preview_copies"`, `reelStatus: "making_previews"`,
  `outputs: [{ file: "footage.mp4", keep: "kept" }, { file: "subject.webm", keep: "kept" }]`,
  `reusedWhat: "preview copies made"`, inputs retime's `source.mp4` and remove_background's
  `subject.webm`. Two `tool` calls writing `footage.part.mp4` and `subject.part.webm` (extensions
  kept so ffmpeg picks the muxer), each renamed after its exit 0. Return
  `{ what: "preview copies made" }` (runner appends `, <duration>, 18.0 MB`).
- `preview-copies.test.ts`: both argument lists, the size and rate values from the settings, alpha
  flags on the WebM, the `libvpx-vp9` decoder before `-i`.

### 9. Wire the pipeline

- `PIPELINE = [convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.
- `definition.test.ts`:
  - order and statuses: the six `[name, reelStatus]` pairs;
  - outputs: names per step (`subject.webm`; `head-track.json`; `footage.mp4`, `subject.webm`), and
    the tags (verification 3): `remove_background`'s `subject.webm` is `rebuildable`, both
    `preview_copies` outputs are `kept`, every output of every step has a tag;
  - verification 2: replacing `remove_background.settings.hyperframes` with another version leaves
    `convert`, `transcribe`, `retime` unchanged and changes `remove_background`, `head_track` and
    `preview_copies`. The existing every-leaf and version tests now cover the new steps too (the
    `null` bounds leaves included).
- `run-pipeline.test.ts`: `fakeTools` also plays `remove-background` (write the file after `-o`,
  answer the JSON line on stdout), the head-track decode (write a raw RGBA file with a whole number of
  frames of the analysis size; the args contain `-f rawvideo`) and the two preview encodes (write the
  last argument). Every status list grows by `removing_background`, `tracking_head`,
  `making_previews`. Add one case: a stored `remove_background` output with `head_track` missing
  downloads `subject.webm` only and spawns only the decode, no HyperFrames (resume from the failed
  step without running background removal twice). Uploads of `.webm` carry `video/webm`.
- `doctor-checks.ts`: one check that `ffmpeg -encoders` and `ffmpeg -decoders` both list
  `libvpx-vp9`; extend its test in the existing style.

### 10. Tool tests on the person clip (`test:tools`, the Mac only)

- `tools-test-support.ts`: `PERSON_CLIP` (`fixtures/footage/short-person.mp4`), `frameCount(path)`
  (`-count_frames -show_entries stream=nb_read_frames`, with `-c:v libvpx-vp9` before `-i` for WebM),
  `streamTags(path)`, and `rawAlphaFrame(path, seconds, width, height)` (one decoded frame through
  `-c:v libvpx-vp9 -ss <s> -i ... -frames:v 1 -vf alphaextract -f rawvideo -pix_fmt gray -`).
- The real tools read the clip in place; nothing writes beside it. One shared `beforeAll` per file
  (or a small shared helper) runs `remove_background` once on `PERSON_CLIP` into a temp folder, since
  the clip is already H.264 30 fps 1080x1920 like a retimed `source.mp4`.
- `remove-background.tools.test.ts` (verification 4): the output's codec is `vp9` in a WebM, and it
  carries alpha (the stream tag `alpha_mode`, compared case-insensitively, is `1`, or the
  `libvpx-vp9`-decoded `pix_fmt` is `yuva420p`); the 2 s alpha frame holds both `0` and `255`.
- `head-track.tools.test.ts` (verification 5): on that cut-out, `head_track.run` writes 16 samples
  (4 s at 4 per second, allow 16 or 17), at least 80 percent non-null, every non-null `cx` within
  `0..1080`, and the `what` line matches the counts.
- `preview-copies.tools.test.ts` (verification 6): `footage.mp4` and `subject.webm` are 540x960;
  each has the same frame count as its source within one frame (so the same duration within 1/30 s);
  the WebM keeps alpha (as in verification 4); total bytes per second of the two stay under 18 MB /
  50 s times 1.5.

### 11. Fixtures and the E2E spec

- `yarn workspace @edit-issebya/worker fixtures:pipeline` (real tools on `short-speech.mp4`; the
  first run downloads the u2net model). Commit the regenerated `fixtures/pipeline/` (manifest with six
  steps). `pipeline-fixtures.test.ts` must pass. The fixture clip stays `short-speech.mp4`: the spec
  uploads it, so its ETag is the fixtures' source; its cut-out is transparent and its head track all
  `null`, which is all a hit needs.
- `apps/studio/e2e/upload.spec.ts` (verification 7): the expected step lines become
  `convert: footage converted, reused`, `transcribe: transcribed, reused`,
  `retime: retimed, reused`, `remove_background: background removed, reused`,
  `head_track: head tracked, reused`, `preview_copies: preview copies made, reused`; the step rows
  six `hit(...)`s in that order; the reel page still ends on `processed`, live (the `__noReload`
  marker). This spec fails without the feature (three lines, three rows).

### 12. Docs and profile

- `app_docs/pipeline.md` (in place): title and overview to six steps; the statuses; a section per
  new step (command and settings, `u2net_human_seg` named, the HyperFrames ffmpeg variables;
  head-track algorithm and format `[{ t, head_top, cx, head_w } | null]` in 1080x1920 pixels every
  0.25 s, the bounds off by default; preview sizes 540x960, codecs, the bitrate caps, about 18 MB per
  50 s, alpha flags for Chrome); the `kept`/`rebuildable` table for every output; Testing (new pure
  tests, the tool tests on `short-person.mp4`, six hits in E2E); Rules: add "Do not change the
  background removal model or method (Apple Vision, mask as H.264, a frame-reader patch, a decode
  size change) until issue #20 is taken up", "Every output carries a `kept` or `rebuildable` tag",
  "Never touch `fixtures/footage/short-person.mp4`"; Notes: the old room-specific bounds
  (`head_top >= 380`, `220 <= head_w <= 420`) for the manual comparison. No em-dashes.
- `app_docs/studio.md`: the status list where it appears.
- `docs/conditional-docs.md`: widen the `app_docs/pipeline.md` line (background removal, head
  tracking, preview copies, kept/rebuildable tags, `short-person.mp4` tool tests). No new line.
- `.adw/project.md` Tests section: `test:tools` also runs background removal, head tracking and
  preview copies on `fixtures/footage/short-person.mp4`; `upload.spec.ts` sees six hits. Headings
  untouched.

### 13. Validation

- Run every command in `Validation Commands`, in order, and fix anything that fails without
  weakening a test, a rule or a type.

## Testing Strategy

### Unit Tests

- `head-sample.test.ts`: the ellipse within 4 px, empty frame `null`, the row-pixel and alpha
  thresholds, each bound on and off, `t` rounding, wrong frame size.
- `remove-background.test.ts`: argument list; result parser on good, failed, wrong-format and
  missing JSON.
- `preview-copies.test.ts`: both argument lists, alpha flags, decoder placement, sizes and caps from
  settings.
- `head-track` decode args (in `head-sample.test.ts` or a small `head-track.test.ts`).
- `definition.test.ts`: six steps in order with statuses, output names and tags, the HyperFrames
  version chain, every leaf and version (now including the new steps).
- `run-pipeline.test.ts`: six-step run with fake tools, statuses, hits spawn nothing, resume after
  the cut-out without HyperFrames, `.webm` content type.
- `tools.test.ts`: `hyperframesEnv` ffmpeg variables.
- `doctor-checks.test.ts`: `libvpx-vp9` present and missing.
- `pipeline-fixtures.test.ts`: fixtures match the six-step definition.
- `reels.test.ts`: the status list.

### Test Coverage

- Unit (`apps/worker/src/pipeline/head-sample.test.ts`, vitest): catches a wrong head top, centre,
  width or bound handling in the port; nothing tests head tracking today.
- Unit (`definition.test.ts`): catches a step missing from `PIPELINE`, a wrong order or status, an
  untagged or wrongly tagged output, and a HyperFrames version that does not invalidate the cut-out
  and everything after it.
- Unit (`run-pipeline.test.ts`): catches a new step not cached, not resumed, or running
  HyperFrames again when only head tracking is missing.
- Unit (`remove-background.test.ts`, `preview-copies.test.ts`): catches a dropped `--json`, a lost
  alpha flag or decoder, a wrong preview size.
- DB (`apps/studio/db-tests/pipeline-statuses.test.ts`): catches a missing migration for the three
  reel statuses (the worker's status write would fail at run time).
- E2E (`apps/studio/e2e/upload.spec.ts`): catches the worker not recording six hits or the page not
  showing the new step lines live; fails today with three.
- Tools (`*.tools.test.ts`, `test:tools`, the owner's Mac, never CI): catches HyperFrames not
  producing alpha, head tracking finding no head on a real person, preview copies with the wrong
  size, timing or no alpha.

### Edge Cases

- No person in frame (the E2E fixture clip): fully transparent cut-out, all-`null` track, step
  succeeds, summary `16 samples, 16 without a head`.
- A raw frames file that is not a whole number of frames (a killed decode): the step fails.
- HyperFrames prints something other than the JSON line, or `ok: false`: the step fails with the
  tail; the partial `subject.part.webm` is never uploaded (not an output name).
- A lost lease mid-step: nothing more uploaded (existing runner behaviour).
- `remove_background` stored but `head_track` missing: no HyperFrames call, only the cut-out
  downloaded.
- `FFMPEG_PATH` a bare name: HyperFrames left to PATH; absolute: both HyperFrames variables set.
- A frame with an opaque top but nothing in the band (a thin line): `null`.
- Bounds `null` keep everything; a bound set filters only on its own comparison.
- An odd number of band spans: middle; even: the upper middle (`floor(n / 2)`), as the reference.
- Source without audio: `-map 0:a:0?` lets the footage copy succeed (the retime step already
  requires audio, so this is defensive only).

## Acceptance Criteria

- `PIPELINE` is `convert, transcribe, retime, remove_background, head_track, preview_copies`, with
  reel statuses `converting, transcribing, retiming, removing_background, tracking_head,
making_previews`, then `processed`.
- `remove_background` runs the installed HyperFrames `remove-background ... --device auto --json`
  with `HYPERFRAMES_NO_TELEMETRY=1`; its settings `device`, `quality`, `hyperframes` are in the
  fingerprint; output `subject.webm` tagged `rebuildable`.
- `head_track` is a pure function over RGBA frames plus a decode step; output `head-track.json` in
  the old format; bounds off by default.
- `preview_copies` writes `footage.mp4` (H.264) and `subject.webm` (VP9 alpha), 540x960, same frame
  count as their sources, both `kept`.
- Every output of every step has a `kept` or `rebuildable` tag.
- Changing the HyperFrames version setting of `remove_background` changes its fingerprint and those
  of `head_track` and `preview_copies`, and none before.
- Summaries read like `background removed, <duration>, <size>`, `head tracked, N samples, M without a
head, ...`, `preview copies made, <duration>, <size>`.
- The E2E upload spec shows six `..., reused` lines and six skipped hit rows, and `processed`, live.
- `test:tools` passes on the Mac on `short-person.mp4` (verifications 4 to 6).
- Background removal is still HyperFrames' u2net; none of issue #20's options is implemented.
- `fixtures/footage/short-person.mp4` is unchanged (`git diff --stat` shows nothing for it).
- `app_docs/pipeline.md`, `app_docs/studio.md`, `docs/conditional-docs.md` and `.adw/project.md`
  updated; no em-dashes anywhere.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies #29's and this slice's migrations to the shared local
  stack before DB and E2E tests (the only database command ADW may run; on failure report and stop).
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio`: ESLint in both changed
  workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio`: types, including the
  new output type everywhere it is read.
- `yarn knip`: no unused exports or files from the new modules.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio`: unit tests (head tracking,
  definition, run-pipeline, builders, fixtures freshness, statuses).
- `yarn turbo run test:db --filter=./apps/studio`: the reel statuses migration.
- `yarn workspace @edit-issebya/worker test:tools`: real HyperFrames and ffmpeg on the person clip
  (the owner's Mac only; skip in CI and say so).
- `yarn turbo run build --filter=./apps/studio`: the studio still builds (the worker's build check
  is its typecheck).
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's full gate, unfiltered.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E
  suites against the run's server (started by `/prepare_app` with the Workspaces dev command);
  `upload.spec.ts` must show six hits.
- `git diff --exit-code -- fixtures/footage/short-person.mp4`: the person clip is untouched.
- `grep -rn $'\u2014' app_docs docs specs apps/worker/src apps/studio/src apps/studio/e2e supabase .adw`
  returns nothing: no em-dashes.

## Notes

- No new dependency: HyperFrames 0.8.222 (pinned by #29) already ships `remove-background`; ffmpeg
  with `libvpx-vp9` is required on the worker's machine (checked by `doctor`).
- The first `remove-background` run downloads `u2net_human_seg.onnx` (about 170 MB) into
  `~/.cache/hyperframes/background-removal/models/`; the tool tests and `fixtures:pipeline` need
  network once on the Mac. CI never runs them.
- This branch is based on `7d82d00`, which does not contain #29. Task 1 merges it; until #29 lands
  in `develop` the PR also shows #29's diff.
- No browser coverage beyond extending `upload.spec.ts`: the slice adds no screen; the reel page
  already renders whatever step lines and status exist. No visual review needed.
- Not verified by the pipeline (owner's manual acceptance): the cut-out against
  `rethink-work/subject.webm` at 10 s and 25 s, the head track against `rethink-work/head-track.json`
  (same sample count, within a few pixels where the old filter kept a sample: set
  `bounds = { minHeadTop: 380, minHeadWidth: 220, maxHeadWidth: 420 }` for that comparison only),
  the 18 MB preview size on 50 s of real footage, and about 7 minutes for background removal.
- Out of scope: faster background removal (issue #20), progress percentage (slice 15), deleting
  rebuildable files (slice 14, which reads the tags), the builder that uses the head track (slice 8).
- The ffmpeg build is in no fingerprint (as in #29): an ffmpeg upgrade that changes output needs a
  hand version bump.
