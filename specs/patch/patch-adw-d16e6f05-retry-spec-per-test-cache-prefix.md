# Patch: give each retry.spec.ts case its own pipeline cache prefix

## Metadata

adw_id: `d16e6f05`
review_change_request: `Triage: run_defect: the studio E2E suite failed in CI on PR #118 (job https://github.com/SBub/edit-issebya/actions/runs/41642787163/job/125940248926). Find the failing spec, fix it on this branch, never weaken an assertion or retry a flake.`

## Issue Summary

**Original Spec:** `specs/issue-117-adw-d16e6f05-sdlc_planner-reel-progress-overlay.md`
**Issue:** The CI job's Playwright output names the one failure:
`[chromium] › e2e/retry.spec.ts:164:1 › a retry that fails again offers a fresh Try again, live`,
at `apps/studio/e2e/retry.spec.ts:175`, `expect(first.code, first.output).toBe(1)`, received `0`.
The worker output shows the job `claimed (attempt 1)` then `done`: the `transcribe:signal` fault
never fired because `transcribe` was a cache hit. Both cases in the file share one module-level
`CACHE_PREFIX`. The first case's Retry runs `transcribe` for real (the step double) and stores its
output at `<CACHE_PREFIX>cache/transcribe/<fingerprint>/...`. The fingerprint comes from the
committed fixture clip, so it is the same for the second case's reel, and
`seedPipelineCache(..., { except: ["transcribe"] })` only skips writing that step, it never removes
an existing entry. So the second case's worker finds the transcript cached, skips the faulted step
and finishes the job. The case passed nowhere before CI because it was added in 05e855d after the
test phase and never ran in E2E. No other spec failed (`1 failed` in the log); the overlay, test ids,
`failure_kind` and RLS checks the triage listed were never reached, and the code under test is not
at fault.
**Solution:** Fix the spec's isolation, not its assertions: each case gets its own fresh cache
prefix, so `except: ["transcribe"]` really means transcribe must run. Every prefix used is cleaned
up in `afterAll`. The assertions stay as they are.

## Files to Modify

- `apps/studio/e2e/retry.spec.ts`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the shared prefix with a per-case one

- Remove the module-level `CACHE_PREFIX` and `STEPS` constants. Add a module-level
  `const cachePrefixes: string[] = [];` and a helper:
  ```ts
  // Each case gets its own cache folder: a step one case runs is stored in the
  // cache, and would be a hit for the next case's reel (same fixture clip).
  function freshCache() {
    const prefix = `e2e-${crypto.randomUUID()}/`;
    cachePrefixes.push(prefix);
    return {
      prefix,
      steps: {
        R2_KEY_PREFIX: prefix,
        E2E_MOCK_STEPS: "true",
        E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER,
      },
    };
  }
  ```
  Keep the existing comments about the worker reading the folder through `R2_KEY_PREFIX` and the
  step double, moved onto the helper.
- In `afterAll`, delete every key under each prefix in `cachePrefixes` (same loop as today, once per
  prefix), then delete the test user as before.

### Step 2: Use it in both cases

- At the top of each case: `const { prefix, steps } = freshCache();`, then pass `prefix` to
  `insertQueuedReel` and `seedPipelineCache`, and use `steps` wherever the case used `STEPS`
  (`{ ...steps, E2E_MOCK_STEP_FAULT: "transcribe:signal" }` and plain `steps`).
- Change no assertion, timeout or expected value. The second case's comment "Finish the reel, so no
  claimable job is left for later specs." stays, and its third `runWorkerOnce(steps)` still has to
  exit 0 with the reel `processed`.

### Step 3: Reproduce and verify against this run's servers

- Start the servers with the profile's Workspaces web dev command through `/prepare_app` (never
  `CI=1`), then run `PORT=9205 STUDIO_PORT=9105 yarn test:e2e --filter=./apps/studio -- e2e/retry.spec.ts`.
  Before the change the second case fails at line 175 exactly as in CI (received 0); after it both
  cases pass.
- Then run the whole studio suite once (last Validation command) to prove no state leaks into a
  later spec (every spec's `beforeAll` that checks `claimableJobIds` must find none).

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn turbo run lint --filter=./apps/studio`
2. `yarn turbo run typecheck --filter=./apps/studio`
3. `yarn knip` and `yarn format:check`
4. `yarn turbo run test --filter=./apps/studio`, then `yarn turbo run test:db --filter=./apps/studio`
   (after `.adw/supabase-stack reset` if the stack is stale), then
   `yarn turbo run build --filter=./apps/studio`
5. `PORT=9205 STUDIO_PORT=9105 yarn test:e2e` (the full suite, against the `/prepare_app` servers,
   `workers: 1`), exit 0

## Patch Scope

**Lines of code to change:** about 20, one spec file
**Risk level:** low
**Testing required:** `retry.spec.ts` alone (both cases, the second failing before and passing
after), then the full E2E suite in one pass, plus the profile's lint, typecheck, knip, format, unit,
DB and build checks.
