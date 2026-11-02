# Patch: Keep the + upload button disabled until the dialog can open

## Metadata

adw_id: `f1d8b655`
review_change_request: `Issue #1: The upload now sits behind the + button, and that makes the E2E specs flaky. signIn in multipart-upload.spec.ts clicks 'Upload a reel' right after page.goto; before the client component hydrates the button has no onClick, so showModal() never runs and expect(getByLabel('Clip')).toBeVisible() fails (multipart-upload.spec.ts:111). upload.spec.ts:73, footage-refusal.spec.ts:42 and reels.spec.ts:153 use the same click-then-expect pattern. Resolution: make opening the dialog safe before hydration, preferably (a) render the + button disabled until mounted and have the specs wait for it to be enabled before clicking. Then run the studio E2E suite and confirm it passes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-95-adw-f1d8b655-sdlc_planner-studio-one-screen-reel-layout.md`
**Issue:** `apps/studio/src/components/UploadDialog.tsx` server-renders the round **+** button enabled, but its `onClick` (which calls `dialogRef.current?.showModal()`) only exists after React hydrates. A click that lands between the server HTML and hydration (Playwright right after `page.goto`, or a real user's early tap) does nothing, so the dialog stays closed and every spec that opens it (`multipart-upload.spec.ts` `signIn` and line 269, `upload.spec.ts:73`, `footage-refusal.spec.ts:42`, `reels.spec.ts:153` and `:158`) is flaky.
**Solution:** Option (a). Render the button `disabled` (with `data-ready="false"`) on the server and during hydration, and enabled (`data-ready="true"`) once the client has hydrated, using `useSyncExternalStore` with a server snapshot of `false` and a client snapshot of `true` (no effect, no `setState`). Playwright's `click()` already waits for the element to be enabled (its actionability checks), so every existing click waits for hydration without being wrapped in a retry; the one spec that checks the grid (`reels.spec.ts`) also asserts the button turns enabled before clicking, so a regression of the guard is caught explicitly. A real user's early tap now hits a visibly disabled button instead of silently doing nothing.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/src/components/UploadDialog.tsx`: the hydration flag, `disabled` and `data-ready` on the **+** button, a disabled style.
- `apps/studio/e2e/reels.spec.ts`: assert the **+** button is enabled (`data-ready="true"`) before the first click.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Disable the + button until hydrated

- In `apps/studio/src/components/UploadDialog.tsx`, import `useSyncExternalStore` from `react` beside `useRef`.
- Add module-level helpers (no effect, per the repo's no-unnecessary-effects pattern):
  `const noSubscribe = () => () => {};` and inside the component
  `const ready = useSyncExternalStore(noSubscribe, () => true, () => false);`.
  The server snapshot (`false`) is used for the server render and the hydration pass, then React re-renders with the client snapshot (`true`), so the button turns enabled exactly when its `onClick` is attached.
- On the **+** `<button>` add `disabled={!ready}` and `data-ready={ready ? "true" : "false"}`, and append `disabled:opacity-60` to its `className` so the pre-hydration state is visible. Keep `aria-label="Upload a reel"`, the `onClick` and every other class unchanged.
- Extend the component's top comment by one sentence: the button stays disabled until the client has hydrated, because before that it has no click handler and a tap would do nothing.
- No em-dashes in the comment.

### Step 2: Make the grid spec assert the ready state

- In `apps/studio/e2e/reels.spec.ts`, just before the first `await page.getByRole("button", { name: "Upload a reel" }).click();` (line 153), add
  `await expect(page.getByRole("button", { name: "Upload a reel" })).toBeEnabled();` and
  `await expect(page.getByRole("button", { name: "Upload a reel" })).toHaveAttribute("data-ready", "true");`.
- Leave the other click sites (`multipart-upload.spec.ts:110` and `:269`, `upload.spec.ts:73`, `footage-refusal.spec.ts:42`, `reels.spec.ts:158`) as they are: `locator.click()` waits for the button to be enabled, which now means hydrated, so no `toPass()` wrapper is needed.

### Step 3: Validate

- Run the commands in Validation, in order. The studio E2E suite must pass on the first run with no reruns; if any spec that opens the dialog fails, fix the cause, never rerun to green.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn turbo run lint --filter=./apps/studio && yarn turbo run typecheck --filter=./apps/studio && yarn knip && yarn format:check`
2. `yarn turbo run test --filter=./apps/studio`
3. `yarn turbo run build --filter=./apps/studio`
4. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:e2e reels.spec.ts upload.spec.ts multipart-upload.spec.ts footage-refusal.spec.ts --repeat-each=3` (against the `/prepare_app` servers; every dialog-opening spec passes on every repeat)
5. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e --filter=./apps/studio` (the full studio suite, after the landing suite turbo runs first; all green on the first run)

## Patch Scope

**Lines of code to change:** about 10 (6 in `UploadDialog.tsx`, 2 to 4 in `reels.spec.ts`)
**Risk level:** low
**Testing required:** studio lint, typecheck, knip, format, unit and build; the dialog-opening specs repeated three times and the full studio E2E suite passing on the first run.
