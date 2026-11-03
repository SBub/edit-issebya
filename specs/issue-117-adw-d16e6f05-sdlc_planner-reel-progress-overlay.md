# Feature: reel page without the Status area, a friendly progress overlay on the preview, step timings as traces with the reel's size

## Metadata

issue_number: `117`
adw_id: `d16e6f05`
issue_json: `{"number":117,"title":"reel page: remove the Status area, friendly progress overlay on the preview, step timings as traces with reel size"}`

## Feature Description

The reel page gives a large area to **Status**: machine step names and summaries
(`check_footage: footage checked, 0:52, 1080 x 1920`), the jobs list, Retry and the notification
toggle. It is useful to the owner as a developer, not as a reel maker, and it takes space from
Versions (desktop side panel under Versions, a fourth tab on a phone).

This feature:

1. Removes the Status area on desktop and on a phone (the phone keeps Edit, Versions and Library
   tabs). Versions takes the whole side panel, still scrolling in its own area, never the page.
2. Adds a small **progress overlay** in the top corner of the preview, above the player and never
   blocking it (`pointer-events: none` except its own buttons). It says in plain words what is
   happening (one mapping from step names to words, unknown names fall back to "Working on it"),
   shows how far along the job is (step k of n and a bar, plus the long step's percent and time
   left), the waiting lines (AI, disk, worker offline), "New version N" for a few seconds after a
   save, and on failure one plain line, a safe short reason and the actions that fit (Try again,
   Change the request, Keep the current version), each recording a `studio_failure_action` event
   carrying the failed `job_id`.
3. Switches the preview to a newly saved version automatically, at the same playback time and in
   the same play or pause state, with no click.
4. Moves step detail to instrumentation: the job span and every step span carry the reel's size
   (`reel.*` attributes: source seconds, bytes, width, height, retimed seconds, word count, and for
   `decide` the number of tracks items), so time can be read against size in PostHog; plus one
   saved dashboard insight "time per step against reel length".
5. Makes every failure the overlay can show exist in error tracking (production) or in a local
   JSON-lines error log (development, never PostHog), with a `decide` refusal's failed check rule
   names and round count as data, and `yarn dev:studio errors` to read the log in plain words.

## User Story

As the reel studio's owner making a reel
I want the reel page to tell me in plain words what the studio is doing, switch to a new version by
itself while I watch, and tell me what I can do when something fails
So that I keep my attention on the reel and its versions instead of a developer's step log, while
the step timings and failures still reach me as the developer through PostHog and a local log

## Problem Statement

- The Status area (`apps/studio/src/components/StatusPanel.tsx`, `data-testid="status-area"`)
  shows machine names, raw summaries and error tails, crowding Versions on desktop and costing a
  tab on a phone.
- A new version replaces the preview from 0 and paused (the preview is keyed by version and shows
  "Loading the preview" in between), so a change interrupts watching.
- A failure shows a raw error tail and one generic Retry, whatever the failure; a refused change
  request cannot be reworded from where it failed.
- Step spans carry timings but not the reel's size, so "how long does `head_track` take for a
  50-second reel" cannot be read; the `steps` table cannot be joined to the reel's length either
  (only the retimed `footage_seconds` exists).
- In development a failure is only a terminal line; a `decide` refusal's reasons are free text in
  the tail, never data that can be grouped by rule; job failures outside a step (a job-kind
  dispatch error, a missing `footage_seconds`) are not captured at all.

## Solution Statement

- **Layout:** `ReelScreen` loses its `status` prop and tab; Versions spans all three rows of the
  side column. The few owner-facing pieces of `StatusPanel` move: the notification toggle to the
  header, the progress, waiting and offline lines and Retry into the overlay; the rest (jobs list,
  step log, error tails, size and created date) is no longer shown. `steps` rows are kept as now.
