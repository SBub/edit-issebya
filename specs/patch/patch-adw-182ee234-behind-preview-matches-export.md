# Patch: make the behind-the-speaker composite score the same in preview and export

## Metadata

adw_id: `182ee234`
review_change_request: `Issue #1: The spec's guardrail validation (step 12 and the acceptance criteria: preview and export of a photo behind the speaker match at the existing PREVIEW_EXPORT_SSIM_BOUND) fails. 'a photo behind the speaker matches between preview and export' scored SSIM 0.937845 at 0.5 s, 0.949762 at 1.5 s and 0.942838 at 2.5 s, below >= 0.982, while the caption case passed at 0.98902, 0.993297 and 0.989198. Find out why the preview and export composites of the behind group differ, make them agree so all three samples reach at least 0.982, do not lower PREVIEW_EXPORT_SSIM_BOUND or loosen the case, and record the passing scores in app_docs/export.md. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md`

**Issue:** `apps/studio/e2e-tools/export-matches-preview.spec.ts`, case "a photo behind the speaker
matches between preview and export", scores about 0.94 at every moment, so the guardrail exits 1.
The caption case on the same run scores about 0.989.

**What planning already established (measured, do not re-derive):**

- The photo is the same image on both sides. The preview signs `photos.large_key`
  (`apps/studio/src/app/preview-actions.ts:103-110`) and the render downloads the same
  `photo.large_key` (`apps/worker/src/render/render-step.ts:239-248`). `seedReadyPhoto`
  (`apps/studio/test-support/photos.ts`) stores the bytes of `fixtures/photos/sample.jpg` as the
  large copy. `object-fit: cover` is the same in both paths: the injector copies `object-fit`,
  `filter` and `mix-blend-mode` onto each frame (`MEDIA_VISUAL_STYLE_PROPERTIES` in
  `node_modules/hyperframes/dist/chunk-BDZSH6P3.js:1651`).
