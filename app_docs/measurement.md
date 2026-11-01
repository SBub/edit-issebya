# Step measurement, tracing and studio analytics

**Specifications:**

- specs/issue-28-adw-dcfd8f84-sdlc_planner-measure-pipeline-steps-traces.md

## Overview

Every step the worker runs is measured by the operating system and saved on its `steps` row, so the
owner knows what each reel costs to make, step by step. The full output of every step goes to
PostHog as OpenTelemetry logs and each reel is one trace. The studio also starts its own PostHog
client, identifies the signed-in user and sends `studio_*` events.

## How it works

### Step runner (`apps/worker`)

- `src/step-runner.ts`: the one place a step runs. `runStep` starts a tool as its own child process
  (own process group, no shell interpretation of the arguments) under `/usr/bin/time`, streams its
  stdout and stderr lines to the OTel logger, and when it exits writes `wall_ms` (`performance.now()`),
  `cpu_ms`, `peak_rss_bytes`, `bytes_in`, `bytes_out`, the summary line and, on failure, the error
  tail. `runInProcessStep` is the second entry point for work that stays in the worker (an HTTP
  call): it records `wall_ms` only and leaves the other four measurements null, because moving one
  call into a child would measure Node's start-up, not the step. `receive` is such a step. Both share
  the row, the span, the summary and the tail.
- `src/time-report.ts`: `timeCommand(platform)` (`/usr/bin/time -l` on macOS, `-v` on Linux, an error
  elsewhere) and the two report parsers. macOS reports max RSS in bytes, Linux in kilobytes (times
  1024). `/usr/bin/time` is the kernel's `wait4` accounting (`RUSAGE_CHILDREN`): CPU summed over every
  reaped descendant, max RSS of the largest single process. Never the whole machine. A missing report
  (the tool could not start, sh exit 126 or 127) stores null CPU and memory, never zeros.
- The tool runs through `sh -c 'exec "$0" "$@" 2>&3'` so its stderr goes to fd 3 and the time report
  alone goes to fd 2; no mixed stream is parsed.
- `src/process-tree.ts`: with `sampleGroupMemory: true` the runner runs `ps -A -o pid=,ppid=,rss=`
  every second (and once after the spawn), sums the RSS of the tool and all its descendants and keeps
  the peak. `peak_rss_bytes` is the larger of that peak and the report's max RSS. Without the option
  it is the largest single process. Meant for the render's long-lived browser processes.
- `src/summary.ts`: `stepSummary` gives `<what>, <duration in words>, <size>`, for example
  `background removed, 6 minutes 47 seconds, 51.0 MB` (`formatBytes`, one decimal, 1024 convention;
  durations under a second read `under a second`, hours drop the seconds, zero parts are omitted).
  `outputTail` keeps the last 20 lines of the output and never more than 4096 UTF-8 bytes, cut at a
  line start or a character boundary. A failed step's summary is `<name> failed, <duration>`.
- `src/step-store.ts`: `StepStore` and `supabaseStepStore`; `done` and `failed` write the measurement
  columns in the same update as `status`, `summary` / `error_tail` and `finished_at`.
- `supabase/migrations/20261101090000_step_measurements.sql`: adds `wall_ms`, `cpu_ms`,
  `peak_rss_bytes`, `bytes_in`, `bytes_out` (bigint, check `>= 0`) and the AI columns
  `ai_input_tokens`, `ai_output_tokens`, `ai_cost_usd`, `ai_model`, written by a later slice. No
  column converts machine measurements to money.
- A lost lease aborts the signal: the process group gets SIGTERM, SIGKILL after 5 seconds, and nothing
  more is written to the row.

### Telemetry (`apps/worker/src/telemetry.ts`)

- `createTelemetry(env)` builds a tracer and a logger provider per worker process (created in `once.ts`
  and `main.ts`, passed down, flushed with `shutdown()` before exit). It reads only
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values URL-decoded) and
  `OTEL_SERVICE_NAME` (default `edit-issebya-worker`). It exports to `<endpoint>/v1/traces` and
  `<endpoint>/v1/logs` only when both the endpoint and the headers are set; otherwise the providers have
  no processor and nothing is exported or fails.
- `traceIdForReel(uuid)`: the reel uuid without dashes, lowercased. `startJobSpan` starts the span
  `job <kind>` under a remote parent with that trace id (span id from the last 16 hex digits of the reel
  id, never exported), so every job of a reel, at any time, lands in one trace. Each step is a child
  span `step <name>` with `reel.id`, `job.id`, `step.name` and `step.wall_ms`, `step.cpu_ms`,
  `step.peak_rss_bytes`, `step.bytes_in`, `step.bytes_out`. Output lines are log records emitted in the
  step span's context (INFO for stdout, ERROR for stderr, attribute `stream`).
- Step measurements are never sent to PostHog as events: PostHog reads the tables as a data source.

### Studio analytics (`apps/studio`)

