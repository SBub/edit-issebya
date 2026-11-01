# Patch: Blocked on two leftover queued jobs; owner clears them, then the E2E and DB suites are re-run unchanged

## Metadata

adw_id: `e5831ece`
review_change_request: `Issue #1: The spec's E2E Validation Command PORT=9214 STUDIO_PORT=9114 yarn test:e2e exited 1 again (third run). The landing suite passed (140 passed) and 8 studio specs passed. Both specs this change relies on failed in beforeAll before any step ran: e2e/disk-guard.spec.ts and e2e/upload.spec.ts threw "claimable jobs already on the local stack (a crashed run or a connected dev worker): 625eec18-8c64-48cf-b3a6-85edb069dbf3, b85f874b-6263-44db-bf74-fa59ecf655f4". The same leftover jobs also fail db-tests/jobs.test.ts's suite guard under yarn turbo run test:db --filter=./apps/studio. The browser confirms they are still queued: reel 412ce537 (review-35mb.mp4, studio-review@example.test, created 09:07 UTC) shows process queued attempts: 0. Three acceptance criteria therefore remain unverified end to end: (1) at 9 GB free with a 10 GB minimum, once makes no claim_job call and prints no job: <reason>; (2) the reel page shows the waiting reason live without a reload and hides it once there is room; (3) a studio upload leaves exactly one stored_files source row, and the reel's objects match its live rows. The unit and DB layers (disk-guard.test.ts, stored-files.test.ts, db-tests/stored-files.test.ts) cover the same logic and pass. Resolution: No code patch on this branch can resolve this: the cause is the state of the shared local Supabase stack, and the leftover-jobs guard in both specs is correct and must not be weakened, skipped or narrowed. The owner must finish or remove jobs 625eec18-8c64-48cf-b3a6-85edb069dbf3 and b85f874b-6263-44db-bf74-fa59ecf655f4 outside the run (the run must not delete them or start the worker). Then re-run PORT=9214 STUDIO_PORT=9114 yarn test:e2e and confirm disk-guard.spec.ts and upload.spec.ts pass. CI's fresh stack also runs both on the pull request. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-e5831ece-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** Third run blocked by the same shared-stack state. The two earlier patch plans
(`specs/patch/patch-adw-e5831ece-clear-leftover-jobs-rerun-e2e.md` and
`specs/patch/patch-adw-e5831ece-owner-clears-jobs-before-e2e-rerun.md`) handed jobs
`625eec18-8c64-48cf-b3a6-85edb069dbf3` and `b85f874b-6263-44db-bf74-fa59ecf655f4` to the owner, but
both are still `queued` (attempts 0) on `studio-review@example.test`'s `review-35mb.mp4` reels
(reel `412ce537`, created 09:07 UTC). So the `claimableJobIds` guard in
`apps/studio/test-support/worker.ts` stops `apps/studio/e2e/disk-guard.spec.ts` and
`apps/studio/e2e/upload.spec.ts` in `beforeAll`, and the same guard fails
`apps/studio/db-tests/jobs.test.ts`. Acceptance criteria (1) disk-guard refusal with
`no job: <reason>` and no `claim_job` call, (2) the live waiting reason on the reel page, and
(3) exactly one `stored_files` source row per upload with matching objects, are unverified end to
end.
**Solution:** No code change. The guard is correct and stays exactly as written. The run does not
re-run the suites again until the owner confirms the two jobs are finished or removed: a fourth
run before that only reproduces this failure. After confirmation, re-run `test:db` and the E2E
command and check both specs pass. If the owner cannot clear the local stack, CI's fresh stack on
the pull request is the end-to-end evidence for the three criteria.

## Files to Modify

None. Explicitly unchanged:

- `apps/studio/e2e/disk-guard.spec.ts`, `apps/studio/e2e/upload.spec.ts` (the `beforeAll`
  leftover-jobs check is not removed, skipped, `test.fixme`d, or narrowed to the run's own user or
  reels).
- `apps/studio/test-support/worker.ts` (`claimableJobIds` unchanged).
- `apps/studio/db-tests/jobs.test.ts` (same guard, same rule).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Stop and escalate to the owner

- Report that the owner step from both earlier patches is still outstanding: jobs
  `625eec18-8c64-48cf-b3a6-85edb069dbf3` and `b85f874b-6263-44db-bf74-fa59ecf655f4`, `queued`,
  attempts 0, on reel `412ce537` and its sibling `review-35mb.mp4` reel of
  `studio-review@example.test`, created 09:07 UTC by an earlier run, not by this branch's code.
- The owner finishes them with their own dev worker or removes them, outside the run. The run does
  not delete, update or claim them, never starts the worker (`worker`, `worker:prod`), and runs no
  database command except `supabase migration up --local` (never `supabase db reset`,
  `supabase start`, `supabase stop` or a seed).
- Do not continue to Step 2 until the owner confirms the stack holds no claimable jobs.

### Step 2: Re-run the DB and E2E suites on this run's ports

- `yarn turbo run test:db --filter=./apps/studio`: `jobs.test.ts`'s suite guard and
  `stored-files.test.ts` pass.
- With the `/prepare_app` server up on `PORT=9214` (studio on `STUDIO_PORT=9114`, from
  `.ports.env`), run `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`. Never set `CI=1`; never set,
  unset or override `PW_WEBKIT_WS`.
- If a guard still lists claimable jobs, stop and report the listed ids to the owner untouched.

### Step 3: Confirm the three acceptance criteria from the output

- `disk-guard.spec.ts` passes: with 9 GB free against a 10 GB minimum, `once` makes no
  `claim_job` call and prints `no job: <reason>`; the reel page shows the waiting reason live
  without a reload and hides it once there is room.
- `upload.spec.ts` passes: one studio upload leaves exactly one `stored_files` source row, and the
  reel's stored objects match its live rows.
- The landing suite (140) and the other 8 studio specs still pass.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `supabase migration up --local`: the branch's migration is applied (nothing new expected; on
  failure report and stop, never reset).
- `yarn turbo run test:db --filter=./apps/studio`
- `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`: the landing suite, then the studio suite with
  `disk-guard.spec.ts` and `upload.spec.ts` passing.
- `git status --porcelain -- apps/studio/e2e apps/studio/test-support apps/studio/db-tests apps/worker/src`:
  prints nothing, proving no guard or worker code changed to get a pass.

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** the owner clears the two queued jobs; then `test:db` and a full
`yarn test:e2e` on this run's ports show `jobs.test.ts`, `disk-guard.spec.ts` and `upload.spec.ts`
passing. CI's fresh Supabase stack repeats both specs on the pull request.
