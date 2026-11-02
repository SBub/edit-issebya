# Patch: verify the E2E suite on a clean ADW stack (the two studio failures were leftover state, not prepareScratchDir)

## Metadata

adw_id: `fb57dacf`
review_change_request: `Issue #2: The spec's Validation Command yarn test:e2e (run as PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e) is unverified. The reviewer's run was stopped at the 10-minute background limit; change-requests.spec.ts:160 and footage-refusal.spec.ts:37 failed (both spawn once) and the specs after preview.spec.ts never ran. Resolution: find out why the two fail on this branch, fix prepareScratchDir or apps/studio/test-support/worker.ts if the start-up step causes it, then run the full yarn test:e2e to completion and confirm it exits 0. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-91-adw-fb57dacf-sdlc_planner-worker-scratch-dir-and-r2-write-probe.md`

**Issue:** The full `yarn test:e2e` never ran to completion on this branch, and two studio specs that spawn `once` failed in the reviewer's run with no investigation.

**Findings (investigated while planning, port 9205 / studio 9105):**

- `prepareScratchDir` is not the cause. The specs' `once` reads `apps/worker/.env.development`, whose `WORKER_SCRATCH_DIR` (`~/.edit-issebya-worker/dev`) already exists and is writable, so the new `mkdir(dir, { recursive: true })` changes nothing for them. Crash-resume (which passes its own `WORKER_SCRATCH_DIR`), disk-guard, export, notification and preview all pass with the same start-up step.
- The cause is leftover state on the shared ADW stack. The reviewer's run was killed at the 10-minute limit in the middle of a `render` job (progress.spec.ts runs after preview.spec.ts). That left job `cb00baed-...` as `running` with a lease that expired at 15:37:04Z. `claim_job` takes the oldest claimable job across the whole stack, so once the lease expired, the next spec's `once` claimed the stale render job instead of its own job. That spec then timed out at the 30 s test timeout. Every later spec's `beforeAll` guard then refused with `claimable jobs already on the local stack`. The reviewer's own two failures fit the same pattern: something the stack held when the suite started (no failure detail survived in `/tmp/review-fb57dacf-e2e.log`).
- After `ADW_ID=fb57dacf .adw/supabase-stack reset`, both specs pass on this branch. footage-refusal passed alone (14.4 s), and change-requests plus footage-refusal passed together (6 passed, 28.6 s). The whole studio suite passed: `yarn workspace @edit-issebya/studio test:e2e` gave 34 passed (3.1 m), exit 0, including retry, step-log, upload, waiting-ai and worker-offline.
- Not run on `origin/develop`: this run may not check out files from another branch. The only change on the `once` path is `await prepareScratchDir(config.scratchDir)` in `apps/worker/src/once.ts`, which is a no-op on an existing folder. The passing runs above, on this branch, show it does not cause these failures.
- Two full `PORT=9205 STUDIO_PORT=9105 yarn test:e2e` runs on this branch each stopped in the landing suite (139 of 140 passed), with a different spec failing each time. The first was `landing_content.spec.ts:9` at 375x667: `locator.boundingBox` hung on an h1 that was already visible, until the 30 s timeout. The second was `confirmation_email.spec.ts:89`: `POST /api/stripe/webhook` failed with `read ECONNRESET` from the dev server. Each passed on the other run and in the reviewer's run, and this branch changes nothing under `apps/web`. They are environmental flakes of the local dev server. They are out of scope here and should be fixed in their own PR, never re-run in CI to get a pass.

**Solution:** No code change. The start-up step is correct and the spec's worker environment needs no change. The patch is to start the E2E validation from a clean ADW stack (no claimable or lease-expired job left by an interrupted run) and to run the full suite in the foreground until it finishes.

## Files to Modify

None. `apps/worker/src/once.ts`, `apps/worker/src/scratch.ts` and `apps/studio/test-support/worker.ts` stay as they are.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Make sure no interrupted run left a claimable job on the ADW stack

- Check that no job is `queued`, `waiting_ai` past `not_before`, or `running` with an expired lease (the same query as `claimableJobIds` in `apps/studio/test-support/worker.ts`). Also check for any `running` job whose lease is still live, because once that lease expires a later spec's `once` claims it.
- If any is found, run `ADW_ID=fb57dacf .adw/supabase-stack reset` (the only allowed way to reset the ADW stack; never a bare `supabase` command). If it fails, report its error and stop.

### Step 2: Run the two flagged specs on this branch

- `PORT=9205 STUDIO_PORT=9105 yarn test:e2e -- e2e/change-requests.spec.ts e2e/footage-refusal.spec.ts` against the running `/prepare_app` server (ports from `.ports.env`). Expect every test in both files to pass.

### Step 3: Run the full E2E suite to completion in the foreground

- `PORT=9205 STUDIO_PORT=9105 yarn test:e2e`, in the foreground or with a timeout of at least 30 minutes (the landing suite takes about 5 minutes and the studio suite about 3). Never stop it part-way: a killed `once` leaves a `running` job behind that breaks the next run (go back to Step 1 if that happens).
- Confirm exit 0. If a landing spec fails again with a dev-server hang or `ECONNRESET` and nothing under `apps/web` changed, record it as a separate flaky-spec fix. Do not weaken or skip the spec here.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn turbo run lint --filter=./apps/worker`
2. `yarn turbo run typecheck --filter=./apps/worker`
3. `yarn knip`
4. `yarn turbo run test --filter=./apps/worker`
5. `PORT=9205 STUDIO_PORT=9105 yarn test:e2e` (after Step 1; runs to completion, exit 0)

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** a clean ADW stack, the two flagged studio specs, then the full landing and studio E2E suites run to completion with exit 0.
