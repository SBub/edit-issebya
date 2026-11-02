# Feature: measure every pipeline step, one trace per reel, studio events under the logged-in user

## Metadata

issue_number: `28`
adw_id: `dcfd8f84`
issue_json: `{"number":28,"title":"feat: measure every pipeline step (time, CPU, memory, bytes), one trace per reel, studio events under the logged-in user"}`

## Feature Description

Reel studio MVP, slice 5 of 17. From the very first reel, the owner must know what every reel
costs to make, step by step. Every step the worker runs goes through one step runner that starts
the tool as its own child process and, when it exits, saves on the step's `steps` row: wall-clock
time, CPU seconds reported by the operating system for that process (user + system), peak resident
memory, and the sizes of the files it read and wrote, plus one short summary line for the studio's
step log (`background removed, 6 minutes 47 seconds, 51 MB`) and, on failure, the tail of its
output. For the render step (later) the runner can also sample the memory of the whole process
tree every second and store the peak. New columns for the decide step's AI usage are added now
(filled by slice 10).

The full output of every step goes to PostHog as OpenTelemetry logs, and each reel is one trace
(trace id derived from the reel uuid) with one span per job and one child span per step. Step
measurements are never sent to PostHog as events: PostHog reads the tables as a data source.

The studio gets its own PostHog start-up: same project as the landing page, super property
`app: "studio"`, `identify` with the Supabase user id, memory-only persistence, and it ignores the
landing page's `?notrack` opt-out. One `capture` helper sends `studio_*` events; the first,
`studio_footage_uploaded`, is sent when an upload finishes. The reel page's step log shows each
step's summary and, for a failed step, its error tail collapsed.

## User Story

As the studio's owner
I want every step of every reel measured (time, CPU, memory, bytes) and traced, and my studio clicks attributed to my account
So that I know what each reel costs to make from the first one, can open a slow or failed reel as one timeline, and the studio funnel fills with known users

## Problem Statement

Steps today record only a name, a status and a free-text summary, and the only step (`receive`)
runs in-process. There is no way to know how long a step took, how much CPU or memory it used or
how many bytes it moved, no log of a tool's output outside the worker's terminal, and no timeline
per reel. The studio sends no analytics at all, so there is no funnel, and the landing page's
analytics (cookieless, honours `?notrack`) cannot simply be reused: the studio needs a known user,
and the owner, its only user, has the opt-out set.

## Solution Statement

- **One step runner** in `apps/worker/src/step-runner.ts`. `runStep` creates the row, spawns the
  tool under `/usr/bin/time` (`-l` on macOS, `-v` on Linux) through a tiny `sh -c 'exec "$0" "$@" 2>&3'`
  wrapper so the tool's stderr goes to fd 3 and the time report alone goes to fd 2 (no parsing of
  a mixed stream), streams stdout and stderr lines to the OTel logger, and on exit writes
  `wall_ms` (Node `performance.now()`), `cpu_ms` (user + sys from the report), `peak_rss_bytes`
  (max RSS from the report, bytes on macOS, kilobytes times 1024 on Linux), `bytes_in` and
  `bytes_out` (sum of `stat` sizes of the declared input files before the run and output files
  after), the summary line and, on failure, the error tail. `/usr/bin/time` reports
  `RUSAGE_CHILDREN`: CPU summed over every reaped descendant, and max RSS of the largest single
  one. That is per process, never the whole machine.
