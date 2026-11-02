# Feature: failures and footage checks (one automatic retry, Retry button, waiting for the AI, per-reel job order, refusals)

## Metadata

issue_number: `39`
adw_id: `6f234803`
issue_json: `{"number":39,"title":"feat: failures and footage checks: one automatic retry, Retry button, waiting for the AI, per-reel job order, refusals"}`

## Feature Description

Reel studio MVP, slice 16 of 17 (block E of the design: every failure case gets exactly one rule).
When something goes wrong the owner sees what happened and what to do:

- **Footage check first.** A new first pipeline step, `check_footage`, probes the uploaded object
  with `ffprobe` before any heavy step. A file that is not a video, has no sound, is not vertical
  (after rotation metadata) or is longer than 90 seconds is refused at once: the reel becomes
  `refused` with a human message (`This clip is 2 minutes 10 seconds; the studio takes up to 1
minute 30 seconds.`) and no other step runs.
- **One automatic retry per step, for transient errors only.** One function classifies errors
  (network errors, R2 or Supabase 5xx and timeouts, a tool killed by a signal are transient; a
  tool's non-zero exit, a schema or check failure, a refusal are not). A transient failure re-runs
  the step once; a second failure, or any non-transient one, stops the job with the step's error
  tail.
- **Retry button** on a failed job: inserts a new job of the same kind and parameters with
  `retry_of_job_id`; every earlier step is a fingerprint hit, so it resumes at the failed step.
- **Waiting for the AI.** When Claude Code reports a usage limit or is signed out, the job becomes
  `waiting_ai` with a `waiting_reason` and `not_before = now() + 15 minutes`; `claim_job` skips it
  until then and the worker keeps taking other jobs. The studio shows
  `Waiting for the AI: <reason>. Next try at HH:MM.` Fixed steps never need the AI and finish first.
- **One job at a time per reel, in order**, enforced in `claim_job`. Slice 11's interim UI rule is
  removed: the change box is enabled during processing and says
  `Your change will run after processing finishes.`
- **Lease plus temporary names, proved** by a crash test (SIGKILL mid-step, lease expiry, second
  worker re-runs the step, the half-written file never becomes an output).

## User Story

As the owner of the reel studio
I want to see what went wrong and what to do: a hiccup retried once on its own, a real failure stopped with its error and a Retry button, a job that waits (and says why) when the AI is unavailable, a change that waits its turn, and unusable footage refused at once
So that I never wait ten minutes for a doomed job, never lose work to a transient error, and always know the next action

## Problem Statement

Today any error fails the whole job (`run-job.ts` catches and calls `failJob`), with no retry and no
way to resume except re-uploading. `claim_job` takes the oldest claimable job across all reels with
no per-reel order, so the studio blocks the change box during processing (slice 11's interim rule,
`changeBlockedReason`) to avoid two jobs of one reel running at once. An unavailable AI (usage limit,
signed-out Claude Code) fails the job like any other error. Footage is only probed inside `convert`;
a landscape, silent or too-long clip is processed for minutes before anything notices, and a text
file renamed `.mp4` fails with a raw ffprobe error.

## Solution Statement

1. **Database (one new migration)**: job status `waiting_ai` with `waiting_reason` and `not_before`;
   step status `waiting_ai`; `jobs.retry_of_job_id` (owner-insertable, validated by a trigger, one
   retry per failed job); reel statuses `checking_footage` and `refused` with
   `reels.refusal_message`; `claim_job` rewritten with the per-reel order and the `not_before` rule;
   `wait_for_ai(...)` so the waiting deadline uses the database clock.
2. **Worker**:
   - `apps/worker/src/failures.ts`: `classifyFailure(error)` is the one classification
     (`transient | ai_unavailable | refused | permanent`), walking the `cause` chain.
   - `step-runner.ts`: the tool's thrown failure carries its exit (`code`, `signal`) and stdout; the
     shared `withStep` re-runs a step body once on a `transient` failure (each attempt its own step
     row), writes a `waiting_ai` row for an AI-unavailable failure, and never retries anything else.
   - `pipeline/check-footage.ts` + `pipeline/footage-limits.ts`: the first `PIPELINE` step, its
     kept output `footage.json` (normalized probe facts), and a pure verdict that refuses with the
     message. The pipeline runner evaluates the step's gate on a run and on a hit.
   - `ai.ts`: `AiResult` gains `{ kind: "unavailable", reason }`, recognised from captured fixture
     messages (envelope and non-zero exit); `run-decide.ts` throws `AiUnavailableError` on it.
   - `run-job.ts`/`queue.ts`/`process-job.ts`: outcomes `refused` (job failed with the message,
     reel `refused` with `refusal_message`) and `waiting` (`wait_for_ai`), besides done, failed, lost.
   - A test-only step double (`E2E_MOCK_STEP_RUN`, on only under `E2E_MOCK_STORAGE=true`) so specs
     can half-write and hang, complete, or fail transiently a named step with no real tool.
3. **Studio**: new statuses and columns in `lib/jobs.ts` and `lib/reels.ts`; the waiting line, the
   refusal message and a Retry button (server action `retryJob`) in `LiveReel`; the change box rule
   replaced (`changeRule` returns `{ blocked, notice }`).
4. **Tests** at every layer named in the profile, including the negative proof for the per-reel order.
5. **Docs**: new `app_docs/failures.md`, its index line, and in-place updates of
   `change-requests.md`, `studio.md`, `decide-step.md`, `pipeline.md` and the profile's Tests section.

## Relevant Files

Use these files to implement the feature:

Docs (read before implementing):

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, Protected section (no `supabase`
  command but `supabase migration new` and `.adw/supabase-stack reset`; never start the worker).
- `docs/conditional-docs.md`: add the `failures.md` line.
- `app_docs/studio.md`: jobs, steps, `claim_job` and the lease, studio test layers (update in place).
- `app_docs/change-requests.md`: the interim one-job-at-a-time rule this issue replaces.
- `app_docs/pipeline.md`: pipeline steps, fingerprints, `fixtures/pipeline/`, `test:tools`.
- `app_docs/decide-step.md`: the AI runner, `E2E_MOCK_AI_SCRIPT`, rule "at most two AI calls".
- `app_docs/measurement.md`: step rows, summaries and error tails (a retried step has two rows).
- `app_docs/storage.md`: `recordingStorage`, `stored_files`, the disk guard's waiting reason
  (the existing `job-waiting` line under a queued job stays).
- `app_docs/export.md`: Export button rule (kept as is).

Database:

- `supabase/migrations/20261031174750_job_queue.sql`: `jobs`, `steps`, the original `claim_job`
  and `jobs_claimable_idx`.
- `supabase/migrations/20261101184843_change_restore_jobs.sql`,
  `supabase/migrations/20261101194557_export_render_jobs.sql`: job kinds, insert grants and policies.
- `supabase/migrations/20261101135426_pipeline_steps_part_two.sql`: the current `reels_status_check`.
- `supabase/migrations/20261101100000_pipeline_steps.sql`: the current `steps_status_check`.

Worker (`apps/worker`):

- `src/run-job.ts`, `src/process-job.ts`, `src/queue.ts`, `src/once.ts`, `src/main.ts`, `src/loop.ts`.
- `src/step-runner.ts` (`withStep`, `runToolsStep`, `StepFailure`, `StepError`), `src/step-store.ts`,
  `src/recording-steps.ts`, `src/errors.ts`.
- `src/ai.ts` and `src/ai.test.ts`; `src/decide/run-decide.ts` and its test.
- `src/pipeline/run-pipeline.ts`, `src/pipeline/definition.ts`, `src/pipeline/probe.ts`,
  `src/pipeline/convert.ts`, `src/pipeline/atomic.ts`, `src/pipeline/tools-test-support.ts`,
  `src/pipeline/pipeline-fixtures.test.ts`, `src/pipeline/run-pipeline.test.ts`.
- `src/make-pipeline-fixtures.ts`: regenerates `fixtures/pipeline/`.
- `src/version-store.ts`, `src/stored-files.ts`, `src/preview-copies-record.ts`,
  `src/render/export-store.ts`: Supabase calls whose errors must carry the HTTP status.
- `.env.example`: test-only flags block (`E2E_MOCK_*`).

Studio (`apps/studio`):

- `src/lib/jobs.ts`, `src/lib/reels.ts`, `src/lib/change-requests.ts` (+ tests).
- `src/app/change-actions.ts`, `src/components/ChangeRequestForm.tsx`, `src/components/VersionList.tsx`,
  `src/components/LiveReel.tsx`, `src/components/ReelList.tsx`, `src/app/reels/[id]/page.tsx`.
- `test-support/worker.ts`, `test-support/pipeline-cache.ts`, `test-support/ai-script.ts`,
  `test-support/fixtures.ts`.
- `db-tests/jobs.test.ts` (its "oldest, then the next" case puts two jobs on one reel and must move
  one to a second reel), `db-tests/pipeline-statuses.test.ts`, `db-tests/change-jobs.test.ts`.
- `e2e/change-requests.spec.ts` (asserts the interim disabled box), `e2e/upload.spec.ts` (asserts the
  exact step list), `e2e/step-log.spec.ts`, `e2e/disk-guard.spec.ts` (patterns to copy).

Fixtures:

- `fixtures/pipeline/manifest.json` and step folders; `fixtures/footage/short-speech.mp4`
  (read only). Never touch `fixtures/footage/short-person.mp4`.

### New Files

- `supabase/migrations/<stamp>_failures_and_footage_checks.sql` (created with `supabase migration new failures_and_footage_checks`).
- `apps/worker/src/failures.ts`, `apps/worker/src/failures.test.ts`: `classifyFailure`,
  `AiUnavailableError`, `FootageRefusedError`, `dbFailure`.
- `apps/worker/src/ai-unavailable.ts`, `apps/worker/src/ai-unavailable.test.ts`: the recognised
  messages and the reason each maps to.
- `apps/worker/src/testdata/ai-unavailable/usage-limit.json`,
  `apps/worker/src/testdata/ai-unavailable/not-logged-in.json`,
  `apps/worker/src/testdata/ai-unavailable/not-logged-in-exit.txt`: captured-message fixtures.
- `apps/worker/src/pipeline/footage-limits.ts`: the limits and messages, one place.
- `apps/worker/src/pipeline/check-footage.ts`, `check-footage.test.ts`, `check-footage.tools.test.ts`.
- `apps/worker/src/pipeline/testdata/footage/*.json`: ffprobe JSON fixtures (portrait, landscape,
  rotated portrait stored landscape, no audio, 130 s, still image, empty `{}` for a text file).
- `apps/worker/src/pipeline/step-double.ts`, `step-double.test.ts`: `E2E_MOCK_STEP_RUN`.
- `apps/worker/src/pipeline/footage-check-fixtures.test.ts`: checks `fixtures/footage-check/`.
- `fixtures/pipeline/check_footage/footage.json` (+ manifest entry).
- `fixtures/footage-check/landscape.mp4`, `fixtures/footage-check/manifest.json`,
  `fixtures/footage-check/landscape/footage.json`.
- `apps/studio/src/app/retry-actions.ts`, `apps/studio/src/components/RetryJobButton.tsx`.
- `apps/studio/src/lib/job-failures.ts`, `job-failures.test.ts`: `waitingForAiLine`, `canRetry`.
- `apps/studio/db-tests/failures.test.ts`, `apps/studio/db-tests/job-order.test.ts`.
- `apps/studio/e2e/refusal.spec.ts`, `apps/studio/e2e/retry.spec.ts`,
  `apps/studio/e2e/waiting-ai.spec.ts`, `apps/studio/e2e/crash-resume.spec.ts`.
- `app_docs/failures.md`.

## Implementation Plan

### Phase 1: Foundation

The migration (statuses, columns, trigger, `claim_job`, `wait_for_ai`), the worker's error
classification and the tool exit carried on failures, the footage limits and verdict as pure
functions with unit tests. Nothing user-visible yet.

### Phase 2: Core Implementation

The `check_footage` step and the gate in the pipeline runner; the one automatic retry in
`withStep`; the AI runner's "unavailable" outcome and the decide step's `AiUnavailableError`; the
job outcomes `refused` and `waiting`; the step double for specs; fixtures regenerated.

### Phase 3: Integration

The studio: statuses, waiting line, refusal message, Retry button and server action, the change
box rule replaced. DB tests, E2E specs, the tools test, docs and the profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the docs and the Next guide

- Read `AGENTS.md`, `docs/conditional-docs.md`, then `app_docs/studio.md`, `change-requests.md`,
  `pipeline.md`, `decide-step.md`, `measurement.md`, `storage.md`.
- Read the server actions and forms guides under `node_modules/next/dist/docs/` before the studio
  work (server action for Retry).

### 2. Migration

- Run `supabase migration new failures_and_footage_checks` (the only way to create it; never pick
  a version by hand). Fill it with, commented like the existing migrations:
  - `jobs`: drop and re-add `jobs_status_check` with `('queued','running','waiting_ai','done','failed')`;
    add `waiting_reason text`, `not_before timestamptz`, constraint
    `jobs_waiting_check check ((status = 'waiting_ai') = (waiting_reason is not null and not_before is not null))`.
  - `jobs.retry_of_job_id uuid references public.jobs (id) on delete set null`;
    unique partial index `jobs_retry_of_idx on public.jobs (retry_of_job_id) where retry_of_job_id is not null`
    (a failed job is retried once; a double click inserts nothing more);
    `grant insert (retry_of_job_id) on public.jobs to authenticated`.
  - A `before insert` trigger function `public.jobs_check_retry()` (`security definer`,
    `set search_path = ''`): when `new.retry_of_job_id` is not null, the referenced job must exist,
    have status `failed`, the same `reel_id`, `kind`, and `request`, `restore_version_id`,
    `version_id` each `is not distinct from` the new row's, and its reel must not be `refused`;
    otherwise `raise exception ... using errcode = '23514'`. The existing insert policies stay
    unchanged (they already check own reel and kind-specific columns).
  - `steps`: `steps_status_check` re-added with `waiting_ai` added.
  - `reels`: `reels_status_check` re-added with `checking_footage` (after `received`) and `refused`
    added; column `refusal_message text`, constraint
    `reels_refusal_check check ((status = 'refused') = (refusal_message is not null))`.
  - `drop index jobs_claimable_idx`; recreate with `where status in ('queued','running','waiting_ai')`.
  - `create or replace function public.claim_job(p_worker text, p_lease_seconds int)` keeping the
    argument checks, the grants (`service_role` only), and this candidate set:
    ```sql
    with next as (
      select c.id
      from public.jobs c
      where (
          c.status = 'queued'
          or (c.status = 'running' and c.lease_expires_at < now())
          or (c.status = 'waiting_ai' and c.not_before <= now())
        )
        -- One job at a time per reel, in order (app_docs/failures.md).
        and not exists (
          select 1 from public.jobs o
          where o.reel_id = c.reel_id
            and o.id <> c.id
            and (
              (o.status = 'running' and o.lease_expires_at >= now())
              or (
                (o.created_at, o.id) < (c.created_at, c.id)
                and o.status in ('queued', 'running', 'waiting_ai')
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
    Re-state `revoke ... from public, anon, authenticated` and `grant ... to service_role`.
  - `public.wait_for_ai(p_job_id uuid, p_worker text, p_reason text, p_retry_after_seconds int)
returns boolean`, `security definer`, `set search_path = ''`: validates the reason (1 to 200
    trimmed characters) and seconds (60 to 86400); updates the job where `id`, `lease_holder =
p_worker` and `status = 'running'` to `waiting_ai`, the reason, `not_before = now() +
make_interval(secs => p_retry_after_seconds)`, `lease_holder = null`, `lease_expires_at = null`;
    returns `found`. Execute for `service_role` only (revoke from `public, anon, authenticated`).
- Run `.adw/supabase-stack reset` (the profile's only allowed way to apply a migration in a run;
  the issue's `supabase migration up --local` is forbidden by the Protected section). If it fails,
  report the error and stop.

### 3. Error classification (`apps/worker/src/failures.ts`)

- `FootageRefusedError(message)` and `AiUnavailableError(reason)` classes.
- `dbFailure(what, { error, status })`: an `Error` with `status` (the PostgREST HTTP status, 0 when
  the request never got an answer) and `cause`; use it in `step-store.ts`, `version-store.ts`,
  `stored-files.ts`, `preview-copies-record.ts`, `render/export-store.ts` and `queue.ts` where they
  now throw plain `Error`s (destructure `status` beside `error`).
- `classifyFailure(error): "transient" | "ai_unavailable" | "refused" | "permanent"`, walking
  `cause` (bounded depth): `FootageRefusedError` is `refused`; `AiUnavailableError` is
  `ai_unavailable`; `StepError` (decide refusal), a Zod error and a tool exit with a numeric code
  are `permanent`; transient when a tool exit has a signal; a Node or undici network code
  (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `UND_ERR_SOCKET`,
  `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`); `TypeError: fetch
failed`; an error named `TimeoutError`, `RequestTimeout`, `ServiceUnavailable`, `InternalError`
  or `SlowDown`; an AWS SDK `$metadata.httpStatusCode >= 500`; a `dbFailure` with `status >= 500`
  or `0`. Everything else is `permanent`.
- `failures.test.ts`: a table of each case, including a 503 wrapped two levels deep in `cause`, an
  AWS-shaped 404 (`permanent`) and an unknown error (`permanent`).

### 4. Tool exits carried on failures (`step-runner.ts`)

- The tool's thrown `StepFailure` also carries `exit: { code: number | null; signal: string | null }`
  and `stdout`; export `toolExitOf(error)` returning `{ code, signal, stdout } | null` (walks
  `cause`). `classifyFailure` uses it.
- In `withStep`, loop over at most two attempts. Per attempt: `steps.start`, run the body; on
  error: if `ctx.signal.aborted` rethrow (lease lost, unchanged); classify;
  - `ai_unavailable`: `steps.waiting(stepId, reason, summary, measurements)` (new `StepStore`
    method: status `waiting_ai`, summary `<name>: waiting for the AI (<reason>)` via
    `stepSummary`), then rethrow;
  - `transient` on attempt 1: `steps.failed(...)` with summary what `${name} failed, retried`, log
    `step <name>: transient failure, retrying once: <first line>`, then run attempt 2;
  - otherwise `steps.failed(...)` as today and rethrow.
    Exactly one automatic retry; `recordHit` is unchanged.
- Add `waiting` to `supabaseStepStore` and to `recording-steps.ts` (`{ call: "waiting", ... }`).
- `step-runner.test.ts`: a fake spawn killed by `SIGKILL` once then exiting 0 gives two `start`
  calls, one `failed`, one `done`; killed twice gives two `failed` and a throw; a non-zero exit runs
  once; a `StepError` runs once; an aborted signal never retries; an `AiUnavailableError` writes
  `waiting` and is not retried.

### 5. Footage limits and verdict

- `pipeline/footage-limits.ts`: `FOOTAGE_LIMITS = { maxDurationSeconds: 90 }` and the message
  builders; `formatClipLength(seconds)` (ceil to whole seconds; `1 minute 30 seconds`,
  `2 minutes 10 seconds`, `45 seconds`, singular units).
- `pipeline/probe.ts`: extend `RawStream` with `tags.rotate`, `side_data_list[].rotation`,
  `disposition.attached_pic`; `parseProbe` behaviour unchanged.
- `pipeline/check-footage.ts`:
  - `footageFacts(json: string | null): FootageFacts` where
    `FootageFacts = { readable: boolean; formatName: string | null; video: { width; height; rotation } | null; audio: boolean; durationSeconds: number | null }`.
    `null` input (ffprobe exited non-zero) or no parseable JSON gives `readable: false`. Video is
    the first video stream that is not an `attached_pic`. Rotation from the display matrix side
    data, else `tags.rotate`, normalised to 0, 90, 180, 270.
  - `footageRefusal(facts): string | null`: every failing rule, one sentence each, in this order,
    joined by a space:
    1. not a video (unreadable, no video stream, `formatName` `image2` or ending `_pipe`, or no
       positive duration): `This file is not a video the studio can read.` (stop here);
    2. no audio: `This clip has no sound; the studio needs the voice.`;
    3. not vertical: effective width and height swapped when rotation is 90 or 270; refused unless
       effective height > width: `This clip is landscape (W x H); the studio takes vertical
footage only.` (square: `This clip is square (W x H); ...`);
    4. too long: `This clip is 2 minutes 10 seconds; the studio takes up to 1 minute 30 seconds.`
  - `checkFootage: PipelineStep` named `check_footage`, version 1, settings
    `{ facts: 1 }`, `reelStatus: "checking_footage"`, one output
    `{ file: "footage.json", retention: "kept" }`, `reusedWhat: "footage checked"`, input the
    source only. `run`: ffprobe with `probeArgs(source)`; on a tool exit with a numeric code treat
    the output as unreadable (`footageFacts(null)`), rethrow anything else (a signal stays
    transient); write `footage.json` (canonical JSON of the facts) with `writeAtomic`; return
    `what` like `footage checked: 1080 x 1920, 42 seconds, sound`.
  - `gate(bytes: Uint8Array): string | null` on the step: parses `footage.json` and returns
    `footageRefusal`.
- `PipelineStep` gets an optional `gate?(outputs: Record<string, Uint8Array>): string | null`.
- `PIPELINE` becomes `[checkFootage, convert, transcribe, retime, removeBackground, headTrack, previewCopies]`.
  `convert`'s fingerprint does not depend on `check_footage`, so every existing fingerprint is
  unchanged.
- `StepStore`'s `PipelineReelStatus` gains `checking_footage`.
- `check-footage.test.ts`: on the ffprobe JSON fixtures, portrait accepted, landscape refused,
  rotated portrait-stored-landscape (rotation -90) accepted, no audio refused, 130 s refused with the
  exact message, 90 s accepted, still image refused, `{}` and `null` refused as not a video,
  a landscape 130 s clip gets both sentences.

### 6. Gate in the pipeline runner (`run-pipeline.ts`)

- Run path, inside `work`: after the outputs are uploaded (so a refused clip's facts are cached and
  a retry stays a hit), call `step.gate` with the local output bytes; a message throws
  `FootageRefusedError(message)`, so the step row becomes `failed` with the message as its tail.
- On the hit path, read the outputs with `storage.get`, call `gate`; on a message record the step
  with `runInProcessStep` whose work throws `FootageRefusedError` (a `failed` row, no tool), instead
  of `recordHit`; otherwise `recordHit` as today.
- Nothing after a refused step runs. `run-pipeline.test.ts`: a landscape probe fixture refuses with
  exactly one `start` (`check_footage`) and no other step call and no `getFile` of any other input;
  a stored refused `footage.json` refuses on a hit; a portrait fixture runs on.
- Transient retry proof (Verification 3) in `run-pipeline.test.ts`: a storage wrapper whose
  `getFile` throws once an AWS-shaped 503 (`name: "ServiceUnavailable"`,
  `$metadata: { httpStatusCode: 503 }`): the step has two `start` calls, the first `failed`, the
  second `done`, and `runPipeline` resolves. A fake spawn exiting 1 for `ffmpeg`: one `start`, one
  `failed`, and `runPipeline` rejects.
- Update existing tests that list every step (`run-pipeline.test.ts`, `definition.test.ts`) for the
  new first step; the fake spawn answers ffprobe with a portrait fixture.

### 7. Fixtures

- `make-pipeline-fixtures.ts`: before the run, seed into the temporary store every committed output
  whose manifest fingerprint still equals `fingerprintsFor(...)`, so only new or changed steps run
  (here only `check_footage`, one ffprobe); the rest of the script is unchanged. Also generate
  `fixtures/footage-check/`: run `runPipeline({ pipeline: [checkFootage] })` on
  `fixtures/footage-check/landscape.mp4`, expect `FootageRefusedError`, copy its `footage.json` to
  `fixtures/footage-check/landscape/footage.json` and write `fixtures/footage-check/manifest.json`
  `{ clips: [{ file, source: { etag, bytes }, fingerprint, files: ["footage.json"], refusal }] }`.
- Create `fixtures/footage-check/landscape.mp4` once with ffmpeg (1 s, 160x90, 10 fps, H.264,
  AAC sine), for example:
  `ffmpeg -hide_banner -v error -f lavfi -i testsrc=size=160x90:rate=10:duration=1 -f lavfi -i sine=frequency=440:duration=1 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest fixtures/footage-check/landscape.mp4`.
- Run `yarn workspace @edit-issebya/worker fixtures:pipeline` (needs ffprobe on this machine; the
  other committed outputs must stay byte-identical: check `git diff --stat fixtures/pipeline`).
- `pipeline-fixtures.test.ts` passes unchanged (it compares against `PIPELINE`).
  `footage-check-fixtures.test.ts`: the landscape clip's MD5 and size, its fingerprint equals
  `fingerprintsFor(source, [checkFootage]).check_footage`, and `footageRefusal` of its committed
  facts equals the recorded `refusal`.

### 8. AI unavailable (`ai-unavailable.ts`, `ai.ts`, `run-decide.ts`)

- Fixtures under `apps/worker/src/testdata/ai-unavailable/`, recorded as Claude Code shows them
  (to be confirmed by the owner's capture, see Notes): `usage-limit.json` (result envelope,
  `is_error: true`, `result` like `Claude AI usage limit reached|1767225600`), `not-logged-in.json`
  (`is_error: true`, `result` `Invalid API key · Please run /login`) and
  `not-logged-in-exit.txt` (stdout of a non-zero exit with the same text).
- `ai-unavailable.ts`: `unavailableReason(text): string | null`, case-insensitive patterns in one
  list: usage or rate limit reached (`usage limit`, `limit reached`, `limit will reset`) →
  `usage limit reached`; signed out (`please run /login`, `not logged in`, `invalid api key`,
  `oauth token has expired`) → `Claude Code is not logged in`.
- `AiResult` gains `{ kind: "unavailable"; reason: string; usage: AiUsage }`. `parseClaudeResult`
  returns it when `is_error` and the result text matches. `claudeRunner` catches a tool exit with
  a numeric code and returns `unavailable` when its stdout or output matches, else rethrows.
  The fake runner returns it through `parseClaudeResult`, so a script entry carrying the fixture
  envelope reproduces it.
- `run-decide.ts`: on `unavailable` from either call, throw `AiUnavailableError(reason)` with the
  usage so far (no second call, nothing written).
- `ai.test.ts`/`ai-unavailable.test.ts`: each fixture maps to its reason; an ordinary
  `is_error` (`subtype: error_max_turns`) stays `broken`; the exit path with a matching stdout is
  `unavailable`, with an unrelated stderr rethrows. `run-decide.test.ts`: an unavailable first
  answer makes one call, writes no version and throws `AiUnavailableError`.

### 9. Job outcomes (`run-job.ts`, `queue.ts`, `process-job.ts`, `once.ts`, `main.ts`)

- `JobOutcome = "done" | "failed" | "lost" | "refused" | "waiting"`. `RunJobDeps` gains
  `refuse(message)` and `wait(reason)`. In the catch (after the lease check): `refused` →
  `refuse(error message)`; `ai_unavailable` → `wait(reason)`; else `fail(tail)` as today. Each
  returns false when the lease was lost (`lost`).
- `queue.ts`: `refuseJob(db, config, job, message)`: the job `failed` with `error_tail = message`
  (same lease guards as `endJob`), the reel `refused` with `refusal_message` in one update.
  `waitForAi(db, config, job, reason)`: `rpc("wait_for_ai", { ..., p_retry_after_seconds:
AI_RETRY_AFTER_SECONDS })` with `AI_RETRY_AFTER_SECONDS = 15 * 60` exported from `queue.ts`.
  `claimableJobIds` also matches `and(status.eq.waiting_ai,not_before.lte.<now>)` (still ids only),
  so the poll wakes the worker when a wait ends.
- `ClaimedJob` gains `retry_of_job_id`, `waiting_reason`, `not_before` (read, unused by the kinds).
- `once.ts`: exit 0 for `done`, `waiting` and `refused`, 1 otherwise; log the outcome.
- `run-job.test.ts`: a `FootageRefusedError` calls `refuse`, an `AiUnavailableError` calls `wait`,
  a plain error calls `fail`, each only once.
- `queue.test.ts`: the waiting branch of `claimableJobIds`' filter string.

### 10. Step double for specs (`pipeline/step-double.ts`)

- `stepDoubles(env)(pipeline)`: only when `env.E2E_MOCK_STORAGE === "true"` and
  `E2E_MOCK_STEP_RUN` is `<step>:<mode>`; otherwise the pipeline unchanged. Replaces that step's
  `run`:
  - `half`: writes the first half of the committed `fixtures/pipeline/<step>/<first output>` to
    `<file>.part` in the step folder, logs `e2e: <step> partial written`, then waits forever (until
    the process is killed);
  - `full`: copies each committed fixture output through `writeAtomic`-style temp name and rename;
  - `fail-transient`: throws an error whose tool exit carries `signal: "SIGKILL"` every time.
    An unknown step or mode throws at job start. Add the variable to the tests-only block of
    `apps/worker/.env.example` (empty).
- `process-job.ts` passes `pipeline: stepDoubles(process.env)(PIPELINE)` to `runPipeline` (process
  and render).
- `step-double.test.ts`: off without the storage flag; each mode's file effects in a temp folder.

### 11. Studio data

- `lib/jobs.ts`: `JOB_COLUMNS` adds `retry_of_job_id, waiting_reason, not_before`; `JOB_STATUSES`
  and `STEP_STATUSES` add `waiting_ai`; `JobRow` fields.
- `lib/reels.ts`: `REEL_STATUSES` adds `checking_footage` and `refused`; `REEL_DETAIL_COLUMNS` adds
  `refusal_message`; `ReelDetail` field.
- `lib/job-failures.ts`: `waitingForAiLine(job, timeZone?)` →
  `Waiting for the AI: <reason>. Next try at HH:MM.` (24-hour, the given or the browser's zone);
  `canRetry(job, jobs, reel)`: failed, reel not `refused`, and no other job has
  `retry_of_job_id = job.id`. Unit tests with a fixed zone.
- `lib/change-requests.ts`: replace `changeBlockedReason` with `changeRule(reel, jobs)` returning
  `{ blocked: string | null; notice: string | null }`: blocked when the reel is `refused`
  (`This clip was refused; upload another.`), `uploading`, or has no current version and no
  unfinished `process` job (`Changes open once the reel has a version.`); otherwise open, with
  notice `Your change will run after processing finishes.` when a `process` job is `queued`,
  `running` or `waiting_ai`, else `Your change will run after the current job finishes.` when any
  job is unfinished, else none. Update its tests (remove the interim cases).

### 12. Studio UI and actions

- `app/change-actions.ts`: `openReel` uses `changeRule(...).blocked` (still re-read under RLS);
  select `kind, status` of jobs.
- `ChangeRequestForm.tsx`: props `blockedReason` and `notice`; pending also while the sent job is
  `waiting_ai`; the notice shown in `data-testid="change-notice"` when not blocked.
  `VersionList.tsx`: same `blockedReason` source.
- `app/retry-actions.ts`: server action `retryJob({ reelId, jobId })`: validates ids, the owner's
  client, reads the job (`kind, status, request, restore_version_id, version_id, reel_id`) and the
  reel under RLS, refuses unless `canRetry`, inserts the same kind and parameters with
  `retry_of_job_id`; a unique violation answers `already retried`. Logs without request text.
- `components/RetryJobButton.tsx`: client button `Retry` (`data-testid="job-retry"`), disabled while
  sending, `router.refresh()` when signed out, a one-line message on failure.
- `LiveReel.tsx`: under each job: the waiting line (`data-testid="job-waiting-ai"`, rendered in a
  `<time dateTime={not_before} suppressHydrationWarning>` for the clock part) when `waiting_ai`;
  the Retry button when `canRetry`; `retried` label when a later job retries it. Above the status
  list, `data-testid="reel-refusal"` with `reel.refusal_message` when `refused`. Pass `changeRule`
  results to the form and the list. `waiting_ai` counts as unfinished everywhere the page checks
  queued or running.
- `ExportPanel` and `exportBlockedReason` are unchanged (their own rule, `app_docs/export.md`).

### 13. Test support

- `test-support/worker.ts`: `claimableJobIds` also returns every `waiting_ai` job (any
  `not_before`), so a leftover wait is reported; `workerEnv(env)` shared by `runWorkerOnce` and a
  new `spawnWorkerOnce(env)` that starts `node --env-file-if-exists=.env.development src/once.ts`
  in `apps/worker` with `detached: true` (so the spec can `process.kill(-pid, "SIGKILL")` the group)
  and exposes the output and a `waitForLine(text)`.
- `test-support/pipeline-cache.ts`: `seedPipelineCache(storage, prefix, { skip?: string[] })`; a
  `seedQueuedReel({ admin, storage, ownerId, prefix, clip?, skip? })` that uploads the clip, inserts
  the reel and its queued process job, seeds the cache, and returns ids and keys (used by the new
  specs; `seedProcessedReel` builds on it).
- `test-support/ai-script.ts`: `USAGE_LIMIT_SCRIPT` path to the worker's fixture.

### 14. DB tests

- `db-tests/jobs.test.ts`: move the newer job to a second reel so "the oldest, then the next" still
  holds under the per-reel order.
- `db-tests/pipeline-statuses.test.ts`: accepts `checking_footage` and `refused` (with a message),
  rejects `refused` without one.
- `db-tests/failures.test.ts`: `waiting_ai` needs a reason and `not_before`; `wait_for_ai` moves a
  leased job (wrong worker: false), `not_before` about 15 minutes ahead by the database clock;
  `claim_job` skips a `waiting_ai` job whose `not_before` is in the future, returns another reel's
  queued job meanwhile, and claims it once `not_before` is set to the past (clearing reason and
  `not_before`, attempts + 1); `steps` accepts `waiting_ai`; the owner inserts a retry of their own
  failed job (each kind with its parameters), and is refused for a queued or done job, another
  reel's job, a different kind or parameters, a second retry of the same job, a refused reel, and
  another owner's job; `authenticated` cannot execute `wait_for_ai` or `claim_job`.
- `db-tests/job-order.test.ts` (Verification 7): queue `process` and `change` for reel A and
  `process` for reel B (explicit increasing `created_at`). Two simulated workers alternate: claim
  through a given function, record start, hold a few milliseconds, mark `done` through the admin
  client, record end, until no claim. Assert A's two intervals never overlap, A's change starts
  after A's process ended, and B's job overlaps one of A's. **Negative proof:** in `beforeAll`
  create, through `pg` on `localDbUrl()`, `public.claim_job_unordered_for_test` (the old body:
  no per-reel condition, `service_role` only) and drop it in `afterAll`; the same loop through it
  must produce an overlap of A's jobs (`expect(...).toBe(true)`). Both run in the file, so removing
  the condition from `claim_job` makes the ordered case fail.

### 15. E2E specs (studio, chromium, through the landing page)

Each spec follows `disk-guard.spec.ts`: its own `R2_KEY_PREFIX`, leftover-claimable check in
`beforeAll`, cleanup of its keys, queued or waiting jobs and its user in `afterAll`, serial mode.

- `e2e/refusal.spec.ts` (Verification 2): seed the reel with `fixtures/footage-check/landscape.mp4`
  as its source and `footage.json` under the manifest fingerprint (no ffprobe in CI), open the reel
  page, wait for `data-realtime="ready"`, run `once`: the page shows status `refused` and
  `reel-refusal` with the manifest's message live (no reload), exactly one step line
  (`check_footage`), no `job-retry`; the DB has one step row for the reel; the change box is
  disabled with the refusal reason.
- `e2e/retry.spec.ts` (Verification 4): seed with `skip: ["transcribe"]`, run `once` with
  `E2E_MOCK_STEP_RUN=transcribe:fail-transient`: the job is `failed`, `transcribe` has two `failed`
  rows, the reel `failed`. Press `Retry`: a new queued job with `retry_of_job_id` (DB), the button
  gone. Run `once` with `E2E_MOCK_STEP_RUN=transcribe:full` and the unchanged-answer script: the
  new job's `convert` is a hit (`cache_hit`), `transcribe` is `done` with `cache_hit` false, the
  job `done`, the reel `processed`.
- `e2e/waiting-ai.spec.ts` (Verification 5): seed reel A (full cache), open its page, run `once`
  with `E2E_MOCK_AI_SCRIPT` = the usage-limit fixture: exit 0, job `waiting_ai`, reason
  `usage limit reached`, `not_before` 14 to 16 minutes ahead, every fixed step `done` or a hit, the
  decide row `waiting_ai`; the page shows `job-waiting-ai` matching
  `/^Waiting for the AI: usage limit reached\. Next try at \d{2}:\d{2}\.$/` live. Seed reel B
  (queued), run `once`: B's job is the one claimed and ends `done`, A still waiting. Set A's
  `not_before` to the past, run `once` with the unchanged-answer script: A `done`, the line gone,
  the reel `processed`.
- `e2e/crash-resume.spec.ts` (Verification 6, no page needed): seed with `skip: ["convert"]`, a
  temporary `WORKER_SCRATCH_DIR`, `spawnWorkerOnce` with `E2E_MOCK_STEP_RUN=convert:half`; wait for
  `e2e: convert partial written` and the `.part` file, then `SIGKILL` the group. Assert no object
  under convert's keys, no `stored_files` row with step `convert`, the `convert` row still
  `running`. Expire the lease through the admin client, run `once` with `convert:full`: attempts 2,
  a new `convert` row `done` with `cache_hit` false, one `stored_files` row for `converted.mp4`
  whose bytes equal the full fixture, the job `done`.
- `e2e/change-requests.spec.ts`: the interim test becomes: with a running `process` job the box and
  Send are enabled and `change-notice` reads `Your change will run after processing finishes.`;
  sending queues the change, which the worker's `once` does not claim while the process job holds
  the lease (assert `no job`), and after the process job is marked done the change runs.
- `e2e/upload.spec.ts`: the exact step list and hit list gain `check_footage` first
  (`check_footage: footage checked, reused`), and the stored-files check includes its `footage.json`
  (`kept`).

### 16. Tools test (Mac only)

- `pipeline/check-footage.tools.test.ts` (Verification 1): generate with ffmpeg in a temp folder a
  100-second portrait clip (tiny size, 1 fps, with audio), a landscape clip, a portrait clip
  without audio, a portrait clip stored landscape with rotation 90 (`-display_rotation:v:0 90`
  input option on ffmpeg 6+, falling back to `-metadata:s:v:0 rotate=90`), and a text file named
  `.mp4`; run the real `checkFootage` through `runPipeline({ pipeline: [checkFootage] })` on a
  folder fake: each refused or accepted with the expected message; the committed
  `fixtures/footage/short-speech.mp4` and the committed landscape fixture give their expected
  verdicts.

### 17. Docs and profile

- New `app_docs/failures.md` (sections as the other feature docs: Specifications, Overview, How it
  works, How to Use, Configuration, Testing, Rules, Notes): the edge cases and their rules, the
  transient classification table, the Retry button and `retry_of_job_id`, `waiting_ai`,
  `waiting_reason`, `not_before` and `wait_for_ai`, the per-reel order in `claim_job`, the footage
  limits and messages, the step double. Rules: exactly one automatic retry, only for transient
  errors; no heavy step before `check_footage` passes; one job per reel at a time, in order,
  enforced in `claim_job`; fixed steps never wait for the AI; never turn `E2E_MOCK_STEP_RUN` on
  unless `E2E_MOCK_STORAGE` is exactly `"true"`; refusal limits only the four named.
- `docs/conditional-docs.md`: one line for it (failures, retries, Retry button, `waiting_ai`,
  `claim_job` order, footage checks).
- `app_docs/change-requests.md`: replace the interim rule (How it works, How to Use, Notes) with the
  database order and the notice; the box is enabled during processing.
- `app_docs/studio.md`: `claim_job` paragraph, job and step statuses, reel statuses, new columns,
  new DB tests and specs.
- `app_docs/decide-step.md`: the unavailable outcome; amend the rule to
  `At most two AI calls per attempt of the step: one retry with reasons, never a loop; the step's
one automatic retry for transient errors (app_docs/failures.md) is the only other repeat.`
- `app_docs/pipeline.md`: `check_footage` as the first step, its kept `footage.json`, the
  `fixtures/footage-check/` fixtures.
- `app_docs/measurement.md`: a retried step has two rows, the first `failed` with `, retried`.
- `.adw/project.md` Tests section: add `failures.test.ts` and `job-order.test.ts` to the DB layer
  and the four new specs to the E2E list (facts only; headings unchanged).
- No em-dashes anywhere.

### 18. Validation

- Run every command in `Validation Commands` and fix anything that fails (never weaken a test).

## Testing Strategy

### Unit Tests

- Worker: `failures.test.ts` (classification table), `ai-unavailable.test.ts` and `ai.test.ts`
  (fixtures to reasons, exit path), `check-footage.test.ts` (facts and verdict on ffprobe JSON
  fixtures), `step-runner.test.ts` (one retry for transient only, waiting row, no retry after an
  abort), `run-pipeline.test.ts` (refusal stops the pipeline on a run and a hit; 503 once retried;
  non-zero exit once), `run-job.test.ts` (refuse, wait, fail dispatch), `queue.test.ts`,
  `run-decide.test.ts` (unavailable stops after one call), `step-double.test.ts`,
  `footage-check-fixtures.test.ts`, `pipeline-fixtures.test.ts` (unchanged, new manifest).
- Studio: `change-requests.test.ts` (`changeRule`), `job-failures.test.ts` (`waitingForAiLine` in a
  fixed zone, `canRetry`).

### Test Coverage

- Unit `apps/worker/src/failures.test.ts`: catches a misclassified error (a 503 not retried, a
  non-zero exit retried); fails today because the module does not exist.
- Unit `apps/worker/src/pipeline/run-pipeline.test.ts` additions: the step runs twice after one 503
  and once after a non-zero exit (Verification 3), and a landscape clip stops the pipeline after
  `check_footage`; fails today (no retry, no check).
- Unit `apps/worker/src/pipeline/check-footage.test.ts`: the four refusal rules, rotation and the
  exact messages on fixture ffprobe JSON (Verification 1, parsing part).
- Unit `apps/worker/src/ai-unavailable.test.ts` and `run-decide.test.ts`: the captured usage-limit
  and signed-out outputs become a wait, not a failure.
- Unit `apps/studio/src/lib/change-requests.test.ts`: the change box is open during processing with
  the notice (fails against the interim rule).
- Tools `apps/worker/src/pipeline/check-footage.tools.test.ts` (Mac only, `test:tools`): real
  ffprobe on generated clips (Verification 1).
- DB `apps/studio/db-tests/failures.test.ts`: `waiting_ai` and `not_before` in `claim_job`, the
  retry trigger and grant, `wait_for_ai` (Verification 5, database part).
- DB `apps/studio/db-tests/job-order.test.ts`: per-reel order with the negative proof against a
  copy without the condition (Verification 7).
- E2E `apps/studio/e2e/refusal.spec.ts`: refusal message live, one step row (Verification 2).
- E2E `apps/studio/e2e/retry.spec.ts`: Retry resumes at `transcribe` (Verification 4).
- E2E `apps/studio/e2e/waiting-ai.spec.ts`: waiting line live, another reel claimed meanwhile, then
  finished (Verification 5).
- E2E `apps/studio/e2e/crash-resume.spec.ts`: SIGKILL plus lease expiry never turns a half file into
  an output (Verification 6).
- E2E `apps/studio/e2e/change-requests.spec.ts` (changed): the box enabled during processing with
  the notice; the change waits its turn.

### Edge Cases

- A clip exactly 90.0 s is accepted; 90.4 s is refused and reads `1 minute 31 seconds`.
- Rotation 90, -90, 270 and 180; side data and the legacy `rotate` tag; a square clip.
- A still image (`image2`, `attached_pic`), an audio-only file, a text file (`ffprobe` exits 1).
- A clip both landscape and too long gets both sentences.
- ffprobe killed by a signal during `check_footage` is transient (retried once), not a refusal.
- A refused clip retried by the owner: no Retry button; the trigger refuses a crafted insert.
- A transient failure after the AI calls in decide re-runs decide once (two more calls at most).
- AI unavailable on the second decide call (after a refused first answer) still waits.
- A waiting job is the oldest of its reel: a change queued meanwhile waits behind it.
- A running job with an expired lease blocks its reel's newer jobs until it is re-claimed.
- Lease lost while waiting is being written: `wait_for_ai` returns false, outcome `lost`.
- Double click on Retry: one new job (unique index), the action answers `already retried`.
- The waiting line across a server render and the browser's zone (no hydration error).

## Acceptance Criteria

- `check_footage` is the first step of every `process` job; a not-a-video, silent, non-vertical
  (after rotation) or over-90-second clip ends the job with the reel `refused`, the message stored
  on the reel and shown live, and no other step row.
- A transient step failure re-runs the step exactly once; a second failure or any non-transient
  failure fails the job and the step with the error tail.
- A failed job (reel not refused) shows Retry; pressing it inserts one job of the same kind and
  parameters with `retry_of_job_id`, which resumes at the failed step.
- An unavailable AI makes the job `waiting_ai` with the reason and `not_before = now() + 15 min`;
  fixed steps finish first; `claim_job` skips it until then and takes other reels' jobs; the
  studio shows `Waiting for the AI: <reason>. Next try at HH:MM.`
- `claim_job` never returns a job of a reel that has a running job with a live lease or an older
  unfinished job; the negative proof fails without that condition.
- The change box is enabled during processing and shows `Your change will run after processing
finishes.`
- The crash test passes: the half-written file never gets a `stored_files` row or a hit.
- Every validation command passes; no em-dashes; docs and the profile updated.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: applies the new migration to this run's ADW stack (the issue's
  `supabase migration up --local` is not allowed by the profile; this is its replacement). If it
  fails, report the error and stop.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker`: lint of both changed workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker`: types, including the
  new `StepStore.waiting` and `AiResult` kind across the worker.
- `yarn knip`: no unused exports or files from the new modules and test helpers.
- `yarn format:check`: Prettier over the repository (docs, SQL comments, JSON fixtures).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker`: unit tests, including the
  migration version guard and the fixture manifests.
- `yarn workspace @edit-issebya/worker test:tools`: real ffprobe on generated clips (owner's Mac).
- `yarn turbo run test:db --filter=./apps/studio`: `failures.test.ts`, `job-order.test.ts` and the
  updated `jobs.test.ts` and `pipeline-statuses.test.ts` against the reset ADW stack.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker`: the studio builds.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's full gates, unfiltered.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites, with the four new
  studio specs and the changed `change-requests` and `upload` specs, against the `/prepare_app`
  server.

## Notes

- **Profile over issue on the migration command.** The issue says to run
  `supabase migration up --local`; the profile's Protected section forbids it in a run and names
  `.adw/supabase-stack reset` as the way (it resets the ADW stack to the worktree's migrations). CI
  applies migrations to its own stack. The hosted project gets the migration from the owner after
  merge.
- **Captured AI messages.** The fixtures record the messages Claude Code is known to print for a
  usage limit and a signed-out tool; the pipeline never runs the real `claude` (and must not sign
  the machine's Claude Code out). Owner step: sign Claude Code out on the worker machine, run
  `claude -p --output-format json "hi"`, and compare stdout, stderr and the exit code with the
  fixtures; the same at a usage limit. If they differ, update the fixtures and the patterns in
  `ai-unavailable.ts` together.
- **Why `check_footage` caches its facts.** CI has no ffmpeg, and every studio spec relies on each
  step being a fingerprint hit. A kept `footage.json` under the step's fingerprint keeps that true,
  makes a retry after a refusal a hit, and lets the verdict (limits in `footage-limits.ts`) change
  without re-probing. No CI change is needed.
- **Download, not range read.** `check_footage` downloads the source into the job folder; `convert`
  reuses the local copy in the same job (`local` map in `run-pipeline.ts`), so the download is not
  repeated.
- **Retried step rows.** Each attempt gets its own step row so the log stays truthful; the first
  attempt reads `<name> failed, retried`.
- **Export button.** `exportBlockedReason` keeps its own rule; a render queued during processing
  now simply waits its turn in `claim_job`.
- No new dependency. No change to `turbo.json` (the specs pass `E2E_MOCK_STEP_RUN` to the child
  directly) or to `.github/workflows/ci.yml`.
- Browser coverage: the studio is a browser surface; the four new specs and the two changed ones
  cover it. The worker has none of its own.
- Manual acceptance (owner, not verified by the pipeline): upload a landscape clip and a two-minute
  clip (both refused at once); sign Claude Code out and process a real reel (fixed steps finish,
  the job waits, then finishes after signing in); kill the worker during background removal and
  restart it (the job resumes after the lease runs out); compare the finished reel with the old
  setup's.
- Out of scope: horizontal footage, clips over 90 s, several clips per reel, email alerts.
