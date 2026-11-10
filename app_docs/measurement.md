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
  call into a child would measure Node's start-up, not the step. `first_version` and `restore` are such
  steps. Both share the row, the span, the summary and the tail.
- `src/time-report.ts`: `timeCommand(platform)` (`/usr/bin/time -l` on macOS, `-v` on Linux, an error
  elsewhere) and the two report parsers. macOS reports max RSS in bytes, Linux in kilobytes (times
  1024). `/usr/bin/time` is the kernel's `wait4` accounting (`RUSAGE_CHILDREN`): CPU summed over every
  reaped descendant, max RSS of the largest single process. Never the whole machine. A missing report
  (the tool could not start, sh exit 126 or 127) stores null CPU and memory, never zeros.
- The tool runs through `sh -c 'exec "$0" "$@" 2>&3'` so its stderr goes to fd 3 and the time report
  alone goes to fd 2; no mixed stream is parsed.
- Each tool call is one `exec` span under its step, see Tool calls below. An AI call is an HTTP call
  (OpenRouter), not a tool call: it has a `chat` span and no `exec` span.
- `src/process-tree.ts`: with `sampleGroupMemory: true` the runner runs `ps -A -o pid=,ppid=,rss=`
  every second (and once after the spawn), sums the RSS of the tool and all its descendants and keeps
  the peak. `peak_rss_bytes` is the larger of that peak and the report's max RSS. Without the option
  it is the largest single process. Meant for the render's long-lived browser processes: the
  export's `render` step is the step that uses it (HyperFrames runs Chrome workers and an encoder);
  see `app_docs/export.md`.
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
  more is written to the row. The tool call settles only once no process of the group is left (reaped
  included, at most 2 seconds past the SIGKILL), so a member that let go of the pipes still gets the
  SIGKILL. No tool call starts after an abort.

### Telemetry (`apps/worker/src/telemetry.ts`)

- `createTelemetry(env)` builds a tracer and a logger provider per worker process (created in `once.ts`
  and `main.ts`, passed down, flushed with `shutdown()` before exit). It reads only
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values URL-decoded) and
  `OTEL_SERVICE_NAME` (default `edit-issebya-worker`). It exports to `<endpoint>/v1/traces` and
  `<endpoint>/v1/logs` whenever the endpoint is set. The headers are optional: a local collector needs
  none, and an empty value sends none. Without an endpoint the providers have no processor and nothing
  is exported or fails.
- `traceIdForReel(uuid)`: the reel uuid without dashes, lowercased. `startJobSpan` starts the span
  `job <kind>` as a root span (no parent span id) in that trace: `startRootSpan` passes `root: true`
  and a trace id pinned for that one call to the SDK's id generator (`PinnableIdGenerator`, which
  the SDK asks for a trace id only when a span has no parent). So every job of a reel, at any time,
  lands in one trace as a top-level block, with no missing-parent gap. A span started outside a job
  gets a random trace id as before. Each step is a child
  span `step <name>` with `reel.id`, `job.id`, `step.name` and `step.wall_ms`, `step.cpu_ms`,
  `step.peak_rss_bytes`, `step.bytes_in`, `step.bytes_out`. Output lines are log records emitted in the
  step span's context (INFO for both streams, attribute `stream`: a tool's stderr is progress as often
  as errors, so no output line is an ERROR). A failed step attempt or job failure is one ERROR record
  (`emitFailureLog`), see "Failures in Grafana". The exec spans carry no log records, so a step's log
  lookup is unchanged.
- The reel's size: the job span and every step span (cache hits included) carry `reel.source_seconds`,
  `reel.source_bytes`, `reel.width`, `reel.height`, `reel.footage_seconds` and `reel.word_count` when
  known (nulls skipped). `src/reel-size.ts`: `readReelSize` reads the reel's size columns once at job
  start (`process-job.ts`), and the `ReelSizeHolder` on `StepContext` (`size`) is updated when the
  pipeline learns a value: the source's after `check_footage`, the footage seconds and the word count
  after `retime`. The `decide` step span adds `reel.tracks_items` (the items over every track of the
  saved edit). Photo jobs carry none.
