# Patch: failures docs, doc pointers and the ADW profile Tests section (spec step 16)

## Metadata

adw_id: `f5af08ca`
review_change_request: `Triage: run_defect: the review stopped because the implementer skipped spec step 16 (docs and the ADW profile) and the reviewer captured no screenshots of the changed studio components. Implement step 16, docs only, no code change.`

## Issue Summary

**Original Spec:** `specs/issue-39-adw-f5af08ca-sdlc_planner-failures-and-footage-checks.md` (step 16)
**Issue:** The run's code is in (`git diff origin/develop...HEAD --stat` shows the migration, `apps/worker/src/failure.ts`, `footage-check.ts`, `step-double.ts`, the two DB tests and four new studio E2E specs), but none of the step 16 documentation exists: no `app_docs/failures.md`, no index line, the change-requests, studio and decide-step docs still describe the interim one-job-at-a-time rule and "no retry limit", and `.adw/project.md` Tests does not list the new tests or the `ffprobe` need.
**Solution:** Write `app_docs/failures.md` from the committed code (facts read from the source, never invented), add its index line, update the three existing docs in place and extend the profile's Tests section. Change no code, test or migration. Screenshots (review blocker 2) are out of scope for this patch; the re-review completes the visual pass.

## Files to Modify

Use these files to implement the patch:

- `app_docs/failures.md` (new)
- `docs/conditional-docs.md`
- `app_docs/change-requests.md`
- `app_docs/studio.md`
- `app_docs/decide-step.md`
- `.adw/project.md` (Tests section only)

Read only, as the source of every fact: `apps/worker/src/failure.ts`, `apps/worker/src/pipeline/footage-check.ts`, `apps/worker/src/pipeline/step-double.ts`, `apps/worker/src/pipeline/fake-step.ts`, `apps/worker/src/step-runner.ts`, `apps/worker/src/ai.ts`, `apps/worker/src/decide/run-decide.ts`, `apps/worker/src/decide/testdata/claude-signed-out*.{json,txt}` and `claude-usage-limit.json`, `apps/worker/src/queue.ts`, `apps/worker/src/run-job.ts`, `apps/worker/.env.example`, `supabase/migrations/20261102040716_failures_and_footage_checks.sql`, `apps/studio/src/lib/change-requests.ts`, the studio Retry action and components from the diff, the spec's block E edge cases (`## Edge Cases`, line ~634) and step 2 to 9 text.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Create `app_docs/failures.md`

- Title line, then `##` sections in this order: Overview, How it works, How to Use, Configuration, Testing, Rules. Follow the tone and layout of `app_docs/status.md` and `app_docs/storage.md`.
- How it works, one `###` subsection per item:
  - Edge cases: the spec's block E cases and the rule each follows.
  - Transient errors: a table built from `apps/worker/src/failure.ts` (`TransientError`, exit by signal, the `NETWORK_CODES` list including `ECONNRESET`/`ECONNREFUSED` and `UND_ERR_*`, `TypeError` "fetch failed", HTTP status >= 500, `$fault === "server"`, the `TIMEOUT_NAMES`, Supabase store 5xx; everything else permanent). Copy the lists exactly from the file.
  - The one automatic retry: exactly one, transient only, and the step rows it leaves (read `step-runner.ts` and `step-store.ts`: the failed attempt's row and the retry's row).
  - Abandoned step rows: what marks a row abandoned and when (from `step-store.ts`/`run-job.ts`).
  - Retry button: inserts a new job with `retry_of_job_id` pointing at the failed job; the insert policy calls the security-definer helper `public.is_retry_of_failed_job(...)` because an inline subquery on `jobs` inside a `jobs` policy is rejected as RLS recursion; execute rights as the migration grants them.
  - Waiting for the AI: the runner's `unavailable` result, job status `waiting_ai` with `waiting_reason` and `not_before` (15 minutes later), the step row `waiting`, the check constraint tying the three together, and that `claim_job` skips a job until its `not_before`.
  - Not-available fixtures: `apps/worker/src/decide/testdata/claude-signed-out.json`, `claude-signed-out-stdout.txt`, `claude-usage-limit.json` hold best-known texts and still need capturing on the worker machine (`claude -p --output-format json` signed out and at the usage limit), replacing the fixtures and, if needed, the regexes in `ai.ts`.
  - Per-reel order in `claim_job`: one job per reel at a time (no other `running` or `waiting_ai` job on the reel), oldest first, as the migration's `claim_job` has it.
  - Footage check: `check_footage` runs first in every process job via `ffprobe`; the four limits from `FOOTAGE_LIMITS` and the exact refusal messages copied verbatim from `footage-check.ts` (not vertical, too long, not a video/image, no audio as the file has them), plus the success line `footage checked, M:SS, W x H`; a missing `ffprobe` is a broken worker, never a refusal.
  - Step double: `apps/worker/src/pipeline/step-double.ts` and `fake-step.ts`, `E2E_MOCK_STEPS=true` copies the `fixtures/pipeline/` outputs, `E2E_MOCK_STEP_FAULT=<step>:<signal|exit|half>`.
