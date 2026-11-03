# Feature: photos and one big word behind the speaker, with an on-demand Apple Vision cut-out

## Metadata

issue_number: `20`
adw_id: `182ee234`
issue_json: `{"number":20,"title":"feat: photos and one big word behind the speaker, with an on-demand Apple Vision cut-out of just those moments"}`

## Feature Description

A reel can today only stack captions, accents, transitions and sounds on top of the footage. This
feature adds a `behind` track to the edit format: a library photo or one huge word placed behind the
speaker, so the speaker's head and body overlap it. Each `behind` item is anchored to words like a
caption, lasts 2 to 4 seconds, and cuts in and out hard (no fade, no slide).

The speaker is kept in front by a cut-out made only for those moments: a small Swift command-line
tool (`vseg`) runs Apple Vision person segmentation at `accurate` quality over the padded span and
writes a grayscale H.264 mask (white = person) at the footage's size and frame timing. The worker
makes a mask for every span not already stored (fingerprinted by footage, span and tool version),
stores it put-if-absent as a `rebuildable` output, records it in `stored_files`, and names it in the
version's `inputs`. A version is saved (and so shown) only once its masks exist.

The one shared builder (`packages/edit`, `build`) draws the photo or word between the footage and
the speaker by compositing the footage and the mask in the page with plain `<video>` elements and
CSS blending, so the live preview (`@hyperframes/player`) and the export (HyperFrames render) show
the same frames. A change request can add, move, swap or remove a `behind` item and change the big
word.

## User Story

As the studio owner (issebya)
I want to put a library photo or one big word behind myself for a few seconds of a reel
So that the reel has depth (me in front of the picture or the word) without a 7-minute whole-clip
cut-out or a 53 MB alpha video that Safari cannot play

## Problem Statement

Everything the builder places sits on top of the footage. Putting something behind the speaker
needs a per-frame matte of the person. The old matte (HyperFrames' u2net over the whole clip, VP9
alpha WebM) took about 7 minutes per 47.5 s clip, was never used and was removed in #94. The owner
has decided what may go behind (library photos, one huge word), where (three preset spots), how
(hard cuts anchored to words) and how the matte is made (Apple Vision accurate, grayscale H.264,
only for those moments, saved and reused). The preview and the export must still match frame for
frame (`app_docs/export.md`, the preview-matches-export guardrail).

## Solution Statement

1. **Edit format** (`packages/edit`): an optional `behind` track (stored versions without it still
   parse; the builder treats a missing track as empty) with two kinds, `photo` (`photo_id`, `spot`:
   `top | left | right`) and `word` (`text`, one word). Refinement: 2 to 4 seconds long, no two
   `behind` items overlap in time, no overlap with a footage `hidden` span. Optional
   `inputs.masks` (one `{ step: "cutout", fingerprint, file: "mask.mp4", start, end }` per merged
   padded span) and `inputs.photos` (the photo ids the track names, sorted). The preset gets
   `behind`: the three spot rectangles, the big word's font, maximum size, side margin, colour and
   its place relative to the head, and the mask padding in frames.
