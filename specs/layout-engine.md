# Layout engine: variants as data, one placement loop

Built on branch feat/engine-simplify, steps 1 to 12 (2026-11-10); app_docs/edit-model.md describes the code.

Design spec for the rebuilt layout engine of the reel studio (owner decisions of 2026-11-09). Nothing
here is built yet; `app_docs/edit-model.md` describes what the code does today. This file is the plan
as decided; the "Decisions" log at the end keeps the history of the points that were open and how
each was settled.

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
2. The variant picker, `packages/edit/src/variant-picker.ts`, maps each pick to one variant entry.
   One variant per component for now, so the picker is a lookup table; it is the one place a later
   picker (by intensity, by reel, by the LLM) plugs in. `editFromAnswer` and the worker's
   `first_version` step call it; the worker gains no module of its own for it.
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

| Field       | Meaning                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `component` | HOOK, ACCENT, QUESTION, BIGWORD, VISUAL, LIST, or CAPTION (the non-component element)                                                     |
| `variant`   | the entry's name                                                                                                                          |
| `layer`     | `front` (over the footage, in front of the speaker) or `behind` (behind the speaker, needs the mask)                                      |
| `type`      | `text` or `box`                                                                                                                           |
| `style`     | a text: a named style of the style table (font role, colour, base size, or `largest-fit`); a box: its stroke. No size of the entry's own. |
| `zones`     | the ranked list of named zones it may take, best first                                                                                    |
| `timing`    | which timing option its span comes from (see "Timing first")                                                                              |
| `hides`     | whether its words leave the captions while it shows (`hidden_by`)                                                                         |
| `aspect`    | a box's width over height; text has none                                                                                                  |
| `width`     | a box's full width as a share of the frame (the one size no text can give); text has none                                                 |
| `levels`    | a stack (LIST) only: its level roles in order, each with its style, and the number's ratio to the key level                               |

### Zones

