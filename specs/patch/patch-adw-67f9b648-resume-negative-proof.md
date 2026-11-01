# Patch: Run and record the negative proof for the reload resume (task 17)

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #2: Step 17 (verification 4) was not performed. It requires temporarily skipping setFileState(..., { s3Multipart }) on resume, running --grep "a reload resumes", confirming it fails because parts 1 and 2 are sent again, restoring the code and recording the failing output. The implementor's final report says: 'neither has task 17's check that the reload test fails without the resume'. No other run artifact contains that output. The reload spec passes now, and my live resume in the browser re-sent only parts 2 and 3, never part 1. But a gate that has only ever passed is not shown to catch a resume that starts over. Resolution: Source .ports.env and start the /prepare_app server. Temporarily remove the uppy.setFileState(fileId, { s3Multipart: ... }) call in apps/studio/src/lib/multipart-upload.ts. Run PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes" and confirm it fails on the part counts. Restore the code and rerun it green. Record the failing assertion output in the run's report. Never commit the probe. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md` (task 17, verification 4)
**Issue:** The reload spec `a reload resumes` in `apps/studio/e2e/multipart-upload.spec.ts` (lines 221 to 253) has only ever been seen passing. Nobody has shown it fails when the resume is broken, so it is not proven to catch a resume that starts over from part 1.
**Solution:** A probe, not a code change. Temporarily remove the resume call at `apps/studio/src/lib/multipart-upload.ts:81-84` (`if (uploadId) { uppy.setFileState(fileId, { s3Multipart: { uploadId, key: target.key } }); }`), run only the reload spec and capture the failure (expected: `expect(counts.parts[1]).toBe(1)` or `expect(counts.parts[2]).toBe(1)` gets 2). Then restore the file byte for byte, rerun the spec green and paste the failing assertion output into the run's final report. Nothing from the probe is committed.

## Files to Modify

- `apps/studio/src/lib/multipart-upload.ts`: temporary edit only, restored before the step ends. Its committed content must be unchanged (`git diff --quiet -- apps/studio/src/lib/multipart-upload.ts` exits 0 at the end).
- No other file. The evidence goes in the run's final report (the implement phase's `Report` output), not in the repository.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Load ports and make sure the run's server is up

- `set -a; . ./.ports.env; set +a` (never edit `.ports.env`). This run: `PORT=9211`, `BACKEND_PORT=9111`.
- If `http://localhost:$PORT/studio` does not answer, start the server with `/prepare_app` (the profile's Workspaces dev command with the mock flags, including `E2E_MOCK_STORAGE=true`). Never reuse, probe or kill a server on 3000. The shared local Supabase stack is the owner's; do not start or reset it.
- Confirm `git diff --quiet -- apps/studio/src/lib/multipart-upload.ts` exits 0 before probing, so the restore can be checked against `HEAD`.

### Step 2: Apply the probe

- In `apps/studio/src/lib/multipart-upload.ts`, delete the block at lines 81 to 84 (the `if (uploadId) { ... uppy.setFileState(fileId, { s3Multipart: { uploadId, key: target.key } }); }` with its comment). Leave everything else as is. `next dev` hot reloads the studio; no restart is needed.
- Do not stage, commit or run `git commit` while the probe is in place (lefthook would also reject it through `typecheck` if `uploadId` became unused, which is one more reason never to commit here).

### Step 3: Run the reload spec and capture the failure

- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes" --pass-with-no-tests 2>&1 | tee /tmp/adw-67f9b648-resume-probe.log`
  - `--pass-with-no-tests` is needed because turbo runs the landing suite first (`@edit-issebya/studio#test:e2e` depends on `@edit-issebya/web#test:e2e`) and passes the same arguments to it; without the flag the landing suite exits 1 on "No tests found" and the studio spec never runs. It does not weaken the studio run: that run matches one test.
- Expected: the studio suite fails `a reload resumes` on a part count, `expect(counts.parts[1]).toBe(1)` (or `parts[2]`) receiving `2`, because without the `s3Multipart` state Uppy starts a fresh multipart upload and sends parts 1 and 2 again.
- If it fails on something other than the part counts (for example the reel URL never appears because the server refuses a second create for the same reel), record that output too and say so plainly in the report: the gate still catches a resume that starts over, but the review asked for the part-count failure, so state which assertion fired and why. If it passes, STOP: restore the code (Step 4) and report that the spec does not catch a non-resuming upload; that is a test defect to fix, not to paper over.
- Keep the Playwright error block (test title, the failing `expect` line, `Expected`/`Received`, and the spec line number) from the log for the report.

### Step 4: Restore the code and rerun green

- `git checkout -- apps/studio/src/lib/multipart-upload.ts`, then `git diff --quiet -- apps/studio/src/lib/multipart-upload.ts` must exit 0 and `grep -n "setFileState" apps/studio/src/lib/multipart-upload.ts` must show the call again.
- Rerun `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes" --pass-with-no-tests`; it must pass.

### Step 5: Record the evidence in the run's report

- In the final report, under a heading `Task 17: negative proof for the resume`, include: the probe (which lines were removed), the exact command, the failing assertion output copied from `/tmp/adw-67f9b648-resume-probe.log`, the restore check (`git diff --quiet` exit 0) and the green rerun's summary line (`1 passed`).
- No file in the repository changes in this patch; `git status --porcelain` shows the same entries as before Step 2.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `set -a; . ./.ports.env; set +a`
2. `git diff --quiet -- apps/studio/src/lib/multipart-upload.ts && grep -c "uppy.setFileState(fileId, { s3Multipart" apps/studio/src/lib/multipart-upload.ts` (exit 0 and count 1: the probe is gone)
3. `yarn turbo run typecheck --filter=./apps/studio` and `yarn turbo run lint --filter=./apps/studio`
4. `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes" --pass-with-no-tests` (green)
5. `grep -n "counts.parts\[" /tmp/adw-67f9b648-resume-probe.log` shows the failing part-count assertion captured during the probe

## Patch Scope

**Lines of code to change:** 0 committed (4 lines removed temporarily, then restored)
**Risk level:** low
**Testing required:** one probe run of `a reload resumes` that fails on the part counts, then the same spec green after restore; typecheck and lint of the studio to confirm the tree is back to `HEAD`.
