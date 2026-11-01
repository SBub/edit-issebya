# Patch: make the export guardrail see a moved caption (caption-region SSIM)

## Metadata

adw_id: `95bd0696`
review_change_request: `Issue #1: Acceptance criterion "On the Mac, the tools spec passes" fails. PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools exits with 1 failed and 2 did not run. In apps/studio/tools/preview-matches-export.spec.ts:239 the matching frames pass (SSIM 0.9922 / 0.9929 / 0.9959 at 0.5 / 1.5 / 2.5 s) but the negative proof does not: with caption c-w0004 moved 60 px the scores are 0.9871 / 0.9929 / 0.9959, because the caption is visible at only one of the three times and whole-frame SSIM at the preview size barely notices it. The serial spec then skips the sound and memory tests, and the spec's Notes "Recorded values" line is still empty. Make the guardrail sensitive enough that the 60 px probe falls below the bound while the matching frames stay above it (for example SSIM on the crop around the moved caption's laid-out box, before and after the move, in addition to the whole frame, requiring both bounds), run the spec on the Mac and record every value in the spec's Notes. Do not weaken or drop the negative assertion; do not lower SSIM_BOUND below 0.9, and only with evidence. The loudness, onset and memory tests must also pass. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`

**Issue:** The guardrail compares only whole frames scaled to the preview's size (about a third of
the 1080x1920 export). A 60 px caption shift touches a few hundred preview pixels in one of the three
frames, so the lowest probe score is 0.9871, above `SSIM_BOUND` (0.95), and
`expect(Math.min(...probed)).toBeLessThan(SSIM_BOUND)` fails. The guardrail cannot detect the drift
it exists to catch, and because the spec is serial, the loudness, onset and `peak_rss_bytes` tests
never ran. No values were recorded in the spec's Notes.