A zone is a named area the engine computes per moment from the head track and the safe zone. The
safe zone `S` is `PLATFORM_SAFE` minus the `PLATFORM_BUTTONS` notch, one zone for everything (the
style's tighter box `STYLE_SAFE`, 130..860 x 260..1400, goes). Every zone is cut to `S`, so hard rule
1 holds by construction. `F` is the face over the element's span: the bounding box of the robust
faces (`facesOver`, `head-track.ts`), padded 35 px left and 30 px right (`LAYOUT_PADDING`) and
`layout.gap` (12 px) above and below. `gap` is 12 px. Each zone has a wanted point; of the spots that
fit, the one nearest it wins (as `placeBox` in `engine-space.ts` does today: ties to the higher, then
the further left).

| Zone                    | Area                                                                                                               | Wanted point                                                                    | No head in the moment                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `above-head`            | `S` above `F.top - gap`                                                                                            | centre x of `S`, 190 px above `F.top` (`accent.aboveHead`)                      | the accent line, y 1130 (`accent.noHeadY`), centred |
| `upper-third`           | the top third of `S` (220 to 637)                                                                                  | top centre of `S`                                                               | the same                                            |
| `beside-face`           | the strips of `S` left and right of `F`, from `F.top` to `F.bottom + 120`                                          | towards the face, at the mouth (0.7 of the face's height); the wider side first | zone absent                                         |
| `below-face`            | `S` below `F.bottom + gap`                                                                                         | under the face's centre, just below it                                          | zone absent                                         |
| `caption-line`          | `S` from y 1290 (`caption.fallbackY`) down                                                                         | centre x, y 1290                                                                | the same                                            |
| `corner`                | the four corners of `S`, inset 40 px (`card.inset`): top-left, top-right, bottom-left, bottom-right, in that order | the corner itself                                                               | the same                                            |
| `head-top`              | all of `S`; the big word's anchor (decision 18): placed at the want, moved up only, never elsewhere in the zone    | centre x; vertical centre 60 px below `F.top` (`word.belowHeadTop`)             | y 700 (`word.noHeadY`)                              |
| `anywhere-in-safe-zone` | all of `S`                                                                                                         | the centre of `S`                                                               | the same                                            |

These are the zones the current variants need. A zone is the engine's: adding one is an engine change
(see "Writing a variant").

### Sizes and wrapping

Sizes are not in the variant. Every text but BIGWORD has a natural size: its style's base size
(decision 17, 2026-11-09, after a visual comparison of the three size rules on real frames, where
"the largest that fits" made a hook 472 px and a one-word accent as wide as the safe zone). A style
is the typography a text is set in, a font role, a colour and a base size, the `STYLES` table in
`variants.ts`; each has one base, today's values: `accent` (accents, questions, the hook, a LIST key)
110 px, `caption` (captions, a LIST lead) 50 px. The engine never sets a text above its base; when
space is short it shrinks from it in 10% steps (the shrink cost) down to one global minimum text
size: 30 px (today's caption floor, the smallest text shown today; the schema's `MIN_TEXT_SIZE` 8 px
stays the format's bound, never a layout value). Two variants on the same style get the same base by
construction; a variant that wants another size names another style, a typography decision taken
once, never a field of the entry. BIGWORD is the one `largest-fit` style (`bigWord`): the largest
size at which the word fits at its zone's anchor, the head-top want (decision 18: it is a word behind the
head, so the largest fit is the largest size that fits there, never the largest rectangle anywhere in
the zone), measured with HarfBuzz (`measurer.width(font, size, line)`), bounded by the 30% head rule
(hard rule 6) and by `S`. Wrapping is free: any number of lines, balanced
breaks (`balancedBreak` today), line height the size (plus `caption.lineGap` 14 px between caption
lines). The lines are stored as `breaks: number[]` (the word index each line break falls after),
which replaces `break_after` in the schema; nothing keeps `break_after`.

A box's full size is its `width` share of the frame at its `aspect` (the card: 1/3 at 4:5, 360 x 450);
the engine shrinks from it when the spot is smaller, at the same cost as a text's shrink.

A LIST item's levels are one stacked element: number, lead, key, `transition.gap` (24 px) between,
centred; placed once, as a whole. The key and lead take their styles' bases (`accent` 110, `caption`
50), shrunk together when the stack must; the number is the key's size times the entry's ratio
(300/110 to start, the two preset sizes of today), so a one-digit number never fills the zone. A stack
that fits nowhere whole is a `no-spot`, never three placements.

### The entries

One variant per component today. Values are the current preset's, named so they can be read back to
`preset.ts`.

| Entry                | `component` | `layer`  | `type` | `style`                                                                                | `zones` (best first)                                                 | `timing`                                                                                                                                                | `hides`              | `aspect`, `width` |
| -------------------- | ----------- | -------- | ------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------- |
| `hook/written-line`  | HOOK        | `front`  | text   | `accent` (`primary`, `#FFFFFF`, 110)                                                   | `upper-third`, `anywhere-in-safe-zone`                               | window: 0.2 s to 3 s (`pace.hook`), cut to the reel's end                                                                                               | no (nobody says it)  | none              |
| `accent/above-head`  | ACCENT      | `front`  | text   | `accent` (`primary`, `#FFFFFF`, 110)                                                   | `above-head`, `upper-third`, `anywhere-in-safe-zone`                 | words: first word's start to last word's end, no lead, no minimum                                                                                       | yes                  | none              |
| `question/as-accent` | QUESTION    | `front`  | text   | `accent` (`primary`, `#FFFFFF`, 110)                                                   | `above-head`, `upper-third`, `anywhere-in-safe-zone`                 | words, as an accent                                                                                                                                     | yes                  | none              |
| `bigword/behind`     | BIGWORD     | `behind` | text   | `bigWord` (`primary`, `#FFFFFF`, largest fit)                                          | `head-top`                                                           | words with lead 0.2 s (`accent.leadSeconds`) and minimum 1.5 s (`accent.minSeconds`)                                                                    | yes                  | none              |
| `visual/card`        | VISUAL      | `front`  | box    | white stroke 8 px (`card.stroke`), no fill                                             | `corner`, `beside-face`                                              | words with minimum 1 s and maximum 2 s (`behind.minSeconds`, `maxSeconds`)                                                                              | no                   | 4:5, 1/3          |
| `list/numbered`      | LIST        | `front`  | text   | levels: `number` `accent` (ratio 300/110 to the key), `lead` `caption`, `key` `accent` | `upper-third`, `anywhere-in-safe-zone`                               | words with entrance 0.3 s (`transitions.numbered.seconds`) before the item's first word; each level from its own first word                             | yes                  | none              |
| `caption/default`    | CAPTION     | `front`  | text   | `caption` (`secondary`, `#FFFFFF`, 50)                                                 | `beside-face`, `below-face`, `caption-line`, `anywhere-in-safe-zone` | caption groups as today: a group leaves at its last word's end, held so its last caption shows 0.25 s (`caption.minSeconds`), never past the next group | (they are the words) | none              |

Notes on the entries:

- QUESTION is the ACCENT entry under another component name. That is the point of variants as data:
  the engine has no QUESTION branch.
- The hook's `timing` is its window, not words. There is no one-text-at-a-time rule, so it runs its
  full window whatever is said in it; a text pick said then is placed around it, not instead of it.
- The LIST entry places one item as one stack (see "Sizes and wrapping"). The number shows only in a
  list of two or more items; numbering restarts at 1 in each list (as today).
- Captions are an element like the others, with their own entry, placed last. The element is the
  sentence block: one spot per spoken sentence (`sentenceSpans`, a 0.6 s pause or `.?!`), so
  captions do not jump mid-sentence; its size is the largest at which every group of the sentence
  fits, its lines free.

## Hard rules

Never broken. A candidate spot that breaks one is not a candidate. The element itself is never thrown
away for a rule (see "No legal spot").

1. Everything stays inside the safe zone `S` (`PLATFORM_SAFE` minus `PLATFORM_BUTTONS`). The behind
   big word too: it no longer uses the frame with a 40 px margin (down to y 1880), and the `frame`
   check is replaced by `safe-box` for it.
2. Captions are always visible: nothing covers a caption.
3. Everything spoken is on screen, as a caption or inside a component (the caption split in time by
   `hidden_by`, as today).
4. The same text never shows twice at the same moment (the `same-text` pass and the `same-text`
   check, as today).
5. Text never overlaps text: captions, HOOK, ACCENT, QUESTION, BIGWORD, LIST levels, with
   `layout.gap` (12 px) between them. Text may sit on top of a VISUAL: a text is no obstacle to a
   card and a card no obstacle to a text, either way round; the card draws under the text, and the
   captions, placed last, keep rule 2.
6. BIGWORD (behind variant): the head hides at most 30% of its height (`word.minVisible` 0.7,
   `bigWordCoveredShare` in `behind.ts`, the face only, over the whole span).

## Soft rules

Costs. The cheapest legal candidate wins; the most avoided first.

| Cost                  | What it charges                                                                                                                                                                                                   | Starting value (a tuning value)                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| covers the face       | flat: the element's box overlaps `F` in any moment of its span, whatever the share (the behind big word is exempt: it is behind the speaker by design, rule 6 bounds it)                                          | 100                                                                     |
| down the zone ranking | one step down the variant's `zones`                                                                                                                                                                               | 10 per step                                                             |
| shrinking             | one step of 10% below the element's full size (a text: its style's base size; the big word: the largest size that fits at its first zone's anchor with no text in the way, rule 6 kept; a box: its `width` share) | 10 per step, so a step down the ranking and a shrink step cost the same |
| wrapping              | more lines                                                                                                                                                                                                        | 0                                                                       |

Tie-break, in order: the earlier zone, the larger size, fewer lines, the higher spot, the further left
spot. Deterministic by construction.

These numbers are tuning values: tuned on real reels, never by reasoning alone. The face cost becomes
proportional to the covered share only if a real reel shows a small graze costing a good spot.

## The loop

### Timing first

Each element's span comes from its words and its entry's `timing` option:

- `words`: first word's start to last word's end (ACCENT, QUESTION). A pick with no length at all
  shows the shown floor (`SHOWN_FLOOR_SECONDS`, 0.5 s) from its start, earlier where the reel ends
  (`clamped-to-end`).
- `words` with `lead` and `minimum`: the lead before the first word, never before 0, to the last
  word's end, at least the minimum; at the reel's end the start moves earlier so it shows
  (`clamped-to-end`). BIGWORD: 0.2 s and 1.5 s.
- `words` with `minimum` and `maximum`: the first word's start, held or cut to the bounds,
  `clamped-to-end` at the reel's end. VISUAL: 1 to 2 s.
- `words` with `entrance`: the entrance before the first word (never before 0) to the last word's
  end. LIST: 0.3 s.
- `window`: fixed seconds of reel, cut to the reel's end (`hook-time`). HOOK: 0.2 s to 3 s.
- Captions: groups as today (`captionGroups`), a group leaving at its last word's end, held to
  `caption.minSeconds`.
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

Order: components first, by their start time, ties by the answer's order (the hook comes first by its
start); then the captions, in time order, in the space left.

