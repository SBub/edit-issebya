# Feature: readable text, a darker free area or a soft shadow, never a colour change

## Metadata

issue_number: `154`
adw_id: `596f3b25`
issue_json: `{"number":154,"title":"engine: readable text, move to a darker free area or add a soft shadow, never change colour"}`

## Feature Description

The layout engine (`placeEdit`, `packages/edit/src/engine.ts`) places and times every caption,
accent and big word, but it never looks at the footage behind them. A thin light-blue accent
(`#B3E6FF`) over a beige sweater is almost invisible. This feature gives the engine eyes on the
background:

1. A **background map**: the worker samples the retimed footage with ffmpeg (2 frames a second,
   each scaled down to a 36 by 64 grid of 30 px cells) and stores each cell's WCAG relative
   luminance. It is made once per footage, cached in R2 under its own fingerprint (the footage ref,
   the settings and a version), like the `cutout` step's masks.
2. A **background sampler** in `packages/edit` (pure, no I/O): given a box and a time span it reads
   the cells under the box in every sampled frame of the span and returns a robust background
   luminance (the 80th percentile towards the text's own luminance, so a few dark cells never hide
   a mostly light background). Memoised per box, span and direction.
3. **Readability in the engine**: right after each text is placed, the engine measures its WCAG
   contrast ratio (text colour against the sampled background). Below the threshold (4.5:1 for
   captions, 3:1 for accents and the big word) it first tries nearby free places in the same zone
   (the same candidate area, same size and lines, same obstacles); else it keeps the place and adds
   a soft shadow, `shadow: 1`, or `shadow: 2` when the contrast is very low. It never changes a
   colour. Every move and shadow is written to the engine record.
4. The **builder** renders `shadow` as a CSS `text-shadow` from the preset (two levels), in the one
   HTML the live preview and the export both play, so they match by construction.

## User Story

As the reel owner
I want every caption and accent to stay readable on whatever is behind it
So that viewers can read the reel without the text's brand colours ever being changed

## Problem Statement

Nothing measures contrast. The engine avoids the face, the platform notch and other text, but a
light text over a light background (a beige sweater, a white wall, a window) ships nearly
invisible, and the owner only finds it by eye.

## Solution Statement

Measure the pixels, not the colours: a cached per-footage luminance grid made by the worker, a
pure sampler the engine queries, and a two-stage remedy inside the engine (move within the same
zone, else a two-level soft shadow), recorded in `versions.engine_record`. Colours stay as the
preset or the item sets them. With no background map given (old callers, existing fixtures and
tests) the engine behaves exactly as today, so stored versions and current goldens stay valid.

Design decisions (documented in `app_docs/edit-model.md`):

- **Contrast**: WCAG 2.x. Relative luminance from sRGB hex (`#RRGGBB`) with the standard
  linearisation; ratio `(L1 + 0.05) / (L2 + 0.05)`, lighter over darker.
- **Robust background**: over all cells the box touches (any overlap) in every sampled frame whose
  time is inside the span (at least the one nearest frame when the span is shorter than a sample
  step), sort the cell luminances and take the 80th percentile **towards the text's luminance**:
  for a text lighter than the median cell the 80th percentile from the dark end (the light end is
  what hurts), for a darker text the 20th. Nearest-rank, integer arithmetic on the stored bytes so
  it is exact and deterministic.
- **Thresholds** (`preset.readability`): captions `4.5`, accents and big word `3` (large text in
  WCAG terms). Shadow level 2 when the ratio is below `strongBelow` (captions `3`, large `2`), else
  level 1.
- **Shadows** (`preset.readability.shadows`): level 1 `0 2px 8px rgba(0, 0, 0, 0.55)`, level 2
  `0 2px 6px rgba(0, 0, 0, 0.8), 0 0 18px rgba(0, 0, 0, 0.6)`; a text darker than its
  background gets the same shapes in white (`rgba(255, 255, 255, ...)`) so the halo always
  separates it. The shadow is chosen from the text's luminance, never by changing the text.
