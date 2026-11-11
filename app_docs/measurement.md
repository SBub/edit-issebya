# Step measurement, tracing and studio analytics

**Specifications:**

- specs/issue-28-adw-dcfd8f84-sdlc_planner-measure-pipeline-steps-traces.md

## Overview

Every step the worker runs is measured by the operating system and saved on its `steps` row, so the
owner knows what each reel costs to make, step by step. The full output of every step goes to
PostHog as OpenTelemetry logs and each reel is one trace. The studio also starts its own PostHog
client, identifies the signed-in user and sends `studio_*` events. In local development the worker
container's CPU, memory, disk and network are measured too and shown above a reel's trace
(Resource metrics).

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
- A step attempt's times agree. The worker stamps its start (`startedAt`, one instant) and writes it as
  the row's `started_at` and the span's start; the row finishes `wall_ms` later (`finishedAt` in
  `step-store.ts`), and the span ends there too. A cache hit (`recordHit`) is the same: its skipped row and
  span last exactly its `wall_ms`. A failed attempt's `wall_ms` runs from its own start to the end of its
  work, never a nested step's time (decide's cut-out, its own row) or an earlier attempt's. Its CPU, peak
  memory and bytes are its own calls and declared files, as on success; a nested step's are on its row.
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
  export's `render` step uses it (HyperFrames runs Chrome workers and an encoder; see
  `app_docs/export.md`), and so does each span call of the `cutout` step (the MODNet entry and its
  two ffmpegs, of which the encoder alone is the largest single process).
- A step's calls may run at the same time (the `cutout` step's spans, `app_docs/pipeline.md`). The
  row is measured the same way: `wall_ms` is the step's own clock from its start to its end (not a
  sum of the calls), `cpu_ms` is still the sum of every call's CPU (so it can be several times
  `wall_ms`), and `peak_rss_bytes` is the largest total of the peaks of calls that were running at
  the same moment (`concurrentPeak` in `step-runner.ts`): the largest single call when they run
  one after the other, as before, and the calls together when they overlap. Each call is taken at
  its own peak, so for overlapping calls the number is an upper bound. A failed call's row counts
  the calls that ended beside it. Each `exec` span keeps its own call's numbers.
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
- The job span carries `job.queue_wait_ms`: the time from the job's creation to this claim
  (`started_at - created_at` of the row `claim_job` returns). It is left out when either time is
  missing.
- Every object the job reads from or writes to storage is an `r2.get` or `r2.put` span (R2 reads and
  writes below).
- `runUnderSpan` and `activeSpanContext` (`src/telemetry.ts`) keep the Context of the running step or
  stage in an `AsyncLocalStorage`, for code that is handed no Context (the storage wrapper). The step
  runner and `inSpan` set it. It is not OpenTelemetry's global context manager: none is registered.
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
container, OTLP over HTTP; and cAdvisor, a second container that measures the containers, see
Resource metrics) and sets `WORKER_DOCKER_OTLP_ENDPOINT=http://host.docker.internal:4318`,
which `compose.yaml` passes to the worker container as `OTEL_EXPORTER_OTLP_ENDPOINT`. The container
also gets an empty `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME=edit-issebya-worker-dev` from
`compose.yaml`; compose `environment` wins over the env file, so a PostHog token in
`apps/worker/.env.development` never reaches the local container. The monitoring containers keep
running when `yarn dev:studio` stops.

There is one monitoring stack per machine: every checkout uses the Compose project
`edit-issebya-monitoring`, and `yarn dev:studio` reuses it when Grafana already answers on 3300 and
every service runs with the settings of the checkout's compose file (Compose's hash of each service,
`docker compose config --hash`, against the hash on the running container). Otherwise it runs
`docker compose up -d`, which adds a missing container and recreates only one whose settings changed;
the data volume is kept. The files mounted from `monitoring/` are part of the settings by their path,
so a checkout in another folder recreates the otel-lgtm container with its own files.

Four files of the repository are mounted into the otel-lgtm container:

- `monitoring/prometheus.yaml` over `/otel-lgtm/prometheus.yaml`: the image's own Prometheus config
  (0.39.0, unchanged) plus one `scrape_configs` job, cAdvisor. On an image upgrade, copy the new
  image's file and keep that block.
- `monitoring/grafana/dashboards.yaml`, a dashboard provider beside the image's own, and the folder
  it loads, `monitoring/grafana/dashboards/`. Every dashboard JSON file in that folder is in Grafana
  after start-up and re-read every 10 seconds, and survives a recreated container. A change made in
  the Grafana UI is not saved to the file: export the JSON and commit it.
- `monitoring/grafana/datasources.yaml`, beside the image's own data sources: one more data source,
  "Tempo trace JSON" (uid `tempo-trace-json`), which is the Infinity plugin reading Tempo's HTTP API
  inside the container (`http://127.0.0.1:3200`, the only host it may call).