For each element:

1. Enumerate candidates: for each zone in its ranking, for each line count (1 up to its word count,
   balanced breaks), twice (the face as an obstacle; the face allowed, at the face cost): the largest
   size at which the wrapped text fits a free rectangle of the zone, at most its style's base (the
   big word uncapped), and the spot nearest the zone's wanted point (`freeRects`, `placeBox`).
   Obstacles: the notch, and every text already placed whose
   span shares a moment with this one, expanded by `gap`. A VISUAL is no obstacle and sees none but
   the notch and the face (rule 5). A box variant enumerates its zones the same way at its aspect,
   from its full width down.
2. Skip candidates that break a hard rule: below the global minimum size (none fits), over a caption
   (rule 2; captions are placed last, so this is a check on a caption's own candidates against the
   captions before it), text over text (rule 5, the obstacles above), a big word the face hides more
   than 30% of (rule 6).
3. Score the rest by the soft costs. Take the cheapest; tie-break as above.
4. Write the element with its position, size, `breaks` and span, add its box to the obstacles over
   its moments, and record a note.

Candidates per element are bounded: zones (at most 8) x line counts (the word count) x 2. The sizes
need no ladder: each cell's size is the largest fit capped at the base, found by the measurer (a
text's width scales linearly with size, so one measurement per line gives the fit).

Deterministic: same input, same output. No clock, no randomness, no I/O (as today).

Details the placer settled (build step 5, `engine-place.ts`; each the simplest reading, marked
`Settled:` in the code; a real reel may move any of them):

- A cell's size is capped at the element's full size: a text's style base; a box's `width` share; for
  the big word (`largest-fit`) the largest size over any line count it may take at its first zone's
  anchor with no text in the way (step 8, decision 18; the anchored fit below), the first zone with room
  at the minimum size or more giving it when the first zone has none (a face at the frame's top). So a
  later zone with more room never makes an element larger than its style, or its first zone, allows.
- An element that fits no zone at the minimum size even with nothing but the notch in the way is a
  `no-spot` blamed on the safe zone's edges, whatever its base says.
- Shrink steps are counted up: any size under the full size is at least one step, 0.9 of it one step,
  0.89 two. Sizes are whole pixels (floored), spots whole pixels (`placeBox`).
- A box's size is the largest continuous fit at its aspect, capped at its `width` share, floored;
  the 30 px minimum bounds a box's width too.
- The face as an obstacle is `F` grown by `gap`, like the texts; the face cost charges an overlap with
  `F` itself. `F` is the faces' bounding box padded 35 and 30 px horizontally only (the zone table
  applies `gap` above and below). A behind text never sees the face as an obstacle (it sits behind the
  speaker by design; rule 6 bounds it instead, step 8), pays no face cost and never notes
  `covers-face`; rule 6 is checked on the unpadded faces.
- The wanted point anchors the element's top centre (above-head, upper-third, below-face,
  caption-line), its centre (head-top, anywhere-in-safe-zone), its edge towards the face at the mouth
  (beside-face) or its own corner (corner).
- A zone part's disjoint pieces are searched as their bounding box with the notch as an obstacle, so a
  spot that straddles the notch's top edge left of the column stays a candidate.
- Balanced breaks on `n` lines keep the widest line narrowest, measured at size 1 (the break is the
  same at every size); ties go to the earlier cuts.
- Line height is the size; the element carries its line gap (a caption 14 px, every other text 0).
- A note's `blockers` are the captions, items, face and buttons that touch the zones before the one
  taken, plus the taken zone's own when the element shrank or covers the face there; a `no-spot` names
  what touches every zone, or the safe zone's edges (left and right, or top and bottom) when the element
  fits no zone at the minimum size even with nothing in the way.

Details step 7 settled (the hook and the LIST stacks through the placer, `placeHook` and `placeStack` in
`engine.ts`; the `stack` element in `engine-place.ts`):

- A stack's size is its key level's: the key at its style's base (110), the lead-in at its own base over
  the key's (50/110 of the stack's size), the number at the entry's ratio (300/110), each floored to a
  whole pixel; the shrink steps count from the key's base, and one step shrinks every level.
