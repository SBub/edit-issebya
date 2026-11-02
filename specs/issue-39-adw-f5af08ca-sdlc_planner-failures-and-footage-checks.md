# Feature: failures and footage checks (one automatic retry, Retry button, waiting for the AI, per-reel job order, refusals)

## Metadata

issue_number: `39`
adw_id: `f5af08ca`
issue_json: `{"number":39,"title":"feat: failures and footage checks: one automatic retry, Retry button, waiting for the AI, per-reel job order, refusals"}`

## Feature Description

Reel studio MVP, slice 16 of 17 (block E of the design). When something goes wrong the owner sees
what happened and what to do:

- **Footage check first.** Every `process` job starts with a `check_footage` step: the source is
  downloaded into the job's scratch folder and probed with `ffprobe`. A file that is not a video,
  has no sound, is not vertical (after applying rotation metadata) or is longer than 90 seconds is
  refused at once with a human message stored on the reel (status `refused`); no other step runs.
- **One automatic retry for transient errors.** A step that fails with a transient error (network,
  R2 or Supabase 5xx and timeouts, a tool killed by a signal) runs once more; a second failure, or
  any non-transient failure, stops the job (`failed`, `error_tail` kept).
- **Retry button.** A failed job shows Retry. It inserts a new job of the same kind and parameters
  with `retry_of_job_id`; every step before the failed one is a fingerprint hit, so it resumes there.
- **Waiting for the AI.** When Claude Code reports a usage limit or a signed-out tool, the job
  becomes `waiting_ai` with a `waiting_reason` and `not_before = now + 15 minutes`; `claim_job` skips
  it until then and the worker keeps taking other reels' jobs. The studio shows
  `Waiting for the AI: <reason>. Next try at HH:MM.`
- **One job at a time per reel, in order,** enforced in `claim_job`. The interim rule of slice 11
  (change box disabled while processing) goes: the box is open during processing and says
  `Your change will run after processing finishes.`
- **Lease plus temporary names, proved** by a spec that SIGKILLs the worker mid-step.

## User Story

As the owner of the reel studio
I want failures to be retried, explained, resumable and ordered, and bad footage refused at once
So that I always know what happened and what to do, instead of a job failing ten minutes later

## Problem Statement

Today `claim_job` takes the oldest claimable job across all reels with no per-reel order, so a
change could run beside its reel's processing (hidden only by an interim UI rule). A step that
hiccups (a 503 from R2) fails the whole job, and the only way back is a new upload. A signed-out or
rate-limited Claude Code fails the decide step like any error. Footage the studio cannot handle
(landscape, silent, too long, not a video) is only discovered by a later heavy step. Nothing proves
that a worker killed mid-step leaves no half-written output behind.

## Solution Statement

- One migration (`supabase migration new failures_and_footage_checks`): reel statuses
  `checking_footage` and `refused` plus `reels.refusal_message`; job status `waiting_ai` with
  `waiting_reason` and `not_before`; `jobs.retry_of_job_id` (unique, owner-insertable, checked by a
  restrictive policy); step status `waiting`; and a replaced `claim_job` with the `not_before` and
  per-reel conditions.
- Worker: a single error classifier (`apps/worker/src/failure.ts`) used by the step runner's
  one-retry loop; a `check_footage` step with the limits in one constants object
  (`apps/worker/src/pipeline/footage-check.ts`); the AI runner recognising "not available" outcomes
  (`AiResult` kind `unavailable`), turned into an `AiUnavailable` error that makes the job wait;
  `runJob` outcomes `refused` and `waiting`; abandoned `running` step rows closed on a re-claim; a
  pipeline step double (`E2E_MOCK_STEPS`, `E2E_MOCK_STEP_FAULT`) so specs can make a step run, fail
  or crash without real tools.
- Studio: the refusal message, the waiting line, a Retry button (server action under RLS) and the
  new change-box rule.
- Tests at each layer: unit (classifier, probe parsing, retry loop, AI recognition, studio
  helpers), tools (real ffmpeg clips), DB (`claim_job` order, `not_before`, retry policy, with an
  automated negative proof), E2E (refusal, Retry, waiting, crash resume).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands; the profile's Tests section lists
  every spec and DB test and must be updated in the same change.