- **Justification of the OS source.** Node exposes no `rusage` for a child (`process.resourceUsage()`
  is the worker's own), and sampling `ps` would miss short peaks and measure wall-time-ish CPU.
  `/usr/bin/time` is the kernel's `wait4` accounting for exactly the spawned tree, on both
  platforms, with no native dependency. Both report parsers are pure functions tested against
  captured fixtures, and the real-process tests run on macOS (developer, pre-push) and Linux (CI).
- **Group sampling** (`sampleGroupMemory: true`): every 1000 ms the runner runs
  `ps -A -o pid=,ppid=,rss=`, walks the tree from the spawned pid, sums RSS (kilobytes on both
  platforms) and keeps the peak; the stored `peak_rss_bytes` is the larger of that peak and the
  time report's max RSS. Without the option the stored value is the largest single process, which
  is the negative test.
- **In-process work.** The skeleton's `receive` (an R2 HEAD) stays in-process and is recorded with
  wall time only: `cpu_ms`, `peak_rss_bytes`, `bytes_in`, `bytes_out` stay null, because a HEAD
  reads and writes no file and moving one HTTP call into a child would measure Node's start-up,
  not the step. `runInProcessStep` is the runner's second entry point for that and shares the row,
  summary, tail and span code.
- **Migration** adds the nine columns to `steps`, nothing else.
- **Summary and tail** are pure functions in `apps/worker/src/summary.ts`.
- **Telemetry** (`apps/worker/src/telemetry.ts`): an explicit `createTelemetry(env)` that builds a
  `NodeTracerProvider` and a `LoggerProvider` with OTLP HTTP exporters only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` are both non-empty (URLs
  `<endpoint>/v1/traces` and `<endpoint>/v1/logs`, headers parsed from the `k=v,k2=v2` form,
  service name from `OTEL_SERVICE_NAME`); otherwise providers with no processor (nothing exported,
  nothing fails). It is created per worker process and passed down (never at module load, never
  registered globally), and `shutdown()` flushes before `once` exits. `traceIdForReel(uuid)` is the
  uuid without dashes, lowercased. The job span is started under a remote parent span context
  carrying that trace id (span id derived from the last 16 hex digits of the reel id, sampled), so
  every job of the reel, at any time, lands in the same trace; each step is a child span of the job
  span with `reel.id`, `job.id`, `step.name` and the measurement attributes. Each output line is a
  log record emitted with the step span's context, so it carries its trace and span ids.
- **Studio**: `apps/studio/instrumentation-client.ts` plus `apps/studio/src/lib/analytics.ts`
  (gate and init options, no `posthog-js` import, adapter pattern of `apps/web`) and
  `apps/studio/src/lib/track.ts` (`capture`, `identify`, test hook). Persistence is
  `persistence: "memory"`: `cookieless_mode: "always"` cannot carry an identified user, and
  `posthog-js` 1.438.12 (`@posthog/types` `PostHogConfig.persistence` accepts `"memory"`, and
  `identify(new_distinct_id: string, ...)` has no persistence precondition) keeps the distinct id
  in memory, so the studio identifies on every signed-in page load and writes no cookie or storage.
  `StudioIdentify` (client component) calls `identify(user.id)` on the home page and the reel page.
  `LiveReel` renders the summary and a collapsed `<details>` for a failed step's tail.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; the "Run the worker locally" section gains the `/usr/bin/time`
  requirement (GNU `time` on Linux).
- `AGENTS.md`: rules (Yarn only, no em-dashes, turbo strict env, docs layout).
- `.adw/project.md`: the profile; Tests section names the worker unit layer and the studio suites.
  Update it if a new spec or test file is worth naming (the studio's `step-log.spec.ts`).
- `docs/conditional-docs.md`: add one line for `app_docs/measurement.md`.
- `app_docs/studio.md`: matches this task (steps table, `apps/worker`, the studio's tests). Its Rules
  ("never put large content in rows (logs in PostHog)", "never poll from the studio", "never point a
  test at real R2, a real AI or the hosted project") bind this change. Update the Worker and Live
  status sections and point to `measurement.md`.
- `app_docs/analytics.md`: matches (adding events). The landing page's rules must not change; add a
  short pointer that the studio's events and opt-out behaviour live in `app_docs/measurement.md`.
- `supabase/migrations/20261031174750_job_queue.sql`: the `steps` table being extended.
- `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`,
  `apps/worker/eslint.config.mjs`, `apps/worker/.env.example` (already holds the three `OTEL_*`
  names; keep them exactly).
- `apps/worker/src/steps/receive.ts` and `receive.test.ts`: `StepStore` and the placeholder step,
  moved onto `runInProcessStep`.
- `apps/worker/src/process-job.ts`, `run-job.ts`, `once.ts`, `main.ts`: wire telemetry and the job
  span; flush on exit.
- `apps/worker/src/format.ts`, `apps/worker/src/errors.ts`: existing `formatBytes` (reuse) and the
  job-level `errorTail` (unchanged for jobs).
- `apps/studio/src/components/LiveReel.tsx`: the step log.
- `apps/studio/src/lib/jobs.ts`: `STEP_COLUMNS`, `StepRow`.
- `apps/studio/src/components/UploadForm.tsx`: sends `studio_footage_uploaded`.
- `apps/studio/src/app/page.tsx`, `apps/studio/src/app/reels/[id]/page.tsx`: render `StudioIdentify`.
- `apps/studio/package.json`, `apps/studio/.env.example` (already holds the two
  `NEXT_PUBLIC_POSTHOG_*` names).
- `apps/studio/e2e/upload.spec.ts`, `apps/studio/test-support/worker.ts`,
  `apps/studio/test-support/fixtures.ts`: the E2E to extend and its helpers.
- `apps/studio/db-tests/rls.test.ts`: pattern for a DB test on `steps`.
- `apps/web/instrumentation-client.ts`, `apps/web/src/lib/analytics.ts`, `apps/web/src/lib/track.ts`,
  `apps/web/src/lib/track.test.ts`, `apps/web/e2e/events.ts`: patterns to mirror (not to change).
- `turbo.json`: no new variable is read by a turbo task (see Notes); verify.
- `knip.json`: the studio's `instrumentation-client.ts` must be seen as an entry (the `next` plugin
  covers it, as in `apps/web`).
- `.github/workflows/ci.yml`: make sure GNU `time` is present before `yarn test`.
- `node_modules/next/dist/docs/`: read the `instrumentation-client` guide before adding the studio's
  file.
- `node_modules/@posthog/types/dist/posthog-config.d.ts` and `posthog.d.ts`: confirm `persistence`
  and `identify` signatures in the installed version.

### New Files

- `supabase/migrations/20261101090000_step_measurements.sql` (any timestamp later than
  `20261031174750`): the nine columns.
- `apps/worker/src/summary.ts`, `apps/worker/src/summary.test.ts`: `formatDuration`,
  `stepSummary`, `outputTail`.
- `apps/worker/src/time-report.ts`, `apps/worker/src/time-report.test.ts`: `timeCommand(platform)`,
  `parseBsdTimeReport`, `parseGnuTimeReport`.
- `apps/worker/src/process-tree.ts`, `apps/worker/src/process-tree.test.ts`: `parsePsTable`,
  `treeRssBytes(table, rootPid)`, `sampleTreeRss(rootPid)`.
- `apps/worker/src/step-runner.ts`, `apps/worker/src/step-runner.test.ts`: `runStep`,
  `runInProcessStep`, the `StepStore` measurement types (moved from `receive.ts`).
- `apps/worker/src/step-store.ts`: `supabaseStepStore` (moved from `receive.ts`, extended).
- `apps/worker/src/telemetry.ts`, `apps/worker/src/telemetry.test.ts`: `createTelemetry`,
  `traceIdForReel`, `jobSpan` helpers.
- `apps/studio/instrumentation-client.ts`: the studio's PostHog start-up.
- `apps/studio/src/lib/analytics.ts`, `apps/studio/src/lib/analytics.test.ts`: gate, init options,
  super property.
- `apps/studio/src/lib/track.ts`, `apps/studio/src/lib/track.test.ts`: `capture`, `identify`,
  `STUDIO_EVENTS`, test hook.
- `apps/studio/src/components/StudioIdentify.tsx`: identifies the signed-in user.
- `apps/studio/e2e/events.ts`: the studio's copy of `recordEvents` (apps do not import each other).
- `apps/studio/e2e/step-log.spec.ts`: a failed step shows its collapsed tail.
- `apps/studio/db-tests/steps-measurements.test.ts`: the column set of `steps` and a worker write.
- `app_docs/measurement.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Migration, dependencies, and the pure functions (summary, tail, time-report parsers, process-tree
parser, trace id), each with unit tests. Nothing wired yet.

### Phase 2: Core Implementation

The step runner (real child processes, OS measurements, group sampling, bytes, failure tail,
abort), the Supabase step store with measurement columns, and telemetry (providers, exporters gated
on the env, job and step spans, log records with span context).

### Phase 3: Integration

`receive` on `runInProcessStep`, the job span in `processJob`, telemetry created in `once` and
`main` and flushed on exit, `runWorkerOnce` with OTLP variables blanked. Studio: PostHog start-up,
`capture`, `identify`, `studio_footage_uploaded`, the step log. E2E and DB tests, docs, CI.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md`, `app_docs/analytics.md`, and the Next `instrumentation-client` guide
  under `node_modules/next/dist/docs/`.
- Confirm in `node_modules/@posthog/types/dist/posthog-config.d.ts` that `persistence` accepts
  `"memory"` and in `posthog.d.ts` that `identify(new_distinct_id: string, ...)` exists. Record the
  version (`posthog-js` 1.438.12) in the doc.

### 2. Migration

- Create `supabase/migrations/20261101090000_step_measurements.sql`:
  ```sql
  -- Per-step measurements (app_docs/measurement.md). Raw numbers only: no column converts machine
  -- measurements to money. ai_cost_usd is the cost Claude Code itself reports, stored as reported.
  alter table public.steps
    add column wall_ms bigint check (wall_ms >= 0),
    add column cpu_ms bigint check (cpu_ms >= 0),
    add column peak_rss_bytes bigint check (peak_rss_bytes >= 0),
    add column bytes_in bigint check (bytes_in >= 0),
    add column bytes_out bigint check (bytes_out >= 0),
    add column ai_input_tokens bigint check (ai_input_tokens >= 0),
    add column ai_output_tokens bigint check (ai_output_tokens >= 0),
    add column ai_cost_usd numeric check (ai_cost_usd >= 0),
    add column ai_model text;
  ```
  No grant change: `authenticated` already has table-level `select` only, and the worker writes
  through the secret key.
- Run `supabase migration up --local`. If it fails, report the error and stop (never reset).

### 3. Dependencies

- `yarn workspace @edit-issebya/worker add @opentelemetry/api @opentelemetry/api-logs @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node @opentelemetry/sdk-logs @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-logs-otlp-http @opentelemetry/resources`
  (registry today: api 1.10.0, sdk-trace-* 2.12.0, sdk-logs 3.0.0, resources 3.0.0, exporters
  0.300.0, api-logs 0.223.0). Check that the peer ranges agree after install (`yarn explain
peer-requirements`); if `sdk-logs`/`resources` 3.x require a different `api-logs` or core line
  than the exporters, pin the newest mutually compatible set. Read the installed `.d.ts` for the
  constructor shapes (2.x: `new NodeTracerProvider({ resource, spanProcessors })`,
  `resourceFromAttributes`, `new LoggerProvider({ resource, processors })`). Do not use
  `@opentelemetry/sdk-node`: it configures itself from many more `OTEL_*` variables than the three
  this issue allows.
- `yarn workspace @edit-issebya/studio add posthog-js@^1.438.12` (same range as `apps/web`).
- Run `yarn install --immutable` afterwards to prove the lockfile is consistent.

### 4. Summary and tail (`apps/worker/src/summary.ts`)

- `formatDuration(ms)`: under 1000 ms `under a second`; otherwise whole seconds, rounded down, in
  words: `1 second`, `47 seconds`, `1 minute`, `6 minutes 47 seconds`, `1 hour`,
  `1 hour 2 minutes` (hours drop seconds), `2 hours 5 minutes 0 seconds` never (zero parts are
  omitted: `2 hours`, `6 minutes`).
- `stepSummary({ what, wallMs, sizeBytes })`: `<what>, <formatDuration(wallMs)>` plus
  `, <formatBytes(sizeBytes)>` when `sizeBytes` is not null (reuse `formatBytes` from `format.ts`,
  `1024` convention). `stepSummary({ what: "background removed", wallMs: 407_000, sizeBytes: 51 * 1024 * 1024 })`
  is exactly `background removed, 6 minutes 47 seconds, 51.0 MB`. Note: `formatBytes` prints one
  decimal (`51.0 MB`); the issue's `51 MB` example is illustrative. Keep `formatBytes` unchanged
  (it matches the studio's `formatBytes`) and put the exact produced string in the table test and
  the doc.
- `outputTail(text)`: last 20 lines of the combined output (trailing blank lines trimmed); if that
  is longer than 4096 bytes in UTF-8, keep the last 4096 bytes, cut forward to the next line start
  or character boundary so no character is split. Whichever is shorter wins.
- Remove `receivedSummary` from `format.ts` (its replacement is `stepSummary`); update
  `format.test.ts`.
- `summary.test.ts`: a table of inputs to exact strings (including the example above, `0 ms`,
  `999 ms`, `1000 ms`, `61_000`, `3_600_000`, `3_720_000`, null size, `512` bytes), and tail cases:
  100 numbered lines gives lines 81 to 100 and not line 1; 20 lines of 1000 characters gives at most
  4096 bytes ending with the last line; multibyte characters are never split.

### 5. Time report (`apps/worker/src/time-report.ts`)

- `timeCommand(platform)`: `darwin` gives `["/usr/bin/time", "-l"]`, `linux` gives
  `["/usr/bin/time", "-v"]`, anything else throws `step runner: no per-process measurement on <platform>`.
- `parseBsdTimeReport(text)`: from `<real> real <user> user <sys> sys` and
  `<n>  maximum resident set size` returns `{ cpuMs: round((user + sys) * 1000), peakRssBytes: n }`.
- `parseGnuTimeReport(text)`: from `User time (seconds): x`, `System time (seconds): y`,
  `Maximum resident set size (kbytes): k` returns `{ cpuMs, peakRssBytes: k * 1024 }`. It ignores
  `Command exited with non-zero status N` and `Command terminated by signal N`.
- Both return `null` when the lines are missing (the tool could not start), and the runner then
  stores null CPU and memory rather than zeros.
- `time-report.test.ts`: fixtures copied from a real run on each platform (the macOS block above
  this plan was captured with `/usr/bin/time -l true`; capture a GNU `-v` block from its man page
  format), including a non-zero exit.

### 6. Process tree (`apps/worker/src/process-tree.ts`)

- `parsePsTable(stdout)`: rows of `pid ppid rssKb`.
- `treeRssBytes(rows, rootPid)`: sum of RSS times 1024 over the root and every descendant (walk
  by ppid, guard against cycles).
- `sampleTreeRss(rootPid)`: `execFile("ps", ["-A", "-o", "pid=,ppid=,rss="])` then
  `treeRssBytes`. `ps` reports RSS in kilobytes on both macOS and Linux.
- `process-tree.test.ts`: pure tests of the parser and the walk (siblings outside the tree are not
  counted, nested grandchildren are).

### 7. Step store (`apps/worker/src/step-store.ts`)

- Move `StepStore` and `supabaseStepStore` out of `steps/receive.ts`. New shape:
  ```ts
  export interface StepMeasurements {
    wall_ms: number;
    cpu_ms: number | null;
    peak_rss_bytes: number | null;
    bytes_in: number | null;
    bytes_out: number | null;
  }
  export interface StepStore {
    start(job: ClaimedJob, name: string): Promise<string>;
    sourceKey(reelId: string): Promise<string | null>;
    done(stepId: string, summary: string, measurements: StepMeasurements): Promise<void>;
    failed(
      stepId: string,
      errorTail: string,
      summary: string,
      measurements: StepMeasurements,
    ): Promise<void>;
  }
  ```
  `done` and `failed` write the measurement columns in the same update as `status`, `summary` /
  `error_tail` and `finished_at`. The AI columns are not written by this slice.

### 8. Telemetry (`apps/worker/src/telemetry.ts`)

- `traceIdForReel(reelId)`: validates a uuid, returns its 32 hex digits lowercased without dashes.
- `createTelemetry(env = process.env)` returns `{ tracer, logger, exporting: boolean, shutdown() }`.
  It reads only `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME`
  (default `edit-issebya-worker`). When both endpoint and headers are non-empty after trimming, it
  adds a `BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint + "/v1/traces", headers }))` and
  a `BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint + "/v1/logs", headers }))`
  (endpoint trailing slash removed; headers parsed from `k=v` pairs separated by commas, values
  URL-decoded as the OTLP spec says). Otherwise no processor at all: no exporter is constructed.
  An optional `spanProcessors` / `logProcessors` argument lets tests inject in-memory exporters.
  Never register the providers globally, never create them at module load.
- `startJobSpan(telemetry, job)`: a remote parent `SpanContext` `{ traceId: traceIdForReel(job.reel_id), spanId: <last 16 hex of the reel id>, traceFlags: TraceFlags.SAMPLED, isRemote: true }`
  set with `trace.setSpanContext(ROOT_CONTEXT, ...)`; the job span `job <kind>` starts under it
  with `reel.id`, `job.id`, `job.attempt`. Returns the span and its context.
- `stepLogger(telemetry, stepContext, attributes)`: `emit({ body: line, severityText: "INFO" | "ERROR" (stderr), context: stepContext, attributes: { reel.id, job.id, step.name, stream } })`.
- `telemetry.test.ts`:
  - the same reel uuid always gives the same 32-hex trace id; two different uuids differ; a
    non-uuid throws;
  - with an `InMemorySpanExporter` (`SimpleSpanProcessor`), running a job with two
    `runInProcessStep` steps gives one job span and two child spans whose `parentSpanContext.spanId`
    is the job span's, all with `traceIdForReel(reel)`; a second job of the same reel shares the
    trace id;
  - with an `InMemoryLogRecordExporter`, a `runStep` child that prints two lines yields two log
    records carrying the step span's trace and span ids;
  - export off (Verification 7): start a local `http.createServer` counting requests; run a job
    with `createTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x" })`
    and with `{ OTEL_EXPORTER_OTLP_ENDPOINT: <server url>, OTEL_EXPORTER_OTLP_HEADERS: "" }`, call
    `shutdown()`: `exporting` is false and the server saw zero requests. Positive control: with both
    set to the local server, after `shutdown()` the server saw `POST /v1/traces` and `POST /v1/logs`.
    The server is local; no test reaches PostHog.