- The global minimum holds for every level of a stack, so a stack shrinks only until its smallest level
  (the lead-in) reaches 30 px: a key of 66 (the number 180). Below that it is a `no-spot`.
- A stack's candidates are every combination of its levels' line counts; `wrapped` means some level has
  more than one line, and the wrap cost counts the lines beyond one per level. The note's `lines` is the
  stack's total.
- A stack is one obstacle, its whole box over the item's whole span (its levels appear at their own
  words, but the stack is placed once, as a whole).
- A two-item stack at full size (300 + 24 + 50 + 24 + 110 = 508 px) is taller than the upper third
  (416 px): one zone step (10) to `anywhere-in-safe-zone` at full size beats two shrink steps (20) in
  the upper third, so a numbered stack takes the safe zone whole, nearest S's centre, the face pushing it
  to the strip beside it or below it. A tuning observation, not a change: with the wrap cost at 0, a
  narrow strip beside the face where the key phrase wraps costs the same as open room.
- The hook is an element like any other: a hook that fits nowhere at 30 px or more is a `no-spot`, left
  out of that version (nobody says it, so nothing stands in for it). Today's 8 px exceptions are gone.
- No element's time depends on another's: the big word's lead is no longer held back by a text that
  starts inside it, and the LIST entrance is no longer shortened by a text said before it. With no cut,
  the same-text pass meets more pairs; its rule is unchanged (a big word keeps the shared word, else the
  earlier pick), so a list starting on an accent's last word gives that word up (its range trimmed to
  its own words), an accent said inside a list whose words it repeats is dropped, and a big word whose
  lead reaches into an accent ending on its word trims the accent.

Details step 8 settled (the big word through the placer, `placeBigWord` in `engine.ts`; the anchored fit
in `engine-place.ts`; unattended choices following the owner's head-top intent, decision 18):

- A `largest-fit` text is anchored: its candidates stay centred on the zone's want. Sizes are searched
  from the largest the zone's area holds down to the minimum, by the pixel; at each, the box is centred
  on the want, moved only as far as keeps it inside `S`, then moved up by the pixel towards `S`'s top
  until every hard rule holds (clear of the notch and of the texts on screen with it; behind the speaker,
  the face hides at most 30% of it). The first size with such a spot is the fit, at the lowest spot that
  keeps the rules. Moves are by the pixel, not today's 10 px steps, so the fit is exact. With a head the
  word's lower 30% sits behind the head's top and it grows until its top meets `S`'s top or `S`'s width
  holds no more; with no head it is centred at y 700.
- The big word's full size, the one its shrink steps count from, is that anchored fit with no text in the
  way (the notch only, rule 6 kept): `shrunk` means a text on screen took room at the head top, never
  that the head did.
- The big word is set on one line: the behind word item carries no `breaks` (step 4 gave them to
  captions, overlays and levels only), so the engine passes `maxLines` 1 and the placer tries no other
  line count. A wrapped big word waits for the format to carry its breaks.
- The face is no obstacle to a behind text in either path (above). A big word that fits nowhere at 30 px
  with no text in the way (the face's top at or above `S`'s top) is a `no-spot` blamed on the face.
- The schema's bound on a big word's `size` is the frame's height (the format's bound, like
  `MIN_TEXT_SIZE`), no longer 400: the deleted `word.maxSize` was a layout value that had leaked into the
  format.
- The `frame` check is gone: a big word's box joins the `safe-box` check with the captions, overlays and
  levels (decision 2), and the studio's rule words lose `frame`.

Details step 9 settled (the visual's card through the placer, `placeVisual` in `engine.ts` as a thin
wrapper over `placeElement`, like the other components'; unattended choices, each the simplest reading):

- The card is a `box` element from the `visual/card` entry: its full size the `width` share of the frame
  (360 px) at its `aspect` (4:5), the largest card the spot holds up to it, whole pixels (the height
  floored from the width), shrink steps counted from the full width. It sees nothing but the notch and
  the face (rule 5: text is no obstacle to it) and never joins the texts' obstacles (`shown`), so a text
  placed after it may sit on it and a caption may too; the builder's track order (the card at 30, every
  text at 50, later in the page) keeps rule 2.
- A zone of several parts (the four corners, the two sides of the face) is one zone to the ranking, so
  between its parts the tie-break is: the spot nearest its part's want (the spec's rule inside a zone),
  then the earlier part (the zone table's order), then the higher and the further left spot; after the
  cost, the zone, the size and the line count as before. Without it a card the face pushed along the top
  edge, far from the top-left corner, beat the card sitting exactly in the top-right one (both cost 0,
  the further left won).
- The face cost against the shrink steps: a card beside a large face shrinks rather than covers it as
  long as a spot off the face holds a card of 34 px or more (9 shrink steps, 90, under the face's 100);
  only a face that fills the safe zone gets a card over it. A tuning observation, not a change.
- The card's contrast move and its stay note (`preset.behind.edge`, `contrast-spot` and `contrast-stay`
  on a visual) served the old card placer alone, so they are gone with it; the captions' readability stays
  for step 11. `behind.spots`, `BEHIND_SPOTS`, `BehindSpot`, `spotBox`, `spotFaceShare`, `boxFaceShare`,
  `card.smaller`, `card.ring`, `card.spots` (`CARD_SPOTS`), `behind.maxFaceShare` and the old rule names
  `visual-size` and `visual-face` are gone; `card.widthShare`, `aspect`, `inset` and `stroke` stay as the
  values the entry and the zone table read back to (a test ties the entry's share and ratio to them),
  for step 12 to settle.
- Re-deriving the goldens moved the fixture reel's card from the old smaller step (252 by 315 at the
  bottom-left corner) to the largest card that corner holds under the head (307 by 383, two shrink
  steps), and the big word "distribution" from y 379 to y 388: step 8's goldens had been written before
  its last by-the-pixel change, so y 388 is what the step 8 engine already placed.

Details step 10 settled (the captions through the placer, `placeCaptions` in `engine.ts`; the `block`
element in `engine-place.ts`; unattended choices, each the simplest reading):

- The element is the sentence block (decision 4): a `block` of groups, each group the captions on
  screen together (as `captionGroups` makes them, re-timed), each caption a unit set whole on one line.
  A hidden caption (`hidden_by`) is no unit: it has no place and takes no room. The block's id is its
  first caption's; its style is the `caption` style (base 50), its line gap `caption.lineGap` (14).
- A block's line count `n` (1 up to its largest group's caption count) sets every group on at most `n`
  lines, balanced between whole units (a group of fewer captions on one per caption), the line width
  the units' widths and a space between them. The block is as wide as its widest line and as tall as its
  deepest group, so the size that fits is the largest at which every group fits; `wrapped` means some
  group has more than one line, and the note's `lines` is the deepest group's. The lines are centred
  in the block's box (the old path aligned them towards the face beside it; the spec names no alignment).
