# Patch: make the preview's clock test fail without the studio's readiness gate

## Metadata

adw_id: `b7898314`
review_change_request: `Issue #1: The spec's negative proof does not hold. Step 11 and Test Coverage say test 2 of apps/studio/e2e/preview.spec.ts ('the clock waits until both videos can play, at start and after a seek') fails without the readiness gate. With whenReady replaced by Promise.resolve(), test 2 passed 3 times out of 3: something other than the studio's gate keeps currentTime still, so nothing protects the gate against regression, and the commits hold no record that the probe was run. Find out why the clock holds without the gate, change test 2 so it fails when whenReady resolves at once (for example: serve the held file's first range and stall the rest, or assert readyState/currentTime at the moment play() is called), re-run the negative proof (bypassed: fail; restored: pass) and record the result for the PR. If the player itself guarantees the hold in every case, change the spec's Test Coverage claim and add a case where only the studio gate can hold the clock (a seek into an unbuffered range of a partly served file). Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md`

**Issue:** Test 2 of `apps/studio/e2e/preview.spec.ts` passes with the studio's gate bypassed. Root
cause, read from `node_modules/@hyperframes/player/dist/hyperframes-player.js` (0.8.222): on every
iframe load the player runs its own first-frame assets wait (`_waitForAssetsReady`: every `<video>`
and `<audio>` visible at time 0 must reach `readyState >= 3`, or 8 s pass, `_t = 8e3`). Until it
settles, `player.play()` only sets `_pendingPlay` and returns (`_play`: `if (this._ready &&
!this._assetsReady) { this._pendingPlay = true; return }`), so no `play` event fires and the clock
cannot move. The studio's Play button is enabled on `ready`, which fires before `assetsready`. Both
halves of test 2 hold a whole file (`subject.webm`, then `footage.mp4`) from the first byte, so the
player's own wait keeps the clock still for 8 s, longer than the 1.5 s the test samples, with or
without `whenReady`. The wait runs once per load: `seek()` clears `_pendingPlay` but never resets
`_assetsReady`, so after the first frame is ready a seek into data the browser does not have is
held by the studio's gate alone. That is the case the test must cover.

**Solution:** Test-only change plus a spec correction. Keep test 2's first half (whole cut-out held
at start: still a true requirement, now documented as held by the player's first-frame wait and the
gate together). Replace the second half with the case only the studio's gate can hold: serve the
first quarter of `footage.mp4` as a `206` partial response and hold every later request, wait for
`player.assetsReady`, assert the footage's buffer ends before the middle, seek to the middle and
press Play. Add a recorder (init script, spec only, no app code) that snapshots both videos'
`readyState`, `seeking` and `currentTime` against `player.currentTime` at the moment the player
fires `play`; the test requires every snapshot to be playable at the clock's time. With the gate
bypassed the player's `play` fires while the footage is still seeking, so test 2 fails
deterministically, whether or not the HyperFrames runtime would also stall its timeline. Re-run the
negative proof, then correct the spec's test 2 text, Negative proof and Test Coverage, and record
the probe's result in the spec's Notes for the PR.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/e2e/preview.spec.ts`: a partial-serve route helper, a `play`-moment readiness
  recorder, test 2's second half rewritten.
- `specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md`: Step 11 test 2
  text, the Negative proof bullet, Test Coverage, and a Notes bullet with the probe's recorded result.

No change to `apps/studio/src/` (the gate itself is correct; only its test is blind). No
`app_docs/` change: tests and `specs/` need no documentation (profile, Documentation).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add the partial-serve helper and the play-moment recorder to the spec

- In `apps/studio/e2e/preview.spec.ts`, next to `holdRequests`, add
  `serveFirstPart(page, pattern, fraction)`: on the first request matching `pattern`, `route.fetch`
  it with `range: "bytes=0-"` (the mock storage route answers ranges), take
  `last = Math.floor(total * fraction) - 1` and `route.fulfill` a `206` with
  `Content-Range: bytes 0-<last>/<total>`, `Content-Length`, `Accept-Ranges: bytes`, the fetched
  `Content-Type` and `body.subarray(0, last + 1)`; every later request awaits a `released` promise,
  then `route.continue()`. Return `{ release }`. Comment: the first quarter carries the `moov` box
  (the preview copies are `+faststart`) and the first second of frames, so the player's first-frame
  wait settles while the middle stays unbuffered.
- Add `recordPlayReadiness(page)`, an `addInitScript` that sets `window.__playReadiness = []` and
  adds a capture-phase `play` listener on `window` (capture sees the player's non-bubbling event);
  for a target whose `tagName` is `HYPERFRAMES-PLAYER` it pushes, for `#footage` and `#cutout` in
  `target.iframeElement.contentDocument`, `{ id, readyState, seeking, currentTime, clock:
target.currentTime }`. Declare the window field locally in the spec (a cast, as `__noReload` does);
  nothing is added to app code.