### 9. Step runner (`apps/worker/src/step-runner.ts`)

- Shared context: `{ steps: StepStore, telemetry, jobContext, job, signal }`.
- `runStep(ctx, { name, file, args, cwd?, env?, inputs?: string[], outputs?: string[], sampleGroupMemory?: boolean, describe: string, sizeOf?: "out" | "in" })`
  (`sizeOf` defaults to `"out"`, falling back to in when nothing is written):
  1. `signal.throwIfAborted()`, `stepId = await steps.start(job, name)`, start the step span (child
     of `jobContext`) with `step.name`.
  2. `bytes_in` = sum of `stat(path).size` over `inputs` (null when none declared).
  3. Spawn `timeCommand(process.platform)` + `["/bin/sh", "-c", 'exec "$0" "$@" 2>&3', file, ...args]`
     with `stdio: ["ignore", "pipe", "pipe", "pipe"]`, `detached: true` (own process group), no
     shell interpretation of `args`. Lines of fd 1 (stdout) and fd 3 (tool stderr) go to
     `stepLogger` and to a combined in-memory buffer (cap the buffer at the last 64 KB, enough for
     the tail); fd 2 is the time report.
  4. With `sampleGroupMemory`, `setInterval(1000)` of `sampleTreeRss(child.pid)` keeping the max
     (plus one sample right after spawn); cleared on exit.
  5. On `signal` abort: `process.kill(-child.pid, "SIGTERM")`, then SIGKILL after 5 s; after an
     abort the runner writes nothing more (same rule as today) and rethrows.
  6. On exit: `wall_ms` from `performance.now()`, parse the report for the platform,
     `peak_rss_bytes` = max(report, group peak when sampled), `bytes_out` = sum of output sizes
     that exist (null when none declared). Set every measurement as span attributes
     (`step.wall_ms`, `step.cpu_ms`, `step.peak_rss_bytes`, `step.bytes_in`, `step.bytes_out`), end
     the span (status ERROR on failure).
  7. Exit code 0: `steps.done(stepId, stepSummary({ what: describe, wallMs, sizeBytes }), measurements)`.
     Non-zero or signal: `tail = outputTail(combined)`,
     `steps.failed(stepId, tail, stepSummary({ what: "<name> failed", ... }), measurements)`, then
     throw `new Error("<name> exited with <code>")` whose message includes the tail, so the job
     fails with it too.
