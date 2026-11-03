# Patch: make the big word behind the speaker match between preview and export

## Metadata

adw_id: `182ee234`
review_change_request: `Issue #1: Acceptance criterion 'Preview and export of a version with one photo and one big word match (guardrail at the existing bound) on the owner's Mac' fails, and so does spec step 12. I ran PORT=9213 STUDIO_PORT=9113 yarn workspace @edit-issebya/studio test:tools on the run's servers and it exited 1. The case 'a photo and a big word behind the speaker match between preview and export' fails at export-matches-preview.spec.ts:462 with behind-word: SSIM 0.5 s 0.983279, 1.5 s 0.986733, 2.5 s 0.986025, against PREVIEW_EXPORT_SSIM_BOUND 0.9855. The other cases pass: guardrail 0.998655/0.998293/0.998843, caption probe min 0.983808, photo 0.987437/0.991179/0.99071, photo probe min 0.923527. Also, patch patch-adw-182ee234-guardrail-big-word-behind.md step 3 was never finished: app_docs/export.md has no big-word column or scores. The bound cannot simply return to 0.982, because the caption probe's minimum (0.983808) would then pass. Resolution: find out why the big word WORK differs between the live preview and the export at 0.5 s (per plane and over the word's box; likely font loading or anti-aliasing of the large white Golos Text glyph edges, the word's first frames at its hard cut-in, or chroma loss on white-on-flat-colour edges). Fix it in our code (builder markup, render arguments, or the guardrail's measurement, applied equally to every case), never by patching HyperFrames. Do not lower PREVIEW_EXPORT_SSIM_BOUND or loosen the case. Re-run until behind-word scores >= 0.9855 at 0.5, 1.5 and 2.5 s with the probes still below. Then add a 'Big word behind' column with the measured scores to the composition-box table in app_docs/export.md and mention the word in its Acceptance bullet. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md`

**Issue:** In `apps/studio/e2e-tools/export-matches-preview.spec.ts`, the `behind-word` version
(one big white `WORK` in Golos Text Bold, 400 px at most, on the fixture's flat-colour footage)
scores 0.983279 / 0.986733 / 0.986025, so 0.5 s is below the 0.9855 bound and the other two
clear it by under 0.0013. `app_docs/export.md` has no word scores. The PNGs named in the request
are no longer under `apps/studio/test-results/` (only `.last-run.json` is left), so the cause must
be measured again from a fresh run before anything is changed.

**Known facts (do not re-derive):**

- The fixture footage is a flat colour and the mask cuts nothing out (`app_docs/export.md`), so
  the cut-out's frame alignment is not the cause.
- Captions and accents already use the same `@font-face` rules and score 0.998+, so the font file
  and its URL rewrite (`apps/studio/src/lib/preview-page.ts`) are known to work for small text.
- A 4:2:0 round trip of a preview capture alone scored 0.994112 with the guardrail's scale flags:
  chroma subsampling by itself costs about 0.006, and a frame-wide white glyph on a saturated flat
  colour has far more colour-edge pixels than any caption.
- `seekTo` waits only for videos (seeked, `readyState >= 2`, within 0.05 s) and two animation
  frames. It never waits for `document.fonts` or for `<img>` decoding. The 0.5 s capture is the
  first one after each new version's preview opens, and it is the lowest moment in both behind
  cases (photo 0.987437 against 0.991179 and 0.99071; word 0.983279 against 0.986+).

**Solution:** Measure first (Step 1), then apply the fix the measurement names, always to the
guardrail's measurement or our markup and to every case alike: (a) a capture readiness wait for
fonts and images if the 0.5 s preview differs in glyph shape or presence, and/or (b) the 4:2:0
chroma sampling the export format imposes applied to the preview reference before SSIM if the loss
is in the U and V planes at the word's edges. Re-measure every case, keep the bound at 0.9855 (or
raise it only if every guardrail score rises, with all score sets recorded), keep both probes
below, and record the scores and the word in `app_docs/export.md`.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: `seekTo` readiness wait and/or the SSIM
  reference preparation, the header comment's measured numbers.
- `apps/studio/test-support/frames.ts`: only if fix (b) applies, a helper that writes the 4:2:0
  round trip of a PNG with the same `SCALE_FLAGS`.
- `app_docs/export.md`: the Acceptance bullet, the measurement paragraph, the composition-box
  table's `Big word behind` column (and every column re-measured), the Rules if the measurement
  changes.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Reproduce and measure the 0.5 s difference

- From the worktree root, with `.ports.env` sourced and the `/prepare_app` server up, run
  `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools` once and
  keep the attachments `behind-word-preview-{0.5,1.5,2.5}.png` and
  `behind-word-export-{0.5,1.5,2.5}.png` from `apps/studio/test-results/` (copy them to a scratch
  folder under `agents/182ee234/patch_agent/`, never committed).
- Per plane: `ffmpeg -hide_banner -i <preview> -i <export> -lavfi ssim -f null -` and read the
  `Y:`, `U:`, `V:` and `All:` values for each moment.
