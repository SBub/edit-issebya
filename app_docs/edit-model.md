# Edit Model: Word-Anchored Format, Style Preset, HarfBuzz Builder, Versions

**Specifications:**

- specs/issue-31-adw-7f81a19d-sdlc_planner-edit-model-builder-versions.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-114-adw-9049f8fd-sdlc_planner-platform-safe-zone-guard.md
- specs/issue-154-adw-596f3b25-sdlc_planner-readable-text-contrast.md

Every edit of a reel is a small JSON file (`edit.json`) anchored to the words of its transcript.
One builder turns it into a HyperFrames page, the same bytes in the worker and in the studio, and
every saved edit is an immutable version.

## Overview

`packages/edit` (`@edit-issebya/edit`) holds the edit format, the issebya style preset, the
HarfBuzz builder with its layout checks, and the version operations. It is TypeScript source with
no build step and no platform API (no `fs`, no DOM, no clock, no randomness): the caller passes in
everything that touches the platform (the HarfBuzz module and font bytes, storage, the database,
new ids). `apps/worker` consumes it now (the `first_version` step); `apps/studio` imports only its
types until slice 9 brings the live preview.

## How it works

### Format

- `src/schema.ts`: `edit.json`, format 1: `format`, `preset` (`"issebya"`), `duration`, `inputs`
  (the pipeline outputs it was made from, each `{ step, fingerprint, file }`: `footage`,
  `transcript`, `head_track`) and `tracks`: `footage`, `captions`, `overlays`
  (`kind: "accent"`), `transitions` (`dim`, `panel`, `card`), `sounds` (`click`) and the optional
  `behind` track. `inputs.cutout` and `tracks.cutout` (the old whole-clip cut-out) are optional and
  never written now (old versions may hold them); the builder ignores them.
