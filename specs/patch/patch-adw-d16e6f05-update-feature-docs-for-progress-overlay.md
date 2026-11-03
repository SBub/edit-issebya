# Patch: update the eight feature docs and the index for the progress overlay

## Metadata

adw_id: `d16e6f05`
review_change_request: `Issue #1: Step 16 (Documentation) and the acceptance criterion 'The six docs, the index, README.md and .adw/project.md are updated' are only partly done. README.md and .adw/project.md changed, but git diff origin/develop --stat -- app_docs docs is empty. None of app_docs/studio-reel-layout.md, status.md, measurement.md, error-tracking.md, failures.md, change-requests.md, dashboard.md, studio.md or docs/conditional-docs.md were edited, so they still describe the Status area, the four phone tabs, status-area and StatusPanel.tsx, and miss the new Rules (overlay never blocks the controls, step words only in step-words.ts, no raw error tail on the reel page), the worker: job failed and studio: realtime channel dropped messages, the studio_failure_action event row, the reel.* attributes, the local error log and the new insight. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-117-adw-d16e6f05-sdlc_planner-reel-progress-overlay.md` (step 16, Documentation)
**Issue:** The code removed `StatusPanel.tsx`, `RetryButton.tsx`, the `status-area` and the phone's Status tab, and added the progress overlay, `step-words.ts`, `progress-overlay.ts`, `jobs.failure_kind` / `failure_rules`, the four `reels` size columns, `reel.*` span attributes, `worker: job failed`, `studio: realtime channel dropped`, `studio_failure_action`, the local error log and the `step-time-vs-length` insight. No file under `app_docs/` or `docs/` was touched, so the feature docs describe code that no longer exists and the Rules the spec requires are missing.
**Solution:** Docs-only edits, in place, to the eight feature docs and the index, describing what the branch's code actually does (read each named source file before writing its lines). Remove every stale reference, add the three new Rules, and keep every existing "never" and "do not" that still holds. No code, test or spec changes. No em-dashes; no dated changelog entries; no new doc file.

## Files to Modify

- `app_docs/studio-reel-layout.md`
- `app_docs/status.md`
- `app_docs/measurement.md`
- `app_docs/error-tracking.md`
- `app_docs/failures.md`
- `app_docs/change-requests.md`
- `app_docs/dashboard.md`
- `app_docs/studio.md`
- `docs/conditional-docs.md`

Sources to read for facts (not modified): `apps/studio/src/components/{ReelScreen,LiveReel,ProgressOverlay,ReelPreview,PreviewPlayer,ChangeRequestForm,NotifyToggle}.tsx`, `apps/studio/src/lib/{step-words,progress-overlay,studio-events,track,jobs}.ts`, `apps/worker/src/{error-tracking,dev-error-log,dev-errors,failure,queue,run-job,reel-size,telemetry,step-runner}.ts`, `apps/worker/src/decide/run-decide.ts`, `apps/worker/.env.example`, `apps/studio/scripts/posthog-dashboard/insights/step-time-vs-length.ts`, `supabase/migrations/20261103115809_failure_kind_reel_size.sql`, `scripts/dev-studio.sh`, `apps/studio/e2e/{progress-overlay,reel-layout,retry,change-requests}.spec.ts`.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: `app_docs/studio-reel-layout.md` (the layout)

- Overview (line 12) and the library paragraph (line 14): Versions has the side column to itself (no Status); the library is the third column on desktop and the third tab on a phone.
- Reel page section (lines 19 to 37): replace "a side panel with Versions above Status" with Versions spanning all three rows of the side column (`lg:col-start-2 lg:row-span-3 lg:row-start-1`), still `min-h-0 overflow-y-auto overscroll-contain`; the phone tabs are Edit, Versions and Library (arrows, Home and End wrap over the three); the areas carry `edit-area`, `versions-area` and the library's test id (drop `status-area`); drop `StatusPanel` from the `ReelScreen` / `LiveReel` bullet and delete the `StatusPanel.tsx` bullet. Add: the notification toggle sits in the header between the name and Export; the progress overlay (`ProgressOverlay.tsx`) is an absolutely positioned card in the top-left of the preview (`absolute left-2 top-2 right-2 sm:right-auto sm:max-w-xs`), `pointer-events-none` except its own buttons, above Play and the Position slider; link to `app_docs/status.md` for what it says.
- How to Use step 5 (line 100): Edit, Versions and Library tabs.
- Testing (lines 109 to 121): `reel-layout.spec.ts` checks no `status-area` and no `step-line`, Versions as tall as the side column within 1 px with its list scrolling inside, the phone's three tabs; `progress-overlay.spec.ts` checks the overlay inside the preview, clear of Play and the Position slider, at 1440x900 and 390x844.
- Rules: add "The overlay never blocks the player's controls: `pointer-events` off except its own buttons."
- Notes (line 145): drop the `StatusPanel` mention.