2. **Mask tool**: `apps/worker/tools/vseg/vseg.swift` (from the owner's prototype on the issue),
   built by `yarn workspace @edit-issebya/worker build:vseg` with `swiftc` into the gitignored
   `apps/worker/tools/vseg/.build/vseg`. `vseg --input <mp4> --start <s> --end <s> --output <mp4>`:
   `VNGeneratePersonSegmentationRequest`, `qualityLevel = .accurate`, each mask scaled to the
   footage's natural size, written as H.264 through `AVAssetWriter` (VideoToolbox) with the source
   sample times shifted to start at 0. On any OS but macOS the worker refuses before spawning with
   one line.
3. **Cut-out step** (`apps/worker/src/cutout/`): `ensureCutouts` computes the merged padded spans of
   an edit's `behind` items, fingerprints each, HEADs each key, and for the missing ones runs `vseg`
   (or the `E2E_MOCK_MASK` double) in one measured `cutout` step row, uploading put-if-absent; all
   present is a hit (`cut-out reused`). It returns the edit with `inputs.masks` and `inputs.photos`
   filled. It runs before every save of a version with `behind` items (decide, restore) and in the
   render's `ensureInputs` (rebuilding a slimmed mask).
4. **Builder**: per mask span, one isolated full-frame group above the footage and below
   transitions and text: a footage copy, the active `behind` items, the mask inverted and
   multiplied (gives `(footage with item) x (1 - mask)`), and an isolated sub-group with a second
   footage copy and the mask multiplied, blended `plus-lighter` (adds `footage x mask`). Every layer
   is a plain timed `<video>`, `<img>` or `<div>`, so HyperFrames drives it in the player and its
   render frame injector (which copies `filter` and `mix-blend-mode` onto the injected frame
   `<img>`, verified in `hyperframes` 0.8.222's `MEDIA_VISUAL_STYLE_PROPERTIES`) reproduces it in the
   export. This candidate is **spiked first** (see Phase 1); if it is not frame-accurate in the
   export, the run stops and says so in the PR.
5. **Preview and export** load masks and photos: the studio signs the masks' cache keys (after a
   HEAD; a mask cleared by the slimming shows a one-line notice instead of a preview that differs
   from the export) and each photo's `large_key` read under RLS; the render downloads both into the
   project.
6. **Corrections**: the decide answer schema includes the `behind` track, with `photo_id` limited
   to the owner's `ready` library photos, which the decide input lists (id, description, tags),
   quoted as data.
7. **Doctor**: `mask tool` check builds `vseg` and runs it on a 1-second sample.
8. **Docs**: `edit-model.md`, `preview.md`, `export.md`, `pipeline.md` (the on-demand rule replaces
   "No background removal step until #20"), `storage.md`, plus `decide-step.md`,
   `photo-library.md` and the index.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: conventions, commands, the Tests and Protected
  sections (worker never started by a run, `test:tools` only on the owner's Mac, no em-dashes).
- `docs/conditional-docs.md`: index; add or update lines for the touched docs.
- `app_docs/pipeline.md`: fingerprints, `kept`/`rebuildable`, `RETIRED_OUTPUTS`, the rule
  "No background removal step until #20" to replace, `test:tools`, doctor lines.
- `app_docs/edit-model.md`: format, preset values, builder contract, checks, goldens, rules (one
  builder, never store a page, nothing platform-specific in `packages/edit`).
- `app_docs/preview.md`: player wrapper rules (never patch the player; transform only swaps URLs,
  adds `preload`, drops sound clips), `loadPreviewSources`, `previewPage`, `canPlayFrom`.
- `app_docs/export.md`: render step, `render-project.ts`, the guardrail and its SSIM bound rules.
- `app_docs/storage.md`: `classifyKey`, `recordingStorage`, slimming of `rebuildable` files.
- `app_docs/decide-step.md`, `app_docs/change-requests.md`: decide schema, input, prompt
  versioning, change jobs.
- `app_docs/photo-library.md`: `photos` table, `large_key`, quoting rule, delete behaviour.
- `app_docs/studio-reel-layout.md`: the read-only tracks timeline (`tracks-timeline.ts`).
- `app_docs/measurement.md`, `app_docs/status.md`: step rows, progress parsers (if `vseg` prints
  progress).
- `packages/edit/src/schema.ts`: `tracksSchemaFor`, `editInputsSchema`, `refineEdit`, types.
- `packages/edit/src/preset.ts`: `Preset`, `ISSEBYA_PRESET`.
- `packages/edit/src/build.ts`, `html.ts`, `layout.ts`, `measure.ts`: page assembly, assets,
  measuring the big word.
- `packages/edit/src/timeline.ts`: `resolveTimeline` must include `behind` items.
- `packages/edit/src/checks.ts`: `safe-box` must skip big words; add their frame check.
- `packages/edit/src/decide.ts`: answer schema (`omit({ cutout })`), `editFromAnswer`,
  `decideCounts`, `usedFreeField`.
- `packages/edit/src/index.ts`: exports.
- `packages/edit/src/build.test.ts`, `build.browser.test.ts`, `schema.test.ts`,
  `timeline.test.ts`, `checks.test.ts`, `decide.test.ts`, `test-support/fixtures.ts`,
  `testdata/versions/`, `testdata/golden/`, `scripts/golden.ts`.
- `apps/worker/src/decide/run-decide.ts`, `input.ts`, `prompt.md`, `prompt.ts`
  (`PROMPT_VERSION`), `run-decide.test.ts`, `prompt.test.ts`.
- `apps/worker/src/restore-step.ts`, `restore-step.test.ts`: restore copies inputs; must ensure
  the old version's masks exist first.
- `apps/worker/src/render/render-step.ts`, `render-project.ts`, `render-step.test.ts`,
  `render-project.test.ts`, `render.tools.test.ts`.
- `apps/worker/src/process-job.ts`: wiring of decide, restore, render.
- `apps/worker/src/pipeline/definition.ts` (`retentionOf`, `RETIRED_OUTPUTS`),
  `fingerprint.ts` (`fingerprint`, `cacheKey`), `tools.ts` (`toolPaths`), `step-runner.ts`
  (`runToolsStep`, `recordHit`), `pipeline/step-double.ts` (pattern for a double).
- `apps/worker/src/stored-files.ts`: `classifyKey` must accept `cache/cutout/<fp>/mask.mp4`.
- `apps/worker/src/photos/photo-store.ts`: add reads of ready photos for decide and render.
- `apps/worker/src/doctor-checks.ts`, `doctor.ts`, `doctor-checks.test.ts`.
- `apps/worker/package.json`, `vitest.tools.config.ts`, `.gitignore`, `knip.json`.
- `apps/studio/src/app/preview-actions.ts`, `src/lib/preview-sources.ts`,
  `src/lib/preview-page.ts`, `src/components/ReelPreview.tsx`, `src/components/PreviewPlayer.tsx`
  and their tests.
- `apps/studio/src/lib/tracks-timeline.ts`, `src/components/TracksTimeline.tsx`: a `Behind` row.
- `apps/studio/test-support/worker.ts` (sets every `E2E_MOCK_*` for spawned `once`),
  `ai-script.ts`, `versions.ts`, `pipeline-cache.ts`, `fixtures.ts`.
- `apps/studio/e2e/change-requests.spec.ts`, `photo-library.spec.ts`, `preview.spec.ts`: models
  for the new spec.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: the guardrail to extend.
- `turbo.json`: `E2E_MOCK_*` is already passed through; no change expected.
- `node_modules/hyperframes/dist/skills/hyperframes/references/format.md` and `runtimes.md`:
  `data-media-start`, `muted`, nested clip timing, the seek protocol.
- `node_modules/hyperframes/dist/chunk-AIXH3V5A.js` (`injectResolvedVideoFramesBatch`) and
  `chunk-BDZSH6P3.js` (`MEDIA_VISUAL_STYLE_PROPERTIES`): what the render copies onto injected
  frames. Read only, never patched.

### New Files

- `apps/worker/tools/vseg/vseg.swift`: the mask tool (from the owner's prototype).
- `apps/worker/scripts/build-vseg.sh`: `swiftc -O` into `tools/vseg/.build/vseg`; one-line refusal
  off macOS.
- `apps/worker/src/cutout/spans.ts` and `spans.test.ts`: merged padded spans, frame snapping,
  fingerprints, `cutoutKey`.
- `apps/worker/src/cutout/mask-tool.ts` and `mask-tool.test.ts`: the `vseg` call, the platform
  refusal, the `E2E_MOCK_MASK` double, the source hash guard.
- `apps/worker/src/cutout/ensure-cutouts.ts` and `ensure-cutouts.test.ts`: the `cutout` step.
- `apps/worker/src/cutout/mask-tool.tools.test.ts`: real `vseg` on `fixtures/footage/short-person.mp4`
  (read only), owner's Mac.
- `packages/edit/src/behind.ts` and `behind.test.ts`: spot and big-word layout, the composite
  markup helpers used by `build.ts`.
- `packages/edit/src/testdata/versions/rethink-work-behind.edit.json` and its goldens under
  `packages/edit/src/testdata/golden/`.
- `apps/studio/test-support/photos.ts`: `seedReadyPhoto` (row and its `large.jpg` from
  `fixtures/photos/sample.jpg` in the storage mock).
- `apps/studio/e2e/behind.spec.ts`: the E2E for a correction adding a photo behind the speaker.

## Implementation Plan

### Phase 1: Foundation

- **Spike the composite first**, before any schema work lands, and record the result in this
  plan's `Spike record` section (append it; it ships in the PR). Build a throwaway HyperFrames
  project by hand under the job scratch (never committed) from `fixtures/footage/short-person.mp4`
  (read only), a mask made by `vseg` (or, before `vseg` exists, an ffmpeg-made test mask such as a
  white ellipse), `fixtures/photos/sample.jpg` and one word:
  - Candidate A (primary): the CSS blend composite in the Solution Statement, all layers plain
    timed elements, no script. Check in the player (Chrome, the studio's `PreviewPlayer` or a bare
    `<hyperframes-player>` page) and with `hyperframes render`: grab the same frames (span start,
    middle, last frame) from both and compare by SSIM and by a pixel diff inside the photo
    rectangle. Also check HyperFrames lint does not fail (`video_nested_in_timed_element`,
    `video_missing_muted`): mask and footage copies are `muted playsinline`, the footage copies
    take `data-media-start` equal to their `data-start`.
  - Candidate B (fallback): a `<canvas>` composite drawn from `hf-seek` (`e.detail.time`, the
    documented seek protocol) reading the footage and mask `<video>` elements. Known risk: the
    render replaces each `<video>` with an injected `<img class="__render_frame__">` after the
    seek, so the canvas may draw the previous frame. Only try it if A fails.
  - Candidate C (recorded, not built): CSS `mask-image` on the footage copy cannot take a video
    source; SVG `<mask>` with a video is not supported by Chrome's compositor.
  - If no candidate is frame-accurate in the export, stop: do not ship a preview that differs from
    the export; write the findings in the PR body and the `Spike record`.
- Port the owner's `vseg.swift` prototype and its build script, so the spike uses the real mask.
- Edit format and preset additions with their tests (schema accepts old versions, refuses bad
  `behind` items).

### Phase 2: Core Implementation

- `packages/edit`: `behind.ts` (spot rectangles, big-word size and place from HarfBuzz widths and
  the head track), `build.ts` composite markup, new asset roles `mask` and `photo`, timeline,
  checks, decide schema, the fixture version and goldens (Node and browser).
- `apps/worker`: `cutout/` (spans, fingerprints, tool call, double, `ensureCutouts`), photo reads,
  decide (library in the input, `ensureCutouts` before save, step line), restore (ensure masks
  before the copy), render (ensure masks, download masks and photos, place them in the project),
  `classifyKey`, doctor check.

### Phase 3: Integration

- Studio: `loadPreviewSources` signs masks (after HEAD) and photos (RLS read of `large_key`),
  `previewPage` swaps their paths, `ReelPreview` passes them through, the tracks timeline shows a
  `Behind` row.
- Test support: `E2E_MOCK_MASK=true` for every spawned `once`, `seedReadyPhoto`, an AI script with a
  `behind` photo.
- E2E spec, guardrail extension, tools tests, docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/edit-model.md`, `preview.md`, `export.md`, `pipeline.md`, `storage.md`,
  `decide-step.md`, `photo-library.md`, `studio-reel-layout.md`, and their Rules sections (each "do
  not" and "never" is an invariant).
- Read `node_modules/hyperframes/dist/skills/hyperframes/references/format.md` (media attributes,
  nested clip timing, lint opt-outs) and `runtimes.md` (seek protocol).
- Read the owner's prototype `vseg.swift` linked or attached on issue #20 (`gh issue view 20`); if
  it is not attached, write the tool from the contract in task 2 and say so in the PR.

### 2. Mask tool `vseg` (Swift) and its build

- Create `apps/worker/tools/vseg/vseg.swift`: arguments `--input`, `--start`, `--end`, `--output`
  (seconds, three decimals). Read with `AVAssetReader` over `[start, end)` using the track's own
  sample times; per frame run `VNGeneratePersonSegmentationRequest` with
  `qualityLevel = .accurate` and `outputPixelFormat = kCVPixelFormatType_OneComponent8`; scale the
  mask to the footage's natural size (Core Image, `CILanczosScaleTransform` or
  `CIAffineTransform`); write a `420v` pixel buffer with Y = mask and CbCr = 128 through
  `AVAssetWriter` (`AVVideoCodecType.h264`, VideoToolbox), each frame at its source presentation
  time minus `start`. Print `vseg: frame <i>/<n>` lines on stderr for progress and exit non-zero
  with a one-line reason on any failure. Write to `<output>.part`, rename after success.
- Create `apps/worker/scripts/build-vseg.sh`: on `uname` other than `Darwin` print
  `vseg: the mask tool builds on macOS only (Apple Vision)` and exit 1; else
  `swiftc -O tools/vseg/vseg.swift -o tools/vseg/.build/vseg`.
- `apps/worker/package.json`: `"build:vseg": "bash scripts/build-vseg.sh"`.
- `.gitignore`: `apps/worker/tools/vseg/.build/`.
- `knip.json`: make sure the script and the Swift folder raise no unused-file finding.

### 3. Spike the composite and record it

- Do Phase 1's spike with the built `vseg` on `fixtures/footage/short-person.mp4` (3 s span).
- Append a `## Spike record` section at the end of this plan file: what was built, the commands,
  the per-frame scores (preview against export) for each candidate tried, and the decision.
- If no candidate passes, stop here (see Phase 1) and report in the PR.

### 4. Preset

- `packages/edit/src/preset.ts`: add to `Preset`
  `behind: { spots: Record<BehindSpot, Box>; word: { font: FontKey; maxSize: number; margin: number; color: string; belowHeadTop: number; noHeadY: number }; padFrames: number; frameRate: number; minSeconds: number; maxSeconds: number }`
  with `BehindSpot = "top" | "left" | "right"` and `BEHIND_SPOTS`.
- `ISSEBYA_PRESET.behind` starting values (owner tunes them by eye after merge):
  `top` `{ left: 90, right: 990, top: 160, bottom: 760 }`, `left`
  `{ left: 40, right: 500, top: 560, bottom: 1180 }`, `right`
  `{ left: 580, right: 1040, top: 560, bottom: 1180 }`; word `font: "secondary"` (Golos Text
  Bold, solid), `maxSize: 400`, `margin: 40` (frame side margin), `color: "#FFFFFF"`,
  `belowHeadTop: 60` (word's vertical centre below the head top, so the head overlaps it),
  `noHeadY: 700`; `padFrames: 3`, `frameRate: 30`, `minSeconds: 2`, `maxSeconds: 4`.
- Export `BehindSpot`, `BEHIND_SPOTS` from `index.ts`.

### 5. Edit format

- `packages/edit/src/schema.ts`:
  - `editInputsSchema`: add optional `masks: z.array(refSchema.extend({ step: z.literal("cutout"), start: z.number().min(0), end: z.number().positive() }))`
    and optional `photos: z.array(z.uuid())`.
  - `EditLimits`: add optional `photoIds?: readonly string[]`. `tracksSchemaFor`: a `behind`
    track, optional, a discriminated union on `kind`: `photo` `{ ...base, kind: "photo",
photo_id, spot: z.enum(BEHIND_SPOTS) }` and `word` `{ ...base, kind: "word", text:
z.string().regex(/^[^\s<>&]{1,24}$/) }`. `photo_id` is `z.enum(photoIds)` when `photoIds` is
    given (empty list: `z.never()`, as for words), else `z.uuid()`. Base keeps `style`.
  - `refineEdit`: include `behind` items in the id and order checks; a `behind` item resolving to
    under `minSeconds` or over `maxSeconds` (2 to 4 s) is refused with a reason; two `behind` items
    overlapping in time are refused; a `behind` item overlapping a footage `hidden` span is
    refused.
  - Types: `BehindItem`, `BehindPhotoItem`, `BehindWordItem`, `EditMask`.
- `packages/edit/src/timeline.ts`: include `tracks.behind ?? []` in `resolveTimeline`.
- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor(preset, transcript, duration, photoIds)`
  and `decideJsonSchema(..., photoIds)` pass `photoIds` in the limits; keep `.omit({ cutout: true
})`; `editFromAnswer` passes `behind` through (and drops `inputs.masks`/`inputs.photos` from the
  current version, which `ensureCutouts` recomputes); `decideCounts` adds `behindPhotos` and
  `behindWords`; `usedFreeField` includes `behind`.
- Tests (`schema.test.ts`, `decide.test.ts`, `timeline.test.ts`): a stored version without
  `behind` and without `inputs.masks` parses; a valid photo item and word item parse; a 1.5 s and a
  4.5 s item are refused; two overlapping items are refused; two words (`"big word"`) refused; a
  photo id outside `photoIds` refused by the decide schema and by its JSON Schema `enum`; an unknown
  spot refused; the JSON Schema conversion still works.

### 6. Builder

- `packages/edit/src/behind.ts`:
  - `spotBox(spot, preset)`.
  - `bigWordLayout(item, span, headTrack, preset, measurer)`: measure at 1 px with the preset font,
    size `= min(maxSize, (frame.width - 2 * margin) / width1px)` rounded down to an integer, x
    centred, vertical centre at `headTop(span.start) + belowHeadTop` (the head sample at the item's
    start, as `layout.ts` reads it) or `noHeadY`; records its width with the measurer, so goldens
    cover it.
  - `maskSpans(edit, transcript, preset)`: pure, shared by the builder and the worker: each
    `behind` item's span padded by `padFrames / frameRate` each side, clamped to `[0, duration]`,
    snapped outward to the frame grid, overlapping or touching spans merged, sorted. The worker's
    fingerprints and the builder's markup both come from it, so they always agree.
- `packages/edit/src/build.ts`:
  - `AssetRole` adds `"mask"` and `"photo"`; `BuildAsset.ref` stays the producer for masks (`step
"cutout"`), null for photos, with `photoId` on photo assets. Mask path
    `masks/<fingerprint>.mp4`, photo path `photos/<photo_id>.jpg` (inside the project, no `..`).
  - A version with `behind` items whose `inputs.masks` does not cover every span from `maskSpans`
    throws `build: behind item <id> has no cut-out`; the worker always fills them before saving.
  - Markup per mask span, after the footage clips and before the transitions (paint order by DOM
    order and `z-index`, as the spike settled): the group described in the Solution Statement, or
    whatever the spike's `Spike record` chose. Photos are `<img class="clip">` with `object-fit:
cover` exactly filling the spot rectangle, no radius, border or shadow; words are a `<div
class="clip f-<font>">` with the measured size and colour, `line-height: 1`, `white-space:
nowrap`. Each item's own `data-start` and `data-duration` give the hard cut; no GSAP tween.
  - `assetsOf` adds the masks and photos, still sorted.
- `packages/edit/src/checks.ts`: `safe-box` skips big words (they cross the frame by design); a new
  rule `frame` refuses a big word whose box leaves the frame; a `face` check does not apply to
  `behind` items.
- Fixture and goldens: add `src/testdata/versions/rethink-work-behind.edit.json` (the
  `rethink-work` transcript and real head track, one `top` photo and one big word, with
  `inputs.masks` and `inputs.photos` filled with fixed fake fingerprints and a fixed photo UUID),
  register it in `src/test-support/fixtures.ts`, run `yarn workspace @edit-issebya/edit golden` and
  commit what it writes. The existing goldens must stay byte-identical (a version without `behind`
  builds exactly as before).
- Tests: `behind.test.ts` (spot boxes, big-word size and centre with and without a head,
  `maskSpans` padding, clamping, merging, frame snapping), `build.test.ts` and
  `build.browser.test.ts` cover the new fixture against its golden byte for byte, `checks.test.ts`
  (`frame` rule, `safe-box` skipping words), and the missing-mask throw.

### 7. Worker: cut-out spans and the mask tool

- `apps/worker/src/cutout/spans.ts`: `MASK_STEP = "cutout"`, `MASK_FILE = "mask.mp4"`,
  `maskFingerprint(footageRef, span)` = `fingerprint({ inputs: { footage: footageRef }, settings: {
start, end, quality: "accurate", format: "h264-gray" }, version: MASK_TOOL_VERSION })` with the
  pipeline's `fingerprint.ts`; `cutoutKey(prefix, fp)` through `cacheKey`.
- `apps/worker/src/pipeline/definition.ts`: an `ON_DEMAND_OUTPUTS` list with `{ step: "cutout",
file: "mask.mp4", retention: "rebuildable" }`, read by `retentionOf`, so `classifyKey` gives
  `rebuildable`, step `cutout`.
- `apps/worker/src/cutout/mask-tool.ts`:
  - `MASK_TOOL_VERSION` (1) and `MASK_TOOL_SOURCE_SHA256` (the SHA-256 of `vseg.swift`);
    `mask-tool.test.ts` hashes the committed Swift file and fails when it differs, telling the
    developer to bump the version and the hash together.
  - `maskToolCall({ binary, input, start, end, output })`: the argument list.
  - `maskToolPath()`: `apps/worker/tools/vseg/.build/vseg`; on `process.platform !== "darwin"`
    throws `cutout: the mask tool runs on macOS only (Apple Vision); this worker runs on
<platform>`; a missing binary throws `cutout: mask tool not built, run yarn workspace
@edit-issebya/worker build:vseg`. No fallback to another model.
  - The double: only when `E2E_MOCK_MASK` is exactly `"true"`, the call becomes ffmpeg
    `-f lavfi -i color=c=black:s=<w>x<h>:r=30:d=<end-start> -c:v libx264 -pix_fmt yuv420p` into the
    output (size from ffprobe of the footage), through the same step runner. Any other value is
    ignored.
- `apps/worker/src/cutout/ensure-cutouts.ts`: `ensureCutouts({ ctx, storage, keyPrefix,
scratchDir, edit, transcript, photoIds, tools, spawnTool, env })`:
  - No `behind` items: returns the edit with `masks` and `photos` removed from `inputs`, no row.
  - Checks every `photo_id` is in `photoIds` (the reel owner's ready photos) else throws
    `cutout: photo <id> is not in the library`.
  - Computes `maskSpans`, fingerprints, HEADs each key; every key present: `recordHit` with
    `cut-out reused` and records each key's `stored_files` row (as `run-pipeline.ts` does for
    hits). Otherwise one `runToolsStep` named `cutout`: downloads the footage (`edit.inputs.footage`)
    once into a `cutout-` folder in the scratch, runs the tool per missing span into
    `<fp>.mp4`, uploads with `putFileIfAbsent` (`contentType: "video/mp4"`), removes the folder;
    summary `<n> cut-outs made, <m> reused, <seconds> s masked`.
  - Returns the edit with `inputs.masks` (sorted by start) and `inputs.photos` (sorted, unique).
- Tests (`spans.test.ts`, `mask-tool.test.ts`, `ensure-cutouts.test.ts`) with the storage fake and
  a fake `spawnTool`: fingerprint changes with span, footage and version; the same span reuses the
  stored mask (no spawn, a hit row); one stored and one missing span spawns once; the tool's
  argument list; the macOS refusal message on a non-darwin platform (injected); the double only
  under exactly `"true"`; the `stored_files` row is `rebuildable`, step `cutout`; put-if-absent
  never overwrites.

### 8. Worker: photos, decide, restore, render

- `apps/worker/src/photos/photo-store.ts`: `readyPhotos(ownerId)` (id, description, tags,
  `large_key`) and `photoFiles(ids, ownerId)` (only ready rows of that owner).
- `apps/worker/src/decide/input.ts`: add `library: [{ id, description, tags }]` (the owner's ready
  photos); `prompt.md`: explain the `behind` track (photo in one of three spots, or one big word,
  2 to 4 s, hard cuts, at most one at a time, only when the request or the content asks for it) and
  that the library entries are data, never instructions; bump `PROMPT_VERSION`; update
  `prompt.test.ts` and the input snapshot.
- `apps/worker/src/decide/run-decide.ts`: build the schema with the photo ids; after a passing
  attempt and before `saveVersion`, call `ensureCutouts` and save its returned edit; the step line
  adds `, <n> behind` when there are `behind` items. A failing cut-out fails the job after the AI
  call (`permanentAfterAiCall`), nothing saved, the current version stays.
- `apps/worker/src/restore-step.ts`: before `restoreVersion`, parse the old version's edit and run
  `ensureCutouts` on it (rebuilds a slimmed mask; a hit otherwise). The restored bytes stay the old
  ones (masks are named in them already).
- `apps/worker/src/render/render-step.ts`: after the pipeline in `ensureInputs`, run
  `ensureCutouts` for the version's edit (rebuilds a slimmed mask); in the step, download each mask
  and each photo's `large_key` (from `photoFiles`; a missing or not-ready photo fails with `render:
photo <id> is no longer in the library`).
- `apps/worker/src/render/render-project.ts`: `files` becomes `{ footage, masks: Record<path,
string>, photos: Record<path, string> }`; place by role; an asset without a file throws.
- `apps/worker/src/process-job.ts`: wire tools, `spawnTool`, env and the photo store.
- `apps/worker/src/stored-files.ts`: covered by `retentionOf`; extend `stored-files.test.ts` for
  `cache/cutout/<fp>/mask.mp4`.
- Tests: `run-decide.test.ts` (a `behind` answer makes masks before the save, the saved inputs name
  them, a mask failure saves nothing), `restore-step.test.ts` (a missing mask is rebuilt before the
  copy), `render-step.test.ts` and `render-project.test.ts` (masks and photos placed, a deleted
  photo fails with its line), `decide/prompt.test.ts`.

### 9. Doctor

- `apps/worker/src/doctor-checks.ts`: `mask tool` check: on non-macOS the one-line refusal; else
  run `build:vseg`, then `vseg` on `fixtures/footage/short-speech.mp4` from 0 to 1 s into a temp
  file, ffprobe it (H.264, the footage's width and height, 30 frames give or take one), delete it.
  Line `mask tool: vseg built, 1 s masked in <x> s`.
- `doctor-checks.test.ts`: the check's lines with a fake build and tool (pass, build failure,
  wrong size, non-darwin).
- Pipeline doc's doctor list gets the new line.

### 10. Studio: preview sources, page and timeline

- `apps/studio/src/lib/preview-sources.ts`: `PreviewKeys` adds `masks: { path, key }[]` (from
  `inputs.masks`, step `cutout`, validated like other cache keys) and `photoIds` (from
  `inputs.photos`, UUIDs only); an `inputs` value without them gives empty lists.
- `apps/studio/src/app/preview-actions.ts`: read `photos` (`id, large_key, status`) for those ids
  under RLS (only the owner's rows come back); a missing or not-ready one returns
  `photo-missing`; HEAD each mask key and return `cutout-cleared` when one is gone; sign the masks
  and each photo's `large_key` (from the row, never built from the id); return `masks` and `photos`
  as `{ path, url }[]`.
- `apps/studio/src/lib/preview-page.ts`: `urls` adds `masks` and `photos` (path to URL); a `mask`
  asset swaps ` src="<path>"` on `<video ` lines (adding `preload="auto"`), a `photo` asset on
  `<img ` lines; throws when the page lacks the element. Nothing else changes.
- `apps/studio/src/components/ReelPreview.tsx`: pass them through; show `A photo in this version was
deleted from the library.` for `photo-missing` and `This version's cut-out was cleared to save
space; Export rebuilds it.` for `cutout-cleared`.
- `PreviewPlayer.tsx` needs no change: `canPlayFrom` already waits for every active `<video>`,
  masks and footage copies included. Confirm in the E2E.
- `apps/studio/src/lib/tracks-timeline.ts` and `TracksTimeline.tsx`: a `Behind` row (label: the
  spot for a photo, the word for a word) with its own colour token.
- Unit tests: `preview-sources.test.ts`, `preview-page.test.ts` (mask and photo swaps, missing
  element throws), `tracks-timeline.test.ts`.

### 11. E2E test support and spec

- `apps/studio/test-support/worker.ts`: add `E2E_MOCK_MASK: "true"` for every spawned `once`.
- `apps/studio/test-support/photos.ts`: `seedReadyPhoto(owner)`: inserts a `ready` photo row with
  description and tags and `large_key`, writes `fixtures/photos/sample.jpg` at that key in
  `.e2e-storage/`, returns the id.
- `apps/studio/test-support/ai-script.ts`: `behindPhotoAnswerScript(dir, photoId, spot)`: the
  baseline tracks plus one `behind` photo item from `w0001` start to `w0010` end (about 2.6 s on the
  fixture clip).
- `apps/studio/e2e/behind.spec.ts` (model on `change-requests.spec.ts` and `preview.spec.ts`,
  1440x900): seed a processed reel and a ready photo, script the answer, send a change through the
  change box, run the worker's `once`, then:
  - version 3 becomes current live; its `inputs.masks` has one entry and `inputs.photos` the
    photo id; the job's step rows include `cutout` with `1 cut-outs made` (or the exact summary
    chosen) and a `stored_files` row `rebuildable`, step `cutout`, for the mask key;
  - in the preview frame, at a seek inside the span, the `<img>` of the item is visible, its `src`
    is a signed URL of the photo's `large_key`, and its box (relative to the composition root,
    scaled by the frame) equals the `left` spot rectangle; outside the span it is not shown;
  - the `Behind` row in the tracks timeline shows one item.
    This spec fails without the feature (no `behind` track, no cut-out row, no image).

### 12. Tools tests (owner's Mac)

- `apps/worker/src/cutout/mask-tool.tools.test.ts`: build `vseg`, mask a 3-second span of
  `fixtures/footage/short-person.mp4` (read only, never modified): H.264, the source's size, the
  span's frame count, within 15 s, a mean mask value inside the head box above 200 and in a corner
  below 30.
- `apps/worker/src/render/render.tools.test.ts`: a version with one photo and one big word renders
  (real HyperFrames, real mask).
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: add a version with one `top` photo and
  one big word; score frames inside both spans at or above `PREVIEW_EXPORT_SSIM_BOUND` (0.982),
  with a probe (the photo moved by 60 px) scoring at least one frame below it. Do not change the
  bound; record the scores in `app_docs/export.md`.

### 13. Documentation

- `app_docs/edit-model.md`: the `behind` track, `inputs.masks`/`inputs.photos`, preset `behind`
  values, the composite markup, asset roles, the `frame` check, the new fixture, rules (masks
  required for a `behind` item).
- `app_docs/pipeline.md`: replace the rule "No background removal step until #20; ..." with: "The
  cut-out is made on demand, only for the padded spans of `behind` items, by `vseg` (Apple Vision
  `accurate`, grayscale H.264, macOS only, no fallback), fingerprinted by footage, span and tool
  version, stored put-if-absent as `rebuildable` and reused by later versions. `head_track` still
  makes its own sampled u2net mask and never stores it." Add `cutout/mask.mp4` to Kept and
  rebuildable, the doctor line and `build:vseg`.
- `app_docs/preview.md`: masks and photos in `loadPreviewSources` and `previewPage`, the two new
  statuses.
- `app_docs/export.md`: render downloads masks and photos; the guardrail's new case and scores.
- `app_docs/storage.md`: the `cutout` key layout and its slimming (rebuilt by the next export,
  restore or change).
- `app_docs/decide-step.md`, `app_docs/photo-library.md`, `app_docs/studio-reel-layout.md`: the
  library in the decide input, photos now used behind the speaker, the `Behind` row.
- `docs/conditional-docs.md`: update the `pipeline.md` and `edit-model.md` lines to mention the
  cut-out, `vseg` and the `behind` track.
- `.adw/project.md` Tests section: name `cutout/mask-tool.tools.test.ts` among the worker's tool
  tests and `behind.spec.ts` among the E2E specs; `E2E_MOCK_MASK` beside the other doubles. Keep the
  nine headings.
- No em-dashes anywhere.

### 14. Validation

- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `packages/edit`: schema (old versions parse, `behind` items valid and refused cases, photo id
  enum in decide), timeline, `behind.ts` layout and `maskSpans`, checks (`frame`, `safe-box`
  skip), builder goldens with and without `behind` in Node and in the browser project, the missing
  mask throw.
- `apps/worker`: spans and fingerprints, the tool call and its macOS refusal and double, the
  source-hash guard, `ensureCutouts` reuse and partial rebuild, `classifyKey`, decide (masks before
  the save, nothing saved on failure, library in the input), restore and render (masks ensured,
  photos placed), doctor check.
- `apps/studio`: `preview-sources`, `preview-page`, `tracks-timeline`.

### Test Coverage

- Unit, `packages/edit/src/build.test.ts` + `build.browser.test.ts`: the `rethink-work-behind`
  golden catches any divergence between Node and browser builds of the composite and any change to
  the existing goldens.
- Unit, `packages/edit/src/schema.test.ts` / `decide.test.ts`: catches `behind` items outside 2 to
  4 s, overlapping, with a photo outside the library, and stored versions without the track failing
  to parse.
- Unit, `apps/worker/src/cutout/ensure-cutouts.test.ts`: catches a mask re-made for a stored span,
  a missing span not made, or an overwrite.
- Unit, `apps/worker/src/cutout/mask-tool.test.ts`: catches a changed `vseg` argument list, a
  silent fallback off macOS, and a Swift change without a version bump.
- Unit, `apps/worker/src/decide/run-decide.test.ts`: catches a version saved before its masks exist.
- Unit, `apps/studio/src/lib/preview-page.test.ts`: catches a mask or photo path left unsigned.
- E2E, `apps/studio/e2e/behind.spec.ts`: catches a correction that does not produce a version with
  a photo in the named spot in the live preview, a missing `cutout` step or `stored_files` row.
- Tools (owner's Mac, not CI): `mask-tool.tools.test.ts` (the real Vision mask), the guardrail's
  `behind` case (preview matches export).

### Edge Cases

- A stored version without `behind`, without `inputs.masks`, or with the old `inputs.cutout`.
- A `behind` item at the reel start or end: padding clamped to `[0, duration]`.
- Two `behind` items closer than twice the padding: one merged mask.
- The same span in a later version (a change that only edits captions): mask reused, `cut-out
reused` hit.
- A mask slimmed after seven days: preview shows the cleared notice; export, restore or a change
  rebuilds it.
- A photo deleted from the library after a version used it: preview notice, render fails with one
  line, decide no longer offers it.
- A photo of another owner named in an answer: refused by the decide schema's enum; the studio
  never signs it (RLS).
- A word item with spaces, markup characters or longer than 24 characters: refused.
- A very long word: size shrinks to fit the frame; a word that cannot fit at the minimum size (8 px)
  fails the `frame` check.
- No head in the frame at the word's start: `noHeadY`.
- A `behind` item overlapping a footage `hidden` span: refused.
- The worker on Linux (CI) without `E2E_MOCK_MASK`: the change job fails with the one-line macOS
  reason, nothing saved.

## Acceptance Criteria

- The spike result is recorded in this plan's `Spike record`, and the chosen composite is
  frame-accurate in the export, or the PR stops and says it is not.
- `edit.json` accepts a `behind` track (photo in `top`, `left` or `right`; one word), 2 to 4 s,
  word-anchored; stored versions without it still parse and build byte-identically to the
  committed goldens.
- `vseg` builds with `yarn workspace @edit-issebya/worker build:vseg` (binary gitignored) and
  writes a grayscale H.264 mask at the footage's size and frame timing; off macOS it fails with one
  line.
- Saving a version with `behind` items makes each missing mask once (fingerprinted, padded,
  put-if-absent, `rebuildable` in `stored_files`, named in `inputs.masks`) before the version is
  saved; a later version with the same span reuses it.
- Preview and export of a version with one photo and one big word match (guardrail at the existing
  bound) on the owner's Mac.
- A correction can add, move, swap or remove a `behind` item and change the big word.
- The worker doctor has a `mask tool` line.
- `app_docs/pipeline.md`'s "until #20" rule is replaced by the on-demand rule; the other docs are
  updated.
- Lint, typecheck, knip, format, unit, build and E2E pass; CI green.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - formatting over the whole repository.
- `yarn turbo run lint --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio` - lint of the three touched workspaces.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio` - types, including the new asset roles and `STORAGE_METHODS`.
- `yarn knip` - no unused file, export or dependency (the Swift tool and its script included).
- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio` - unit tests, the edit package's Node and browser goldens, the migration guard.
- `yarn workspace @edit-issebya/worker test:tools` - real ffmpeg, HyperFrames and `vseg` (owner's Mac only, never CI).
- `yarn turbo run test:db --filter=./apps/studio` - no schema change, run to confirm `stored_files` and versions behaviour is unchanged.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/web` - the studio builds (and the landing page, which forwards to it).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools` - the preview-matches-export guardrail with the `behind` case (owner's Mac only).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - every E2E suite, `behind.spec.ts` included.

## Notes

- No new dependency: `vseg` uses only Apple frameworks (AVFoundation, Vision, Core Image,
  VideoToolbox) and the Xcode command-line tools' `swiftc`, which the owner's Mac already has.
- No migration: `stored_files.step` accepts `cutout` (`^[a-z_]{1,40}$`), `rebuildable` is an
  existing kind, and the `steps` table takes any step name.
- Masks are `rebuildable` as the issue decides, so the seven-day slimming can delete them; the
  preview then shows a one-line notice rather than a picture that differs from the export, and the
  next export, restore or change rebuilds them. If the owner prefers the preview never to lose its
  cut-out, tagging masks `kept` is a one-line change in `ON_DEMAND_OUTPUTS` (owner decision).
- The preview footage copy is 540x960 while masks are at the footage's full size; both fill the
  frame with `object-fit: cover`, so they align. A 540x960 mask copy for the preview is a possible
  later optimisation, not part of this issue.
- Choosing the spot and the word automatically from the content is a later issue; here the AI uses
  the track only when a request (or the content, if the prompt allows it) asks for it.
- The preset's spot rectangles, the word size and its place are starting values; the owner judges
  them on one real reel after merge (owner acceptance), with stills at the span showing hair strands
  and the earbud cable in front of the photo.
- The 47.5 s `rethink-work` clip is not in the repository; the "3-second span masked in a few
  seconds" timing on it is part of the owner's manual verification.
- `vseg` is macOS only; the worker never runs in the cloud now. A cloud worker would need another
  segmentation model (options recorded on the issue).
- Never patch, fork or copy the HyperFrames player or renderer; the spike only reads their source to
  understand the frame injector.
- Commit messages: conventional commits, no trailers.

## Spike record

Run on the owner's Mac (macOS 14.6, Apple M3, Swift 5.10, HyperFrames 0.8.222, ffmpeg 8), in a
throwaway folder outside the repository (never committed). No prototype `vseg.swift` was attached
to issue #20, so the tool was written from the contract in task 2.

**Mask.** `vseg --input fixtures/footage/short-person.mp4 --start 0.500 --end 3.500 --output
mask.mp4` (read only on the fixture): 90 frames, H.264 1080x1920, 30 fps, `yuv420p` video range,
3.000 s, in 6.3 s wall. Two bugs found on the way and fixed in the tool: the reader stamps the
frame showing at the range start with the range start itself, so a range opened half a frame early
gave two frames at time 0 (VideoToolbox then fails with `-16364`); the tool now snaps each span edge
within a quarter frame onto the frame grid and drops any frame not after the last one written.

**Candidate A (CSS blend composite), built.** `index.html` by hand: the footage clip, then one
untimed group (`position: absolute; inset: 0; isolation: isolate`) holding a footage copy
(`muted`, `data-media-start` equal to its `data-start`), the photo `<img>` (900x600 at 90,160,
`object-fit: cover`, 0.6 to 2.0 s), a big word `<div>` (2.0 to 3.4 s), the mask with
`filter: invert(1); mix-blend-mode: multiply`, and a sub-group (`isolation: isolate;
mix-blend-mode: plus-lighter`) of a second footage copy and the mask with
`mix-blend-mode: multiply`. Every layer is a plain timed element, no script.

- `hyperframes lint`: 0 errors, one warning, `duplicate_media_discovery_risk` (the two footage
  copies, and the two mask copies, share source, start and duration). The render below discovered
  and drew all four correctly.
- `hyperframes render ... --quality delivery --workers 3 --no-browser-gpu --sdr`: 4 s in 35.6 s.
- Export against an ffmpeg reference composite (`maskedmerge` of footage-with-photo and footage by
  the mask), SSIM in the head area, mask shifted by -2..+2 frames: peaks at 0 at both 1.0 s
  (0.890, 0.906, **0.924**, 0.905, 0.875) and 1.5 s (0.867, 0.884, **0.897**, 0.892, 0.893), so the
  export's mask is frame-aligned with the footage (the absolute values include the re-encode and
  the two decoders' colour conversion).
- Preview: the same `index.html` as `srcdoc` of a bare `<hyperframes-player>` (Chromium through
  Playwright, 1080x1920, runtime and GSAP from the local packages), `seek(t)`, then every active
  video settled. The player honours `data-media-start` on the nested copies (at 1.5 s: footage
  copies 1.500, masks 1.000).
- Preview against export, SSIM in `yuv444p` (the export frame matched to the frame the preview
  shows; the preview shows the footage frame before the export's at the same `t`, outside the
  span too, so that offset is the existing player behaviour and not the composite's):

| Moment                | Full frame | Photo rectangle | Probe (photo 60 px lower) full | Probe rectangle |
| --------------------- | ---------- | --------------- | ------------------------------ | --------------- |
| 0.2 s (before span)   | 0.992555   | 0.992096        |                                |                 |
| 0.65 s (photo)        | 0.991984   | 0.991942        | 0.941383                       | 0.849199        |
| 1.5 s (photo)         | 0.992553   | 0.992569        | 0.952845                       | 0.870148        |
| 1.95 s (photo)        | 0.992360   | 0.992345        | 0.951201                       | 0.864001        |
| 2.5 s (word)          | 0.992459   | 0.990974        | 0.992459 (no photo)            | 0.990974        |
| 3.2 s (span, no item) | 0.992716   | 0.990998        |                                |                 |
| 3.8 s (after span)    | 0.993077   | 0.992436        |                                |                 |

Inside the span the composite scores the same as plain footage outside it, and the probe falls
well below, so the comparison is sensitive. Measured in RGB the photo rectangle scored lower
(0.94) on both sides of the comparison alike: the synthetic test photo's saturated colour bars
lose chroma in the export's 4:2:0 encode; in `yuv444p` the rectangle's luma SSIM is 0.9965.

**Candidate B (canvas from `hf-seek`)**: not built, A passed. **Candidate C** (CSS `mask-image` or
SVG `<mask>` with a video): recorded as unsupported, not built.

**Decision:** Candidate A ships. One finding for the studio: the preview wrapper
(`PreviewPlayer.tsx`, `preview-clock.ts`) placed every video at `t - data-start`, ignoring
`data-media-start`, so it would have held the footage copies at the wrong point; it now reads
`data-media-start` (a wrapper change, the player itself untouched).