- `runInProcessStep(ctx, { name, work: () => Promise<{ what: string; sizeBytes: number | null }> })`:
  same row and span; `wall_ms` only, other measurements null; on throw `errorTail(error)` (the
  existing job helper, then `outputTail` on its text) and rethrow.
- `step-runner.test.ts` (real processes, a recording `StepStore`, `process.execPath` as the tool;
  timeouts of 20 s per test):
  - Verification 1: `node -e` that does `const b = Buffer.alloc(200 * 1024 * 1024, 1)` then spins
    `while (Date.now() - t < 1100)`: `peak_rss_bytes >= 200 * 1024 * 1024`, `cpu_ms >= 500`,
    `wall_ms >= 1000`, status done.
  - Verification 1, second half: `node -e "setTimeout(() => {}, 1000)"`: `wall_ms >= 1000` and
    `cpu_ms < 200`.
  - Verification 2: a child spawning three grandchildren (`spawn(process.execPath, ["-e", hold100MbFor3s])`)
    and waiting for them: with `sampleGroupMemory: true` the stored peak is
    `>= 300 * 1024 * 1024`; without it under `200 * 1024 * 1024`.
  - Verification 3: a child that reads a temp input of exactly 123_456 bytes and writes an output
    of exactly 654_321 bytes: `bytes_in === 123_456`, `bytes_out === 654_321`, summary ends with the
    output size.
  - Verification 4: a child printing `line 1` to `line 100` (half to stderr) then `process.exit(1)`:
    `failed` called, the tail's lines are `line 81` to `line 100`, it does not contain `line 1\n`
    at its start nor the line `line 1`; the runner throws.
  - A tool that does not exist: step failed, CPU and memory null, no crash.
  - An aborted signal mid-run kills the process group and writes neither `done` nor `failed`.