- `tracks.behind`: what sits behind the speaker. An item is either a library photo
  (`kind: "photo"`, `photo_id` a photo's uuid, `spot` one of `top`, `left`, `right`) or one big
  word (`kind: "word"`, `text` a single word of 1 to 24 characters with no space, `<`, `>` or
  `&`). It is anchored on words like a caption, lasts the preset's 2 to 4 s, cuts in and out with
  no animation, and only one is shown at a time. A refinement refuses an item outside 2 to 4 s, two
  overlapping items and an item crossing a footage clip's `hidden` span. A version without the
  track parses, and the builder reads it as empty.
- `inputs.masks` and `inputs.photos`, both optional, filled by the worker before a version with a
  `behind` item is saved: `masks` lists the person masks (`EditMask`, a `{ step: "cutout",
fingerprint, file: "mask.mp4", start, end }` ref plus the span of the reel it covers, in
  seconds, by start), `photos` the library photo ids the track names (sorted, unique). A version
  without behind items has neither.
- Every item has an `id` (`^[a-z][a-z0-9-]{0,63}$`, unique across tracks), a `start` and an `end`
  anchor. An anchor is a word (`{ word, edge?: "start" | "end", offset? }`, offset within plus or
  minus 1 s), a time in seconds (`{ time }`, only where nobody speaks) or the reel's edge
  (`{ reel: "start" | "end" }`). Anchors are resolved at every build (`src/timeline.ts`,
  `resolveAnchor`, `resolveTimeline`, to the millisecond), so items follow their words through a
  re-time.
- Per-item properties: captions and overlays take `words`, `text`, `font` (`primary` or
  `secondary`), `size`, `color` (`#RRGGBB`), `position` (`{ x, y, align }` inside the frame) and
  `break_after` (set in two lines, this many words on the first); a big word behind the speaker
  takes `position` (`{ x, y }`, its top left corner in the frame) and `size`. Captions, accents and
  the big word also take an optional `shadow` (`1` or `2`, a soft text shadow the engine sets when
  the text would be hard to read; the builder renders it as the preset's `text-shadow`). The layout engine
  writes `position` and `size` on every caption, accent and big word it places; versions saved
  before it have none;
  footage clips take `hidden` spans; transitions a replacement `color`; sounds
  `gain_db` (-60 to 12). Unset properties come from the preset.
- `style` is the free custom-style field: CSS property to value, added to the element. Values
  cannot leave the style attribute (no `;`, `{`, `}`, `<`, `>`, backslash or `url(`).
- Validation is Zod 4. `editSchemaFor(preset, transcript)` is built per reel: word ids are the
  transcript's and fonts the preset's, so an unknown word or font is refused by the schema itself;
  a refinement refuses a duplicate id, an end before its start, an overlay with neither words
  nor text, and a `behind` item breaking its rules above. `EditLimits.photoIds` limits
  `photo_id` to the given ids (the decide answer passes the owner's ready photos); without it any
  uuid parses. `src/transcript.ts` is the studio transcript (`{ words: [{ id, text, start, end }] }`).

### Preset values

`src/preset.ts`, `ISSEBYA_PRESET`, the values of the approved `rethink-work` reel:

- Frame 1080x1920; safe box left 130, right 860, top 260, bottom 1400. Text never leaves it. It is
  the style's own box (130, 860, 260, 1400, `STYLE_SAFE`) cut to `PLATFORM_SAFE` with
  `intersectBox`; with the current zone the style's box lies wholly inside the guard, so the cut
  changes nothing. It stays a rectangle for the placement code; the button-column notch is left to
  the `safe-box` check.
- `PLATFORM_SAFE` (left 35, right 1045, top 220, bottom 1470) and `PLATFORM_BUTTONS` (left 945,
  right 1045, top 1164, bottom 1470): where TikTok and Instagram Reels leave text visible at
  1080x1920 (owner decision 2026-11-03 from a TikTok and Instagram safe-zone reference, replacing
  issue #114's 120, 840, 252, 1164). The platforms cover 220 px at the top, 35 px at each side and
  450 px at the bottom, and the button column on the right covers a further 100 px from y 1164
  down, so the visible area is `PLATFORM_SAFE` minus the `PLATFORM_BUTTONS` notch at its
  lower-right corner. The column's top (`PLATFORM_BUTTONS_TOP`, 1164) is measured from the
  reference drawing, which does not label it; it and the column's width
  (`PLATFORM_BUTTONS_WIDTH`, 100) are named constants the owner tunes by eye with the studio's
  Zones button. Module constants, not `Preset` fields: no preset and no change request moves them.
- Fonts: `primary` Raleway Light (`assets/fonts/Raleway-Light.ttf`, weight 300, 110 px) for
  accents, `secondary` Golos Text Bold (`assets/fonts/GolosText-Bold.ttf`, weight 700, 50 px) for
  captions.
- Captions: `#FFFFFF`, rise 12 px over 0.18 s (`power2.out`), fade out 0.15 s, at least 0.25 s on
  screen, a group breaks at a 0.35 s pause or after 4 units, fallback line y 1290 when no head is
  in the frame, line gap 14.
- Accents: `#B3E6FF`, 190 px above the head, y 1130 with no head, from the first word to 1 s
  (`afterSeconds`) after the last, at least 1.5 s (`minSeconds`). Slots beside the head (versions
  saved before the layout engine): first row 610, row gap 85, right drop 42, minimum left 110,
  minimum right 90.
- Layout (`layout`): text shrinks to 60% of its size (`minScale`) before it gives up a place, and
  keeps 12 px (`gap`) from the face and from other text.
- Transitions: `dim` (full frame, `rgba(0, 0, 0, 0.62)`, fade 0.3 s), `panel` (y 1150 to 1920,
  `#121212`, slide 0.5 s `power3.inOut`), `card` (full frame,
  `rgba(8, 8, 8, 0.9)`, fade 0.25 s). Their text areas end at 1400 and stop at x 860 (`dim` 1180 to
  1400, `panel` 1200 to 1400, `card` 640 to 1400), back at the approved reel's values (issue
  #114 had moved these, the fallback line and the accent's no-head line up to fit its smaller
  zone; owner decision 2026-11-03 to restore them). Every one fits `STYLE_SAFE`, `PLATFORM_SAFE`
  and stays left of `PLATFORM_BUTTONS`.
- Click sound: `assets/sounds/mouse-click-trimmed.wav`, 0.23 s, -13 dB, at least 0.25 s apart.
- Behind (`behind`, starting values the owner tunes by eye): photo spots `top` (left 90, right 990,
  top 160, bottom 760), `left` (40 to 500, 560 to 1180) and `right` (580 to 1040, 560 to 1180),
  each covered exactly by the photo. The big word: `secondary` font, at most 400 px, side margin
  40, `#FFFFFF`, its vertical centre 60 px below the head's top (`belowHeadTop`) or at y 700 with
  no head (`noHeadY`). The cut-out covers each item plus 3 frames on each side (`padFrames` at
  `frameRate` 30); an item lasts 2 s (`minSeconds`) to 4 s (`maxSeconds`).
- Caption units: kept capitals (`I`, `I'm`, `I've`, `I'll`, `I'd`, `AI`), a number joined with the
  unit after it, a month with its day number, and the glossary (`lock-in`, heard as `locking` or
  `lock in`).

### Builder contract

- `src/build.ts`: `build(edit, transcript, headTrack, preset, measurer) -> { html, assets, checks }`.
  `html` is a HyperFrames composition (`data-composition-id="main"`, a paused GSAP 3.14.2 timeline
  registered on `window.__timelines`); `assets` lists every referenced file with its role
  (`footage`, `font`, `sound`, `mask`, `photo`), sorted; `checks` is the layout check list. A
  `mask` asset carries its `cutout` ref at `maskPath(mask)` (`masks/<fingerprint>.mp4`); a `photo`
  asset has no ref, its `photoId` and the path `photoPath(id)` (`photos/<id>.jpg`).
- Deterministic: no clock, no randomness, no I/O. The same inputs give the same bytes in Node and in
  the browser. One builder serves the preview and the export.
- `src/measure.ts`: `createMeasurer(hb, fonts)` over the initialised `harfbuzzjs` module and the
  font bytes, both passed in by the caller (the worker's `apps/worker/src/edit-measurer.ts` reads
  them from `packages/edit/assets/`, once per process). The `Measurer` returns advance widths
  (`sum(x_advance) * size / upem`) and records every width it measured (`widths()`, what the
  goldens compare). The same wasm on the same font bytes gives identical widths everywhere.
- `src/layout.ts` (`layoutText`) turns every caption and accent into its measured box: an item with
  a `position` (everything the layout engine placed) keeps it, with its `size` and its two lines
  when it has `break_after` (rendered `first<br />second`, centred); an item without one (a version
  saved before the engine) gets the old fixed-spot placement, kept unchanged so stored versions look
  as they did. `src/html.ts` escapes text and attributes and formats numbers.
- `src/behind.ts`: `spotBox(spot, preset)` (the spot's rectangle), `placedBigWord` (a big word at
  its stored `position` and `size`, its width from HarfBuzz at 1 px), `bigWordLayout` (for a
  version saved before the engine: the big word
  as large as fits between the side margins, at most the preset's size and at least 8 px, centred
  across the frame, its centre below the head's top at the item's start or at `noHeadY`; its width
  from HarfBuzz at 1 px, so the measurer records it and the goldens cover it) and
  `maskSpans(edit, transcript, preset)`: each behind item's span padded by `padFrames`, clamped to
  the reel, widened to whole frames, overlapping or touching spans merged, sorted, to the
  millisecond. The builder (one composite per span) and the worker (one mask per span) both call
  it, so they always agree.
- Behind the speaker, one composite per mask span, above the footage and under transitions and
  text: an untimed isolated group (`.cutout`, id `cut_<n>`) holding a footage copy (`muted`,
  `data-media-start` equal to its `data-start`), the span's behind items (a photo `<img>` exactly
  over its spot, or the big word `<div>` at its measured size, each with its own start and
  duration as the hard cut), the mask inverted and multiplied (`.mask-under`, keeps the picture
  where the person is not), and an untimed `plus-lighter` sub-group (`.cutout-front`) of a second
  footage copy times the mask (the person back in front). Every layer is a plain timed element, so
  the player and the render's frame injector show the same pixels. A span with no matching entry
  in `inputs.masks` (start and end within half a millisecond) throws.

### The layout engine's input

- `src/engine-input.ts`: `EngineInput` is what the decide answer hands the layout: `accents`
  (word ranges, one may be the title), `big_word` (one word id or null), `photos` (a library id and
  a word range), `transitions` (a kind and a word range), `word_fixes` (a word id and its text), each
  with an optional `wish` from `WISHES` (`top`, `bottom`, `left`, `right`, `behind`, `beside_head`,
  `big`, `small`). No times, positions, sizes or spots.
- `choicesOf(edit, transcript, preset)` reads a version back as an `EngineInput` (what Claude is
  shown): each item by its anchor words, or the words spoken under it (an older version's written
  title); a caption whose text differs from its words is a fix on its first word. A photo reads back
  as the words it shows over, so the choices placed again place the same.

### Layout engine

`src/engine.ts`, `placeEdit(current, input, transcript, headTrack, preset, measurer, { requested })`
returns `{ tracks, record }`: the edit's tracks as the builder consumes them (every caption, accent
and big word with `position` and `size`, every photo with a `spot`) and the record of what it did.
Pure and deterministic: no randomness, no clock, no I/O; the same input gives the same tracks and
record. `editFromAnswer` (decide) and the worker's `first_version` step (with no choices) call it.

- Inputs: the current version (footage, sounds and captions kept; each word fix becomes the text
  of the caption showing that word; old positions and sizes are dropped), the answer's choices, the
  transcript with word times, the head track, the preset (safe box, fonts and sizes, transition
  text areas, behind spots as candidates) and the HarfBuzz measurer.
- Timing first (owner decision 6):
  - Captions: each from its own word; a group (consecutive captions ending on the same anchor)
    leaves at its last word's end, held so its last caption shows at least 0.25 s, never past the
    next group's start; a last caption that cannot show that long joins the next group.
  - Accent: from its first word to 1 s after its last, at least 1.5 s.
  - Big word: exactly on its spoken word, to the end of its sentence, 2 to 4 s; never before it.
  - Photo: from its sentence's start (from its first word when that is more than 1 s into a long
    sentence) to the sentence's end, 2 to 4 s, taking the pauses around a short sentence but never
    another sentence's words; dropped when that is under 2 s.
  - At most one extra (accent, big word or photo) at a time on top of the captions: a later extra
    may cut an earlier one short down to its minimum, or end itself before a later one down to its
    minimum; else it is dropped. Behind items never cross a hidden span of footage.