- A placed caption's `position` is its line's spot (`align` left), floored to 0.01 px like today's, its
  `size` the block's; each caption's own box over its own span joins `shown` as a `caption` obstacle, so
  the captions after it keep rule 2. Every caption of the block gets the block's notes under its own id
  (the checks and the decide step read `covers-face` and `no-spot` per caption); the reason names the
  block ("caption block cw0 ...") and the words left in.
- With no legal spot (decision 19) the block is placed again over a scene with no text or caption
  obstacles (the notch and the face stay; captions of another sentence never share a moment with it, so
  a caption obstacle is none in practice), and its notes are the `no-spot` note (its `blockers` the
  placer's plus the texts the box sits over, `zone`, `size`, `lines` and `cost` the spot's) and the
  fallback's `moved`, `shrunk`, `wrapped` and `covers-face` notes. A block that fits nowhere even then
  throws.
- Readability stays for step 11 with one change: a caption block below its contrast threshold looks for
  a free place within the preset's radius anywhere in `S` (the zone's area was the old candidate's), with
  the face, the texts on screen and the notch as obstacles; a block over the face or over text (a
  `no-spot`) is never moved for it, as before.
- With the wrap cost at 0 and a zone step at 10, a sentence beside the face wrapped to three or four lines
  at 50 px (cost 0) beats the same sentence below the face on one line (cost 10): on the fixture reel 93%
  of the captions moved (median 405 px), from below the face (y about 1050, one or two lines, the old
  two-line cap) to beside it, wrapped, at the same 50 px. A tuning observation, not a change.
- `placeBlock`, `captionCandidates`, `tryBlock`, `blockObstacles`, `layLines`, `wrapUnits`, `sizesFrom`,
  `layout.minScale` (0.6), the "over the face on the caption line" tier, the "over the face and other
  text" tier, the one-unit-per-line stacking, the `kept-overlapping` outcome and action, the `all-picks`,
  `caption-spot`, `caption-size` and `caption-face` rule names, `PlaceNote.with` and the record
  adapter's `with` and `captionIds` handling are gone. `caption.fallbackY` stays as the value the zone
  table reads back to (like `accent.aboveHead` and `card.inset`), for step 12 to settle.

## No legal spot

Rare: a moment so crowded that a component has no candidate that keeps the hard rules at or above the
global minimum size. The element is left out of that version; its spoken words still show as captions
(rule 3). The engine writes a structured note with outcome `no-spot` and the blockers that took the
space, so the owner sees it in the record and the trace. Any other behaviour (a smaller minimum, a
later moment, a different variant) waits for a real reel that shows the case.

A caption block is the exception (decision 19): left out, its words would vanish, so it is never left
out. With no legal spot it is placed again with the texts on screen out of its way, inside `S` (rule 1
kept, the face still a cost), and noted `no-spot` on each of its captions, the blockers naming the
texts that took the space and the ones it sits over; the `text-overlap` check excuses exactly those
pairs. Rarer still: a block that fits nowhere in `S` even then (a caption group wider or taller than
`S` at 30 px) is an error, not a layout; the baseline never makes one.

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
- This is the one shape. The trace (`decision-trace.ts`) and the checks read it and nothing else;
  today's `{ item, action, rule, reason, with }` is not read any more (no old-version support
  anywhere, decision 15).
- The checks read the record: the `face` check excuses a caption whose note has outcome
  `covers-face`; the `text-overlap` check no longer has a `kept-overlapping` pair to excuse (rule 5
  is hard), so it is strict: its one excuse is a caption whose `no-spot` note names the other text
  (decision 19).

## Readability

Out for now: no contrast measurement, no background map, no move for contrast. A shadow or a stroke
may come later if a real reel needs it (today's rule "never a shadow" is lifted with it; it is not a
rule of this design). A later shadow or stroke needs no map, so the map goes with the measurement.

This removes, in `packages/edit`: `contrast.ts` and `background.ts` (`backgroundSampler`,
`BackgroundMap`, `BACKGROUND_GRID`, their exports in `index.ts`), `PlaceOptions.backgrounds`,
`keepReadable`, `readablePlace`, `contrastOf`, the notes `contrast-spot` and `contrast-stay`
(`low-contrast`), `preset.readability` (4.5, 3, 300, 60) and `preset.behind.edge` (1.5, 30), and the
"readable text" engine tests. In `apps/worker`: the `backgrounds` pipeline step and its module
(`apps/worker/src/backgrounds/`, `backgrounds.json`, the `ensureBackgrounds` calls in
`first-version.ts` and `decide/run-decide.ts`), with its lines in `app_docs/pipeline.md`.