The Infinity plugin (`yesoreyeram-infinity-datasource`) is not in the image. The compose file names
it at a pinned version in `GF_PLUGINS_PREINSTALL`; Grafana downloads it from grafana.com in the
background after it starts (about 25 seconds on the first start) and keeps it in
`/data/grafana/plugins` on the data volume, so the network is needed once. Without the network the
container runs and records as before, and only the four dashboard panels that read through the
plugin show an error until a later start downloads it. The image's Drilldown apps are downloaded
the same way.

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
- Stop it (both containers) with `docker compose -f docker-compose.monitoring.yml down`. The data lives in the named
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
the masks this call made and the stored masks it reused. A cache hit has `cutout.made` 0. A step that
makes masks also carries `cutout.parallel`, how many span calls it ran at a time (`cutoutPool`); its
`exec modnet-entry` spans overlap under it, one per span made.

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
  way the step row reads it, so the step's CPU is the sum of its calls' and its peak the largest,
  or the total of the calls that ran at the same time);
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
│  └─ r2.get                       one per object read (the edit, the footage, the masks)
├─ render.build                    render.page_bytes, render.assets
├─ render.encode                   render.duration_seconds
│  └─ exec hyperframes             the tool call's exec attributes (CPU, peak, exit)
├─ render.upload                   render.mp4_bytes, render.key
│  └─ r2.put                       the MP4's upload: r2.kind export, r2.bytes, r2.outcome
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

### R2 reads and writes (`r2.get`, `r2.put` spans)

`src/traced-storage.ts` `tracedStorage` wraps the worker's storage (`process-job.ts`, under the
recording storage of `app_docs/storage.md`), so every object a job reads or writes is one span, a
`CLIENT` span under the step or stage that made the call (`activeSpanContext`), or under the job's
span outside any step. `packages/storage` is shared with the studio and does not know OpenTelemetry:
the wrapping is the worker's.

- `r2.get`: `get` and `getFile`. `r2.put`: `put`, `putIfAbsent`, `putFileIfAbsent` and
  `completeMultipartUpload`. The span's duration is the call's.
- `r2.operation`: the storage method.
- `r2.kind`: what the key holds, from its layout: `cache` (a pipeline output), `source` (the raw
  footage), `version`, `export`, `library` (a photo) or `other`. For `cache`, `r2.cache_step` is the
  step that made the object.
- `r2.bytes`: the bytes read, or the bytes offered for writing (a file's size for the two file
  methods).
- `r2.outcome`: `ok` or `missing` for a read; `written`, `exists` (the key was taken and nothing was
  replaced) or `missing` (an unknown multipart upload) for a write; `aborted` when the call's signal
  stopped it (no error status); `error` otherwise, with an error status, `error.type` and an
  `exception` event.
- `r2.multipart_parts`: the parts of a completed multipart upload. The worker's own writes are each
  one PUT (`packages/storage/src/r2.ts`), so they carry no part count; the browser's multipart
  upload of the footage is the studio's and is not a worker span.
- `head`, `list`, `delete` and the signing methods move no object bytes and are not spans.
- Never on the span: the key, a reel's id in a path, a file name.
- Under `E2E_MOCK_STORAGE` the same spans wrap the folder-backed fake.

TraceQL: `{ name = "r2.put" && span.r2.kind = "export" }` for the exports' uploads,
`{ name =~ "r2\\..*" && duration > 5s }` for the slow transfers.

### Resource metrics

What limits a step (CPU, memory, disk, the network to R2, or the database) is read from the
container's own counters, next to the reel's trace. Local development only.

What is collected:

- cAdvisor (`gcr.io/cadvisor/cadvisor`, pinned in `docker-compose.monitoring.yml`, the `cadvisor`
  service, no host port) reads the kernel's per-container counters (cgroups) for every container of
  the machine, the worker (`edit-issebya-worker-worker-1`) and the Supabase database
  (`supabase_db_edit-issebya`) among them. Prometheus in the otel-lgtm container scrapes it every
  10 seconds (`monitoring/prometheus.yaml`). Each series carries the container's `name`.
- CPU: `container_cpu_usage_seconds_total` (and `_user_`, `_system_`), as a rate: seconds of CPU per
  second, so 1 is one core busy.
- Memory: `container_memory_working_set_bytes` (what cannot be given back without swapping or a
  kill), `container_memory_rss`, `container_memory_cache` (page cache).