- **Overlay:** a pure state function `overlayState(...)` in `apps/studio/src/lib/progress-overlay.ts`
  (fed by `LiveReel`'s existing Realtime state, no new subscription, no polling) and the words in
  one module `apps/studio/src/lib/step-words.ts`. A client component `ProgressOverlay.tsx` renders
  it in an absolutely positioned card over the top of the preview, with a polite live region and
  keyboard-reachable buttons.
- **Failure data:** a migration adds `jobs.failure_kind` (`transient`, `failed`, `answer_refused`)
  and `jobs.failure_rules` (check rule names only) written by the worker's `failJob`; the overlay
  picks its actions from them and turns rule names into plain words (never free text).
- **Auto-apply:** `ReelPreview` keeps the previous built preview playing until the next version is
  built, then mounts it with `startAt` (the last position) and `autoPlay` (the last intent);
  `PreviewPlayer` seeks and plays through its own hold-then-start routine. The player itself is
  never patched.
- **Size attributes:** a migration adds `reels.source_seconds`, `source_width`, `source_height` and
  `word_count`, written once by the worker (after `check_footage` and after `retime`, like
  `footage_seconds`). A `ReelSize` holder on `StepContext` puts `reel.*` attributes on the job span
  and every step span (including cache hits); `decide` adds `reel.tracks_items`.
- **Errors:** `AnswerRefused` (rules, rounds) rides as the cause of `decide`'s `StepError`;
  `worker: step failed` gains `failed_rules` and `rounds`; a new `worker: job failed` covers job
  failures outside a step. With the PostHog gate closed, the tracker writes the same failures as one
  JSON line each to `<WORKER_STATE_DIR or ~/.edit-issebya-worker/dev>/errors.jsonl`, rotated by
  size. `yarn dev:studio` prints the path; `yarn dev:studio errors` prints the last failures.
- **Browser errors:** `reportBrowserFailure` in `track.ts` sends a studio browser exception when
  PostHog is loaded (production) and prints to the console otherwise; the Realtime channel's
  `CHANNEL_ERROR`, `TIMED_OUT` and an unexpected `CLOSED` use it.

## Relevant Files

Use these files to implement the feature:

- `README.md`: human-facing run instructions; gets the `yarn dev:studio errors` line.
- `AGENTS.md`: repository rules (no em-dashes, migrations through `supabase migration new`, yarn
  only, root box measurement in specs).
- `.adw/project.md`: the ADW profile; its Tests section describes `reel-layout.spec.ts` ("the
  phone's Edit, Versions and Status tabs"), `step-log.spec.ts` and the specs that read the status
  panel; its Review section lists the phone tabs (Edit, Versions, Status). Update both in the same
  change, never rename or reorder its `##` headings.
- `docs/conditional-docs.md`: the doc index; the `status.md` and `studio-reel-layout.md` lines
  change.
- `app_docs/studio-reel-layout.md`: the layout, tabs and no-scroll rules this change edits.
- `app_docs/status.md`: progress, time left, notification, offline line; the overlay replaces the
  list.
- `app_docs/measurement.md`: the step runner, telemetry span attributes and `studio_*` events.
- `app_docs/error-tracking.md`: stable messages, the worker's tracker and its Rules (never the
  request text, never a cause, tests never call PostHog).
- `app_docs/failures.md`: Retry, `waiting_ai`, `failJob`, refused footage, the step double.
- `app_docs/change-requests.md`: the change box, `requestChange`, the `change` job and its refusal.
- `app_docs/preview.md`: the player wrapper rules (never patch the player, the clock never advances
  while a video cannot play, test hooks under `navigator.webdriver` only).
- `app_docs/decide-step.md`: decide's two rounds and the refusal tail.
- `app_docs/dashboard.md`: the PostHog dashboard script and its insights.
- `app_docs/studio.md`: `LiveReel`, the `reels`, `jobs`, `steps` tables and their RLS and grants.
- `apps/studio/src/components/ReelScreen.tsx`: tabs and grid; drop `status`.
- `apps/studio/src/components/LiveReel.tsx`: Realtime state; stops rendering `StatusPanel`, renders
  the overlay over the preview, moves `NotifyToggle` to the header, reports channel errors, tracks
  the new-version notice.
- `apps/studio/src/components/StatusPanel.tsx`: removed.
- `apps/studio/src/components/RetryButton.tsx`: removed (the overlay's Try again calls
  `requestRetry`).
- `apps/studio/src/components/ReelPreview.tsx`, `PreviewPlayer.tsx`: hand-off of position and play
  state across a version switch; a `data-version-id` on the player wrapper for specs.
- `apps/studio/src/components/ChangeRequestForm.tsx`: an imperative `refill(text)` handle (sets the
  text, focuses the field).
- `apps/studio/src/components/NotifyToggle.tsx`: compact header rendering (icon with
  `aria-label` under `sm`), `data-testid="notify-toggle"` kept.
- `apps/studio/src/app/retry-actions.ts`: `requestRetry`, unchanged behaviour, called from the
  overlay.
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS` and `JobRow` gain `failure_kind`, `failure_rules`.
- `apps/studio/src/lib/failures.ts`: `retryableJobIds`, `formatWaitingForAi`, used by the overlay.
- `apps/studio/src/lib/progress.ts`: `timeLeftSeconds`, `formatTimeLeft`, `isProgressStep`, reused.
- `apps/studio/src/lib/worker-offline.ts`, `worker-status.ts`: offline and disk lines, reused.
- `apps/studio/src/lib/track.ts`, `studio-events.ts`: the new event and `reportBrowserFailure`.
- `apps/studio/src/lib/reels.ts`: `formatBytes` and `formatCreatedAt` lose their reel-page caller
  (keep if the grid or another caller uses them, else remove with their tests so knip stays green).
- `apps/studio/scripts/posthog-dashboard/insights/index.ts`, `cost-per-step.ts`, `common.ts`,
  `__snapshots__/`, `dry-run.test.ts`: the new insight next to the existing SQL ones; `funnel.ts`
  reads `STUDIO_EVENTS`, which must not gain the new event.
- `apps/studio/e2e/reel-layout.spec.ts`: layout checks at 1440x900 and 390x844 (no Status area, no
  Status tab, Versions fills the panel).
- `apps/studio/e2e/step-log.spec.ts`: its only subject (the collapsed error tail on the page) is
  gone; deleted.
- `apps/studio/e2e/upload.spec.ts`, `export.spec.ts`, `footage-refusal.spec.ts`,
  `change-requests.spec.ts`, `retry.spec.ts`, `waiting-ai.spec.ts`, `worker-offline.spec.ts`,
  `disk-guard.spec.ts`, `progress.spec.ts`, `notification.spec.ts`, `reels.spec.ts`: read
  `reel-status`, `job-status`, `step-line`, `job-retry`, `job-item`; switch to database reads or to
  the overlay's elements (kept test ids: `step-progress`, `step-time-left`, `job-waiting-ai`,
  `job-waiting`, `job-offline`, `notify-toggle`, `reel-refusal`).
- `apps/studio/e2e/events.ts`: the spec helpers for `window.__capturedEvents`.
- `apps/studio/test-support/worker.ts`: the spawned `once`'s env; gains `WORKER_STATE_DIR` under
  `.e2e-storage/` so a spec never writes to the owner's home.
- `apps/studio/test-support/pipeline-cache.ts`, `versions.ts`, `ai-script.ts`, `fixtures.ts`:
  seeding a processed reel, saving a version, the broken AI answer.
- `apps/studio/db-tests/grants.test.ts`, `steps-measurements.test.ts`, `sync-columns.test.ts`,
  `pipeline-statuses.test.ts`, `dashboard-queries.test.ts`: the new columns' grants, checks and the
  new insight against the real schema.
- `apps/worker/src/step-runner.ts`: `withStep`, `recordHit`, `StepError`, `StepContext`; size
  attributes on spans, `isStepFailure`.
- `apps/worker/src/telemetry.ts`: `startJobSpan`, `endJobSpan`, `targetAttributes`.
- `apps/worker/src/error-tracking.ts`: `createErrorTracker`, `failureKind`, `scrub`, `stepFailed`,
  `crashed`; gains `jobFailed`, `failed_rules`, `rounds`, the local log tracker.
- `apps/worker/src/failure.ts`: `PermanentError`, `findCause`, `isTransient`; gains `AnswerRefused`
  and the exported `failureKind`.
- `apps/worker/src/decide/run-decide.ts`: the two rounds; collects rule names, throws `StepError`
  with an `AnswerRefused` cause; sets `reel.tracks_items`.
- `apps/worker/src/run-job.ts`: the fail path; passes kind and rules, calls `errors.jobFailed` for
  a failure that is not a step's.
- `apps/worker/src/queue.ts`: `failJob` writes `failure_kind` and `failure_rules`.
- `apps/worker/src/process-job.ts`: wires `ReelSize` into `StepContext` and `errors` into `runJob`.
- `apps/worker/src/pipeline/run-pipeline.ts`, `pipeline/footage-check.ts`: records the source
  size after `check_footage` and the word count after `retime`, next to `footage_seconds`.
- `apps/worker/src/step-store.ts`: `footageSeconds` / `recordFootageSeconds` pattern for the new
  reel columns.
- `apps/worker/src/main.ts`, `once.ts`, `config.ts`: tracker construction, `WORKER_STATE_DIR`.
- `apps/worker/.env.example`: OTEL in development, `WORKER_STATE_DIR`.
- `apps/worker/package.json`: the `dev:errors` script.
- `scripts/dev-studio.sh`: the ready block and the `errors` subcommand.
- `supabase/migrations/`: the new migration (created with `supabase migration new`).
- `turbo.json`: no change expected (the worker is run by Node directly, not through a turbo task
  that filters env); confirm `WORKER_STATE_DIR` needs no entry.
- `node_modules/next/dist/docs/`: read the client component and `useImperativeHandle`-adjacent
  guidance for Next 16 before the studio work, per `AGENTS.md`.

### New Files

- `supabase/migrations/<stamp>_failure_kind_reel_size.sql`: `jobs.failure_kind`,
  `jobs.failure_rules`, `reels.source_seconds`, `source_width`, `source_height`, `word_count`.
- `apps/studio/src/lib/step-words.ts` and `step-words.test.ts`: the one step-to-words mapping, the
  per-kind step lists, the rule-to-words mapping.
- `apps/studio/src/lib/progress-overlay.ts` and `progress-overlay.test.ts`: `jobProgress` (step k
  of n, fraction) and `overlayState` (what the overlay shows, which actions).
- `apps/studio/src/components/ProgressOverlay.tsx`: the overlay card.
- `apps/studio/e2e/progress-overlay.spec.ts`: the scripted job's words, the overlay never blocking
  the controls, and the automatic switch while playing, at 1440x900 and 390x844.
- `apps/studio/test-support/rows.ts`: `reelStatus(admin, reelId)` and `jobsOf(admin, reelId)` for
  specs that used to read the status panel.
- `apps/studio/db-tests/failure-and-size-columns.test.ts`: the new columns' checks and grants.
- `apps/studio/scripts/posthog-dashboard/insights/step-time-vs-length.ts`: the saved insight.
- `apps/worker/src/step-names.ts` and `step-names.test.ts`: every step name the worker runs, one
  list, checked against the modules' own constants.
- `apps/worker/src/reel-size.ts` and `reel-size.test.ts`: `ReelSize`, `readReelSize`,
  `reelSizeAttributes`.
- `apps/worker/src/dev-error-log.ts` and `dev-error-log.test.ts`: the local JSON-lines log
  (append, rotate, scrub) and `formatLastFailures` for the `errors` subcommand.
- `apps/worker/src/dev-errors.ts`: the tiny entry point behind `yarn workspace @edit-issebya/worker
dev:errors` (prints `formatLastFailures` of the log).

## Implementation Plan

### Phase 1: Foundation

- Database: one migration with the failure and size columns, its DB test, and the grants.
- Worker data: the step name list, `AnswerRefused` and `failureKind`, `failJob` writing the kind and
  rules, the reel size columns written once.
- Studio data: `JOB_COLUMNS` gains the two columns; the step-words and overlay-state modules with
  their unit tests (pure, no UI yet).

### Phase 2: Core Implementation

- Studio: `ProgressOverlay`, the layout without the Status area, the header's notify toggle, the
  change box's refill handle, the preview's hand-off on a version switch, the failure action events
  and `reportBrowserFailure`.
- Worker: `reel.*` span attributes, `failed_rules` and `rounds` on `worker: step failed`,
  `worker: job failed`, the local error log and rotation, `dev:errors`.

### Phase 3: Integration

- `scripts/dev-studio.sh` ready block and `errors` subcommand; `.env.example` for OTEL in
  development; the dashboard insight.
- E2E: the new overlay spec, the layout spec, and every spec that read the old panel.
- Docs: the six feature docs, the index, `README.md` and `.adw/project.md`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before changing

- Read `app_docs/studio-reel-layout.md`, `status.md`, `measurement.md`, `error-tracking.md`,
  `failures.md`, `change-requests.md`, `preview.md` (Rules), `decide-step.md`, `dashboard.md`.
- Read the Next 16 guides under `node_modules/next/dist/docs/` that cover client components and
  server actions called from them.
- Check how `jobs`, `steps` and `reels` are granted to `authenticated` today
  (`grant select on public.jobs, public.steps to authenticated` in
  `supabase/migrations/20261031174750_job_queue.sql`, `grant select on public.reels` in
  `20261031105245_studio_skeleton.sql`, and any later column-level grants) and what
  `apps/studio/db-tests/grants.test.ts` pins, so the new columns follow the same rule.

### 2. Migration: failure kind and reel size

- Create it with `supabase migration new failure_kind_reel_size` (never hand-stamp a version).
- `alter table public.jobs add column failure_kind text`, `add column failure_rules text[]`;
  constraints:
  - `jobs_failure_kind_check`: `failure_kind is null or failure_kind in ('transient', 'failed',
'answer_refused')`.
  - `jobs_failure_state_check`: `failure_kind is null or status = 'failed'` (old failed rows keep
    null).
  - `jobs_failure_rules_check`: `failure_rules is null or (failure_kind = 'answer_refused' and
cardinality(failure_rules) between 1 and 20)`.
- `alter table public.reels add column source_seconds numeric check (source_seconds > 0)`,
  `source_width integer check (source_width > 0)`, `source_height integer check (source_height >
0)`, `word_count integer check (word_count >= 0)`.
- Grants: owners read the job columns the way they read the rest of `jobs` (table-level select
  covers them; if a column-level grant is in force, grant select on the two new columns to
  `authenticated`). Owners never get insert or update on any new column: the column-limited insert
  grant on `jobs` stays as it is, so a Retry insert cannot set a failure kind. The worker writes
  through `service_role`. No new table, so no new role grant set is needed.
- The Realtime publication already carries both tables; nothing to add.
- Run `.adw/supabase-stack reset` afterwards (the only Supabase command besides `migration new`).

### 3. DB test for the new columns

- New `apps/studio/db-tests/failure-and-size-columns.test.ts`: a `failure_kind` outside the three
  values is refused; a kind on a non-failed job is refused; rules without `answer_refused` or with
  0 or 21 entries are refused; non-positive `source_seconds`, width, height and a negative
  `word_count` are refused; an owner (`authenticated`) can read `failure_kind` and `failure_rules`
  of their own job and cannot update them, nor the four reel columns.
- Update `steps-measurements.test.ts` only if it pins `jobs` or `reels` column sets too (it pins
  `steps`, which does not change), `grants.test.ts` and `sync-columns.test.ts` if they enumerate
  columns.

### 4. Worker: the step name list

- New `apps/worker/src/step-names.ts`: `export const STEP_NAMES = ["check_footage", "convert",
"transcribe", "retime", "head_track", "preview_copies", "first_version", "decide", "cutout",
"restore", "render", "describe_photo", "photo_images"] as const` (confirm against the code: the
  `PIPELINE` names in `pipeline/definition.ts`, the `STEP` constants of `first-version.ts`,
  `decide/run-decide.ts`, `restore-step.ts`, `render/render-step.ts`, `cutout/ensure-cutouts.ts`,
  `photos/describe-photo.ts`, `photos/photo-images.ts`). One name per line, double quotes, so the
  studio's test can read the file as text.
- Export each module's step name constant where it is not exported yet.
- `step-names.test.ts`: every `PIPELINE` step's name and every module constant is in
  `STEP_NAMES`, and `STEP_NAMES` has no name no module uses.

### 5. Worker: `AnswerRefused`, `failureKind` and the job's failure columns

- `apps/worker/src/failure.ts`: `export class AnswerRefused extends PermanentError` with
  `readonly rules: string[]` and `readonly rounds: number` (message `the answer failed the checks`,
  no free text). Move `failureKind` here from `error-tracking.ts` and export it: `FootageRefused`
  gives `refused`, `AnswerRefused` gives `answer_refused`, else `transient` or `failed` by
  `isTransient`. `error-tracking.ts` imports it.
- `apps/worker/src/decide/run-decide.ts`: each `Attempt` failure carries `rules: string[]`
  beside its `reasons`: a check's `check.rule` (`safe-box`, `frame`, `behind-face`,
  `behind-caption`, `face`, `sound-gap`, `time-in-speech`, `out-of-reel`, `glossary`); a broken
  answer `answer-json`; a `parseDecideAnswer` refusal `answer-schema`; an `editFromAnswer`
  refusal `answer-edit`. On the second refusal throw the same `StepError(tail, tail, usage)` with
  `cause = new AnswerRefused(uniqueSortedRulesOfBothRounds, 2)`. The tail text is unchanged.
- `apps/worker/src/queue.ts`: `failJob(db, config, job, errorTail, failure)` where `failure` is
  `{ kind: "transient" | "failed" | "answer_refused"; rules: string[] | null }`; it writes
  `failure_kind` and `failure_rules` in the same update as `status` and `error_tail`. `refuseJob`
  (footage) writes no kind: the reel's refusal is its own state.
- `apps/worker/src/run-job.ts`: `fail: (tail: string, failure: JobFailure) => Promise<boolean>`;
  the fail path computes `failure` from the error (`failureKind`, rules from
  `findCause(error, AnswerRefused)`). It also takes `errors: Pick<ErrorTracker, "jobFailed">` and
  calls `errors.jobFailed({ job, error, tail, failure })` when `isStepFailure(error)` is false (a
  failure outside any step: no step capture happened). The `job <id>: failed: ...` log line stays
  exactly as it is.
- `apps/worker/src/step-runner.ts`: `export function isStepFailure(error: unknown): boolean`
  (walks the cause chain for the internal `StepFailure`).
- `apps/worker/src/process-job.ts`: pass `errors` to `runJob` and the failure to `failJob`.
- Unit tests: `failure.test.ts` (`failureKind` for each class, through a cause chain),
  `run-decide.test.ts` (a twice-refused answer throws with `AnswerRefused` rules from both rounds,
  `behind-caption` and `safe-box` for example, and the tail unchanged), `queue.test.ts` (`failJob`
  writes the kind and rules), `run-job.test.ts` (the failure passed to `fail`, `jobFailed` only for
  a non-step failure, the log line unchanged).

### 6. Worker: the reel's size, recorded once and on every span

- `apps/worker/src/step-store.ts`: `recordSourceSize(reelId, { seconds, width, height })` and
  `recordWordCount(reelId, count)`, each writing only while the column is null (the
  `footage_seconds` pattern).
- `apps/worker/src/pipeline/footage-check.ts` / `run-pipeline.ts`: after an accepted
  `check_footage`, record the probe's duration and display width and height. After `retime` (ran or
  hit), next to `footage_seconds`, record the word count from the transcript the retime reads
  (`transcript.json`'s words; a missing transcript records nothing, never fails the job).
- New `apps/worker/src/reel-size.ts`:
  - `interface ReelSize { sourceSeconds, sourceBytes, width, height, footageSeconds, wordCount }`
    (all `number | null`).
  - `readReelSize(db, reelId)`: one select of `source_bytes, source_seconds, source_width,
source_height, footage_seconds, word_count` (named columns).
  - `reelSizeAttributes(size)`: `reel.source_seconds`, `reel.source_bytes`, `reel.width`,
    `reel.height`, `reel.footage_seconds`, `reel.word_count`, skipping nulls.
  - `createReelSizeHolder(initial)`: `current()` and `update(partial)`, so values learned during a
    job (the probe, the retime) reach the later spans.
- `StepContext` gains `size?: ReelSizeHolder` (optional: photo jobs and unit tests have none).
  `withStep` and `recordHit` set `reelSizeAttributes(ctx.size.current())` at span start and again
  before the span ends; `startJobSpan` / `endJobSpan` do the same on the job span.
  `processJob` reads the size once at job start for a job with a `reel_id`, and the pipeline
  updates the holder when it records the new values.
- `decide`: after a version is saved, set `reel.tracks_items` (the saved edit's item count over
  every track) on the step's span through the step body's context (`trace.getSpan(stepContext)`).
- Unit tests: `reel-size.test.ts` (attributes from a full and a partial size, nulls skipped),
  `telemetry.test.ts` and `step-runner.test.ts` (with the in-memory exporter the tests already use:
  the job span and a step span carry the `reel.*` attributes; a value updated mid-job reaches the
  next step's span; a cache-hit span carries them too), `run-pipeline.test.ts` (source size after
  `check_footage`, word count after `retime`, neither written twice), `run-decide.test.ts`
  (`reel.tracks_items` on the decide span).

### 7. Worker: error tracking and the local error log

- `apps/worker/src/error-tracking.ts`:
  - `stepFailed` adds `failed_rules` (the `AnswerRefused` rules, else null) and `rounds` (else
    null). Still never `job.request` or any free text beyond the scrubbed tail.
  - New `jobFailed({ job, error, tail, failure })`: `worker: job failed` with `app`, `job_kind`,
    `reel_id`, `photo_id`, `job_id`, `failure_kind`, `error_code`, `error_tail` (scrubbed, last
    1000), `distinct_id` the owner. A new stable message, added to the doc's table.
  - The gate: with both PostHog variables set, the PostHog tracker as now. Without them, a local
    tracker (`localErrorLogTracker`) built from `apps/worker/src/dev-error-log.ts` is the
    closed-gate tracker: it sends nothing (`enabled` stays false) and appends each `stepFailed`,
    `jobFailed` and `crashed` as one line. Every test that builds a tracker without the variables
    sets `WORKER_STATE_DIR` to a temporary folder; tests that need no tracker keep passing
    `DISABLED_TRACKER`.
- New `apps/worker/src/dev-error-log.ts`:
  - `errorLogPath(env)`: `join(env.WORKER_STATE_DIR?.trim() || join(homedir(), ".edit-issebya-worker",
"dev"), "errors.jsonl")`.
  - `appendErrorLine(path, line)`: creates the folder, rotates when the file is at or above
    `MAX_LOG_BYTES` (2 MiB) by renaming it to `errors.1.jsonl` (replacing the older one, so at most
    about 4 MiB stay), then appends one JSON line. Synchronous, inside try/catch: a log that cannot be
    written prints one `worker: error log not written: <code>` line and never breaks the job.
  - The line: `time` (ISO), `job_id`, `job_kind`, `reel_id` or `photo_id`, `step` (null for a job
    failure or a crash), `attempt`, `failure_kind` (`uncaught` for a crash), `message` (the first
    line of the tail, scrubbed with the same `scrub`, at most 300 characters), and for
    `answer_refused` `rules` and `rounds`. Never the request text, never env values.
  - `formatLastFailures(path, count = 10)`: reads the current and rotated file, newest last, and
    prints one plain line per failure, for example
    `14:02 decide (change, job 1a2b...): the AI's answer failed twice; rules behind-caption, safe; 2 rounds`,
    or `No failures logged in <path>.` when empty or missing.
- New `apps/worker/src/dev-errors.ts`: prints `errorLogPath` and `formatLastFailures`; script
  `"dev:errors": "node --env-file-if-exists=.env.development src/dev-errors.ts"` in
  `apps/worker/package.json`.
- `apps/studio/test-support/worker.ts`: set `WORKER_STATE_DIR` to a folder under the gitignored
  `.e2e-storage/` (for example `.e2e-storage/worker-state/`) for every spawned `once`, next to the
  blanked `POSTHOG_PROJECT_TOKEN`, so a spec never writes to the owner's home.
- Unit tests:
  - `error-tracking.test.ts`: with the PostHog variables and a fake client, a `decide` refusal
    (`StepError` with an `AnswerRefused` cause) captures `worker: step failed` with
    `failure_kind: "answer_refused"`, `failed_rules`, `rounds: 2` and no `request` text anywhere in
    the properties (the job has a request); `jobFailed` captures `worker: job failed`. Without the
    variables and with `WORKER_STATE_DIR` in a temp folder, the same refusal writes exactly one line
    to `errors.jsonl` with the rule names and rounds and no request text, and no client is built.
  - `dev-error-log.test.ts`: rotation at the size limit keeps one older file, a secret-shaped string
    in a tail is redacted, an unwritable folder does not throw, `formatLastFailures` prints the last
    lines in plain words and the empty message.

### 8. Development tooling: `yarn dev:studio`, `.env.example`, README

- `scripts/dev-studio.sh`:
  - The ready block gains `Worker errors:  <path> (yarn dev:studio errors)`, the path computed the
    same way as `errorLogPath` (`${WORKER_STATE_DIR:-$HOME/.edit-issebya-worker/dev}/errors.jsonl`).
  - A new case `errors) yarn workspace @edit-issebya/worker dev:errors ;;` and the usage line in the
    header comment and the unknown-argument message.
  - Bash 3.2 compatible, as the rest of the script.
- `apps/worker/.env.example` (names and placeholders only):
  - Under the OTEL block, a comment: filling `OTEL_EXPORTER_OTLP_ENDPOINT` and
    `OTEL_EXPORTER_OTLP_HEADERS` in `.env.development` exports development traces and logs to the
    same PostHog project; set `OTEL_SERVICE_NAME=edit-issebya-worker-dev` there to tell them apart.
    `POSTHOG_PROJECT_TOKEN` stays empty in development (error tracking is production only).
  - `WORKER_STATE_DIR=` with a comment: where the development error log lives (default
    `~/.edit-issebya-worker/dev`), used only while `POSTHOG_PROJECT_TOKEN` is empty.
- `README.md`: one line under the `yarn dev:studio` commands:
  `yarn dev:studio errors            # the worker's last failures in development, in plain words`.
- No test for the shell lines beyond `bash -n`: the script is the owner's command (never run in a
  run); its logic lives in `dev-error-log.ts`, which is unit tested.