- **Nearby, same zone**: for a caption block or an accent, the chosen candidate's `area` with the
  same obstacles the original fit used (face, text shown with it, notch, and the photo-spot rule for
  a sentence that kept a photo spot), the same size, the same line breaks. Wanted points: the
  original centre, then a fixed grid every 60 px within `moveRadius` (300 px) of it, in a fixed
  order. Each goes through `placeBox`; the results are deduplicated; the first that reaches the
  threshold, ranked by distance from the original place, then higher, then further left, wins.
  The big word is never moved (the head overlapping it is the design); it gets a shadow only.
- **Skipped**: captions inside a transition's text area (the transition layer is the background,
  dark by preset), and every text when no background map is given.
- **Record**: a new `EngineAction` `"shadowed"`; rules `contrast-spot` (action `moved`) and
  `contrast-shadow` (action `shadowed`), with the ratio before and after in plain words, for example
  `{ "item": "accent-1", "action": "shadowed", "rule": "contrast-shadow", "reason": "accent \"What are you protecting?\" gets a soft shadow (level 2): contrast 1.6:1 from 3.20 s to 5.10 s, no free place nearby reaches 3:1" }`.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md` - repository rules (Yarn only, no em-dashes, no attribution, one doc per
  feature, Rules lines are invariants).
- `.adw/project.md` - profile: workspaces, the test layers (`packages/edit` Node and browser
  goldens, worker unit tests, studio E2E), Protected (never start the worker, no `supabase`
  commands beyond the two allowed).
- `docs/conditional-docs.md` - index; the `edit-model.md` line will mention readability.
- `app_docs/edit-model.md` - "Layout engine" section (engine inputs, record actions and rules,
  Rules section) and the builder; gets the readability subsection and the "never change a text
  colour" Rules line.
- `app_docs/decide-step.md` - how `editFromAnswer` is called and the engine record saved and
  logged; the decide step now passes the background sampler.
- `app_docs/pipeline.md` - fingerprints, cache keys, `kept` and `rebuildable` outputs, on-demand
  outputs (the `cutout` pattern this follows), `fixtures/pipeline/`.
- `app_docs/storage.md` - `stored_files` rows for every stored object (`recordingStorage`).
- `app_docs/status.md` - `STEP_NAMES` and the studio's step words.
- `packages/edit/src/engine.ts` - `placeEdit`, `PlaceOptions`, `EngineAction`, caption block
  placement (`placeBlock`, `tryBlock`), `placeAccent`, `placeBigWord`, the output tracks.
- `packages/edit/src/engine-space.ts` - `placeBox`, `overlaps`, `expand`: reused for nearby
  candidates.
- `packages/edit/src/engine.test.ts` - engine unit tests to extend.
- `packages/edit/src/decide.ts` - `editFromAnswer` calls `placeEdit`; gets an optional sampler
  argument and still parses with `parseEdit` (so `shadow` must be in the schema).
- `packages/edit/src/schema.ts` - `textProps` (captions and accents) and the behind `word`: add an
  optional `shadow: 1 | 2`.
- `packages/edit/src/preset.ts` - `Preset` type and `ISSEBYA_PRESET`: add `readability`.
- `packages/edit/src/layout.ts` - `TextBox` and the old layout's text items: carry `shadow`.
- `packages/edit/src/build.ts` - text spans and the big word element: emit `text-shadow`.
- `packages/edit/src/index.ts` - public exports.
- `packages/edit/scripts/golden.ts`, `packages/edit/src/test-support/goldens.ts`,
  `packages/edit/src/test-support/inputs.ts`, `packages/edit/src/build.test.ts`,
  `packages/edit/src/build.browser.test.ts` - the golden fixtures, Node and browser.
- `apps/worker/src/first-version.ts` - calls `placeEdit`; ensures the background map first.
- `apps/worker/src/decide/run-decide.ts` - calls `editFromAnswer`; ensures the background map first.
- `apps/worker/src/process-job.ts` - passes `tools` and `scratchDir` to the steps (first version
  may need them now).
- `apps/worker/src/cutout/ensure-cutouts.ts` - the on-demand, fingerprinted, put-if-absent step
  pattern (hit row, measured tools step, `recordStored`) to copy.
- `apps/worker/src/pipeline/fingerprint.ts` (`fingerprint`, `cacheKey`),
  `apps/worker/src/pipeline/definition.ts` (`ON_DEMAND_OUTPUTS`, `retentionOf`),
  `apps/worker/src/step-runner.ts` (`runToolsStep`, `recordHit`), `apps/worker/src/step-names.ts`.
- `apps/studio/src/lib/step-words.ts` - plain words for each step name (its test reads
  `STEP_NAMES`).
- `apps/studio/e2e/upload.spec.ts` - checks every stored object has one `stored_files` row with
  its step; the new `backgrounds.json` must appear there.
- `apps/studio/e2e/preview.spec.ts` - compares the worker's version 2 with the
  `baseline-short-speech` golden byte for byte; the golden must be made with the same background
  map the worker computes for the fixture clip.
- `fixtures/pipeline/retime/source.mp4` - the retimed fixture clip the E2E worker samples.

### New Files

- `packages/edit/src/contrast.ts` - `relativeLuminance(hex)`, `contrastRatio(a, b)`, pure.
- `packages/edit/src/contrast.test.ts` - known WCAG pairs (white on black 21:1, `#777777` on white
  about 4.48:1, equal colours 1:1).
