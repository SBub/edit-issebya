# Patch: Document the hydration wait in the no-scroll section of the landing page doc

## Metadata

adw_id: `9ffa7abc`
review_change_request: `Issue #1: Spec step 7 (Update the doc) is not done. app_docs/landing-page.md is not in the diff, and its 'No-scroll rule and its specs' section still names only rootBox and expectInsideRoot and says nothing about hydration. waitForPageReady now means something different (it also waits for React hydration of <main>), and the spec's Relevant Files and step 8 both expect this doc to change. Resolution: In app_docs/landing-page.md, section 'No-scroll rule and its specs', add this sentence right after the one ending '(rootBox, expectInsideRoot).': 'waitForPageReady waits for fonts, the first reel card and React hydration of <main> (its __reactFiber$ key), so a spec that changes the DOM after it is never undone by a hydration mismatch.' Use no em-dashes, then run yarn format:check. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-26-adw-9ffa7abc-sdlc_planner-no-scroll-hydration-race.md`
**Issue:** Spec step 7 was skipped. `app_docs/landing-page.md`, section "No-scroll rule and its specs", still names only `rootBox` and `expectInsideRoot` and does not say that `waitForPageReady` (in `apps/web/e2e/viewport.ts`) now also waits for React hydration of `<main>`.
**Solution:** Insert the one sentence from spec step 7 right after the sentence ending ``(`rootBox`, `expectInsideRoot`).``, then check formatting. Docs only, no code change.

## Files to Modify

Use these files to implement the patch:

- `app_docs/landing-page.md` (section "No-scroll rule and its specs", currently lines 72 to 76)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the hydration sentence to the doc

- In `app_docs/landing-page.md`, the paragraph currently reads (lines 72 to 76):
  ```
  `apps/web/e2e/no_scroll.spec.ts` and `apps/web/e2e/landing_content.spec.ts` check this, with the helpers in
  `apps/web/e2e/viewport.ts` (`rootBox`, `expectInsideRoot`). The helpers measure from
  `document.documentElement`, never from `window.innerWidth`. At 320x568 the dialogs scroll inside
  themselves (the form body is `overflow-y-auto`, the dialog is capped at `100dvh - 2rem`), never the
  page.
  ```
- Immediately after ``(`rootBox`, `expectInsideRoot`).`` and before `The helpers measure from`, insert exactly:
  `` `waitForPageReady` waits for fonts, the first reel card and React hydration of `<main>` (its `__reactFiber$` key), so a spec that changes the DOM after it is never undone by a hydration mismatch. ``
- Keep it in the same paragraph; reflow the paragraph's line breaks to the file's existing width (about 105 characters) so it matches the surrounding text. Change nothing else in the file.
- No em-dashes.

### Step 2: Format check

- Run `yarn format:check`. If it reports `app_docs/landing-page.md`, run `yarn format` and re-run `yarn format:check` until it passes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `grep -n "__reactFiber\$" app_docs/landing-page.md` - the sentence is present, in the "No-scroll rule and its specs" section.
- `grep -nP "\x{2014}" app_docs/landing-page.md` - returns nothing (no em-dashes).
- `yarn format:check` - Prettier passes over the whole repository.
- `yarn knip` - unaffected, still passes.
- `git diff --stat origin/develop` - only files under `apps/web/e2e/`, `app_docs/landing-page.md` and `specs/`.

## Patch Scope

**Lines of code to change:** 1 sentence (about 2 to 4 lines after reflow) in one doc
**Risk level:** low
**Testing required:** Docs only: `yarn format:check`; no unit or E2E run needed for this patch beyond the original spec's validation.