### 10. `receive` on the runner

- `apps/worker/src/steps/receive.ts`: keep its logic (source key, HEAD, signal checks) inside
  `runInProcessStep(ctx, { name: "receive", work })`, returning
  `{ what: "footage received", sizeBytes: object.bytes }`. Its summary becomes
  `footage received, under a second, 12.3 MB`.
- Update `receive.test.ts` to the new store shape: summary string, `wall_ms` a number, the other
  four null.

### 11. Job span and wiring

- `process-job.ts`: takes `telemetry`; starts the job span, passes `{ steps, telemetry, jobContext, job, signal }`
  to `receive`, ends the span with the outcome (`job.outcome` attribute, ERROR status when
  failed).
- `once.ts`: `const telemetry = createTelemetry()`; after `processJob`, `await telemetry.shutdown()`
  before `process.exit` (also on the `no job` path). `main.ts`: create once at start, shut down in
  `stop()` before `process.exit(0)`.
- Update `run-job.test.ts`/`loop.test.ts` only if signatures change.
- `apps/studio/test-support/worker.ts` `runWorkerOnce`: set `OTEL_EXPORTER_OTLP_ENDPOINT: ""` and
  `OTEL_EXPORTER_OTLP_HEADERS: ""` in `childEnv` (before `...env`), so a filled
  `apps/worker/.env.development` can never make a spec export (an empty variable already in the
  environment wins over the env file).

