# Feature: progress and time left for long steps, browser notification, worker heartbeat and keep-awake

## Metadata

issue_number: `38`
adw_id: `119c12a9`
issue_json: `{"number":38,"title":"feat: progress and time left for long steps, browser notification, worker heartbeat and keep-awake", ...}` (reel studio MVP, slice 15 of 17)

## Feature Description

The two long steps of the reel pipeline, `remove_background` (about seven minutes for a 50-second
reel) and `render` (about three minutes), currently show only `running` in the step log until they
finish, which looks like a stopped studio. This slice makes the studio usable while the owner does
something else:

- **Progress (D4).** The worker reads each long step's progress from the tool's own output and
  writes `steps.progress_percent` at most once every ten seconds per step, plus 100 at the end. The
  reel page shows the percentage live (Realtime, no reload).
- **Time left (D4).** Next to the percentage the studio shows the time left, estimated from the
  owner's earlier `done` rows of the same step: the median of `wall_ms / footage_seconds` over the
  last ten, times this reel's `footage_seconds`, minus the elapsed time. With fewer than three
  earlier rows it says `no estimate yet`.
- **Notification (D7).** When the open reel reaches `processed` or a new export is recorded while
  the tab is hidden, the browser shows a system notification (only after the owner turned it on
  with a "Notify me" button, which asks for permission from that click) and the tab title becomes
  `Ready: <reel>`; the title is restored when the tab becomes visible. Nothing works with the tab
  closed.
- **Heartbeat (block E).** The long-running worker upserts `worker_status.heartbeat_at` at start and
  every five minutes. The studio reads it once and through Realtime and, with a local timer (never a
  database poll), shows `Worker offline since HH:MM` under queued jobs once the newest heartbeat is
  older than eleven minutes.
- **Keep awake (block E).** While a job runs, the worker spawns `/usr/bin/caffeinate -i -w <worker
pid>` on macOS (nothing elsewhere) and kills it when the job ends, whatever the outcome.

## User Story

As the owner
I want to see a percentage and the time left for the long steps, get told when my reel is ready while the studio tab is in the background, and see since when the worker is offline
So that I can do something else while my footage is processed instead of watching a status that looks stuck

## Problem Statement

The step log writes one row per step at start and one at the end. A step that takes minutes
therefore shows no movement at all, the owner has to keep the tab in front to learn the reel is
ready, and when the worker's Mac is asleep or off a queued job just sits there with no explanation.
The Mac may also go to sleep in the middle of a seven-minute background removal.

## Solution Statement

- **Database** (one new migration): `steps.progress_percent smallint` (0 to 100) and
  `steps.progress_updated_at timestamptz`; `reels.footage_seconds numeric` (positive);
  `worker_status.heartbeat_at timestamptz`. Existing RLS and the Realtime publication of all three
  tables already cover the new columns.
- **Worker progress**: a `progress` line parser on `ToolCall` (optional), a pure throttle
  (`apps/worker/src/progress.ts`) created per step inside `runToolsStep`, and a `progress(stepId,
percent)` write on `StepStore`. The throttle writes the first parsed value at once, then at most
  one value per 10 s window (never a lower value than the last written), and `finish()` writes 100
  right before the step's `done` write. Writes are serialised on one promise chain; a failed progress
  write is logged and never fails the step; nothing is written after the abort signal or after a
  failure.