### 9. Studio: data and the two pure modules

- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS` gains `failure_kind, failure_rules`; `JobRow`
  gains `failure_kind: "transient" | "failed" | "answer_refused" | null` and
  `failure_rules: string[] | null`.
- New `apps/studio/src/lib/step-words.ts`, the one place for the words:
  - `STEP_WORDS: Record<string, { doing: string; failed: string }>`: `check_footage` "Checking
    your video" / "Could not finish checking your video"; `convert` "Preparing your video";
    `transcribe` "Listening to your words"; `retime` "Tightening the pace"; `head_track` "Finding
    your face"; `preview_copies` "Making the preview"; `first_version` "First version"; `decide`
    "Styling your reel" / "Could not finish styling"; `cutout` "Cutting you out for the photo";
    `restore` "Going back to version N" (N filled by `stepWords(name, { restoreNumber })`);
    `render` "Exporting"; `describe_photo` and `photo_images` (photo jobs, not shown on the reel
    page) "Describing your photo" and "Preparing your photo". A `change` job's `decide` reads
    "Styling your reel" too.
  - `stepWords(name, context)`: the entry, or `{ doing: "Working on it", failed: "Could not finish
this step" }` for an unknown name.
  - `JOB_STEPS: Record<JobKind, readonly string[]>`: `process` = check_footage, convert,
    transcribe, retime, head_track, preview_copies, first_version, decide; `change` = decide;
    `restore` = restore; `render` = render. `cutout` counts as part of `decide`.
  - `RULE_WORDS`: plain words per check rule (`behind-caption` "a photo would cover your
    captions", `behind-face` "a photo would cover your face", `safe-box` "something would sit
    outside the safe area", `frame` "something would leave the frame", `face` "something would
    cover your face", `sound-gap` "two sounds would play too close together", `time-in-speech` "an
    accent would land outside your words", `out-of-reel` "something would run past the end",
    `glossary` "a word would be spelled differently from your glossary", `answer-json`,
    `answer-schema` and `answer-edit` "the AI's answer could not be used"). `refusalReason(rules)`:
    the first two distinct words joined with "and", capitalised, or null when no rule is known.
- New `apps/studio/src/lib/progress-overlay.ts`:
  - `jobProgress(job, steps)`: the job's own steps (by `job_id`), the running (or last) step's
    name, `index` (1-based position in `JOB_STEPS[job.kind]`, `cutout` as `decide`), `total`, and
    `fraction` = (list steps `done` or `skipped`, plus the running long step's
    `progress_percent / 100`) / total, clamped to 0..1. A step not in the list keeps the last known
    index. A queued job: index 0, fraction 0.
  - `overlayState({ reel, jobs, steps, versionsById, waitingReason, offline, now, notice,
dismissed, estimateRates })` returns one of:
    - `{ kind: "failure", jobId, jobKind, step, headline, reason, actions }` for the newest
      finished job when it is `failed`, not dismissed, not retried (`retryableJobIds`), the reel
      not `refused`, and no newer job exists. Actions: `change_request` when the kind is `change`,
      `failure_kind === "answer_refused"` and the job has a `request`; `try_again` for every other
      retryable failure (transient, failed, an older row with no kind, and a refused `process`
      decide); `keep_current` always. `reason`: `refusalReason(failure_rules)` for an
      `answer_refused`, else null (no raw tail is shown).
    - `{ kind: "notice", text: "New version N" }` while `notice` is set (below).
    - `{ kind: "working", words, index, total, fraction, percent, timeLeft, waitingAi,
waitingDisk, offline }` for the oldest live job (`queued`, `running`, `waiting_ai`): a queued
      job reads "Waiting to start" with the disk and offline lines; `waiting_ai` reads its step's
      words with `formatWaitingForAi`; a running long step adds percent and `formatTimeLeft`.
    - `{ kind: "hidden" }` otherwise.
      Precedence: failure, then notice, then working, then hidden.
- Unit tests:
  - `step-words.test.ts`: reads `apps/worker/src/step-names.ts` as text (like
    `migration-versions.test.ts` reads `supabase/migrations/`), parses the quoted names, and expects
    every one to have its own entry (not the fallback); an unknown name falls back to "Working on
    it"; `restore` fills N; every `JOB_STEPS` name is a worker step name; every rule in
    `RULE_WORDS` maps and an unknown rule gives null.
  - `progress-overlay.test.ts`: `jobProgress` for a process job at `convert` (2 of 8), at
    `head_track` with 50 percent (fraction includes the half step), at `cutout` (shown as decide's
    index), queued (0), all done (1); `overlayState` precedence, a refused change offering
    `change_request` and `keep_current` with the plain reason, a transient failure offering
    `try_again`, a refused reel showing no failure, a dismissed or retried failure hidden, a newer
    done job hiding an older failure, the waiting and offline lines.

### 10. Studio: the overlay component

- New `apps/studio/src/components/ProgressOverlay.tsx` (client):
  - Props: the `overlayState` result, `reelId`, `onTryAgain`, `onChangeRequest`, `onKeep`.
  - Markup: a card `data-testid="progress-overlay"` with `data-overlay-kind`, absolutely
    positioned in the top-left of the preview (`absolute left-2 top-2 right-2 sm:right-auto
sm:max-w-xs`), `pointer-events-none`; its buttons alone `pointer-events-auto`. A polite live
    region (`role="status" aria-live="polite"`) holds the words and the lines; buttons sit outside
    it so they are not re-announced.
  - Working: the words (`data-testid="overlay-words"`), `Step k of n`, a bar
    (`role="progressbar"`, `aria-valuemin=0`, `aria-valuemax=100`, `aria-valuenow`), and when
    present `step-progress` (percent), `step-time-left`, `job-waiting-ai`, `job-waiting`,
    `job-offline` (the test ids kept from `StatusPanel`).
  - Notice: "New version N" (`data-testid="overlay-notice"`).
  - Failure: the headline (`overlay-headline`), the reason (`overlay-reason`) when present, then
    the action buttons with plain labels: "Try again" (`overlay-try-again`), "Change the request"
    (`overlay-change-request`), "Keep the current version" (`overlay-keep`), native `<button>`s in
    tab order; a short answer line for Try again (`overlay-action-message`: "Queued again.", "This
    job is already being retried.", "Retry did not start. Try again.").
  - Hidden: renders nothing.
- `LiveReel.tsx`:
  - Computes `overlayState` from its existing state; holds `dismissed: Set<string>` (memory only:
    a reload shows a still-unhandled failure again) and the `notice` (set when
    `current_version_id` changes after the first render, to the new version's number, cleared by
    one `setTimeout` of `NEW_VERSION_NOTICE_MS = 4000`; never on the first render).
  - Try again: calls `requestRetry({ reelId, jobId })` as `RetryButton` did (signed-out refreshes the
    router) and captures `studio_failure_action` with `{ reel_id, job_id, action: "try_again",
failure_kind, step, job_kind }`.
  - Change the request: `changeFormRef.current.refill(job.request)`, marks the failure dismissed,
    captures `action: "change_request"`. On a phone the change field is the pinned footer, always
    visible.
  - Keep the current version: marks dismissed, captures `action: "keep_current"`.
  - Wraps `ReelPreview` in a `relative` container and renders the overlay inside it.
  - The Realtime channel: `channel.subscribe((status) => ...)`; on `CHANNEL_ERROR`, `TIMED_OUT`, or
    `CLOSED` while still active, `reportBrowserFailure("studio: realtime channel dropped", {
reel_id, status })` once per status change.
  - Moves `<NotifyToggle />` into the header between the name and Export.
  - Drops `StatusPanel`, its props and what only it used (`estimateRates` goes to the overlay).
- `ChangeRequestForm.tsx`: `forwardRef` / `useImperativeHandle` with `refill(text)`: sets the
  text, clears the message, focuses the textarea and puts the caret at the end.
- `NotifyToggle.tsx`: a compact rendering for the header (under `sm` an icon button with
  `aria-label="Notify me when ready"`, the text from `sm` up), behaviour and test id unchanged.
- `apps/studio/src/lib/studio-events.ts`: keep `STUDIO_EVENTS` (the funnel's series) as it is and
  add `STUDIO_ACTION_EVENTS = ["studio_failure_action"] as const`;
  `StudioEvent = (typeof STUDIO_EVENTS)[number] | (typeof STUDIO_ACTION_EVENTS)[number]`.
- `apps/studio/src/lib/track.ts`: `reportBrowserFailure(message, properties)`: when PostHog is
  loaded, `captureException`; otherwise `console.error(message, properties)`. Under
  `navigator.webdriver` the test hook records it as now.
- Delete `StatusPanel.tsx` and `RetryButton.tsx`; remove now-unused exports (`formatBytes`,
  `formatCreatedAt` only if nothing else uses them) with their tests so knip passes.
- Unit tests: `track.test.ts` (`reportBrowserFailure` captures when loaded, prints to the console
  when not, the test hook records it; `studio_failure_action` goes through `capture` with its
  `job_id`), and the dashboard `dry-run.test.ts` still expects the funnel to equal `STUDIO_EVENTS`.

### 11. Studio: the layout without the Status area

- `ReelScreen.tsx`: `TABS` = Edit, Versions, Library (arrows, Home, End wrap over three); no
  `status` prop, no `status-area`; Versions on desktop
  `lg:col-start-2 lg:row-span-3 lg:row-start-1 lg:border-l lg:border-line`, still `min-h-0
overflow-y-auto overscroll-contain`. Update the component comment.
- Check the grid still fills the root box at `lg` and `xl` with no page scroll.

### 12. Studio: the automatic version switch at the same time and state

- `PreviewPlayer.tsx`: new props `startAt?: number` and `autoPlay?: boolean`, and
  `onIntent?: (intent: "paused" | "playing") => void` reported wherever the intent changes. Once
  the player is ready for this version, seek to `min(startAt, duration)` and, when `autoPlay`, start
  through the existing `holdThenStart` (so the clock still never advances before the videos can
  play from there, and sounds are scheduled from that playhead). Add `data-version-id={versionId}`
  and `data-intent={intent}` on the wrapper element for specs. No change to the player itself.
- `ReelPreview.tsx`:
  - Keep the last built preview mounted while the next version loads (render the previous
    `Built` until the new outcome arrives, instead of "Loading the preview"); a message outcome
    for the new version still replaces it.
  - A ref holds `{ position, intent }` from the mounted player's `onPosition` and `onIntent`; the
    next `BuiltPreview` (still keyed by version) gets `startAt` and `autoPlay` from it. The first
    open starts at 0, paused. The same hand-off applies to an Undo or Redo switch.
  - `studio_preview_opened` stays once per page open.
- Verify `app_docs/preview.md` Rules hold: no player patch, one builder, no polling.

### 13. PostHog insight: time per step against reel length

- New `apps/studio/scripts/posthog-dashboard/insights/step-time-vs-length.ts`, modelled on
  `cost-per-step.ts`: a `SqlInsight` `step-time-vs-length`, "Studio: time per step against reel
  length", over the synced `steps` joined to `reels` on `reel_id`: per step name and source length
  bucket (`floor(reels.source_seconds / 15) * 15`), the count, median and max `wall_ms / 1000`, and
  the median seconds per retimed footage second (`wall_ms / 1000 / reels.footage_seconds`), done
  rows only. Register it in `insights/index.ts`, update the dry-run snapshot.
- `dashboard-queries.test.ts` renders it against the real schema (the new reel columns exist after
  the migration).
- The owner runs `--apply` from their shell; ADW never does.

### 14. E2E: the new overlay spec

- New `apps/studio/e2e/progress-overlay.spec.ts` (serial, modelled on `reel-layout.spec.ts` and
  `preview.spec.ts`; `claimableJobIds` guard in `beforeAll`; cleanup in `afterAll`):
  - Seeds a processed reel with `seedProcessedReel`.
  - **Scripted job, both viewports (1440x900 and 390x844):** inserts with the admin client a
    `running` `change` job whose lease is held by a fake worker id far in the future (never
    claimable), then a `running` `convert` step row: the overlay shows "Preparing your video" and
    a progress bar; updating that row `done` and inserting a `running` `decide` row: "Styling your
    reel". At both sizes the overlay's box lies inside the preview and above the Play button and
    Position slider (no intersection, measured with `boundingBox()`), a click on the Play button
    works while the overlay shows, and the page does not scroll (root box). Ends the job `done`.
  - **Automatic switch while playing (1440x900):** press Play, wait until the player's
    `currentTime` passes 2 seconds, save a new version with `saveTestVersion` and set
    `reels.current_version_id` to it (admin); expect the wrapper's `data-version-id` to become the
    new id, `data-intent` to stay `playing` (button reads "Pause"), the new player's `currentTime`
    to be at least the time read just before the save minus 0.5 s (not back to 0), and
    "New version 3" in the overlay, gone after a few seconds. A second case with the preview paused
    keeps it paused.
  - Event hook (`window.__capturedEvents`): no `studio_failure_action` in these cases.
- Fails without the feature: no overlay, and the switch restarts at 0 paused.

### 15. E2E: the layout spec and every spec that read the Status area

- `reel-layout.spec.ts`: no `status-area` and no `step-line` at both sizes; at 1440x900 the
  versions area's height equals the side column's height (from the header's bottom to the root
  box's bottom, within 1 px) and its list scrolls inside it; at 390x844 the tablist has exactly Edit,
  Versions and Library, arrows wrap over three. Keep every other check (timeline, playhead, Undo and
  Redo, no page scroll). Its seeded 48 steps stay (they prove nothing shows them).
- `change-requests.spec.ts`: replace `job-status` / `reel-status` reads with
  `test-support/rows.ts` database reads; after the twice-refused change (`brokenAnswerScript`), the
  job has `failure_kind = 'answer_refused'` and `failure_rules` containing `answer-json` (or the
  rules the script triggers), and the overlay shows "Could not finish styling", its plain reason,
  "Change the request" and "Keep the current version" and no "Try again". Clicking "Change the
  request" puts the sent request back in the field, focused (`toBeFocused`), and records one
  `studio_failure_action` with `action: "change_request"` and that job's `job_id`.
- `retry.spec.ts`: Retry is now the overlay's "Try again" (`overlay-try-again`): after the
  signal-killed `transcribe` fails the job (`failure_kind = 'transient'`), the overlay shows
  "Could not finish listening to your words" and "Try again"; clicking it inserts the job with
  `retry_of_job_id` (database read), records `studio_failure_action` with `action: "try_again"`
  and the failed `job_id`, and the resumed job ends `done` as before. Job and reel statuses through
  `rows.ts`.
- `footage-refusal.spec.ts`: keep `reel-refusal`; no overlay failure and no `overlay-try-again`;
  `reel-status`, `job-status` and `step-line` through `rows.ts` (one `check_footage` row).
- `upload.spec.ts`, `export.spec.ts`, `notification.spec.ts`, `reels.spec.ts`: `reel-status`,
  `job-status`, `step-line` through `rows.ts` (step summaries are checked in the `steps` rows, as
  their format still matters for PostHog). `notification.spec.ts`'s toggle is now in the header.
- `progress.spec.ts`: `step-progress` and `step-time-left` are read inside `progress-overlay`
  (with "Exporting" as its words); `step-line` through `rows.ts`.
- `waiting-ai.spec.ts`, `worker-offline.spec.ts`, `disk-guard.spec.ts`: `job-waiting-ai`,
  `job-offline`, `job-waiting` inside `progress-overlay`; the `job-item` scoping goes; statuses
  through `rows.ts`.
- Delete `step-log.spec.ts` (the page no longer shows a step's error tail; the tail is still
  written to the row, unit tested in `step-runner.test.ts`).
- New `apps/studio/test-support/rows.ts` with the small admin reads these specs share.
- Run a grep afterwards: no spec references `status-area`, `step-line`, `job-status`,
  `reel-status`, `job-item` or `job-retry`.

### 16. Documentation

- `app_docs/studio-reel-layout.md`: no Status area; three phone tabs; Versions spans the side
  column; the overlay's position and that it never blocks the controls; testing lines; Rules gain
  "The overlay never blocks the player's controls: `pointer-events` off except its own buttons."
- `app_docs/status.md`: rename the title to include the overlay; the overlay replaces the jobs and
  step list (states, precedence, step k of n, the words module, the actions and their event, the
  new-version notice and the automatic switch, the live region); the percent and time left, the
  waiting and offline lines now live in the overlay; Rules keep "never poll" and add "Step words
  live only in `step-words.ts`; an unknown step reads `Working on it`." and "Never show a raw
  error tail on the reel page."
- `app_docs/measurement.md`: the `reel.*` attributes on job and step spans and
  `reel.tracks_items` on `decide`; the four new reel columns; OTEL in development
  (`OTEL_SERVICE_NAME=edit-issebya-worker-dev`); the `studio_failure_action` event row
  (`reel_id`, `job_id`, `action`, `failure_kind`, `step`, `job_kind`, `app`); remove the
  `LiveReel` step-line bullet; a short "Reading time per step against reel length" note naming the
  insight and the SQL it runs (steps joined to reels).
- `app_docs/error-tracking.md`: `worker: step failed` gains `failed_rules`, `rounds` and the
  `answer_refused` kind; the new `worker: job failed` row; `studio: realtime channel dropped`
  (browser); the local development error log (path, line fields, rotation, never secrets or
  request text, `yarn dev:studio errors`); the overlay actions' `job_id` link; production only for
  PostHog. Rules keep every existing "never".
- `app_docs/failures.md`: Retry is the overlay's Try again (when it is offered and why), the
  `failure_kind` and `failure_rules` columns written by `failJob`.
- `app_docs/change-requests.md`: a refused change offers "Change the request", which puts the
  request back in the field.
- `app_docs/dashboard.md`: the new insight.
- `app_docs/studio.md`: `LiveReel` no longer renders a status panel; the new `jobs` and `reels`
  columns.
- `docs/conditional-docs.md`: the `status.md` line names the progress overlay, `step-words.ts`,
  `progress-overlay.ts`, the automatic version switch; the `studio-reel-layout.md` line drops the
  phone's Status tab; the `error-tracking.md` line names the local development error log.
- `.adw/project.md`: in Tests, the `reel-layout.spec.ts` description (Edit, Versions and Library
  tabs, no steps area), remove `step-log.spec.ts`, add `progress-overlay.spec.ts`, the
  `failure-and-size-columns.test.ts` DB test, and the specs whose status reads moved; in Review,
  "on 390x844 the reel page once per tab (Edit, Versions, Library)" and the overlay. Headings
  untouched.
- `README.md`: the `yarn dev:studio errors` line (step 8).
- No em-dashes anywhere.

### 17. Run the Validation Commands

- Run every command below from the root and fix whatever fails, without weakening a test or a rule.

## Testing Strategy

### Unit Tests

- Studio (`yarn turbo run test --filter=./apps/studio`): `step-words.test.ts` (every worker step
  name has words, the fallback, `restore`'s N, rule words), `progress-overlay.test.ts` (step k of
  n, the fraction with a long step's percent, state precedence, actions per failure kind, hidden
  cases), `track.test.ts` (`reportBrowserFailure`, the action event's `job_id`), the dashboard
  `dry-run.test.ts` snapshot with the new insight and the unchanged funnel.
- Worker (`yarn turbo run test --filter=./apps/worker`): `step-names.test.ts`, `failure.test.ts`,
  `run-decide.test.ts` (rules and rounds, `reel.tracks_items`), `queue.test.ts`, `run-job.test.ts`,
  `reel-size.test.ts`, `telemetry.test.ts` and `step-runner.test.ts` (`reel.*` on job, step and hit
  spans), `run-pipeline.test.ts` (source size, word count, written once), `error-tracking.test.ts`
  (PostHog with rules and no request text; the local line when the variables are unset; `jobFailed`),
  `dev-error-log.test.ts` (rotation, scrub, unwritable folder, plain-words output).
- DB (`yarn turbo run test:db --filter=./apps/studio`): `failure-and-size-columns.test.ts`.

### Test Coverage

- `apps/studio/src/lib/step-words.test.ts` (unit): catches a worker step with no plain words, or a
  mapping that drifts from the worker's names; nothing checks this today.
- `apps/studio/src/lib/progress-overlay.test.ts` (unit): catches a wrong step k of n, a wrong
  fraction, or the wrong actions for a failure (Try again on a refused change, a failure shown on
  a refused reel); no overlay exists today.
- `apps/worker/src/telemetry.test.ts` / `step-runner.test.ts` additions (unit): catch job and step
  spans without the `reel.*` size attributes; today they carry none.
- `apps/worker/src/error-tracking.test.ts` and `dev-error-log.test.ts` (unit): catch a `decide`
  refusal captured without its rule names (or with request text), and a development failure that
  writes no local line or an unrotated log; neither exists today.
- `apps/worker/src/run-decide.test.ts`, `run-job.test.ts`, `queue.test.ts` (unit): catch rules not
  reaching the job's `failure_rules`, and a job failure outside a step not captured.
- `apps/studio/src/lib/track.test.ts` (unit): catches an overlay action event without the failed
  `job_id` and a browser failure not reported.
- `apps/studio/db-tests/failure-and-size-columns.test.ts` (DB): catches missing checks or an owner
  able to write the worker's failure and size columns.
- `apps/studio/e2e/progress-overlay.spec.ts` (E2E): catches a missing or blocking overlay, the
  wrong words for a scripted job, and a version switch that restarts at 0 or pauses.
- `apps/studio/e2e/reel-layout.spec.ts` (E2E, extended): catches a Status area or tab coming back
  and Versions not filling the panel, with no page scroll at 1440x900 and 390x844.
- `apps/studio/e2e/change-requests.spec.ts` and `retry.spec.ts` (E2E, extended): catch a refused
  change without "Change the request" putting the request back, and a retryable failure without
  "Try again" queuing the job, each with its event's `job_id`.
- `scripts/dev-studio.sh`'s two new lines: no test needed beyond `bash -n`, because the script is
  the owner's command that ADW must never run and it only delegates to `dev:errors`, whose logic is
  unit tested.

### Edge Cases

- An unknown step name (a future step) reads "Working on it"; a `cutout` step inside `decide`
  keeps decide's step number.
- A queued job before any step: "Waiting to start" with the disk or offline line; a `waiting_ai`
  job: its waiting line, no failure actions.
- A failure followed by a newer job (Retry already pressed, or a new change): the old failure is
  not shown. A retried job (`retry_of_job_id` names it): no Try again.
- A refused reel (footage): the red refusal box, no overlay failure, no Try again.
- A refused `process` decide (no request to reword): Try again, never Change the request.
- A failure row from before the migration (`failure_kind` null): treated as a plain failure, Try
  again offered.
- Unknown or missing rule names: no reason line rather than a raw tail.
- A new version arriving while the previous one is still loading: the newest wins (the existing
  stale guard), and the hand-off uses the last mounted player's position.
- A start time past the new version's duration (a shorter edit): clamped to its duration.
- The notice on the first render (page open on a reel that just got a version): not shown.
- Two versions saved within the notice window: the notice shows the newest number, one timeout.
- The Realtime channel closing because the page unmounts: not reported (only while active).
- The local log folder missing or unwritable: created, or one log line printed, the job unaffected;
  a log over 2 MiB rotates and the older rotation is replaced.
- A step tail with a signed URL, a JWT or an email: scrubbed in both the PostHog property and the
  local line; the change request's text never appears in either.
- A photo job's failure: `photo_id` in place of `reel_id` in the line and the exception; no
  `reel.*` attributes on its spans.

## Acceptance Criteria

- The reel page has no Status area and no Status tab at any size; the phone shows Edit, Versions
  and Library; on desktop Versions spans the side column, scrolls in its own area, and the page
  never scrolls (1440x900 and 390x844).
- While a job runs, a small overlay over the top of the preview shows the step's words from the one
  mapping, step k of n and a progress bar (plus percent and time left for a long step), updates live
  over the existing Realtime channel, and never blocks Play, the Position slider, Undo or Redo.
- A newly saved version replaces the preview automatically, at the same playback time and in the
  same play or pause state, and the overlay says "New version N" for about 4 seconds.
- A refused change shows "Could not finish styling", a plain reason built from rule names, "Change
  the request" (refills and focuses the field) and "Keep the current version". A retryable failure
  shows "Try again", which queues the job with `retry_of_job_id`. Each action records
  `studio_failure_action` with the failed `job_id`, and every action is keyboard reachable with a
  polite live region for the words.
- Job and step spans carry `reel.source_seconds`, `reel.source_bytes`, `reel.width`, `reel.height`,
  `reel.footage_seconds`, `reel.word_count` when known, and the decide span `reel.tracks_items`.
- With the PostHog variables set, a decide refusal is captured as `worker: step failed` with
  `failure_kind: "answer_refused"`, `failed_rules` and `rounds`, never the request text; a job
  failure outside a step is captured as `worker: job failed`. Without them, each failure is one JSON
  line in `~/.edit-issebya-worker/dev/errors.jsonl` (or `WORKER_STATE_DIR`), rotated by size; the
  terminal `job <id>: failed: ...` line is unchanged; `yarn dev:studio` prints the log path and
  `yarn dev:studio errors` prints the last failures in plain words.
- `apps/worker/.env.example` documents OTEL for development (names and placeholders only) and
  `WORKER_STATE_DIR`.
- The dashboard script has the "time per step against reel length" insight (dry run only from ADW),
  and `app_docs/measurement.md` says how to read it.
- `steps` rows are written exactly as before; nothing is deleted.
- The six docs, the index, `README.md` and `.adw/project.md` are updated; no em-dashes; lint,
  typecheck, knip, format, unit, DB, build and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: Prettier over the whole repository (specs, docs, scripts, migration).
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker`: ESLint for both changed apps.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker`: `next typegen` + `tsc`
  for the studio, `tsc` for the worker (its build check).
- `yarn knip`: no unused export or file left behind by the removed `StatusPanel`, `RetryButton` and
  helpers.
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker`: the unit layers, including
  the step words, the overlay state, the span attributes, the error log and the dashboard dry run.
- `bash -n scripts/dev-studio.sh`: the owner's script still parses (never run it in a run).
- `.adw/supabase-stack reset`: apply the new migration to the ADW stack before the DB and E2E
  layers.
- `yarn turbo run test:db --filter=./apps/studio`: the new columns' checks and grants, and the
  dashboard queries against the real schema.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker`: the studio's `next build`
  (the worker's is its typecheck).

## Notes

- No new dependency.
- Try again is offered for every retryable failure except a refused change (the issue names
  `waiting_ai`, timeouts and the AI being unavailable as retry cases; a `waiting_ai` job is not
  failed and is taken again by itself at `not_before`, so the overlay shows its waiting line instead,
  and a permanent tool failure still deserves a Try again because the owner may have fixed the
  machine). A "try now" for a waiting job would need an owner write on `not_before`, out of scope.
- Dismissing a failure ("Keep the current version") is kept in memory for the page load; a reload
  shows a still-unhandled failure again. The previous version is current after any failure, so
  nothing is written.
- `studio_failure_action` is kept out of `STUDIO_EVENTS` because the dashboard's funnel uses that
  list as its series; it lives in `STUDIO_ACTION_EVENTS`. Never rename it or its properties once
  shipped. The evals in #110 group failures by `failure_rules` (warehouse) or `failed_rules`
  (error tracking).
- The reel's machine status is no longer shown on the reel page (it stays on the grid's badge);
  specs read it from the database.
- Owner steps after merge: apply the migration to the hosted project; add the four new `reels`
  columns and the two `jobs` columns to the PostHog warehouse source sync if it selects columns;
  run `yarn workspace @edit-issebya/studio posthog:dashboard --apply` from their shell; optionally
  fill the OTEL variables in `apps/worker/.env.development`; watch one real reel process in
  development (the owner acceptance).
- Not verified by the pipeline: real OTLP export from development, a real Realtime drop in
  production, autoplay of the switched preview in a non-automated browser session.
