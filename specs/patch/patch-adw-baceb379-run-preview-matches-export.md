# Patch: run the studio's preview-matches-export guardrail against this run's servers

## Metadata

adw_id: `baceb379`
review_change_request: `Issue #2: The spec's validation command PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools (preview matches export, owner's Mac) was not run in this review, so the preview-matches-export criterion is unverified. yarn test:e2e did finish: exit 0, landing 140 passed, studio 34 passed. Resolution: Fixable by patch: on the next review pass, run PORT=9212 STUDIO_PORT=9112 yarn workspace @edit-issebya/studio test:tools against this run's servers and record the result. If it fails, fix the code at its cause. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-94-adw-baceb379-sdlc_planner-remove-cutout-from-pipeline.md`

**Issue:** The spec's last validation command, the studio's `test:tools`
(`apps/studio/e2e-tools/export-matches-preview.spec.ts`, real HyperFrames through the worker's
`once`), was not run in the review, so it is unproven that the preview still matches the export now
that the cut-out is gone from the pipeline and the built page.

**Findings (run while planning, landing 9212, studio 9112, both answering 200):**

- `PORT=9212 STUDIO_PORT=9112 yarn workspace @edit-issebya/studio test:tools` passed: 2 passed
  (45.4 s), exit 0.
- Guardrail (`the export matches the live preview at every moment`, 23.4 s): SSIM 0.995673 at
  0.5 s, 0.995609 at 1.5 s, 0.997499 at 2.5 s, all above the 0.99 bound. Render
  `peak_rss_bytes` 1555800064.
- Probe (`a caption moved by 60 px falls below the bound`, 17.0 s): SSIM 0.995673, 0.982028,
  0.994654. The 1.5 s probe moment (0.982028) is below 0.99, so the comparison is still sensitive.
- These scores are the same as the measured scores recorded in the spec file's bound comment,
  so removing the cut-out changed no pixel the guardrail compares.

**Solution:** No code change. Run the guardrail again on the review pass against this run's
servers and record its result in the review. Change code only if it fails, and then fix the
failure at its cause.

## Files to Modify

None. `apps/studio/e2e-tools/export-matches-preview.spec.ts`, its bound and
`apps/studio/playwright.tools.config.ts` stay as they are.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Confirm this run's servers and a clean queue

- Read the ports from `.ports.env` (`PORT=9212`, `BACKEND_PORT=9112`). Never edit it.
- `curl` `http://localhost:9212/` and `http://localhost:9212/studio` and expect 200 from each (the
  `/prepare_app` server started with the Workspaces dev command). Never start the worker, and never
  touch a server on another port.
- The spec's `beforeAll` refuses to run when `claimableJobIds` finds leftover jobs. If it refuses,
  run `ADW_ID=baceb379 .adw/supabase-stack reset` (the only allowed reset). If that fails, report
  its error and stop.

### Step 2: Run the guardrail in the foreground

- `PORT=9212 STUDIO_PORT=9112 yarn workspace @edit-issebya/studio test:tools`, with a timeout of at
  least 10 minutes. Never stop it part-way: a killed `once` leaves a `running` render job behind.
- Expect 2 passed, with the guardrail's three SSIM scores at or above 0.99 and at least one probe
  score below it.

### Step 3: Record the result, or fix the cause

- On a pass, record the command, exit code and printed `guardrail:` and `probe:` SSIM lines in the
  review as the evidence for the preview-matches-export criterion.
- On a failure, find the cause in this branch's changes (`apps/studio/src/lib/preview-page.ts`,
  `preview-sources.ts`, `apps/worker/src/pipeline/preview-copies.ts`, `first-version.ts`) and fix
  it there. Never lower `PREVIEW_EXPORT_SSIM_BOUND`, skip a moment or weaken the probe.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `PORT=9212 STUDIO_PORT=9112 yarn workspace @edit-issebya/studio test:tools` (2 passed, exit 0)
2. `yarn format:check`

## Patch Scope

**Lines of code to change:** 0
**Risk level:** low
**Testing required:** the studio's `test:tools` guardrail and probe against this run's servers
(already green while planning: 2 passed, exit 0).
