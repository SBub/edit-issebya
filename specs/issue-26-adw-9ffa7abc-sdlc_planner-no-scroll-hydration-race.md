# Chore: no_scroll negative checks wait for React hydration before injecting their element

## Metadata

issue_number: `26`
adw_id: `9ffa7abc`
issue_json: `{"number":26,"title":"fix: no_scroll negative checks inject their element before React hydrates"}`

## Chore Description

`apps/web/e2e/no_scroll.spec.ts` > `negative check at 1024x768` > `a tall element makes the page
scroll vertically` fails intermittently. Both negative checks (the 200vh tall div and the 200vw
wide div, at 1024x768 and 1920x1080) call `waitForPageReady(page)` and then append a `<div>` to
`<main>`. `waitForPageReady` (`apps/web/e2e/viewport.ts`) waits for `document.fonts.ready` and for
the first reel card to be visible, and both are already true in the server-rendered HTML, before
React has hydrated. When the injection lands before hydration has passed `<main>`, React finds a
DOM node the server HTML did not have, reports a hydration mismatch, client-renders that tree and
drops the div. The page then does not scroll and the assertion fails, depending on timing.

The fix: `waitForPageReady` itself also waits until React has hydrated `<main>`, so every spec that
calls it (no_scroll, landing_content, equal_gaps, reel_slider, dialog_form, analytics, notrack,
legal_pages) gets the guarantee. Owner rule: the flaky test is fixed, never re-run into green,
retried, skipped or slowed with `waitForTimeout`; `retries: 0` and `workers: 1` stay.

### Hydration signal (decision and justification)

Signal: React's internal fiber key on the `<main>` element. When React hydrates a host element it
attaches the fiber to the existing DOM node under a key starting with `__reactFiber$`
(`precacheFiberNode` in `prepareToHydrateHostInstance`). That key never exists in the
server-rendered HTML, so it is an observable that only exists after hydration, readable from the
spec without touching the app. Polled with `page.waitForFunction`.

Why `<main>` and why this is sufficient: the specs inject into `<main>`. React completes a host
element bottom-up, and for a hydrating element it first checks for leftover (unclaimed) children
(`popHydrationState`, where an extra node becomes a mismatch) and only then attaches the fiber key.
So once `<main>` carries the key, React has already matched every child of `<main>`; a div appended
afterwards is never compared against the server HTML and is never removed. Checking `<main>`
rather than `document.body` also stays correct if Next wraps the page segment in a boundary that
hydrates separately: the key on `<main>` appears exactly when `<main>`'s own subtree hydrates. Every
caller of `waitForPageReady` is on `/`, which renders one `<main>` (`apps/web/src/app/page.tsx`).

Rejected alternatives:

- `window.__NEXT_HYDRATED` (`node_modules/next/dist/client/app-index.js`): set only when
  `__NEXT_TEST_MODE` is on, which this app does not use.
- A hydration-only interaction (for example sliding the reel slider): changes page state the
  no-scroll and layout specs then measure.
- A test-only attribute set in an effect: would change the app, which the issue allows only when no
  spec-side signal works, and one does.

## Relevant Files

Use these files to resolve the chore:

- `apps/web/e2e/viewport.ts` - holds `waitForPageReady` and `rootBox`; gets the new `waitForHydration(page)` helper, called from `waitForPageReady`.
- `apps/web/e2e/no_scroll.spec.ts` - the two negative checks with the race; they keep injecting the element and asserting `scrollHeight > clientHeight` / `scrollWidth > clientWidth`, now after a hydrated page.
- `apps/web/e2e/landing_content.spec.ts`, `apps/web/e2e/equal_gaps.spec.ts`, `apps/web/e2e/reel_slider.spec.ts`, `apps/web/e2e/dialog_form.spec.ts`, `apps/web/e2e/analytics.spec.ts`, `apps/web/e2e/notrack.spec.ts`, `apps/web/e2e/legal_pages.spec.ts` - other callers of `waitForPageReady`; read only, they must still pass (fix the same way only if one breaks).
- `apps/web/playwright.config.ts` - `retries: 0`, `workers: 1`; read only, must not change.
- `apps/web/src/app/page.tsx` - confirms `/` renders a single `<main>`; read only, the page must not change.
- `app_docs/landing-page.md` - the "No-scroll rule and its specs" paragraph naming the helpers in `apps/web/e2e/viewport.ts`; one sentence added since `waitForPageReady` changes meaning (`docs/conditional-docs.md` matches: "touching the no-scroll specs").
- `AGENTS.md`, `.adw/project.md` - rules: root box measurements, no em-dashes, Yarn only, commit format, run port from `.ports.env`.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Start the run's server

- `source .ports.env` (fall back to 3000 only if absent). Never touch a server on 3000 when `PORT` is not 3000.
- If `/prepare_app` has not already started it, start the Workspaces dev command in the background: `PORT=$PORT E2E_MOCK_STRIPE=true E2E_MOCK_RESEND=true yarn workspace @edit-issebya/web dev`, and wait until `/` answers 200. Never set `CI=1`.

### 2. Reproduce before changing anything

