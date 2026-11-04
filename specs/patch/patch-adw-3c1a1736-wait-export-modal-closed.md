# Patch: wait for the export modal to close before the next ruler seek

## Metadata

adw_id: `3c1a1736`
review_change_request: `Issue #2: The spec's last validation command, set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools, exits 1. Its two transition cases pass. The behind-the-speaker case fails: e2e-tools/export-matches-preview.spec.ts:438, 'a photo and a big word behind the speaker match between preview and export', at line 487: capturePreview("behind-word") calls seekTo, whose 30 s poll for every video[data-start] playing at 0.5 s to be seeked and decoded never turns true. Find out why the big-word version's preview at 0.5 s never has every playing video seeked. If this branch's ai-script.ts round change or the engine's new rules produced a composition the preview cannot seek, fix that cause. Otherwise show it fails identically on develop and record that evidence. Then re-run the spec's command verbatim against the run's servers and confirm all three cases pass. Never lower PREVIEW_EXPORT_SSIM_BOUND or the seek wait. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-157-adw-3c1a1736-sdlc_planner-transitions-tied-to-phrases.md`

**Issue:** What was found while investigating (scratch replay and diagnostic runs; every temporary change has since been reverted):

1. **The composition is not the cause.** The scripted rounds were replayed through `editFromAnswer` and `build`: version 2 from the committed answer, the guardrail (numbered transition, accent, click), then photo `top` (v5), photo `left` (v6) and big word `w0001` (v7). The v7 composition differs from v5's by exactly one element: the photo's `<img id="photo-1">` becomes `<div id="big-word">`. Every `<video>` is the same in both: `footage`, `cut_1_footage`, `cut_1_under`, `cut_1_person` and `cut_1_mask`, all `data-start="0.000" data-duration="2.690"`, and the footage copies have `data-media-start="0.000"`. The mask span (0 to 2.69 s) and the script are identical too. On `develop` the dim transition stays in the answer, but it only adds a `<div>`, never a video, so this branch's `roundEnvelope` change cannot affect what `seekTo` waits for.
2. **The preview could seek; it was never asked to.** When the poll fails, every video is loaded (`readyState` 4), not seeking, and paused at 2.4667 s: the frame before 2.5 s, the last moment the photo capture seeked to. Calling `player.seek(0.5)` directly in the page settles all five videos at 0.5 s at once.
3. **The click hit the export modal.** In the capture's first `seekTo`, `document.elementFromPoint` at the ruler's 0.5 s point returns `<dialog data-testid="export-modal" open>`, and the `pointerdown`, `pointerup` and `click` all go to that dialog. So the ruler never fires and `player.seek` is never called. The modal is still open from the preceding `exportNow("behind-probe")`. The earlier ruler clicks (guardrail, photo) reached the ruler because no modal was open then.
4. **Why the modal is still open.** `ExportPanel` closes the modal `DOWNLOADED_MS` (4000 ms) after the export downloads by itself. `exportNow` returns as soon as the worker exits and the export row is read, without waiting for that close. In the earlier rounds, something long ran in between: the photo's real mask build, or Playwright's `button.click()` on Export, which waits for the dialog to stop covering the page. The big-word change job, by contrast, is a mask cache hit (same span as the photo), so it finishes within the 4 s. `seekOnRuler` (`test-support/ruler.ts`) then clicks with raw `page.mouse.click` coordinates, which do no actionability check, so the click lands on the dialog. The auto-closing modal (`c9fd6d5`) and the raw-coordinate ruler seek (`43cc2fd`) are both on `develop`. `git diff origin/develop -- apps/studio/src apps/studio/test-support/ruler.ts` is empty on this branch, so the race predates this branch.

**Solution:** Fix it in the spec's helper, never in the bound or the seek wait. At the end of the export, `exportNow` waits until the export modal has closed (`toBeHidden`), so every later raw ruler click reaches the page. This makes the guardrail independent of how fast the next change job runs. `PREVIEW_EXPORT_SSIM_BOUND`, `seekTo`'s 30 s poll and `ruler.ts` stay unchanged.

## Files to Modify

- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: the `exportNow` helper (about lines 293 to 320) only.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Wait for the export modal to close in `exportNow`

- In `exportNow`, directly after `expect(worker.code, worker.output).toBe(0);`, add:
  `await expect(page.getByTestId("export-modal")).toBeHidden({ timeout: 30_000 });`
- Put a short comment above it (no em-dashes): the export downloads by itself and the modal closes a few seconds later; until it closes it covers the page, and the ruler seeks with a raw pointer click (no actionability wait), so the next capture's click would land on the modal.
- Leave the rest of `exportNow` (the export row, the file, the return value) unchanged. Do not touch `seekTo`, `seekOnRuler`, `PREVIEW_EXPORT_SSIM_BOUND`, `MOMENTS` or any timeout.
- Update the helper's leading comment from "Presses Export, runs the real render through the worker, and returns the MP4 on disk and the job's id." to also say it waits for the modal to close after the download.

### Step 2: Re-run the guardrail verbatim against this run's servers

- The `/prepare_app` servers must already be up on `.ports.env`'s `PORT` and `BACKEND_PORT`. Never start, probe, kill or reuse another server, and never set `CI=1`.
- Run exactly: `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`
- All three cases must pass: 'the export matches the live preview at every moment', 'text moved by 60 px falls below the bound' and 'a photo and a big word behind the speaker match between preview and export'. Every `behind-word` SSIM must be at or above 0.9855; if it is not, report the scores as a finding and never change the bound.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn format:check`
2. `yarn turbo run lint --filter=./apps/studio` and `yarn turbo run typecheck --filter=./apps/studio`
3. `yarn knip`
4. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools` (the spec's last validation command, verbatim; all three cases pass)

## Patch Scope

**Lines of code to change:** about 5 (one wait and its comment in one test helper)
**Risk level:** low
**Testing required:** the studio tools guardrail (all three cases) against this run's servers; lint, typecheck, knip and format stay green. No product code, engine, bound or seek-wait change.
