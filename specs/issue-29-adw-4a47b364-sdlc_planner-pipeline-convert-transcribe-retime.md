# Feature: fixed pipeline steps part one: convert, transcribe, retime, each cached by input fingerprint

## Metadata

issue_number: `29`
adw_id: `4a47b364`
issue_json: `{"number":29,"title":"feat: fixed pipeline steps part one: convert, transcribe, retime, each cached by input fingerprint"}`

## Feature Description

Reel studio MVP, slice 6 of 17. After an upload the worker's `process` job stops running the
placeholder `receive` step and runs the first three fixed pipeline steps as plain TypeScript, with
no AI:

1. **convert**: ffmpeg turns the phone footage into H.264, constant 30 fps, a keyframe every 1 s,
   audio copied when it is AAC (else encoded to AAC), `+faststart`. HDR footage (`smpte2084` or
   `arib-std-b67` transfer) is tone-mapped to SDR BT.709; a variable frame rate becomes a steady 30.
2. **transcribe**: the HyperFrames CLI (`transcribe --engine whisper --model small --language en
--json`, `HYPERFRAMES_NO_TELEMETRY=1`, binary from `node_modules`) gives word-level timings,
   normalised into the studio's transcript format where every word has a stable id (`w0001`).
3. **retime**: a pure planner (transcript + audio envelope + settings in, segments with speed out)
   and one ffmpeg encode that applies it: 1.05x generally, 1.1x on slow stretches, every speed
   boundary inside a silent gap (below -40 dB), short gaps protected (silent middle frame slowed),
   a 30 ms end fade, and optional pause cutting (off by default). Outputs `source.mp4`, the retimed
   `transcript.json` (same ids, new times) and `retime.json` (original to new time map).

Each step declares its inputs (files by fingerprint), its settings (a plain object) and its code
version. Its fingerprint is SHA-256 over the canonical JSON of those three; its outputs live at
`${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`. A step whose outputs are all present is
recorded `skipped` with `cache_hit = true` and spawns nothing; a failed job resumes from the step
that failed; outputs are never overwritten. The reel moves through `converting`, `transcribing`,
`retiming`, `processed` (or `failed`), and the studio's existing live status shows each step line.

The new pipeline must reproduce what the old Python scripts made from the same footage (the
`rethink-work` reel is the reference, compared by hand by the owner).

## User Story

As the studio owner
I want every upload to be converted, transcribed and retimed automatically, exactly once per input
So that each reel gets the same clean, retimed source as the old scripts made, without paying twice
for a step, and a failed job picks up where it stopped

## Problem Statement

The worker only HEADs the uploaded file (`receive`). The real conversion, transcription and retime
live in ~700 lines of Python in another repository, run by hand. Without a cached, ordered
pipeline every retry would redo minutes of encoding and whisper, a half-uploaded output could be
mistaken for a finished one, and phone footage with HDR colour or a variable frame rate would come
out washed out or drift out of sync.

## Solution Statement

