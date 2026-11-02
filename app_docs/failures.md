# Failures, footage checks, the one retry and waiting for the AI

**Specifications:**

- specs/issue-39-adw-f5af08ca-sdlc_planner-failures-and-footage-checks.md

## Overview

Every `process` job starts by checking the footage, so a clip the studio cannot take is refused
with a human message before any heavy step runs. A step that fails for a passing reason (a network
hiccup, a 5xx, a tool killed by a signal) is run once more on its own; any other failure fails the
job, and the owner can press Retry, which queues a new job that resumes at the step that failed.
When Claude Code is signed out or at its usage limit, the job waits and is taken again 15 minutes
later instead of failing. The database runs one job per reel at a time, in order, so a change can
be sent while the reel is still processing.

## How it works

### Database

`supabase/migrations/20261102040716_failures_and_footage_checks.sql`:

- `reels.status` gains `checking_footage` and `refused`; `reels.refusal_message` (1 to 300
  characters) is set exactly when the reel is `refused` (`reels_refusal_check`).
- `jobs.status` gains `waiting_ai`; new columns `waiting_reason` (1 to 200 characters),
  `not_before` (`timestamptz`) and `retry_of_job_id` (`references jobs (id) on delete set null`).
  `jobs_waiting_check`: a job is `waiting_ai` exactly when it has a `waiting_reason`, and exactly
  when it has a `not_before`.
- `jobs_retry_of_job_id_key`: a unique partial index on `retry_of_job_id`, so a failed job is
  retried at most once.
- `steps.status` gains `waiting`.
- `jobs_claimable_idx` is rebuilt on `(created_at, id)` for `queued`, `running` and `waiting_ai`.

### Edge cases

The issue's block E, and the rule each follows:

| Case                                                                         | Rule                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Portrait footage stored landscape with rotation 90 or -90, or a `rotate` tag | Accepted: the display size swaps width and height for a quarter turn.             |
| Rotation 180 on footage stored landscape                                     | Still landscape: refused as not vertical.                                         |
| Square footage                                                               | Refused as not vertical (height must be greater than width).                      |
| Exactly 90.0 s / 90.4 s                                                      | 90.0 s accepted; 90.4 s refused and shown as `1 minute 31 seconds` (rounded up).  |
| A renamed text file, an image, an audio file with cover art                  | "Not a video", a refusal, never a step failure.                                   |
| Retry of a refused process job                                               | No button, and the Retry action refuses it too.                                   |
| Double click on Retry                                                        | The unique index lets one job through; the second answer is `already`.            |
| A transient failure during the retry attempt                                 | The job fails: no third run.                                                      |
| A lease lost mid-step                                                        | Never retried, nothing written.                                                   |
| A decide call that fails transiently after the AI answered                   | Not retried: at most two AI calls per decide step.                                |
| A waiting `process` job                                                      | Holds its reel's newer change job; other reels' jobs keep running.                |
| A change sent while processing                                               | Waits, then decides from the processed reel's current version.                    |
| A process job taken again after a crash                                      | Its abandoned `running` step rows end `failed`.                                   |
| `waiting_ai` with `not_before` in the past                                   | Claimable; the claim clears the reason and `not_before`.                          |
| Clock drift between host and database                                        | Tests set `not_before` and leases an hour or a minute away on the database clock. |

### Transient errors

`apps/worker/src/failure.ts`, `isTransient(error)`, walks the error and its `cause` chain, outer to
inner (at most ten links); the first link that decides wins:

| Link                                                                                                                                               | Verdict   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `PermanentError`, `FootageRefused`, `AiUnavailable`                                                                                                | permanent |
| an `Error` named `StepError` (a step's own check failed)                                                                                           | permanent |
| `TransientError`                                                                                                                                   | transient |
| `exitSignal` is a string (a tool killed by a signal)                                                                                               | transient |
| `code` in `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, or starting with `UND_ERR_` | transient |
| a `TypeError` whose message is `fetch failed`                                                                                                      | transient |
| `$metadata.httpStatusCode` >= 500                                                                                                                  | transient |
| `$fault === "server"`                                                                                                                              | transient |
| `name` in `TimeoutError`, `RequestTimeout`, `RequestTimeoutException`                                                                              | transient |
| `status` >= 500                                                                                                                                    | transient |

A chain no link decides is permanent (a tool's non-zero exit with its message, for example).
`supabaseFailure(what, { error, status })` is what the stores throw for a failed Supabase call: a
`TransientError` for a status of 500 or more or postgrest-js's network failure (status 0), a plain
`Error` otherwise.

### The one automatic retry

`withStep` in `apps/worker/src/step-runner.ts` runs a step's body at most twice:

- A failure on the first attempt that `isTransient` calls transient marks that attempt's row
  `failed` with the summary `<name> failed, retrying once`, waits 2 seconds
  (`TRANSIENT_RETRY_DELAY_MS`) and runs the body again in a new row. The step log then shows both
  rows.
- A second failure, or any non-transient failure, marks the row `failed` (`<name> failed`) and
  fails the step, so the job fails with the error tail.
- An unavailable AI marks the row `waiting` and is never retried here (the job waits, below).
- A lost lease is never retried and writes nothing more; the retry's pause is aborted with it.
- The span of each attempt carries `step.attempt`.

### Abandoned step rows

A job claimed again after its worker stopped (`attempts` above 1) first calls
`StepStore.abandonRunning(job.id)` (`apps/worker/src/process-job.ts`): every row the job left
`running` ends `failed` with the tail `the worker stopped during this step; the job was taken again`
(`apps/worker/src/step-store.ts`), so the step log never shows a step running forever. The step
then runs again in a new row; a half-written `<file>.part` was never uploaded, so nothing of it is
stored.

### Retry button

- `apps/studio/src/lib/failures.ts`, `retryableJobIds`: a `failed` job shows Retry while no other job
  names it in `retry_of_job_id`; none while the reel is `refused`.
- `apps/studio/src/components/RetryButton.tsx` calls the server action `requestRetry`
  (`apps/studio/src/app/retry-actions.ts`). It reads the reel and the job under RLS as the owner,
  answers `blocked` for a refused reel (`This clip was refused; upload another clip.`) or a job that
  is not `failed` (`Only a failed job can be retried.`), then inserts a new job of the same reel,
  kind and parameters (`request`, `restore_version_id`, `version_id`) with `retry_of_job_id` set to
  the failed job. A unique-violation (`23505`) answers `already`, shown as
  `This job is already being retried.`. Every step before the one that failed is a fingerprint hit,
  so the new job resumes there.
- `grant insert (retry_of_job_id)` to `authenticated`, on top of the existing insert grants.
- The restrictive insert policy `jobs: a retry names a failed job of the same reel, kind and
parameters` applies on top of every permissive insert policy (process, change or restore, render):
  `retry_of_job_id is null or public.is_retry_of_failed_job(retry_of_job_id, reel_id, kind,
request, restore_version_id, version_id)`.
- `public.is_retry_of_failed_job(...)` is `security definer` (`search_path = ''`, `stable`): it
  checks the named job is the caller's, of the same reel, `failed`, and of the same kind and
  parameters. A policy on `jobs` that reads `jobs` in an inline subquery is rejected by Postgres as
  infinite recursion, hence the helper. Execute is revoked from `public`, `anon` and `service_role`
  and granted to `authenticated` only.
- The jobs list marks a retry job with `retry` (`data-testid="job-retry-of"`).

### Waiting for the AI

- `apps/worker/src/ai.ts`: the runner's result may be `{ kind: "unavailable", reason }`.
  `aiUnavailableReason` recognises Claude's output (the result text, or a failed call's message):
  `/usage limit|limit reached|hit your limit/i` gives `the usage limit is reached`;
  `/please run \/login|not logged in|invalid api key|oauth token has expired|authentication_error/i`
  gives `Claude Code is signed out`.
- `apps/worker/src/decide/run-decide.ts` throws `AiUnavailable(reason)` for that result. The step
  runner marks the step row `waiting` (tail the reason, summary `<name> waiting for the AI`), and
  `runJob` (`apps/worker/src/run-job.ts`) calls `waitJob` (`apps/worker/src/queue.ts`) instead of
  failing the job.
- `waitJob` sets the job `waiting_ai` with `waiting_reason` and `not_before` 15 minutes later
  (`AI_RETRY_MINUTES`), and gives up its lease. The reel's status stays as it is.
- `claim_job` skips a `waiting_ai` job until its `not_before`; the claim clears both columns. The
  worker's periodic check also lists `waiting_ai` jobs past their `not_before`.
- The studio shows `Waiting for the AI: <reason>. Next try at HH:MM.` under the job
  (`formatWaitingForAi`, 24-hour local time, `data-testid="job-waiting-ai"`), and the waiting step
  row's reason under `Show error`.

### Not-available fixtures

`apps/worker/src/decide/testdata/claude-signed-out.json`, `claude-signed-out-stdout.txt` and
`claude-usage-limit.json` hold the best-known texts of a signed-out Claude Code and one at its usage
limit. They still need capturing on the worker machine (`claude -p --output-format json` signed out,
and at the usage limit); the captured output replaces the fixtures and, if it does not match, the
regexes in `ai.ts`.

### Per-reel order in `claim_job`

`claim_job(p_worker, p_lease_seconds)` takes the oldest claimable job (`order by created_at, id`,
`for update skip locked`): `queued`, `waiting_ai` past its `not_before`, or `running` with an
expired lease. A job is skipped while another job of its reel is `running` under a live lease, or
while an older job of its reel is still `queued`, `running` or `waiting_ai`. So one job per reel
runs at a time, in the order they were created; jobs of other reels keep running. Two workers
claiming at once cannot run two jobs of a reel: the second skips the row the first has locked and
still sees it `queued` and older, so it skips the sibling too. Only `service_role` may execute it.

### Footage check

- `check_footage` is the first step of every `process` job (`runPipeline` with `checkFootage`,
  `apps/worker/src/pipeline/run-pipeline.ts`); a render never checks. The reel is
  `checking_footage` while it runs. The step downloads the source (where `convert` reads it, so
  `convert` downloads nothing more) and probes it with `ffprobe`
  (`apps/worker/src/pipeline/footage-check.ts`). `ffprobe` is found beside `FFMPEG_PATH`, or on the
  `PATH` when that is a bare name.
- `FOOTAGE_LIMITS = { maxSeconds: 90 }` is the one place the limit lives; the other three rules are
  yes or no. The first failing rule wins, in this order:

| Rule                                                        | Message                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| a video (no probe, an image container `image2` or `*_pipe`) | `This file is not a video. Upload a clip from your phone (MP4 or MOV).`     |
| with sound                                                  | `This clip has no sound. The studio needs your voice to make the captions.` |
| vertical (display height greater than width)                | `This clip is W x H, not vertical. The studio takes vertical clips only.`   |
| at most 90 seconds                                          | `This clip is <duration>; the studio takes up to 1 minute 30 seconds.`      |

- `<duration>` is whole seconds rounded up: `2 minutes 10 seconds`, `1 minute`, `45 seconds`.
- An ffprobe exit that is not 0, 126 or 127, output that does not parse, or a probe error is "not a
  video". A refusal throws `FootageRefused`; `runJob` sets the reel `refused` with the message and
  no later step runs.
- Accepted footage writes the step `footage checked, M:SS, W x H` (display size).
- A missing `ffprobe` (sh exit 126 or 127) is a broken worker: the step fails, the clip is never
  refused for it.

### Step double

`apps/worker/src/pipeline/step-double.ts`, `stepDouble(env)`: only when `E2E_MOCK_STEPS` is exactly
`"true"`. A fixed step that must run spawns `apps/worker/src/pipeline/fake-step.ts` through the
step's own tool (so the step runner measures it, sees its exit and retries it like a real tool),
which copies the step's committed outputs from `fixtures/pipeline/` as `<file>.part` and renames
them. It knows only the fixture clip: a step whose fingerprint is not the manifest's is refused.
`E2E_MOCK_STEP_FAULT=<step>:<signal|exit|half>` makes one step fail on purpose: `signal` kills
itself with SIGKILL (transient), `exit` exits 1 (permanent), `half` writes the first half of the
first output as its `.part` and waits up to 20 seconds for the spec to kill the worker.
`fake-step.ts` refuses to run without `E2E_MOCK_STEPS=true`.

## How to Use

1. Upload a clip. While it is checked the reel reads `checking_footage`. A clip the studio cannot
   take turns the reel `refused` and shows the reason in a red box; the change box says
   `This clip was refused; upload another clip.` and no job offers Retry. Upload another clip.
2. A failed job shows Retry in the jobs list. Pressing it queues a new job, marked `retry`, which
   skips every step already done and runs from the one that failed.
3. A job waiting for the AI shows `Waiting for the AI: <reason>. Next try at HH:MM.`. Sign Claude
   Code in again or wait for the limit; the worker takes the job again after that time.
4. The change box stays open while the reel processes and shows
   `Your change will run after processing finishes.` (or
   `Your change will run after the jobs before it finish.`); the change runs in its turn.

## Configuration

Both are E2E only (`apps/worker/.env.example`), never set on the worker machine:

- `E2E_MOCK_STEPS`: the step double, on only when exactly `true`.
- `E2E_MOCK_STEP_FAULT`: read only when `E2E_MOCK_STEPS` is exactly `true`; one step that fails on
  purpose, as `<step>:<signal|exit|half>`. Any other form throws.

The worker needs `ffprobe` beside `ffmpeg` (or on the `PATH`), and so does the E2E suite.

## Testing

- Unit (`apps/worker`): `src/failure.test.ts`, `src/pipeline/footage-check.test.ts` (the probe
  samples under `src/pipeline/testdata/`), `src/pipeline/step-double.test.ts`,
  `src/step-runner.test.ts`, `src/queue.test.ts`, `src/pipeline/run-pipeline.test.ts`,
  `src/ai.test.ts`, `src/decide/run-decide.test.ts`.
- Tools: `apps/worker/src/pipeline/footage-check.tools.test.ts` (real ffprobe, `yarn workspace
@edit-issebya/worker test:tools`).
- Unit (`apps/studio`): `src/lib/failures.test.ts`, `src/lib/change-requests.test.ts`.
- DB: `apps/studio/db-tests/job-order.test.ts` (one job per reel, in order, `not_before`) and
  `retry-jobs.test.ts` (the Retry insert policy through `is_retry_of_failed_job`).
- E2E (`apps/studio/e2e/`): `footage-refusal.spec.ts` (a landscape clip refused live, one step row),
  `retry.spec.ts` (a signal-killed `transcribe` run twice, then Retry resumes at it),
  `waiting-ai.spec.ts` (the usage-limit fixture, the waiting line live, then taken again),
  `crash-resume.spec.ts` (a worker killed mid-step, the abandoned row `failed`, the output stored
  once).

## Rules

- Never retry a step automatically more than once, and never for an error `isTransient` does not
  call transient.
- Do not run a heavy step before `check_footage` passes.
- Never run two jobs of a reel at once or out of order; the order is enforced in `claim_job`, not
  in the studio.
- Fixed steps never wait for the AI; only an AI call may make a job `waiting_ai`.
- Do not add refusal limits beyond the four rules.
- Never turn the step double on unless `E2E_MOCK_STEPS` is exactly `"true"`.