- The four `reels` columns `source_seconds`, `source_width`, `source_height` and `word_count`
  (`supabase/migrations/20261103115809_failure_kind_reel_size.sql`, beside `source_bytes` and
  `footage_seconds`) are each written once by the worker while null; the owner reads them, never
  writes them.
- A `describe_photo` job's trace uses the photo's id in place of the reel's (`traceIdForJob`), and its
  spans carry `photo.id` in place of `reel.id` (`targetAttributes`). Its `job` span keeps the earlier
  shape: a remote parent whose span id no span carries, so Grafana shows it with a missing parent.
- `decide`'s stages are child spans of its `step decide` span, one per stage, with the `decide.*`
  names and attributes listed under Local monitoring. `step cutout` is a
  child of the decide span when decide runs it (the step takes an optional `parent`); its
  step rows are the same either way. `src/telemetry.ts` `inSpan` runs a stage in its span. Each AI
  call is a `chat` span under the stage that made it (`src/ai.ts` `inChatSpan`, see AI calls below).
- Step measurements are never sent to PostHog as events: PostHog reads the tables as a data source.
- Exceptions: `app_docs/error-tracking.md`.

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
  `identify`. It also holds `captureException(message, properties)`. Under `navigator.webdriver` and
  when a spec put an array on `window.__capturedEvents`, it also records the event with the super
  property (the test hook); the hook also records `{ event: "$exception", properties }` (with `app` and
  `$exception_message`) from the upload form's failed upload, via `captureException`.
- Exceptions: `app_docs/error-tracking.md`.
- `src/lib/studio-events.ts`: `STUDIO_EVENTS` (the five funnel events, the dashboard's funnel series)
  and `STUDIO_ACTION_EVENTS` (`studio_failure_action`, kept out of the funnel).
- The reel page shows no step log, summary or error tail: the progress overlay says the step in plain
  words (`app_docs/status.md`). The measurement columns are not shown.

| Event                      | Sent when                                                                                                            | Properties                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `studio_footage_uploaded`  | after the multipart upload completes, once (`UploadForm.tsx`)                                                        | `reel_id`, `app`                                                         |
| `studio_preview_opened`    | the live preview first reaches the player on a page open (`ReelPreview.tsx`)                                         | `reel_id`, `app`                                                         |
| `studio_change_requested`  | no longer sent: the change box is removed (`app_docs/change-requests.md`)                                            | `reel_id`, `app` (never the request text)                                |
| `studio_export_requested`  | the Export button queues a render job (`ExportPanel.tsx`)                                                            | `reel_id`, `app`                                                         |
| `studio_export_downloaded` | the export modal starts the download by itself, or the owner clicks its fallback `Download` link (`ExportPanel.tsx`) | `reel_id`, `app`                                                         |
| `studio_failure_action`    | the owner presses one of the overlay's failure actions (`LiveReel.tsx`)                                              | `reel_id`, `job_id`, `action`, `failure_kind`, `step`, `job_kind`, `app` |

A cancelled render (`jobs.status = 'cancelled'`, `app_docs/export.md`) keeps the step rows
written before the cancel; its `render` row stays `running` with no measurements, as on any abort.
The dashboard insights read it this way: those that filter steps or jobs on `done`, `failed` or
`skipped` (`job-run-time`, `worker-busy-hours`, `failed-steps`, `capacity-per-minute`,
`step-time-vs-length`, `cache-hit-rate`) leave it out; `jobs-per-day` counts it as a created
render and `queue-wait` counts its wait if it was started; the AI and cost insights sum only the
measurements written, so the aborted row adds nothing. No insight changed.

### Reading time per step against reel length

The dashboard's insight `step-time-vs-length` ("Studio: time per step against reel length",
`apps/studio/scripts/posthog-dashboard/insights/step-time-vs-length.ts`, `app_docs/dashboard.md`)
joins the synced `steps` to the synced `reels` on `reel_id`, keeps `done` rows of reels with
`source_seconds`, and per step name and 15-second `source_seconds` bucket gives the count, the median
and longest seconds, and the median seconds per second of retimed footage.