- `packages/edit/src/background.ts` - the `BackgroundMap` format and its zod schema, `BACKGROUND_GRID`
  (columns, rows, cell size, `everySeconds`), `backgroundSampler(map, frame)` with the memoised
  `behind(box, span, textLuminance)`, and `uniformBackground` / a test builder for synthetic maps.
- `packages/edit/src/background.test.ts` - sampler tests (stable values, caching, percentile
  direction, span edges, boxes past the frame edge).
- `packages/edit/src/testdata/backgrounds/short-speech.backgrounds.json` - the background map the
  worker's code makes from `fixtures/pipeline/retime/source.mp4`, used by `golden.ts` so the
  baseline golden equals the worker's version 1.
- `packages/edit/src/testdata/versions/rethink-work-readable.edit.json` and
  `packages/edit/src/testdata/golden/rethink-work-readable.html` (+ `.widths.json`) - an engine
  placement over a synthetic light background with a moved caption and a shadowed accent, built in
  Node and in the browser and compared byte for byte.
- `apps/worker/src/backgrounds/background-map.ts` - `BACKGROUND_SETTINGS`, the ffmpeg arguments
  (`-vf fps=2,scale=36:64:flags=area,format=rgb24 -f rawvideo`), and `mapFromRaw(bytes, settings)`
  turning raw RGB frames into the stored map (per cell relative luminance, quantised to 0..255).
- `apps/worker/src/backgrounds/background-map.test.ts` - raw bytes to map (a white frame, a black
  frame, a split frame), the arguments.
- `apps/worker/src/backgrounds/ensure-backgrounds.ts` - `ensureBackgrounds({ ctx, storage,
keyPrefix, scratchDir, footage, tools, spawnTool, recordStored })`: hit or one measured
  `backgrounds` step, put-if-absent, returns the parsed map.
- `apps/worker/src/backgrounds/ensure-backgrounds.test.ts` - a stored map is a hit (no ffmpeg, a
  `backgrounds reused` row); a missing one runs the fake tool once and stores it under the
  fingerprint; the fingerprint changes with the footage ref and the settings.
