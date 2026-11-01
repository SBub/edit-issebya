# Patch: compare the preview and the export at the same frame, so the caption region holds

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #1: Acceptance criterion 'On the Mac, the tools spec passes' and its validation command both fail. The command was PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools, and it exited 1 against the current tree. After the caption-region patch, the matching run logs 'SSIM at 0.5 / 1.5 / 2.5 s: whole 0.9917 / 0.9926 / 0.9945, caption region 0.9226 / 0.9613 / 0.9153'. preview-matches-export.spec.ts:279 then fails with 'Expected: >= 0.95, Received: 0.922617'. The serial spec skips the sound and memory tests, so loudness, click timing, peak_rss_bytes and the 60 px negative proof are all unverified. Find out why the caption-region crop of the matching export scores 0.92 at 0.5 s and 2.5 s; fix the measurement so the matching export holds SSIM >= 0.95 on the whole frame and on the region at all three times (a region score may be scoped to the times the probed caption is visible, if justified in a comment); confirm the 60 px probe falls below the bound; do not lower SSIM_BOUND below 0.9 (and only with evidence in a comment); do not weaken the negative assertion; run test:tools until all three tests pass. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`

**Issue:** The region score of the matching export is 0.92 at 0.5 s and 2.5 s. Diagnosis done
while planning (the fixture edit built with `build()`, frame 1080x1920):

- The region is not near-uniform and not footage. The probed caption is `c-w0004` ("short",
  x 430.63, y 1290, 128.75x50, 0.467 to 0.752 s), so the region is x 406 to 583, y 1266 to 1424.
  Every compared time has a caption in that box: "short" at 0.5 s, `c-w0007` "for" (y 1290,
  1.357 to 1.557 s) at 1.5 s, `c-w0010` "studio" (y 1290, 2.052 to 2.605 s) at 2.5 s.
- The footage is a flat teal frame, and the preview copy matches the retimed source (SSIM 0.99997
  at 540x960, 1.0 at 1080x1920; cutout copies 0.9976), so the 540x960 preview copies are not the
  cause.
- Each compared time falls inside a GSAP caption transition (`preset.caption`: appear 0.18 s with a
  12 px rise, `power2.out`; fade 0.15 s from `hideAt = max(end - fade, start + minOnScreen)`):
  at 0.5 s "short" is 33 ms into its rise (opacity about 0.34, the steepest part of `power2.out`);
  at 2.5 s "studio" is 45 ms into its fade (hide at 2.455 s); at 1.5 s "for" is 143 ms into its
  rise, almost settled, and that time scores 0.9613. The score tracks how fast the caption is
  changing at the compared instant: the player's `seek(t)` and the export frame `extractFrame`
  takes at `-ss t` (30 fps render) are not sampled at the same timeline instant, and a few ms (or
  one frame, 33 ms) moves the caption's opacity and rise by a large share inside a 180 px crop
  while the whole frame dilutes it to 0.99.

