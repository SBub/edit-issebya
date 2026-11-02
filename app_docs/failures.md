# Failures and footage checks

**Specifications:**

- specs/issue-39-adw-6f234803-sdlc_planner-failures-and-footage-checks.md

## Overview

Every failure case of the reel studio has one rule: unusable footage is refused at once by a first
`check_footage` step, a transient error re-runs its step once on its own, any other failure stops
the job with the step's error tail and a Retry button, an unavailable AI makes the job wait and say
why, and one reel runs one job at a time, in order. The owner always sees what happened and what to
do next.

## How it works

### Database

`supabase/migrations/20261102024708_failures_and_footage_checks.sql`:

- `jobs.status` gains `waiting_ai`, with `waiting_reason` and `not_before`; a check keeps them set
  together and only on a `waiting_ai` job. `steps.status` gains `waiting_ai` too.
- `jobs.retry_of_job_id` (owner-insertable). A unique index allows one retry per failed job and the
  `jobs_check_retry` trigger requires a failed job of the same reel, kind and parameters.
- `reels.status` gains `checking_footage` and `refused`; `reels.refusal_message` holds the owner's
  message.
- `claim_job` is rewritten: a job is claimable when `queued`, when `running` with an expired lease,
  or when `waiting_ai` with `not_before` passed, and never while another job of the same reel holds
  a live lease or is older and unfinished (queued, running, waiting). Other reels' jobs are taken
  meanwhile.
- `wait_for_ai(job, worker, reason, retry_after_seconds)`: moves the lease-held running job to
  `waiting_ai`, `not_before = now() + retry_after` on the database clock. False when the lease is
  lost.

### Worker

- `apps/worker/src/failures.ts`: `classifyFailure(error)`, the one classification
  (`transient | ai_unavailable | refused | permanent`), walking the `cause` chain. Transient:
  network error codes, fetch failures, timeouts, an HTTP status of 0 or 5xx (`dbFailure` carries
  the PostgREST status) and a tool killed by a signal. Permanent: a tool's non-zero exit, a
  `StepError`, a schema failure and anything unrecognised. Also `FootageRefusedError`,
  `AiUnavailableError` and `toolExitOf`.
- `apps/worker/src/step-runner.ts`: the shared `withStep` re-runs a step body once on a transient
  failure (each attempt is its own step row), writes a `waiting_ai` row for an AI-unavailable
  failure, and never retries anything else.
- `apps/worker/src/pipeline/check-footage.ts` and `footage-limits.ts`: the first `PIPELINE` step. One
  `ffprobe` call is normalised into the kept output `footage.json` (readable, format, video size
  and rotation, audio, duration). A pure verdict refuses a non-video, a clip without sound, a clip
  that is not vertical after rotation metadata, and one longer than 90 seconds (`FOOTAGE_LIMITS`),
  with the message from `FOOTAGE_MESSAGES` (for example `This clip is 2 minutes 10 seconds; the
studio takes up to 1 minute 30 seconds.`). The verdict is not part of the fingerprint, so a
  changed limit judges the stored facts again without a probe. `run-pipeline.ts` evaluates the
  gate on a run and on a cache hit; a refusal stops before any other step.
- `apps/worker/src/ai.ts` and `ai-unavailable.ts`: `AiResult` gains `{ kind: "unavailable", reason }`,
  recognised from Claude Code's usage-limit and signed-out messages (envelope and non-zero exit,
  captured under `apps/worker/src/testdata/ai-unavailable/`). `decide/run-decide.ts` throws
  `AiUnavailableError` on it.
- `apps/worker/src/run-job.ts`, `queue.ts`, `process-job.ts`: outcomes `refused` (job failed with
  the message, reel `refused` with `refusal_message`) and `waiting` (`wait_for_ai` with
  `AI_RETRY_AFTER_SECONDS`, 15 minutes), besides done, failed and lost. Fixed steps never need
  the AI and finish before the waiting.
- `apps/worker/src/pipeline/step-double.ts`: the test-only step double (see Configuration).

### Studio

- `apps/studio/src/lib/jobs.ts`, `reels.ts`: the new statuses and columns.
- `apps/studio/src/lib/job-failures.ts`: `waitingForAiLine` (`Waiting for the AI: <reason>. Next
try at HH:MM.`), `canRetry` and `isRetried`.
- `apps/studio/src/app/retry-actions.ts` and `components/RetryJobButton.tsx`: the `retryJob` server
  action reads the job, reel and the reel's jobs under RLS, checks `canRetry`, and inserts a job
  of the same kind and parameters with `retry_of_job_id`. A unique violation answers `already
retried`. Every step the failed job finished is a fingerprint hit, so the retry resumes at the
  failed step.
