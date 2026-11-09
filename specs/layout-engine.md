# Layout engine: variants as data, one placement loop

Design spec for the rebuilt layout engine of the reel studio (owner decisions of 2026-11-09). Nothing
here is built yet; `app_docs/edit-model.md` describes what the code does today. This file is the plan
and the record of what was agreed, so a later reader can tell a decision from an open point.

Branch: `feat/engine-simplify`. Code: `packages/edit/src/engine.ts` (2689 lines today),
`engine-space.ts`, `engine-input.ts`, `preset.ts`, `behind.ts`, `head-track.ts`, `checks.ts`,
`transitions.ts`, `measure.ts`; the record in `versions.engine_record`
(`supabase/migrations/20261103230327_version_engine_record.sql`, `apps/worker/src/engine-record.ts`).

## Why

The engine today is a set of per-component special cases:

- an accent goes above the head, a big word at the head top, a visual to a corner, the hook to the
  upper part; each has its own candidate list written in code (`placeAccent`, `placeHook`,
  `placeBigWord`, `placeVisual`, `placeLevels`, `placeBlock`);
- each kind has its own tier ladder (clear of face and text; then over the face; then over text at
  the default spot), its own size ladder (`sizesFrom`, 10% steps to a 60% floor, with exceptions
  down to 8 px for the hook and an accent's default spot) and its own line cap (two);
- text picks show one at a time (`oneTextAtATime`, `text-one-at-a-time`), so a LIST item and a big
  word far apart on screen still cut each other;
- readability moves text around after it is placed (`keepReadable`, `readablePlace`).

It already strains with one variant per component. Several variants per component (a second accent
look, a big word in front, a captioned card) would multiply the branches.

Goal: variants are data, the engine is one generic loop, and a rule is added only when a real reel
shows the need.

## Pipeline

```
curator LLM  ->  variant picker  ->  engine (timing, then placement)  ->  edit + engine record
 (meaning)      (pick -> variant)     (positions, sizes, times)          (versions.engine_record)
```

1. The curator LLM (the decide step, `apps/worker/src/decide/`) picks components by meaning, as
   today: HOOK (its own call), ACCENT, QUESTION, BIGWORD, VISUAL, LIST with `lists[].items[]`
   (`packages/edit/src/decide.ts`, `EngineInput` in `engine-input.ts`). Word ids only, never a time,
   position, size or spot.
2. A variant picker, a new separate module, maps each pick to one variant entry. One variant per
   component for now, so the picker is a lookup table; it is the one place a later picker (by
   intensity, by reel, by the LLM) plugs in.
3. The engine: timing from the words, then placement in one loop over every element.
4. Output: the edit's tracks (every caption, overlay, level and behind item with its position, size
   and times) and the engine record.

## What the engine knows

| Input              | Today                                                                                     | Used for                                |
| ------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| Transcript words   | `Transcript`, `words[{ id, text, start, end }]`                                           | timing of every element, caption text   |
| Head track         | `HeadTrack`, robust face per moment (`facesOver`)                                         | zones (above-head, beside-face, ...)    |
| Person mask        | `inputs.masks` (made by the worker after placement)                                       | behind variants only (the cut-out)      |
| Platform zones     | `PLATFORM_SAFE` 35..1045 x 220..1470, `PLATFORM_BUTTONS` 945..1045 x 1164..1470           | hard rule 1                             |
| Fonts and measurer | `primary` Raleway Light 300, `secondary` Golos Text Bold 700; `createMeasurer` (HarfBuzz) | exact width at any size                 |
| Cut footage spans  | `tracks.footage[].hidden`                                                                 | a behind item never over a cut          |
| Frame size         | 1080 x 1920 (`preset.frame`)                                                              | every box                               |
| The picks          | `EngineInput`                                                                             | what to place                           |
| The variants       | the registry (new)                                                                        | how each pick looks and where it may go |

Not used: the background luminance map (`backgrounds.json`, `backgroundSampler`). Readability is out
for now (see "Readability").

## Variants as data

A variant entry holds only what the engine cannot compute. No sizes, no pixel positions.

