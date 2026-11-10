# Progress overlay, time left, worker heartbeat and keep-awake

**Specifications:**

- specs/issue-38-adw-119c12a9-sdlc_planner-reel-progress-notification-heartbeat.md
- specs/issue-117-adw-d16e6f05-sdlc_planner-reel-progress-overlay.md

## Overview

The reel page shows what the studio is doing in a small progress overlay over the preview: the step
in plain words, step k of n with a bar, the waiting and offline lines, a `New version N` notice when
a version is saved, and a failure with the actions that fit it. The overlay replaced the jobs list
and step log the page used to show. A newly saved version replaces the preview by itself, at the
same time and play state. The long steps, `head_track` (its person mask's per-frame progress), the on-demand `cutout` (MODNet's per-frame progress) and `render`, write their tool's progress into their own
step row, and the studio's reel page shows the percentage with an estimate of the time left. The long-running worker writes a heartbeat every five
minutes, so a queued job can say since when the worker is offline. On macOS the worker keeps the
machine from idle-sleeping while a job runs.

## How it works

### Database

`supabase/migrations/20261102005505_progress_heartbeat.sql`:

- `steps.progress_percent` (`smallint`, 0 to 100) and `steps.progress_updated_at`
  (`timestamptz`).
- `reels.footage_seconds` (`numeric`, above 0): the retimed footage's length, the divisor of the
  time-left estimate.
- `worker_status.heartbeat_at` (`timestamptz`).
- The existing RLS and the Realtime publication of the three tables cover the new columns: no grant
  or policy changed.

### Progress overlay

- `apps/studio/src/lib/progress-overlay.ts`, `overlayState(...)`: a pure function of `LiveReel`'s
  existing Realtime state (reel, jobs, steps, versions, worker status, the notice, the dismissed
  jobs, the time-left history). No new subscription, no polling, no reads, no timers.
- One state at a time, in this precedence: `failure` (the newest job failed, it is retryable under
  `retryableJobIds`, so not already retried and never on a refused reel, and the owner has not
  handled it on this page load), then `notice` (`New version N`), then `working` (the oldest
  `queued`, `running` or `waiting_ai` job), then `hidden` (nothing rendered). A `cancelled` job
  (`app_docs/export.md`) is neither live nor failed, so it shows nothing.
- The export modal (`app_docs/export.md`) reads the same render step's `progress_percent` from the
  same Realtime state, for the job it follows.
- `jobProgress`: step k of n from `JOB_STEPS[job.kind]` in `step-words.ts` (`process` runs eight
  steps, `change` and `start_over` are `decide`, `restore` and `render` one each). A `cutout` step counts as `decide`;
  the current step is the running one, else a `waiting` one (so a `cutout` row finished inside a
  waiting `decide` never takes its words), else the last; a queued job, or one with no step yet, is step 0 (`Waiting to start`, no "Step k of n" line). The
  bar's fraction is the finished (`done` or `skipped`) listed steps over n, plus a running long
  step's `progress_percent`.
- `apps/studio/src/lib/step-words.ts` is the one place for the step words: `STEP_WORDS` (each
  step's doing words and failed headline; the headline defaults to `Could not finish` and the doing
  words), `stepWords(name, { restoreNumber })` (`restore` names its version N, else `an earlier
version`), the `Working on it` / `Could not finish this step` fallback for an unknown step, and
  `RULE_WORDS` with `refusalReason(rules)`: the first two distinct rule words of a refused answer,
  joined with "and", from the rule names only. `RULE_WORDS` covers the check rules (`safe-box`,
  `face`, `text-overlap`, `same-text`, `timing`, `big-word-timing`, `sound-gap`, `time-in-speech`,
  `out-of-reel`), the rules a refused answer carries (`answer-json`, `answer-schema`, `answer-edit` and
  `glossary`) and the engine's `hidden-footage`. The engine's other notes never refuse, so they have no words.