## What changes from today

| Today (`engine.ts` and friends)                                                                                                                                                                                                                                                                                                                                                                                                  | New model                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Deleted**                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                   |
| per-kind placers: `placeAccent`, `placeHook`, `placeBigWord`, `placeVisual`, `placeLevels`, `placeBlock`, `cardSpots`                                                                                                                                                                                                                                                                                                            | one `place(element, variant)`                                                                     |
| per-kind tier ladders (clear; over the face; default spot over text) and `noteOverlap`'s `all-picks`                                                                                                                                                                                                                                                                                                                             | hard rules filter, soft costs rank                                                                |
| `sizesFrom`, `layout.minScale` (0.6), the 8 px exceptions, `card.smaller` (0.7)                                                                                                                                                                                                                                                                                                                                                  | the style's base size as the cap (the big word: largest fit), one global minimum of 30 px         |
| two-line caps (`maxLines: 2`, `wraps`), `break_after` in the schema and the builder                                                                                                                                                                                                                                                                                                                                              | any number of lines, cost 0, stored as `breaks: number[]`                                         |
| `oneTextAtATime`, `text-one-at-a-time`, `transition-entrance`, the hook cut by a later text                                                                                                                                                                                                                                                                                                                                      | none: conflicts are screen overlaps                                                               |
| `kept-overlapping` (text over text) and the `text-overlap` check's excuse                                                                                                                                                                                                                                                                                                                                                        | rule 5 is hard; the check is strict                                                               |
| `STYLE_SAFE`, `preset.safe`, `intersectBox` for the safe box; the `frame` check; the big word's frame-wide area and `word.margin`                                                                                                                                                                                                                                                                                                | one safe zone `S` for everything; `safe-box` checks it all                                        |
| readability (see above), the worker's `backgrounds` step                                                                                                                                                                                                                                                                                                                                                                         | none                                                                                              |
| hand-picked sizes and spots in `preset.ts`: `fonts[].size` as the start of a ladder (the base sizes live in the style table; `fonts[].size` stays the builder's fallback for an item with no size until step 12), `behind.word.maxSize`, `behind.spots` (`top`, `left`, `right`), `spot` on a VISUAL (schema and `nearestSpot`), `transitions.numbered.want`, `numberSize` (now the ratio), `behind.maxFaceShare` (unread today) | zone derivations hold the pixel offsets (190, 60, 1290, 700, 40, 120); the variant holds the rest |
| `EngineAction` and `EngineNote.with`; reading today's note shape in the trace and the checks                                                                                                                                                                                                                                                                                                                                     | the new note shape, the only one read                                                             |
| **Kept**                                                                                                                                                                                                                                                                                                                                                                                                                         |                                                                                                   |
| the HarfBuzz measurer (`measure.ts`)                                                                                                                                                                                                                                                                                                                                                                                             | the one source of text width                                                                      |
| the robust face (`facesOver`, `boundingBox`, `LAYOUT_PADDING`)                                                                                                                                                                                                                                                                                                                                                                   | the zones' `F`                                                                                    |
| `PLATFORM_SAFE`, `PLATFORM_BUTTONS`                                                                                                                                                                                                                                                                                                                                                                                              | the safe zone `S`                                                                                 |
| free space (`freeRects`, `placeBox`, `overlaps`, `expand` in `engine-space.ts`)                                                                                                                                                                                                                                                                                                                                                  | the candidate enumerator's core                                                                   |
| the same-text pass (`sameTextPass`) and check                                                                                                                                                                                                                                                                                                                                                                                    | rule 4                                                                                            |
| the caption split by time (`splitCaption`, `hidden_by`, `hiddenCaptionIds`)                                                                                                                                                                                                                                                                                                                                                      | rule 3                                                                                            |
| caption grouping (`captionGroups`), `sentenceSpans`                                                                                                                                                                                                                                                                                                                                                                              | caption timing; the sentence block is the caption element                                         |
| timing helpers: `transitionTiming`, `ownSpan`, `floorSpan`, `visibleSpan` (`moved-off-cut`), `clamped-to-end`, `anchorAt`                                                                                                                                                                                                                                                                                                        | the timing options                                                                                |
| `bigWordCoveredShare`, `maskSpans`, `needsCutout`, `placedBigWord`                                                                                                                                                                                                                                                                                                                                                               | rule 6 and the behind layer                                                                       |
| `clicksFor` (`clicks.ts`)                                                                                                                                                                                                                                                                                                                                                                                                        | unchanged: a click per VISUAL and BIGWORD                                                         |
| `choicesOf`, the edit format (`schema.ts`) but for `breaks` and `spot`, the builder, versions                                                                                                                                                                                                                                                                                                                                    | unchanged                                                                                         |
| **New**                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                   |
| variant registry (`variants.ts`, data only)                                                                                                                                                                                                                                                                                                                                                                                      | the entries above                                                                                 |
| the style table (`STYLES` in `variants.ts`: font role, colour, base size or `largest-fit`)                                                                                                                                                                                                                                                                                                                                       | the natural size of every text but the big word                                                   |
| variant picker (`variant-picker.ts`, one variant per component)                                                                                                                                                                                                                                                                                                                                                                  | pick to entry                                                                                     |
| zone computation (`engine-zones.ts`)                                                                                                                                                                                                                                                                                                                                                                                             | the zone table                                                                                    |
| candidate enumeration and scoring (`engine-place.ts`)                                                                                                                                                                                                                                                                                                                                                                            | the loop                                                                                          |
| the note shape with `component`, `variant`, `start`, `end`, `outcome`, `blockers`                                                                                                                                                                                                                                                                                                                                                | the record                                                                                        |
| `breaks: number[]` on every text item and level                                                                                                                                                                                                                                                                                                                                                                                  | free wrapping                                                                                     |

## Build order

Small steps. Each ends in one commit with its tests and the doc update (`app_docs/edit-model.md`,
"Layout engine"; `docs/conditional-docs.md` when a file moves), each leaves the worker working
(`yarn test` green, the goldens re-derived with `yarn workspace @edit-issebya/edit golden` and
committed). Do not start building from this file; each step gets its own go-ahead.

1. The note shape. `EngineNote` becomes the shape above, written by the current engine (an adapter
   maps today's actions to outcomes and `with` to blockers until the loop replaces them);
   `engineRecordLine`, the trace and the checks read the new shape only.
2. Zones. `engine-zones.ts`: the zone table as code over `S`, `zonesAt(name, S, F)`; unit tests per
   zone with and without a head. Not yet called by the engine. `STYLE_SAFE` and `preset.safe` go
   with it: `S` is the one safe zone from here.
3. Variants. `variants.ts` with the seven entries and `variant-picker.ts`; `placeEdit` takes the
   picked variants and ignores them for now; `editFromAnswer` and `first_version` call the picker.
   Tests: one entry per component, the picker total.
4. The schema: `breaks: number[]` replaces `break_after` on captions, overlays, levels; the builder
   renders the lines from it; the fixtures and goldens re-derived. `spot` leaves the VISUAL item.
5. The placer. `engine-place.ts`: candidates, hard filters, costs, tie-break, the 30 px minimum, over
   a given obstacle set; unit tests on synthetic scenes (a crowded upper third, a face filling the
   zone, a word that fits nowhere). Not yet called.
6. ACCENT and QUESTION through the placer; `placeAccent` deleted; goldens re-derived.
7. HOOK and LIST stacks through the placer, components placed by start time; `oneTextAtATime` and
   `transition-entrance` deleted (the hook runs its window); `placeHook` and `placeLevels` deleted;
   `numberSize` becomes the entry's ratio.
8. BIGWORD through the placer with rule 6 as a hard filter, inside `S`; `placeBigWord`,
   `word.margin`, `word.maxSize` and the `frame` check deleted.
9. VISUAL through the placer as a box from its `width` share; `placeVisual`, `cardSpots`,
   `behind.spots`, `nearestSpot`, `card.smaller` deleted.
10. Captions through the placer as sentence blocks; `placeBlock`, `captionCandidates`, `sizesFrom`,
    `layout.minScale` deleted; `no-spot` leaves an element out; `text-overlap` made strict.
11. Readability removed (the list under "Readability"), the worker's `backgrounds` step and module
    with it.
12. Clean-up: `engine.ts` split into timing, scene and the loop; dead preset fields removed; the
    "Layout engine" section of `app_docs/edit-model.md` rewritten from this spec; `.adw/project.md`
    if a path changed.

## Writing a variant

For whoever designs a new variant later. A variant is a data entry in `variants.ts` and a line in the
picker; it never touches the engine.

### What a variant sets

| Field       | Allowed values                                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component` | one of HOOK, ACCENT, QUESTION, BIGWORD, VISUAL, LIST, CAPTION                                                                                                                                                                                                                      |
| `variant`   | `<component>/<name>`, lower-case words and hyphens, unique                                                                                                                                                                                                                         |
| `layer`     | `front` or `behind`. `behind` is text only and needs the person mask (the cut-out, `maskSpans`); rule 6 applies to it                                                                                                                                                              |
| `type`      | `text` or `box`                                                                                                                                                                                                                                                                    |
| `style`     | text: one named style of the `STYLES` table in `variants.ts` (`accent`, `caption`, `bigWord`: a font role, a colour and a base size, or `largest-fit` for the big word's); box: a stroke in px and no fill. Nothing else: no size of the entry's own, no shadow, no stroke on text |
| `zones`     | one or more names from the zone table, ranked best first. Only those names                                                                                                                                                                                                         |
| `timing`    | one option: `words`; `words` + `lead` (s) + `minimum` (s); `words` + `minimum` + `maximum` (s); `words` + `entrance` (s); `window` (`from`, `to` in s). Captions keep their own grouping                                                                                           |
| `hides`     | `yes` (its words leave the captions while it shows; text that shows spoken words) or `no` (a box, or a text nobody says)                                                                                                                                                           |
| `aspect`    | box only: width over height, such as `4/5`                                                                                                                                                                                                                                         |
| `width`     | box only: the full width as a share of the frame, such as `1/3`                                                                                                                                                                                                                    |
| `levels`    | a stack only: the level roles in order (`number`, `lead`, `key`), each with its style, and the number's ratio to the key level                                                                                                                                                     |

A worked example, a hypothetical second ACCENT variant that sits low and large:

```ts
{
  component: "ACCENT",
  variant: "accent/bottom-large",
  layer: "front",
  type: "text",
  style: STYLES.accent,
  zones: ["caption-line", "below-face", "anywhere-in-safe-zone"],
  timing: { option: "words" },
  hides: true,
}
```

"Large" is not a field of the entry: the size is the style's base (110 for `accent`), and the room
`caption-line` has (wide and, with the captions placed after it, usually empty) only means the entry is
rarely shrunk or wrapped. An accent meant to be set larger than 110 needs a new style in the table, a
typography decision taken once with its own base, never a number on the entry; only the big word's
style is `largest-fit`. The picker then decides which accents take `accent/above-head` and which take
`accent/bottom-large`.

### What the engine decides and a variant cannot change

- The hard rules, all six, and the safe zone `S` they run in.
- The zone geometry: each zone's area, wanted point and no-head fallback, the face padding (35, 30, 12) and the gap (12 px). A variant ranks zones; it does not move or reshape them.
- The size: the style's base as the cap (the big word's largest fit), the global minimum of 30 px, the
  10% shrink steps from the base, a box's shrink from its `width` share. A variant names a style; it
  does not set a size.
- The line breaks: balanced, any count, stored as `breaks`.
- The placement order: components by start time (ties by the answer's order), captions last.
- The soft costs, their order and values (face 100, zone step 10, shrink step 10, wrap 0) and the
  tie-break.
- The face cost's shape (flat) and who is exempt (the behind text).
- Time: no element cuts another's time; the timing options compute the span from the words, and the
  same-text pass and the caption split are the only trims. A variant picks an option and its seconds,
  not a new behaviour.
- The `no-spot` behaviour: the element is left out, its words stay captions, the note is written; a
  caption block alone is set over the texts instead, inside `S`, noted (decision 19).
- The moments and `F`: how the reel is cut and how the robust face is read.
- The clicks (`clicks.ts`): a click per VISUAL and BIGWORD, whatever their variant.
- The record: every element gets its notes in the one shape; a variant adds no note kind.
- The format: what the schema accepts (positions, sizes, `breaks`, anchors) is the format's, not the
  variant's.

### How to add a new zone or timing option

That is an engine change, not a variant change: a new row in the zone table of this spec with its
derivation (area, wanted point, no-head case) and its code in `engine-zones.ts` with tests for both
cases; or a new timing option in the timing stage with its test, and a row under "Timing first". Each
is its own commit with the doc update, and only then may an entry name it.

## Decisions

The points the first draft of this spec left open and how the owner settled them (2026-11-09: every
recommendation taken, except 15, where the owner went further).

| #   | Question                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Date       |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | which safe zone is the hard rule         | `PLATFORM_SAFE` minus the notch, one zone `S` for everything; `STYLE_SAFE` goes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2026-11-09 |
| 2   | does the behind big word obey rule 1     | yes; `head-top` is cut to `S`, the `frame` check becomes `safe-box`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 2026-11-09 |
| 3   | the global minimum text size             | 30 px; the schema's 8 px stays the format's bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2026-11-09 |
| 4   | caption block versus sentence grouping   | the element is the sentence block, lines free, sized so every group fits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2026-11-09 |
| 5   | how a LIST item's levels sit             | one stacked element (number, lead, key, 24 px gap, centred), placed once; a stack that fits nowhere whole is a `no-spot`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 2026-11-09 |
| 6   | the LIST number's size                   | a ratio to the key level in the entry, 300/110 to start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2026-11-09 |
| 7   | a box's size                             | the entry carries its full width as a share of the frame (1/3, 360 x 450); shrinking from it costs as for text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2026-11-09 |
| 8   | the order the components are placed in   | by start time, ties by the answer's order; the hook first by its start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 2026-11-09 |
| 9   | is a text an obstacle to a VISUAL        | no obstacle either way; the card draws under the text; captions placed last keep rule 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2026-11-09 |
| 10  | what happens to a `no-spot` element      | left out of that version, its words as captions, the note tells the owner; more waits for a real reel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2026-11-09 |
| 11  | the face cost's shape                    | flat 100; by share only if a real reel shows a small graze costing a good spot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2026-11-09 |
| 12  | the worker's `backgrounds` step          | removed with its module and `backgrounds.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2026-11-09 |
| 13  | the hook with no one-text-at-a-time rule | runs its full window 0.2 s to 3 s; a text pick said then is placed around it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2026-11-09 |
| 14  | `upper-third` versus the hook's top half | the top third as named; the second zone catches what does not fit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 2026-11-09 |
| 15  | `break_after` holds one break            | `breaks: number[]` replaces `break_after`; nothing kept for stored versions. No old-version support anywhere: the old note shape and `spot` are not read either                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2026-11-09 |
| 16  | where the variant picker lives           | `packages/edit/src/variant-picker.ts`, called by `editFromAnswer` and `first_version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 2026-11-09 |
| 17  | how large a text is set                  | chosen after a visual comparison of the three size rules on real frames: every text but BIGWORD at its style's base size (`accent` 110, `caption` 50), never above it, shrunk in 10% steps to 30 px; BIGWORD the largest fit with the 30% head rule as a hard filter; boxes unchanged. The base lives on the style (`STYLES` in `variants.ts`), not on the entry                                                                                                                                                                                                                                                                                                                                                                                                | 2026-11-09 |
| 18  | where the big word's largest fit is      | BIGWORD largest fit is anchored at the head top, it does not wander to roomier spots: the largest size that fits centred on the `head-top` want (60 px below the face top; y 700 with no head), moved up towards `S`'s top where the head would hide more than 30%, then shrunk; the step 6 placer test had shown it drifting below the face for a roomier rectangle. An unattended choice following the owner's head-top intent (step 8)                                                                                                                                                                                                                                                                                                                       | 2026-11-09 |
| 19  | a caption block with no legal spot       | Captions are never left out (rule 3: their words would vanish). A block with no legal spot at 30 px or more keeps rule 1 and breaks rule 5 alone: it is placed again with the texts on screen out of its way (the notch and the face still in it, the face still a cost), at its cheapest candidate there, noted `no-spot` on each of its captions with the texts that took the space and the ones it sits over as blockers; the strict `text-overlap` check excuses exactly those pairs. Rare: none in the goldens or in a seeded sweep over the fixture reel; 6 versions in 100 over a synthetic opening (60 captions in one block, a face filling `S`, a hook and a list). An unattended choice, the simplest reading of rules 1, 3 and 5 together (step 10) | 2026-11-09 |
