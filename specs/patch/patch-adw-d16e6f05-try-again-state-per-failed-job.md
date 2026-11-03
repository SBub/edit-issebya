# Patch: tie the overlay's Try again state to the failed job it was pressed for

## Metadata

adw_id: `d16e6f05`
review_change_request: `Issue #1: The overlay's Try again state in LiveReel.tsx (retryBusy and actionMessage) is a single page-level state that is never reset when a different failed job takes the overlay. After a successful Try again, setRetryBusy(true) stays set and actionMessage stays 'Queued again.'. If the retry job then fails too, the overlay shows the new failure ('Could not finish listening to your words') with a disabled Try again and the stale 'Queued again.' line. The owner cannot retry again without reloading the page. Reproduced in the browser on port 9205 with a transient failed job: clicked Try again, a job with retry_of_job_id was queued, that job was then failed, and the snapshot showed button 'Try again' [disabled] plus 'Queued again.'. This is a regression: the removed RetryButton was mounted once per job line, so each failed job had fresh state. It breaks the acceptance criterion 'A retryable failure shows Try again, which queues the job with retry_of_job_id'. Resolution: Fixable on this branch. Tie the Try again state to the failed job it was pressed for. Either key ProgressOverlay (or a small TryAgain child holding busy and message) by failure.jobId, or store the job id next to retryBusy and actionMessage and treat them as empty when it differs from the current failure's jobId. Add a case to apps/studio/e2e/retry.spec.ts, or a unit-level check, where a retried job fails again and the overlay offers an enabled Try again with no stale message. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-117-adw-d16e6f05-sdlc_planner-reel-progress-overlay.md`
**Issue:** `apps/studio/src/components/LiveReel.tsx` keeps `retryBusy` and `actionMessage` as two page-level `useState`s. After a queued Try again they stay `true` and `"Queued again."` forever, so when the retry job fails in turn the overlay shows the new failure with a disabled Try again and the stale line, and the owner must reload to retry.
**Solution:** Replace the two states with one state that names the failed job it belongs to, `{ jobId, busy, message } | null`, and derive the props passed to `ProgressOverlay` during render: busy and message only when `retry.jobId === failure?.jobId`, otherwise `false` and `""`. No effect, no key juggling, no change to `ProgressOverlay.tsx`. Cover it with a new case in `apps/studio/e2e/retry.spec.ts` where the retry job fails again and the overlay offers an enabled Try again with no action message, which queues a job naming the retry.

## Files to Modify

- `apps/studio/src/components/LiveReel.tsx`
- `apps/studio/e2e/retry.spec.ts`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Key the Try again state by the failed job in `LiveReel.tsx`

- Replace `const [retryBusy, setRetryBusy] = useState(false);` and `const [actionMessage, setActionMessage] = useState("");` (around line 170) with one state and a short comment saying it belongs to one failed job, so a later failure (for example the retry's own) starts fresh:
  `const [retry, setRetry] = useState<{ jobId: string; busy: boolean; message: string } | null>(null);`
- After `const failure = overlay.kind === "failure" ? overlay : null;` derive, during render (no effect):
  `const retryForFailure = failure && retry?.jobId === failure.jobId ? retry : null;`
- Rewrite `tryAgain()` to capture `const jobId = failure.jobId;` first, then use `setRetry({ jobId, busy: true, message: "" })` where it set busy and cleared the message, and `setRetry({ jobId, busy: <same rule as today>, message: <same text as today> })` for each outcome: `queued` keeps busy with `"Queued again."`, `already` keeps busy with `"This job is already being retried."`, `failed` and the refusal reason clear busy with their message, the `catch` clears busy with `"Retry did not start. Try again."`. `signed-out` still only calls `router.refresh()`. Keep `recordAction("try_again")` and the `requestRetry({ reelId: reel.id, jobId })` call unchanged.
- Pass `actionMessage={retryForFailure?.message ?? ""}` and `tryAgainBusy={retryForFailure?.busy ?? false}` to `ProgressOverlay`. Leave `ProgressOverlay.tsx` and its props untouched.
- No em-dashes in the comment.

### Step 2: Add a "retry fails again" case to `apps/studio/e2e/retry.spec.ts`

- Add a second `test(...)`, for example `"a retry that fails again offers a fresh Try again, live"`, with `test.setTimeout(180_000)`, its own reel from `insertQueuedReel({ admin, storage, ownerId: owner.id, prefix: CACHE_PREFIX })` and `seedPipelineCache(storage, CACHE_PREFIX, { except: ["transcribe"] })`, reusing the file's `STEPS`, helpers and owner.
- Run `runWorkerOnce({ ...STEPS, E2E_MOCK_STEP_FAULT: "transcribe:signal" })` (expect code 1, the job `failed`, `failure_kind` `transient`), sign in, open `/studio/reels/<reelId>`, wait for `[data-realtime="ready"]`, set the `__noReload` marker.
- Click `overlay-try-again`; poll `jobsOf` until it equals `[["failed", null], ["queued", jobId]]` and read the retry's id; expect the overlay to turn `working`.
- Run `runWorkerOnce({ ...STEPS, E2E_MOCK_STEP_FAULT: "transcribe:signal" })` again (expect code 1); poll `jobsOf` statuses to `["failed", "failed"]`.
- On the same live page (no reload, marker still set at the end): expect `data-overlay-kind="failure"`, `overlay-headline` `"Could not finish listening to your words"`, `overlay-try-again` visible and `toBeEnabled()`, and `overlay-action-message` with count 0 (the stale `"Queued again."` gone).
- Click it and poll `jobsOf` to `[["failed", null], ["failed", jobId], ["queued", retryId]]`, proving the second Try again queues a job whose `retry_of_job_id` is the failed retry. Then run `runWorkerOnce(STEPS)` (code 0) and poll the reel to `processed`, so no claimable job is left for later specs.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/studio && yarn turbo run typecheck --filter=./apps/studio && yarn knip`
- `yarn turbo run test --filter=./apps/studio`
- `yarn turbo run build --filter=./apps/studio`
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` (the `/prepare_app` server already up on this run's port; `retry.spec.ts` and `progress-overlay.spec.ts` must pass, with the new case)

## Patch Scope

**Lines of code to change:** about 20 in `LiveReel.tsx`, about 70 added in `retry.spec.ts`
**Risk level:** low
**Testing required:** the new E2E case (a retry that fails again offers an enabled Try again with no stale message and queues a retry of the retry), the existing retry and progress overlay specs, plus lint, typecheck, knip, unit and build for the studio
