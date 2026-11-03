# Patch: document the behind track, the on-demand cut-out and library photos behind the speaker

## Metadata

adw_id: `182ee234`
review_change_request: `Issue #2: Step 13 (Documentation) is mostly not done. The only doc changed is app_docs/pipeline.md, where the 'until #20' rule is replaced by the on-demand cut-out rule. These are unchanged: app_docs/edit-model.md (the behind track, inputs.masks/inputs.photos, preset behind values, builder contract, checks, golden), app_docs/preview.md (masks and photos in loadPreviewSources and previewPage), app_docs/export.md (render downloads masks and photos, the guardrail's new case and its scores), app_docs/storage.md (the cutout key layout and its slimming), app_docs/decide-step.md, app_docs/photo-library.md, app_docs/studio-reel-layout.md (the behind schema, the photo quoting rule, the Behind row) and docs/conditional-docs.md (the pipeline.md and edit-model.md lines). Resolution: Fixable on this branch. Make the step 13 updates the spec lists in app_docs/edit-model.md, preview.md, export.md (including the guardrail scores once issue 1 passes), storage.md, decide-step.md, photo-library.md and studio-reel-layout.md. Update the pipeline.md and edit-model.md lines in docs/conditional-docs.md. Use no em-dashes, and add any new invariant to the doc's Rules section. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md`
(task 13, "Documentation")

**Issue:** The branch adds the `behind` track, the `vseg` cut-out, library photos in the decide
input, the preview's mask and photo sources, the render's mask and photo downloads and the timeline's
Behind row, but only `app_docs/pipeline.md` was touched (its one rule). Seven feature docs and the
index still describe the reel as if nothing can sit behind the speaker.

**Solution:** Edit each listed doc in place (never a second file), describing what the code on this
branch does, read from the code itself (the facts below are pointers, not a substitute for reading
it). Add every new "never" or "only" to that doc's Rules section. Finish the rest of task 13
(pipeline.md's three remaining items, the two index lines, the profile's Tests section). Prose only:
no code changes, no em-dashes.

Note on `app_docs/export.md`: the issue 1 patch
(`specs/patch/patch-adw-182ee234-behind-preview-matches-export.md`) already rewrote its guardrail
section in the working tree (the behind case, the 0.9855 bound, the scores table, the
composition-box rule). Keep those edits exactly as they are. This patch only adds the render's mask
and photo downloads to export.md's Worker section, and must not touch the guardrail scores.

## Files to Modify