- `instrumentation-client.ts`: initialises PostHog (same project as the landing page) through
  `startStudioAnalytics` in `src/lib/analytics.ts`, only when `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and
  `NEXT_PUBLIC_POSTHOG_HOST` are both set and `navigator.webdriver` is not true, then registers the
  super property `app: "studio"`.
- Options (`studioPosthogOptions`): `persistence: "memory"` (checked in `posthog-js` 1.438.12:
  `PostHogConfig.persistence` accepts `"memory"` and `identify` has no persistence precondition), so no
  cookie or storage is written and an identified user still works. Not `cookieless_mode`, which cannot
  carry an identified user.
- The studio ignores the landing page's `?notrack` / `edit_notrack` opt-out: the owner sets it to keep
  their visits out of the landing funnel, and in the studio they are the user being measured.
- `src/components/StudioIdentify.tsx`: calls `identify(user.id)` (the Supabase id, never the email) on
  the home page and the reel page. Memory persistence means a new anonymous id per page load before the
  call, and PostHog merges an early `$pageview` on identify.
- `src/lib/track.ts`: `capture(event, { reel_id, ... })` is the one way to send a `studio_*` event, and
  `identify`. Under `navigator.webdriver` and when a spec put an array on `window.__capturedEvents`, it
  also records the event with the super property (the test hook).
- `src/components/LiveReel.tsx`: each step line reads `name: <summary>` (or `name: <status>` while no
  summary exists), and a failed step's `error_tail` sits in a collapsed `<details data-testid="step-error-tail">`
  ("Show error"). Still one read on open plus Realtime, no polling. The measurement columns are not shown.

| Event                                                                                                     | Sent when                                                                                     | Properties       |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| `studio_footage_uploaded`                                                                                 | the whole file is in storage and `finishUpload` succeeded, once per upload (`UploadForm.tsx`) | `reel_id`, `app` |
| `studio_preview_opened`, `studio_change_requested`, `studio_export_requested`, `studio_export_downloaded` | reserved, not sent yet                                                                        | `reel_id`, `app` |

## How to Use

1. Run steps through `runStep` (a tool) or `runInProcessStep` (in-worker work), passing the job's
   `StepContext` (`steps`, `telemetry`, `jobContext`, `job`, `signal`). Declare `inputs` and `outputs`
   to get byte counts, and `sampleGroupMemory: true` for a step that spawns a process tree.
2. To export, fill `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in
   `apps/worker/.env.production` and check one reel as one trace in PostHog.
3. In the studio, send an event with `capture("studio_...", { reel_id })` from a client component.

## Configuration

- Worker: the three `OTEL_*` variables above; both endpoint and headers are needed to export.
  `apps/studio/test-support/worker.ts` blanks both so a spec never exports.
- Studio: `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` (inlined at build, empty in
  development and CI). The PostHog project must accept non-cookieless events from the studio.
- Linux needs GNU `time` at `/usr/bin/time` (`apt-get install time`); CI installs it before the tests.

## Testing

- Worker unit tests (real child processes under `/usr/bin/time`): `step-runner.test.ts` (CPU vs sleep,
  200 MB memory, group sampling with and without the option, byte counts, failure tail, missing tool,
  abort), `summary.test.ts`, `time-report.test.ts`, `process-tree.test.ts`, `telemetry.test.ts` (one
  trace per reel, span tree, logs linked to spans, no request when export is off against a local HTTP
  server, positive control), `steps/receive.test.ts`.
- Studio unit tests: `src/lib/analytics.test.ts`, `src/lib/track.test.ts`.
- DB test: `db-tests/steps-measurements.test.ts` pins the exact column set of `steps`, so a money column
  fails it.
- Studio E2E: `e2e/upload.spec.ts` (step line format, `studio_footage_uploaded` with the reel id and
  `app`, no PostHog request), `e2e/multipart-upload.spec.ts` (`studio_footage_uploaded` exactly once
  per upload, through a retry and a resume) and `e2e/step-log.spec.ts` (a failed step's summary and
  collapsed tail).

## Rules

- Never write a step measurement twice: never send it to PostHog as an event or as an attribute of a
  product event (span attributes are traces, not events).
- Never store or emit a price derived from machine measurements; `ai_cost_usd` is only what Claude Code
  reports.
- Never measure the whole machine for a step.
- Never rename a `studio_*` event or a property once shipped.
- The studio never reads `edit_notrack` or `?notrack`.
- Never use the email as the distinct id.
- Never initialise PostHog in the studio under `navigator.webdriver` or without both variables; never
  write analytics cookies or storage (no `cookieless_mode`, no opt-in or opt-out calls).
- Never export OTLP unless both endpoint and headers are set; tests blank them.
- Never create telemetry providers at module load or register them globally.

## Notes

- `receive` is the only step today and runs in-process, so its row carries `wall_ms` only.
- Group sampling is as fine as one second; the report's max RSS still bounds short single-process peaks.
- The trace's root is virtual; PostHog groups by trace id, so a reel opens as one timeline.
- `app_docs/studio.md` (Worker, Live status) and `app_docs/analytics.md` (landing rules unchanged) are the
  neighbouring features this change touches.
- Out of scope: the data warehouse source and dashboard, progress and time left, AI token and cost
  values, any real video step.