- **Cause A, the test photo (about 0.017 of the gap, needed regardless of the composite).**
  `sample.jpg` is ffmpeg `testsrc2`, saturated colour bars. The export's 4:2:0 H.264 encode cannot
  keep its chroma, and the guardrail's `ssim()` compares two RGB PNGs (every plane). Measured
  during planning with no composite (a frame of `short-person.mp4`, read only, with `sample.jpg`
  pasted into the `top` spot 90,160 900x600, at 398x706: the RGB path against
  libx264 `yuv420p`), plain footage scores RGB 0.993389 (Y 0.996828). With the photo it scores RGB
  0.976202 while Y stays 0.997262. With the caption case's real baseline (0.989), a pixel-perfect
  composite with this photo tops out near 0.972, below 0.982. The spike in the original spec saw
  the same thing ("Measured in RGB the photo rectangle scored lower (0.94) ... in `yuv444p` the
  rectangle's luma SSIM is 0.9965"). This loss measures the encoder's chroma subsampling, not
  preview/export parity.
- **Cause B, the composite itself (the remaining about 0.03).** It is not yet located. The candidates,
  in order: (1) the render extracts every H.264 video without alpha, the mask included, as **JPEG**
  (`resolveFrameFormat` picks `jpg` under `--video-frame-format auto`; the frame goes through
  `SDR_JPEG_AS_BT601_FULL_RANGE_FILTER`, decoded with VideoToolbox on macOS,
  `chunk-AIXH3V5A.js:13313-13366`). The browser decodes the `vseg` mask (BT.709 video range,
  `apps/worker/tools/vseg/vseg.swift:63-67,124-128`) straight from H.264. A lossy mask breaks
  `footage x (1 - m) + footage x m`, so the error shows at the person's edges and as a level shift
  over the photo. (2) Frame timing in the preview: `seekTo` accepts any video within 0.05 s of its
  target, so the two footage copies (preview copy 540x960, `data-media-start` = span start) and the
  two mask copies (no `data-media-start`) can each show a different frame at the same moment.
  (3) The frame the export samples for the mask (`-noaccurate_seek`, `fps=...:round=up`, the mask
  starting at media time 0) may not be the frame the footage copies use.

**Solution:** First, keep the frames and measure where the difference is (per plane, per region).
Then fix the composite mismatch in our own code (render arguments or the preview wrapper; never
patch HyperFrames). Then give the guardrail's behind case a photo with natural colour, so the
case measures composite parity and not 4:2:0 chroma loss. The bound, the three moments, the
`top` spot, the real `vseg` mask, the real render and the 60 px probe all stay. Finally, record the
passing scores.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: attach the preview and export PNGs of
  every case to the test result. Make the behind case's photo from a natural-colour image. Update
  the header comment with the new measurements.
- `apps/studio/test-support/photos.ts`: `seedReadyPhoto` takes an optional `bytes` (default: the
  `sample.jpg` bytes as today; the photo-library spec is unchanged).
- Only if Step 2 points at the render's mask frames: `apps/worker/src/render/render-call.ts`
  (`renderArgs`, `RENDER_SETTINGS`) and `apps/worker/src/render/render-call.test.ts`.
- Only if Step 2 points at preview timing: `apps/studio/src/components/PreviewPlayer.tsx` /
  `apps/studio/src/lib/preview-clock.ts` (and `preview-clock.test.ts`).
- `app_docs/export.md`: the behind case's acceptance, the cause, the scores, and any render-argument
  rule change.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Keep the frames and locate the difference

- In `export-matches-preview.spec.ts`, after `scores()` computes the scores, attach each preview
  PNG and each extracted export PNG with `test.info().attach(name, { path, contentType: "image/png" })`.
  The attachments are copied into Playwright's gitignored output before the temp folders are
  removed. This is a permanent, small aid; no assertion changes.
- Source `.ports.env` and run the guardrail as the profile prescribes:
  `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`.
  Copy the `behind-*` frames into `agents/182ee234/patch_agent/behind-frames/` (gitignored, never
  committed).
- For each moment, compare `behind-preview-<t>.png` with `behind-export-<t>.png` with ffmpeg
  `ssim`: (a) RGB `All` (what the spec scores), (b) after `format=yuv444p`, `Y` and `All`. Then crop
  to three regions at the 398x706 scale (the photo rectangle: the `top` spot 90,160 to 990,760
  scaled by 398/1080; the person, from the mask frame; the rest). Also save
  `blend=all_mode=difference` images, and check whether the error sits at the person's edges, as a
  level shift over the photo, or as a whole-frame offset.
- Decide which candidate holds. Luma in the photo rectangle well below about 0.99, or a
  difference at the person's outline, means Cause B. Luma at or above about 0.99 everywhere, with
  only chroma in the photo rectangle low, means Cause A alone.

### Step 2: Fix the composite mismatch (Cause B) at its source

- Mask frames lossy or with shifted levels in the export (difference at the person's edges or as a
  flat level shift, footage alone matching): add `"--video-frame-format", "png"` to `renderArgs`
  in `apps/worker/src/render/render-call.ts` (a documented `hyperframes render` flag; `png` keeps
  every extracted frame lossless and skips the JPEG BT.601 re-encode). Add `videoFrameFormat: "png"`
  to `RENDER_SETTINGS` with a one-line reason. Update the exact-arguments expectation in
  `render-call.test.ts`. Run `yarn workspace @edit-issebya/worker test:tools`
  (`render.tools.test.ts`) to confirm the render still passes and its time stays within the
  test's limits.
- Mask and footage copies on different frames in the preview (the difference follows motion,
  and the copies' and masks' `currentTime` at capture are not on the same frame): make the preview
  wrapper put every video of a cut-out group on the same frame index as the export does (snap
  `t - data-start + data-media-start` to the 30 fps grid, `preset.behind.frameRate`) in
  `preview-clock.ts`, with a unit test. Tighten `seekTo`'s check in the spec to the same
  snapped time. This makes the check stricter, never looser.
- Never patch, fork or copy HyperFrames. Never change `PREVIEW_EXPORT_SSIM_BOUND`, `MOMENTS`,
  `PROBE_SHIFT_PX`, the `top` spot or the real-mask setting (`E2E_MOCK_MASK: ""`).

### Step 3: Give the behind case a natural-colour photo (Cause A)

- `seedReadyPhoto` takes an optional `bytes?: Uint8Array`, defaulting to `sample.jpg`. Width and
  height stay 1200x900 (the generated photo is that size).
- In the behind case, before seeding, make the photo in the case's temp folder with ffmpeg
  (`FFMPEG_PATH` or `ffmpeg`, as `test-support/frames.ts` does): one frame of
  `fixtures/pipeline/convert/converted.mp4` (read only) at 2.0 s,
  `hflip,scale=1200:900:force_original_aspect_ratio=increase,crop=1200:900`, written as JPEG
  (`-q:v 2 -pix_fmt yuvj420p`). This is a real camera picture with natural chroma. It is mirrored
  so it differs from the footage behind it, which keeps the 60 px probe sensitive. Add a short
  helper in `test-support/frames.ts` beside `extractFrame` if that keeps the spec tidy.
- In the case's comment, explain the choice in one or two sentences: `testsrc2`'s saturated bars
  lose chroma in any 4:2:0 export, measured at RGB 0.976202 against 0.993389 without the photo
  (Y unchanged at 0.997), so they measure the encoder and not preview/export parity. The probe
  must still score at least one frame below the bound.

### Step 4: Re-run the guardrail and record the scores

- Re-run the guardrail (Step 1's command). All three behind samples must be `>= 0.982`, the
  behind probe's minimum `< 0.982`, and the caption case and its probe must behave as before
  (caption `>= 0.982`, probe minimum below it). If the behind case is still below, go back to
  Step 1 with the new frames. Never relax a check.
- In `app_docs/export.md`, under "Preview matches export guardrail", add the behind case to
  Acceptance. Add a "Photo behind the speaker" score table (moment, behind, behind probe) with the
  measured values, and the caption case's scores from the same run. Write one short paragraph on
  the cause (the composite fix from Step 2, and why the case uses a natural-colour photo). If
  `--video-frame-format png` was added, add the Rules line "Render with `--video-frame-format png`;
  the cut-out mask must reach the page losslessly". Update the spec file's header comment with
  the same numbers. No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker && yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker && yarn knip`
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker`
- `yarn workspace @edit-issebya/worker test:tools` (only if `renderArgs` changed; owner's Mac)
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`
  must exit 0, with "behind: SSIM" at or above 0.982 at 0.5 s, 1.5 s and 2.5 s, and the caption
  case and both probes as required.

## Patch Scope

**Lines of code to change:** about 60 to 120 (spec and helper about 40, one render argument and its test, or
the preview clock snap and its test, about 20 to 40, and the docs about 30).
**Risk level:** medium (a render argument changes every export's frame extraction, or the preview
clock changes every cut-out's seek; both are covered by unit tests and the tools tests).
**Testing required:** studio and worker unit tests, the worker tools tests if `renderArgs` changed,
and the studio guardrail (`test:tools`) passing all three cases against the run's servers.