## How to Use

1. Run steps through `runStep` (a tool) or `runInProcessStep` (in-worker work), passing the job's
   `StepContext` (`steps`, `telemetry`, `jobContext`, `job`, `signal`). Declare `inputs` and `outputs`
   to get byte counts, and `sampleGroupMemory: true` for a step that spawns a process tree.
2. To export, fill `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` in
   `apps/worker/.env.production` and check one reel as one trace in PostHog. In development, the same
   two lines in `apps/worker/.env.development` with `OTEL_SERVICE_NAME=edit-issebya-worker-dev`
   export to the same project, told apart by the service name.
3. In the studio, send an event with `capture("studio_...", { reel_id })` from a client component.

## Local monitoring

`yarn dev:studio` always starts it. The script starts `docker-compose.monitoring.yml` (the
`grafana/otel-lgtm` image: Grafana, Tempo for traces, Loki for logs and Prometheus for metrics in one
container, OTLP over HTTP) and sets `WORKER_DOCKER_OTLP_ENDPOINT=http://host.docker.internal:4318`,
which `compose.yaml` passes to the worker container as `OTEL_EXPORTER_OTLP_ENDPOINT`. The container
also gets an empty `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME=edit-issebya-worker-dev` from
`compose.yaml`; compose `environment` wins over the env file, so a PostHog token in
`apps/worker/.env.development` never reaches the local container. The monitoring container keeps
running when `yarn dev:studio` stops.

There is one monitoring stack per machine: every checkout uses the Compose project
`edit-issebya-monitoring`, and `yarn dev:studio` reuses it when Grafana already answers on 3300
instead of starting a second one.

After starting the stack, `yarn dev:studio` waits up to 60 seconds for Grafana to answer. If it does
not (or the container has exited), it recreates the container once with `up -d --force-recreate`, which
keeps the data volume, and waits again. If Grafana still does not answer, it prints a WARNING with the
container's last log lines, and the banner shows Grafana as DOWN. The studio still runs, but worker
traces and logs are not recorded until the stack is back.

- Grafana: `http://localhost:3300`. The host port is 3300 because the landing page owns 3000. Both
  published ports (3300 and 4318) are bound to 127.0.0.1.
- A reel's trace: Explore, the Tempo data source, query type TraceID, the reel's uuid without dashes
  (`traceIdForReel`). Each job is a root `job <kind>` span (a top-level block; jobs of one reel follow each
  other in time), each step a child `step <name>` span and each
  tool call a child `exec <executable>` span of its step.
- A step's output: from a span, Logs for this span opens Loki (Tempo's `tracesToLogsV2` link). Each
  output line is a log record in the step span's context, and Loki links back to Tempo by `trace_id`.
- Stop it with `docker compose -f docker-compose.monitoring.yml down`. The data lives in the named
  volume `otel-lgtm-data` (under `/data` in the container), so it survives a restart; add `-v` to
  delete it.

### Failures in Grafana

A failed step attempt, and a job failure outside any step, is one ERROR log record
(`emitFailureLog` in `apps/worker/src/telemetry.ts`; production exports the same record through the
same OTLP logs exporter). It is written at the point the failed row is written, in the step's or the job's span
context.

1. Grafana (`http://localhost:3300`), Explore, data source Loki.
2. Query: `{service_name="edit-issebya-worker-dev"} | detected_level="error"`. Each line's body reads
   `<step> failed: <message>` or `job failed: <message>`.