### Step 2: `app_docs/status.md` (the overlay)

- Title: `# Progress overlay, time left, ready notification, worker heartbeat and keep-awake`; update the Overview to say the overlay on the preview replaced the jobs and step list.
- New section `### Progress overlay` (after Database): `overlayState(...)` in `apps/studio/src/lib/progress-overlay.ts`, fed by `LiveReel`'s existing Realtime state (no new subscription, no polling); the four states `failure`, `notice`, `working`, `hidden` and their precedence (failure, then notice, then working, then hidden); `jobProgress`: step k of n from `JOB_STEPS[job.kind]` (`cutout` counts as `decide`, a queued job is 0), the bar's fraction including a running long step's `progress_percent`; the words module `apps/studio/src/lib/step-words.ts` (`STEP_WORDS`, `stepWords`, the `Working on it` fallback, `restore`'s N, `RULE_WORDS` and `refusalReason`); the failure actions Try again, Change the request and Keep the current version (when each is offered, as in `progress-overlay.ts`), each capturing `studio_failure_action` with `reel_id`, `job_id`, `action`, `failure_kind`, `step`, `job_kind`; dismissal kept in memory for the page load; the polite live region (`role="status" aria-live="polite"`) with buttons outside it; the test ids (`progress-overlay`, `data-overlay-kind`, `overlay-words`, `overlay-notice`, `overlay-headline`, `overlay-reason`, `overlay-try-again`, `overlay-change-request`, `overlay-keep`, `overlay-action-message`).
- New section `### New version notice and automatic switch`: `New version N` for `NEW_VERSION_NOTICE_MS = 4000` when `current_version_id` changes after the first render (never on the first render, one timeout, newest number wins); `ReelPreview` keeps the previous built preview until the next is built, then mounts it with `startAt` (last position, clamped to the duration) and `autoPlay` (last intent), through `PreviewPlayer`'s hold-then-start; the same for Undo and Redo; `data-version-id` and `data-intent` on the wrapper.
- Time left (line 89) and Offline display (line 122): the percent (`step-progress`), time left (`step-time-left`), waiting (`job-waiting-ai`, `job-waiting`) and offline (`job-offline`) lines now render inside the overlay, not under a job item. Ready notification: the toggle lives in the header.
- Testing: add `progress-overlay.spec.ts`, `step-words.test.ts`, `progress-overlay.test.ts`; `progress.spec.ts`, `waiting-ai.spec.ts`, `worker-offline.spec.ts`, `disk-guard.spec.ts` read their lines inside `progress-overlay`.
- Rules: keep "never poll" and every existing rule; add "Step words live only in `step-words.ts`; an unknown step reads `Working on it`." and "Never show a raw error tail on the reel page."

### Step 3: `app_docs/measurement.md` and `app_docs/dashboard.md`

- measurement.md Telemetry section: the job span and every step span (cache hits included) carry `reel.source_seconds`, `reel.source_bytes`, `reel.width`, `reel.height`, `reel.footage_seconds`, `reel.word_count` when known (nulls skipped), from `apps/worker/src/reel-size.ts` (`readReelSize` once at job start, the `ReelSizeHolder` on `StepContext` updated after `check_footage` and `retime`); `decide` adds `reel.tracks_items`; photo jobs carry none. The four `reels` columns `source_seconds`, `source_width`, `source_height`, `word_count`, each written once by the worker while null. OTEL in development: filling `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in `apps/worker/.env.development` with `OTEL_SERVICE_NAME=edit-issebya-worker-dev` exports to the same project.
- measurement.md Studio analytics: remove the `LiveReel.tsx` step-line bullet (line 93); add the `studio_failure_action` row (`reel_id`, `job_id`, `action`, `failure_kind`, `step`, `job_kind`, `app`), kept in `STUDIO_ACTION_EVENTS`, out of the funnel's `STUDIO_EVENTS`.
- measurement.md: a short `### Reading time per step against reel length` note naming the insight `step-time-vs-length` ("Studio: time per step against reel length") and the SQL it runs (synced `steps` joined to `reels` on `reel_id`, done rows, per step and 15-second `source_seconds` bucket: count, median and max seconds, median seconds per retimed footage second). Keep its Rules.
- dashboard.md: add the insight to the insight list in How it works (file `insights/step-time-vs-length.ts`, registered in `insights/index.ts`, dry-run snapshot), with the owner-only `--apply` note already there.

### Step 4: `app_docs/error-tracking.md`, `app_docs/failures.md`, `app_docs/change-requests.md`, `app_docs/studio.md`