- Failure actions (`FailureAction`): every retryable failure offers Try again and Keep the current version.
  Try again calls `requestRetry` and shows its answer (`Queued again`, say). Keep the current version dismisses the failure. Each
  action captures `studio_failure_action` with `reel_id`, `job_id`, `action`, `failure_kind`,
  `step` and `job_kind` (the `job_id` links it to the job's error). A handled failure is dismissed
  in memory for the page load: a reload shows a still-unhandled one again.
- The headline is the failed step's `failed` words; the reason line is `refusalReason` for a refused
  answer and nothing otherwise. No error tail, code or machine step name reaches the page.
- `apps/studio/src/components/ProgressOverlay.tsx` renders it (layout in
  `app_docs/studio-reel-layout.md`). The words sit in a polite live region (`role="status"
aria-live="polite"`); the buttons stay outside it, so updates do not announce them again. Test ids:
  `progress-overlay` (with `data-overlay-kind`), `overlay-words`, `overlay-step`, `overlay-notice`,
  `overlay-headline`, `overlay-reason`, `overlay-try-again`,
  `overlay-keep`, `overlay-action-message`.

### New version notice and automatic switch

- `LiveReel` shows `New version N` for `NEW_VERSION_NOTICE_MS` (4000 ms) when the reel's
  `current_version_id` changes after the first render (derived during render, never on the first
  render). One timeout clears it; a newer version's number replaces the shown one.
- `apps/studio/src/components/ReelPreview.tsx` keeps the previous built preview on screen until the
  next version is built, then mounts it with `startAt` (the last position, clamped to the new
  version's duration) and `autoPlay` (the last play or pause intent), through `PreviewPlayer`'s
  hold-then-start routine. `PreviewPlayer`'s wrapper carries
  `data-version-id` and `data-intent`.

### Progress parsing per tool

- `apps/worker/src/progress-parsers.ts` reads one output line at a time. A line
  `@hf-progress {...,"pct":N}` gives `N`, clamped to 0 to 100 and rounded; every other line, and a
  line whose JSON does not parse or has no finite `pct`, gives null. `parseRenderProgress`,
  `parsePersonMaskProgress` and `parseCutoutProgress` are the same parser today, named per step so
  each can follow its tool later.
- `render`: HyperFrames 0.8.222's `hyperframes render`, with stdout not a terminal, prints one
  `@hf-progress` line per progress report. `renderEnv` drops `HYPERFRAMES_STDOUT_IS_TTY`, which
  set to 1 silences those lines (`apps/worker/src/render/render-call.ts`).
- `head_track`: the pinned CLI prints no progress when nobody watches (with `--json` its
  spinner is off, and without it the unattended spinner drops every message); the per-frame events
  exist only through `onProgress` of the package's `hyperframes/api` export. So the person mask
  (`apps/worker/src/pipeline/person-mask.ts`) runs
  `apps/worker/src/pipeline/remove-background-entry.ts` with HyperFrames' own Node: it calls the
  same `removeBackground` with exactly the options the CLI passes (input, output, device, quality),
  prints one `@hf-progress {"index","total","pct"}` line per sampled frame and, at the end, the
  same JSON result document the CLI prints under `--json` (`app_docs/pipeline.md`).
- `cutout`: the MODNet entry (`apps/worker/src/cutout/modnet-entry.ts`, `app_docs/pipeline.md`)
  prints one `@hf-progress {"index","total","pct"}` line per frame of its span. The step runs one
  call per missing span, so `ensureCutouts` wraps the parser in `partProgress(parser, from, to)`:
  each span's 0 to 100 maps onto its share of the step, weighted by the span's length, and the
  step's progress keeps rising across spans (the throttle drops a value at or below the last).
- `apps/worker/src/progress-testdata/render.txt`, `person-mask.txt` and `cutout.txt` are committed
  samples of the real output; `apps/worker/src/progress-parsers.test.ts` replays all three and
  expects rising values ending at 100 or just below, and checks `partProgress`.
- A tool call carries its parser as `ToolCall.progress`; `runToolsStep`
  (`apps/worker/src/step-runner.ts`) feeds every logged line through it. A step without a parser
  writes no progress.

### The throttle

`apps/worker/src/progress.ts`, `createProgressThrottle`, one per step:

- The first value is written at once; after it at most one write per 10 s
  (`PROGRESS_EVERY_MS`). A value arriving inside the window is dropped; the next line carries a
  fresher one.
- Never a value lower than or equal to the last written.
- At the end of a successful step, 100 is written once the queued writes are through, before the
  step's `done` write.
- After a failure or a lost lease the throttle stops: nothing more is written.
- Writes run one after the other; a failed write is logged (`progress not written: ...`) and never
  stops the next one or the step.
- `StepStore.progress` sets `progress_percent` and `progress_updated_at` on the step's row.

### Footage seconds

- The `retime` step names its footage file (`footage: { file: "retime.json", ... }`); after it,
  whether it ran or was a cache hit, `runPipeline` reads `durationSeconds` from `retime.json` (the
  local output, or the kept file downloaded) and sets `reels.footage_seconds`, only while the reel
  has none. A missing or non-positive value fails the job.
- It is recorded before the long steps, so the studio has it while they run.

### Time left

`apps/studio/src/lib/progress.ts`:

- `apps/studio/src/app/reels/[id]/page.tsx` reads, once per page open, the owner's newest 10
  `done` rows of each long step whose reel has `footage_seconds` (RLS keeps them to the owner).
  `historyRates` turns each into `wall_ms / footage_seconds`, skipping a row without both.
- `timeLeftSeconds`: the median of those rates times this reel's `footage_seconds`, minus the time
  the step has run (from `started_at` to `progress_updated_at`). Fewer than 3 earlier rows, or no
  `footage_seconds` on this reel: no estimate. Never below 0.
- `formatTimeLeft`: `no estimate yet`, `less than a minute left`, or `about <n> min left`.
- The overlay shows, for a running long step with a percentage, `<n>%`
  (`data-testid="step-progress"`) and the time left (`data-testid="step-time-left"`). Both are a
  pure function of the row, so each Realtime update refreshes them; no ticking timer.

### Heartbeat

- `apps/worker/src/heartbeat.ts`, `startHeartbeat`: one beat at start, then one every 5 minutes
  (`HEARTBEAT_EVERY_MS`); a failed beat is logged and the next one still comes.
- Only `apps/worker/src/main.ts` starts it, and stops it on shutdown. `once` never beats: it exits
  at once, and a beat from it would show a live worker for eleven minutes that is not there.
- `WorkerStatusStore.heartbeat` (`apps/worker/src/disk-guard.ts`) upserts this worker's
  `worker_status` row with `heartbeat_at`, `updated_at` and `free_disk_bytes` (a first upsert
  inserts the row, which needs it), never `waiting_reason`.

### Offline display

- `apps/studio/src/lib/worker-offline.ts`: the worker is offline once the newest `heartbeat_at` of
  any worker is older than 11 minutes (`OFFLINE_AFTER_MS`). No heartbeat ever: nothing is shown.
- `LiveReel` reads every worker's row (`WORKER_STATUS_COLUMNS` now includes `heartbeat_at`) and
  follows it through Realtime. One local timeout, set for the moment the newest heartbeat turns 11
  minutes old, flips the display; no interval and no database read.
- For a `queued` job the overlay shows `Worker offline since HH:MM` (24-hour local time of the last
  beat, `data-testid="job-offline"`), beside the waiting lines (`job-waiting-ai` for a job waiting
  for the AI, `job-waiting` for the disk guard's reason); a fresh heartbeat arriving through Realtime removes it.

### Keep-awake

- `apps/worker/src/keep-awake.ts`, `withKeepAwake`: on macOS only, spawns
  `/usr/bin/caffeinate -i -w <worker pid>` around the job (`processJob` in
  `apps/worker/src/process-job.ts`) and kills it when the job ends, whatever the outcome. `-w` also
  ends it if the worker dies. Nothing is spawned on any other platform, and a missing `caffeinate`
  never fails the job.
- The worker in its container (Linux) never spawns it. `yarn dev:studio` keeps the Mac awake instead,
  with `caffeinate -i -w <script pid>` for the script's whole life (`app_docs/worker-container.md`).

## How to Use

- On a reel's page, the overlay over the preview says what the studio is doing, step k of n. A
  running `head_track` or `render` step also shows its percentage and the time left. The first reels show `no estimate yet` until three earlier runs of that step exist.
- When a job fails, the overlay offers Try again and Keep the current version.
- `Worker offline since HH:MM` in the overlay means the worker on the owner's machine has not
  beaten for 11 minutes: start it again.

## Configuration

- `E2E_MOCK_RENDER_SECONDS` (tests only, with `E2E_MOCK_RENDER=true`): the render double
  (`apps/worker/src/render/fake-render.ts`) prints the `@hf-progress` lines of the committed render
  sample spread evenly over that many seconds, then copies the stub MP4. Unset or 0: all at once. A
  negative or non-numeric value makes the double exit with an error.
- No other setting: the 10 s throttle, the 5-minute heartbeat and the 11-minute offline threshold
  are constants.

## Testing

- Unit (`yarn test`): `apps/worker/src/progress.test.ts` (the throttle with a fake clock, rising
  values only, `stop`, a failed write), `progress-parsers.test.ts` (the three committed samples rise
  to 100, other lines give null, `partProgress`), `cutout/ensure-cutouts.test.ts` (each span's
  progress weighted by its length), `step-runner.test.ts` (throttled progress then 100 before `done`, no
  writes without a parser, no 100 on failure), `pipeline/head-track-step.test.ts` and
  `render/render-call.test.ts` (the calls carry their parser, the render env drops
  `HYPERFRAMES_STDOUT_IS_TTY`, the double is the fake-render process),
  `pipeline/run-pipeline.test.ts` (footage seconds after retime: ran, hit without a value, hit with
  one), `heartbeat.test.ts` and `disk-guard.test.ts` (beats at start and every 5 minutes, the
  heartbeat upsert's shape), `keep-awake.test.ts` (caffeinate killed on success and failure, none
  off macOS), and `apps/studio/src/lib/progress.test.ts`, `step-words.test.ts` (every step name has
  words, the fallback, `refusalReason`), `progress-overlay.test.ts` (the states' precedence, step k
  of n, the actions per failure),
  `worker-offline.test.ts`, `worker-status.test.ts`.
- DB (`yarn test:db`): `apps/studio/db-tests/steps-measurements.test.ts` (the `progress_percent`
  and `progress_updated_at` columns) and `stored-files.test.ts` (`worker_status.heartbeat_at`, and a
  heartbeat upsert keeps the disk guard's `waiting_reason`).
- E2E: `apps/studio/e2e/progress-overlay.spec.ts` (scripted step rows read in plain words with step
  k of n at 1440x900 and 390x844, clear of Play and the timeline's ruler; a version saved while
  playing replaces the preview at the same time, still playing, with `New version N`; one saved while
  paused stays paused); `progress.spec.ts`, `waiting-ai.spec.ts`, `worker-offline.spec.ts` and
  `disk-guard.spec.ts` read their lines inside `progress-overlay`;
  `progress.spec.ts` (a render job with `E2E_MOCK_RENDER_SECONDS` shows its
  percentage rising live with `no estimate yet`, and the step ends `done` at 100);
  `worker-offline.spec.ts` (a 20-minute-old `heartbeat_at` shows
  `Worker offline since HH:MM` under a queued job live, a fresh one removes it, no reload).

## Rules

- Never more than one progress write per 10 s per step (plus the final 100).
- Progress only for `head_track` and `render`.
- Never poll the database from the studio for progress, the heartbeat or the offline line: Realtime
  and local timers only.
- Never write a heartbeat from `once`.
- Never let the heartbeat clear `waiting_reason`.
- Step words live only in `step-words.ts`; an unknown step reads `Working on it`.
- Never show a raw error tail on the reel page.
- The overlay reads `LiveReel`'s one Realtime channel; never add a subscription or a poll for it.

## Notes

- Estimates are wrong for the first reels: few rows, and warm-up runs are slower.
- Not verified by the pipeline: real sleep and wake, the quality of the
  estimates.
- Owner steps: apply `supabase/migrations/20261102005505_progress_heartbeat.sql` to the hosted
  project after merge, and do the manual acceptance.