- Over the word's box: get `#behind-word`'s box in the composition (1080x1920 frame pixels from the
  built element's `left`, `top`, `font-size` and the measured width), scale it to the capture size,
  crop both PNGs to it (`crop=w:h:x:y`) and run the same per-plane SSIM; then the same on the
  complement (the frame with the word box filled identically in both, or a crop of a region with no
  word and no caption) to see how much of the loss is the word.
- Font and image readiness at the 0.5 s capture: in a one-off Playwright check (not committed)
  against the same version, evaluate inside the composition frame right after `seekTo(0.5)`:
  `document.fonts.status`, `document.fonts.check('400px "Golos Text"')` and every
  `img.complete && img.naturalWidth > 0`; and compare the word's glyph outline in the 0.5 s and
  1.5 s previews (identical if the font was loaded at both).
- Record which of these the numbers show: (a) the 0.5 s preview glyphs or photo not yet loaded or
  decoded (glyph shape or presence differs, Y loss on the word box, 0.5 s only); (b) chroma loss on
  the white glyph edges (U and V well below Y on the word box at every moment, Y close to the
  guardrail's); (c) anything else (for example a different frame of the word at 0.5 s), which is
  then traced the same way before Step 2.

### Step 2: Fix the cause in the guardrail's measurement or our markup, for every case

- If (a): in `seekTo`, after the video poll and before the two animation frames, wait inside the
  composition frame for `document.fonts.ready` and for every `img` in the body to be `complete`
  and `decode()`d (a single `evaluate` returning a promise). It runs for every capture of every
  case. Comment why: the first capture after a version opens can precede the font or photo.
- If (b): compare the export against what the preview looks like in the export's pixel format.
  Add `subsampled(png, out)` to `apps/studio/test-support/frames.ts` (ffmpeg
  `-vf format=yuv420p,scale=iw:ih:flags=${SCALE_FLAGS},format=rgb24`, one frame, PNG out) with a
  comment citing the 0.994112 round-trip figure, and in `scores` run it on each preview capture
  before `ssim`, so every case (guardrail, both probes, photo, word) is measured the same way. Keep
  the original preview PNG attached and attach the subsampled one too.
- If both show, apply both. If (c), fix it at its cause in our code (builder markup in
  `packages/edit/src/build.ts`, for example the word element's rendering properties, or the render
  arguments in `apps/worker/src/render/render-call.ts`), never in HyperFrames; a builder change
  must keep the committed goldens in step (`packages/edit` tests) and must not alter the word's
  measured box.
- Never change `PREVIEW_EXPORT_SSIM_BOUND` downward, `MOMENTS`, `PROBE_SHIFT_PX`, the word text,
  the real mask (`E2E_MOCK_MASK: ""`) or the real render, and never drop or skip a moment.

### Step 3: Re-run the guardrail until every case and probe holds

- Run `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools` again.
  Required: `guardrail`, `behind` and `behind-word` every moment >= 0.9855; `probe` and
  `behind-probe` each have at least one moment < 0.9855. Run it a second time to confirm the scores
  are stable.
- If the new measurement lifts the caption probe's minimum to or above 0.9855, the bound may only
  be raised (never lowered), to near the middle of the new gap between the highest probe minimum
  and the lowest guardrail, photo or word score, following the existing rule in
  `app_docs/export.md`; then re-run once more.
- Update the header comment in `export-matches-preview.spec.ts` with the cause found and this
  run's numbers (guardrail, caption probe, photo, photo probe, word), in the style of the existing
  paragraphs. No em-dashes.

### Step 4: Record the word and the scores in `app_docs/export.md`

- Acceptance bullet: every guardrail frame, every frame of the photo behind the speaker and every
  frame of one big word behind the speaker (`WORK`, a second version over the same span, since the
  fixture's speech is too short for both in one version) scores at or above the bound; each case's
  probe (a caption, or the photo, moved by 60 px) scores at least one frame below it.
- Add a paragraph after the existing measurement history: the word's first scores
  (0.983279, 0.986733, 0.986025), what Step 1 measured (per plane and over the word's box) and
  the fix.
- Composition-box table: add a `Big word behind` column after `Photo behind probe` with this run's
  values at 0.5, 1.5 and 2.5 s, and replace the other columns with this run's values if they
  changed; update the `peak_rss_bytes` line. Keep the older tables as they are.
- Rules: if fix (b) was applied, extend the composition-box rule: the preview capture is passed
  through the same 4:2:0 sampling as the export before SSIM. If fix (a), add that every capture
  waits for fonts and images. No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions. From the worktree
root, with `.ports.env` sourced (`set -a; . ./.ports.env; set +a`) and the `/prepare_app` server
already up on this run's port.

1. `yarn turbo run lint --filter=./apps/studio` (add `--filter=./packages/edit` or
   `--filter=./apps/worker` to commands 1, 2, 4 and 5 only if Step 2 touched them)
2. `yarn turbo run typecheck --filter=./apps/studio`
3. `yarn knip && yarn format:check`
4. `yarn turbo run test --filter=./apps/studio`
5. `yarn turbo run build --filter=./apps/studio`
6. `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`: exits 0;
   `behind-word` >= 0.9855 at 0.5, 1.5 and 2.5 s; `guardrail` and `behind` likewise; `probe` and
   `behind-probe` each with at least one frame below the bound.

## Patch Scope

**Lines of code to change:** about 40 (spec 10 to 20, frames.ts 0 to 20, export.md about 20)
**Risk level:** medium (a measurement change re-scores every case; the probes must stay below)
**Testing required:** the studio tool test on the owner's Mac (real HyperFrames, real `vseg`
mask), run twice, plus lint, typecheck, knip, format, unit and build for the studio.
