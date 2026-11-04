# Patch: seek the transition test before the next caption fades out

## Metadata

adw_id: `3c1a1736`
review_change_request: `Issue #1: The spec's new E2E test (task 15) fails every time on this branch: apps/studio/e2e/preview.spec.ts:383, 'a transition shows its number, lead-in and key phrase inside its layer, never the phrase's captions', at expect.poll(() => opacity("#cw0010")).toBeGreaterThan(0.5), Received 0.2283. The test seeks to layer.end + 0.1 (2.552 s) but cw0010 ends with the reel's last word (2.605 s) and fades out over caption.outSeconds (0.15 s) from about 2.455 s. Change the final step of the test, not the engine: compute cw0010's span with resolveTimeline(edit, transcript).get("cw0010"), seek to a moment after layer.end and before span.end - ISSEBYA_PRESET.caption.outSeconds (for example layer.end + 0.001), assert that window exists, then assert the layer has left and #cw0010 is visible above 0.5. Never loosen the opacity bound. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-157-adw-3c1a1736-sdlc_planner-transitions-tied-to-phrases.md`
**Issue:** The test's last step seeks to `layer.end + 0.1` (2.552 s). On the 2.7 s fixture clip `cw0010` ends at 2.605 s, and the builder starts its fade-out at `box.end - caption.outSeconds` (`packages/edit/src/build.ts:336`), about 2.455 s. At 2.552 s the caption is mostly faded (opacity 0.2283), so the `> 0.5` check fails every run. The engine is right; the test seeks to the wrong moment.
**Solution:** Change only the test's final block. Seek to a moment inside the window between `layer.end` and `cw0010`'s fade-out start (`span.end - ISSEBYA_PRESET.caption.outSeconds`), with `layer.end + 0.001`. First assert the window exists, then keep both existing assertions with their bounds unchanged: the layer has left (`< 0.05`) and `#cw0010` shows `studio` above 0.5.

## Files to Modify

- `apps/studio/e2e/preview.spec.ts`: the final "After it has left" block of the test `a transition shows its number, lead-in and key phrase inside its layer, never the phrase's captions` (about lines 377 to 383).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Compute the next caption's window

- In the "After it has left, the next caption shows as usual." block, before the `setPosition` call, add:
  - `const nextSpan = resolved.get("cw0010")!;` (reuse the existing `resolved = resolveTimeline(edit, transcript)`; `resolveTimeline` and `ISSEBYA_PRESET` are already imported).
  - `const fadeOut = nextSpan.end - ISSEBYA_PRESET.caption.outSeconds;`
  - `expect(fadeOut).toBeGreaterThan(layer.end);` with a short comment: `cw0010` ends with the reel's last word and fades out over `caption.outSeconds`, so the check has to land between the layer's end and that fade.

### Step 2: Seek inside the window

- Replace `await setPosition(page, layer.end + 0.1);` with `await setPosition(page, layer.end + 0.001);`, and add `expect(layer.end + 0.001).toBeLessThan(fadeOut);` before it so the moment is proven inside the window.
- Keep, unchanged and in order: `await expect.poll(() => opacity("#transition-1")).toBeLessThan(0.05);`, `const next = frame.locator("#cw0010");`, `await expect(next).toHaveText("studio");`, `await expect.poll(() => opacity("#cw0010")).toBeGreaterThan(0.5);`. Do not loosen either bound.
- Comments use no em-dashes.

### Step 3: Re-run the test against this run's server

- Source `.ports.env` and run the single test against the `/prepare_app` server (never start, probe or kill another server, never set `CI=1`):
  `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio playwright test e2e/preview.spec.ts -g "a transition shows"`
- It must pass. If the layer's exit opacity is still above 0.05 at `layer.end + 0.001` (the layer fades out over its own exit ending at `layer.end`), report it as a finding rather than loosening the bound; the review states the layer has already gone at that point.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn format:check`
2. `yarn turbo run lint --filter=./apps/studio` and `yarn turbo run typecheck --filter=./apps/studio`
3. `yarn knip`
4. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio playwright test e2e/preview.spec.ts` (the whole preview spec, including the fixed test, passes)
5. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` (the full E2E suites, landing then studio)

## Patch Scope

**Lines of code to change:** about 8, one test block in one spec file
**Risk level:** low
**Testing required:** the fixed E2E test passes against this run's server, then the full preview spec and E2E suites; lint, typecheck, knip and format stay green.