| Field       | Meaning                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `component` | HOOK, ACCENT, QUESTION, BIGWORD, VISUAL, LIST, or CAPTION (the non-component element)                |
| `variant`   | the entry's name                                                                                     |
| `layer`     | `front` (over the footage, in front of the speaker) or `behind` (behind the speaker, needs the mask) |
| `type`      | `text` or `box`                                                                                      |
| `style`     | font role (`primary`, `secondary`) and colour; for a LIST, one per level. No size.                   |
| `zones`     | the ranked list of named zones it may take, best first                                               |
| `timing`    | how its span comes from its words                                                                    |
| `hides`     | whether its words leave the captions while it shows (`hidden_by`)                                    |
| `aspect`    | a box's width over height; text has none                                                             |

### Zones

A zone is a named area the engine computes per moment from the head track and the safe zone. Every
zone is cut to the safe zone `S` (`PLATFORM_SAFE` minus the `PLATFORM_BUTTONS` notch), so hard rule 1
holds by construction. `F` is the face over the element's span: the bounding box of the robust faces
(`facesOver`, `head-track.ts`), padded 35 px left and 30 px right (`LAYOUT_PADDING`) and
`layout.gap` (12 px) above and below. `gap` is 12 px. Each zone has a wanted point; of the spots that
fit, the one nearest it wins (as `placeBox` in `engine-space.ts` does today: ties to the higher, then
the further left).