### 12. CI

- In `.github/workflows/ci.yml`, before `yarn test`: a step
  `run: test -x /usr/bin/time || (sudo apt-get update && sudo apt-get install -y time)` with a
  comment that the step runner measures each tool through GNU time.

### 13. Studio analytics

- `apps/studio/src/lib/analytics.ts` (no `posthog-js` import):
  - `STUDIO_SUPER_PROPERTIES = { app: "studio" } as const`.
  - `studioPosthogOptions(host, debug)`: `{ api_host: host, defaults: "2026-01-30", persistence: "memory", disable_session_recording: true, capture_exceptions: true, debug }`.
    Never `cookieless_mode` (it cannot carry an identified user) and never `opt_in_capturing` /
    `opt_out_capturing` (they write consent to storage).
  - `startStudioAnalytics(env: { projectToken, host }, browser: { webdriver } | undefined, client: { init, register })`:
    initialises only when both values are set and `webdriver !== true`, then
    `register(STUDIO_SUPER_PROPERTIES)`. No `NEXT_PUBLIC_VERCEL_ENV` check (the issue gates on the
    two variables, which are empty in development and CI) and no `edit_notrack` / `?notrack` read.
- `apps/studio/instrumentation-client.ts`: reads `process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`
  and `NEXT_PUBLIC_POSTHOG_HOST` literally and calls `startStudioAnalytics` with an adapter over
  `posthog-js`. Comment why the studio ignores `?notrack`.
- `apps/studio/src/lib/track.ts`:
  - `STUDIO_EVENTS = ["studio_footage_uploaded", "studio_preview_opened", "studio_change_requested", "studio_export_requested", "studio_export_downloaded"] as const`,
    `type StudioEvent`.
  - `capture(event: StudioEvent, properties: { reel_id: string } & Record<string, unknown>)`:
    records to the test hook `{ event, properties: { ...STUDIO_SUPER_PROPERTIES, ...properties } }`
    (what PostHog will send, with the super property) only under `navigator.webdriver === true` and
    when `window.__capturedEvents` is an array, then `posthog.capture(event, properties)`. It never
    reads storage.
  - `identify(userId)`: `posthog.identify(userId)` only when `posthog.__loaded`; never the email.
  - The `Window.__capturedEvents` global declaration, as in `apps/web/src/lib/track.ts`.
- `apps/studio/src/components/StudioIdentify.tsx` (`"use client"`): `useEffect(() => identify(userId), [userId])`,
  renders nothing. This syncs an external system, which is what an effect is for. Render it in
  `apps/studio/src/app/page.tsx` (signed-in branch) and `apps/studio/src/app/reels/[id]/page.tsx`
  with `user.id`.
- `UploadForm.tsx`: after `finishUpload` returns `finished`, `capture("studio_footage_uploaded", { reel_id: finished.reelId })`,
  then `router.push`.
- `apps/studio/src/lib/analytics.test.ts`: no init without the token, without the host, or under
  webdriver; init plus `register({ app: "studio" })` otherwise; the options carry
  `persistence: "memory"` and no `cookieless_mode`.
- `apps/studio/src/lib/track.test.ts` (mirrors `apps/web/src/lib/track.test.ts`, `vi.mock("posthog-js")`):
  Verification 9: with a stubbed `localStorage` holding `edit_notrack = "1"` and
  `navigator.webdriver` true, `capture("studio_footage_uploaded", { reel_id: "r" })` pushes
  `{ event, properties: { app: "studio", reel_id: "r" } }` and calls `posthog.capture`; nothing
  recorded without webdriver; `identify` is not called before load and is called with the id after.

### 14. Step log

- `apps/studio/src/components/LiveReel.tsx`: each `step-line` shows `name: <summary>` (or
  `name: <status>` while running without a summary). A failed step shows `name: <summary ?? "failed">`
  and, when `error_tail` is set, a `<details data-testid="step-error-tail">` with
  `<summary>Show error</summary>` and the tail in a `<pre>` (collapsed by default). Still one read
  on open and Realtime updates; no polling.
- `STEP_COLUMNS` and `StepRow` stay as they are (`summary`, `error_tail` are already selected); the
  measurement columns are not shown in this slice.

### 15. E2E

- `apps/studio/e2e/events.ts`: copy of `recordEvents` / `eventsNamed` from `apps/web/e2e/events.ts`
  typed with the studio's `CapturedEvent`.
- Extend `apps/studio/e2e/upload.spec.ts` (Verification 8):
  - `const events = await recordEvents(page)` before the first `goto`; collect
    `page.on("request")` URLs whose host contains `posthog` (and any request to
    `NEXT_PUBLIC_POSTHOG_HOST` if set).
  - after the redirect to the reel page:
    `await expect.poll(() => eventsNamed(events, "studio_footage_uploaded")).toEqual([{ event: "studio_footage_uploaded", properties: { app: "studio", reel_id: reelId } }])`.
  - the step line after `once`: `/receive: footage received, (under a second|\d+ seconds?), \d+(\.\d)? (B|KB|MB)/`.
  - check the row through `admin`: `wall_ms` is a number >= 0, `cpu_ms`, `peak_rss_bytes`,
    `bytes_in`, `bytes_out` null (in-process step).
  - at the end, the PostHog request list is empty.