- `apps/worker/src/backgrounds/background-map.tools.test.ts` - real ffmpeg on
  `fixtures/pipeline/retime/source.mp4`, equal to the committed
  `short-speech.backgrounds.json` (owner's Mac, `test:tools`).

## Implementation Plan

### Phase 1: Foundation

Pure pieces in `packages/edit`: contrast maths, the background map format and its sampler, the
`shadow` field in the schema, the preset's `readability` block, and the builder's `text-shadow`.
None of this changes any existing output: no stored version has `shadow`, no caller passes a map.

### Phase 2: Core Implementation

The readability pass inside `placeEdit`, run right after each caption block and each accent is
placed (so later items see the moved box as an obstacle) and after the big word: measure, try
nearby places in the same zone, else shadow; record each. Then the golden fixture that shows a
move and a shadow, written by `golden.ts` and checked in Node and in the browser.

### Phase 3: Integration

The worker makes and caches the background map (`ensureBackgrounds`, on demand like the cut-out,
so old reels and change jobs get one without re-running the pipeline), records it in
`stored_files`, and passes a sampler to `placeEdit` in `first_version` and to `editFromAnswer` in
`decide`. The studio gets the step's words; the upload spec expects its stored object; the
baseline golden is regenerated with the fixture clip's map; docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/edit-model.md` ("Layout engine", the builder, Rules), `app_docs/decide-step.md`,
  `app_docs/pipeline.md` (fingerprints, on-demand outputs), `app_docs/storage.md` and
  `app_docs/status.md` (step names). Read `apps/worker/src/cutout/ensure-cutouts.ts` end to end:
  `ensureBackgrounds` follows it.

### 2. Contrast maths

- Create `packages/edit/src/contrast.ts`: `relativeLuminance(hex: string): number` (accepts the
  schema's `COLOR` forms; read `schema.ts` for the exact regex and support each form it allows),
  `contrastRatio(a: number, b: number): number`, `luminanceByte(l)` / `byteLuminance(b)` for the
  0..255 quantisation the map stores (`round(l * 255)`).
- Create `packages/edit/src/contrast.test.ts` with the known pairs above.

### 3. Background map and sampler

- Create `packages/edit/src/background.ts`:
  - `BackgroundMap`: `{ version: 1, everySeconds: number, columns: number, rows: number,
frames: string[] }`, each frame base64 of `columns * rows` bytes (row-major relative luminance
    bytes), decoded with `atob` (standard in Node 24 and browsers, no platform module). A zod
    schema checking the lengths.
  - `backgroundSampler(map, frame: { width, height })` returning `{ behind(box, span,
textLuminance): number }`: frames at times `index * everySeconds` (the first frame at 0);
    the frames inside `[span.start, span.end)` or the nearest one when none is; cells overlapping
    the box clipped to the frame; the robust value as in the Solution Statement. Decode each frame
    once, lazily. Memoise results in a `Map` keyed by the box edges, the span (to the millisecond)
    and the direction; expose `calls`/`hits` counters only through a test seam if needed (or test
    caching by counting `atob` decodes through an injected decoder parameter, defaulting to
    `atob`).
  - A helper to build maps for tests (`backgroundMapOf(width, height, paint: (x, y, t) => hex)`)
    kept in `src/test-support/` if only tests use it (knip runs on the whole repository).
- Create `packages/edit/src/background.test.ts`: same call twice returns the identical number and
  decodes no frame again; two samplers over the same map agree; a light box over a mostly dark area
  with a few light cells returns the light value for dark text and the dark value for light text as
  the percentile rule says; a span shorter than a step reads the nearest frame; a box partly outside
  the frame reads only the inside cells; a map with the wrong byte count fails to parse.

### 4. Schema and preset

- `packages/edit/src/schema.ts`: add `shadow: z.union([z.literal(1), z.literal(2)]).optional()` to
  `textProps` and to the behind `word` object. Stored versions without it still parse (extend
  `schema.test.ts`: a version with `shadow: 2` parses, `shadow: 3` does not).
- `packages/edit/src/preset.ts`: add to `Preset` and `ISSEBYA_PRESET`
  `readability: { caption: { min: 4.5, strongBelow: 3 }, large: { min: 3, strongBelow: 2 },
moveRadius: 300, moveStep: 60, shadows: { dark: [level1, level2], light: [level1, level2] } }`
  with the CSS values from the Solution Statement. Extend `preset.test.ts` if it snapshots the
  preset.

### 5. Builder renders the shadow

- `packages/edit/src/layout.ts`: add `shadow: 1 | 2 | undefined` to `TextBox` (and the old
  layout's text items) from the item.
- `packages/edit/src/build.ts`: for a text box with `shadow`, append
  `text-shadow: <preset shadow>` to its inline CSS (the dark set for a text lighter than mid-grey, the light set
  otherwise, the same direction rule the engine uses); same for the big word element. Nothing else changes, so
  every existing golden is byte for byte the same.
- Extend `packages/edit/src/build.test.ts`: an edit with a caption `shadow: 1` and an accent
  `shadow: 2` has the exact `text-shadow` strings, and the same edit without them has none.

### 6. Readability in the engine

- `packages/edit/src/engine.ts`:
  - `EngineAction` gains `"shadowed"`; `PlaceOptions` gains
    `backgrounds?: { behind(box: Box, span: { start: number; end: number }, textLuminance: number): number }`.
  - A helper `readable(box, span, color, kind)` returning `{ ratio, min, strong }`.
  - In `placeBlock` (sentence blocks only, not transition blocks): after the place is chosen and
    before the units are pushed to `shown`, compute the block's box and colour (caption `color ??
preset.caption.color`; when the block's captions carry different colours, measure each colour
    and use the worst). Below `min`: build the nearby wanted points (the original centre, then the
    60 px grid within `moveRadius`, row by row from the top, left to right), run `placeBox` in the
    chosen candidate's area with the same obstacles `tryBlock` used (factor the obstacle list out of
    `tryBlock` so both use one list), keep the `leavesPhotoSpot` rule when the chosen fit kept it,
    and take the best place that reaches `min` (distance, then y, then x). Moved: shift every
    unit's x and y by the offset, record `moved` / `contrast-spot`. Not moved: set `shadow` (1 or
    2 by `strongBelow`) on every caption of the block and record `shadowed` / `contrast-shadow`.
  - In `placeAccent`: after a spot is found, same procedure inside `candidate.area` with the same
    `obstacles`, size and lines; on a move update `item.position` and the `shown` box; else set
    `item.shadow`.
  - In `placeBigWord`: measure only; below `large.min` set `shadow` on the behind word and record
    `shadowed` / `contrast-shadow`.
  - The colour is never written or altered anywhere in this path (assert in tests).
  - Write the reasons in plain words with the text (via `quote`), the times (via `at`), the ratios
    to one decimal (`2.1:1`) and the move distance in whole pixels.
  - Update the engine's header comment (step 6 and a new step for readability).
- `packages/edit/src/decide.ts`: `editFromAnswer(..., measurer, backgrounds?)` passes it through
  in `PlaceOptions`.
- `packages/edit/src/index.ts`: export `backgroundSampler`, `backgroundMapSchema`, `type
BackgroundMap`, `relativeLuminance`, `contrastRatio` (only what the worker and tests use; knip).

### 7. Engine unit tests

- Extend `packages/edit/src/engine.test.ts` (use the existing fixtures and the Node measurer):
  - A light caption (`#FFFFFF`) whose first place lies on a light region of a synthetic map, with
    a dark region nearby inside the same candidate area: it moves there, the record has
    `moved` / `contrast-spot`, the caption has no `shadow`, its `color` is unchanged (absent, as
    before), and nothing overlaps (run `runChecks` and expect no failure).
  - The same map with no dark region nearby (all light): the caption keeps its place and gets
    `shadow` 1 or 2 by the ratio, record `shadowed` / `contrast-shadow`.
  - The accent from the issue (`#B3E6FF`) over a beige (`#D8C3A5`) region: moves when a darker
    free area exists in its zone, else `shadow: 2`; never a colour field on the output.
  - The big word over a light region: `shadow`, never moved.
  - A dark background everywhere: output deep-equal to the output with no map (no notes, no
    shadow).
  - No map given: output deep-equal to today's (guards every existing caller).
  - Deterministic: two runs with the same input and map give deep-equal tracks and records.
  - Captions inside a transition: never moved or shadowed for contrast.

### 8. Golden fixture with a move and a shadow

- `packages/edit/scripts/golden.ts`: place the `rethink-work-engine` choices over a committed
  synthetic map (built in the script by the test-support helper: light where the first accent and
  a caption block would sit, dark beside them) and write `rethink-work-readable`; place the
  baseline with `short-speech.backgrounds.json` (step 10 makes it) so the baseline golden equals
  what the worker saves for the fixture clip.
- Register the new golden in `src/test-support/goldens.ts` and the fixture lists the Node and
  browser build tests iterate. Run `yarn workspace @edit-issebya/edit golden` and commit what it
  writes. Check by eye that `rethink-work-readable.html` has a `text-shadow` on the accent and a
  moved caption, and that its `.edit.json` keeps every colour as in the engine fixture.

### 9. Worker: the background map step

- `apps/worker/src/backgrounds/background-map.ts`: `BACKGROUND_SETTINGS = { everySeconds: 0.5,
columns: 36, rows: 64 }` (from `BACKGROUND_GRID`), `BACKGROUNDS_VERSION = 1`,
  `backgroundArgs(input, output, settings)` for ffmpeg (`-hide_banner -v error -y -i <in> -map
0:v:0 -vf fps=2,scale=36:64:flags=area,format=rgb24 -f rawvideo <out>`), and `mapFromRaw(bytes,
settings)`: per pixel `relativeLuminance` of its RGB, `round(l * 255)`, one base64 string per
  frame. A trailing partial frame is an error.
- `apps/worker/src/backgrounds/ensure-backgrounds.ts`: fingerprint
  `fingerprint({ inputs: [footage ref], settings: BACKGROUND_SETTINGS, version })`, key
  `cacheKey(keyPrefix, "backgrounds", fp, "backgrounds.json")`; stored: `recordStored` its size
  and a hit row (`recordHit`, summary `backgrounds reused`); else one `runToolsStep` named
  `backgrounds` that downloads the footage into `scratchDir`, runs ffmpeg through the tool, builds
  the map, uploads it put-if-absent and returns `{ what: "backgrounds of N frames" }`. Returns the
  parsed map.
- `apps/worker/src/pipeline/definition.ts`: add `{ step: "backgrounds", file: "backgrounds.json",
retention: "rebuildable" }` to `ON_DEMAND_OUTPUTS` (the next job makes it again from the
  footage).
- `apps/worker/src/step-names.ts`: add `"backgrounds"`; `apps/studio/src/lib/step-words.ts`: its
  plain words (for example `Reading the background`), keeping its test green.
- Tests: `background-map.test.ts`, `ensure-backgrounds.test.ts` (fake tool and folder storage, as
  `ensure-cutouts.test.ts` does), `background-map.tools.test.ts` (real ffmpeg, compares with the
  committed `short-speech.backgrounds.json`).

### 10. The fixture clip's map

- Produce `packages/edit/src/testdata/backgrounds/short-speech.backgrounds.json` from
  `fixtures/pipeline/retime/source.mp4` with the worker's own `backgroundArgs` and `mapFromRaw`
  (a small script entry or the tools test in write mode; real ffmpeg is on the owner's Mac and in
  the run's environment). Confirm the fixture clip's map is the same one the E2E worker computes
  (same file, same settings). Then rerun step 8's `golden` so the baseline golden uses it. If the
  baseline golden changes (the fixture clip has low-contrast text), that is the intended new
  version 1: commit it and say so in the PR body.

### 11. Worker integration

- `apps/worker/src/first-version.ts`: `FirstVersionRun` gains `scratchDir`, `tools`, `spawnTool?`,
  `recordStored?`; before `runInProcessStep`, `ensureBackgrounds` for `inputs.footage`; pass
  `backgroundSampler(map, ISSEBYA_PRESET.frame)` as `{ backgrounds }` to `placeEdit`. Update
  `first-version.test.ts` (a stored map: a hit row and the sampler used; the record carries a
  `contrast-*` note on a light synthetic map).
- `apps/worker/src/decide/run-decide.ts`: before the attempts, `ensureBackgrounds` for
  `row.inputs.footage` (a failure here comes before the AI call, so it is an ordinary step failure);
  pass the sampler to `editFromAnswer`. Update `run-decide.test.ts`.
- `apps/worker/src/process-job.ts`: pass `scratchDir`, `tools` and `recordStored` to
  `saveFirstVersion` as it already does for the other steps.
- `apps/worker/src/engine-record.ts`: check it handles the new action (one line per version).
- Grep the studio and worker for exhaustive lists of `EngineAction` values or engine rules and add
  `shadowed`, `contrast-spot`, `contrast-shadow` where they are listed.

### 12. Studio E2E

- `apps/studio/e2e/upload.spec.ts`: expect the `backgrounds` step row of the process job and the
  `backgrounds.json` object under the run's prefix with its `stored_files` row (`rebuildable`,
  step `backgrounds`). It fails without this feature (no such row or object).
- `apps/studio/e2e/preview.spec.ts`: no code change; it must still pass, now against the baseline
  golden made with the fixture clip's map (step 10).
- No new browser spec for the shadow itself: the shadow lives in the built HTML that the preview
  and the export both play; the browser golden layer (`build.browser.test.ts`, real chromium)
  compares `rethink-work-readable` byte for byte, which is the deterministic proof. The owner's
  `yarn workspace @edit-issebya/studio test:tools` (export matches preview, real HyperFrames) is the
  pixel guardrail and needs no change.

### 13. Documentation

- `app_docs/edit-model.md`: a "Readability" subsection under "Layout engine" (the map, the
  sampler, the percentile, thresholds, nearby same-zone moves, the two shadow levels, skipped
  texts, the record's new action and rules, `PlaceOptions.backgrounds`); the `shadow` field in the
  format; the builder's `text-shadow`. Rules lines: "Never change a text colour to make it
  readable: move it or add a shadow." and "Never move the big word for contrast; it only gets a
  shadow."
- `app_docs/decide-step.md`: decide ensures the background map before the AI call and passes it.
- `app_docs/pipeline.md`: the on-demand `backgrounds` output (`backgrounds.json`, rebuildable, its
  fingerprint and settings) beside `cutout`.
- `app_docs/status.md`: the new step name if that doc lists them.
- `docs/conditional-docs.md`: extend the `edit-model.md` line with "readability (contrast, the
  background map and sampler, text shadows)" and the `pipeline.md` line with "the on-demand
  background map".
- No em-dashes anywhere.

### 14. Validation

- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `packages/edit/src/contrast.test.ts`: WCAG maths against known pairs.
- `packages/edit/src/background.test.ts`: stable values, memoisation (no second decode), the
  percentile direction, span and edge handling, schema.
- `packages/edit/src/engine.test.ts`: moved to a darker free area in the same zone; else shadowed
  (level by ratio); never a colour change; big word shadow only; transitions skipped; no map or a
  dark map changes nothing; deterministic.
- `packages/edit/src/build.test.ts` and `schema.test.ts`: `shadow` parsed and rendered as the
  exact `text-shadow`.
- Node and browser golden tests over the new `rethink-work-readable` fixture.
- `apps/worker/src/backgrounds/*.test.ts`: raw frames to map; hit versus miss; fingerprint inputs.
- `apps/worker/src/first-version.test.ts`, `decide/run-decide.test.ts`: the sampler is passed and
  its notes reach the saved record.

### Test Coverage

- `engine.test.ts` (unit, `packages/edit` Node project): a light text on a light sampled
  background moves to a darker free area, else gets a shadow, and its colour never changes;
  nothing measures contrast today, so it fails without the feature.
- `background.test.ts` (unit): the sampler returns stable cached values; the module does not
  exist today.
- `build.test.ts` + `rethink-work-readable` golden in `build.browser.test.ts` (Node and browser
  layers): the shadow is rendered as one exact `text-shadow` in the HTML the preview and export
  both play; fails today (no `shadow` field, no golden).
- `ensure-backgrounds.test.ts` (worker unit): the map is made once per footage fingerprint and
  reused; fails today (no step).
- `apps/studio/e2e/upload.spec.ts` (studio E2E): the real process job writes and records the
  background map; fails today (no `backgrounds` row or object).
- `background-map.tools.test.ts` (worker tools layer, owner's Mac only): real ffmpeg output equals
  the committed map the golden uses.

### Edge Cases

- No head in the frame (captions on the caption line or the safe zone): the same procedure.
- A span shorter than one sample step, a span at the reel's end, a box partly outside the frame.
- Mixed backgrounds (a small light patch on dark): the 80th percentile ignores a small patch.
- Dark text (an item colour set darker than the background): the percentile flips and the shadow
  is light.
- A caption block whose nearby better place would hide the only photo spot: not taken.
- A caption block that moved and a later accent: the accent sees the moved box as an obstacle.
- A transition block: skipped. A caption already over the face (`covers-face`): shadow only, never
  moved for contrast.
- A change job on a reel saved before this feature: the map is made on demand from the stored
  footage; stored versions without `shadow` still build byte for byte as before.
- The same answer twice: the same tracks and record.

## Acceptance Criteria

- The engine never writes or alters a `color` field for readability (tested).
- A text under its threshold moves to a nearby free place in the same zone that reaches it, when
  one exists; else gets `shadow: 1` or `shadow: 2`; each recorded with `contrast-spot` or
  `contrast-shadow` in `versions.engine_record`.
- Thresholds 4.5:1 captions, 3:1 accents and big word, documented with the shadow levels.
- The background map is cached by footage fingerprint (a second job is a hit), and the sampler
  memoises per box and span; same input, same output.
- The builder renders `shadow` as the preset's `text-shadow` in the one HTML used by preview and
  export; the Node and browser goldens match byte for byte.
- `app_docs/edit-model.md` documents readability with the Rules line "Never change a text colour
  to make it readable: move it or add a shadow."
- Format, lint, typecheck, knip, unit tests, build, DB and E2E green; no em-dashes; no attribution.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio` - lint the package, its dependents and the changed apps.
- `yarn turbo run typecheck --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio` - types across the package and both consumers.
- `yarn knip` - no unused exports or files (the new test helpers and exports).
- `yarn turbo run test --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio` - unit tests, including the Node and browser golden projects of `packages/edit`.
- `yarn workspace @edit-issebya/worker test:tools` - real ffmpeg map equals the committed fixture map (owner's Mac only, never in CI).
- `yarn turbo run test:db --filter=./apps/studio` - DB layer unchanged (no migration in this change).
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker --filter=./packages/edit` - the studio builds; worker and package typecheck as their build check.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - the landing and studio E2E suites, including the extended `upload.spec.ts` and the unchanged `preview.spec.ts` against the regenerated baseline golden.

## Notes

- No new dependency: ffmpeg is already a worker tool; base64 goes through the standard `atob`.
- No migration: the shadow lives in the edit JSON, the record in the existing
  `versions.engine_record`, the new stored object in `stored_files` with an existing kind.
- Why on demand and not a fixed pipeline step: change jobs and old reels get a map from the
  stored footage without re-running the pipeline, and `fixtures/pipeline/` (made by real tools on
  the owner's Mac) needs no regeneration. The step costs one low-resolution ffmpeg decode per
  footage, once.
- The area-averaged scale averages in gamma space before the luminance is taken; that slightly
  understates contrast on fine textures. Acceptable for a robust estimate, documented.
- Item 6 of the engine design (the record as a summary) will read the new action and rules.
- Future: per-item sampler cache across jobs is unnecessary (the map is the cache; sampling is
  milliseconds).