- A **pipeline definition** (`apps/worker/src/pipeline/`): an ordered list of step objects, each
  with `name`, `version` (a hand-bumped constant), `settings` (a plain preset object), `inputs`
  (a function from the source reference and earlier steps' fingerprints to file references),
  `outputs` (file names), the reel status it sets, and `run` (the code that makes the outputs
  locally through an injected tool runner).
- **Fingerprints**: `sha256(canonicalJson({ inputs, settings, version }))`. A file reference is
  either the uploaded source, identified by its storage ETag and byte size (`{ source: { etag,
bytes } }`, read from one HEAD, so no download is needed to decide a hit), or a cached output,
  identified by its producer (`{ step, fingerprint, file }`): cached outputs are immutable under
  their fingerprint, so the producer's fingerprint identifies their content.
- **Runner** (`run-pipeline.ts`): for each step it computes the fingerprint, HEADs every output
  key, and either records a hit (no download, no process) or sets the reel status, downloads the
  inputs it needs into the job's scratch folder, runs the step through the measuring step runner,
  and uploads each output with "put if absent" (never overwrite). Local files are written under a
  temporary name and renamed; uploads are single completed PUTs.
- **Step runner extension**: `runToolsStep` lets one step row cover several tool calls (ffprobe,
  ffmpeg envelope, ffmpeg encode), summing CPU and keeping the peak memory; `runStep` becomes a
  one-call wrapper over it with unchanged behaviour; `recordHit` writes a `skipped` row with
  `cache_hit = true` and a span.
- **Storage**: `head` also returns the ETag; new `getFile` (stream to a `.part` file, then rename)
  and `putFileIfAbsent` (R2 `If-None-Match: *`, the fake hard-links a finished temp file) on the
  shared `Storage` interface.
- **Database**: one migration adds `steps.cache_hit boolean not null default false`, the `skipped`
  step status and the reel statuses `converting`, `transcribing`, `retiming`, `processed`.
- **Tests**: pure tests in `yarn test` with a fake tool runner and the folder fake; a separate
  `test:tools` script runs the real ffmpeg and HyperFrames on the committed clip on the owner's
  Mac; the E2E upload spec seeds the committed step outputs (`fixtures/pipeline/`) under their
  fingerprints so every step is a hit in CI.

## Relevant Files

Use these files to implement the feature:

- `README.md`: the "Run the worker locally" and "Checks" sections gain `test:tools` and
  `fixtures:pipeline`.
- `AGENTS.md`: working rules (Yarn only, no em-dashes, doc rules, `.adw/project.md` upkeep). No
  change.
- `.adw/project.md`: Tests section gains `test:tools` as a step for runs targeting the worker, and
  the seeded `fixtures/pipeline/`; never rename or reorder its nine headings.
- `docs/conditional-docs.md`: add one line for `app_docs/pipeline.md`; widen the studio and
  measurement lines' wording if needed.
- `app_docs/studio.md`: the worker, reel statuses, `steps`, storage doubles. Its Rules are
  invariants (never put large content in rows, never point a test at real R2, never stage
  `.e2e-storage/`, never create an R2 client at module load, never turn a double on unless exactly
  `"true"`). Update the Worker, Reels and Jobs sections (`receive` replaced, new statuses).
- `app_docs/measurement.md`: the step runner and its entry points, the `steps` column set; its
  Rules are invariants (never measure the whole machine, never send measurements as events). Update
  for `runToolsStep`, `recordHit`, `cache_hit` and the removal of `receive`.
- `apps/worker/package.json`: scripts (`test:tools`, `fixtures:pipeline`), the exact `hyperframes`
  dependency.
- `apps/worker/.env.example`: `FFMPEG_PATH`, `HYPERFRAMES_NO_TELEMETRY`, `R2_KEY_PREFIX`,
  `WORKER_SCRATCH_DIR` already exist; use these names exactly, add none.
- `apps/worker/vitest.config.ts`: exclude `*.tools.test.ts` from the pure suite.
- `apps/worker/src/config.ts`: add `keyPrefix` (from `R2_KEY_PREFIX`) and the tool paths.
- `apps/worker/src/process-job.ts`: replace `receive` with `runPipeline`.
- `apps/worker/src/queue.ts`: `finishJob` sets the reel to `processed`.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `recordHit`, an injectable tool spawner,
  captured stdout.
- `apps/worker/src/step-runner.test.ts`, `apps/worker/src/telemetry.test.ts`: existing runner
  tests; must still pass unchanged (they prove `runStep` keeps its behaviour).
- `apps/worker/src/step-store.ts`: `skipped` and `reelStatus` writes.
- `apps/worker/src/recording-steps.ts`: the recording store gains `skipped` and `reelStatus`
  calls.
- `apps/worker/src/steps/receive.ts`, `apps/worker/src/steps/receive.test.ts`: removed (the
  pipeline's source HEAD replaces it).
- `apps/worker/src/doctor-checks.ts`, `apps/worker/src/doctor.ts`: add checks that the ffmpeg
  build has `zscale`, `tonemap`, `atempo`, `astats` and `ametadata`, and that the HyperFrames binary
  answers `--version`.
- `apps/worker/src/storage.ts`: unchanged factory; uses the extended interface.
- `packages/storage/src/storage.ts`, `fake.ts`, `r2.ts`, `index.ts` and their tests: `head` ETag,
  `getFile`, `putFileIfAbsent`, atomic fake writes, shared `keyPrefix`.
- `apps/studio/src/lib/storage.ts`: `keyPrefix` moves to `@edit-issebya/storage`; the studio
  imports it from there.
- `apps/studio/src/lib/reels.ts`, `apps/studio/src/lib/jobs.ts`,
  `apps/studio/test-support/fixtures.ts`: the new reel statuses and the `skipped` step status.
- `apps/studio/src/components/LiveReel.tsx`: renders the step lines; no markup change is needed
  (a hit's summary reads `... , reused`).
- `apps/studio/e2e/upload.spec.ts`: extended to seed the pipeline outputs and expect every step
  as a hit and the reel `processed`.
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` (its `env` argument carries
  `R2_KEY_PREFIX`).
- `apps/studio/db-tests/steps-measurements.test.ts`: the pinned `steps` column set gains
  `cache_hit`.
- `supabase/migrations/20261031105245_studio_skeleton.sql`,
  `supabase/migrations/20261031174750_job_queue.sql`: the existing `reels.status` (inline check,
  auto-named `reels_status_check`) and `steps_status_check` constraints the new migration replaces.
- `knip.json`: the worker's vitest config list.
- `.prettierignore`: generated JSON fixtures.
- `scripts/make-test-clip.sh`: the fixture clip's spoken sentence ("This is a short test clip for
  the reel studio.").
- `fixtures/footage/short-speech.mp4`: the committed clip every tool test and the E2E use. Never
  touch `fixtures/footage/short-person.mp4`.
- Reference, read-only, another repository (never written):
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/` (`brief.md`,
  `retime.py`, `fix_words.py`, `transcript-1x.json`, `transcript-1x-whisper.json`,
  `checks/envelope-1x.json`, `retime.json`, `source-1x.mp4`, `source.mp4`) and
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/setup-notes.md`.

### New Files

- `supabase/migrations/20261102090000_pipeline_steps.sql`: `cache_hit`, `skipped`, new reel
  statuses.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: the new statuses are accepted, an unknown one
  rejected, `cache_hit` defaults to false.
- `apps/worker/src/pipeline/canonical-json.ts` (+ `.test.ts`): sorted-key, whitespace-free JSON
  that refuses `undefined`, functions and non-finite numbers.
- `apps/worker/src/pipeline/fingerprint.ts` (+ `.test.ts`): `fingerprint({ inputs, settings,
version })`, `cacheKey(prefix, step, fingerprint, file)`, the `FileRef` type.
- `apps/worker/src/pipeline/definition.ts` (+ `.test.ts`): `PIPELINE`, the ordered steps and the
  `PipelineStep` type; the test walks every leaf of every step's settings.
- `apps/worker/src/pipeline/run-pipeline.ts` (+ `.test.ts`): the runner (hit, download, run,
  upload, statuses, scratch clean-up).
- `apps/worker/src/pipeline/tools.ts`: the tool paths (`ffmpeg`, `ffprobe` beside `FFMPEG_PATH`,
  the HyperFrames binary under `node_modules`) and the HyperFrames environment.
- `apps/worker/src/pipeline/probe.ts` (+ `.test.ts`): ffprobe arguments and parsing: `isHdr`,
  `isVariableFrameRate`, audio codec, sample rate, duration.
- `apps/worker/src/pipeline/convert.ts` (+ `.test.ts`): the convert step and its pure ffmpeg
  argument builder.
- `apps/worker/src/pipeline/transcript.ts` (+ `.test.ts`): the studio transcript type, the
  HyperFrames normaliser (ids `w0001`), `remapTranscript`.
- `apps/worker/src/pipeline/transcribe.ts` (+ `.test.ts`): the transcribe step and its arguments.
- `apps/worker/src/pipeline/envelope.ts` (+ `.test.ts`): ffmpeg arguments for a 10 ms RMS envelope
  in dB and the parser of its `ametadata` print file; `silentRuns(envelope, thresholdDb)`.
- `apps/worker/src/pipeline/retime-preset.ts`: `RETIME_PRESET`, every retime setting in one object.
- `apps/worker/src/pipeline/retime-plan.ts` (+ `.test.ts`): the pure planner and `remapTime`.
- `apps/worker/src/pipeline/retime-encode.ts` (+ `.test.ts`): the pure filter graph builder.
- `apps/worker/src/pipeline/retime.ts`: the retime step (probe, envelope, plan, encode, write).
- `apps/worker/src/pipeline/testdata/`: ffprobe JSON (`sdr-cfr.json`, `hdr-pq.json`,
  `hdr-hlg.json`, `vfr.json`, `sdr-60fps-cfr.json`), a synthetic transcript and envelope, and a copy
  (read, not written there) of the reference `transcript-1x.json` and `checks/envelope-1x.json`
  under `testdata/rethink-work/`.
- `apps/worker/src/pipeline/pipeline-fixtures.test.ts`: the committed `fixtures/pipeline/`
  manifest still matches the fingerprints the definition computes for the committed clip.
- `apps/worker/src/make-pipeline-fixtures.ts`: the `fixtures:pipeline` script that runs the real
  pipeline on the clip against a temporary folder fake and writes `fixtures/pipeline/`.
- `apps/worker/vitest.tools.config.ts`: the `test:tools` config (`src/**/*.tools.test.ts`, long
  timeouts, one file at a time).
- `apps/worker/src/pipeline/convert.tools.test.ts`, `transcribe.tools.test.ts`,
  `retime.tools.test.ts`: the real-tool tests.
- `fixtures/pipeline/manifest.json`, `fixtures/pipeline/convert/converted.mp4`,
  `fixtures/pipeline/transcribe/transcript.json`, `fixtures/pipeline/retime/{source.mp4,
transcript.json, retime.json, envelope.json}`: the three steps' outputs for the clip.
- `app_docs/pipeline.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Database statuses and `cache_hit`; the storage interface (ETag, streamed file download, put if
absent, shared `keyPrefix`); the step runner's multi-tool entry point, hit recording and
injectable spawner; canonical JSON and fingerprints; the HyperFrames dependency.

### Phase 2: Core Implementation

The three steps as pure argument builders plus thin step bodies: ffprobe parsing (HDR, VFR), the
convert arguments, the HyperFrames normaliser, the envelope parser, the retime planner and filter
graph. The pipeline definition and the runner with hits, resume, statuses and immutable outputs.

### Phase 3: Integration

`processJob` runs the pipeline; `finishJob` writes `processed`; the studio's status lists; the
doctor's tool checks; `test:tools`; the committed `fixtures/pipeline/` and their guard test; the
E2E upload spec seeding the cache; docs and the ADW profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md` and `app_docs/measurement.md` in full, including their Rules.
- Read the reference `retime.py`, `fix_words.py`, `brief.md` (Speed table, Short gaps, Ending) and
  `setup-notes.md` (Transcription rule). Never write anything in that repository.
- Note: the committed `retime.py` and `retime.json` are **Draft 02** (base 1.10, slow 1.15, 18 gap
  frames); `brief.md`'s Draft 01 table is base 1.05 / slow 1.1 (5 gap frames). The preset defaults
  are Draft 01's (the issue's 1.05 / 1.1).

### 2. Migration

- Create `supabase/migrations/20261102090000_pipeline_steps.sql`:
  - `alter table public.steps add column cache_hit boolean not null default false;`
  - `alter table public.steps drop constraint steps_status_check, add constraint steps_status_check
check (status in ('running', 'done', 'failed', 'skipped'));`
  - Drop and re-add `reels_status_check` (confirm the auto-generated name against the local
    database with `\d public.reels` through `psql` on port 54432, read-only) as a named constraint:
    `('uploading', 'uploaded', 'received', 'converting', 'transcribing', 'retiming', 'processed',
'failed')`. `received` stays allowed for existing rows (the review sample reel); nothing new
    writes it.
  - Comment the file the way the earlier migrations are commented.
- Run `supabase migration up --local`. If it fails, report the error and stop: never reset, start
  or stop the stack.
- Update `apps/studio/db-tests/steps-measurements.test.ts`: add `["cache_hit", "boolean"]` to the
  pinned column list (and the measurement doc in the same change, task 18).
- Add `apps/studio/db-tests/pipeline-statuses.test.ts` (pattern of `steps-measurements.test.ts`):
  the admin client can set a reel to each of `converting`, `transcribing`, `retiming`,
  `processed`; `bogus` fails with `23514`; a step inserted without `cache_hit` reads back `false`;
  a step with `status: "skipped", cache_hit: true` is accepted and the owner reads it under RLS.

### 3. Shared storage

- `packages/storage/src/storage.ts`: `head` returns `{ bytes: number; etag: string | null }`. Add:
  - `getFile(key, path, options?: { signal? }): Promise<boolean>`: streams the object to
    `<path>.part`, renames to `path` when complete; `false` when the object does not exist.
  - `putFileIfAbsent(key, path, options?: { contentType? }): Promise<"written" | "exists">`: never
    replaces an existing object.
  - Move `keyPrefix(env)` here from `apps/studio/src/lib/storage.ts` (same behaviour); export it
    from `index.ts` and import it in the studio.
- `r2.ts`: `head` returns `ETag` unquoted; `getFile` pipes `Body` (a Node `Readable`) into a write
  stream with `stream/promises` `pipeline`, then `rename`; `putFileIfAbsent` sends
  `PutObjectCommand` with `Body: createReadStream(path)`, `ContentLength` from `stat` and
  `IfNoneMatch: "*"`, and maps HTTP 412 (`PreconditionFailed`) to `"exists"`. A single PUT is
  atomic in R2; objects above 5 GiB are out of scope (note it in the doc).
- `fake.ts`: `head` returns the MD5 hex of the file as `etag` (what R2 returns for a single PUT, so
  fingerprints computed against the fake equal R2's for the same bytes); `put` writes a temp file
  in the same folder and renames it (no half-written file); `getFile` copies to `.part` then
  renames; `putFileIfAbsent` copies to a temp file and `link`s it to the final path (`EEXIST`
  means `"exists"`), then removes the temp file.
- Extend `fake.test.ts` and `r2.test.ts` (follow their existing patterns): ETag equals the MD5 of
  the bytes; `putFileIfAbsent` twice keeps the first content and answers `"exists"`; `getFile` on a
  missing key returns `false` and leaves no `.part`; R2 sends `If-None-Match: *` and maps 412.

### 4. HyperFrames dependency

- Read the current version (`yarn npm info hyperframes --fields version`, 0.8.225 when this plan
  was written; the issue saw 0.8.222, the old setup used 0.8.162) and add it exactly:
  `yarn workspace @edit-issebya/worker add hyperframes@<version> --exact`.
- Check whether its install runs a heavy postinstall (browser download) in CI; if it does, disable
  it for this package in the root `.yarnrc.yml` (`dependenciesMeta`) or `package.json`, and record
  that in the Notes of the doc. `yarn install --immutable` must still pass.
- `apps/worker/src/pipeline/tools.ts`: `toolPaths(env)` returns `ffmpeg` (`FFMPEG_PATH`, default
  `ffmpeg`), `ffprobe` (the sibling `ffprobe` of an absolute `FFMPEG_PATH`, else `ffprobe`) and the
  HyperFrames entry: `process.execPath` plus the package's `bin/hyperframes.mjs`, resolved from the
  worker with `import.meta.resolve` / `createRequire` (never `npx`, never `yarn dlx`).
  `hyperframesEnv(env)` returns the environment with `HYPERFRAMES_NO_TELEMETRY=1` forced.
  `HYPERFRAMES_VERSION` is read from the installed package's `package.json`.

### 5. Step runner

- `apps/worker/src/step-runner.ts`:
  - `runChild` also collects stdout (capped, separately from the mixed `output`), and the child
    spawn becomes an injectable `SpawnTool` (`(spec, signal, log) => Promise<ChildRun>`), default
    the real one.
  - `runToolsStep(ctx, { name, inputs?, outputs?, sizeOf?, work: (tool) => Promise<{ what: string
}> }, spawnTool?)`: one `withStep` row; `tool({ file, args, cwd?, env?, sampleGroupMemory? })`
    runs one child, returns its stdout, and adds to the step's measurements: CPU summed over calls
    (null when no call reported), peak RSS the maximum, `bytes_in` / `bytes_out` from the declared
    local paths measured after `work` (they exist then). A non-zero exit throws `StepFailure` with
    the accumulated measurements and that call's tail, as today. The summary is
    `stepSummary({ what, wallMs, sizeBytes })`.
  - `runStep(ctx, spec)` becomes `runToolsStep` with one call and `what: spec.describe`; its
    observable behaviour (rows, messages, tails, abort) must not change: `step-runner.test.ts` and
    `telemetry.test.ts` pass unchanged.
  - `recordHit(ctx, { name, summary })`: checks the signal, opens span `step <name>` with
    `step.cache_hit = true` and `step.wall_ms`, and calls `steps.skipped(...)`; nothing else.
  - Keep `runInProcessStep` (documented in-process entry point, used by `telemetry.test.ts`).
- `apps/worker/src/step-store.ts`: `skipped(job, name, summary, wallMs)` inserts one row with
  `status: "skipped"`, `cache_hit: true`, `summary`, `finished_at`, `wall_ms` and null
  `cpu_ms`, `peak_rss_bytes`, `bytes_in`, `bytes_out`; `reelStatus(reelId, status)` updates
  `reels.status`. Drop `sourceKey` only if nothing uses it (the runner still needs it: keep it).
- `apps/worker/src/recording-steps.ts`: record `{ call: "skipped", jobId, name, summary }` and
  `{ call: "reelStatus", reelId, status }`.
- Add tests to `step-runner.test.ts` (real children under `/usr/bin/time`, like the existing
  ones): two tool calls in one step sum CPU and keep the larger peak; the second call failing
  stores the accumulated measurements and its tail; `recordHit` writes one `skipped` call and a span
  with `step.cache_hit`.

### 6. Canonical JSON and fingerprints

- `canonical-json.ts`: objects with keys sorted by code point, arrays in order, no whitespace,
  numbers through `JSON.stringify`; throws on `undefined`, functions, symbols, `NaN`, `Infinity`
  and non-plain objects. `null` is allowed (the `maxPauseSeconds: null` setting).
- `fingerprint.ts`: `type FileRef = { source: { etag: string; bytes: number } } | { step: string;
fingerprint: string; file: string }`; `fingerprint({ inputs: FileRef[], settings, version })`
  returns the hex SHA-256 of the canonical JSON; `cacheKey(prefix, step, fp, file)` returns
  `${prefix}cache/${step}/${fp}/${file}` checked by `assertStorageKey`.
- Tests (verification 1): the same inputs, settings and version give the same fingerprint; key
  order does not matter; changing one input (an ETag, a byte count, a producer fingerprint, a file
  name), one nested setting, or the version changes it; `canonicalJson` refuses `undefined` and
  `NaN`.

### 7. Probe (HDR and VFR detection)

- `probe.ts`: `probeArgs(path)` (`-v error -print_format json -show_streams -show_format`);
  `parseProbe(json)` returns `{ video: { codec, width, height, rFrameRate, avgFrameRate,
colorTransfer, colorPrimaries, colorSpace }, audio: { codec, sampleRate } | null,
durationSeconds }`; `isHdr(probe)` is true for `color_transfer` `smpte2084` or `arib-std-b67`;
  `isVariableFrameRate(probe)` is true when `r_frame_rate` and `avg_frame_rate` differ by more than
  0.5% (rational parsing, `0/0` treated as unknown, so VFR).
- Fixture ffprobe JSON in `testdata/` (trimmed real output: make them with the local ffprobe on
  synthetic inputs and on an iPhone-style sample, keep only the fields used).
- Tests (verification 5): `hdr-pq.json` and `hdr-hlg.json` are HDR, `sdr-cfr.json` is not;
  `vfr.json` is VFR, `sdr-cfr.json` and `sdr-60fps-cfr.json` are not.

### 8. Convert

- `convert.ts`: `CONVERT_VERSION = 1`, `CONVERT_SETTINGS = { fps: 30, keyframeSeconds: 1, videoCodec:
"libx264", preset: "medium", crf: 18, pixelFormat: "yuv420p", copyAudioCodecs: ["aac"],
audioCodec: "aac", audioBitrate: "256k", faststart: true, hdrToSdr: { tonemap: "hable",
npl: 100 } }`.
- `convertArgs(probe, input, output, settings)` (pure): `-hide_banner -v error -y -i input`, video
  filter `fps=30` always, preceded for HDR by `zscale=t=linear:npl=100,format=gbrpf32le,
zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv` then
  `format=yuv420p`; `-fps_mode cfr -r 30`; `-c:v libx264 -preset medium -crf 18 -g 30
-keyint_min 30 -sc_threshold 0 -force_key_frames expr:gte(t,n_forced*1)`; for HDR also
  `-color_primaries bt709 -color_trc bt709 -colorspace bt709`; `-c:a copy` when the audio codec is
  AAC, else `-c:a aac -b:a 256k`; `-movflags +faststart`; the output a temporary name ending in
  `.mp4` that the step renames to `converted.mp4` after exit 0.
- The step: `tool(ffprobe)` on the source, `parseProbe`, `tool(ffmpeg, convertArgs(...))`,
  rename. Summary `what`: `footage converted`, plus `, HDR to SDR` and/or `, variable frame rate
fixed` when detected (for example `footage converted, 4 seconds, 61.0 MB`).
- Tests: arguments for SDR CFR (no `zscale`, `fps=30`, `-c:a copy`), HDR (the tone-map chain and
  bt709 tags), Opus audio (`-c:a aac`), output never the final name.

### 9. Transcript format and transcribe

- `transcript.ts`: `interface Transcript { words: Word[] }`, `interface Word { id: string; text:
string; start: number; end: number }` (seconds, three decimals). `normaliseHyperframes(raw)`:
  accepts the HyperFrames word array (`[{ text, start, end, id? }]`), trims text, drops empty
  words, rounds to milliseconds, keeps `end >= start` and order (a word never starts before the
  previous one starts), and assigns ids `w0001`, `w0002`, ... by position. `remapTranscript(t,
map)` returns new times with the same ids and texts.
- `transcribe.ts`: `TRANSCRIBE_VERSION = 1`, `TRANSCRIBE_SETTINGS = { engine: "whisper", model:
"small", language: "en", hyperframes: HYPERFRAMES_VERSION }`. Arguments:
  `transcribe <converted.mp4> --engine whisper --model small --language en --json --dir <step
folder>`; env from `hyperframesEnv`. The CLI writes `<dir>/transcript.json`; the step reads it,
  normalises, writes `transcript.json.part`, renames. Summary `what`: `transcribed, <n> words`
  (for example `transcribed, 132 words, 38 seconds`).
- Tests: normaliser on the reference `transcript-1x-whisper.json` shape (ids `w0001`..., count
  kept, ordering), an empty or malformed result fails with a clear message; the settings'
  `hyperframes` equals the exact version pinned in `apps/worker/package.json`; the arguments always
  carry `--model small --language en --engine whisper`.

### 10. Envelope

- `envelope.ts`: `envelopeArgs(input, printFile)`: `-v error -i input -vn -af aresample=48000,
asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=<printFile>
-f null -` (10 ms frames, as the reference envelope). `parseEnvelope(text)` returns dB values,
  `-inf` as -180. `silentRuns(db, thresholdDb, frameSeconds)` returns `[start, end]` runs below the
  threshold.
- Tests: a small print file sample parses (including `-inf`); runs are found at the right times.

### 11. Retime planner and encode

- `retime-preset.ts`: `RETIME_VERSION = 1` and `RETIME_PRESET = { baseSpeed: 1.05, slowSpeed: 1.1,
slowWordsPerSecond: 2.7, drawnOutWordSeconds: 0.6, longPauseSeconds: 0.3, phraseGapSeconds: 0.1,
minSlowStretchSeconds: 0.8, silenceDb: -40, envelopeFrameSeconds: 0.01, minGapAfterSeconds:
0.065, gapRate: 0.6, maxPauseSeconds: null, frameRate: 30, endFadeSeconds: 0.03, videoCodec:
"libx264", preset: "medium", crf: 18, audioBitrate: "256k" }`. Every value is part of the
  fingerprint. Document each one in the pipeline doc.
- `retime-plan.ts`, `planRetime({ words, envelope, durationSeconds, settings })` (pure):
  1. Silent runs from the envelope (below `silenceDb`).
  2. Phrases: words split at silent runs at least `phraseGapSeconds` long (a word belongs to the
     phrase holding its midpoint).
  3. A phrase is slow when its words per second (over its speech span) is below
     `slowWordsPerSecond`, or it holds a word longer than `drawnOutWordSeconds`, or a silent run of
     `longPauseSeconds` or more follows it. Adjacent slow phrases merge into a stretch; a stretch
     shorter than `minSlowStretchSeconds` stays at base speed.
  4. Each speed boundary sits on a frame point (k / `frameRate`) strictly inside the silent run
     between the phrases (the frame point nearest the run's middle); a run with no frame point
     inside never carries a boundary (the phrases join). Never on a word join.
  5. Short gaps: for each silent run between two words whose length divided by the speed of its
     segment is under `minGapAfterSeconds`, and which holds a whole frame, that silent middle frame
     becomes its own segment at `gapRate` (the reference's fix, applied by rule instead of a hand
     list).
  6. Pause cutting: when `maxPauseSeconds` is a number, a silent run longer than it is shortened to
     it by removing its middle; both cut points are frame points inside the run. `null` cuts
     nothing.
  7. The end is the duration rounded to a frame; the last segment carries the end fade.
     Output: `{ segments: [{ orig: [a, b], speed, new: [c, d] }], durationSeconds }`, new times from
     exact lengths `(b - a) / speed` (the encode trims every audio piece to its video length, so no
     measuring pass is needed); `remapTime(plan, t)` maps an original time (a time inside a cut maps
     to the cut point).
- `retime-encode.ts`, `retimeFilterGraph(plan, sampleRate, settings)` (pure): per segment
  `[0:v]trim=start=a:end=b,setpts=(PTS-STARTPTS)/speed` and `[0:a]atrim=start=a:end=b,
asetpts=PTS-STARTPTS,<atempo=speed | asetrate=SR*speed,aresample=SR>,apad,atrim=duration=<(b-a)/speed>`,
  the end fade on the last piece, `concat=n=<N>:v=1:a=1`, then `fps=30`; encode arguments as in
  `retime.py` (`-c:v libx264 -preset medium -crf 18 -g 30 -keyint_min 30 -sc_threshold 0
-pix_fmt yuv420p -c:a aac -b:a 256k -movflags +faststart`). The graph goes to a file passed with
  `-/filter_complex <file>` (long graphs exceed argument limits; ffmpeg 7+ syntax, the local build
  is 8.0.1).
- `retime.ts`, the step: `tool(ffprobe)` on `converted.mp4` (duration, sample rate),
  `tool(ffmpeg, envelopeArgs)`, `planRetime`, `tool(ffmpeg, encode)` to a temporary name, then
  write `source.mp4`, `transcript.json` (remapped, same ids), `retime.json` (the plan) and
  `envelope.json`, each through temp name and rename. Summary `what`: `retimed to <new duration,
one decimal> seconds, <base speed>x` (for example `retimed to 49.3 seconds, 1.05x`).
- Tests (verification 4), on the synthetic fixture and on `testdata/rethink-work/`:
  every boundary lies inside a silent run; every speed boundary between base and slow segments lies
  in a run at least `minGapAfterSeconds` long and never between two words with a shorter gap; the
  segments tile `[0, end]` without overlap (or with only cut ranges between them); mapped word times
  are monotonic and every id is kept; with `maxPauseSeconds: null` no time is removed and the new
  duration equals the sum of `(b - a) / speed`; with `maxPauseSeconds: 0.4` a 1.2 s pause comes out
  0.4 s and its cut points lie inside the pause; the filter graph has one `trim` and one `atrim`
  per segment and uses `asetrate` only for speeds under 1.

### 12. Pipeline definition and runner

- `definition.ts`: `PIPELINE = [convert, transcribe, retime]`; each `PipelineStep` has `name`,
  `version`, `settings`, `reelStatus` (`converting`, `transcribing`, `retiming`), `outputs`,
  `inputs(source, fingerprints)` returning `FileRef[]` and a map from each ref to the local name the
  step reads, `reusedWhat` (`footage converted`, `transcribed`, `retimed`) and `run({ tool, dir,
files, signal })`. convert reads the source; transcribe reads `convert/converted.mp4`; retime
  reads `convert/converted.mp4` and `transcribe/transcript.json`. A step may read only what its
  `inputs` declare (the runner hands it only those local paths).
- `fingerprintsFor(source)` computes all three fingerprints from the definition alone (used by
  the runner, the fixtures script and the guard test).
- `definition.test.ts`: for each step, mutating any single leaf of its `settings` (walk the
  object), or its `version`, changes its fingerprint and the fingerprints of every later step,
  and leaves earlier ones unchanged; the declared outputs have distinct names.
- `run-pipeline.ts`, `runPipeline({ ctx, storage, keyPrefix, scratchDir, tools, spawnTool? })`:
  1. Reads the source key (`steps.sourceKey`), HEADs it (missing source fails the job with
     `source object missing`); the source ref is `{ etag, bytes }` (an ETag-less object fails:
     never fingerprint without it).
  2. For each step in order: compute its fingerprint; HEAD every output key. All present: set the
     reel status, `recordHit` with summary `<reusedWhat>, reused`, keep the step's output keys for
     later downloads, continue.
  3. Otherwise: set the reel status, then one `runToolsStep` row whose `work` downloads each
     declared input not already local (`getFile` from the source key or from the producer's cache
     key; a missing cached input fails the step), runs the step in
     `<scratchDir>/job-<job id>/<step>/`, and uploads every output with `putFileIfAbsent`
     (an `"exists"` answer is fine: the stored one stays).
  4. The job folder is removed in `finally`. A lost lease (aborted signal) writes nothing more.
- `processJob` runs `runPipeline` in place of `receive`; delete `steps/receive.ts` and its test.
  `finishJob` sets the reel to `processed`; `failJob` keeps `failed`.
- `config.ts`: `keyPrefix` from the shared `keyPrefix(env)` (a malformed value throws, naming
  `R2_KEY_PREFIX`); add a config test case.
- `run-pipeline.test.ts` (pure, verification 2 and 3), with `fakeStorage` on a temporary folder,
  `recordingSteps` and a fake `spawnTool` that records every call and writes the declared output
  files (it reads the output path from the arguments; ffprobe calls return fixture JSON on stdout;
  the HyperFrames call writes a small `transcript.json` into `--dir`; the envelope call writes a
  print file):
  - First run: three `done` steps, the reel statuses `converting`, `transcribing`, `retiming` in
    order, every output stored under its cache key.
  - Second run of the same job: three `skipped` calls (cache hit), zero spawns, zero downloads, zero
    puts.
  - Delete retime's `retime.json`: convert and transcribe are hits, only retime runs, and the
    other two retime outputs are not rewritten (their bytes and mtime unchanged).
  - Delete convert's `converted.mp4`: convert runs; transcribe and retime are hits (their
    fingerprints are unchanged; see Notes).
  - Bump transcribe's version (a definition override in the test): convert is a hit, transcribe and
    retime run.
  - Resume: a fake transcribe that fails the first time: the first run records convert `done`,
    transcribe `failed` and throws; the retry records convert `skipped` (hit) and transcribe and
    retime `done`.
  - The scratch job folder is gone after success and after failure.

### 13. Studio status lists

- `apps/studio/src/lib/reels.ts`: `REEL_STATUSES` adds `converting`, `transcribing`, `retiming`,
  `processed`. `apps/studio/src/lib/jobs.ts`: `STEP_STATUSES` adds `skipped`.
  `apps/studio/test-support/fixtures.ts`: widen `insertReel`'s status type. Fix any studio unit test
  that pins those lists. No markup change in `LiveReel.tsx`: a step line still reads
  `name: summary`.

### 14. Doctor

- `doctor-checks.ts`: one line for the ffmpeg filters this pipeline needs (`zscale`, `tonemap`,
  `atempo`, `astats`, `ametadata` in `ffmpeg -hide_banner -filters`), one for `hyperframes
--version` (with `HYPERFRAMES_NO_TELEMETRY=1`). Extend `doctor-checks.test.ts` with the fake deps
  pattern it already uses.

### 15. Tool tests (`test:tools`)

- `apps/worker/vitest.tools.config.ts`: include `src/**/*.tools.test.ts`, `testTimeout` 10
  minutes (the first whisper run may download the `small` model), `fileParallelism: false`.
- `apps/worker/vitest.config.ts`: exclude `src/**/*.tools.test.ts` (keep the default excludes).
- `apps/worker/package.json`: `"test:tools": "vitest run --config vitest.tools.config.ts"`.
- `knip.json`: worker `"vitest": { "config": ["vitest.config.ts", "vitest.tools.config.ts"] }`.
- `convert.tools.test.ts` (verification 6 and 7): convert the committed clip: codec `h264`,
  `r_frame_rate` and `avg_frame_rate` both `30/1`, keyframe times (`ffprobe -skip_frame nokey
-show_entries frame=pts_time`) 1 s apart. A synthetic HDR input made in the test (`testsrc2`,
  10-bit, tagged `-color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc`) is
  detected as HDR and comes out with `color_transfer` `bt709`. A synthetic VFR input (two parts at
  24 and 60 fps concatenated with `-fps_mode vfr`) is detected as VFR and comes out `30/1` for both
  rates.
- `transcribe.tools.test.ts` (verification 8): transcribe the committed clip; the joined word
  texts, lower-cased and stripped of punctuation, contain `this is a short test clip for the reel
studio`; ids are `w0001`... in order.
- `retime.tools.test.ts`: the whole pipeline on the clip against a temporary folder fake: the
  retimed `source.mp4` is H.264 `30/1`, its duration matches `retime.json`'s within one frame, and
  the retimed transcript keeps every id.
- Real tools resolve through `toolPaths(process.env)` (`FFMPEG_PATH` when set, else `ffmpeg` on
  `PATH`); the files they make go to a temporary folder, never the repository.

### 16. Committed pipeline fixtures

- `apps/worker/src/make-pipeline-fixtures.ts` and `"fixtures:pipeline": "node
--env-file-if-exists=.env.development src/make-pipeline-fixtures.ts"`: runs `runPipeline` with the
  real tools on `fixtures/footage/short-speech.mp4` against a temporary folder fake (key prefix
  empty, a recording step store, no database), then writes `fixtures/pipeline/<step>/<file>` for
  every output and `fixtures/pipeline/manifest.json` (`{ source: { etag, bytes }, steps: [{ name,
fingerprint, files }] }`). Run it once on the Mac and commit the result (small: a few seconds of
  720x1280 footage).
- Add `fixtures/pipeline/` to `.prettierignore` (generated output, compared byte for byte).
- `pipeline-fixtures.test.ts` (pure, in CI): the MD5 and size of the committed clip equal the
  manifest's source; `fingerprintsFor` gives the manifest's three fingerprints; every listed file
  exists. A version or setting change therefore fails CI until `fixtures:pipeline` is re-run.

### 17. E2E: every step reused, page updates live

- Extend `apps/studio/e2e/upload.spec.ts` (it already uploads the clip and spawns `once`):
  - Before spawning the worker, read `fixtures/pipeline/manifest.json` and put every file into the
    folder fake at `<prefix>cache/<step>/<fingerprint>/<file>` with a per-run prefix
    `e2e-<uuid>/`; pass `R2_KEY_PREFIX` to `runWorkerOnce` in its `env`. Delete those keys in
    `afterAll` together with the source.
  - After `once` exits 0: `job-status` `done`; three `step-line`s, in order,
    `convert: footage converted, reused`, `transcribe: transcribed, reused`,
    `retime: retimed, reused`; `reel-status` `processed`; the no-reload marker still set; the
    `steps` rows are `[convert, transcribe, retime]`, each `status: "skipped"`, `cache_hit: true`,
    `wall_ms` a number and `cpu_ms`, `peak_rss_bytes`, `bytes_in`, `bytes_out` null; still no
    PostHog request and `studio_footage_uploaded` sent once.
  - No ffmpeg or HyperFrames is needed (every step is a hit), so it runs in CI. Pure test 2 is the
    proof that a missing output is not skipped.
- This fails without the feature (the worker writes `receive` and `received`).

### 18. Documentation and profile

- Create `app_docs/pipeline.md` (layout of the other feature docs: Specifications, Overview, How
  it works, How to Use, Configuration, Testing, Rules, Notes): the step list and order, the
  fingerprint (inputs, settings, version; canonical JSON; source by ETag and size, outputs by
  producer fingerprint), the cache layout `${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`,
  hits (`skipped`, `cache_hit`, summary `..., reused`) and resume, the conversion fixes (HDR to SDR,
  VFR to 30 fps), the transcription settings (always `--model small --language en`, why not `.en`
  or `base`), the retime rules and every `RETIME_PRESET` setting, pause cutting off by default, the
  transcript format with stable word ids, the reel statuses, `test:tools`, `fixtures:pipeline` and
  the manual comparison. Rules section: no AI in the fixed steps; every step declares everything it
  reads and reads nothing else; never overwrite a stored output; word ids never change after
  transcribe; bump a step's version whenever its behaviour changes, then re-run
  `fixtures:pipeline`; never run HyperFrames through `npx` or `yarn dlx`, always with
  `HYPERFRAMES_NO_TELEMETRY=1`; never write to the reference repository.
- `docs/conditional-docs.md`: one line, for example "Read `app_docs/pipeline.md` when changing the
  pipeline steps (convert, transcribe, retime), fingerprints and the R2 cache, the retime planner or
  preset, the transcript format, HyperFrames or ffmpeg arguments, `test:tools` or
  `fixtures/pipeline/`."
- `app_docs/studio.md`: Reels (new statuses), Jobs (`skipped`, `cache_hit`), Worker (`receive`
  replaced by the pipeline, `processed`), Storage (`getFile`, `putFileIfAbsent`, ETag, shared
  `keyPrefix`), Testing (upload spec seeds the cache). Its Rules stay as they are.
- `app_docs/measurement.md`: `runToolsStep`, `recordHit`, `cache_hit` in the column set, the
  removal of `steps/receive.test.ts`, the Notes line about `receive`.
- `.adw/project.md`, Tests: after the unit line, "for a run targeting the worker, the tool tests
  `yarn workspace @edit-issebya/worker test:tools` (real ffmpeg and HyperFrames on the committed
  clip; on the owner's Mac only, never in CI)"; mention that `upload.spec.ts` seeds
  `fixtures/pipeline/`. Do not rename or reorder any heading.
- `README.md`: in "Run the worker locally", `test:tools` and `fixtures:pipeline` one line each.
- No em-dashes anywhere.

### 19. Validation

- Run every command in `Validation Commands`, plus `test:tools` on the Mac. Record the manual
  comparison for the owner as a PR note (task in Notes), not as an automated check.

## Testing Strategy

### Unit Tests

- `packages/storage`: ETag, `getFile`, `putFileIfAbsent` (fake and R2), atomic fake writes,
  `keyPrefix` moved with its tests.
- `apps/worker`: `canonical-json`, `fingerprint`, `definition` (every setting leaf and version),
  `probe` (HDR, VFR), `convert` arguments, `transcript` normaliser and remap, `transcribe`
  arguments and the version pin, `envelope` parsing and silent runs, `retime-plan` (synthetic and
  reference fixtures), `retime-encode`, `run-pipeline` (hits, partial deletes, version bump,
  resume, statuses, clean-up), `pipeline-fixtures` (the committed manifest), `step-runner` (multi
  tool step, hit), `config` (`R2_KEY_PREFIX`), `doctor-checks`.
- DB: `steps-measurements.test.ts` (column set), `pipeline-statuses.test.ts`.

### Test Coverage

- Unit (`yarn test`), `fingerprint.test.ts` and `definition.test.ts`: catch an input, setting or
  version that is not part of the fingerprint, so a stale output can never be reused.
- Unit, `run-pipeline.test.ts`: catches a second run that spawns a process, a missing output that
  is skipped, a resumed job that redoes `convert`, an output that is overwritten, and wrong reel
  statuses.
- Unit, `retime-plan.test.ts`: catches a speed boundary on a word join or outside silence, lost or
  reordered word ids, non-monotonic times, and pause cutting that runs when it is off.
- Unit, `probe.test.ts`: catches HDR or VFR footage that would pass through unfixed.
- Unit, `pipeline-fixtures.test.ts`: catches a version or settings change that leaves the committed
  E2E fixtures stale.
- Unit, `step-runner.test.ts` additions: catch wrong summed CPU or peak across several tools in
  one step, and a hit row that is not `skipped` with `cache_hit`.
- Unit, storage tests: catch an overwrite through `putFileIfAbsent` and a half-written download.
- DB (`yarn turbo run test:db --filter=./apps/studio`), `pipeline-statuses.test.ts` and the pinned
  columns: catch a migration that rejects the new statuses or misses `cache_hit`.
- E2E (`yarn test:e2e`), `apps/studio/e2e/upload.spec.ts`: catches the worker not running the
  three steps, not recognising stored outputs, or the reel page not showing `processed` and the
  reused step lines live.
- Tools (`yarn workspace @edit-issebya/worker test:tools`, Mac only, not a CI layer): catch wrong
  real ffmpeg or HyperFrames arguments (codec, 30/1, keyframes, bt709, the spoken sentence).

### Edge Cases

- Source without audio (convert has no `-c:a`; transcribe fails clearly; the retime planner never
  runs on an empty transcript: fail with a message).
- Non-AAC audio (Opus in WebM): encoded to AAC.
- `avg_frame_rate` `0/0` or missing: treated as VFR; 60 fps CFR: no VFR flag, still 30 fps out.
- HLG and PQ both tone-mapped; SDR untouched apart from `fps=30`.
- Rotated phone footage (display matrix): ffmpeg's default autorotate applies; the tools test can
  add a rotated synthetic case if cheap.
- An empty transcript, a word with `end < start`, whisper words out of order.
- A transcript with no silent run long enough for a boundary: the whole clip plays at base speed.
- Slow stretch at the very start or end of the clip (no gap before or after).
- Short gap with no whole frame inside: left alone.
- `maxPauseSeconds` set: a word time inside a cut maps to the cut point; monotonic still.
- Some but not all outputs of a step present: the step runs; only missing outputs are uploaded.
- An ETag-less HEAD answer: the job fails rather than fingerprinting without it.
- Lease lost mid-step: nothing more written, scratch cleaned.
- A cached input missing when a later step needs to download it: the step fails with the key.

## Acceptance Criteria

- A `process` job runs `convert`, `transcribe`, `retime` in that order through the measuring step
  runner; the reel goes `converting`, `transcribing`, `retiming`, then `processed` (or `failed`).
- Each step's fingerprint is SHA-256 over the canonical JSON of its declared inputs, settings and
  code version; outputs live at `${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`.
- A step whose outputs all exist is recorded `skipped` with `cache_hit = true`, its summary ends in
  `reused`, and no process is spawned; a failed job's retry resumes at the failed step; no stored
  output is ever overwritten.
- Convert outputs H.264, `r_frame_rate` and `avg_frame_rate` 30/1, a keyframe every second, AAC
  copied (or encoded), `+faststart`; HDR comes out bt709; VFR comes out 30/1.
- Transcribe runs the pinned HyperFrames binary from `node_modules` with `--engine whisper --model
small --language en --json` and `HYPERFRAMES_NO_TELEMETRY=1`; words carry ids `w0001`... that
  retime never changes.
- Retime defaults: 1.05x base, 1.1x slow, -40 dB silence, 65 ms minimum gap, 30 ms end fade, no
  pause cutting; every boundary inside a silent gap; outputs `source.mp4`, `transcript.json`,
  `retime.json`.
- `steps.cache_hit` exists; `skipped` and the new reel statuses are accepted by the database.
- `yarn test` stays pure (no ffmpeg, HyperFrames, database or network); `test:tools` passes on the
  Mac; the upload spec passes with every step reused.
- `app_docs/pipeline.md` exists with a Rules section; `docs/conditional-docs.md`, `studio.md`,
  `measurement.md`, `README.md` and `.adw/project.md` are updated; no em-dashes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the only
  database command allowed; on failure report and stop, never reset).
- `yarn install --immutable`: the lockfile matches the new `hyperframes` pin.
- `yarn format:check`: whole-repository formatting (the generated fixtures are ignored).
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio --filter=./packages/storage`:
  lint in the three touched workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio --filter=./packages/storage`:
  types, including the widened `Storage` interface the studio implements through the package.
- `yarn knip`: no unused export, file or dependency (the tools config and the new scripts are
  entries).
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio --filter=./packages/storage`:
  the pure unit tests (fingerprints, skip, resume, planner, detection, fixtures guard).
- `yarn turbo run test:db --filter=./apps/studio`: the column set and the new statuses against the
  local stack.
- `yarn turbo run build --filter=./apps/studio`: the studio still builds (the worker and storage
  build checks are their typecheck above).
- `yarn workspace @edit-issebya/worker test:tools`: real ffmpeg and HyperFrames on the committed
  clip (owner's Mac, ADW test phase for worker runs; never CI).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites, including the
  extended upload spec (every step a hit, `processed`, live step lines).

## Notes

- New dependency: `hyperframes` (exact version, 0.8.225 at planning time) in `apps/worker`, added
  with `yarn workspace @edit-issebya/worker add hyperframes@<version> --exact`; its binary runs from
  `node_modules` through `process.execPath`, never `npx` or `yarn dlx`. No other new library: the
  R2 conditional PUT uses the existing `@aws-sdk/client-s3` (`IfNoneMatch` is in its
  `PutObjectCommand` types).
- Verified on the owner's Mac: ffmpeg 8.0.1 at `/usr/local/bin` has `zscale`, `tonemap`, `atempo`,
  `astats` and `ametadata`; whisper models `base` and `small` are already cached under
  `~/.cache/hyperframes/whisper/models`. The doctor check covers the worker machine's build from
  now on.
- **Verification 2, deleted outputs.** Inputs are identified by their producer's fingerprint, so
  deleting an earlier step's output re-runs that step and leaves later steps as hits when their own
  outputs are still stored (their fingerprints are unchanged). Re-running them anyway would require
  overwriting their stored outputs under the same fingerprint, which the never-overwrite rule
  forbids. Later steps re-run whenever an earlier step's version or settings change (tested). The
  test therefore deletes retime's output to show "only that step runs", and convert's output to
  pin this behaviour. A whisper re-run can produce slightly different words than the transcript the
  stored retime was made from; that only happens after a manual deletion, and retime's own
  `transcript.json` stays consistent with its `source.mp4`.
- **Source fingerprint by ETag.** The source is identified by its R2 ETag (the MD5 of the bytes
  for a single PUT, which is how the studio uploads) and size, so deciding a hit needs no download.
  The folder fake returns the same MD5, so the committed fixture fingerprints hold for R2 too. A
  future multipart upload changes the ETag form, not its stability.
- **Tool versions.** The HyperFrames version is a setting of transcribe (it changes the words).
  The ffmpeg build is not in any fingerprint (reading it would need ffmpeg in CI for the E2E hit);
  after an ffmpeg upgrade that changes output, bump the affected step versions by hand.
- **Deviations from `retime.py`, for the manual comparison.** The planner picks slow stretches and
  short-gap frames by rule instead of by hand; audio pieces are trimmed to their video length
  instead of measured with an extra ffmpeg pass; the gap-frame rule may slow more gaps than the
  five of Draft 01. The committed `retime.json` / `source.mp4` are Draft 02 (1.10 / 1.15): to
  compare against them, run with `baseSpeed 1.10, slowSpeed 1.15`, or compare the defaults with
  `brief.md`'s Draft 01 table (49.30 s). `fix_words.py` is out of scope.
- **Manual acceptance (owner).** Run the original phone file `brief.md` names
  (`2CBC1BBE-4340-45D9-8967-DF3EED398D0D.MP4`) through the worker and compare with
  `rethink-work/source-1x.mp4` (format, fps, keyframes, duration), `transcript-1x.json` (words) and
  `source.mp4` / `retime.json` (segments and speeds; durations within a frame or two with pause
  cutting off). Record the differences in the PR or a follow-up issue; tune `RETIME_PRESET` and
  `maxPauseSeconds` after it.
- Large outputs: single PUT only, so an output above 5 GiB fails; acceptable for reels, noted in
  the doc. Multipart is a later slice with storage records (slice 14).
- Browser surface: the only UI effect is the existing step lines and status on the reel page,
  covered by the extended upload spec. No visual review change and no new screen; no `e2e/*.md`
  journey (a code spec covers it).
- Out of scope: background removal, head tracking, preview copies (slice 7), refusing bad footage
  and automatic retry (slice 16), storage records and cleanup (slice 14), `fix_words.py`.
