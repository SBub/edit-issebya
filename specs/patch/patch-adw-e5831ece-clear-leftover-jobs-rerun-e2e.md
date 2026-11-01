# Patch: Re-run the studio E2E once the owner clears the leftover queued jobs

## Metadata

adw_id: `e5831ece`
review_change_request: `Issue #1: The spec's Validation Command PORT=9214 STUDIO_PORT=9114 yarn test:e2e exited 1. The landing suite passed (140 passed) and 8 studio specs passed. Both new or extended specs this change relies on failed in beforeAll before running a single step: e2e/disk-guard.spec.ts and e2e/upload.spec.ts both threw "claimable jobs already on the local stack (a crashed run or a connected dev worker): 625eec18-8c64-48cf-b3a6-85edb069dbf3, b85f874b-6263-44db-bf74-fa59ecf655f4". Those two jobs are queued on review-35mb.mp4 reels of studio-review@example.test, created at 09:07 UTC, before this branch's plan commit (09:43). They come from another run. Unverified by execution: (1) once makes no claim at 9 GB and prints "no job: <reason>" end to end; (2) the waiting reason reaches the page through the real once path; (3) a studio upload leaves exactly one stored_files row, with the reel's objects matching its live rows. Resolution: no code patch on this branch; do not weaken or remove the leftover-jobs check in either spec, and do not delete jobs from inside a run. The owner finishes or removes the two leftover queued jobs, then re-run PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e and confirm disk-guard.spec.ts and upload.spec.ts pass. CI's fresh Supabase stack also exercises them on the pull request. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-e5831ece-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** The E2E validation command failed because `apps/studio/e2e/disk-guard.spec.ts` and
`apps/studio/e2e/upload.spec.ts` refuse to start while the shared local Supabase stack holds
claimable jobs (`claimableJobIds` in `apps/studio/test-support/worker.ts`: any `queued` job, or a
`running` one whose lease expired). Two queued jobs from an earlier run
(`625eec18-8c64-48cf-b3a6-85edb069dbf3`, `b85f874b-6263-44db-bf74-fa59ecf655f4`, on
`studio-review@example.test`'s `review-35mb.mp4` reels) tripped that guard, so the `once` wiring in
`apps/worker/src/once.ts` (disk-guard refusal, `no job: <reason>`, the live waiting reason, the
single `stored_files` row per upload) was never executed.
**Solution:** No code change. The guard is correct and protects the specs from claiming a job they
did not create, so it stays as is. The shared stack's state is the owner's to fix: the owner
finishes or removes the two leftover jobs outside the run. The run then re-executes the spec's E2E
validation command and confirms both specs pass. CI's fresh stack runs them again on the pull
request.

## Files to Modify

None. In particular, do not edit:

- `apps/studio/e2e/disk-guard.spec.ts` and `apps/studio/e2e/upload.spec.ts` (the `beforeAll`
  leftover-jobs check stays exactly as written).
- `apps/studio/test-support/worker.ts` (`claimableJobIds` is not narrowed to the run's own user or
  reels).
- `apps/studio/db-tests/jobs.test.ts` (same guard, same rule).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Hand the leftover jobs to the owner, change nothing

- Report the two job ids (`625eec18-8c64-48cf-b3a6-85edb069dbf3`,
  `b85f874b-6263-44db-bf74-fa59ecf655f4`), their reels (`review-35mb.mp4` of
  `studio-review@example.test`) and their creation time (09:07 UTC, before this branch's plan
  commit) to the owner, who finishes them (for example with their own dev worker) or removes them.
- The run itself does not delete, update or claim those jobs, does not start the worker (`worker`,
  `worker:prod`), and runs no database command other than `supabase migration up --local` (never
  `supabase db reset`, `supabase start`, `supabase stop` or a seed).
- Do not edit any spec, helper or test, and do not skip or `test.fixme` either spec.

### Step 2: Re-run the E2E suites against this run's server

- With the `/prepare_app` server up on `PORT=9214` (studio on `STUDIO_PORT=9114`, from
  `.ports.env`), run `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`. Never set `CI=1`, never touch
  `PW_WEBKIT_WS`.
- If `beforeAll` still throws `claimable jobs already on the local stack`, the owner has not cleared
  the stack yet: stop and report the listed ids again, without touching them.

### Step 3: Confirm the three unverified behaviours from the output

- `disk-guard.spec.ts` passes: `once` with the free space forced low (minimum pinned at 10 GB)
  makes no claim, prints `no job: <reason>`, and the reel page shows the waiting reason live, then
  hides it after the second `once` with room.
- `upload.spec.ts` passes: an upload through the studio leaves exactly one `stored_files` row for
  the source, and the reel's stored objects match its live rows.
- The landing suite and the remaining studio specs still pass (no regression).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `supabase migration up --local`: confirms the branch's migration is applied (no new migrations
  expected; on failure report and stop, never reset).
- `yarn turbo run test:db --filter=./apps/studio`: `jobs.test.ts` shares the leftover-jobs guard and
  `stored-files.test.ts` covers `finish_upload`'s source row; both must pass on the cleared stack.
- `PORT=9214 STUDIO_PORT=9114 yarn test:e2e`: the landing suite then the studio suite, with
  `disk-guard.spec.ts` and `upload.spec.ts` both passing.
- `git status --porcelain -- apps/studio/e2e apps/studio/test-support apps/studio/db-tests`: prints
  nothing, proving no guard was weakened.

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** a full `yarn test:e2e` on a stack with no claimable jobs, showing
`disk-guard.spec.ts` and `upload.spec.ts` pass, plus `test:db`; CI's fresh Supabase stack
repeats both on the pull request.
