# Patch: Docs for removing the cut-out from the pipeline (spec step 12)

## Metadata

adw_id: `baceb379`
review_change_request: `Issue #1: Spec step 12 (Docs) is not in the diff. No file under app_docs/, docs/conditional-docs.md or apps/worker/README.md is changed. app_docs/pipeline.md, status.md and storage.md still describe remove_background, and docs/conditional-docs.md's pipeline line still says 'background removal'. Two feature-doc Rules are now broken without being rewritten in the same change, which AGENTS.md forbids: pipeline.md line 197 and status.md line 180. Resolution: do spec step 12 on this branch. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-94-adw-baceb379-sdlc_planner-remove-cutout-from-pipeline.md`
**Issue:** The code no longer has a `remove_background` step, a cut-out preview or a `cutout` asset
role, and `head_track` makes its own sampled person mask (`person-mask.ts`, `parsePersonMaskProgress`,
version 2), but the feature docs still describe the old pipeline. Two Rules are broken without being
rewritten: `app_docs/pipeline.md:197` (u2net rule for background removal) and `app_docs/status.md:180`
("Progress only for `remove_background` and `render`").
**Solution:** Docs only. Rewrite the stale passages in seven feature docs and the index line, using
the facts in the code on this branch, and replace both Rules in the same change. No code change.

## Files to Modify

- `app_docs/pipeline.md`
- `app_docs/status.md`
- `app_docs/storage.md`
- `app_docs/edit-model.md`
- `app_docs/preview.md`
- `app_docs/export.md`
- `app_docs/decide-step.md`
- `docs/conditional-docs.md`

(`apps/worker/README.md` lists no steps: grep found no step, `remove` or cut-out mention, so it
stays as is. Confirm with `grep -n -i -E "remove|cut-?out|head_track" apps/worker/README.md`.)

Code facts to cite (read them, do not guess): `apps/worker/src/pipeline/definition.ts` (`PIPELINE`,
`RETIRED_OUTPUTS` lines 72 to 79, `retentionOf`), `head-track-step.ts` (`HEAD_TRACK_VERSION = 2`,
`headTrackSampleArgs`, `headTrackDecodeArgs`, scratch `samples.mp4`, `mask.part.webm`,
`frames.rgba`, `HEAD_TRACK_STEP_SETTINGS = { ...HEAD_TRACK_SETTINGS, mask: PERSON_MASK_SETTINGS }`),
`person-mask.ts` (`PERSON_MASK_ENTRY` pointing at `remove-background-entry.ts`, `personMaskArgs`,
`parsePersonMaskResult`, `PERSON_MASK_SETTINGS`), `preview-copies.ts` (`PREVIEW_VERSION = 2`, one
output), `progress-parsers.ts` (`parseRenderProgress`, `parsePersonMaskProgress`),
`progress-testdata/person-mask.txt`, `pipeline/head-track.tools.test.ts`, `pipeline/person-mask.test.ts`,
`apps/studio/e2e/upload.spec.ts` (count of `skipped` rows).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Rewrite `app_docs/pipeline.md`

- Title (line 1): `# Fixed Pipeline Steps: Convert, Transcribe, Retime, Head Tracking, Previews`.
- Overview (lines 10 to 14): five fixed steps; drop `remove_background`; `head_track` is "the head
  position every 0.25 s, from its own sampled person mask".
- Statuses (line 20): drop `removing_background`. Line 24: `PIPELINE = [convert, transcribe, retime,
headTrack, previewCopies]`. Lines 88 to 91: keep the migration fact, add that
  `removing_background` stays allowed for old reels and in `REEL_STATUSES`, but is no longer in
  `PipelineReelStatus` and nothing writes it. Line 92: "after the five steps".
- Replace the `remove-background.ts` paragraph (lines 60 to 70) with a `person-mask.ts` paragraph:
  runs HyperFrames' own Node on `remove-background-entry.ts` (`PERSON_MASK_ENTRY`, the package's
  `removeBackground` with the CLI's options, pinned `u2net_human_seg`, `--device auto --quality