- Add `playableAtClock(records)`: true when the array is non-empty and every record has
  `readyState >= 3`, `seeking === false` and `|currentTime - clock| <= 0.25` (the same thresholds as
  `canPlayFrom` in `apps/studio/src/lib/media-ready.ts`).

### Step 2: Rewrite test 2's second half as the case only the studio's gate can hold

- Keep the first half (cut-out held whole, Play, drift at 0 for 1.5 s, "Loading" visible, release,
  time passes 0.3 s). Add a one-line comment: on a fresh load the player's own first-frame wait
  holds here too.
- Replace the second half: `page.unrouteAll`, `recordPlayReadiness(page)`, then
  `const footage = await serveFirstPart(page, "**/cache/preview_copies/**/footage.mp4", 0.25)`,
  `openReel`, then `await expect.poll(() => player(page).evaluate((el) => (el as unknown as {
assetsReady: boolean }).assetsReady)).toBe(true)` (the player's own wait is over, so it can no
  longer hold the clock).
- Compute `middle` as today, then assert the precondition that makes the case meaningful: the
  footage element's last `buffered.end` (read through `iframeElement.contentDocument`) is below
  `middle - 0.5`. A fixture whose first quarter already reaches the middle fails here loudly instead
  of passing silently.
- Seek to `middle`, press Play, expect "Loading" visible and `drift(page, middle, 1500) <= 0.05`;
  `footage.release()`; poll `playerTime > middle + 0.2` within 5 s; then poll
  `window.__playReadiness` until non-empty and expect `playableAtClock` to be true for it.
- Rename the test to `the clock waits until both videos can play, at start and after a seek into
unbuffered footage`.

### Step 3: Run the negative proof, then the restored run

- Source the run's ports: `set -a; . ./.ports.env; set +a`. The `/prepare_app` server must already be
  up on `$PORT` (never start a second one, never touch port 3000).
- Bypass: in `apps/studio/src/components/PreviewPlayer.tsx` replace
  `await whenReady(playingMedia(player), controller.signal, at);` with
  `await Promise.resolve(); console.log("gate-bypass-probe");` and confirm the dev server serves it
  (`grep -l gate-bypass-probe apps/studio/.next/dev/static/chunks/apps_studio_src_*.js`).
- Run `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio playwright test preview.spec.ts -g "the clock waits" --repeat-each=3`.
  All 3 must fail; note which assertion (expected: `playableAtClock` false, a footage record with
  `seeking: true` or `readyState < 3`; the drift assertion may fail first if the runtime's timeline
  runs on). If any run passes, the case is still not gate-only: lower the served fraction and
  repeat before going on.
- Restore with `git checkout -- apps/studio/src/components/PreviewPlayer.tsx`, confirm
  `git status --short apps/studio/src` is empty and the probe string is gone from the served chunk,
  rerun the same command: all 3 must pass.

### Step 4: Correct the spec and record the probe for the PR

- In the spec's Step 11, rewrite test 2's text to the new second half (first quarter of
  `footage.mp4` served as a partial response, the rest held, `assetsReady` awaited, seek beyond the
  buffer, drift held, readiness of both videos at the player's `play` moment).
- Rewrite the Negative proof bullet with the Step 3 commands (the studio's own Playwright command
  with `-g`, since `yarn test:e2e -- <file>` also passes the file to the landing suite).
- In Test Coverage, replace "test 2 fails without the readiness gate" with: the player's own
  first-frame wait (8 s, once per load) also holds the clock at start, so the gate is proven by the
  seek into unbuffered footage after that wait has settled, which fails without the gate.
- Add a Notes bullet `**Negative proof, run 2026-11-01**`: the cause (the player's `_assetsReady`
  first-frame wait), the bypass used, the command, "3 of 3 failed on <assertion>" with the gate
  bypassed and "3 of 3 passed" restored (fill in the observed results). The PR body quotes it.
- Check both changed files for em-dashes: `grep -n -P "\x{2014}" apps/studio/e2e/preview.spec.ts specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md specs/patch/patch-adw-b7898314-preview-gate-negative-proof.md` prints nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `yarn turbo run lint --filter=./apps/studio && yarn turbo run typecheck --filter=./apps/studio`
2. `yarn knip && yarn format:check`
3. `yarn turbo run test --filter=./apps/studio`
4. `yarn turbo run build --filter=./apps/studio`
5. `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` (both suites,
   against the `/prepare_app` server; `preview.spec.ts` passes in full with the gate in place, and
   Step 3's recorded bypass run failed test 2).

## Patch Scope

**Lines of code to change:** about 70 in `apps/studio/e2e/preview.spec.ts`, about 20 in the spec file
**Risk level:** low (test and spec only; no app code changes)
**Testing required:** the negative proof (gate bypassed: test 2 fails 3 of 3; restored: passes 3 of 3) and the full studio E2E suite, plus the lint, typecheck, knip, format, unit and build gates.