- How to Use: what the owner sees for a refused clip, a failed job and its Retry button, a job waiting for the AI, and the change box queue note.
- Configuration: `E2E_MOCK_STEPS` and `E2E_MOCK_STEP_FAULT` (format and that they are E2E only), matching `apps/worker/.env.example`.
- Testing: `failure.test.ts`, `footage-check.test.ts`, `footage-check.tools.test.ts` (real ffprobe, `test:tools`), `step-double.test.ts`, `step-runner.test.ts`, `queue.test.ts`, `run-pipeline.test.ts`, `ai.test.ts`, `run-decide.test.ts`, DB `job-order.test.ts` and `retry-jobs.test.ts`, E2E `crash-resume.spec.ts`, `footage-refusal.spec.ts`, `retry.spec.ts`, `waiting-ai.spec.ts`.
- Rules (each a "Never"/"Do not" line): exactly one automatic retry, and only for transient errors; no heavy step before `check_footage` passes; one job per reel at a time, in order, enforced in `claim_job`; fixed steps never wait for the AI; no refusal limits beyond the four; never turn the step double on unless its flag is exactly `"true"`.

### Step 2: Index line in `docs/conditional-docs.md`

- Append: ``- Read `app_docs/failures.md` when changing job failures, transient errors or the one automatic retry, the Retry button or `retry_of_job_id` and its policy, `waiting_ai`, `waiting_reason` or `not_before`, the per-reel order in `claim_job`, the footage check (`check_footage`) or its refusal messages, or the step double (`E2E_MOCK_STEPS`, `E2E_MOCK_STEP_FAULT`).``
- In the `change-requests.md` line, change "the one-job-at-a-time rule" to "when the change box is blocked or queued".

### Step 3: `app_docs/change-requests.md`

- How it works (lines ~25-31): `requestChange`/`requestRestore` refuse with `blocked` only in the cases `changeBlockedReason` in `apps/studio/src/lib/change-requests.ts` has now (read it and state them exactly); describe `changeBlockedReason` the same way, dropping "interim".
- How to Use (line ~59): the change box stays open while the reel is processing and shows `Your change will run after processing finishes.`; list the blocked cases as the code has them; the order is `claim_job`'s, see `app_docs/failures.md`.
- Notes (line ~78): replace the interim rule bullet with one saying jobs are ordered per reel in `claim_job` (`app_docs/failures.md`) and the Export button follows its own rule (`app_docs/export.md`). Check the Rules section for an interim-rule line and update it in the same way if present.

### Step 4: `app_docs/studio.md`, `app_docs/decide-step.md`

- studio.md line ~96-98: keep the lease description, add that `claim_job` takes one job per reel at a time in order and skips a `waiting_ai` job until `not_before` (see `app_docs/failures.md`); delete "There is no retry limit yet.". Line ~238: drop "and a retry limit" from the later-slices note. Under "Storage and AI doubles" (line ~133) add the step double with a pointer to `app_docs/failures.md`.
- decide-step.md: in How it works, the AI runner bullet (line ~40) gains the `unavailable` result (signed out or usage limit, recognised from Claude's output in `ai.ts`), which makes the job wait (`app_docs/failures.md`) instead of failing; in Failure (line ~74) add that a transient retry is the step runner's and never adds AI calls (state precisely what `run-decide.ts` does).

### Step 5: `.adw/project.md` Tests section only

- In the DB layer sentence add `job-order.test.ts` (one job per reel, in order, `not_before`) and `retry-jobs.test.ts` (the Retry insert policy through `is_retry_of_failed_job`).
- In the E2E list add `crash-resume.spec.ts`, `footage-refusal.spec.ts`, `retry.spec.ts` and `waiting-ai.spec.ts`, one clause each from the spec's step 14.
- In the worker `test:tools` clause add `footage-check.tools.test.ts` (real ffprobe).
- Add: the E2E suite needs `ffprobe` on the PATH, because every `process` job runs `check_footage` (CI installs ffmpeg).
- Do not rename or reorder any of the nine `##` headings or touch other sections.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `git diff --stat` shows only the six files above (no code, test or migration).
- A search for the em-dash character (U+2014) over the changed files prints nothing.
- `grep -n "^## " .adw/project.md` prints the nine headings unchanged: Identity, Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review.
- `yarn format:check` (run `yarn format` and re-check if it fails).
- `yarn knip`

## Patch Scope

**Lines of code to change:** about 200 lines of Markdown (about 150 new in `failures.md`, the rest in-place edits), 0 lines of code.
**Risk level:** low
**Testing required:** format check and knip only; docs change no gate. The re-review must still capture the studio screenshots (sign in with `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`, /studio and the received sample reel's page with the open change box at 1920x1080 and 375x667 into `agents/f5af08ca/reviewer/review_img/`, after the E2E run) and add the one-line PR callout for the security-definer retry policy.