**Solution:** Make the time mapping exact instead of loosening anything: compare at frame
indexes. Each compared time becomes frame `n = round(t * fps)` of the export (fps read from the
export), the export frame is selected by index (`select=eq(n\,N)`, no seek rounding), and the
player is seeked to the same frame's timeline time. Before fixing, measure which export frame
(and sub-frame instant) the preview actually matches, so the mapping is set from evidence and
written in a comment; also assert the player's box is the 9:16 video area at the screenshot's
device pixel ratio, so a letterbox or scale error cannot hide in the region crop. The whole and
region bounds stay at `SSIM_BOUND` (0.95) at all three times, and the negative assertion is
unchanged.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/tools/media.ts`: `extractFrame` selects a frame by index; a `frameRate(video)`
  helper.
- `apps/studio/tools/preview-matches-export.spec.ts`: frame-index mapping of `TIMES`, the player's
  seek to the frame's time, a 9:16 and device-pixel-ratio check of the player box, the comment
  with the measured evidence.
- `app_docs/export.md`: the Testing "Tools" paragraph names the frame-exact comparison and the new
  recorded matching scores.
- `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`: the Notes "Recorded
  values" line filled in from the passing run.

No app, worker or package code; no profile change (the `test:tools` command is unchanged).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Measure where the preview lands before changing the mapping

- Temporarily (not committed) keep the spec's temp folder (skip the `rm` in `afterAll` and log
  `work`) and run `PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools`
  against this run's server (`.ports.env`: `PORT=9209`, `BACKEND_PORT=9109`; the server is the
  Workspaces dev command, already up or started by `/prepare_app`, never a second one).
- From the kept files, for each of 0.5, 1.5 and 2.5 s, score the `same-preview-<t>-region.png`
  crop against the same crop of export frames `n - 1`, `n` and `n + 1`
  (`n = round(t * 30)`, extracted with `ffmpeg -i export.mp4 -vf "select=eq(n\,N)" -frames:v 1`
  and scaled and cropped exactly as `scores` does). Look at the region PNG pairs for the caption's
  opacity and vertical offset.
- Log from the spec: `player(page).boundingBox()`, `window.devicePixelRatio`, and the screenshot's
  pixel size (ffmpeg `-i` on the PNG). Expected: the box is 9:16 within 1 CSS px and the PNG is
  exactly `round(box * dpr)`; if not, the region mapping is wrong and Step 2's assertion catches it.
- Decide from the numbers, and write them in the comment of Step 2:
  - Region score highest at frame `n` once the export is selected by index (the `-ss` output seek
    took a neighbouring frame): Step 2's index selection is the whole fix.
  - Highest at a fixed neighbour (`n + 1` or `n - 1`) at all three times: the player and the
    renderer sample the timeline a whole frame apart; seek the player to that frame's time
    (`(n + offset) / fps`) and name the offset and the three scores in the comment.
  - No frame reaches 0.95 at a time while the player box and DPR are right: compare a preview
    screenshot seeked to the export frame's exact time against the export frame (Step 2's mapping
    already does this) and, if it still falls short, follow the "Fallback" bullet of Step 3.

### Step 2: Compare at frame indexes in `media.ts` and the spec

- `media.ts`: change `extractFrame(video, seconds, out)` to `extractFrame(video, index, out)`:
  `["-y", "-i", video, "-vf", \`select=eq(n\\,${index})\`, "-fps_mode", "passthrough", "-frames:v", "1", out]`,
comment "The frame numbered `index`(from 0), as a PNG; selected by index so no seek rounding
picks a neighbour." Add`frameRate(video): Promise<number>`that parses`(\d+(?:\.\d+)?) fps`from ffmpeg's`-i`banner (same catch pattern as`duration`), throwing when absent. Argument
  lists only, never a shell.
- Spec: in `scores`, read `fps` once from `exported`; for each `t` of `TIMES`,
  `const index = Math.round(t * fps) + FRAME_OFFSET` (`FRAME_OFFSET` a constant, 0 unless Step 1
  found a fixed neighbour, with the Step 1 numbers in its comment) and `const at = index / fps`;
  call `previewFrame(page, at, ...)` and `extractFrame(exported, index, ...)`. File names keep `t`
  so the logs still read 0.5 / 1.5 / 2.5 s. `previewFrame`'s poll keeps its 0.02 s tolerance
  around `at`.
- In `scores`, after reading the box and `ratio`: `expect(Math.abs(box.width * 16 - box.height * 9)).toBeLessThanOrEqual(16)`
  (9:16 within 1 CSS px, so the box is the video area with no letterbox), comment why: the region
  is mapped by `width / ISSEBYA.frame.width` alone, which is only right when the screenshot is
  the whole frame.
- Comment above `TIMES` (or `FRAME_OFFSET`): all three times fall inside a caption transition
  (the diagnosis above, with the caption ids and ms), which is why the comparison must be frame
  exact, and the before and after region scores.

### Step 3: Keep the bounds and the negative proof; run until all three tests pass

- Leave `SSIM_BOUND = 0.95`, the `for (const score of [...matched.whole, ...matched.region])`
  assertion and `expect(Math.min(...probed.whole, ...probed.region)).toBeLessThan(SSIM_BOUND)`
  exactly as they are. The probe runs through the same `scores`, so it uses the same frame mapping.
- Run `PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools`. Expected:
  whole and region at or above 0.95 at 0.5, 1.5 and 2.5 s; the probe's region score at 0.5 s
  (where `c-w0004` is moved 60 px, inside the region's 158 px height) clearly below 0.95; then
  "the sound matches the sound track" and "the render step sampled the whole process group" run
  and pass. A failing loudness or onset check follows the original spec's step 12 (never tune
  `LOUDNESS_LU`, `ONSET_S` or `ONE_CHROME_BYTES`).
- Fallback, only if Step 1 showed the frames aligned and a region score at a time where the probed
  caption is not visible (1.5 s or 2.5 s) still sits under 0.95: scope the matching region
  assertion to the times `c-w0004` (`shown`) is visible (`shown.start <= t < shown.end`), with a
  comment naming the measured scores and that the whole-frame score still covers those times. The
  region at 0.5 s (the probed caption's own time) must pass 0.95 in every case. Lower
  `SSIM_BOUND` only with the measured evidence in a comment, never below 0.9, and only if the probe
  still falls below it.
- Restore the temp folder cleanup in `afterAll` (undo Step 1's temporary edit).

### Step 4: Record the values

- `app_docs/export.md`, Testing, Tools paragraph: say the preview and the export are compared at
  the same frame index (the export's frame `round(t * fps)`, the player seeked to its time) and
  replace "The matching whole-frame scores were 0.9922 / 0.9929 / 0.9959" with the passing run's
  whole and region scores.
- Spec Notes: replace "Recorded values (fill in at step 12): ..." with the passing run's values:
  whole and region SSIM at 0.5 / 1.5 / 2.5 s, the probe's caption id with its whole and region
  scores and the lowest named, export and source loudness (LUFS), click onset errors (ms), render
  `peak_rss_bytes` and the step summary, and one line on the cause (caption transitions sampled at
  different instants). No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/studio`
- `yarn turbo run typecheck --filter=./apps/studio`
- `yarn knip`
- `PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools`: 3 passed, 0 failed,
  0 did not run, against this run's server; the matching log shows whole and region at or above
  0.95 at all three times and the probe's lowest score below 0.95; the logged values match the
  spec's Notes.
- `git diff --name-only origin/develop | xargs perl -CSD -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof'`: prints nothing.

## Patch Scope

**Lines of code to change:** about 40 (15 in `media.ts`, 20 in the spec file, a few doc and
spec-plan lines)
**Risk level:** low (tools spec and its media helper only; no app, worker or database code)
**Testing required:** the studio `test:tools` run on the Mac with the real HyperFrames render, all
three tests passing, plus format, lint, typecheck and knip.