- `app_docs/edit-model.md`
- `app_docs/preview.md`
- `app_docs/export.md` (Worker section only)
- `app_docs/storage.md`
- `app_docs/decide-step.md`
- `app_docs/photo-library.md`
- `app_docs/studio-reel-layout.md`
- `app_docs/pipeline.md` (task 13's three remaining items)
- `docs/conditional-docs.md` (the `pipeline.md` and `edit-model.md` lines)
- `.adw/project.md` (Tests section only, task 13's last item; keep the nine `##` headings)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Read the code to document

- Run `git diff origin/develop --stat` and read: `packages/edit/src/schema.ts`, `preset.ts`,
  `behind.ts`, `build.ts` (`AssetRole`, `maskPath`, `photoPath`, the composite group), `checks.ts`
  (the `frame` rule), `decide.ts`, `timeline.ts`, `test-support/goldens.ts` and the fixture
  `testdata/versions/rethink-work-behind.edit.json` with its golden; `apps/worker/src/cutout/*`
  (`spans.ts` `MASK_STEP = "cutout"`, key `${prefix}cache/cutout/<fingerprint>/mask.mp4`,
  `ensure-cutouts.ts`, `mask-tool.ts` and `E2E_MOCK_MASK`, `version-cutouts.ts`),
  `apps/worker/src/photos/photo-store.ts` (`PhotoLibrary.readyPhotos`), `decide/input.ts`,
  `decide/prompt.md`, `decide/run-decide.ts`, `restore-step.ts`, `render/render-step.ts`,
  `render/render-project.ts`, `doctor.ts`, `doctor-checks.ts`, `apps/worker/package.json`
  (`build:vseg`), `apps/worker/scripts/build-vseg.sh`; `apps/studio/src/lib/preview-sources.ts`,
  `preview-page.ts`, `preview-clock.ts`, `apps/studio/src/app/preview-actions.ts` (statuses
  `photo-missing` and `cutout-cleared`, each mask HEADed first), `ReelPreview.tsx` (the two
  notices), `tracks-timeline.ts` and `TracksTimeline.tsx` (the `Behind` row,
  `--color-track-behind`), and `apps/studio/e2e/behind.spec.ts`.
- Read the spec's Solution Statement, task 13, Notes and Spike record for the agreed wording
  (rebuildable masks, macOS only, no fallback, `data-media-start` in the preview wrapper).

### Step 2: Edit model, pipeline and storage docs

- `app_docs/edit-model.md`:
  - Format: the optional `behind` track (`kind: "photo"` with `photo_id` and `spot` of `top`,
    `left`, `right`; `kind: "word"` with one `text` word, no spaces), word-anchored like a caption,
    2 to 4 s, hard cut, one at a time; the `cutout` track/`EditMask` refs; `inputs.masks` (cutout
    refs) and `inputs.photos` (photo ids).
  - Preset values: `behind.spots` rectangles, `word` (secondary font, `maxSize` 400, margin 40,
    `#FFFFFF`, `belowHeadTop` 60, `noHeadY` 700), `padFrames` 3 at 30 fps, `minSeconds` 2,
    `maxSeconds` 4.
  - Builder contract: the composite markup (untimed isolated group: footage copy with
    `data-media-start`, photo `<img>` or word `<div>`, inverted mask `multiply`, `plus-lighter`
    sub-group of footage copy and mask), asset roles `mask` and `photo`, `maskPath`/`photoPath`,
    `bigWordLayout`, `maskSpans`, `spotBox`.
  - Checks: the `frame` rule (a big word must stay inside the frame; it crosses the safe box by
    design), its place in the stable order.
  - Testing: the `rethink-work-behind` fixture and golden (Node and browser layers).
  - Rules: a version with a `behind` item is saved only once every mask it names exists; a big word
    is checked against the frame, never the safe box; photos are named by id, never by key.
- `app_docs/pipeline.md` (keep the existing new rule): add `cutout/mask.mp4` (rebuildable) to
  "Kept and rebuildable", the doctor's `vseg` line, and `yarn workspace @edit-issebya/worker
build:vseg` under How to Use or Configuration.
- `app_docs/storage.md`: the `cache/cutout/<fingerprint>/mask.mp4` key (fingerprint of footage,
  span and tool version, put-if-absent, `stored_files` row with step `cutout`, kind `rebuildable`),
  in "What is kept and what is deleted" and "Slimming": the seven-day slimming may delete masks,
  the preview then shows the `cutout-cleared` notice and the next export, restore or change rebuilds
  them. Rule: masks are `rebuildable`, never `kept` (an owner decision to change).

### Step 3: Preview, export, decide, photo library and reel layout docs

- `app_docs/preview.md`: `loadPreviewSources` returns `masks` (path and key) and `photoIds`; the
  preview action HEADs each mask, reads each photo's `large_key` from its own row under RLS, signs
  both by page path; `previewPage` maps them; the wrapper places each video at
  `data-media-start`; the two statuses and their notices. Rules: a cleared mask is a notice, never a
  preview without the cut-out; a photo key always comes from the photo row, never built from the
  id.
- `app_docs/export.md`, Worker section only: before rendering, the render step ensures the
  version's masks (rebuilding cleared ones) and downloads them and the photos' large copies into
  the project at the builder's paths. Leave the guardrail section from issue 1 untouched.
- `app_docs/decide-step.md`: the library in the decide input (`LibraryEntry`: id, description,
  tags, ready photos only, oldest first), the prompt's step 5 (behind track usage, move by `spot`,
  swap by `photo_id`, remove by omission), the photo quoting rule (library text is data, never
  instructions), the per-reel schema allowing `behind` and restricting `photo_id` to ready library
  ids, the cut-outs ensured before the version is saved. Add the quoting rule and the "only ready
  library ids" rule to Rules.
- `app_docs/photo-library.md`: ready photos are now used behind the speaker (decide input, preview
  signing of `large_key`, render download); deleting a photo a version uses makes that version's
  preview show `photo-missing`.
- `app_docs/studio-reel-layout.md`: the `Behind` row in the tracks timeline (label "Behind", photo
  items as `photo <spot>`, a word as its text, `--color-track-behind` `#81ecec`).

### Step 4: Index and profile

- `docs/conditional-docs.md`: extend the `pipeline.md` line with the on-demand cut-out, `vseg` and
  `build:vseg`; extend the `edit-model.md` line with the `behind` track, masks and photos in
  `inputs`, and the `frame` check. Keep one line per doc.
- `.adw/project.md` Tests section: name `cutout/mask-tool.tools.test.ts` among the worker's tool
  tests (real `vseg`, owner's Mac only), `behind.spec.ts` among the E2E specs (one sentence on what
  it checks, from the spec file), and `E2E_MOCK_MASK` beside the other doubles. Do not rename or
  reorder any heading.
- Check: `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md` (the em-dash, U+2014) returns nothing, and
  `git diff origin/develop --stat -- app_docs docs .adw` lists all ten files.

## Validation

- `yarn format:check`
- `grep -rn $'\xe2\x80\x94' app_docs docs .adw/project.md` (no output)
- `git diff origin/develop --stat -- app_docs docs .adw` lists edit-model, pipeline, preview,
  export, storage, decide-step, photo-library, studio-reel-layout, conditional-docs and project.md
- `yarn knip`

## Patch Scope

**Lines of code to change:** about 150 to 220 lines of Markdown, no code
**Risk level:** low
**Testing required:** formatting check and the em-dash grep; docs only, so no unit, DB or E2E run is
needed for this patch