- `apps/studio/src/components/LiveReel.tsx`: the waiting line (`job-waiting-ai`), the refusal
  message (`reel-refusal`), the Retry button (`job-retry`) and `job-retried` on a retried job.
- `apps/studio/src/lib/change-requests.ts`, `changeRule`: replaces the interim "blocked during
  processing" rule. The change box is open while processing and says `Your change will run after
processing finishes.` (or `...after the current job finishes.`); it stays closed on a refused
  reel and before the reel has a version.

## How to Use

1. Upload footage. The reel shows `checking_footage`; a refused clip becomes `refused` with its
   message and no other step runs. Upload another clip to go on.
2. A hiccup (network, a 5xx, a tool killed by a signal) is retried once by the worker, with no
   action needed. The step log shows both attempts.
3. A failed job shows the step's error tail and a Retry button. Press it once: it resumes at the
   failed step. A failed job on a refused reel has no Retry.
4. `Waiting for the AI: usage limit reached. Next try at 14:30.` means Claude Code hit a limit or
   is signed out: fix it or wait; the worker tries again at that time and takes other reels'
   jobs meanwhile.
5. Send a change while a reel is processing: it runs after the current job.

## Configuration

- `E2E_MOCK_STEP_RUN=<step>:<mode>` (tests only, read only when `E2E_MOCK_STORAGE` is exactly
  `true`; listed in `apps/worker/.env.example`): `half` writes half of the committed output as a
  `.part` file and hangs until killed, `full` copies the committed outputs through a temporary
  name, `fail-transient` fails as a tool killed by SIGKILL.
- `E2E_MOCK_AI_SCRIPT` can serve the captured unavailable messages
  (`apps/studio/test-support/ai-script.ts`).
- The limits (90 seconds, vertical only, sound required) and the 15-minute waiting time are
  constants.

## Testing

- Unit (`yarn test`): `apps/worker/src/failures.test.ts`, `ai-unavailable.test.ts`, `ai.test.ts`,
  `pipeline/check-footage.test.ts` with the committed probe facts under
  `pipeline/testdata/footage/`, `pipeline/step-double.test.ts`, `step-runner.test.ts`,
  `pipeline/run-pipeline.test.ts`, `run-job.test.ts`, `queue.test.ts`, and the studio's
  `lib/job-failures.test.ts`, `change-requests.test.ts`, `jobs.test.ts`.
- Tools (`yarn workspace @edit-issebya/worker test:tools`, owner's Mac only):
  `pipeline/check-footage.tools.test.ts` probes the clips in `fixtures/footage-check/`.
- DB (`yarn test:db`): `apps/studio/db-tests/failures.test.ts` (retry trigger and unique index,
  `wait_for_ai`, statuses), `job-order.test.ts` (per-reel order, with the negative proof) and
  `jobs.test.ts`, `pipeline-statuses.test.ts`.
- E2E: `retry.spec.ts` (Retry resumes at the failed step), `refusal.spec.ts` (refused footage),
  `waiting-ai.spec.ts` (the waiting line and the later claim), `crash-resume.spec.ts` (SIGKILL
  mid-step, lease expiry, a second worker re-runs the step, the half-written file never becomes an
  output), `change-requests.spec.ts` (the change box during processing).

## Rules

- Never retry a step more than once automatically, and never for a non-transient failure.
- Never run two jobs of one reel at once; jobs of a reel run in creation order.
- Never claim a `waiting_ai` job before its `not_before`.
- A failed job has at most one retry; the database enforces it.
- Never offer Retry on a refused reel.
- Never run a step after the footage check refused the clip.
- The step double reads `E2E_MOCK_STEP_RUN` only when `E2E_MOCK_STORAGE` is exactly `true`.

## Notes

- The unavailable-AI message patterns come from captured fixtures; confirm them against the worker
  machine's Claude Code when it changes.
- Touched in the same change: the progress, ready notification, heartbeat and keep-awake feature
  (`app_docs/status.md`) was removed, along with its worker, studio and spec code; the docs that
  pointed to it were updated. `app_docs/pipeline.md`, `studio.md`, `change-requests.md` and
  `decide-step.md` describe the step list, the interim rule and the AI runner this feature
  changes.
- Owner step: apply the migration to the hosted project after merge.
