# Patch: Restore the issue's four process steps

## Metadata

adw_id: `d5416729`
review_change_request: `Issue #1: The process list shows the wrong four steps. The issue says to keep the facts (audience, steps, offer, price) exactly. Its four steps are: 1. Discovery call to understand your project. 2. A proposed visual identity for your reels. 3. You record your talking heads. 4. I edit them, consistent with the visual identity. src/content/landing.ts steps holds four different, invented steps: 'You record and send the raw takes.', 'I cut, caption and colour each reel.', 'You review; I refine once.', 'You post eight finished reels.'. These describe a different service flow, with no discovery call and no visual identity, and the accessibility snapshot of / shows them rendered at both viewports. e2e/landing_content.spec.ts reads the same constant, so the suite stays green with the wrong facts. Resolution: Replace LANDING.steps in src/content/landing.ts with the issue's four steps: 'Discovery call to understand your project.', 'A proposed visual identity for your reels.', 'You record your talking heads.', 'I edit them, consistent with the visual identity.'. Wording may be tightened only if the facts stay the same. Then re-run PORT=<run port> yarn test:e2e (no_scroll and landing_content) to confirm the four items still fit at 320x568. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-1-adw-d5416729-sdlc_planner-one-page-landing-checkout.md`
**Issue:** `LANDING.steps` in `src/content/landing.ts` (lines 7-12) holds four invented steps describing a different service flow (no discovery call, no visual identity). `src/app/page.tsx` renders them in `<ol aria-label="Process">`. `e2e/landing_content.spec.ts` only checks that the list has four items inside the root box, so it cannot catch wrong step text.
**Solution:** Replace the four strings with the issue's steps verbatim, and extend `e2e/landing_content.spec.ts` to assert the four step texts as literals (not via `LANDING.steps`), so the facts are pinned by the suite independently of the content constant. Then confirm with the E2E suite that the list still fits at 320x568 without scrolling.

## Files to Modify

Use these files to implement the patch:

- `src/content/landing.ts` - replace the `steps` array.
- `e2e/landing_content.spec.ts` - assert the exact four step texts in order.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Replace `LANDING.steps` in `src/content/landing.ts`

- Replace the array at lines 7-12 with, in this order:
  - `"Discovery call to understand your project."`
  - `"A proposed visual identity for your reels."`
  - `"You record your talking heads."`
  - `"I edit them, consistent with the visual identity."`
- Keep the wording verbatim (no tightening needed; the strings are short). No em-dashes. Touch nothing else in the file; `src/app/page.tsx` needs no change (it maps `LANDING.steps` and uses each string as the `key`, and the four strings are unique).

### Step 2: Pin the step texts in `e2e/landing_content.spec.ts`

- In the per-viewport test, after `await expect(steps).toHaveCount(4);`, add:
  `await expect(steps).toHaveText([...])` with the same four strings as literals, in order (declare them once as a module-level `const PROCESS_STEPS = [...]` above the `for (const viewport of VIEWPORTS)` loop, with a one-line comment that they are the issue's facts and are deliberately not read from `LANDING`).
- Keep the existing `toHaveCount(4)` and `expectInsideRoot` loop unchanged, so the fit check at every viewport still runs.

### Step 3: Run the validation commands

- Source `.ports.env` (this run's `PORT` is `9212`); the `/prepare_app` server must already be up on it, started as `E2E_MOCK_STRIPE=true yarn dev`. Never set `CI=1`, never touch a server on another port.
- If `no_scroll` or `landing_content` fails at 320x568 because the new, slightly longer step 4 wraps, fix it in the layout (the `short:`/`tiny:` text and gap variants on the `<ol>` in `src/app/page.tsx`), never by shortening the facts or weakening a test.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn lint`
- `yarn typecheck`
- `yarn knip`
- `yarn test`
- `env -u STRIPE_SECRET_KEY -u NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN -u NEXT_PUBLIC_POSTHOG_HOST -u STRIPE_AUTOMATIC_TAX yarn build`
- `PORT=9212 yarn test:e2e` (full suite; `no_scroll.spec.ts` and `landing_content.spec.ts` must pass at 1920x1080, 375x667 and 320x568)

## Patch Scope

**Lines of code to change:** about 4 in `src/content/landing.ts`, about 8 in `e2e/landing_content.spec.ts`
**Risk level:** low
**Testing required:** E2E `landing_content` (now asserts the exact step texts) and `no_scroll` at all viewports, plus the standard lint, typecheck, knip, unit and build checks.