- Run `PORT=$PORT yarn test:e2e -- e2e/no_scroll.spec.ts -g "negative check" --repeat-each=40 --project=chromium`.
- Record the pass/fail count per test and the failure output (expected: `expect(received).toBeGreaterThan(expected)` on `box.scrollHeight` or `box.scrollWidth`) for the PR description.
- If it does not fail, retry against a cold server: stop only the server this run started, delete `apps/web/.next` in this worktree, restart it as in step 1 and immediately rerun the command (first compile). Record the result either way; a non-reproduction does not skip the fix.

### 3. Add `waitForHydration` and call it from `waitForPageReady`

- In `apps/web/e2e/viewport.ts`, add an exported-only-if-used helper above `waitForPageReady`:
  ```ts
  // React attaches its fiber to a DOM node (a `__reactFiber$` key) when it
  // hydrates it, after matching the node's children against the server HTML, so
  // a node added to <main> once the key is there is never dropped as a mismatch.
  async function waitForHydration(page: Page): Promise<void> {
    await page.waitForFunction(() => {
      const main = document.querySelector("main");
      return main !== null && Object.keys(main).some((key) => key.startsWith("__reactFiber$"));
    });
  }
  ```
  Keep it unexported (only `viewport.ts` uses it), so knip stays green.
- Make `waitForPageReady` call `await waitForHydration(page);` after the reel-card visibility check, and update its comment to: `// Fonts loaded (they change line breaks), the first reel card shown and React hydrated.`
- No timeout override: the default action timeout applies. No `waitForTimeout`, no retries.

### 4. Keep the negative checks as they are

- `apps/web/e2e/no_scroll.spec.ts` needs no code change: both negative checks already call `waitForPageReady` before injecting, still inject the 200vh / 200vw div into `main` and still assert `scrollHeight > clientHeight` / `scrollWidth > clientWidth` from `rootBox`. Optionally extend the `// Proves the measurement above can fail.` comment with `waitForPageReady waits for hydration, so React never drops the injected element.` Do not change the assertions.

### 5. Verify the fix

- `PORT=$PORT yarn test:e2e -- e2e/no_scroll.spec.ts -g "negative check" --repeat-each=100 --project=chromium` must pass 100/100 for each of the four tests. Record it.

### 6. Negative proof of the helper (probe, not committed)

- Temporarily replace the body of `waitForHydration` with a no-op (`return;`), rerun the step 5 command (also once on a cold server as in step 2 if the warm one passes), and record whether it fails again.
- Restore the helper exactly; `git diff` must show no trace of the probe.

### 7. Update the doc

- In `app_docs/landing-page.md`, "No-scroll rule and its specs", after the sentence naming the helpers in `apps/web/e2e/viewport.ts`, add: `` `waitForPageReady` waits for fonts, the first reel card and React hydration of `<main>` (its `__reactFiber$` key), so a spec that changes the DOM after it is never undone by a hydration mismatch. `` No em-dashes.

### 8. Run the Validation Commands

- Run every command below; all must pass. Confirm `git diff --stat origin/develop` touches only `apps/web/e2e/`, `app_docs/landing-page.md` and this plan under `specs/`.

## Test Coverage

No new test needed: the change is to the E2E layer itself (`apps/web/e2e/viewport.ts`). Its proof is the existing negative checks in `apps/web/e2e/no_scroll.spec.ts` (Playwright, chromium) run with `--repeat-each=100` and passing every time, plus the probe in step 6 showing they fail again with the hydration wait removed. There is no unit layer for e2e helpers, and no user-visible change.

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `source .ports.env` - the run's `PORT` for the E2E commands.
- `PORT=$PORT yarn test:e2e -- e2e/no_scroll.spec.ts -g "negative check" --repeat-each=100 --project=chromium` - the flake is gone: 100/100 per test.
- `yarn turbo run lint --filter=./apps/web` - ESLint over the changed e2e helper.
- `yarn turbo run typecheck --filter=./apps/web` - the helper types check (do not stage `next-env.d.ts`).
- `yarn knip` - no unused export introduced (the helper stays unexported).
- `yarn format:check` - Prettier over the changed files.
- `yarn turbo run test --filter=./apps/web` - unit suite unaffected.
- `yarn turbo run build --filter=./apps/web` - the app still builds.
- `PORT=$PORT yarn test:e2e` - the whole E2E suite passes with every `waitForPageReady` caller now waiting for hydration.
- `git diff --stat origin/develop` - only files under `apps/web/e2e/`, `app_docs/landing-page.md` and `specs/`.

## Notes

- The fiber key is a React internal; if a React upgrade renames it, `waitForPageReady` times out loudly on every spec rather than passing silently, which is the safe failure mode.
- A residual theoretical case: concurrent hydration restarted after `<main>` was completed would re-check its children. Initial hydration of `/` has no competing update, so this does not happen in these specs; if it ever showed up, the next step would be a commit-phase signal, not a retry.
- `retries: 0` and `workers: 1` in `apps/web/playwright.config.ts` stay. No change to the landing page, its layout or copy. Commit with `fix:` or `chore:` and no trailers.
- Put the reproduction counts, the failure output, the 100/100 result and the probe outcome in the PR description.
