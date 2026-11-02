# Patch: make the upload progress and notify toggle specs deterministic

## Metadata

adw_id: `adw_patch_iso`
review_change_request: `119c12a9`

## Issue Summary

**Original Spec:** (none given; branch of issue 38, PR #82)
**Issue:** Two studio E2E specs failed on this branch.

1. `apps/studio/e2e/multipart-upload.spec.ts:144` ("Parts: a 35 MiB clip goes up in four 10 MiB
   parts with a progress bar") got `__maxProgress` 86, not 100, on Linux CI at a702dffd (run
   41376716547). `watchProgress` samples the bar every 10 ms, so a value can be missed. It is
   also a real app gap: `@uppy/core` 6.3.0 emits `progress` through
   `#updateTotalProgressThrottled` (lodash `throttle`, 500 ms, leading and trailing, see
   `node_modules/@uppy/core/lib/Uppy.js:921`). The `upload-success` handler (line 1064) only
   schedules a throttled update. If the last part's progress event fired less than 500 ms
   earlier, the trailing call that would emit 100 is still pending when `uppy.upload()`
   resolves. `createUploader().start()` then removes the `progress` handler in its `finally`,
   and `UploadForm` calls `router.push`. So the app can navigate without ever rendering 100.
2. `apps/studio/e2e/notification.spec.ts:156` ("a reel processed while the tab is hidden changes
   the title and notifies") did not find `getByTestId('notify-toggle')` within 5000 ms at
   b5cfbf15. At that commit the spy's `permission` getter returned the real
   `Notification.permission`, which headless Chromium reports as `"denied"` even with the
   permission granted. So `NotifyToggle`'s `mode()` returned `"blocked"` and rendered
   `notify-blocked` instead of the button. That failure was deterministic, not timing.
   9bf0b1cd gave the spy its own permission (`"default"`, then `"granted"` after the click),
   which is why f92c86ec and 9bf0b1cd passed. `NotifyToggle` also renders nothing before
   hydration (server snapshot `"unknown"`), but the spec already waits for
   `[data-realtime="ready"]` in the same client tree (`LiveReel`), so hydration is not the cause.
   What is still missing is a check of the condition the toggle depends on, so that a regression
   fails with its real reason instead of a locator timeout.

**Solution:**

1. App fix: when the upload finishes, `createUploader().start()` reports `onProgress(100)`
   before it removes the handler and resolves `finished`. `UploadForm` then renders the bar at
   100 (an urgent update) before `router.push` (a transition) commits the reel page. The spec
   stops sampling. A `MutationObserver`, installed by an init script before the upload, records
   every `value` the bar gets, synchronously, when it is inserted or changed. The spec asserts
   that the recorded values never go down and that the last one is 100 (the app's guarantee:
   it reports 100 before it navigates).
2. Spec fix: before looking for the toggle, wait on the state that makes it appear: the page's
   `Notification.permission` is `"default"` (the spy is in place) and `notify-blocked` has count 0. The toggle is then expected with no extra timeout. A comment records the b5cfbf15 cause.
   No timeout is raised.

## Files to Modify

- `apps/studio/src/lib/uploader.ts`: report `onProgress(100)` on a finished upload.
- `apps/studio/e2e/multipart-upload.spec.ts`: replace the sampled `watchProgress` with a
  `MutationObserver` recorder and new assertions.
- `apps/studio/e2e/notification.spec.ts`: wait on the toggle's precondition.
- `app_docs/upload.md`: one sentence (and one Rules line) saying that a finished upload shows
  100 before the page goes to the reel.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Report 100 before a finished upload resolves (`apps/studio/src/lib/uploader.ts`)

- In `start()`, after `uppy.upload()` resolves with a `reelId` (the `finished` branch), call
  `handlers.onProgress(100)` before `return { status: "finished", reelId }`. This runs before
  the `finally` block removes the handler. Do not call it on `cancelled` or `failed`.
- Add a comment: Uppy throttles total progress at 500 ms (trailing), so its own 100 can arrive
  after `upload()` resolves, when the handler is already gone and the page has navigated.
- `UploadForm.tsx` needs no change. `setPercent(100)` happens in `onProgress` before `start()`
  resolves, and `router.push` is a transition, so the bar commits 100 first.

### Step 2: Record every progress value (`apps/studio/e2e/multipart-upload.spec.ts`)

- Replace `watchProgress` with an init script. It sets `window.__progressValues = []` and starts
  a `MutationObserver` on `document` once `document.documentElement` exists (on
  `DOMContentLoaded` if needed): `{ subtree: true, childList: true, attributes: true,
attributeFilter: ["value"] }`. For every added `[data-testid="upload-progress"]` node, and for
  every `value` attribute mutation on one, it pushes `Number(el.getAttribute("value"))`.
  React sets `value` on `<progress>` as an attribute. Check this once while implementing (log the
  recorded array). If React sets it as a property instead, also record the `#upload-status` text
  (`Uploading... N%`) with `characterData` and `childList`, and assert on those numbers.
- Values are recorded synchronously in the mutation callback, so no value is lost to sampling.
  The array is per document. The client-side navigation to the reel page keeps the same
  document, so the array survives it.
- Assertions, replacing `expect(__maxProgress).toBe(100)`: read `__progressValues` after
  `toHaveURL(REEL_URL)`. Expect it to be non-empty, to never go down
  (`values.every((v, i) => i === 0 || v >= values[i - 1])`) and to end in 100 (`values.at(-1)`
  is 100).
- Keep the test's name and its other assertions (part counts, `finished`, the event).

### Step 3: Wait on the toggle's precondition (`apps/studio/e2e/notification.spec.ts`)

- After `[data-realtime="ready"]` is visible and before `getByTestId("notify-toggle")`, add:
  - `expect(await page.evaluate(() => Notification.permission)).toBe("default")` (the spy is in
    place, so `NotifyToggle` will not take the `blocked` branch);
  - `await expect(page.getByTestId("notify-blocked")).toHaveCount(0)`.
- Then `await expect(toggle).toBeVisible()` and the existing text checks, with the default
  timeout (no raise).
- Add a short comment saying the toggle is replaced by `notify-blocked` when the page's
  permission is `"denied"` (the b5cfbf15 failure, the spy delegating to headless Chromium's
  real permission).

### Step 4: Document the progress guarantee (`app_docs/upload.md`)

- Next to the line about `UploadForm.tsx` drawing its own progress bar (line 20), add that a
  finished upload reports 100 before the page goes to the reel, because Uppy's total progress is
  throttled. Add a matching Rules bullet: never navigate after a finished upload before the bar
  shows 100. No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions. All from the
worktree root, with the run's servers from `/prepare_app` already up (`set -a; . ./.ports.env;
set +a` first in each shell).

1. Static checks and unit tests: `yarn turbo run lint --filter=./apps/studio`,
   `yarn turbo run typecheck --filter=./apps/studio`, `yarn knip`, `yarn format:check`,
   `yarn turbo run test --filter=./apps/studio`, `yarn turbo run build --filter=./apps/studio`.
2. Repeat each spec 20 times:
   `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:e2e e2e/multipart-upload.spec.ts --repeat-each=20 -g "Parts:"`
   and
   `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:e2e e2e/notification.spec.ts --repeat-each=20`.
   Both must be all green.
3. Under CPU contention (as in #61's negative check): start two busy loops,
   `node -e 'for(;;){}' & node -e 'for(;;){}' &`, record their PIDs, run both commands from step 2
   again, then kill only those two PIDs. Both must be all green.
4. Negative checks, under the same contention, each from a temporary edit that is reverted
   afterwards (never committed):
   - Remove the `handlers.onProgress(100)` call from Step 1 and keep the new observer: the "Parts:"
     spec must fail at least once in `--repeat-each=20` (last value below 100). This proves the
     app could navigate without rendering 100.
   - Put back the old `watchProgress` sampler and `__maxProgress` assertion, with or without the
     app fix: report how many of 20 fail (the sampler can miss values).
   - In `notification.spec.ts`, make the spy's `permission` getter return the real
     `Notification.permission` again (the b5cfbf15 code): the new precondition must fail with
     `"denied"` (expected every time, since the failure is deterministic). Report the count.
     Restore the files (`git diff` empty for them) and re-run step 2 once.
5. Full E2E: `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`, all green. Then push and
   confirm CI (`.github/workflows/ci.yml`, job `check`) is green on PR #82. Never re-run a failed
   CI job to get it to pass.

## Patch Scope

**Lines of code to change:** about 50 (uploader 3, multipart spec about 30, notification spec
about 8, docs about 4)
**Risk level:** low
**Testing required:** the two specs, 20 repeats each, with and without CPU contention; the three
negative checks; then lint, typecheck, knip, format, unit, build, full E2E and CI.