- New `apps/studio/e2e/step-log.spec.ts`: a test user, `insertReel(admin, { ownerId, status: "failed" })`,
  a `jobs` row (`status: "failed"`) and a `steps` row (`status: "failed"`, `summary: "probe failed, 2 seconds"`,
  `error_tail: "line 99\nline 100"`) through `admin`; sign in, open the reel page: the step line
  shows `probe failed, 2 seconds`, `step-error-tail` is visible but `line 100` is hidden until
  "Show error" is clicked, then visible. Clean up the user in `afterAll`. It fails without the
  collapsed tail (today the tail is shown inline and the summary not at all).

### 16. DB test

- `apps/studio/db-tests/steps-measurements.test.ts`: through `pg` (as the other DB tests connect),
  the columns of `public.steps` in `information_schema.columns` equal exactly the 11 existing plus
  the nine new ones with their types (`bigint` x7, `numeric`, `text`), so a money column added later
  fails the test; the admin client writes `wall_ms`, `cpu_ms`, `peak_rss_bytes`, `bytes_in`,
  `bytes_out` on a step and the owner reads them back; a negative `cpu_ms` is rejected.

### 17. Docs

- New `app_docs/measurement.md`: overview; the step runner and its two entry points; the columns;
  OS sources per platform (`/usr/bin/time -l` bytes on macOS, `-v` kilobytes on Linux, the fd-3
  wrapper, `RUSAGE_CHILDREN` semantics); group sampling (`ps`, 1 s, peak); in-process steps (wall
  only, which and why); summary format with the exact example string; error-tail rule; telemetry
  configuration (three variables, both needed to export), trace id derivation and the remote
  parent, span and attribute names, log records; the studio's PostHog start-up, persistence
  decision (`memory`, version checked), `identify` with the Supabase user id, test hook; the
  events table (`studio_footage_uploaded` sent now with `reel_id`, `app`; the four reserved
  names); testing; Rules:
  - Never write a step measurement twice: never send it to PostHog as an event or a log attribute
    of a product event (span attributes are traces, not events).
  - Never store or emit a price derived from machine measurements; `ai_cost_usd` is only what
    Claude Code reports.
  - Never measure the whole machine for a step.
  - Never rename a `studio_*` event or a property once shipped.
  - The studio never reads `edit_notrack` or `?notrack`.
  - Never use the email as the distinct id.
  - Never initialise PostHog in the studio under `navigator.webdriver` or without both variables;
    never write analytics cookies or storage (no `cookieless_mode`, no opt-in/out calls).
  - Never export OTLP unless both endpoint and headers are set; tests blank them.
  - Never create telemetry providers at module load or register them globally.
- `docs/conditional-docs.md`: `- Read app_docs/measurement.md when changing the step runner, step measurements or their columns, the summary or error-tail rules, OpenTelemetry logs and traces in apps/worker, or the studio's PostHog start-up, identify or studio_* events.`
- `app_docs/studio.md`: Worker and Live status sections mention the runner, the summary format and
  the collapsed tail, with a link to `measurement.md`; add the new spec files to Testing.
- `app_docs/analytics.md`: one line under Events that `studio_*` events are the studio's and are
  listed in `app_docs/measurement.md`; no landing rule changes.
- `README.md`: in "Run the worker locally", one sentence that steps are measured through
  `/usr/bin/time` (present on macOS; `apt-get install time` on Linux).
- `.adw/project.md` Tests: mention `step-log.spec.ts` beside `upload.spec.ts` and that the worker's
  unit tests spawn real child processes under `/usr/bin/time`. Keep the nine headings.

### 18. Validation

- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `apps/worker/src/summary.test.ts`: duration words, summary strings, tail limits.
- `apps/worker/src/time-report.test.ts`: both report formats, missing report, platform choice.
- `apps/worker/src/process-tree.test.ts`: `ps` parsing and tree sum.
- `apps/worker/src/step-runner.test.ts`: real child processes for CPU, memory, group sampling,
  bytes, failure tail, missing tool, abort.
- `apps/worker/src/telemetry.test.ts`: trace id, span tree with in-memory exporter, log records
  with span context, export off against a local HTTP server, positive control.
- `apps/worker/src/steps/receive.test.ts`: updated store shape.
- `apps/studio/src/lib/analytics.test.ts` and `track.test.ts`: gate, options, opt-out ignored,
  test hook, identify.

### Test Coverage

- `apps/worker/src/step-runner.test.ts` (worker unit layer): catches a runner that stores time as
  CPU (the sleeping child), misses memory (200 MB child), ignores the process tree (three
  grandchildren with and without the option), gets byte counts wrong, or keeps the head of the
  output instead of its tail. Nothing measures a step today.
- `apps/worker/src/summary.test.ts` (unit): exact summary strings and tail limits; none exist.
- `apps/worker/src/time-report.test.ts` and `process-tree.test.ts` (unit): the per-platform units
  (bytes vs kilobytes) that a real-process test on one platform cannot cover.
- `apps/worker/src/telemetry.test.ts` (unit): one trace per reel, one span per step, logs linked to
  spans, and no request when export is off.
- `apps/studio/src/lib/track.test.ts` and `analytics.test.ts` (studio unit): the studio ignores
  `edit_notrack`, adds `app: "studio"`, never initialises under webdriver.
- `apps/studio/db-tests/steps-measurements.test.ts` (DB layer): the migration's exact column set,
  so an extra money column fails.
- `apps/studio/e2e/upload.spec.ts` extended (studio E2E): the live step line in the new format,
  `studio_footage_uploaded` with the new reel's id and `app`, no PostHog request.
- `apps/studio/e2e/step-log.spec.ts` (studio E2E): a failed step's summary plus collapsed tail.

### Edge Cases