3. Expand a line to read `job_id`, `job_kind`, `reel_id` (or `photo_id`), `step_name`, `step_attempt`
   (`job_attempt` for a job failure), `failure_kind`, `failure_retrying` and `failure_reasons` (the
   full output tail). Attribute names with dots show with underscores in Loki. To narrow to one job:
   `{service_name="edit-issebya-worker-dev"} | detected_level="error" | job_id="<job uuid>"`.
4. The line's `trace_id` links to Tempo: open the trace, and the failing `step <name>` span carries
   a `failure` event with the same reasons. A reel's whole trace is found by its uuid without dashes
   (`traceIdForReel`).
5. Output lines (INFO, `stream` stderr or stdout) are in the same Loki data source: filter them out with
   `| detected_level="info"` or look for `stream="stderr"` on the step's lines.

The label names follow the OTLP export (`service.name` becomes `service_name`, severity becomes
Loki's detected level). They were written from the exporter and Loki 3's OTLP mapping, and were not
checked against a running stack; if the field shows as `level` in your Grafana, use `| level="error"`.
A worker crash is not a log record in development: it reaches PostHog in production only.

### relayout's spans

The `step relayout` span carries `relayout.font_pair` (the job's pair). Its stages are child spans, one per
stage, the same shape as decide's: `relayout.load` (`relayout.version`, `relayout.inputs` as `name=step`
pairs, `relayout.ai_record`, `relayout.ai_calls`), `relayout.engine` (`relayout.font_pair`,
`relayout.from_version_id`, `relayout.picks_placed`: the overlays and behind items the engine placed,
`relayout.checks`), the cut-out step span (below) and `relayout.save_version`. A stage that throws marks its
own span with error status; the step's failure is one ERROR record, `relayout failed: ...`, with the job id
and `step.name` `relayout`, as for every step. Relayout makes no AI call, so there is no `chat` span.

The cut-out step span (`step cutout`, from decide or relayout) carries `cutout.made` and `cutout.reused`:
the masks this call made and the stored masks it reused. A cache hit has `cutout.made` 0.

### AI calls (`chat` spans)

Every model call is one `chat` span, a `CLIENT` span under the stage that made the call, with the
attributes of the OpenTelemetry GenAI semantic conventions (status Development:
https://github.com/open-telemetry/semantic-conventions-genai). `src/ai.ts` `inChatSpan` makes it
around the OpenRouter call itself (both tries of the JSON mode fallback included), so the real
runner and the test double both get it. The name is `chat <model>`: every call names its role's
model, `chat anthropic/claude-haiku-5.5` today (`app_docs/decide-step.md`, "The AI runner").

- `gen_ai.operation.name` = `chat`, `gen_ai.provider.name` = `openrouter`,
  `gen_ai.request.model`: always.
- No temperature attribute: the model takes no temperature setting, so no call sends one (`app_docs/decide-step.md`, "The AI runner").
- `gen_ai.response.model`: the model that answered (`response.modelId`).
- `gen_ai.usage.input_tokens`: every input token OpenRouter reports, cache reads and writes
  included.
- `gen_ai.usage.output_tokens`; `gen_ai.usage.cache_read.input_tokens` and
  `gen_ai.usage.cache_write.input_tokens` when non-zero (parts of the input tokens above).
- `gen_ai.response.finish_reasons`: the one finish reason (`stop`, `length`, ...).
- `edit_issebya.ai.cost_usd`: the cost OpenRouter reports (usage accounting), else the list price
  of the call's tokens. A custom attribute, because the standard has none.
- `edit_issebya.ai.role` (`hook`, `decide`, `describe`),
  `edit_issebya.ai.output_mode` (`json_schema`, or `json` after the fallback) and
  `edit_issebya.ai.prompt_version` (the prompt's identity, `<name>@v<version>`, such as
  `reel-components@v1`): custom attributes.
- A value not known is left out.
- `error.type` and an error status when the call does not succeed (the OpenTelemetry rule for a
  failed operation): `unavailable` (no key, a refused key, no credits, a rate limit, OpenRouter not
  answering: the job itself waits, and its job span is not an error) or `broken` (the answer is not
  JSON or was cut off; a thrown call is `broken` too, with an `exception` event).
- Never on the span: the prompt, the schema, the answer or the image (they are in the version's AI
  record, `app_docs/decide-step.md`).

To see every AI call in Tempo, TraceQL: `{ span.gen_ai.operation.name = "chat" }`; the fallback
calls: `{ span.edit_issebya.ai.output_mode = "json" }`. The `chat` span's duration is the whole
call, the AI SDK's one retry and its backoff included.

### Tool calls (`exec` spans)

Every tool call the step runner spawns is one `exec` span, an `INTERNAL` span under the step that ran
it (`src/step-runner.ts`, `startExecSpan` and `endExecSpan`). That covers ffmpeg, ffprobe, HyperFrames,
the cut-out's MODNet entry and the render. The step row keeps the totals; the spans show which call
took the time.

- Name: `exec <executable>`, the executable's base name (`exec ffmpeg`, `exec ffprobe`).
  When `node` runs a script (`.mjs`, `.js`, `.cjs`, `.ts`) the name is the script's base name:
  `exec hyperframes` for HyperFrames' `bin/hyperframes.mjs`, `exec remove-background-entry` for the
  person mask, `exec modnet-entry` for each cut-out span. `process.executable.name` stays `node`.
  The ffmpeg processes the MODNet entry starts itself are not spans of their own; their time is in
  `exec modnet-entry`.
- Parent: the step's span, or the call's `parent` when it names one.
- Process attributes, from the OpenTelemetry process conventions (status Release Candidate:
  https://github.com/open-telemetry/semantic-conventions/blob/main/docs/registry/attributes/process.md):
  `process.executable.name`, `process.args_count` (the executable and its arguments, as
  `process.command_args` counts them) and `process.exit.code` when the call exited. `process.pid` is
  not set: the spawned process is `/usr/bin/time`, and the tool runs under it.
- Other attributes: `step.name`; `edit_issebya.exec.subcommand` (the first argument after the script
  when it is a plain lower-case word, such as `transcribe`; a path or a flag never is);
  `edit_issebya.exec.cpu_ms` and `edit_issebya.exec.peak_rss_bytes` (this call's own report, read the
  way the step row reads it, so the step's CPU is the sum of its calls' and its peak the largest);
  `edit_issebya.exec.stdout_bytes` (the stdout the call returned, UTF-8 bytes, capped as the call
  returns it); `edit_issebya.exec.signal` when a signal ended the call.
- Errors: a call the abort ended (`error.type` `aborted`), one that could not be spawned (`spawn_error`,
  or sh's 126 and 127 for a tool it could not run), one a signal killed (`signal`) and one that exited
  non-zero (`nonzero_exit`) have an error status, `error.type` and an `exception` event. The step's
  failure, retry and row are the same as before.
- Not on the span: the command line, the arguments, the stdin (a prompt, a schema) and the environment.
  The step's output lines stay log records of the step span.
- With no exporter the call runs and measures exactly as it does with one.

To find slow or failed calls in Tempo, TraceQL: `{ name =~ "exec .*" && duration > 5s }` for the slow
ones, `{ name =~ "exec .*" && status = error }` for the failed ones, and
`{ name = "exec hyperframes" && span.edit_issebya.exec.subcommand = "transcribe" }` for one HyperFrames
command.

### decide's spans

The `step decide` span has one child per stage. On a normal run (automatic, one attempt, no
behind item) the children run in this order; a retry adds a second
`decide.attempt`:

```
step decide                        reel.tracks_items
├─ decide.load                     the current version, transcript, head track, parse
├─ decide.prepare                  rules, library, schema, prompt input
├─ decide.photo_looks              decide.photos
├─ decide.attempt                  decide.attempt 1, decide.outcome, decide.refused_by
│  ├─ chat <model>                 gen_ai.* (the attempt's AI call)
│  └─ decide.engine                decide.checks
├─ step cutout                     (only with a behind item)
└─ decide.save_version
```

- `decide.attempt`: `decide.attempt` (1 or 2); `decide.outcome`: `ok`, `invalid` (the answer is
  not JSON), or `refused` (the schema, the placed edit's parse or the glossary check); `decide.refused_by`
  the rule names, comma-separated, when refused.
- `decide.engine`: `decide.checks` (layout checks that failed on its output).
- The stage spans carry no AI facts; the `chat` span under each stage does (see AI calls above).
  The step row keeps the summed totals.
- A stage that throws marks its own span with error status and an `exception` event; the step
  then fails, is retried or waits exactly as before (the step row says the same).

To read decide in Tempo: Explore, the Tempo data source, TraceID, the reel's uuid without dashes.
Open `step decide`; its children are the stages above, and any time inside decide that no stage
covers shows as a gap between them. The AI time is in each `chat` span; a long `decide.engine` is
the layout, not the AI.

The photo description (`describe_photo`) makes its call as a `chat` span under its step span.

### render's spans

The `step render` span has five stages as children, in order. The HyperFrames call is the `exec`
span under `render.encode`:

```
step render                        render.version_id, render.duration_seconds, render.mp4_bytes, job.cancelled
├─ render.load                     render.version_id, render.version_number, render.inputs
├─ render.build                    render.page_bytes, render.assets
├─ render.encode                   render.duration_seconds
│  └─ exec hyperframes             the tool call's exec attributes (CPU, peak, exit)
├─ render.upload                   render.mp4_bytes, render.key
└─ render.save                     render.export_id
```

- `render.load`: the version row, its edit and the inputs read from storage. `render.inputs` is the
  footage plus the masks downloaded for the render.
- `render.build`: the HyperFrames page from the shared builder and the project folder beside it.
  `render.page_bytes` is the page's UTF-8 size, `render.assets` the files the page names.
- `render.duration_seconds` is the composition's length (the edit's duration), on the step and on
  `render.encode`. The step's own wall time is `step.wall_ms`.
- `render.upload` and `render.save` are the MP4 put to storage and the `exports` row. A row refused
  for a cancelled job ends `render.save` clean; the uploaded file is discarded as before.
- `job.cancelled` is on the step (`true` or `false`) and on the stage a cancel stopped. A cancel
  (`JobCancelled`) ends those spans clean: no error status, no exception event, and no ERROR log
  record. The step span is not an error either. A lost lease or a deleted job also ends the step span
  without an error status (`step-runner.ts` `withStep`), but sets no `job.cancelled`.
- A failed render writes one ERROR record `render failed: <message>` through the step's failure log
  (`emitFailureLog`), with `job.id`, `job.kind` and `step.name` `render`, in the step span's context. The
  failing stage's span carries the exception and the error status.

## Configuration

- Worker: `OTEL_EXPORTER_OTLP_ENDPOINT` turns export on; `OTEL_EXPORTER_OTLP_HEADERS` is optional
  and only needed for PostHog. `apps/studio/test-support/worker.ts` blanks both so a spec never exports.
- Studio: `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` (inlined at build, empty in
  development and CI). The PostHog project must accept non-cookieless events from the studio.
- Linux needs GNU `time` at `/usr/bin/time` (`apt-get install time`); CI installs it before the tests.

## Testing

- Worker unit tests (real child processes under `/usr/bin/time`): `step-runner.test.ts` (CPU vs sleep,
  200 MB of random memory touched every turn, so macOS cannot compress it under load, group sampling with and without the option, byte counts, failure tail, missing tool,
  abort: the whole group gone when the step settles, a grandchild that ignores SIGTERM and holds no
  pipes killed, no call started after the abort), `summary.test.ts`, `time-report.test.ts`, `process-tree.test.ts`, `telemetry.test.ts` (one
  trace per reel, span tree, logs linked to spans, no request without an endpoint against a local HTTP
  server, an endpoint alone with no Authorization header, positive control).
- Render's spans: `render/render-step.test.ts` (`runRender spans`: the five stages in order under the
  step, the HyperFrames exec under `render.encode`, each stage's attributes, one ERROR `render failed`
  record with the job and the step when the footage is missing, a cancel that ends the stage and the
  step clean with `job.cancelled`). `telemetry.test.ts` (`inSpan`: a cancelled work ends clean).
- Decide's spans: `telemetry.test.ts` (`inSpan`: the child's parent and attributes, an error marked
  and rethrown, telemetry that exports nothing), `run-decide.test.ts` (`runDecide spans`: a normal
  run's children in order with their facts, a retry as two attempts, a thrown error on the attempt's
  span, no exporter; the cut-out under decide).
- AI calls: `ai.test.ts` (`the chat span of a call`: name, kind, operation, provider, request and
  response model, the tokens, the cost, the finish reason, the role and output mode, the error
  types, no trace means no span).
- Tool calls: `step-runner.test.ts` (`exec spans`: one span per call under the step, the row's CPU and
  peak equal to the calls', a script's name and subcommand with no path, the parent a call names, a
  non-zero exit, a spawn error, an abort, no exporter).
- Studio unit tests: `src/lib/analytics.test.ts`, `src/lib/track.test.ts`.
- DB test: `db-tests/steps-measurements.test.ts` pins the exact column set of `steps`, so a money column
  fails it.
- Studio E2E: `e2e/upload.spec.ts` (the step rows' summaries read from the database,
  `studio_footage_uploaded` with the reel id and `app`, no PostHog request), `e2e/multipart-upload.spec.ts` (`studio_footage_uploaded` once with the
  reel id and `app` after completion, also after a retried part and after a resume, and never after
  cancel) `e2e/retry.spec.ts` (`studio_failure_action` with the
  failed job's id).

## Rules

- Never write a step measurement twice: never send it to PostHog as an event or as an attribute of a
  product event (span attributes are traces, not events).
- Never store or emit a price derived from machine measurements; `ai_cost_usd` is what OpenRouter
  reports, or, for a call whose response carries no cost, the list price of its reported tokens
  (`PRICES` in `apps/worker/src/ai.ts`).
- Never measure the whole machine for a step.
- Never rename a `studio_*` event or a property once shipped.
- The studio never reads `edit_notrack` or `?notrack`.
- Never use the email as the distinct id.
- Never initialise PostHog in the studio under `navigator.webdriver` or without both variables; never
  write analytics cookies or storage (no `cookieless_mode`, no opt-in or opt-out calls).
- Never export OTLP without `OTEL_EXPORTER_OTLP_ENDPOINT`; tests blank it, and the headers too.
- Never create telemetry providers at module load or register them globally.
- Never let a span change a step: no row, measurement, AI call, retry or error depends on a span. A
  stage that throws marks its own span as an error and the step fails as before.
- Every model call is one `chat` span with `gen_ai.*` attributes, never invented `ai.*` names; the
  cost is `edit_issebya.ai.cost_usd`, the role and output mode `edit_issebya.ai.*`, because the
  conventions have none.
- Never put a tool call's command line, its arguments, its stdin or its environment on its `exec`
  span: the executable's base name, the argument count, a plain-word subcommand and the measurements
  only. A prompt, a schema, an answer or a reel's path never reaches a span.

## Notes

- The step names are the list in `apps/worker/src/step-names.ts`. `first_version` and `restore` run
  in-process, so their rows carry `wall_ms` only.
- Group sampling is as fine as one second; the report's max RSS still bounds short single-process peaks.
- The trace's root is virtual; PostHog groups by trace id, so a reel opens as one timeline.
- `app_docs/studio.md` (Worker, Live status) and `app_docs/analytics.md` (landing rules unchanged) are the
  neighbouring features this change touches.
- Out of scope: the data warehouse source and dashboard, AI token and cost values, any real video
  step. Step progress and time left are in `app_docs/status.md`.
