# Patch: Capture the live waiting reason once the owner clears the leftover jobs, no code change

## Metadata

adw_id: `e5831ece`
review_change_request: `Issue #2: Visual evidence for the spec's central UI claim, the job-waiting paragraph ("waiting: 7.2 GB free on the worker's disk, needs 10 GB") under a queued job, could not be captured. The snapshot of the queued reel 412ce537 shows only process / queued / attempts: 0 and no waiting reason. That is correct conditional behaviour, because no worker_status row holds a reason. Producing one needs the worker's once run at low disk, which only disk-guard.spec.ts may spawn, and that spec is blocked by issue 1. The page layout with the change in place renders cleanly at 1920x1080 and 375x667, with no overflow or clipping. Resolution: Same root cause and resolution as issue 1: no branch patch resolves it. Once the owner clears the two leftover jobs and disk-guard.spec.ts passes, the waiting reason has been shown live through the real once path. A re-review can then capture it on the reel page during that spec's window, or from the spec's own trace. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-e5831ece-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** No screenshot exists of the `job-waiting` paragraph rendered by
`apps/studio/src/components/LiveReel.tsx`. It only appears when a `worker_status` row carries a
waiting reason, and the only sanctioned producer of that row is the worker's `once` spawned by
`apps/studio/e2e/disk-guard.spec.ts` with `E2E_MOCK_FREE_DISK_GB: "7.2"`. That spec is blocked in
`beforeAll` by the leftover queued jobs `625eec18-8c64-48cf-b3a6-85edb069dbf3` and
`b85f874b-6263-44db-bf74-fa59ecf655f4` (issue 1, see
`specs/patch/patch-adw-e5831ece-blocked-on-leftover-queued-jobs.md`). The empty state on reel
`412ce537` is correct behaviour, and the layout is clean at 1920x1080 and 375x667.
**Solution:** No code change. The paragraph must not be faked: no hand-written `worker_status`
row, no hand-started worker, no test-only render path, no edit to the spec's guard. After the owner
clears the two jobs, run `disk-guard.spec.ts` with a Playwright trace kept, so the trace holds a
DOM snapshot of the reel page at the moment `toHaveText("waiting: 7.2 GB free on the worker's
disk, needs 10 GB")` passes. The re-review takes its visual evidence from that trace (or captures
the reel page during the spec's window). Playwright's `--trace` flag goes after `--`, as the
profile's Tests section allows; nothing committed changes.

## Files to Modify

None. Explicitly unchanged:

- `apps/studio/src/components/LiveReel.tsx` (the `job-waiting` paragraph stays conditional on a
  real `worker_status` reason).
- `apps/studio/e2e/disk-guard.spec.ts` (assertions and `beforeAll` leftover-jobs guard as written).
- `apps/studio/playwright.config.ts` (no `trace` or `screenshot` setting is committed for this).
- `apps/studio/test-support/worker.ts` (`claimableJobIds` unchanged).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Wait on issue 1's owner step

- The owner finishes or removes jobs `625eec18-8c64-48cf-b3a6-85edb069dbf3` and
  `b85f874b-6263-44db-bf74-fa59ecf655f4` outside the run. The run never deletes, updates or claims
  them, never starts the worker (`worker`, `worker:prod`), never inserts a `worker_status` row by
  hand, and runs no database command except `supabase migration up --local`.
- Do not continue until the owner confirms the stack holds no claimable jobs.

### Step 2: Run the full E2E suite, then the disk-guard spec with a trace kept

- With the `/prepare_app` server up on `PORT=9214` (studio on `STUDIO_PORT=9114`, from
  `.ports.env`), run `PORT=9214 STUDIO_PORT=9114 yarn test:e2e` and confirm `disk-guard.spec.ts`
  and `upload.spec.ts` pass (issue 1's resolution).
- Then run the studio suite filtered to the disk-guard spec with a trace:
  `PORT=9214 STUDIO_PORT=9114 yarn turbo run test:e2e --filter=./apps/studio -- e2e/disk-guard.spec.ts --trace on`.
  (The landing suite runs first through turbo's dependency; that is expected.) Never set `CI=1`;
  never set, unset or override `PW_WEBKIT_WS`.
- If `beforeAll` still lists claimable jobs, stop and report the ids to the owner untouched.

### Step 3: Extract the visual evidence for the re-review

- Open the trace written under `apps/studio/test-results/` (the gitignored Playwright output) with
  `yarn workspace @edit-issebya/studio playwright show-trace <trace.zip>`, step to the passing
  `toHaveText("waiting: 7.2 GB free on the worker's disk, needs 10 GB")` assertion, and save the
  snapshot of the reel page under `agents/e5831ece/<agent_name>/review_img/` (never staged).
- Confirm the same trace shows the paragraph gone after the second `once` with 50 GB free
  (`toHaveCount(0)`) while `job-status` reads `done`, with no reload (`__noReload` marker kept).
- Do not commit the trace or the image.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `supabase migration up --local`: nothing new expected; on failure report and stop, never reset.
- `yarn turbo run test:db --filter=./apps/studio`
- `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`: landing suite, then the studio suite with
  `disk-guard.spec.ts` and `upload.spec.ts` passing.
- `PORT=9214 STUDIO_PORT=9114 yarn turbo run test:e2e --filter=./apps/studio -- e2e/disk-guard.spec.ts --trace on`:
  passes and leaves a trace whose snapshot shows the `job-waiting` paragraph with the exact text.
- `git status --porcelain -- apps/studio/src apps/studio/e2e apps/studio/test-support apps/studio/playwright.config.ts apps/worker/src`:
  prints nothing, proving the evidence came from unchanged code.

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** after the owner clears the two jobs, a passing `disk-guard.spec.ts` run with
`--trace on`, whose trace snapshot is the visual evidence of the live waiting reason; CI's fresh
stack repeats the spec on the pull request.