- **Parsers** (`apps/worker/src/progress-parsers.ts`):
  - `render`: HyperFrames 0.8.222's `hyperframes render`, with stdout not a TTY, prints one
    `@hf-progress {"...","pct":N}` line per progress report (`renderMachineProgress` in
    `node_modules/hyperframes/dist/render-UPRWOGLS.js`); the parser reads `pct` from those lines
    only. `HYPERFRAMES_STDOUT_IS_TTY` must not be `1` in the render env (it suppresses the lines).
  - `remove_background`: the pinned CLI prints **no** progress when unattended: with `--json` the
    spinner is off, and without it the unattended `lineSpinner` drops every `message()` (see
    `node_modules/hyperframes/dist/remove-background-PCL6I5SZ.js` and `chunk-26AQTUU4.js`). The
    per-frame events exist only through `onProgress` of the package's public `hyperframes/api`
    export (`removeBackground`, typed `ProgressEvent` with `kind: "frame", index, total`). So the
    step runs a small worker-owned entry, `apps/worker/src/pipeline/remove-background-entry.ts`,
    with the same Node (`process.execPath`), which calls `removeBackground` with exactly the
    options the CLI passes (input, output, device, quality), prints one
    `@hf-progress {"index":i,"total":t,"pct":p}` line per `frame` event (p =
    `Math.floor(100 * index / total)`, as the CLI's own spinner computes it) and, at the end, the same
    JSON result document the CLI prints under `--json` (`ok`, `outputPath`, `framesProcessed`,
    `durationSeconds`, `avgMsPerFrame`, `provider`, `format`), or `{"ok":false,...}` and exit 1 on
    failure. `parseRemoveBackgroundResult` stays unchanged. Both parsers then read the same
    `@hf-progress` line shape.
  - Captured samples of both tools' real output are committed under
    `apps/worker/src/progress-testdata/` and drive the parser tests.
- **Footage seconds**: background removal and the render both work on the retimed footage, so
  `reels.footage_seconds` is the retimed length (`retime.json`'s `durationSeconds`), set after the
  `retime` step (ran or hit) only while the reel has none, with an
  `update ... where footage_seconds is null`. On a hit the small kept `retime.json` is downloaded
  only when the reel has no value yet, so the E2E specs (all hits) also get it.
- **Studio time left**: a pure `timeLeftSeconds()` in `apps/studio/src/lib/progress.ts`. The page
  reads the owner's earlier `done` rows of `remove_background` and of `render` once on the server
  (`wall_ms, reels!inner(footage_seconds)`, `status = done`, footage known, newest 10 per step
  name), passes the per-second rates down, and the step line shows `NN%` and `about N min left` or
  `no estimate yet`.
- **Studio notification**: a "Notify me" button (`NotifyToggle`) that calls
  `Notification.requestPermission()` only from its click and remembers the choice in
  `localStorage`; a pure `readyEvent(previous, next)` decides when a reel became ready (status moved
  into `processed`, or the newest export id changed to a new id, never on the first render); a
  `useReadyNotice` hook, when `document.visibilityState === "hidden"`, sets `document.title` to
  `Ready: <reel>` and, if the toggle is on and permission is `granted`, constructs one
  `Notification`; on `visibilitychange` to visible it restores the saved title.
- **Studio offline banner**: the page reads every `worker_status` row (named columns now including
  `heartbeat_at`) instead of only the waiting ones; a pure `offlineSince(rows, now)` takes the
  newest non-null `heartbeat_at` and returns it when it is older than 11 minutes; a single
  `setTimeout` scheduled for `newest + 11 min` re-renders at the moment the worker turns offline,
  and every Realtime update of `worker_status` recomputes it. Shown as `Worker offline since HH:MM`
  under each queued job.
- **Heartbeat**: `startHeartbeat({ beat, everyMs })` beats at once and every 5 minutes; `main.ts`
  starts it with `status.heartbeat({ freeDiskBytes })` (the upsert also carries `free_disk_bytes`,
  which the insert needs, and leaves `waiting_reason` alone) and stops it on SIGINT or SIGTERM.
  `once` never beats: it is a spec tool that exits at once, and a heartbeat from it would claim a
  live worker for eleven minutes that is not there.
- **Keep awake**: `withKeepAwake(work, { platform, pid, spawn })` in
  `apps/worker/src/keep-awake.ts`, wrapped around the job inside `processJob`.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules (no em-dashes, migrations through
  `supabase migration new`, run `.adw/supabase-stack reset` after adding a migration, never
  `supabase migration up` by hand in a run, specs only spawn `once`).
- `docs/conditional-docs.md`: add the `app_docs/status.md` line.
- `app_docs/studio.md`: reel page, Realtime, "Never poll from the studio", worker; its Rules bind
  this change.
- `app_docs/measurement.md`: the step runner and the `steps` column set; its Notes list progress and
  time left as out of scope, to be updated.
- `app_docs/pipeline.md`: pipeline steps, `remove_background`'s HyperFrames call, the version-bump
  rule.
- `app_docs/export.md`: the render call and the render double (`E2E_MOCK_RENDER`); Notes list render
  progress as out of scope.
- `app_docs/storage.md`: `worker_status`, the disk guard and its Notes promising the heartbeat to
  slice 15.
- `supabase/migrations/20261101233625_storage_records.sql`: `worker_status` definition, RLS,
  publication (read only; never edit an applied migration).
- `supabase/migrations/20261031174750_job_queue.sql`: `steps` table and its publication.
- `apps/worker/src/step-runner.ts`: `ToolCall`, `spawnChild`, `runToolsStep`, `withStep`; where the
  parser and throttle hook in.
- `apps/worker/src/step-runner.test.ts`: fake `SpawnTool` pattern for the runner tests.
- `apps/worker/src/step-store.ts`: `StepStore` and `supabaseStepStore`; add `progress`,
  `footageSeconds`, `recordFootageSeconds`.
- `apps/worker/src/recording-steps.ts`: in-memory `StepStore` used by tests; implement the new
  methods.
- `apps/worker/src/pipeline/remove-background.ts` and `remove-background.test.ts`: switch the call
  to the new entry, add the parser.
- `apps/worker/src/pipeline/cutout.tools.test.ts`: real background removal on the committed clip;
  must keep passing through the new entry.
- `apps/worker/src/pipeline/tools.ts`: `ToolPaths`, `hyperframesEnv`.
- `apps/worker/src/pipeline/retime.ts`, `retime-plan.ts`: `durationSeconds` in `retime.json`.
- `apps/worker/src/pipeline/definition.ts`, `run-pipeline.ts`, `run-pipeline.test.ts`: where the
  footage seconds are recorded after `retime`.
- `apps/worker/src/render/render-call.ts`, `render-call.test.ts`, `render-step.ts`,
  `render-step.test.ts`, `render.tools.test.ts`: the render call, its double and the parser.
- `apps/worker/src/disk-guard.ts`, `disk-guard.test.ts`: `WorkerStatusStore` and
  `supabaseWorkerStatus`; add `heartbeat`.
- `apps/worker/src/main.ts`, `once.ts`: start and stop the heartbeat (main only).
- `apps/worker/src/process-job.ts`: wrap the job in `withKeepAwake`.
- `apps/worker/src/run-job.ts`: job lifecycle (unchanged; context for where keep-awake sits).
- `apps/studio/src/app/reels/[id]/page.tsx`: server reads (history rates, all `worker_status`
  rows).
- `apps/studio/src/components/LiveReel.tsx`: Realtime, step log, jobs list; renders progress, time
  left, offline line, notify toggle, ready notice.
- `apps/studio/src/lib/jobs.ts`: `STEP_COLUMNS`, `StepRow`.
- `apps/studio/src/lib/reels.ts`: `REEL_DETAIL_COLUMNS`, `ReelDetail`, `reelName`.
- `apps/studio/src/lib/worker-status.ts` and `worker-status.test.ts`: columns, `waitingReasonOf`.
- `apps/studio/src/components/ExportPanel.tsx`: how a new export id arrives (context only).
- `apps/studio/e2e/disk-guard.spec.ts`, `export.spec.ts`, `upload.spec.ts`: patterns for seeding,
  running `once`, the no-reload marker and the CDN routes.
- `apps/studio/test-support/worker.ts`, `pipeline-cache.ts`, `fixtures.ts`,
  `local-supabase.ts`: spec helpers.
- `apps/studio/db-tests/steps-measurements.test.ts`: exact `steps` column set (add the two new
  columns).
- `apps/studio/db-tests/stored-files.test.ts`: exact `worker_status` column set (add
  `heartbeat_at`).
- `knip.json`, `turbo.json`: a new env variable a task reads must be listed (none is needed for
  `test:e2e`, since `once` gets its env from the spec process; check `E2E_MOCK_RENDER_SECONDS` does
  not need listing because it is set only in the spawned child's env).
- `node_modules/hyperframes/dist/render-UPRWOGLS.js`, `remove-background-PCL6I5SZ.js`,
  `chunk-26AQTUU4.js`, `api.d.ts`: the pinned tool's real progress behaviour (read only).
- `node_modules/next/dist/docs/`: read the client component and metadata guides before touching
  `document.title` handling in the App Router.

### New Files

- `supabase/migrations/<stamp>_progress_heartbeat.sql`: created with
  `supabase migration new progress_heartbeat`.
- `apps/worker/src/progress.ts` and `progress.test.ts`: the throttle.
- `apps/worker/src/progress-parsers.ts` and `progress-parsers.test.ts`: the two parsers.
- `apps/worker/src/progress-testdata/remove-background.txt`: captured stdout of the new entry on
  the committed clip (real HyperFrames 0.8.222).
- `apps/worker/src/progress-testdata/render.txt`: captured stdout of a real
  `hyperframes render` (0.8.222) of the committed fixture project.
- `apps/worker/src/pipeline/remove-background-entry.ts`: the Node entry wrapping
  `hyperframes/api`'s `removeBackground`.
- `apps/worker/src/render/fake-render.ts`: the render double's process: replays
  `progress-testdata/render.txt`'s `@hf-progress` lines over `E2E_MOCK_RENDER_SECONDS` (default 0)
  and copies the stub MP4.
- `apps/worker/src/heartbeat.ts` and `heartbeat.test.ts`.
- `apps/worker/src/keep-awake.ts` and `keep-awake.test.ts`.
- `apps/studio/src/lib/progress.ts` and `progress.test.ts`: `timeLeftSeconds`, `formatTimeLeft`,
  `historyRates`.
- `apps/studio/src/lib/ready-notice.ts` and `ready-notice.test.ts`: `readyEvent`, `readyTitle`.
- `apps/studio/src/lib/worker-offline.ts` and `worker-offline.test.ts`: `offlineSince`,
  `offlineAt`, `formatOfflineSince`.
- `apps/studio/src/components/NotifyToggle.tsx`: the "Notify me" button.
- `apps/studio/src/components/useReadyNotice.ts`: the title and notification hook.
- `apps/studio/e2e/progress.spec.ts`: E2E progress rising without reload.
- `apps/studio/e2e/notification.spec.ts`: E2E notification and title, hidden versus visible.
- `apps/studio/e2e/worker-offline.spec.ts`: E2E offline line live.
- `app_docs/status.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

The migration and the shared column lists: `steps.progress_percent`, `steps.progress_updated_at`,
`reels.footage_seconds`, `worker_status.heartbeat_at`; update `STEP_COLUMNS`,
`REEL_DETAIL_COLUMNS`, `WORKER_STATUS_COLUMNS` and the two DB column-set tests. Capture the two real
output samples on the owner's Mac (HyperFrames is installed and `test:tools` already runs it).

### Phase 2: Core Implementation

Worker: parsers, throttle, runner hook, `StepStore.progress`, the remove-background entry, the render
parser and progress-printing render double, footage seconds after retime, heartbeat, keep-awake.
Studio: the pure functions (time left, ready event, offline) with their unit tests.

### Phase 3: Integration

Wire the studio: server reads of history rates and every `worker_status` row, the step line with
percentage and time left, the offline line under queued jobs with its local timer, the notify toggle
and the ready notice. Add the three E2E specs, the doc and the index line.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the rules and docs

- Read `AGENTS.md`, `app_docs/studio.md`, `app_docs/measurement.md`, `app_docs/pipeline.md`,
  `app_docs/export.md`, `app_docs/storage.md`, and the Next client-component docs under
  `node_modules/next/dist/docs/`.

### 2. Migration

- Run `supabase migration new progress_heartbeat` (the only `supabase` command besides
  `.adw/supabase-stack reset`). In the new file, with a header comment like the earlier migrations:
  - `alter table public.steps add column progress_percent smallint check (progress_percent between 0 and 100), add column progress_updated_at timestamptz;`
  - `alter table public.reels add column footage_seconds numeric check (footage_seconds > 0);`
  - `alter table public.worker_status add column heartbeat_at timestamptz;`
- No grant changes: `authenticated` already selects these tables under RLS, the worker writes with
  the service role, and all three tables are already in `supabase_realtime`.
- Run `.adw/supabase-stack reset`. If it fails, report its error and stop (never reset by any other
  means, never `supabase migration up`).

### 3. DB column-set tests

- `apps/studio/db-tests/steps-measurements.test.ts`: add `progress_percent` (`smallint`) and
  `progress_updated_at` (`timestamp with time zone`) to `STEP_COLUMNS`.
- `apps/studio/db-tests/stored-files.test.ts`: add `heartbeat_at` to `WORKER_STATUS_COLUMNS`; add a
  case that an upsert of `heartbeat_at` and `free_disk_bytes` alone leaves an existing
  `waiting_reason` untouched (the heartbeat never clears the disk guard's reason).

### 4. Capture the real output samples

- On the owner's Mac (HyperFrames 0.8.222 installed), after step 8 exists: run
  `node apps/worker/src/pipeline/remove-background-entry.ts <retimed fixture or committed clip> /tmp/subject.webm --device auto --quality balanced`
  (input from the `fixtures/pipeline/` retime output or the clip `test:tools` uses; never
  `fixtures/footage/short-person.mp4` modified) with `HYPERFRAMES_NO_TELEMETRY=1`, and save stdout to
  `apps/worker/src/progress-testdata/remove-background.txt`.
- Run a real render the way `render.tools.test.ts` builds its project (a short `--start/--end`
  range is fine) with stdout redirected to a file (not a TTY, `HYPERFRAMES_STDOUT_IS_TTY` unset),
  and save stdout as `apps/worker/src/progress-testdata/render.txt`. Keep every `@hf-progress` line
  and the surrounding lines as printed; strip nothing but absolute home paths if any appear.
- Both files are plain text, committed, small (trim repeated non-progress noise only if one exceeds
  about 200 KB).

### 5. Progress parsers (worker)

- `apps/worker/src/progress-parsers.ts`: `export type ProgressParser = (line: string) => number | null;`
  `hfProgress: ProgressParser` reads lines starting with `@hf-progress ` (after trimming), parses
  the JSON, returns `pct` clamped to 0..100 and rounded, or null for any other line or bad JSON.
  Export `parseRenderProgress = hfProgress` and `parseRemoveBackgroundProgress = hfProgress` under
  their own names so each step names its own parser (and either can diverge later).
- `progress-parsers.test.ts`: feed each committed sample line by line; the non-null values are
  non-decreasing, there is more than one distinct value, and the last is 100 (if the tool's last
  report is below 100, the test asserts the parser's values are monotonic and the step runner's
  `finish()` provides the 100; prefer a sample whose last line is 100). Non-progress lines and
  malformed JSON give null.

### 6. Throttle (worker)

- `apps/worker/src/progress.ts`:
  `createProgressThrottle({ everyMs = 10_000, now = Date.now, write, onError }): { push(percent: number): void; finish(): Promise<void>; stop(): void; settled(): Promise<void> }`.
  - `push`: ignores values not greater than the last written; writes when nothing was written yet or
    `now() - lastWriteAt >= everyMs`; otherwise drops the value (the next line after the window
    carries a fresher one).
  - Writes go on one promise chain; a rejected write calls `onError` and the chain continues.
  - `finish()`: waits for the chain, then writes 100 once (unless stopped). `stop()`: no more writes.
  - Export `PROGRESS_EVERY_MS = 10_000`.
- `progress.test.ts` (fake clock, Verification 1): 1000 lines with rising percentages spread evenly
  over 7 simulated minutes (420 000 ms), then `finish()`: the recorded writes are at most 43, every
  two consecutive non-final writes are at least 10 000 ms apart, the values rise, and the last write
  is 100. Also: a lower value is never written; `stop()` prevents `finish()`'s 100; a failed write
  does not stop later ones.

### 7. Runner and store hook (worker)

- `step-store.ts`: add `progress(stepId: string, percent: number): Promise<void>` (update
  `progress_percent` and `progress_updated_at = now()` of that row),
  `footageSeconds(reelId): Promise<number | null>` (reads `footage_seconds` only) and
  `recordFootageSeconds(reelId, seconds): Promise<void>` (update `reels` set `footage_seconds` where
  `id` and `footage_seconds is null`). Implement them in `recording-steps.ts` and every in-test
  fake `StepStore`.
- `step-runner.ts`: add `progress?: ProgressParser` to `ToolCall`. In `runToolsStep`, create one
  throttle per step lazily (the first call that has a parser), with `write: (p) =>
ctx.steps.progress(stepId, p)`, `onError` logging through the step logger. This needs the step id:
  pass it from `withStep` into the body (extend the body's arguments with `stepId`). In the `tool`
  wrapper, wrap `log` so each line also goes through `call.progress` and `throttle.push`. After
  `spec.work` succeeds and before returning the measurements, `await throttle.finish()` (so 100 is
  written before `done`). On failure or abort, `throttle.stop()` and await `settled()` so no write
  lands after the failed row. Steps without a parser are unchanged (no write, no timer).
- `step-runner.test.ts`: a fake `SpawnTool` that logs progress lines; assert the store received the
  throttled values and a final 100 before `done`; a step without a parser writes no progress; a
  failed step writes no 100.

### 8. Remove-background entry and step (worker)

- `apps/worker/src/pipeline/remove-background-entry.ts`: parses `input`, `-o output`, `--device`,
  `--quality` (the same arguments `removeBackgroundArgs` builds, minus `remove-background` and
  `--json`), calls `removeBackground` from `hyperframes/api` with `onProgress` printing
  `@hf-progress {"index","total","pct"}` for `frame` events with a total, then prints the CLI's
  `--json` result object on one line and exits 0; on error prints
  `{"ok":false,"error":{"code":"runtime_error","message":...}}` and exits 1. A file header comment
  explains why (the pinned CLI prints no progress unattended) and that the options are exactly the
  CLI's, so the output is unchanged.
- `remove-background.ts`: `ToolPaths` gains nothing; the step calls
  `tool({ file: tools.hyperframes[0], args: [REMOVE_BACKGROUND_ENTRY, ...entryArgs], env: hyperframesEnv(), progress: parseRemoveBackgroundProgress })`
  (`tools.hyperframes[0]` is already `process.execPath`; `REMOVE_BACKGROUND_ENTRY` is the entry's
  absolute path from `import.meta.url`).
  Keep `removeBackgroundArgs` (adjusted to the entry's arguments) and `parseRemoveBackgroundResult`.
  Do not bump `REMOVE_BACKGROUND_VERSION` and do not change `REMOVE_BACKGROUND_SETTINGS`: same
  library function, same options, same model, so the same output and the same fingerprints (no
  fixture regeneration).
- Update `remove-background.test.ts` for the new arguments and the parser being passed.
- `cutout.tools.test.ts` (owner's Mac, `test:tools`) must still pass through the entry.

### 9. Render parser and progress-printing double (worker)

- `render-call.ts`: the real call gains `progress: parseRenderProgress`, and `renderEnv` drops
  `HYPERFRAMES_STDOUT_IS_TTY` along with `PRODUCER_*` (it would silence `@hf-progress`).
- Under `E2E_MOCK_RENDER === "true"` the call becomes
  `{ file: process.execPath, args: [FAKE_RENDER, STUB_EXPORT, output], env: { ...env }, sampleGroupMemory: true, progress: parseRenderProgress }`.
- `apps/worker/src/render/fake-render.ts`: reads `progress-testdata/render.txt`, keeps its
  `@hf-progress` lines, prints them spread evenly over `E2E_MOCK_RENDER_SECONDS` seconds (unset or
  `0`: all at once), then copies the stub MP4 to the output. Refuse to run unless
  `E2E_MOCK_RENDER === "true"`.
- Update `render-call.test.ts` (the double's call, the parser present, `HYPERFRAMES_STDOUT_IS_TTY`
  removed) and `render-step.test.ts` if it asserts the call shape.

### 10. Footage seconds after retime (worker)

- `definition.ts`: optional `footage?: { file: string; seconds(text: string): number }` on
  `PipelineStep`; set it on `retime` (`file: "retime.json"`, reading `durationSeconds`, throwing on a
  non-positive or missing value).
- `run-pipeline.ts`: after a step with `footage` (hit or ran), if
  `await steps.footageSeconds(job.reel_id)` is null, read the file (the local output path when it
  ran; when it hit, download the kept `retime.json` into the job's `inputs/` folder) and call
  `steps.recordFootageSeconds`. This happens before `remove_background`, so the studio has it while
  that step runs.
- `run-pipeline.test.ts`: on a ran retime the reel gets the plan's seconds; on a hit with no value
  the file is downloaded and recorded; on a hit with a value nothing is downloaded.

### 11. Heartbeat (worker)

- `disk-guard.ts`: `WorkerStatusStore` gains `heartbeat({ freeDiskBytes }): Promise<void>`;
  `supabaseWorkerStatus` upserts `worker_id`, `free_disk_bytes`, `heartbeat_at = now`,
  `updated_at = now`, never `waiting_reason`. Update fakes in `disk-guard.test.ts`.
- `apps/worker/src/heartbeat.ts`: `HEARTBEAT_EVERY_MS = 5 * 60_000`;
  `startHeartbeat({ beat, everyMs, onError }): { stop(): void }` calls `beat()` at once and on a
  `setInterval`; a rejected beat calls `onError` (default `console.error`) and the interval goes on.
- `heartbeat.test.ts` (fake timers): one beat at start, one more at each 5 minutes, none after
  `stop()`, a failing beat does not stop later ones.
- `main.ts`: start it after the sweep with `beat: async () => status.heartbeat({ freeDiskBytes: await freeBytes(config.scratchDir) })`;
  stop it in `stop()`. `once.ts` does not start it (comment why).

### 12. Keep awake (worker)

- `apps/worker/src/keep-awake.ts`:
  `withKeepAwake<T>(work: () => Promise<T>, { platform = process.platform, pid = process.pid, spawn = node spawn } = {}): Promise<T>`.
  On `darwin`, spawns `/usr/bin/caffeinate` with `["-i", "-w", String(pid)]`, `stdio: "ignore"`,
  ignores its `error` event (a missing binary never fails a job); in `finally` kills it
  (`SIGTERM`). On any other platform it spawns nothing.
- `process-job.ts`: wrap the `withJobScratch(...)` call in `withKeepAwake(() => ...)`.
- `keep-awake.test.ts` (Verification 7): with a fake spawn, on `darwin` it is called once with
  `/usr/bin/caffeinate` and `["-i", "-w", "<pid>"]` before the work runs and the child's `kill` is
  called after the work resolves, and also after it rejects (the rejection propagates); on `linux`
  the fake spawn is never called.

### 13. Studio pure functions

- `apps/studio/src/lib/progress.ts`:
  - `historyRates(rows: { wall_ms: number | null; reels: { footage_seconds: number | string | null } | null }[]): number[]`:
    ms of step time per second of footage, skipping rows without both values (numeric comes back as
    a string from PostgREST; convert).
  - `timeLeftSeconds({ rates, footageSeconds, elapsedMs }): number | null`: null when fewer than 3
    rates or no footage seconds; otherwise the median of the newest 10 rates times footage seconds,
    minus elapsed, in seconds, never below 0.
  - `formatTimeLeft(seconds | null)`: `no estimate yet`, `less than a minute left`, `about N min left`.
  - `ESTIMATE_MIN_ROWS = 3`, `ESTIMATE_LAST_ROWS = 10`, `PROGRESS_STEPS = ["remove_background", "render"]`.
- `progress.test.ts` (Verification 3): rates 8000, 8400, 9000, footage 50, elapsed 120 000 ms gives
  300; with two rates gives null; median of an even count; more than 10 rates uses only the first
  10 (newest first); never negative.
- `apps/studio/src/lib/ready-notice.ts`: `readyEvent(previous, next)` with
  `{ status, latestExportId }` snapshots: `"processed"` when status moved from anything else into
  `processed`, `"export"` when `latestExportId` changed to a different non-null id, otherwise null;
  `readyTitle(reelName)` gives `Ready: <name>`. Tests cover first render (no previous) giving null,
  processed to processed giving null, both transitions.
- `apps/studio/src/lib/worker-offline.ts`: `OFFLINE_AFTER_MS = 11 * 60_000`;
  `offlineAt(rows)` the newest `heartbeat_at` plus 11 minutes, or null when no row has one;
  `offlineSince(rows, now)` the newest heartbeat `Date` when `now >= offlineAt`, else null;
  `formatOfflineSince(date)` `Worker offline since HH:MM` (24-hour, local time, zero padded).
  Tests: no heartbeat rows gives null; newest wins over an older one; 10 minutes old is online, 12
  minutes is offline.
- `worker-status.ts`: `WORKER_STATUS_COLUMNS = "worker_id, waiting_reason, heartbeat_at, updated_at"`,
  `heartbeat_at: string | null` in the row type; update `worker-status.test.ts`.
- `jobs.ts`: add `progress_percent, progress_updated_at` to `STEP_COLUMNS` and `StepRow`.
- `reels.ts`: add `footage_seconds` to `REEL_DETAIL_COLUMNS` and `ReelDetail`.

### 14. Studio wiring

- `page.tsx`: drop `.not("waiting_reason", "is", null)` from the `worker_status` read (every row,
  named columns). Add one read per progress step name, in the same `Promise.all`:
  `supabase.from("steps").select("wall_ms, reels!inner(footage_seconds)").eq("name", name).eq("status", "done").not("reels.footage_seconds", "is", null).order("finished_at", { ascending: false }).limit(10)`,
  turned into `historyRates` and passed as `estimateRates: Record<string, number[]>`. These are read
  only here (once per page open), not in `readSnapshot`. Do the same `worker_status` change in
  `LiveReel`'s `readSnapshot`.
- `LiveReel.tsx`:
  - Step line: for a `running` step whose name is in `PROGRESS_STEPS` and whose
    `progress_percent` is not null, append `<span data-testid="step-progress">NN%</span>` and
    `<span data-testid="step-time-left">` with `formatTimeLeft(timeLeftSeconds({ rates: estimateRates[name], footageSeconds: reel.footage_seconds, elapsedMs: Date.parse(progress_updated_at) - Date.parse(started_at) }))`
    (elapsed measured to the progress write, so the value is a pure function of the row and changes
    with each Realtime update, no ticking timer). Other steps unchanged.
  - Offline: compute `offlineAt(workerStatus)`; a `useEffect` schedules one `setTimeout` for that
    instant (cleared on change) that bumps a state so `offlineSince(workerStatus, new Date())`
    recomputes; under each `queued` job render
    `<span data-testid="job-offline">{formatOfflineSince(since)}</span>` when offline. No interval,
    no database read.
  - Ready notice: `useReadyNotice({ status: reel.status, latestExportId, reelName: reelName(reel) })`,
    and render `<NotifyToggle />` near the status list.
- `components/useReadyNotice.ts`: keeps the previous snapshot in a ref; on change computes
  `readyEvent`; when non-null and `document.visibilityState === "hidden"`: saves `document.title`
  (if not already saved), sets `readyTitle(...)`, and if `localStorage["studio-notify"] === "on"` and
  `Notification.permission === "granted"`, constructs `new Notification(readyTitle(...), { body })`.
  A `visibilitychange` listener restores the saved title when visible. When visible, nothing
  happens.
- `components/NotifyToggle.tsx`: a button `Notify me when ready` / `Notifications on`; hidden when
  `Notification` is undefined; on click calls `Notification.requestPermission()` and stores
  `studio-notify=on` only when it resolves `granted`; shows `Notifications blocked in this browser`
  when denied. Never calls `requestPermission` outside the click handler.
- Check with `yarn turbo run typecheck --filter=./apps/studio` that `reels!inner(...)` types are
  handled (use `.returns<...>()` as the page does).

### 15. E2E: progress (`apps/studio/e2e/progress.spec.ts`)

- Model on `disk-guard.spec.ts`: claimable check, test user, `seedProcessedReel`, CDN routes, sign
  in, open the reel page, wait for `[data-realtime="ready"]`, set the no-reload marker.
- Insert a `render` job for `reel.versionId` with the admin client, then
  `runWorkerOnce({ R2_KEY_PREFIX, E2E_MOCK_RENDER_SECONDS: "25" }, { timeoutMs: 90_000 })` without
  awaiting it yet.
- On the render step's line, wait for `step-progress` to show a percentage below 100; record it;
  then wait (timeout 30 s) for a strictly greater percentage, still without reload; expect
  `step-time-left` to read `no estimate yet` (a fresh owner has no history). Await the worker
  (exit 0), expect the step line to show the finished summary and the marker to still be there.
- Assert from the database that the render step row has `progress_percent = 100` and that the
  `progress_updated_at` values seen never came closer than 10 s apart is covered by the unit test
  (do not assert timing here).
- Set `test.setTimeout(150_000)`. Clean up as `disk-guard.spec.ts` does.

### 16. E2E: notification (`apps/studio/e2e/notification.spec.ts`)

- Context with `permissions: ["notifications"]`. Init script: replace `window.Notification` with a
  subclass-like spy recording `{ title, body }` into `window.__notifications` (keeping
  `permission` and delegating `requestPermission` to the original), and override
  `document.visibilityState` and `document.hidden` getters to read `window.__hidden` (default
  false).
- Hidden case (processing): seed the pipeline cache (`seedPipelineCache`), insert a reel `uploaded`
  with a queued `process` job (as `seedProcessedReel` does, without running the worker), open the
  page, click "Notify me when ready", set `window.__hidden = true` and dispatch `visibilitychange`,
  run `once` with the unchanged-answer AI script. Expect the reel status `processed`, one recorded
  notification whose title is `Ready: short-speech.mp4`, and `document.title` equal to it. Then set
  `__hidden = false`, dispatch `visibilitychange`, expect the original title back.
- Visible case (export): with the tab visible, insert a `render` job and run `once`; wait for the
  export link; expect no new notification and the title unchanged.
- Clean up jobs, storage keys and the user.

### 17. E2E: offline (`apps/studio/e2e/worker-offline.spec.ts`)

- Before anything, fail with a clear message if any `worker_status` row has a `heartbeat_at` newer
  than 11 minutes (a running dev worker would hide the offline state).
- Seed a reel with `insertReel` and insert a queued `process` job for it with the admin client. No
  worker runs in this spec, so the job stays queued; delete it in `afterAll` (even after a failure)
  so nothing claimable is left for the next spec.
- Open the reel page, wait for Realtime ready. Upsert a `worker_status` row with the spec's own
  `WORKER_ID`, `free_disk_bytes`, `heartbeat_at = now - 20 min`. Expect
  `job-offline` to match `/^Worker offline since \d{2}:\d{2}$/` live, and the time to equal the
  heartbeat formatted in the page's local time (compute it with `page.evaluate`). Update
  `heartbeat_at` to now: expect `job-offline` to disappear. Check the no-reload marker. Delete the
  row in `afterAll`.

### 18. Documentation

- New `app_docs/status.md` (format like `app_docs/storage.md`: Specifications, Overview, How it
  works, Rules, Notes): progress parsing per tool (the `@hf-progress` line, why remove-background
  runs through its own entry, the committed samples), the throttle (first value at once, one per
  10 s, never lower, 100 at the end, no write after failure), footage seconds from `retime.json`,
  the time-left estimate and its warm-up (3 rows, median of the last 10, one read per page open),
  the notification and title rules, the heartbeat (main only, 5 minutes, not `once`) and the
  offline display (11 minutes, one local timer, under queued jobs), keep-awake, the render double's
  `E2E_MOCK_RENDER_SECONDS`, the three specs. Rules section: never more than one progress write per
  10 s per step; progress only for `remove_background` and `render`; never poll the database from
  the studio for progress, heartbeat or offline (Realtime and local timers only); never ask for
  notification permission except from a click; no notification service, nothing with the tab
  closed; never write a heartbeat from `once`; never let the heartbeat clear `waiting_reason`.
  Notes: estimates are wrong for the first reels; not verified by the pipeline (real macOS
  notifications, real sleep and wake, estimate quality); owner steps (apply the migration to the
  hosted project after merge, manual acceptance).
- `docs/conditional-docs.md`: one line for `app_docs/status.md` (step progress, time left, the
  ready notification and title, `worker_status.heartbeat_at` and the offline line, keep-awake,
  `E2E_MOCK_RENDER_SECONDS`).
- `app_docs/measurement.md` and `app_docs/export.md`: remove "progress and time left" from
  out-of-scope Notes and point to `status.md`. `app_docs/storage.md`: update the Notes that defer
  the heartbeat to slice 15. `app_docs/pipeline.md`: note that `remove_background` runs through
  `remove-background-entry.ts` with unchanged settings and version.
- `.adw/project.md` Tests section: add the three new specs to the E2E list and `steps`/
  `worker_status` column notes, keeping the nine headings unchanged.

### 19. Validation

- Run every command in `Validation Commands`, fix failures without weakening a test, a type or a
  rule.

## Testing Strategy

### Unit Tests

- `apps/worker/src/progress.test.ts`: throttle with a fake clock (Verification 1), monotonic,
  `stop`, failed write.
- `apps/worker/src/progress-parsers.test.ts`: both committed samples give monotonic values ending
  at 100 (Verification 2); other lines give null.
- `apps/worker/src/step-runner.test.ts`: the runner writes throttled progress then 100 before
  `done`; no writes without a parser; no 100 on failure.
- `apps/worker/src/pipeline/remove-background.test.ts`, `render/render-call.test.ts`: the calls
  carry their parser; the render env drops `HYPERFRAMES_STDOUT_IS_TTY`; the double is the
  fake-render process.
- `apps/worker/src/pipeline/run-pipeline.test.ts`: footage seconds recorded after retime (ran, hit
  without value, hit with value).
- `apps/worker/src/heartbeat.test.ts`, `disk-guard.test.ts`: beats at start and every 5 minutes;
  heartbeat upsert shape.
- `apps/worker/src/keep-awake.test.ts`: Verification 7.
- `apps/studio/src/lib/progress.test.ts`: Verification 3 and formatting.
- `apps/studio/src/lib/ready-notice.test.ts`, `worker-offline.test.ts`, `worker-status.test.ts`.
- DB layer: `steps-measurements.test.ts` and `stored-files.test.ts` column sets and the heartbeat
  upsert leaving `waiting_reason`.

### Test Coverage

- `apps/worker/src/progress.test.ts` (unit): catches more than one progress write per 10 s or a
  missing final 100; fails today because the module does not exist.
- `apps/worker/src/progress-parsers.test.ts` (unit): catches a parser that misreads the pinned
  HyperFrames output (or a version bump that changes it).
- `apps/worker/src/step-runner.test.ts` additions (unit): catches the runner not wiring the parser
  to the store, or writing after failure.
- `apps/worker/src/keep-awake.test.ts` (unit): catches a leaked or missing caffeinate on success or
  failure, or one spawned off macOS.
- `apps/worker/src/heartbeat.test.ts` (unit): catches a missing start beat or a wrong period.
- `apps/worker/src/pipeline/run-pipeline.test.ts` additions (unit): catches a reel left without
  `footage_seconds`, which would leave every estimate empty.
- `apps/studio/src/lib/progress.test.ts` (unit): catches a wrong median, warm-up threshold or sign.
- `apps/studio/src/lib/ready-notice.test.ts`, `worker-offline.test.ts` (unit): catch a
  notification on first load and a wrong offline threshold.
- `apps/studio/db-tests/steps-measurements.test.ts`, `stored-files.test.ts` (DB): catch a missing
  or mistyped column and a heartbeat that clears the disk guard's reason.
- `apps/studio/e2e/progress.spec.ts` (E2E): catches progress not reaching the page live
  (Verification 4).
- `apps/studio/e2e/notification.spec.ts` (E2E): catches a missing notification or title change while
  hidden, or one while visible (Verification 5).
- `apps/studio/e2e/worker-offline.spec.ts` (E2E): catches the offline line not appearing or not
  clearing live (Verification 6).

### Edge Cases

- A tool prints no progress (a very short clip, `total` unknown): no progress writes, just 100 at
  the end; the studio shows nothing until then.
- A tool's reported percentage goes down (stage change): the throttle never writes a lower value.
- Progress write fails (network blip): logged, the step continues.
- Lease lost mid-step: no progress write after abort, no 100.
- Step fails: no 100; the row's last percentage stays, the line shows the failure as before (no
  percentage on a non-running step).
- Cache hit for a long step: no progress (status `skipped`).
- Reel without `footage_seconds` (older reels): `no estimate yet`.
- Earlier rows from reels without `footage_seconds` are excluded from the rates.
- Elapsed already longer than the estimate: `less than a minute left` (never negative).
- Notification API missing (non-Chromium, insecure context): no toggle, title still changes.
- Permission denied: toggle shows blocked; title still changes.
- Several ready events while hidden: title saved once and restored once.
- No heartbeat ever written (only disk guard rows, specs): no offline line.
- Heartbeat arrives exactly as the timer fires: Realtime update recomputes; the timer is
  rescheduled.
- Linux CI: keep-awake spawns nothing; E2E `once` on macOS spawns and kills caffeinate.

## Acceptance Criteria

- The migration adds exactly the four columns; `.adw/supabase-stack reset` applies it; the column-set
  DB tests pass.
- `remove_background` and `render` write `progress_percent` at most once per 10 s per step and 100
  at the end; no other step writes progress.
- The reel page shows the running long step's percentage rising live and the time left or
  `no estimate yet`; three earlier rows at 8000, 8400 and 9000 ms per second, 50 s of footage and
  120 s elapsed give 300 s.
- With the tab hidden, the reel becoming `processed` or a new export changes the title to
  `Ready: <reel>` and, with notifications on, constructs one `Notification`; with the tab visible,
  neither happens; the title comes back when the tab is visible again.
- Notification permission is requested only from the "Notify me" click.
- `main.ts` writes `heartbeat_at` at start and every 5 minutes; `once` never does; the studio shows
  `Worker offline since HH:MM` under queued jobs when the newest heartbeat is older than 11 minutes,
  live, and hides it when a fresh heartbeat arrives, with no database polling.
- On macOS each job runs under `caffeinate -i -w <pid>`, stopped at job end on success and failure;
  on Linux nothing is spawned.
- `app_docs/status.md` exists with a Rules section and one line in `docs/conditional-docs.md`.
- No em-dashes in any changed file. Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset` - applies the new migration to the ADW stack (the profile's rule after
  adding a migration; replaces the issue's `supabase migration up --local`, which the profile forbids
  by hand). If it fails, report the error and stop.
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` - ESLint for both changed
  workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio` - types, including the
  worker's build check.
- `yarn knip` - no unused exports or files from the new modules.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio` - unit tests: throttle,
  parsers, runner, heartbeat, keep-awake, estimate, ready event, offline, and the migration version
  guard.
- `yarn workspace @edit-issebya/worker test:tools` - real HyperFrames on the owner's Mac: background
  removal through the new entry and the render still pass.
- `yarn turbo run test:db --filter=./apps/studio` - column sets and the heartbeat upsert against the
  ADW stack.
- `yarn turbo run build --filter=./apps/studio` - the studio builds (the worker has no build).
- `yarn build` - the issue's gate: the whole repository builds.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - landing then studio suites, including
  `progress.spec.ts`, `notification.spec.ts` and `worker-offline.spec.ts` (values from
  `.ports.env`; the `/prepare_app` server must already be up).

## Notes

- **No new dependency.** `hyperframes/api` is already installed (pinned `0.8.222`, public `./api`
  export); `caffeinate` is a macOS system binary.
- **Why a remove-background entry**: verified in the pinned package that `hyperframes
remove-background` prints no progress when stdout is not a terminal (`--json` disables the
  spinner; the unattended `lineSpinner` discards `message()`). The entry calls the same library
  function with the same options, so its output, the step's settings, version and fingerprints, and
  `fixtures/pipeline/` stay as they are. The pipeline rule "bump a step's version whenever its
  behaviour changes" does not apply, since the output does not change; say so in `pipeline.md`.
  The API's header says it may change between minor versions: a HyperFrames bump must re-check
  the entry and re-capture both samples.
- **Why retime sets `footage_seconds`**: both long steps work on the retimed footage, so the
  retimed length is the right divisor; it is in the kept `retime.json`, so it is available on a
  hit too.
- **Why `once` writes no heartbeat**: a one-shot process would mark the worker live for eleven
  minutes after it exited; specs also spawn it with random worker ids, whose rows would pile up
  with fresh heartbeats.
- **Offline across several workers**: the MVP has one worker; the rule uses the newest heartbeat of
  any worker (if any worker is alive, jobs run). A per-worker display is later work.
- **E2E timing**: the progress spec runs the render double for 25 seconds so the fixed 10-second
  throttle yields at least two distinct percentages before 100; the throttle period is never
  shortened for tests.
- **Manual acceptance (owner)**: a real reel processed and exported with the tab in the background
  (percentage about every 10 s, plausible time left after a few reels, the notification, no sleep);
  laptop lid closed 15 minutes with a job queued (offline line, job runs on wake); apply the
  migration to the hosted project after merge.
- **Out of scope**: email or push with the tab closed; retry, AI-unavailable and footage refusals
  (slice 16); progress for any other step.
