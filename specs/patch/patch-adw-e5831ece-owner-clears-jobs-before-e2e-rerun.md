# Patch: Owner clears the two leftover queued jobs, then the studio E2E is re-run unchanged

## Metadata

adw_id: `e5831ece`
review_change_request: `Issue #1: The spec's E2E Validation Command PORT=9214 STUDIO_PORT=9114 yarn test:e2e exited 1 on this re-run. The landing suite passed (140), and in the studio suite 8 specs passed. The two specs this change relies on, e2e/disk-guard.spec.ts and e2e/upload.spec.ts, both threw in beforeAll before running any step: "claimable jobs already on the local stack (a crashed run or a connected dev worker): 625eec18-8c64-48cf-b3a6-85edb069dbf3, b85f874b-6263-44db-bf74-fa59ecf655f4". Those jobs are still queued on the studio-review@example.test reels named review-35mb.mp4, created 09:07 UTC (reel 412ce537 still queued in the browser). The patch plan's owner step (clear them) has not happened. Three acceptance criteria are therefore unverified end to end: (1) at low disk, once makes no claim and prints "no job: <reason>"; (2) the reel page shows the waiting reason live and hides it once there is room; (3) a studio upload leaves exactly one stored_files source row, and the reel's objects match its live rows. The unit and DB layers (disk-guard.test.ts, stored-files.test.ts, db-tests/stored-files.test.ts) cover the logic and pass. Resolution: No code patch on this branch can resolve this. The blocker is shared local stack state, and the leftover-jobs guard in both specs is correct and must not be weakened, skipped or narrowed. The owner finishes or removes jobs 625eec18-8c64-48cf-b3a6-85edb069dbf3 and b85f874b-6263-44db-bf74-fa59ecf655f4 outside the run. Then re-run PORT=9214 STUDIO_PORT=9114 yarn test:e2e and confirm disk-guard.spec.ts and upload.spec.ts pass. Do not delete jobs from inside a run, and do not start the worker by hand. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-e5831ece-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** This is the second run blocked by the same stack state. The earlier patch
(`specs/patch/patch-adw-e5831ece-clear-leftover-jobs-rerun-e2e.md`) handed the two leftover queued
jobs to the owner, but they are still queued, so `apps/studio/e2e/disk-guard.spec.ts` and
`apps/studio/e2e/upload.spec.ts` again refused to start in `beforeAll` (the `claimableJobIds`
check in `apps/studio/test-support/worker.ts`). The `once` wiring in `apps/worker/src/once.ts`
(disk-guard refusal with `no job: <reason>`, the live waiting reason on the reel page, the single
`stored_files` source row per upload) has still not run end to end.
**Solution:** No code change, again. The leftover-jobs guard is correct and stays exactly as
written. The run blocks on the owner: it reports the two job ids and the reel (`412ce537`,
`review-35mb.mp4` of `studio-review@example.test`, created 09:07 UTC) and waits. Only after the
owner confirms the jobs are finished or removed does the run re-execute the spec's E2E command and
check that both specs pass. Re-running before that confirmation only reproduces this failure.

## Files to Modify

None. In particular, do not edit:

- `apps/studio/e2e/disk-guard.spec.ts` and `apps/studio/e2e/upload.spec.ts` (the `beforeAll`
  leftover-jobs check stays as is: not removed, skipped, `test.fixme`d or narrowed to the run's own
  user or reels).
- `apps/studio/test-support/worker.ts` (`claimableJobIds` unchanged).
- `apps/studio/db-tests/jobs.test.ts` (same guard, same rule).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Escalate to the owner and wait for confirmation

- Report to the owner that the previous patch's owner step is still outstanding: jobs
  `625eec18-8c64-48cf-b3a6-85edb069dbf3` and `b85f874b-6263-44db-bf74-fa59ecf655f4` are still
  `queued` on `studio-review@example.test`'s `review-35mb.mp4` reels (reel `412ce537` among them),
  created 09:07 UTC by an earlier run, not by this branch.
- The owner finishes them (their own dev worker, outside the run) or removes them. The run does not
  delete, update or claim them, does not start the worker (`worker`, `worker:prod`), and runs no
  database command other than `supabase migration up --local` (never `supabase db reset`,
  `supabase start`, `supabase stop` or a seed).
- Do not proceed to Step 2 until the owner confirms the stack is clear.

### Step 2: Re-run the E2E suites against this run's server

- With the `/prepare_app` server up on `PORT=9214` (studio on `STUDIO_PORT=9114`, both from
  `.ports.env`), run `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`. Never set `CI=1`; never set,
  unset or override `PW_WEBKIT_WS`.
- If `beforeAll` still throws `claimable jobs already on the local stack`, stop and report the ids
  it lists (the same two, or new ones from a connected dev worker) back to the owner, untouched.

### Step 3: Confirm the three unverified acceptance criteria from the output

- `disk-guard.spec.ts` passes: `once` with the free space forced low makes no claim and prints
  `no job: <reason>`, and the reel page shows the waiting reason live, then hides it once `once`
  runs with room.
- `upload.spec.ts` passes: a studio upload leaves exactly one `stored_files` source row, and the
  reel's stored objects match its live rows.
- The landing suite (140) and the other studio specs still pass.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `supabase migration up --local`: the branch's migration is applied (nothing new expected; on
  failure report and stop, never reset).
- `yarn turbo run test:db --filter=./apps/studio`: `jobs.test.ts` shares the leftover-jobs guard
  and `stored-files.test.ts` covers `finish_upload`'s source row; both pass on the cleared stack.
- `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`: the landing suite, then the studio suite with
  `disk-guard.spec.ts` and `upload.spec.ts` both passing.
- `git status --porcelain -- apps/studio/e2e apps/studio/test-support apps/studio/db-tests apps/worker/src`:
  prints nothing, proving no guard or worker code was changed to get a pass.

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** the owner clears the two queued jobs; then `test:db` and a full
`yarn test:e2e` on this run's ports show `disk-guard.spec.ts` and `upload.spec.ts` passing. CI's
fresh Supabase stack repeats both on the pull request.