- OOM kills: `container_oom_events_total`, read from the kernel log (`/dev/kmsg`).
- Disk: `container_fs_reads_bytes_total` and `container_fs_writes_bytes_total`.
- Network: `container_network_receive_bytes_total` and `container_network_transmit_bytes_total` of
  `eth0` (the kernel's idle tunnel devices are dropped at scrape time).
- Waiting: `container_pressure_cpu_waiting_seconds_total`, `container_pressure_io_waiting_seconds_total`
  and `container_pressure_memory_waiting_seconds_total` (the kernel's pressure stall information):
  the time at least one process of the container waited for a CPU, for the disk or for memory.
- The machine: `machine_cpu_cores` and `machine_memory_bytes`, the dashed reference lines.
- The export (`render` job) is a step like any other: its Chrome and ffmpeg run inside the worker
  container, so the container's metrics cover them, and its upload is the `r2.put` span under
  `render.upload`.

What is not there, and why:

- CPU throttling (`container_cpu_cfs_throttled_seconds_total`): the kernel counts it only for a
  container with a CPU limit, and `compose.yaml` sets none, so the series does not exist and the
  dashboard's throttling line stays empty. This is not a Mac limit. A container without a limit is
  never throttled; it competes for cores, and that shows as CPU waiting (pressure).
- A memory limit line: the containers have no memory limit, so the only ceiling is the VM's total.
  An OOM kill then happens when the whole VM runs out, and the kernel picks the victim.
- OOM kills were checked as a series (0 for both containers), not by forcing a kill.

On a Mac, Docker Desktop runs every container in one Linux VM, and cAdvisor runs in it too:

- "The machine" is the VM (8 CPUs and 7.75 GiB on the owner's Mac, Docker Desktop, Settings,
  Resources), never macOS. 800% CPU is the VM's eight cores busy.
- Nothing that runs on macOS is measured: the landing page, the studio, the browser. When they keep
  the Mac's cores busy, the VM's cores run slower and a step takes longer with no sign of it here.
- Disk bytes are the VM's virtual disk: the scratch volume, the image and the database's volume.
  Folders mounted from the Mac (the worker's source folders) are not block devices and are not
  counted. A buffered write is counted when the kernel writes it out, which can be after the step.
- Network bytes are everything through the container's interface: R2, OpenRouter, the database and
  the OTLP export together. The `r2.get` and `r2.put` spans say how much of it was R2.
- The numbers do not predict a Linux server: the VM's disk and network go through macOS.

The dashboard, "Worker resources" (`monitoring/grafana/dashboards/worker-resources.json`):

1. Open `http://localhost:3300/d/worker-resources` (`yarn dev:studio` prints the link).
2. Put the reel's id without dashes in `reel` (its trace id, `traceIdForReel`) and set the time range
   to cover the reel's jobs.
3. Top rows, the worker container: CPU as a percentage of one core with the VM's cores as the dashed
   line, memory with the VM's total as the dashed line, network (received up, sent down), disk (read
   up, written down), waiting and throttling, OOM kills; then the database container's CPU, disk
   writes and disk waiting.
4. "Steps on the metrics' time axis": one row per step name and one bar per run of that step, from
   its start to its end, on the same time axis as the panels above (the crosshair is shared). Read a
   step's resources straight above its bar. A step that runs inside another (`cutout` inside
   `decide`) has its own row.
5. "Per step": one row per `step` span with its start and end, its wall time, CPU time, average
   cores (`step.cpu_ms / step.wall_ms`), peak memory and bytes in and out: the step row's own
   measurements, read from the span (no database connection from Grafana). "Jobs": the queue wait
   (`job.queue_wait_ms`) and the run time of each job. "R2 reads and writes": each transfer's bytes,
   time and speed (bytes divided by the span's duration).
6. "The reel's trace": the whole trace, as in Explore.

How to read a step:

| The step shows                                              | It is limited by                    |
| ----------------------------------------------------------- | ----------------------------------- |
| CPU near the dashed line, average cores near the core count | CPU (more cores help)               |
| CPU near 100%, average cores near 1                         | one thread (more cores do not help) |
| Working set climbing to the dashed line, memory waiting     | memory                              |
| Low CPU, busy network, long `r2.get` or `r2.put` spans      | the network to R2                   |
| Low CPU, busy disk, disk waiting                            | the VM's disk                       |
| Low worker CPU, busy Postgres CPU or Postgres disk waiting  | the database                        |
| Low everything, a long `chat` span                          | the AI call                         |

The timeline and the three tables read the reel's whole trace by id, never a search: the "Tempo
trace JSON" data source gets `/api/traces/<trace id>` from Tempo, and a JSONata expression in each
panel (`root_selector`) keeps the spans it wants and turns their attributes into columns. So the
tables show every span of the reel whatever the time range is (the time range only moves the
timeline and the metric panels), with no limit on the number of spans. An empty or unknown `reel`
shows a 404 error on the four panels. On the timeline each step sends two rows, its name at the
start and `idle` at the end (drawn transparent), and the rows are split by step name: a bar stops
where the step stopped, not where the next one starts. A step colour on the timeline comes from the
dashboard's list of step names (`resource-dashboard.test.ts` fails when a step name has none).

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
- R2 spans: `traced-storage.test.ts` (the kind from the key's layout and nothing of the key itself, a
  step's reads and writes under the step, a stage's under the stage, a call outside any step under
  the job, a file's size as the bytes, `missing` and `exists`, the parts of a multipart upload, a
  failed call marked and rethrown unchanged, an aborted download not an error, no span for `head`,
  `list` and `delete`, no exporter). `telemetry.test.ts` (`job.queue_wait_ms`).
- The resources dashboard: `resource-dashboard.test.ts` (the uid `yarn dev:studio` links to, the
  container names against `compose.yaml` and `supabase/config.toml`, the three data sources, the
  10-second query interval against the scrape interval, the Infinity plugin pinned and installed in
  the background, the trace JSON data source on Tempo's port, the timeline and the three tables
  reading the whole trace by id, each step's explicit end on the timeline and a row per step name, a
  colour per step name, the span attributes it reads). The metrics themselves are checked by hand, see Notes.
- Tool calls: `step-runner.test.ts` (`exec spans`: one span per call under the step, the row's CPU and
  peak equal to the calls'; `runToolsStep`: calls run at the same time counted together in the peak; a script's name and subcommand with no path, the parent a call names, a
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
- Never make `packages/storage` depend on OpenTelemetry: the studio shares it. Storage spans are
  made in the worker (`traced-storage.ts`).
- Never put a storage key, a reel's id from a path or a file name on an `r2.*` span: the kind, the
  cache step, the bytes and the outcome only.
- Never let an `r2.*` span change a storage call: its answer and its error pass through unchanged.
- Never read the container metrics as the Mac's: on a Mac they are the Docker VM's.
- Never read a reel's spans for the dashboard with a TraceQL search: read the whole trace by id.
- Never install a Grafana plugin without a pinned version, and never with
  `GF_PLUGINS_PREINSTALL_SYNC`: a failed download then stops Grafana and the whole container.
- Never use `latest` for a monitoring image, and never edit a provisioned dashboard only in the
  Grafana UI: the JSON file in `monitoring/grafana/dashboards/` is the source.
- Never publish cAdvisor's port to the host: it reads every container of the machine.
- Never put a tool call's command line, its arguments, its stdin or its environment on its `exec`
  span: the executable's base name, the argument count, a plain-word subcommand and the measurements
  only. A prompt, a schema, an answer or a reel's path never reaches a span.

## Notes

- The step names are the list in `apps/worker/src/step-names.ts`. `first_version` and `restore` run
  in-process, so their rows carry `wall_ms` only.
- Group sampling is as fine as one second; the report's max RSS still bounds short single-process peaks.
- A TraceQL search of a reel's trace misses spans: the trace sits in more than one Tempo block and the
  search answers from some of them (on reel 80fd7cbe, the regex `name =~ "step .*"` found 9 of its 16
  step spans, `name = "r2.put"` 19 of 20). Reading the trace by id returns all of it, but Grafana's
  built-in transformations cannot turn a span's tag list into columns, hence the Infinity plugin.
- The timeline's first form (one row, a null value at each step's end) drew each bar until the next
  step's start on the owner's dashboard and hid `cutout` behind `decide`. The explicit `idle` state
  and the row per step name replaced it.
- The Infinity panels were checked by hand in a throwaway otel-lgtm container (same mounts and
  plugin setting, another port) holding a copy of reel 80fd7cbe's trace: 16 step rows over both jobs,
  2 jobs (queue waits 8799 ms and 221 ms), 40 R2 rows (20 `r2.put`), `cutout` ending inside `decide`.
  A first start without the network keeps the container up with the background setting and stops it
  with the synchronous one.
- The trace's root is virtual; PostHog groups by trace id, so a reel opens as one timeline.
- `app_docs/studio.md` (Worker, Live status) and `app_docs/analytics.md` (landing rules unchanged) are the
  neighbouring features this change touches.
- The per-step table reads the step measurements from the `step` spans, not from the `steps` table: a
  Postgres data source in Grafana would need a login role that bypasses row level security and a
  password in the repository. A reel whose jobs ran while monitoring was down has rows and no spans.
- Checked by hand on the owner's Mac (Docker Desktop 29, containerd image store, cgroup v2):
  cAdvisor needs the Docker socket and the containerd socket mounted to name the containers; every
  series listed under Resource metrics answered for the worker and the database container through
  Grafana's Prometheus proxy.
- Out of scope: the data warehouse source and dashboard, AI token and cost values, any real video
  step. Step progress and time left are in `app_docs/status.md`.
