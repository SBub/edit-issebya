# Progress, time left, ready notification, worker heartbeat and keep-awake

**Specifications:**

- specs/issue-38-adw-119c12a9-sdlc_planner-reel-progress-notification-heartbeat.md

## Overview

The two long steps, `remove_background` and `render`, write their tool's progress into their own
step row, and the studio's reel page shows the percentage with an estimate of the time left. When
the open reel becomes ready while its tab is hidden, the tab title says so and, if the owner turned
it on, the browser shows a notification. The long-running worker writes a heartbeat every five
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

### Progress parsing per tool

- `apps/worker/src/progress-parsers.ts` reads one output line at a time. A line
  `@hf-progress {...,"pct":N}` gives `N`, clamped to 0 to 100 and rounded; every other line, and a
  line whose JSON does not parse or has no finite `pct`, gives null. `parseRenderProgress` and
  `parseRemoveBackgroundProgress` are the same parser today, named per step so either can follow
  its tool later.
- `render`: HyperFrames 0.8.222's `hyperframes render`, with stdout not a terminal, prints one
  `@hf-progress` line per progress report. `renderEnv` drops `HYPERFRAMES_STDOUT_IS_TTY`, which
  set to 1 silences those lines (`apps/worker/src/render/render-call.ts`).
- `remove_background`: the pinned CLI prints no progress when nobody watches (with `--json` its
  spinner is off, and without it the unattended spinner drops every message); the per-frame events
  exist only through `onProgress` of the package's `hyperframes/api` export. So the step runs
  `apps/worker/src/pipeline/remove-background-entry.ts` with HyperFrames' own Node: it calls the
  same `removeBackground` with exactly the options the CLI passes (input, output, device, quality),
  prints one `@hf-progress {"index","total","pct"}` line per frame and, at the end, the same JSON
  result document the CLI prints under `--json`. Same function, options and model, so the step's
  version, settings and fingerprints are unchanged (`app_docs/pipeline.md`).
- `apps/worker/src/progress-testdata/render.txt` and `remove-background.txt` are committed samples
  of the real output; `apps/worker/src/progress-parsers.test.ts` replays both and expects rising
  values ending at 100.
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
- `LiveReel` shows, under a running long step with a percentage, `<n>%`
  (`data-testid="step-progress"`) and the time left (`data-testid="step-time-left"`). Both are a
  pure function of the row, so each Realtime update refreshes them; no ticking timer.

### Ready notification and title

- `apps/studio/src/components/NotifyToggle.tsx`: the "Notify me when ready" button
  (`data-testid="notify-toggle"`, "Notifications on" once on). Permission is asked only from its
  click, never on load; the choice is kept in `localStorage` (`studio-notify`). Hidden where the
  browser has no Notification API; `Notifications blocked in this browser` when permission is
  denied.
- `apps/studio/src/lib/ready-notice.ts`, `readyEvent`: the reel became ready when its status moved
  into `processed` or a new export was recorded; never on the first render.
- `apps/studio/src/components/useReadyNotice.ts`: on a ready event while the tab is hidden, the
  title becomes `Ready: <reel>` and, if the toggle is on and permission is granted, one
  `Notification` is shown (`Your reel is processed.` or `Your export is ready to download.`;
  clicking it focuses the window). The saved title comes back when the tab becomes visible. With
  the tab visible nothing happens.

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
- Under a `queued` job it shows `Worker offline since HH:MM` (24-hour local time of the last beat,
  `data-testid="job-offline"`); a fresh heartbeat arriving through Realtime removes it.

### Keep-awake

- `apps/worker/src/keep-awake.ts`, `withKeepAwake`: on macOS only, spawns
  `/usr/bin/caffeinate -i -w <worker pid>` around the job (`processJob` in
  `apps/worker/src/process-job.ts`) and kills it when the job ends, whatever the outcome. `-w` also
  ends it if the worker dies. Nothing is spawned on any other platform, and a missing `caffeinate`
  never fails the job.

## How to Use

- On a reel's page, a running `remove_background` or `render` step shows its percentage and the
  time left. The first reels show `no estimate yet` until three earlier runs of that step exist.
- Click "Notify me when ready" once and allow notifications; then switch to another tab while a
  reel processes or exports.
- `Worker offline since HH:MM` under a queued job means the worker on the owner's machine has not
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
  values only, `stop`, a failed write), `progress-parsers.test.ts` (both committed samples rise to
  100, other lines give null), `step-runner.test.ts` (throttled progress then 100 before `done`, no
  writes without a parser, no 100 on failure), `pipeline/remove-background.test.ts` and
  `render/render-call.test.ts` (the calls carry their parser, the render env drops
  `HYPERFRAMES_STDOUT_IS_TTY`, the double is the fake-render process),
  `pipeline/run-pipeline.test.ts` (footage seconds after retime: ran, hit without a value, hit with
  one), `heartbeat.test.ts` and `disk-guard.test.ts` (beats at start and every 5 minutes, the
  heartbeat upsert's shape), `keep-awake.test.ts` (caffeinate killed on success and failure, none
  off macOS), and `apps/studio/src/lib/progress.test.ts`, `ready-notice.test.ts`,
  `worker-offline.test.ts`, `worker-status.test.ts`.
- DB (`yarn test:db`): `apps/studio/db-tests/steps-measurements.test.ts` (the `progress_percent`
  and `progress_updated_at` columns) and `stored-files.test.ts` (`worker_status.heartbeat_at`, and a
  heartbeat upsert keeps the disk guard's `waiting_reason`).
- E2E: `apps/studio/e2e/progress.spec.ts` (a render job with `E2E_MOCK_RENDER_SECONDS` shows its
  percentage rising live with `no estimate yet`, and the step ends `done` at 100);
  `notification.spec.ts` (with the tab hidden, a reel turning `processed` gives one notification
  on the page's spy and the `Ready: <reel>` title, restored once visible; with the tab visible a new
  export does neither); `worker-offline.spec.ts` (a 20-minute-old `heartbeat_at` shows
  `Worker offline since HH:MM` under a queued job live, a fresh one removes it, no reload).

## Rules

- Never more than one progress write per 10 s per step (plus the final 100).
- Progress only for `remove_background` and `render`.
- Never poll the database from the studio for progress, the heartbeat or the offline line: Realtime
  and local timers only.
- Never ask for notification permission except from a click.
- No notification service: nothing works with the tab closed.
- Never write a heartbeat from `once`.
- Never let the heartbeat clear `waiting_reason`.

## Notes

- Estimates are wrong for the first reels: few rows, and warm-up runs are slower.
- Not verified by the pipeline: real macOS notifications, real sleep and wake, the quality of the
  estimates.
- Owner steps: apply `supabase/migrations/20261102005505_progress_heartbeat.sql` to the hosted
  project after merge, and do the manual acceptance.