balanced`), prints per-frame progress and ends with the CLI's JSON result
  (`parsePersonMaskResult`: `ok` true and a positive `framesProcessed`).
- Replace the `head-track-step.ts` paragraph (lines 73 to 76): input `retime/source.mp4`; ffmpeg keeps
  one frame per 0.25 s at 270x480 (lossless `samples.mp4`); the person mask runs on that clip into a
  scratch VP9-alpha `mask.part.webm`; ffmpeg decodes it (`-c:v libvpx-vp9` before `-i`) to raw RGBA
  in `frames.rgba`, read one frame at a time. All three scratch files are deleted in the step, never
  uploaded. Version 2; settings are the tracker's plus `mask` (HyperFrames version among them).
  Output `head-track.json` (format unchanged). Zero frames or a trailing partial frame fails.
- `preview-copies.ts` paragraph (lines 77 to 79): one encode, `footage-preview.mp4`, version 2.
  "Preview copies" section (lines 113 to 116): drop the Subject sentence and the "together" size;
  state the footage preview only.
- Kept and rebuildable (lines 124 to 126): drop `subject.webm` and `subject-preview.webm`; add a
  line: retired outputs (`remove_background`'s `subject.webm` rebuildable, `preview_copies`'
  `subject-preview.webm` kept) are still classified by `retentionOf` through `RETIRED_OUTPUTS` for
  old reels' stored files, and never written again.
- Testing (lines 174 to 178): `head-track.tools.test.ts` runs `head_track` on
  `fixtures/footage/short-person.mp4` (real HyperFrames mask, `u2net_human_seg`, at least 80 percent
  of head samples found); mention `person-mask.test.ts` among the unit tests. Line 182: set the
  `skipped` row count to what `upload.spec.ts` asserts now.
- Notes (lines 210 to 211): the fixtures stay on `short-speech.mp4` (no person): its head track is all
  `null`, enough for cache hits; `fixtures/pipeline/` has no `remove_background/` and no
  `subject-preview.webm`.
- Rules: replace lines 197 to 198 with exactly: "No background removal step until #20; #20 brings
  the cut-out back on demand, only for moments where something is placed behind the speaker.
  `head_track` makes its own sampled person mask with HyperFrames' pinned u2net and never stores
  it."
- Add the spec path to the doc's spec list at the top.

### Step 2: Rewrite `app_docs/status.md`

- Overview (line 9): the two long steps are `head_track` (its person mask's per-frame progress) and
  `render`.
- Lines 34 to 36: `parseRenderProgress` and `parsePersonMaskProgress`.
- Lines 40 to 47: retitle the bullet `head_track`; same explanation (the pinned CLI prints no
  progress unattended, so the person mask runs `remove-background-entry.ts` through
  `person-mask.ts`), progress is per sampled frame; drop "version, settings and fingerprints are
  unchanged" (head_track is version 2).
- Line 48: `render.txt` and `person-mask.txt`. Line 138: a running `head_track` or `render` step.
  Line 159: `pipeline/person-mask.test.ts` (or `head-track-step.test.ts`, whichever asserts the
  parser on the call) instead of `pipeline/remove-background.test.ts`.
- Rule line 180: "Progress only for `head_track` and `render`."

### Step 3: Update `app_docs/storage.md`, `app_docs/export.md`, `app_docs/decide-step.md`

- storage.md lines 64 to 69: two live `rebuildable` outputs (`converted.mp4`, retime's
  `source.mp4`); old `remove_background/subject.webm` and `preview_copies/subject-preview.webm`
  objects stay where they are, still classified (retired outputs) and slimmed like any file of their
  tag (`subject.webm` rebuildable, deleted under the same seven-day rule; nothing re-runs to rebuild
  it, no version built since needs it); the next export re-runs `convert` and `retime` only.
  Line 184: "`transcribe` and `head_track` also run HyperFrames".
- export.md line 56 to 57: render downloads the full-size footage only (a stored version naming a
  cut-out builds without it). Line 68: drop "and the cut-out's outline" (keep "text edges sharper").
- decide-step.md line 9: "After the five fixed steps". It has no `hides_cutout` or cutout track
  mention; confirm with `grep -n -i "cut-\?out" app_docs/decide-step.md` and change nothing else.

### Step 4: Update `app_docs/edit-model.md` and `app_docs/preview.md`

- edit-model.md lines 25 to 27: `inputs.cutout` and `tracks.cutout` are optional and never written
  now (old versions may hold them); the builder ignores them. Line 36: footage clips take `hidden`
  spans. Line 59: drop "hides the cut-out" from `panel`. Line 71: roles `footage`, `font`, `sound`.
  Line 121: baseline is footage over the whole reel plus captions.
- preview.md line 12: "the small preview copy of the footage". Line 19: `{ footage }` (old rows with
  `cutout` still parse). Line 27: signs URLs for the edit, transcript, head track and footage
  preview. Line 44: swaps the footage path for its signed URL. Line 96: Test 2: the clock stays at 0
  while the footage is held, and at a seek target while the footage past the served bytes is held
  (match `apps/studio/e2e/preview.spec.ts`'s wording; it also asserts one `<video>` and no
  `subject-preview.webm` request).

### Step 5: Update `docs/conditional-docs.md` and check

- Line 13: replace "background removal, head tracking" with "head tracking (with its sampled person
  mask)".
- Run `grep -rn -i -E "remove_background|removeBackground|subject-preview|subject\.webm|cut-?out|removing_background" app_docs docs`
  and leave only intended mentions (retired outputs, old rows, #20, the entry file name).
- Run `grep -rn $'\u2014' app_docs docs specs/patch/patch-adw-baceb379-cutout-removal-docs.md`: no em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`
- `yarn knip`
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`

## Patch Scope

**Lines of code to change:** about 90 lines of Markdown across 8 docs, no code
**Risk level:** low
**Testing required:** docs only: format check plus the commit-hook checks (lint, typecheck, knip,
unit) stay green; the greps in Step 5 show no stale cut-out description and no em-dash.