- error-tracking.md: Worker section and Stable messages table: `worker: step failed` gains `failed_rules` and `rounds` (from the `AnswerRefused` cause, else null) and the `answer_refused` `failure_kind`; new row `worker: job failed` (a failure outside any step: `app`, `job_kind`, `reel_id`, `photo_id`, `job_id`, `failure_kind`, `error_code`, `error_tail` scrubbed, last 1000, `distinct_id` the owner); new browser row `studio: realtime channel dropped` (`reportBrowserFailure` in `track.ts` on `CHANNEL_ERROR`, `TIMED_OUT` or an unexpected `CLOSED`, `reel_id`, `status`; console only without PostHog). New `### Local development error log`: with the gate closed the worker's `localErrorLogTracker` appends one JSON line per `stepFailed`, `jobFailed` and `crashed` to `<WORKER_STATE_DIR or ~/.edit-issebya-worker/dev>/errors.jsonl` (fields as in `dev-error-log.ts`), rotated to `errors.1.jsonl` at 2 MiB, never secrets, env values or request text, an unwritable log prints one line and never breaks the job; `yarn dev:studio` prints the path and `yarn dev:studio errors` prints the last failures in plain words; specs set `WORKER_STATE_DIR` under `.e2e-storage/`. Note the overlay actions' `job_id` links an action to its failure. PostHog error tracking stays production only. Keep every existing Rule.
- failures.md: Overview (line 12), Edge cases (lines 45, 46), `### Retry button` (lines 102 to 124), How to Use (lines 207, 208), Testing (line 241): Retry is now the overlay's Try again (`overlay-try-again`), offered for every retryable failure except a refused change, never on a refused reel; `RetryButton.tsx` is gone (`LiveReel` calls `requestRetry`); drop the jobs list `job-retry-of` line. Database: `jobs.failure_kind` (`transient`, `failed`, `answer_refused`) and `failure_rules` (check rule names only) written by `failJob` in the same update as `status`; `refuseJob` writes no kind; readable, never writable by the owner (`failure-and-size-columns.test.ts`).
- change-requests.md: line 30's "press Retry on the failed job" becomes the overlay's Try again; add that a change refused twice shows "Could not finish styling", a plain reason from the rule names, "Change the request" (refills the field with the sent request and focuses it, through `ChangeRequestForm`'s `refill`) and "Keep the current version"; Testing names the extended `change-requests.spec.ts`.
- studio.md: Live status (lines 133 to 136): `LiveReel` renders no status panel, jobs or step log; the same one Realtime channel feeds the progress overlay; the reel's machine status shows only on the grid's badge; specs read statuses through `test-support/rows.ts`. Jobs section: the `jobs.failure_kind` and `failure_rules` columns and the four `reels` size columns.

### Step 5: `docs/conditional-docs.md`

- Line 21 (`status.md`): also name the progress overlay (`ProgressOverlay.tsx`, `progress-overlay.ts`), `step-words.ts`, the overlay's failure actions and `studio_failure_action`, the new-version notice and the automatic version switch.
- Line 24 (`error-tracking.md`): also name `worker: job failed`, `studio: realtime channel dropped` and the local development error log (`dev-error-log.ts`, `yarn dev:studio errors`).
- Line 25 (`studio-reel-layout.md`): "the phone's Edit, Versions and Library tabs" and the overlay's position over the preview.
- If the `measurement.md`, `failures.md` or `dashboard.md` line names something now gone (the step log, the Retry button), update it to the overlay and the new insight.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn format:check` (Prettier over the whole repository, the docs included; run `yarn format` and re-check if it fails).
2. `grep -rn $'—' app_docs docs` prints nothing (no em-dashes).
3. `grep -rnE 'StatusPanel|RetryButton|status-area|step-line|job-retry|Status tab|Versions above Status|four tabs' app_docs docs` prints nothing except a line that says the item is gone.
4. `grep -nE 'pointer-events|step-words.ts|raw error tail' app_docs/studio-reel-layout.md app_docs/status.md` shows the three new Rules; `grep -nE 'worker: job failed|realtime channel dropped|errors.jsonl' app_docs/error-tracking.md`, `grep -nE 'studio_failure_action|reel.tracks_items|step-time-vs-length' app_docs/measurement.md` and `grep -n 'step-time-vs-length' app_docs/dashboard.md` each print a match.
5. `git diff origin/develop --stat -- app_docs docs` lists all nine files.

## Patch Scope

**Lines of code to change:** about 150 to 250 lines of Markdown across nine files, no code
**Risk level:** low
**Testing required:** none beyond the format check and the greps above (docs only; the pre-commit hook still runs lint, typecheck and knip)