**Solution:** Score a second, region-aware SSIM at every time: the crop of the region the probed
caption occupies before and after the move (its `build()` layout box, unioned with the same box
60 px lower, padded), mapped from frame pixels to the screenshot's scale and cut from both the
scaled preview and the scaled export frame. The matching run must hold `SSIM_BOUND` on both the
whole frame and the region at all three times; the probe must fall below the bound on the lowest of
its whole and region scores (the negative assertion is unchanged in strength: it still requires a
score below 0.95, now over a set that includes a score that can see the caption). The caption
whose region is cropped is chosen exactly as today (the first caption visible at one of the
compared times), so the moved text is inside the cropped region in the frame where it is shown.
Then run the spec on the Mac and fill in the Notes.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/tools/media.ts`: a `crop(image, region, out)` helper (ffmpeg `crop` filter).
- `apps/studio/tools/preview-matches-export.spec.ts`: build the layout before the matching run,
  compute the caption region, score whole and region per time, assert both bounds, log both.
- `specs/issue-35-adw-95bd0696-sdlc_planner-export-render-download-link.md`: the Guardrail summary,
  step 12's capture text and Test Coverage line describe the region score; the Notes "Recorded
  values" line filled in.

No app code, no `app_docs/` change (tests and `specs/` need no documentation, profile
Documentation), no profile change (the `test:tools` command is unchanged).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add a crop helper to `apps/studio/tools/media.ts`

- After `scaleTo`, add and export:
  ```ts
  // A rectangle in pixels of the image it is cut from.
  export interface Region {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  // The `region` of the image, as a PNG of the region's size.
  export async function crop(image: string, region: Region, out: string): Promise<void> {
    const { x, y, width, height } = region;
    await ffmpeg(["-y", "-i", image, "-vf", `crop=${width}:${height}:${x}:${y}`, out]);
  }
  ```
- Argument list only, never a shell, like the other helpers. knip sees both exports used by the spec.

### Step 2: Compute the probed caption's region before the matching run

- In `preview-matches-export.spec.ts`, move the font loading, `createMeasurer`, `build()` and the
  `shown` lookup from the middle of "the export matches the preview" to its top (before the first
  `scores` call), unchanged.
- Add `const SHIFT = 60;` and `const PAD = 24;` (frame pixels) beside the other constants, and use
  `SHIFT` where the probe sets `position.y` (`shown.y + SHIFT`) and in the log line.
- Add a pure helper `captionRegion(entry: LayoutEntry): Region` (import `type LayoutEntry` from
  `@edit-issebya/edit`, `type Region` from `./media.ts`) that returns, in frame pixels of
  `ISSEBYA.frame`, the union of the entry's box and the same box `SHIFT` lower, padded by `PAD` on
  every side and clamped to `0..ISSEBYA.frame.width` and `0..ISSEBYA.frame.height`:
  `x = max(0, entry.x - PAD)`, `y = max(0, entry.y - PAD)`,
  `right = min(frame.width, entry.x + entry.width + PAD)`,
  `bottom = min(frame.height, entry.y + entry.height + SHIFT + PAD)`.

### Step 3: Score the whole frame and the region at each time, and assert both

- Change `scores(page, label)` to `scores(page, label, region)` returning
  `{ whole: number[]; region: number[] }`. After the two `scaleTo` calls (unchanged), map the region
  to the screenshot's scale (`k = width / ISSEBYA.frame.width`; `x`, `y` floored, `width`, `height`
  rounded, each at least 8 px and kept inside `width` x `height`), `crop` both scaled images to it
  (`${label}-preview-${seconds}-region.png`, `export-${seconds}-region.png`) and push
  `ssim(previewRegion, frameRegion)` to `region` beside the whole-frame score to `whole`.
- Matching run: log `SSIM at 0.5 / 1.5 / 2.5 s: whole a / b / c, caption region d / e / f`, then
  `for (const score of [...matched.whole, ...matched.region]) expect(score).toBeGreaterThanOrEqual(SSIM_BOUND);`.
- Probe run (same route, reload and unroute as today): log both lists with `shown.id`, then keep the
  negative assertion as `expect(Math.min(...probed.whole, ...probed.region)).toBeLessThan(SSIM_BOUND);`.
  Do not remove it, loosen it, or change `SSIM_BOUND`.
- Comment above `scores`: the whole-frame score proves the frame matches; the region score is what
  can see a caption that is a small part of a downscaled frame, so the negative proof stands on it.

### Step 4: Run the guardrail on the Mac and fix until all three tests pass

- With this run's server up (Workspaces dev command, `PORT=9209`, `STUDIO_PORT=9109` from
  `.ports.env`), run `PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools`.
- Expected: matching whole and region scores at or above 0.95; the probe's region score at the
  caption's time well below it; then "the sound matches the sound track" and "the render step
  sampled the whole process group" run and pass.
- If a matching region score lands between 0.9 and 0.95 for a reason that is not a mismatch (for
  example text antialiasing at the preview's scale, visible by comparing the kept PNGs in the temp
  folder), step 12 applies: lower `SSIM_BOUND` with that evidence in a comment, never below 0.9, and
  only if the probe still falls below it. If the loudness check fails, follow step 12 (ffmpeg click
  mix, reason recorded), never tune `LOUDNESS_LU`, `ONSET_S` or `ONE_CHROME_BYTES`.

### Step 5: Update the plan's text and record the values

- In the spec file: the Guardrail bullet, step 12's "the export matches the preview" and negative
  proof bullets and the Tools line of Test Coverage say that each time is scored on the whole frame
  and on the probed caption's region (its laid-out box and the box 60 px lower, padded), both at
  least the bound, and that the probe must fall below the bound on the lowest of those scores.
- Replace the Notes line "Recorded values (fill in at step 12): ..." with the measured values from
  the passing run: whole-frame and region SSIM at 0.5 / 1.5 / 2.5 s; the probe's caption id and its
  whole and region scores with the lowest named; export and source loudness (LUFS); click onset
  errors (ms); render `peak_rss_bytes` (and the step summary). No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/studio`
- `yarn turbo run typecheck --filter=./apps/studio`
- `yarn knip`
- `PORT=9209 STUDIO_PORT=9109 yarn workspace @edit-issebya/studio test:tools`: all three tests pass
  (3 passed, 0 failed, 0 did not run) on the Mac, against this run's server; the logged values match
  the spec's Notes.
- `git diff --name-only origin/develop | xargs perl -ne 'print "$ARGV:$.\n" if /\x{2014}/; close ARGV if eof' -CSD`: prints nothing.

## Patch Scope

**Lines of code to change:** about 60 (15 in `media.ts`, 40 in the spec file, a few spec-plan lines)
**Risk level:** low (tools spec and its helper only; no app, worker or database code)
**Testing required:** the studio `test:tools` run on the Mac with the real HyperFrames render, all
three tests passing, plus lint, typecheck, knip and format.