- Tool missing or not executable (sh exits 127): failed step, null CPU and memory.
- Tool killed by a signal: GNU prints `Command terminated by signal`; still parsed, step failed.
- No inputs or outputs declared: `bytes_in` / `bytes_out` null, not 0; a declared output that was
  not written counts as 0 bytes only if it exists, otherwise excluded (and the step should normally
  have failed).
- Output with no trailing newline, CRLF lines, empty output (tail is empty string, failed step still
  written).
- Very long single line (> 4 KB): tail is the last 4096 bytes without a split character.
- Lease lost mid-step: process group killed, no row write.
- `OTEL_EXPORTER_OTLP_ENDPOINT` with a trailing slash; headers with several pairs or `=` in a value.
- Unsupported platform: the runner throws a clear error at spawn time (the worker runs on macOS).
- A reel id in upper case: trace id lowercased.
- Studio: signed-out pages never identify; `identify` before PostHog loaded is a no-op.

## Acceptance Criteria

- `steps` has exactly the nine new columns, with no other money column; the migration applied with
  `supabase migration up --local`.
- Every step goes through `runStep` or `runInProcessStep`; a child-process step's row carries
  `wall_ms`, `cpu_ms`, `peak_rss_bytes`, `bytes_in`, `bytes_out`, a summary in the form
  `<what>, <duration in words>, <size>`, and on failure an `error_tail` of at most 20 lines and
  4 KB from the end of the output.
- Verifications 1 to 7 and 9 pass as unit tests on macOS and in CI (Linux); 8 passes as E2E.
- With the OTLP endpoint or headers empty, nothing is exported and the worker works unchanged.
- One reel gives one trace id (its uuid without dashes); one job span per job, one child span per
  step, output lines as log records linked to the step span.
- The worker sends no product event.
- The studio initialises PostHog only with both variables and outside webdriver, registers
  `app: "studio"`, identifies with the Supabase user id, uses memory persistence, and ignores
  `?notrack`; `studio_footage_uploaded` is sent with `reel_id` when an upload finishes.
- The reel page shows each step's summary live and a failed step's tail collapsed.
- The landing page's analytics behaviour and docs rules are unchanged.
- `app_docs/measurement.md` exists with the Rules listed, and `docs/conditional-docs.md` has its
  line.
- All gates below pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local` - applies the new migration to the shared local stack before the
  DB and E2E tests (the only database command allowed; on failure report and stop).
- `yarn install --immutable` - the lockfile matches the added dependencies.
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` - ESLint for both changed
  workspaces.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio` - types, including the
  OTel and posthog-js APIs; the worker's build check is its typecheck.
- `yarn knip` - no unused exports, files or dependencies (new OTel and posthog-js deps are used;
  `receivedSummary` removed).
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio` - unit tests, including the
  real-process runner and telemetry tests.
- `yarn turbo run test:db --filter=./apps/studio` - the steps column set and measurement writes on
  the local stack.
- `yarn turbo run build --filter=./apps/studio` - the studio builds with no variables and with the
  new `instrumentation-client.ts`.
- `yarn build` - every workspace still builds (the landing page is untouched but forwards to the
  studio).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - the landing suite and the studio
  suite, including the extended `upload.spec.ts` and the new `step-log.spec.ts`, against the server
  `/prepare_app` started.

## Notes

- New dependencies (via `yarn workspace ... add`): in `@edit-issebya/worker` `@opentelemetry/api`,
  `@opentelemetry/api-logs`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-trace-node`,
  `@opentelemetry/sdk-logs`, `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/resources`; in `@edit-issebya/studio`
  `posthog-js` (`^1.438.12`, as in `apps/web`). Registry versions seen while planning: api 1.10.0,
  sdk-trace-* 2.12.0, sdk-logs 3.0.0, resources 3.0.0, exporters 0.300.0, api-logs 0.223.0; check
  peer compatibility after install.
- `turbo.json`: no change needed. The worker's scripts run through `yarn workspace`, not turbo, and
  read `OTEL_*` from `apps/worker/.env.*`; the worker's unit tests pass env explicitly; the specs
  spawn `once` with the OTLP variables blanked, so `test:e2e` must not pass `OTEL_*` through. The
  studio's `NEXT_PUBLIC_POSTHOG_*` are already covered by `NEXT_PUBLIC_*` in `build.env`.
- `POSTHOG_PROJECT_TOKEN` / `POSTHOG_HOST` in `apps/worker/.env.example` stay unused by this slice
  (the worker sends no product events); keep the names as they are.
- Memory persistence means a new anonymous id per page load before `identify`; since every signed-in
  page identifies at once, events sent after load belong to the user. `$pageview` fired before the
  effect runs may be anonymous and is merged by PostHog's identify. Recorded in the doc.
- The PostHog project must accept non-cookieless events from the studio (the landing page's
  cookieless events are unaffected).
- The trace's root is virtual: job spans have a remote parent whose span id is derived from the
  reel id and is never exported. PostHog groups by trace id, so the reel opens as one timeline.
- Group sampling is only as fine as one second; it is meant for the render's long-lived browser
  processes. The time report's max RSS still bounds short single-process peaks.
- The browser surface changes (step log), so E2E covers it; the reviewer should also open the
  `received` sample reel's page (Review section) at 1920x1080 and 375x667 and check the step line
  reads `receive: footage received, ...` and that a long tail does not overflow at 375 px.
- Out of scope: the data warehouse source and dashboard, progress and time-left, AI token and cost
  values, any real video step. Owner steps after merge: apply the migration to the hosted project,
  fill `OTEL_*` in `apps/worker/.env.production`, check one reel as one trace in PostHog project 312096.