- `docs/conditional-docs.md`: add the `app_docs/failures.md` line.
- `app_docs/studio.md`: jobs, `claim_job`, the lease, doubles (its `claim_job` paragraph says "no
  retry limit yet"; point it to `failures.md`).
- `app_docs/change-requests.md`: the interim one-job-at-a-time rule to replace in place.
- `app_docs/decide-step.md`: the AI runner, `E2E_MOCK_AI_SCRIPT`, the at-most-two-calls rule
  (must still hold with the automatic retry).
- `app_docs/pipeline.md`: fixed steps, fingerprints, `.part` names, `fixtures/pipeline/`.
- `app_docs/measurement.md`: step runner, error tails, step rows.
- `app_docs/storage.md`, `app_docs/status.md`: `worker_status.waiting_reason` (the disk guard's,
  distinct from the new `jobs.waiting_reason`), progress statuses, `claimableJobIds`.
- `app_docs/adw-supabase-stack.md`: how a run applies migrations (`.adw/supabase-stack reset`).
- `supabase/migrations/20261031174750_job_queue.sql`: current `claim_job`, `jobs`/`steps` checks,
  `jobs_claimable_idx`, insert policies.
- `supabase/migrations/20261101135426_pipeline_steps_part_two.sql`: current `reels_status_check`.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: current `steps_status_check`.
- `supabase/migrations/20261101184843_change_restore_jobs.sql`,
  `supabase/migrations/20261101194557_export_render_jobs.sql`: the owner insert grants and policies
  the retry column joins.
- `apps/worker/src/step-runner.ts`: `withStep`, `runToolsStep`, `StepFailure`, `StepError`; the
  retry loop, the `exitSignal` and the waiting row go here.
- `apps/worker/src/step-store.ts`: `StepStore`; add `waiting` and `abandonRunning`, the reel
  status type gains `checking_footage`.
- `apps/worker/src/errors.ts`: `errorTail` (unchanged, reused).
- `apps/worker/src/run-job.ts`: outcomes; add `refused` and `waiting`.
- `apps/worker/src/queue.ts`: `ClaimedJob`, `claimableJobIds`, `endJob`; add `refuseJob`,
  `waitJob`.
- `apps/worker/src/process-job.ts`: wiring of the new deps, `checkFootage: true` for `process`,
  the step double, abandoned rows.
- `apps/worker/src/once.ts`, `apps/worker/src/main.ts`, `apps/worker/src/telemetry.ts`
  (`endJobSpan` takes the new outcomes).
- `apps/worker/src/ai.ts`: `AiResult`, `parseClaudeResult`, `claudeRunner`, `fakeAiRunner`.
- `apps/worker/src/decide/run-decide.ts`: turns `unavailable` into `AiUnavailable`, wraps errors
  from the first AI call on as permanent.
- `apps/worker/src/pipeline/run-pipeline.ts`: the `check_footage` step before the fixed steps, the
  step double hook.
- `apps/worker/src/pipeline/probe.ts` and `probe.test.ts`: `parseProbe` gains rotation, container
  format and attached-picture handling.
- `apps/worker/src/pipeline/atomic.ts`, `convert.ts`, `transcribe.ts`: the `.part` naming the
  crash spec proves.
- `apps/worker/src/pipeline/tools.ts`: `toolPaths().ffprobe`.
- `apps/worker/src/render/render-call.ts`, `apps/worker/src/render/fake-render.ts`: the pattern for
  a double spawned through the step runner.
- `apps/worker/src/version-store.ts`, `apps/worker/src/stored-files.ts`,
  `apps/worker/src/render/export-store.ts`: stores called inside step bodies; their thrown errors
  must keep the Supabase status so 5xx and network failures classify as transient.
- `apps/worker/.env.example`: document the two new test-only variables.
- `apps/studio/src/lib/jobs.ts`, `apps/studio/src/lib/reels.ts`: column lists and status lists.
- `apps/studio/src/lib/change-requests.ts` and its test: `changeBlockedReason` (interim rule).
- `apps/studio/src/app/change-actions.ts`: the server-side copy of the rule.
- `apps/studio/src/components/LiveReel.tsx`, `ChangeRequestForm.tsx`, `VersionList.tsx`: the reel
  page.
- `apps/studio/test-support/worker.ts`, `pipeline-cache.ts`, `ai-script.ts`, `fixtures.ts`,
  `local-supabase.ts`: spec helpers.
- `apps/studio/db-tests/jobs.test.ts`: its two jobs share one reel; under the per-reel order the
  second claim returns nothing, so the newer job moves to a second reel.
- `apps/studio/db-tests/change-jobs.test.ts`: the `pg` direct-connection pattern.
- `apps/studio/e2e/upload.spec.ts`, `step-log.spec.ts`, `disk-guard.spec.ts`: spec patterns
  (upload through the form, spawning `once`, claimable guard).
- `.github/workflows/ci.yml`: CI has no ffmpeg; `check_footage` runs `ffprobe` in every
  `process` job, so the E2E suite needs it.
- `knip.json`: the worker workspace (a spawned-by-path double must not be reported unused).

### New Files

- `supabase/migrations/<stamp>_failures_and_footage_checks.sql` (created with
  `supabase migration new failures_and_footage_checks`, never hand-stamped).
- `apps/worker/src/failure.ts` and `failure.test.ts`: error classes and the transient classifier.
- `apps/worker/src/pipeline/footage-check.ts`, `footage-check.test.ts`,
  `footage-check.tools.test.ts`.
- `apps/worker/src/pipeline/testdata/probe-landscape.json`, `probe-rotated-portrait.json`,
  `probe-rotate-tag.json`, `probe-no-audio.json`, `probe-long.json`, `probe-image.json`,
  `probe-cover-art-audio.json`: ffprobe JSON fixtures for the parser.
- `apps/worker/src/pipeline/step-double.ts` (the `E2E_MOCK_STEPS` switch and its `ToolCall`),
  `apps/worker/src/pipeline/fake-step.ts` (the double's process), `step-double.test.ts`.
- `apps/worker/src/decide/testdata/claude-usage-limit.json`,
  `claude-signed-out.json`, `claude-signed-out-stdout.txt`: the "not available" fixtures.
- `apps/studio/src/lib/failures.ts`, `failures.test.ts`: waiting line, retry eligibility, change
  queue note.
- `apps/studio/src/app/retry-actions.ts`: `requestRetry` server action.
- `apps/studio/src/components/RetryButton.tsx`.
- `apps/studio/db-tests/job-order.test.ts`: per-reel order, `not_before`, waiting re-claim, the
  negative proof.
- `apps/studio/db-tests/retry-jobs.test.ts`: the retry column, unique index and restrictive policy,
  `refused` and `refusal_message`, `waiting_ai` checks.
- `apps/studio/e2e/footage-refusal.spec.ts`, `retry.spec.ts`, `waiting-ai.spec.ts`,
  `crash-resume.spec.ts`.
- `fixtures/footage/landscape.mp4` (2 s, 320x180, with a tone) and
  `scripts/make-landscape-clip.sh` (the ffmpeg command that made it, run by hand).
- `app_docs/failures.md`.

## Implementation Plan

### Phase 1: Foundation

The migration and the worker's error vocabulary. The migration adds every column, status and the
new `claim_job`; `failure.ts` defines the error classes and `isTransient`, which everything else
uses. `parseProbe` learns rotation and container format.

### Phase 2: Core Implementation

Worker behaviour: `check_footage`, the one-retry loop in the step runner, the AI "not available"
path, the new job outcomes and queue writes, abandoned step rows, and the pipeline step double for
specs.

### Phase 3: Integration

Studio: refusal message, waiting line, Retry button and server action, new change rule. Tests at
the DB and E2E layers, CI ffmpeg, docs and the ADW profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the docs and the Next guide

- Read `app_docs/studio.md`, `change-requests.md`, `decide-step.md`, `pipeline.md`,
  `measurement.md`, `storage.md`, `status.md` (Rules sections are invariants), and the installed
  Next server-actions guide under `node_modules/next/dist/docs/` before touching the studio.

### 2. Migration

- `supabase migration new failures_and_footage_checks` (the only `supabase` command allowed besides
  `.adw/supabase-stack reset`). Write in it, with a header comment like the earlier ones:
- `reels`: drop and re-add `reels_status_check` with every current status plus `checking_footage`
  (after `uploaded`) and `refused`; `add column refusal_message text check (refusal_message is null
or char_length(refusal_message) between 1 and 300)`; `add constraint reels_refusal_check check
((status = 'refused') = (refusal_message is not null))`. No new grant: owners still never write
  reel status.
- `jobs`: drop and re-add `jobs_status_check` with `waiting_ai`; add `waiting_reason text check
(waiting_reason is null or char_length(waiting_reason) between 1 and 200)`, `not_before
timestamptz`, `retry_of_job_id uuid references public.jobs (id) on delete set null`; add
  `jobs_waiting_check check ((status = 'waiting_ai') = (waiting_reason is not null) and (status =
'waiting_ai') = (not_before is not null))`; `create unique index jobs_retry_of_job_id_key on
public.jobs (retry_of_job_id) where retry_of_job_id is not null` (one retry per failed job, so a
  double click queues one job).
- Recreate `jobs_claimable_idx` with `where status in ('queued', 'running', 'waiting_ai')`.
- `steps`: drop and re-add `steps_status_check` with `waiting` added.
- `grant insert (retry_of_job_id) on public.jobs to authenticated;` and one restrictive policy
  `jobs: a retry names a failed job of the same reel, kind and parameters` (`as restrictive for
insert to authenticated with check (retry_of_job_id is null or exists (select 1 from public.jobs f
where f.id = jobs.retry_of_job_id and f.reel_id = jobs.reel_id and f.status = 'failed' and f.kind
= jobs.kind and f.request is not distinct from jobs.request and f.restore_version_id is not
distinct from jobs.restore_version_id and f.version_id is not distinct from jobs.version_id))`).
  The existing permissive policies stay unchanged; the restrictive one applies to all of them.
- `create or replace function public.claim_job(p_worker text, p_lease_seconds int)`, same checks
  and signature, body:
  ```sql
  with next as (
    select c.id
    from public.jobs c
    where (
        c.status = 'queued'
        or (c.status = 'waiting_ai' and c.not_before <= now())
        or (c.status = 'running' and c.lease_expires_at < now())
      )
      and (c.not_before is null or c.not_before <= now())
      -- One job per reel at a time, in order: no live job of the reel, and no
      -- older job of the reel still queued, running or waiting for the AI.
      and not exists (
        select 1 from public.jobs o
        where o.reel_id = c.reel_id
          and o.id <> c.id
          and (
            (o.status = 'running' and o.lease_expires_at >= now())
            or (
              o.status in ('queued', 'running', 'waiting_ai')
              and (o.created_at, o.id) < (c.created_at, c.id)
            )
          )
      )
    order by c.created_at, c.id
    limit 1
    for update of c skip locked
  )
  update public.jobs j
  set status = 'running', lease_holder = p_worker,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = j.attempts + 1, started_at = now(),
      waiting_reason = null, not_before = null
  from next where j.id = next.id
  returning j.*;
  ```
  Comment why two concurrent workers cannot run two jobs of a reel: the second sees the first's
  locked row still `queued` (older) and skips its sibling. Re-state the `revoke` and `grant` on
  `claim_job` (service role only).
- Run `.adw/supabase-stack reset` (the profile's rule for a run, which applies the worktree's
  migrations to the ADW stack; the issue's `supabase migration up --local` is the owner's command
  and is forbidden to agents by the profile). If it fails, report the error and stop; never reset
  anything else.

### 3. Error classes and the transient classifier (`apps/worker/src/failure.ts`)

- Classes: `TransientError` (explicit marker, with `cause`), `PermanentError` (explicit opt-out,
  with `cause`), `FootageRefused` (its `message` is the human text), `AiUnavailable` (`reason`).
- `findCause<T>(error, ctor): T | null` walks `error`, `error.cause`, ... (bounded depth 10).
- `isTransient(error): boolean`, walking the cause chain outer to inner, first decisive link wins:
  - `PermanentError`, `FootageRefused`, `AiUnavailable`, `StepError` (schema or check failure):
    not transient.
  - `TransientError`: transient.
  - an object with a string `exitSignal` (a tool killed by a signal, see task 5): transient.
  - Node network codes (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`,
    `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_*`), a `TypeError` whose message is
    `fetch failed`: transient.
  - AWS SDK errors: `$metadata.httpStatusCode >= 500`, `$fault === "server"`, or `name` in
    `TimeoutError`, `RequestTimeout`, `RequestTimeoutException`: transient.
  - an object with numeric `status >= 500` (a Supabase response): transient.
  - otherwise (a tool's non-zero exit with its message, anything unknown): not transient.
- `supabaseFailure(what, { error, status })`: the `Error` the stores throw, a `TransientError` when
  `status >= 500` or `status === 0` (postgrest-js's network failure), else a plain `Error`; message
  `${what}: ${error.message}` as today. Use it in `version-store.ts`, `stored-files.ts` and
  `render/export-store.ts` (the stores called inside step bodies), destructuring `status` from each
  response.
- `failure.test.ts`: each row of the classification, nested causes, an outer `PermanentError` over
  an inner 503 (not transient), `supabaseFailure` for 503, 0 and 400.

### 4. Probe parsing and the footage check

- `probe.ts`: `RawStream` gains `tags?.rotate`, `side_data_list?: { rotation?: number }[]`,
  `disposition?.attached_pic`; `format.format_name`. `Probe` gains `video.rotation` (degrees,
  normalised to 0, 90, 180, 270; side data wins over the tag) and `formatName`. The first video
  stream skips attached pictures (cover art). Existing callers and `probe.test.ts` expectations get
  the two new fields.
- `footage-check.ts`:
  - `export const FOOTAGE_LIMITS = { maxSeconds: 90 } as const` (the one place the limits live; the
    three other rules are yes/no).
  - `displaySize(probe)`: width and height swapped when the rotation is 90 or 270.
  - `formatDuration(seconds)`: ceiling to whole seconds, `2 minutes 10 seconds`, `1 minute 30
seconds`, `45 seconds`, singular forms for 1.
  - `footageRefusal(probe: Probe | null): string | null`, first failing rule wins, in this order,
    with exactly these messages (constants exported for tests):
    - not a video (`null` probe, no video stream, image container such as `image2`, `png_pipe`,
      `*_pipe`, or no duration): `This file is not a video. Upload a clip from your phone (MP4 or
MOV).`
    - no audio stream: `This clip has no sound. The studio needs your voice to make the captions.`
    - not vertical (display height not greater than display width): `This clip is <w> x <h>, not
vertical. The studio takes vertical clips only.`
    - longer than `FOOTAGE_LIMITS.maxSeconds`: `This clip is <duration>; the studio takes up to 1
minute 30 seconds.` (the limit formatted with `formatDuration`).
  - `checkFootage({ tool, tools, path })`: runs `ffprobe` (`probeArgs`) through the step's `tool`;
    a non-zero ffprobe exit (a renamed text file) or unparsable JSON is the "not a video" refusal,
    never a step failure; returns `{ what }` (`footage checked, 0:24, 1080 x 1920`) or throws
    `FootageRefused(message)`.
- `footage-check.test.ts` on the committed ffprobe JSON fixtures (new files listed above, written
  by hand from real ffprobe output shapes; the rotated one with a Display Matrix `rotation: -90`,
  one with `tags.rotate: "90"`): landscape refused, rotated portrait accepted, rotate tag accepted,
  no audio refused, 100 s refused with `1 minute 40 seconds`, image refused, cover-art audio file
  refused as not a video, `sdr-cfr.json` accepted, the order of rules, `formatDuration` cases.
- `footage-check.tools.test.ts` (`test:tools`, real ffmpeg, Mac only): generates in a temp folder
  with `lavfi` (`testsrc2` plus `sine`, `ultrafast`, tiny sizes): a 100 s portrait clip, a 2 s
  landscape clip, a 2 s portrait clip without audio, a landscape clip remuxed with
  `-display_rotation 90` (accepted), and a text file renamed `notes.mp4`; runs `checkFootage`
  through `plainTool`-like real spawning (reuse `tools-test-support.ts`) and asserts each verdict
  and message. Also `fixtures/footage/short-speech.mp4` accepted and
  `fixtures/footage/landscape.mp4` refused. Never read `short-person.mp4`.
- `scripts/make-landscape-clip.sh` and the committed `fixtures/footage/landscape.mp4` (2 s,
  320x180, H.264 plus AAC tone, a few tens of KB).

### 5. The one automatic retry in the step runner

- `StepFailure` gains `exitSignal: NodeJS.Signals | null`, set from `run.exitSignal` when
  `run.code === null` (a tool killed by a signal; never our own abort, which is checked first).
- `StepContext` gains optional `retryDelayMs` (default `TRANSIENT_RETRY_DELAY_MS = 2000`; unit
  tests pass 0).
- `withStep` runs the body at most twice. On a failure: if the lease is lost, rethrow as today; if
  `findCause(error, AiUnavailable)`, write the row `waiting` (task 6) and rethrow; if it is the
  first attempt and `isTransient(error)`, mark that row `failed` with its tail and the summary
  `<name> failed, retrying once`, wait `retryDelayMs`, start a new row and run again; otherwise
  mark the row `failed` as today and rethrow. Each attempt is its own row, so the step log shows
  both. Exactly one automatic retry, never a loop.
- `runToolsStep` keeps wrapping errors in `StepFailure` with `cause`, so the classifier sees the
  original error; a `FootageRefused` keeps its own message as the row's tail (treat it like
  `StepError`: `outputTail(message)`).
- `step-runner.test.ts`: a fake step whose work throws a transient error once (a `TransientError`,
  and separately a fake `spawnTool` returning `{ code: null, exitSignal: "SIGKILL" }` once) runs
  twice and ends `done` with two rows (first `failed`, `retrying once`); a fake tool exit 1 runs
  once and fails; a transient error twice fails after two rows; a lost lease is never retried; a
  `StepError` is never retried.
- `run-pipeline.test.ts`: a storage wrapper over the fake whose `getFile` throws once an error with
  `$metadata: { httpStatusCode: 503 }`: the step's `start` is called twice and the run finishes;
  a fake tool that exits 1: `start` once, the run throws.

### 6. AI "not available" and waiting

- `ai.ts`: `AiResult` gains `{ kind: "unavailable"; reason: string; usage }`. `aiUnavailableReason
(text): string | null` maps `/usage limit|limit reached|hit your limit/i` to `the usage limit is
reached` and `/please run \/login|not logged in|invalid api key|oauth token has expired|
authentication_error/i` to `Claude Code is signed out`. `parseClaudeResult`: an `is_error`
  envelope whose `result` matches is `unavailable`, otherwise `broken` as today. `claudeRunner`
  catches the tool's thrown error (Claude Code exits non-zero on these), and when its message (which
  carries the output tail with stdout) matches, returns `unavailable`; otherwise rethrows.
  `fakeAiRunner` needs no change (it parses the scripted envelope).
- Fixtures `decide/testdata/claude-usage-limit.json` and `claude-signed-out.json` (result
  envelopes with `is_error: true` and the best-known Claude Code texts, `Claude AI usage limit
reached|<epoch>` and `Invalid API key · Please run /login`), and `claude-signed-out-stdout.txt`
  (a non-zero-exit output tail). A comment in `ai.ts` and a note in `failures.md` say they are not
  yet captured on the worker machine; the owner replaces them with the real output during manual
  acceptance (Notes). Note: `·` is a middle dot, not a dash; keep the files free of em-dashes.
- `ai.test.ts`: both fixtures parse to `unavailable` with the expected reason; the non-zero-exit
  path of the real runner through a fake `Tool` that throws with the stdout tail; an unrelated
  `is_error` stays `broken`.
- `run-decide.ts`: an `unavailable` result (first or second call) throws `AiUnavailable(reason)`;
  every other error thrown from the first `ai.call` on is wrapped in `PermanentError` (cause kept),
  so a transient retry never adds AI calls and the decide rule "at most two AI calls" holds. Errors
  before the first call (reading the version, the transcript) classify normally.
  `run-decide.test.ts`: unavailable on the first call throws `AiUnavailable`, nothing written; a
  network error from the AI call is not retried.
- `step-store.ts`: `waiting(stepId, reason, summary, measurements)` writes status `waiting`,
  `error_tail` the reason, summary `<name> waiting for the AI`, `finished_at`; and
  `abandonRunning(jobId)` sets every `running` row of the job to `failed` with tail `the worker
stopped during this step; the job was taken again` and `finished_at`. `PipelineReelStatus`
  gains `checking_footage`.

### 7. Job outcomes and queue writes

- `run-job.ts`: `JobOutcome` adds `refused` and `waiting`; deps add `refuse(message)` and
  `wait(reason)`. In the catch (after the lost-lease check): `findCause(error, FootageRefused)` →
  `refuse`; `findCause(error, AiUnavailable)` → `wait`; otherwise `fail(tail)` as today. Each
  returns `lost` when the guarded write matched no row. `run-job.test.ts` covers both.
- `queue.ts`:
  - `ClaimedJob` gains `retry_of_job_id`.
  - `refuseJob(db, config, job, message)`: job `failed`, `error_tail` the message, lease cleared,
    guarded by holder and `running` like `endJob`; then the reel `refused` with `refusal_message`.
  - `waitJob(db, config, job, reason)`: job `waiting_ai`, `waiting_reason`, `not_before = now +
AI_RETRY_MINUTES` (`export const AI_RETRY_MINUTES = 15`), `lease_expires_at` and `lease_holder`
    null, guarded the same way; the reel's status is left as it is.
  - `claimableJobIds`: also `and(status.eq.waiting_ai,not_before.lt.<now>)`, still `id` only.
  - `queue.test.ts` covers the new writes with the existing fake.
- `telemetry.ts`: `endJobSpan` marks `failed` and `refused` as errors; `waiting` is not.
- `once.ts`: unchanged contract (exit 0 only for `done`, no job or a guarded claim); log the
  outcome.

### 8. `check_footage` in the pipeline and the process job

- `run-pipeline.ts`: option `checkFootage?: boolean` (default false; `render` keeps not checking).
  When true, before the fixed steps: set the reel `checking_footage`, then a `runToolsStep` named
  `check_footage` that downloads the source to `inputs/source` (the same path convert uses), runs
  `checkFootage`, and records the path in `local` so a running convert does not download again. A
  refusal throws out of the run before any fixed step.
- `process-job.ts`: `checkFootage: true` for `process`; `refuse: (m) => refuseJob(...)`, `wait: (r)
=> waitJob(...)`; when `job.attempts > 1`, `steps.abandonRunning(job.id)` before the work.
- `run-pipeline.test.ts`: refused footage (fake ffprobe output of a landscape probe) writes one
  `check_footage` row and no other step row, nothing stored; accepted footage is followed by
  convert with one download.

### 9. Pipeline step double for specs

- `step-double.ts`: `stepDouble(env)` returns `null` unless `E2E_MOCK_STEPS === "true"` exactly.
  Otherwise a function `(step, args) => Promise<{ what }>` used by `runPipeline` (new option
  `runStep`, default the step's own `run`) for a step that must run: it calls `args.tool` with
  `{ file: process.execPath, args: [FAKE_STEP, <fixtures/pipeline/<step>/>, args.dir, ...files] }`
  and returns `{ what: "<step> (double)" }`. It refuses (throws) when the step's fingerprint is not
  the one in `fixtures/pipeline/manifest.json` (the double only knows the fixture clip).
- `E2E_MOCK_STEP_FAULT=<step>:<signal|exit|half>` (read only when `E2E_MOCK_STEPS` is on) is passed
  to the fake for that step only.
- `fake-step.ts` (exits 2 unless `E2E_MOCK_STEPS=true`): copies each fixture output to
  `<dir>/<file>.part` then renames it to `<file>`. Faults: `signal` kills itself with `SIGKILL`
  (a tool killed by a signal); `exit` prints `fake-step: failed on purpose` and exits 1; `half`
  writes the first half of the first output to `<file>.part`, prints `fake-step: half written`,
  then sleeps at most 20 s and exits 1 (the spec kills the worker meanwhile).
- `process-job.ts` passes `runStep: stepDouble(process.env) ?? undefined`.
- `step-double.test.ts`: off unless exactly `"true"`, the fault parsing, the fingerprint refusal,
  the fake's `.part` then rename through a real spawn in a temp folder.
- If `knip` reports `fake-step.ts` unused, add it to the worker workspace's `entry` in
  `knip.json` (as narrow as possible).
- `apps/worker/.env.example`: document `E2E_MOCK_STEPS` and `E2E_MOCK_STEP_FAULT` (tests only).

### 10. Studio data and helpers

- `lib/jobs.ts`: `JOB_COLUMNS` adds `retry_of_job_id, waiting_reason, not_before`;
  `JOB_STATUSES` adds `waiting_ai`; `STEP_STATUSES` adds `waiting`; `JobRow` fields.
- `lib/reels.ts`: `REEL_STATUSES` adds `checking_footage` and `refused`; `REEL_DETAIL_COLUMNS` adds
  `refusal_message`; `ReelDetail.refusal_message`.
- `lib/failures.ts`:
  - `formatWaitingForAi(reason, notBefore: string)`: `Waiting for the AI: <reason>. Next try at
HH:MM.` (24-hour local time, the same two-digit formatting as `formatOfflineSince`).
  - `retryableJobIds(reel, jobs)`: ids of failed jobs no other job names in `retry_of_job_id`; none
    while the reel is `refused`.
  - `changeQueueNote(jobs)`: `Your change will run after processing finishes.` while a `process`
    job is `queued`, `running` or `waiting_ai`; `Your change will run after the jobs before it
finish.` while another job is; else null.
- `lib/change-requests.ts`: replace the interim rule. `changeBlockedReason(reel)` (no jobs
  argument): `refused` → `This clip was refused; upload another clip.`; `uploading` → `Changes open
once the upload finishes.`; `failed` with no `current_version_id` → `Processing failed; press
Retry on the failed job first.`; otherwise null. Update its comment and `change-requests.test.ts`.
- `failures.test.ts` covers every branch, the HH:MM formatting with a fixed date.

### 11. Studio UI and the Retry action

- `app/retry-actions.ts` (`"use server"`): `requestRetry({ reelId, jobId })`. User client, both ids
  checked with `isReelId`; reads the reel (`status`) and the job (`id, reel_id, kind, status,
request, restore_version_id, version_id`) under RLS; refuses unless the job is the reel's and
  `failed` and the reel is not `refused`; inserts `{ reel_id, kind, request, restore_version_id,
version_id, retry_of_job_id }` (only the non-null parameters; the RLS policies and the
  restrictive retry policy decide); a unique violation (`23505`) answers `already` ("This job is
  already being retried."). Result union like `ChangeActionResult`. Logs codes only.
- `components/RetryButton.tsx` (client): a button `Retry` (`data-testid="job-retry"`), disabled
  while sending and after `queued`; an error line beside it.
- `LiveReel.tsx`:
  - a refusal block under the preview when `reel.status === "refused"`: `role="alert"`,
    `data-testid="reel-refusal"`, the `refusal_message`.
  - in each job line: when `waiting_ai`, `data-testid="job-waiting-ai"` with
    `formatWaitingForAi`; when the job is in `retryableJobIds`, the `RetryButton`; when
    `retry_of_job_id` is set, a small `retry` label (`data-testid="job-retry-of"`).
  - the step log's `waiting` rows show their tail like a failed row's (collapsed).
  - `changeBlockedReason(reel)` and `changeQueueNote(jobs)` passed to `ChangeRequestForm` (and the
    reason to `VersionList` as today).
- `ChangeRequestForm.tsx`: new `queueNote` prop shown in the reason line when not blocked
  (`data-testid="change-queue-note"`); `pending` also while the sent job is `waiting_ai`.
- `change-actions.ts`: `openReel` uses the new `changeBlockedReason(reel)` (no jobs read for the
  rule any more).

### 12. DB tests

- `db-tests/jobs.test.ts`: put `newerJob` on a second reel of the same owner so "then the next"
  still holds under the per-reel order; keep the other cases.
- `db-tests/job-order.test.ts` (claimable guard first, like `jobs.test.ts`):
  - reel A with an older `process` and a newer `change` job, reel B with a `process` job between
    them: the first claim takes A's process, the second takes B's (not A's change), a third returns
    nothing; after A's process is set `done`, A's change is claimed.
  - a `waiting_ai` job with `not_before` an hour ahead of the database clock is skipped while
    another reel's queued job is claimed; set to an hour behind, it is claimed with
    `waiting_reason` and `not_before` cleared and `attempts` incremented; while it waits, a newer
    job of its reel is not claimed.
  - an expired lease on A's running job lets A's same job be re-claimed but not A's newer job.
  - **two workers in a loop** (Verification 7): two `pg` clients (each its own session) claim in a
    loop through `select * from public.claim_job($1, 60)`, record start and end, hold each job a
    few milliseconds, then set it `done`; a pure `orderViolations(events)` helper (in the test
    file) asserts A's two jobs never overlap, A's change starts after A's process ended, and B's
    job overlaps A's process at least once.
  - **negative proof**, automated: each client also creates in its own session
    `pg_temp.claim_job_unordered(text, int)` with the old body (no `not_before`, no per-reel
    condition; the text copied from `20261031174750_job_queue.sql`); the same loop through it must
    report at least one violation. Nothing is added to the schema.
- `db-tests/retry-jobs.test.ts`: the owner can insert a retry of their own failed `process`,
  `change` (same request) and `render` (same version) job; refused: a retry of a `done` job, of
  another reel's job, of a different kind, with a different request, of another owner's job, a
  second retry of the same job (unique); the owner still cannot write `status`, `waiting_reason`
  or `not_before`; `reels_refusal_check` refuses `refused` without a message and a message without
  `refused`; `jobs_waiting_check` both ways; step status `waiting` accepted.
- Update `db-tests/rls.test.ts` or `pipeline-statuses.test.ts` only if they enumerate statuses or
  columns that changed.

### 13. Spec helpers

- `test-support/worker.ts`: `claimableJobIds` also counts `waiting_ai` with `not_before` past;
  new `startWorkerOnce(env)` that spawns `once` `detached: true` and returns `{ exited, killGroup()
}` (`process.kill(-pid, "SIGKILL")`), sharing the env building with `runWorkerOnce`.
- `test-support/pipeline-cache.ts`: `seedPipelineCache(storage, prefix, { except?: string[] })`.
- `test-support/ai-script.ts`: `USAGE_LIMIT_SCRIPT` path to the worker's
  `claude-usage-limit.json`.

### 14. E2E specs (each fails without this feature)

- `e2e/footage-refusal.spec.ts` (Verification 2): sign in, upload `fixtures/footage/landscape.mp4`
  through the upload form as `upload.spec.ts` does, open the reel, spawn `once`: without a reload
  `reel-status` reads `refused`, `reel-refusal` reads `This clip is 320 x 180, not vertical. The
studio takes vertical clips only.`, exactly one `step-line` (`check_footage: ...`), no
  `job-retry`, the change box disabled with the refused reason; in the database exactly one
  `steps` row for the reel.
- `e2e/retry.spec.ts` (Verification 4): reel with the fixture clip and a queued `process` job
  inserted as the service role, cache seeded `except: ["transcribe"]`; `once` with
  `E2E_MOCK_STEPS=true`, `E2E_MOCK_STEP_FAULT=transcribe:signal` and the answer script: job
  `failed`, two `transcribe` rows `failed` (first `retrying once`). Open the page: press
  `job-retry`; a new job with `retry_of_job_id` equal to the failed one appears live; `once` with
  `E2E_MOCK_STEPS=true` and no fault: `convert` skipped with `cache_hit`, `transcribe` done without
  `cache_hit`, the job `done`, the reel `processed`, all shown live.
- `e2e/waiting-ai.spec.ts` (Verification 5, UI part): reel and queued job, full cache seeded;
  `once` with `E2E_MOCK_AI_SCRIPT` the usage-limit fixture: the job row is `waiting_ai` with
  `waiting_reason` `the usage limit is reached` and `not_before` about 15 minutes after its
  `started_at`; the page shows `Waiting for the AI: the usage limit is reached. Next try at HH:MM.`
  live (HH:MM computed in the page from `not_before`); the decide row is `waiting`. Then set
  `not_before` an hour in the past, `once` with the normal answer script: the job is claimed
  (`attempts` 2) and ends `done`, the waiting line disappears live. Clean up the job in `afterAll`
  so no `waiting_ai` row is left claimable.
- `e2e/crash-resume.spec.ts` (Verification 6, no page needed): reel and queued job, cache seeded
  `except: ["transcribe"]`, `WORKER_SCRATCH_DIR` a temp folder; `startWorkerOnce` with
  `E2E_MOCK_STEPS=true`, `E2E_MOCK_STEP_FAULT=transcribe:half`; poll the scratch folder until a
  `transcript.json.part` exists, then `killGroup()`. Assert: no object under
  `<prefix>cache/transcribe/`, no `stored_files` row with step `transcribe`. Expire the lease (set
  `lease_expires_at` a minute before `started_at`, database clock as in `jobs.test.ts`). `once`
  with `E2E_MOCK_STEPS=true`, no fault: the job is claimed again (`attempts` 2), the first
  `transcribe` row is `failed` with `the worker stopped during this step`, a second `transcribe`
  row is `done` without `cache_hit`, the stored `transcript.json` has exactly the fixture's bytes
  and one `stored_files` row, the job `done`.
- Run each new spec alone once to check it, then the whole suite in the last task.

### 15. CI

- `.github/workflows/ci.yml`: before the E2E step, `sudo apt-get update && sudo apt-get install
-y ffmpeg` (with a comment: `check_footage` runs ffprobe in every process job the specs run).

### 16. Docs and the ADW profile

- `app_docs/failures.md`: Overview, How it works (the edge cases and their rules from the issue's
  block E, the transient classification table, the one retry and its rows, the Retry button and
  `retry_of_job_id` with its policy, `waiting_ai`, `waiting_reason`, `not_before` and the 15
  minutes, the not-available fixtures and that they still need capturing, the per-reel order in
  `claim_job`, the footage limits and the exact messages, abandoned step rows, the step double),
  How to Use, Configuration (`E2E_MOCK_STEPS`, `E2E_MOCK_STEP_FAULT`), Testing, and Rules: exactly
  one automatic retry and only for transient errors; no heavy step before `check_footage` passes;
  one job per reel at a time, in order, enforced in `claim_job`; fixed steps never wait for the AI;
  no refusal limits beyond the four; never turn the step double on unless its flag is exactly
  `"true"`.
- `docs/conditional-docs.md`: one line for `failures.md` (failures, retries, Retry button,
  `waiting_ai`, `claim_job` order, footage check and refusal messages, the step double).
- `app_docs/change-requests.md`: replace the interim rule in How it works, How to Use and Notes
  with the new one (box open while processing, the queue note, the blocked cases), pointing to
  `failures.md` for the order.
- `app_docs/studio.md`: the `claim_job` paragraph and the doubles list point to `failures.md`.
- `app_docs/decide-step.md`: the runner's `unavailable` result and that a transient retry never
  adds AI calls.
- `.adw/project.md` Tests section: add `job-order.test.ts`, `retry-jobs.test.ts`, the four new E2E
  specs, `footage-check.tools.test.ts`, and that the E2E suite needs `ffprobe` on the PATH (every
  process job checks footage). Headings untouched.

### 17. Validation

- Run every command in `Validation Commands`, in order, and fix anything that fails without
  weakening a test or a rule.

## Testing Strategy

### Unit Tests

- `apps/worker/src/failure.test.ts`: classification and cause walking, `supabaseFailure`.
- `apps/worker/src/pipeline/probe.test.ts`: rotation (side data and tag), format name, cover art.
- `apps/worker/src/pipeline/footage-check.test.ts`: every rule and message on fixture JSON,
  `formatDuration`.
- `apps/worker/src/step-runner.test.ts`: one retry for transient (error and signal), none for exit
  1, `StepError` or a lost lease, two failures stop, the `waiting` row.
- `apps/worker/src/pipeline/run-pipeline.test.ts`: the 503 GET retried, a tool exit not retried,
  refusal leaves one row and stores nothing.
- `apps/worker/src/ai.test.ts`, `decide/run-decide.test.ts`: unavailable recognition and the
  `AiUnavailable` throw, no extra AI calls.
- `apps/worker/src/run-job.test.ts`, `queue.test.ts`: `refused`, `waiting`, `waitJob`,
  `refuseJob`, `claimableJobIds`.
- `apps/worker/src/pipeline/step-double.test.ts`.
- `apps/studio/src/lib/failures.test.ts`, `change-requests.test.ts`.

### Test Coverage

- `footage-check.test.ts` (unit) and `footage-check.tools.test.ts` (tools, Mac): catch a wrong
  verdict or message for landscape, rotated, silent, long or non-video files; nothing probes for
  refusal today.
- `step-runner.test.ts` and `run-pipeline.test.ts` (unit): catch a missing or repeated automatic
  retry, and a retry of a non-transient error; today a 503 fails the job.
- `failure.test.ts` (unit): catches misclassification (the single function every retry decision
  goes through).
- `ai.test.ts` and `run-decide.test.ts` (unit): catch a usage limit or signed-out tool treated as a
  broken answer instead of a wait.
- `job-order.test.ts` (DB): catches two jobs of a reel running together or out of order, and
  `not_before` ignored; its negative proof shows the check fails against the old `claim_job`.
- `retry-jobs.test.ts` (DB): catches an owner inserting a retry of something that is not their own
  failed job with the same parameters, or a second retry.
- `footage-refusal.spec.ts` (E2E): catches the refusal not reaching the page live, or other steps
  running after a refusal.
- `retry.spec.ts` (E2E): catches a Retry that does not resume from the failed step.
- `waiting-ai.spec.ts` (E2E): catches the waiting line missing or the job never being taken again.
- `crash-resume.spec.ts` (E2E): catches a half-written output being stored or treated as a hit
  after a SIGKILL, and a job not resumed after its lease runs out.

### Edge Cases

- Portrait footage stored landscape with rotation 90 or -90 (Display Matrix) or a `rotate` tag:
  accepted. Rotation 180: still landscape if stored landscape.
- Square footage: refused as not vertical.
- Exactly 90.0 s accepted; 90.4 s refused and shown as `1 minute 31 seconds`.
- A renamed text file (ffprobe exits non-zero), an image, an audio file with cover art: "not a
  video", never a step failure.
- Retry of a refused process job: no button; the action refuses it too.
- Double click on Retry: the unique index lets one job through; the second answer is `already`.
- A transient failure during the retry attempt: the job fails (no third run).
- A lease lost mid-step: never retried, nothing written (existing rule kept).
- A decide call that fails transiently after the AI answered: not retried, at most two AI calls.
- A waiting `process` job holds its reel's newer change job; other reels' jobs keep running.
- A change sent while processing waits, then decides from the processed reel's current version.
- A process job taken again after a crash: its abandoned `running` rows end `failed`.
- `waiting_ai` with `not_before` in the past is claimable; the claim clears the reason.
- Clock drift between host and database: tests set `not_before` and leases an hour or a minute away
  on the database clock, never compared with `Date.now()` precisely.

## Acceptance Criteria

- Every `process` job starts with `check_footage`; a refused clip leaves the reel `refused` with the
  exact message, one step row and nothing stored by later steps.
- The four refusal rules and their messages exactly as listed; the 90 s limit in
  `FOOTAGE_LIMITS`; rotation applied.
- A transient step failure runs the step exactly twice at most; a non-transient failure once; the
  job fails with the error tail after the second failure.
- A failed job shows Retry; pressing it inserts a job with `retry_of_job_id` that resumes at the
  failed step (earlier steps are hits). RLS refuses any other retry insert.
- A usage limit or signed-out Claude Code leaves the job `waiting_ai` with the reason and
  `not_before` 15 minutes ahead; the page shows `Waiting for the AI: <reason>. Next try at HH:MM.`;
  the job is taken again after `not_before`.
- `claim_job` never returns a job while another of its reel is live or an older one is queued,
  running or waiting; jobs of other reels are claimed meanwhile.
- The change box is enabled during processing with `Your change will run after processing
finishes.`
- After a SIGKILL mid-step and an expired lease, a second worker re-runs the step and no
  half-written file is stored or recorded.
- `app_docs/failures.md` exists with the Rules listed; the doc index, `change-requests.md`,
  `studio.md`, `decide-step.md` and `.adw/project.md` are updated; no em-dashes anywhere.
- Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset` - applies the new migration to this run's ADW stack before the DB
  and E2E layers (the profile's rule after adding a migration; stop and report if it fails).
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` - ESLint on both changed
  apps.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio` - types, including the
  studio's `next typegen`.
- `yarn knip` - no unused files or exports (the step double included).
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio` - unit tests, and the
  migration version guard.
- `yarn turbo run test:db --filter=./apps/studio` - `claim_job` order and negative proof, retry
  policy, statuses.
- `yarn turbo run build --filter=./apps/studio` - the studio builds with the new action and
  components (the worker's build check is its typecheck).
- `yarn lint && yarn typecheck && yarn test && yarn build` - the unfiltered gates the issue names.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - both E2E
  suites against the run's servers, the four new specs included.
- `yarn workspace @edit-issebya/worker test:tools` - real ffmpeg footage checks (owner's Mac only,
  never in CI).

## Notes

- **No new dependency.** `pg` is already a studio dev dependency; ffmpeg is a system tool.
- **CI change:** ffmpeg is installed in CI because every `process` job now runs `ffprobe`; the
  existing specs that spawn `once` on a process job (`upload`, `preview`, `change-requests`,
  `export`, and the `seedProcessedReel` helper) depend on it too.
- **Migration command:** the issue names `supabase migration up --local`; the ADW profile forbids
  agents that command and prescribes `.adw/supabase-stack reset` for a run's own stack, which is
  what this plan uses. CI applies the migrations to its own fresh stack.
- **Download, not range read:** `check_footage` downloads the source into the job's inputs folder
  (the path convert reads), so a running convert does not download it again. A Retry whose convert
  is a hit still downloads the source once for the check; acceptable for clips up to 90 s.
- **Not-available fixtures are unverified.** The pipeline cannot sign Claude Code out or hit a
  usage limit. The fixtures hold the best-known texts; during manual acceptance the owner captures
  the real stdout of `claude -p --output-format json` in both states on the worker machine and
  replaces the two fixtures (and the regexes if needed). The pipeline does not verify real sleep or
  crash recovery on the Mac either.
- **Waiting reel status:** a waiting `process` job leaves the reel at its last pipeline status
  (version 1 already exists); only the job line says it waits.
- **One retry per step, not per job:** the job's `attempts` keeps counting claims; a Retry is a new
  job with its own attempts.
- **Manual acceptance (owner):** landscape and two-minute clips refused at once; Claude Code signed
  out during a real reel (fixed steps finish, the job waits, finishes after signing back in); the
  worker killed during background removal resumes after the lease runs out.
- Out of scope: horizontal footage, clips over 90 s, several clips per reel, email alerts.