- Scene: the reel is cut into moments at every item edge; each moment's face is the bounding box
  of the robust faces around it (`facesOver` in `src/head-track.ts`: at each head-track sample, the
  samples within 0.5 s, `cx` their median, the width their upper quartile, the top their lower
  quartile, so one bad reading never moves it), padded like the old layout (35 px left, 30 px right)
  plus `gap` above and below. The body under the face (1.8 head widths wide, to the frame's bottom)
  is an obstacle for accents only: captions may sit on the chest, and the big word and photos sit
  behind the person by design. The mask itself is not read (it is a video).
- Free space (`src/engine-space.ts`): an area minus its obstacles (the moment faces over the item's
  time, the text already placed over it, the `PLATFORM_BUTTONS` notch) as the largest free
  rectangles (each rectangle an obstacle cuts becomes its parts left, right, above and below), and
  `placeBox`: the whole-pixel place nearest a wanted point where a box fits.
- Placement by priority:
  - Captions first, in time order, one spot per sentence (`sentenceSpans`): the sentence's groups
    all start at the same place, sized for its largest group (at most two lines per group);
    captions inside a transition take its text area as one block instead. Candidates: beside the
    head (the wider side first, aligned towards the face, near the mouth), below the face, the
    caption line (`fallbackY` to the safe bottom); with no head, the caption line then the safe
    zone. Every candidate is tried at the full size before a smaller one, down to the floor (60%),
    so captions stay readable. A sentence that shares its time with a planned photo first tries
    only places that leave the photo a spot.
  - Then the extras: the items the request checklist links (`requested`, item 5 strengthens this),
    then accents, the big word, photos, each in answer order.
  - Accent: above the head (its top about 190 px above the head), the upper part of the frame, the
    free part of the safe zone (with no head: the accent line at y 1130, then the safe zone); a
    `top`, `bottom`, `left`, `right` or `beside_head` wish goes first, `small` starts at 80%. In
    each candidate it shrinks to the floor and wraps to two lines (the balanced break) before it
    moves on.
  - Big word: as large as fits between the side margins (at most `maxSize`), its centre wanted
    `belowHeadTop` below the robust head top at its word (or at `noHeadY`), placed nearest that
    inside the frame (40 px margin) clear of every text shown with it, shrinking to the floor.
  - Photo: the wished spot, the spot it had, then `top`, `left`, `right`: the first spot the face
    leaves within `maxFaceShare` at every moment and no caption or accent covers over its span.
- Readability (`src/contrast.ts`, `src/background.ts`, `PlaceOptions.backgrounds`): the worker
  samples the footage into a background map (`BackgroundMap`: 2 frames a second, a 36 by 64 grid of
  30 px cells, each cell's WCAG relative luminance as a byte), and `backgroundSampler(map, frame)`
  answers `behind(box, span, textLuminance)`: the luminance of every cell the box touches in every
  sampled frame inside the span (the nearest frame when none is), at the 80th percentile towards
  the text's own luminance (nearest-rank, integers, so a few cells never decide), memoised per box,
  span and direction. Right after each caption block (not one inside a transition's text area) and
  each accent is placed, and after the big word, the engine measures the WCAG contrast ratio of the
  text colour against that background: below `preset.readability` `caption.min` (4.5) for captions
  or `large.min` (3) for accents and the big word, it first tries nearby places in the same zone (the
  chosen candidate's area, the same obstacles, size and line breaks; the original centre, then a
  60 px grid within 300 px) and moves to the nearest that reaches the threshold (rule
  `contrast-spot`, action `moved`); else it keeps the place and sets `shadow` (2 under `strongBelow`,
  else 1; rule `contrast-shadow`, action `shadowed`). The big word is never moved, only shadowed;
  a caption that already covers the face is shadowed, never moved. The shadow is dark under a light
  text and light under a dark one. With no `backgrounds` given the engine behaves as before. The
  colour is never changed. Example reason: `accent "What are you protecting?" gets a soft shadow
(level 2): contrast 1.6:1 from 3.20 s to 5.10 s, no free place nearby reaches 3:1`.
- Drops: an extra that fits nowhere is dropped and recorded. Captions are never dropped: with no
  free place even at the floor, they take the caption line over the face (recorded `covers-face`).
- Record: a list of `EngineNote` `{ item, action, rule, reason }`, `action` one of `moved` (not its
  kind's first place), `shrunk`, `wrapped`, `retimed`, `dropped`, `covers-face`, `wish-not-kept`, `shadowed`,
  `reason` in plain words with the item's text and times, for example
  `{ "item": "photo-1", "action": "dropped", "rule": "no-room", "reason": "photo 1: every photo spot
is under captions or the face from 23.48 s to 26.23 s" }`. Rules: `caption-min`, `caption-spot`,
  `caption-size`, `caption-face`, `accent-time`, `accent-spot`, `accent-size`, `accent-wrap`,
  `big-word-time`, `big-word-size`, `photo-time`, `photo-spot`, `hidden-footage`, `one-extra`,
  `no-room`, `wish`, `contrast-spot`, `contrast-shadow`. Saved with the version (`versions.engine_record`) and logged by the worker in
  one line per version; item 6 turns it into the summary.
- Final checks: `runChecks` (below) runs on every placed edit. They must never fail on the engine's
  output; one that does is an engine bug, logged with the reel id while the version is still saved.

### Bottom edge in the old layout

For versions saved before the engine only: `src/layout.ts` never places text below the safe box's
bottom (1400): a beside-the-head slot is
taken by a caption only if its row ends above the edge; a wrapped block (the fallback line,
below-the-face text, transition text) that would run past the edge moves up to end there (never
above the safe top); captions too wide for every slot go below the face when that fits, else above
the face when that stays under the safe top, else the block ends at the edge and the `face` check
reports it.

### Checks

`src/checks.ts`, `runChecks`, in a stable order, each failure `{ rule, item, reason }` with a
readable reason string (an empty list means every rule passes):

- `safe-box`: text inside `intersectBox(preset.safe, PLATFORM_SAFE)` and clear of
  `PLATFORM_BUTTONS`, so it holds whatever a preset says (the edge and value that run past the box,
  or `runs into the platform button column below y 1164` with the right edge past x 945).
- `frame`: a big word behind the speaker inside the frame (each edge that leaves it, and the
  word). It crosses the safe box by design, so it is never checked against it.
- `behind-face`, `behind-caption` (`app_docs/decide-step.md`): a photo's spot not taken over by
  the face, and no caption or accent over it.
- `face`: captions clear of the face (the robust faces, `facesOver`, at every moment of the
  caption's span, the same ones the engine avoids).
- `text-overlap`: no caption, accent or big word on another one shown at the same time.
- `timing`: captions at least `caption.minSeconds` (0.25 s) and accents at least
  `accent.minSeconds` (1.5 s) on screen.
- `big-word-timing`: the big word never shows before its word (the matching spoken word nearest
  its start) is said.
- `sound-gap`: two sounds at least the preset's gap (0.25 s) apart.
- `time-in-speech`: a time anchor outside speech (it names the word to anchor to instead).
- `out-of-reel`: an anchor that resolved outside the reel and was clamped.

### Versions and restore

- `src/versions.ts`: a version's `edit.json` lives at
  `${R2_KEY_PREFIX}reels/<reel_id>/versions/<version_id>.json` (`versionKey`), its bytes the
  canonical JSON of the edit (`editBytes`), written with put-if-absent; an existing key fails the
  save (versions are never rewritten). Then `rows.save` writes the row. `saveVersion` and
  `restoreVersion` take `{ rows, blobs, keyPrefix, newId }`, so the package needs no randomness.
- Restore never rewrites history: `restoreVersion` creates a new version copying the old one's
  bytes, inputs and checks, its parent the current version, `restored_from_id` the old one and
  change summary `Back to how v<n> looked` (no change title; the versions list titles it `Back to
v<n>`). Restores saved before read `restored version <n>`.
- `apps/worker/src/version-store.ts`: `supabaseVersionRows(db)` (`current` reads
  `reels.current_version_id`, `get` reads named columns, `save` calls the `save_version` RPC) and
  `storageVersionBlobs(storage)` (JSON, put-if-absent).
- `supabase/migrations/20261101153653_versions.sql`: table `versions` (`id`, `reel_id`,
  `owner_id`, `number`, `parent_id`, `restored_from_id`, `request`, `model`, `prompt_version`,
  `change_summary`, `checks`, `inputs`, unique `r2_key`, `created_at`; later `change_title`, see
  `app_docs/decide-step.md`). Parent and restored-from
  must be versions of the same reel. `reels.current_version_id` names the current one. Trigger
  `versions_refuse_update` refuses every update, even for the service role; rows go only with their
  reel (cascade). Owner-only `select` RLS for `authenticated`, no `anon` access, in the
  `supabase_realtime` publication.
- `save_version(...)` (security definer) locks the reel, refuses a parent that is not the reel's
  current version (a stale or concurrent save), inserts the row with the reel's owner and the next
  `number`, makes it current and returns the number, in one transaction. Only `service_role` may
  execute it.

### First version

`src/baseline.ts`, `baselineEdit(transcript, { inputs, duration }, preset)`: the automatic first
version from the preset alone (no AI): footage over the whole reel plus captions, one caption per
word or unit, starting on its own word and ending on the last word of its group; no positions
(the builder fills them), no accents, transitions or sounds.

`apps/worker/src/first-version.ts`, the `first_version` step after the five pipeline steps: reads
the retimed `transcript.json` and `retime.json` and the `head-track.json` by their fingerprints,
builds the baseline, places it with the layout engine (no choices: captions only, every caption
with its `position` and `size`), runs `build` for its checks and saves version 1 (`request`,
`model` and `prompt_version` null, change summary `automatic first version from the issebya
style`) with the engine record, logged in one line. Its step
line is `version 1 saved, <time>, <size>`. A reel that already has a version (a retried job) keeps
it: a hit, `first version kept, reused`, nothing written. Failed checks are stored on the row,
never fatal.

### Cross-environment test and negative proof

- `src/testdata/versions/` holds the stored fixture versions: `baseline-short-speech.edit.json`
  (the baseline over `fixtures/pipeline/`, placed by the engine as `first_version` saves it),
  `rethink-work-engine.edit.json` (the behind edit's choices placed by the engine, placeholder
  masks; every check passes) and `rethink-work-hand.edit.json` (by hand, with
  accents, the `panel` transition and a click), with `src/testdata/rethink-work/` (its transcript
  and real head track), and `rethink-work-behind.edit.json` (the hand edit with a `top` photo and
  the big word `WORK` behind the speaker, two masks with placeholder fingerprints and one photo id
  in `inputs`) on the same data. `src/test-support/fixtures.ts` imports them as JSON modules so
  both runs build exactly the same inputs.
- `src/build.test.ts` (Node, `measurer.node.ts`) and `src/build.browser.test.ts` (Chromium,
  `measurer.browser.ts`, the same wasm and fonts fetched from the test server) build every fixture
  and compare the page and the widths with the committed goldens in `src/testdata/golden/` byte for
  byte. The Node test also builds each fixture twice and expects the same result.
- Negative proof: during the run a temporary probe (never committed) swapped the browser
  measurer for canvas `measureText` with the same fonts loaded through `FontFace`; the browser
  comparison then failed, so the test detects a measurer that differs from HarfBuzz.
- `scripts/golden.ts` (`yarn workspace @edit-issebya/edit golden`) rewrites the two engine-placed
  fixture versions and every golden from the Node build. Commit what it writes. The hand-made
  versions keep their goldens: stored versions are never placed again.

## Testing

- `yarn turbo run test --filter=./packages/edit`: the `node` and `browser` Vitest projects
  (`vitest.config.ts`); the browser project needs Install step 3's chromium. `turbo.json` passes
  `PLAYWRIGHT_*` and `CI` through. Also schema, timeline, checks, baseline and versions tests, a
  build of the 50-second hand edit under 200 ms, and `src/behind.test.ts` (spots, the big word's
  size and place, mask spans padded, clamped and merged). The `rethink-work-behind` golden is
  compared in both projects.
- `apps/studio/db-tests/versions.test.ts` under `yarn test:db`: `save_version`, version
  immutability and its RLS.
- `apps/worker/src/first-version.test.ts` (version 1 saved, kept on a retry) and
  `apps/worker/src/edit-import.test.ts` (Node imports the package's TypeScript source).
- `src/engine.test.ts`: each timing rule (captions, accents, the big word, photos, drops under the
  minimum, one extra at a time, the request's items first), no check failing on a dense reel (a
  title, four accents, the big word, two photos and a panel) with the real head and with a large
  centred face, one spot per sentence, the big word on its word and inside the frame with one bad
  head reading, a long title shrunk and wrapped (and one too long dropped), captions over a face
  that fills the safe zone recorded, today's failures (two accents in a row, captions on the big
  word, card captions on the face, a photo whose sentence's captions filled every spot, a photo
  with no free spot dropped with its reason), determinism, and the engine placing its own output
  the same again. `src/checks.test.ts` also shows the new checks finding the old fixed-spot
  placement's faults in the hand-made versions.
- `src/preset.test.ts` (the intersection, the preset's box, every moved value inside it, the
  no-head big word inside the guard vertically), `src/layout.test.ts` (low face, a fallback block moved
  up and large captions end at or above the safe box's bottom, 1400) and `src/checks.test.ts` (a
  caption at y 1380 fails `safe-box`, and one at y 1450 under a looser preset; under that preset
  a caption right-aligned at x 1040 fails in the button column at y 1204 and passes at y 1064; no
  stored fixture's text leaves the guard).
- E2E: `apps/studio/e2e/upload.spec.ts` ends with `first_version: version 1 saved, ...`, the
  version row and its R2 key checked.

## Rules

- Never change a version: no update, no rewrite of its key. History is never rewritten; going back
  creates a new version.
- Never write a version key twice (put-if-absent, an existing key fails the save).
- Never let anything but the service role execute `save_version`.
- One builder for preview and export; never fork it per environment.
- Never store a built page; versions hold the edit, the page is built from it.
- Anchors are words; seconds only where nobody speaks.
- Claude never writes times, positions or sizes: every one in a decided version comes from the
  layout engine, never from the answer.
- Never let text overlap text, or a photo sit under a caption or an accent: the engine places
  nothing on what is already placed, and `text-overlap` and `behind-caption` guard it.
- Never drop a caption; only extras (accents, the big word, photos) are dropped, each with a
  recorded reason.
- Never read a single head-track sample for a placement or a check: always the robust faces
  (`facesOver`).
- Never show more than one extra at a time on top of the captions, or the big word before its
  word.
- Never place a stored version again: the builder keeps every stored position, and a version saved
  before the engine keeps the old fixed-spot placement.
- The engine is pure and deterministic: no randomness, no clock, no I/O.
- Never change a text colour to make it readable: move it or add a shadow.
- Never move the big word for contrast; it only gets a shadow.
- A version with a `behind` item is saved only once every mask it names exists; the builder never
  builds a behind item without its mask.
- A big word is checked against the frame, never the safe box.
- Text never enters the platform zones: `PLATFORM_SAFE` and `PLATFORM_BUTTONS` are a guard, never
  a preset value, and no preset or change request moves them.
- Never rewrite a stored version to fit the guard; it shows its failed check.
- A version names a library photo by its id, never by its storage key.
- Nothing Node-only or browser-only in `packages/edit`; the caller injects the platform.
- Never commit an asset without its licence (`assets/fonts/OFL-*.txt`,
  `assets/sounds/LICENSE-sounds.md`).

## Notes

- The `number` column was added beyond the issue's list: it gives the per-reel "version N", and
  `unique (reel_id, number)` doubles as a guard against two concurrent saves.
- The studio imports only types from the package until slice 9.
- The fixture clip has no person, so the face rule is proven with a synthetic head track
  (`src/checks.test.ts`) and the `rethink-work` data.