| Zone                    | Area                                                                                                               | Wanted point                                                                    | No head in the moment                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `above-head`            | `S` above `F.top - gap`                                                                                            | centre x of `S`, 190 px above `F.top` (`accent.aboveHead`)                      | the accent line, y 1130 (`accent.noHeadY`), centred |
| `upper-third`           | the top third of `S`                                                                                               | top centre of `S`                                                               | the same                                            |
| `beside-face`           | the strips of `S` left and right of `F`, from `F.top` to `F.bottom + 120`                                          | towards the face, at the mouth (0.7 of the face's height); the wider side first | zone absent                                         |
| `below-face`            | `S` below `F.bottom + gap`                                                                                         | under the face's centre, just below it                                          | zone absent                                         |
| `caption-line`          | `S` from y 1290 (`caption.fallbackY`) down                                                                         | centre x, y 1290                                                                | the same                                            |
| `corner`                | the four corners of `S`, inset 40 px (`card.inset`): top-left, top-right, bottom-left, bottom-right, in that order | the corner itself                                                               | the same                                            |
| `head-top`              | the full width of `S` (today: the frame with a 40 px margin, see Open questions)                                   | centre x; vertical centre 60 px below `F.top` (`word.belowHeadTop`)             | y 700 (`word.noHeadY`)                              |
| `anywhere-in-safe-zone` | all of `S`                                                                                                         | the centre of `S`                                                               | the same                                            |

These are the zones the current variants need; a new variant that needs another zone adds it here
with its derivation.

### Sizes and wrapping

Sizes are not in the variant. For a text, the engine computes the largest size at which the text fits
the spot, measured with HarfBuzz (`measurer.width(font, size, line)`), down to ONE global minimum text
size (the value is an open question; today the schema's `MIN_TEXT_SIZE` is 8 px and the per-kind
floors are 60% of 110 px and 50 px). Wrapping is free: any number of lines, balanced breaks
(`balancedBreak` today), line height the size (plus `caption.lineGap` 14 px between caption lines).
For a box, the entry gives the aspect; the size question is open (see Open questions).

### The entries

One variant per component today. Values are the current preset's, named so they can be read back to
`preset.ts`.

| Entry                | `component` | `layer`  | `type` | `style`                                                                                       | `zones` (best first)                                                 | `timing`                                                                                                                                                | `hides`              | `aspect`                                      |
| -------------------- | ----------- | -------- | ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------- |
| `hook/written-line`  | HOOK        | `front`  | text   | `primary`, `#FFFFFF`                                                                          | `upper-third`, `anywhere-in-safe-zone`                               | the pace window: 0.2 s to 3 s (`pace.hook`), cut to the reel's end                                                                                      | no (nobody says it)  | none                                          |
| `accent/above-head`  | ACCENT      | `front`  | text   | `primary`, `#FFFFFF`                                                                          | `above-head`, `upper-third`, `anywhere-in-safe-zone`                 | first word's start to last word's end, no lead, no minimum                                                                                              | yes                  | none                                          |
| `question/as-accent` | QUESTION    | `front`  | text   | `primary`, `#FFFFFF`                                                                          | `above-head`, `upper-third`, `anywhere-in-safe-zone`                 | as an accent                                                                                                                                            | yes                  | none                                          |
| `bigword/behind`     | BIGWORD     | `behind` | text   | `primary`, `#FFFFFF`                                                                          | `head-top`                                                           | 0.2 s lead before its first word (`accent.leadSeconds`), to its last word's end, at least 1.5 s (`accent.minSeconds`)                                   | yes                  | none                                          |
| `visual/card`        | VISUAL      | `front`  | box    | white stroke 8 px (`card.stroke`), no fill                                                    | `corner`, `beside-face`                                              | first word's start to last word's end, 1 to 2 s (`behind.minSeconds`, `maxSeconds`)                                                                     | no                   | 4:5 (360 x 450 at a third of the frame today) |
| `list/numbered`      | LIST        | `front`  | text   | levels: `number` `primary` `#FFFFFF`, `lead` `secondary` `#FFFFFF`, `key` `primary` `#FFFFFF` | `upper-third`, `anywhere-in-safe-zone`                               | 0.3 s entrance (`transitions.numbered.seconds`) before the item's first word, to its last word's end; each level from its own first word                | yes                  | none                                          |
| `caption/default`    | CAPTION     | `front`  | text   | `secondary`, `#FFFFFF`                                                                        | `beside-face`, `below-face`, `caption-line`, `anywhere-in-safe-zone` | caption groups as today: a group leaves at its last word's end, held so its last caption shows 0.25 s (`caption.minSeconds`), never past the next group | (they are the words) | none                                          |

Notes on the entries:

- QUESTION is the ACCENT entry under another component name. That is the point of variants as data:
  the engine has no QUESTION branch.
- The hook's `timing` is its window, not words. Without the one-text-at-a-time rule (below) it runs
  its full window; a text pick said inside it is placed around it, not instead of it.
- The LIST entry places one item; its three levels are one stacked element (how they sit relative to
  each other is an open question). The number shows only in a list of two or more items; numbering
  restarts at 1 in each list (as today).
- Captions are an element like the others, with their own entry, placed last.

## Hard rules

Never broken. A candidate spot that breaks one is not a candidate. The element itself is never thrown
away for a rule (see "No legal spot").

1. Everything stays inside the safe zone (`PLATFORM_SAFE`) and off the buttons column
   (`PLATFORM_BUTTONS`).
2. Captions are always visible: nothing covers a caption.
3. Everything spoken is on screen, as a caption or inside a component (the caption split in time by
   `hidden_by`, as today).
4. The same text never shows twice at the same moment (the `same-text` pass and the `same-text`
   check, as today).
5. Text never overlaps text: captions, HOOK, ACCENT, QUESTION, BIGWORD, LIST levels, with
   `layout.gap` (12 px) between them. Text may sit on top of a VISUAL.
6. BIGWORD (behind variant): the head hides at most 30% of its height (`word.minVisible` 0.7,
   `bigWordCoveredShare` in `behind.ts`, the face only, over the whole span).

## Soft rules

Costs. The cheapest legal candidate wins; the most avoided first.

| Cost                  | What it charges                                                                                                                                | Starting value (a tuning value)                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| covers the face       | the element's box overlaps `F` in any moment of its span (the behind big word is exempt: it is behind the speaker by design, rule 6 bounds it) | 100                                                                     |
| down the zone ranking | one step down the variant's `zones`                                                                                                            | 10 per step                                                             |
| shrinking             | one step of 10% below the element's full size (the largest size that fits its first zone with no obstacles)                                    | 10 per step, so a step down the ranking and a shrink step cost the same |
| wrapping              | more lines                                                                                                                                     | 0                                                                       |

Tie-break, in order: the earlier zone, the larger size, fewer lines, the higher spot, the further left
spot. Deterministic by construction.

These numbers are a proposal. They are tuned on real reels, never by reasoning alone.

## The loop

### Timing first

Each element's span comes from its words and its entry's `timing`:

- Captions: groups as today (`captionGroups`), a group leaving at its last word's end, held to
  `caption.minSeconds`.
- ACCENT, QUESTION: exactly their words. A pick with no length at all shows the shown floor
  (`SHOWN_FLOOR_SECONDS`, 0.5 s) from its start, earlier where the reel ends (`clamped-to-end`).
- BIGWORD: the 0.2 s lead, never before 0, to its last word's end, at least 1.5 s; at the reel's end
  the start moves earlier so it shows (`clamped-to-end`).
- VISUAL: its first word to its last word's end, 1 to 2 s, `clamped-to-end` at the reel's end.
- LIST item: 0.3 s before its first word (never before 0) to its last word's end.
- HOOK: 0.2 s to 3 s, cut to the reel's end (`hook-time`).
- A behind item over a cut footage span moves to the next visible moment (`moved-off-cut`), as
  today.
- Then the same-text pass (rule 4): of two text picks on screen together that share a word id, a big
  word keeps it, else the earlier; the other is trimmed to its own words or dropped (as today, the
  one drop there is). Then the caption split: a caption's words a component with `hides` shows are
  left out while it shows (`hidden_by`, pieces `-2`, `-3`, ...).

There is no one-text-at-a-time rule. Two elements conflict only when they overlap on screen at the
same moment. A LIST item "what we do" at the upper third and a BIGWORD "AI" at the head top, far
apart on screen, both stay for their whole spans.

### The scene

The reel is cut into moments at every element edge (`sceneOf`). Each moment has its face (the robust
faces around it, `facesOver`). An element's `F` is the bounding box of the faces over its span.
"Overlap at the same moment" means two placed boxes overlap and their spans share a moment.

### Placement

Order: components first, captions last in the space left. The order among the components is open
(see Open questions).

For each element:

1. Enumerate candidates: for each zone in its ranking, for each line count (1 up to its word count,
   balanced breaks), twice (the face as an obstacle; the face allowed, at the face cost): the largest
   size at which the wrapped text fits a free rectangle of the zone, and the spot nearest the zone's
   wanted point (`freeRects`, `placeBox`). Obstacles: the notch, and every element already placed
   whose span shares a moment with this one, expanded by `gap`, except a VISUAL for a text (rule 5).
   A box variant enumerates its zones the same way at its aspect.
2. Skip candidates that break a hard rule: below the global minimum size (none fits), over a caption
   (rule 2, captions are placed last so this is a check on the caption's own candidates), text over
   text (rule 5, the obstacles above), a big word the face hides more than 30% of (rule 6).
3. Score the rest by the soft costs. Take the cheapest; tie-break as above.
4. Write the element with its position, size, lines (`break_after` today holds one break: see Open
   questions) and span, add its box to the obstacles over its moments, and record a note.

Candidates per element are bounded: zones (at most 8) x line counts (the word count) x 2. The sizes
need no ladder: each cell's size is the largest fit, found by the measurer (a text's width scales
linearly with size, so one measurement per line gives the fit).

Deterministic: same input, same output. No clock, no randomness, no I/O (as today).

## No legal spot

Rare: a moment so crowded that a component has no candidate that keeps the hard rules at or above the
global minimum size. Out of scope for now. The spoken words still show as captions (rule 3). The
engine writes a structured note with outcome `no-spot` and the blockers that took the space. What
happens to the element in that version is for the owner to decide on a real reel (see Open
questions).

## What the engine records

Structured notes, saved with the version in `versions.engine_record` (jsonb array, no migration: the
column takes any array) and logged by the worker in one line (`engineRecordLine`). No PostHog events
for now. The shape is made so a judge can later run over the notes of many versions.

```ts
interface EngineNote {
  item: string; // "hook", "accent-1", "question-2", "big-word-1", "visual-1", "transition-3", "w0012" (a caption)
  component: "HOOK" | "ACCENT" | "QUESTION" | "BIGWORD" | "VISUAL" | "LIST" | "CAPTION";
  variant: string; // the entry's name, "accent/above-head"
  start: number; // the placed span, seconds
  end: number;
  rule: string; // what the note is about: "zone", "size", "face", "safe-zone", "same-text", "timing", "hidden-footage", "no-spot"
  outcome:
    | "placed" // its first zone, full size, no cost
    | "moved" // a zone down the ranking
    | "shrunk" // below its full size
    | "wrapped" // more than one line
    | "covers-face"
    | "retimed" // clamped-to-end, moved-off-cut, trimmed by same-text
    | "dropped" // same-text left no word of its own
    | "no-spot";
  blockers: Blocker[]; // what took the space it did not get
  zone?: string; // the zone taken
  size?: number; // the size taken
  lines?: number;
  cost?: number; // the candidate's total cost
  reason: string; // plain words for people, with the text and times
}

type Blocker =
  | { kind: "caption"; id: string }
  | { kind: "item"; id: string } // another component, by item id
  | { kind: "face" }
  | { kind: "safe-zone"; edge: "left" | "right" | "top" | "bottom" }
  | { kind: "buttons" };
```

- Every element gets at least one note (`placed` when nothing was given up), so a judge sees what
  was placed, not only what moved.
- One note per outcome: an element shrunk and moved has two notes with the same `item`.
- `reason` stays as today: `the accent "lock-in" moves to the upper third from 3.20 s to 4.10 s; the
face took above the head`.
- Records saved before this change keep their `{ item, action, rule, reason, with }` shape and are
  read as stored (the trace already does this for older note kinds).
- The checks read the record: the `face` check excuses a caption whose note has outcome
  `covers-face`; the `text-overlap` check no longer has a `kept-overlapping` pair to excuse (rule 5
  is hard), so it is strict.

## Readability

Out for now: no contrast measurement, no background map, no move for contrast. A shadow or a stroke
may come later if a real reel needs it (today's rule "never a shadow" is lifted with it; it is not a
rule of this design).

This removes, in `packages/edit`: `contrast.ts` and `background.ts` (`backgroundSampler`,
`BackgroundMap`, `BACKGROUND_GRID`, their exports in `index.ts`), `PlaceOptions.backgrounds`,
`keepReadable`, `readablePlace`, `contrastOf`, the notes `contrast-spot` and `contrast-stay`
(`low-contrast`), `preset.readability` (4.5, 3, 300, 60) and `preset.behind.edge` (1.5, 30), and the
"readable text" engine tests. In `apps/worker`: the `ensureBackgrounds` calls in `first-version.ts`
and `decide/run-decide.ts` (the `backgrounds` step itself is an open question).

## What changes from today

| Today (`engine.ts` and friends)                                                                                                                                                                                                                                               | New model                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Deleted**                                                                                                                                                                                                                                                                   |                                                                                                   |
| per-kind placers: `placeAccent`, `placeHook`, `placeBigWord`, `placeVisual`, `placeLevels`, `placeBlock`, `cardSpots`                                                                                                                                                         | one `place(element, variant)`                                                                     |
| per-kind tier ladders (clear; over the face; default spot over text) and `noteOverlap`'s `all-picks`                                                                                                                                                                          | hard rules filter, soft costs rank                                                                |
| `sizesFrom`, `layout.minScale` (0.6), the 8 px exceptions, `card.smaller` (0.7)                                                                                                                                                                                               | largest fit per spot, one global minimum                                                          |
| two-line caps (`maxLines: 2`, `wraps`)                                                                                                                                                                                                                                        | any number of lines, cost 0                                                                       |
| `oneTextAtATime`, `text-one-at-a-time`, `transition-entrance`, the hook cut by a later text                                                                                                                                                                                   | none: conflicts are screen overlaps                                                               |
| `kept-overlapping` (text over text) and the `text-overlap` check's excuse                                                                                                                                                                                                     | rule 5 is hard; the check is strict                                                               |
| readability (see above)                                                                                                                                                                                                                                                       | none                                                                                              |
| hand-picked sizes and spots in `preset.ts`: `fonts[].size` as the start of a ladder, `behind.word.maxSize`, `behind.spots` (`top`, `left`, `right`), `spot` on a VISUAL, `transitions.numbered.want`, `numberSize` (see Open questions), `behind.maxFaceShare` (unread today) | zone derivations hold the pixel offsets (190, 60, 1290, 700, 40, 120); the variant holds the rest |
| `EngineAction` and `EngineNote.with`                                                                                                                                                                                                                                          | the new note shape                                                                                |
| **Kept**                                                                                                                                                                                                                                                                      |                                                                                                   |
| the HarfBuzz measurer (`measure.ts`)                                                                                                                                                                                                                                          | the one source of text width                                                                      |
| the robust face (`facesOver`, `boundingBox`, `LAYOUT_PADDING`)                                                                                                                                                                                                                | the zones' `F`                                                                                    |
| `PLATFORM_SAFE`, `PLATFORM_BUTTONS`, `intersectBox`                                                                                                                                                                                                                           | the safe zone `S`                                                                                 |
| free space (`freeRects`, `placeBox`, `overlaps`, `expand` in `engine-space.ts`)                                                                                                                                                                                               | the candidate enumerator's core                                                                   |
| the same-text pass (`sameTextPass`) and check                                                                                                                                                                                                                                 | rule 4                                                                                            |
| the caption split by time (`splitCaption`, `hidden_by`, `hiddenCaptionIds`)                                                                                                                                                                                                   | rule 3                                                                                            |
| caption grouping (`captionGroups`), `sentenceSpans`                                                                                                                                                                                                                           | caption timing (the block question is open)                                                       |
| timing helpers: `transitionTiming`, `ownSpan`, `floorSpan`, `visibleSpan` (`moved-off-cut`), `clamped-to-end`, `anchorAt`                                                                                                                                                     | the timing stage                                                                                  |
| `bigWordCoveredShare`, `maskSpans`, `needsCutout`, `placedBigWord`                                                                                                                                                                                                            | rule 6 and the behind layer                                                                       |
| `clicksFor` (`clicks.ts`)                                                                                                                                                                                                                                                     | unchanged: a click per VISUAL and BIGWORD                                                         |
| `choicesOf`, the edit format (`schema.ts`), the builder, versions                                                                                                                                                                                                             | unchanged; `break_after` may need more than one break (open)                                      |
| **New**                                                                                                                                                                                                                                                                       |                                                                                                   |
| variant registry (`variants.ts`, data only)                                                                                                                                                                                                                                   | the entries above                                                                                 |
| variant picker (`variant-picker.ts`, one variant per component)                                                                                                                                                                                                               | pick to entry                                                                                     |
| zone computation (`engine-zones.ts`)                                                                                                                                                                                                                                          | the zone table                                                                                    |
| candidate enumeration and scoring (`engine-place.ts`)                                                                                                                                                                                                                         | the loop                                                                                          |
| the note shape with `component`, `variant`, `start`, `end`, `outcome`, `blockers`                                                                                                                                                                                             | the record                                                                                        |

## Build order

Small steps. Each ends in one commit with its tests and the doc update (`app_docs/edit-model.md`,
"Layout engine"; `docs/conditional-docs.md` when a file moves), each leaves the worker working
(`yarn test` green, the goldens re-derived with `yarn workspace @edit-issebya/edit golden` and
committed). Do not start building from this file; each step gets its own go-ahead.

1. The note shape. Add `component`, `variant`, `start`, `end`, `outcome` and `blockers` to
   `EngineNote` beside today's fields, written by the current engine; `engineRecordLine` prints them;
   the checks read `outcome` and `blockers` instead of `action` and `with`. Old records read as
   stored.
2. Zones. `engine-zones.ts`: the zone table as code, `zonesAt(name, S, F)`; unit tests per zone with
   and without a head. Not yet called by the engine.
3. Variants. `variants.ts` with the seven entries and `variant-picker.ts`; `placeEdit` takes the
   picked variants and ignores them for now; `editFromAnswer` and `first_version` call the picker.
   Tests: one entry per component, the picker total.
4. The placer. `engine-place.ts`: candidates, hard filters, costs, tie-break, over a given obstacle
   set; unit tests on synthetic scenes (a crowded upper third, a face filling the zone, a word that
   fits nowhere). Not yet called.
5. ACCENT and QUESTION through the placer; `placeAccent` deleted; goldens re-derived.
6. HOOK and LIST levels through the placer; `oneTextAtATime` and `transition-entrance` deleted (the
   hook runs its window); `placeHook` and `placeLevels` deleted.
7. BIGWORD through the placer with rule 6 as a hard filter; `placeBigWord` deleted; the `frame` check
   follows the safe-zone decision (open question 2).
8. VISUAL through the placer as a box; `placeVisual`, `cardSpots`, `behind.spots`, `spot` deleted
   (the schema keeps `spot` optional for stored versions).
9. Captions through the placer; `placeBlock`, `captionCandidates`, `sizesFrom`, `layout.minScale`
   deleted; the global minimum set (open question 3); `text-overlap` made strict.
10. Readability removed (the list under "Readability"); the worker's `ensureBackgrounds` calls gone.
11. Clean-up: `engine.ts` split into timing, scene and the loop; dead preset fields removed; the
    "Layout engine" section of `app_docs/edit-model.md` rewritten from this spec; `.adw/project.md`
    if a path changed.

## Open questions

Each one line, with a recommendation. None is decided here.

1. Which safe zone is the hard rule: `PLATFORM_SAFE` minus the notch, or the style's tighter box
   `STYLE_SAFE` (130..860 x 260..1400) that text uses today? Recommendation: `PLATFORM_SAFE` minus
   the notch, one zone for everything; the style box goes.
2. Does the behind big word obey rule 1? Today it uses the frame with a 40 px margin (down to y
   1880, checked by `frame`, "crosses the safe box by design"). Recommendation: yes, rule 1 says
   everything; `head-top` is cut to `S` and the `frame` check becomes `safe-box` for it.
3. The global minimum text size value. Today: the schema's 8 px, caption floor 30 px (60% of 50),
   accent floor 66 px. Recommendation: 30 px (a caption's floor, the smallest text we show today);
   the schema's 8 px stays the format's bound.
4. Caption block versus sentence grouping: today one spot per sentence (`sentenceSpans`, a 0.6 s
   pause or `.?!`), sized for the sentence's largest group, two lines at most. Recommendation: the
   element is the sentence block (so captions do not jump mid-sentence), its lines free; the block's
   size is the largest at which every group fits.
5. How a LIST item's levels sit relative to each other. Recommendation: one stacked element (number,
   lead, key, `transition.gap` 24 px between, centred), placed once; a stack that fits nowhere whole
   is a `no-spot`, not three separate placements.
6. The LIST number's size: computed "largest fit" would blow a one-digit number up to the zone; today
   it is 300 px (`numberSize`). Recommendation: the number at a fixed ratio to the key level in the
   entry's style (a ratio, not a size); starting ratio 300/110.
7. A box's size: the entry gives only the aspect, and a corner zone with nothing in it would make a
   huge card. Recommendation: a box entry carries its full width as a share of the frame
   (`widthShare` 1/3, 360 x 450), the one size no text can give; shrinking from it costs as for text.
8. The order the components are placed in (today: list levels, hook, then answer order).
   Recommendation: by start time, ties by the answer's order; the hook comes first by its start.
9. Is a text an obstacle to a VISUAL placed after it (today a card avoids every text)? Rule 5 lets
   text sit on a VISUAL. Recommendation: no obstacle either way; the card draws under the text, and
   captions placed last keep rule 2.
10. What happens to a `no-spot` element in the version. Recommendation: left out of that version with
    its words as captions, until a real reel shows a case; the note tells the owner.
11. The face cost's shape: flat, or by the share of the element's box over the face. Recommendation:
    flat 100 to start; by share only if a real reel shows a small graze costing a good spot.
12. The worker's `backgrounds` pipeline step and `backgrounds.json`. Recommendation: remove the step
    and the module (`apps/worker/src/backgrounds/`); a later shadow or stroke needs no map.
13. The hook with no one-text-at-a-time rule runs 0.2 s to 3 s whatever is said in its window; a
    text pick said then is placed around it. Recommendation: accept, it follows from the design.
14. `upper-third` versus the hook's top half today (`mid`). Recommendation: the top third as named;
    the second zone catches what does not fit.
15. `break_after` holds one break (two lines); free wrapping needs several. Recommendation: a
    `breaks: number[]` beside it in the schema, `break_after` kept for stored versions.
16. Where the variant picker lives. Recommendation: `packages/edit/src/variant-picker.ts`, called by
    `editFromAnswer` and `first_version`; the worker gains no module for it until a second app needs
    one.
