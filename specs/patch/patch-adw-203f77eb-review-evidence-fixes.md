# Patch: Remove the patch plan's em-dash, record the disk guard negative proof, recapture the waiting line

## Metadata

adw_id: `203f77eb`
review_change_request: `Triage run_defect: review attempt 2 captured no screenshots for the LiveReel.tsx job-waiting line (attempt 1 captured four), and specs/patch/patch-adw-203f77eb-storage-docs.md holds a literal em-dash (U+2014). Fix the glyph, rerun the disk guard negative proof (Issue Verification 5, spec step 7) and have the re-review capture the waiting line at 1920x1080 and 375x667.`

## Issue Summary

**Original Spec:** `specs/issue-37-adw-203f77eb-sdlc_planner-storage-records-slimming-disk-guard.md`
**Issue:** Line 165 of `specs/patch/patch-adw-203f77eb-storage-docs.md` writes the U+2014 glyph
itself inside its validation command (`grep -rn $'<glyph>' app_docs docs`), which breaks the
repository's no-em-dash rule. Review attempt 2 also left no visual evidence for the studio change
(the job-waiting line in `apps/studio/src/app/reels/[id]/LiveReel.tsx`), and the PR needs the disk
guard negative proof recorded. Code, lint, typecheck, unit, `test:db` and E2E already pass.
**Solution:** Replace the glyph with its escape text (backslash, `u2014`) so the command still
finds em-dashes without containing one; rerun the negative proof by temporarily bypassing the
guard in `apps/worker/src/disk-guard.ts`, keep the failing output, restore the file byte for byte;
no code change for the visual blocker, the re-review recaptures the waiting line exactly as
attempt 1 did.

## Files to Modify

Use these files to implement the patch:

- `specs/patch/patch-adw-203f77eb-storage-docs.md` (line 165 only: the glyph becomes its escape).
- `apps/worker/src/disk-guard.ts` (temporary edit for the negative proof only; restored, so the
  final diff for this file is empty).

Other runs' older spec files are out of scope and are not touched.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace the literal em-dash in the storage-docs patch plan

- In `specs/patch/patch-adw-203f77eb-storage-docs.md` line 165, change the bullet so it reads
  ``- `grep -rn $'\u2014' app_docs docs` - prints nothing (no em-dashes).``, with the six characters
  backslash, `u`, `2`, `0`, `1`, `4` typed out, never the glyph. Use the Edit tool (or
  `perl -CSD -pi -e 's/\x{2014}/\\u2014/g'` on that one file), nothing else on the line changes.
- Run `grep -rn $'\u2014' specs/patch/patch-adw-203f77eb-storage-docs.md specs/patch/patch-adw-203f77eb-review-evidence-fixes.md specs/issue-37-adw-203f77eb-sdlc_planner-storage-records-slimming-disk-guard.md app_docs docs .adw/project.md`.
  It must print nothing. If it prints a line in any of these files, replace that glyph with a
  comma, colon or parentheses (or its escape text inside a command) and rerun until it is empty.

### Step 2: Disk guard negative proof (Issue Verification 5, spec step 7)

- In `apps/worker/src/disk-guard.ts`, temporarily make `guardedClaim` call `claim()` whatever the
  free space: insert `return claim();` as the first statement of the function body, above
  `const free = await freeBytes(dir);`. Change nothing else.
- Run `yarn turbo run test --filter=./apps/worker` and confirm that
  `src/disk-guard.test.ts > guardedClaim > never claims below the minimum and writes why` fails.
  Save the failing summary (the failed test name, its assertion message and the
  `Tests  N failed | M passed` line for `src/disk-guard.test.ts`; attempt 1 measured 1 failed,
  6 passed) to `agents/203f77eb/patch_agent/disk-guard-negative-proof.txt` (gitignored, never
  staged) so the PR description can quote it.
- Restore the file by removing the inserted line (or `git restore apps/worker/src/disk-guard.ts`,
  since the file is committed and unchanged in this run's working tree). Confirm
  `git diff -- apps/worker/src/disk-guard.ts` prints nothing.
- Rerun `yarn turbo run test --filter=./apps/worker` and confirm every test passes, including the
  one above. Never commit the bypass; never pass `--no-verify`.

### Step 3: Re-review captures the job-waiting line (no code change)

- Nothing to implement. On the re-review the reviewer opens the reel page on this run's port
  (`PORT` from `.ports.env`, never 3000 unless that is the value), signed in through the URL
  printed by `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`.
- It inserts a temporary queued job for the review user's reel and a `worker_status` row with a
  `waiting_reason` (through the ADW stack's `SUPABASE_DB_URL` or the secret key from the hook,
  never the developer's stack and never a `supabase` command), captures the reel page showing the
  waiting line under the queued job at 1920x1080 and 375x667 into
  `agents/203f77eb/reviewer/review_img/`, then deletes both rows.
- It lists every screenshot path in its result. Attempt 1's four PNGs
  (`01_desktop_queued_job_waiting_reason_live.png`, `01_mobile_queued_job_waiting_reason_live.png`,
  `02_desktop_queued_job_reason_cleared.png`, `02_mobile_queued_job_reason_cleared.png`) are still
  in that folder and show the expected state.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -rn $'\u2014' specs/patch/patch-adw-203f77eb-storage-docs.md specs/patch/patch-adw-203f77eb-review-evidence-fixes.md specs/issue-37-adw-203f77eb-sdlc_planner-storage-records-slimming-disk-guard.md app_docs docs .adw/project.md` - prints nothing.
- `git diff -- apps/worker/src/disk-guard.ts` - prints nothing (the bypass is gone).
- `yarn format:check` - Prettier over the repository passes (run `yarn format` and re-check if
  it fails).
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio` - passes.
- `yarn turbo run test --filter=./apps/worker` - every test passes, including
  `guardedClaim > never claims below the minimum and writes why`.
- `yarn knip` - passes.

## Patch Scope

**Lines of code to change:** 1 line of Markdown kept (the escaped em-dash); 1 temporary line in
`disk-guard.ts`, reverted.
**Risk level:** low
**Testing required:** the em-dash grep, the worker unit tests failing with the bypass and passing
without it, format check, lint for worker and studio, knip; the re-review's four captures of the
job-waiting line.
