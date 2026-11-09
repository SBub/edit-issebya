# Edit Model: Word-Anchored Format, Style Preset, HarfBuzz Builder, Versions

**Specifications:**

- specs/issue-31-adw-7f81a19d-sdlc_planner-edit-model-builder-versions.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-114-adw-9049f8fd-sdlc_planner-platform-safe-zone-guard.md
- specs/issue-154-adw-596f3b25-sdlc_planner-readable-text-contrast.md
- specs/issue-155-adw-2a28c287-sdlc_planner-fulfil-change-requests-make-room.md
- specs/issue-157-adw-3c1a1736-sdlc_planner-transitions-tied-to-phrases.md

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
  (`kind: "accent"`, or `kind: "hook"` for the written hook, below), `transitions` (the LIST items, `numbered`, the only kind, each with its `list` and `number`), `sounds` (`click`) and the optional
  `behind` track. There is no whole-clip cut-out: the per-span masks in `inputs.masks` are the only cut-out.
- `tracks.behind`: the big words (behind the speaker) and the VISUALs (over the footage, in front of the
  speaker), any number of items. A VISUAL (`kind: "visual"`, `decide-17`) is an empty white stroke frame,
  a corner card (`behind.card`), always in front: `box` its place and size, which the layout engine always
  writes, and `spot` the preset spot nearest it, with no picture and no asset.
  It may carry an optional
  `description` (a short plain phrase of what the frame would show, at most 120 characters, the
  decide answer's own limit is 8 words), which is never shown on screen; the builder draws a
  `div.clip.visual` with a white border of the preset's card stroke (`card.stroke`, 8 px), transparent
  inside (the `.visual` rule is written only on a page with a visual). Or a big word (`kind: "word"`,
  `text` one or two words of 1 to 24 characters each, with no space inside a
  word and no `<`, `>` or `&`, the two joined by one space: "distribution channel"). It is anchored
  on words like a caption (a big word starts on its first word with a negative
  `offset`, the lead), cuts in and out with no animation. A big word is a text pick: the text picks (the
  hook, accents, questions, big words and lists) show one at a time (`text-one-at-a-time`). A VISUAL
  lasts 1 to 2 s (`behind.minSeconds`, `behind.maxSeconds`), less only at the reel's end or over a cut, is not
  text, and may show with any text. A big word lasts from the lead before its first word to its last word's
  end, at least 1.5 s (a target: a text said later cuts it short).
  A refinement refuses an item crossing a footage clip's `hidden` span; with the decide limit
  (`EditLimits.behindLengths`, new versions only) also an item outside its kind's length (a VISUAL 0.5 to 2 s,
  a big word from 0.5 s to the lead, its words and `afterSeconds`), so a stored
  version keeps parsing and rendering. A version without the track parses, and the builder reads it as
  empty.
- `inputs.masks`, optional, filled by the worker before a version with a `behind` item is saved:
  `masks` lists the person masks (`EditMask`, a `{ step: "cutout", fingerprint, file: "mask.mp4",
start, end }` ref plus the span of the reel it covers, in seconds, by start). A version without
  behind items has none; a VISUAL needs no mask, so a version whose behind items are all VISUALs has none.
- Every item has an `id` (`^[a-z][a-z0-9-]{0,63}$`, unique across tracks), a `start` and an `end`
  anchor. An anchor is a word (`{ word, edge?: "start" | "end", offset? }`, offset within plus or
  minus 1 s), a time in seconds (`{ time }`, only where nobody speaks) or the reel's edge
  (`{ reel: "start" | "end" }`). Anchors are resolved at every build (`src/timeline.ts`,
  `resolveAnchor`, `resolveTimeline`, to the millisecond), so items follow their words through a
  re-time.
- Per-item properties: captions and overlays take `words`, `text`, `font` (`primary` or
  `secondary`), `size`, `color` (`#RRGGBB`), `position` (`{ x, y, align }` inside the frame) and
  `break_after` (set in two lines, this many words on the first); a big word behind the speaker
  takes `position` (`{ x, y }`, its top left corner in the frame), `size` and `words` (the one or two word
  ids it shows, written by the engine; the same-text check reads them). A caption
  takes an optional `hidden_by` (the id of the accent, big word or list showing its words while it is on
  screen; the builder leaves it out, and a refinement refuses an id that is none of those, the hook
  included).
  The hook (`kind: "hook"`, id `hook`) takes `text` and never `words`: it is the one text on screen
  nobody says. A refinement refuses a hook with words or without text, and a second hook. Versions
  saved before it have none and parse as before.
  The layout engine writes `position` and `size` on every caption, accent, hook and big word it
  places, and a VISUAL's `box` and `spot`. Positions remain optional in the format because the
  engine's input (the baseline first version, and `placeEdit`'s `current`) has none; a placed version
  has them all.
  Footage clips take `hidden` spans; sounds `gain_db` (-60 to 12). Unset properties come from the
  preset.
- `style` is the free custom-style field: CSS property to value, added to the element. Values
  cannot leave the style attribute (no `;`, `{`, `}`, `<`, `>`, backslash or `url(`).
- Validation is Zod 4. `editSchemaFor(preset, transcript)` is built per reel: word ids are the
  transcript's and fonts the preset's, so an unknown word or font is refused by the schema itself;
  a refinement refuses a duplicate id, an end before its start, an overlay with neither words
  nor text, and a `behind` item breaking its rules above. `EditLimits.behindLengths` adds the behind
  lengths (the decide limit). `src/transcript.ts` is the studio transcript (`{ words: [{ id, text,
start, end }] }`).

### Preset values

`src/preset.ts`, `ISSEBYA_PRESET`, the values of the approved `rethink-work` reel:

- Frame 1080x1920. The one safe zone `S` (`SAFE_ZONE` in `src/engine-zones.ts`, `box` and `notch`)
  is `PLATFORM_SAFE` minus the `PLATFORM_BUTTONS` notch: text never leaves `box` and never overlaps
  `notch`. There is no style box of its own (`STYLE_SAFE` and `preset.safe` are gone: the preset
  holds no safe box), so the style's text and the checks use the same zone.
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
  accents, the big word and the key phrase of a transition, `secondary` Golos Text Bold
  (`assets/fonts/GolosText-Bold.ttf`, weight 700, 50 px) for captions and a transition's lead-in
  (owner decision 2026-11-04, after a day's trial of Raleway for captions too). The builder lists
  a font file once even when both roles share it. All text is white (`#FFFFFF`: captions, accents,
  the big word, transition levels by their roles).
- Captions: `#FFFFFF`, rise 12 px over 0.18 s (`power2.out`), fade out 0.15 s, at least 0.25 s on
  screen, a group breaks at a 0.35 s pause or after 4 units, fallback line y 1290 when no head is
  in the frame, line gap 14.
- Accents: `#FFFFFF`, 190 px above the head, y 1130 with no head, exactly while their words are spoken,
  like a caption: from the first word's start to the last word's end, no lead and no minimum. The big word
  takes the lead (`leadSeconds`, 0.2 s, so its entrance has finished as the word is heard) and the
  minimum (`minSeconds`, 1.5 s) from its word. `afterSeconds` (1 s) is not a shown time: it only bounds a
  big word's length in the decide limit.
- Layout (`layout`): text shrinks to 60% of its size (`minScale`) before it gives up a place (only an
  accent's default spot and the hook go down to `MIN_TEXT_SIZE`, 8 px), and keeps 12 px (`gap`) from the face
  and from other text.
- Transitions (`transitions.numbered`, the LIST): the layer is the full frame, with no background; its
  text levels come in with a fade of 0.3 s (`power2.out`) and are placed in the safe zone `S`, the
  level stack wanted at y 640 (`want`), the number at 300 px (`numberSize`). Stacked levels keep
  `transition.gap` (24 px) apart. Its text areas stay inside `S` and clear of the notch.
- Click sound: `assets/sounds/mouse-click-trimmed.wav`, 0.23 s, -6 dB (owner decision 2026-11-04,
  louder than the -13 dB before; a stored click with no `gain_db` plays at it too, in the preview
  through `apps/studio/src/lib/sound-schedule.ts` and in the export through the page's
  `data-volume`, both from `gain_db ?? gainDb`), at least 0.25 s apart.
- Behind (`behind`, starting values the owner tunes by eye): the spots `top` (left 90, right 990,
  top 160, bottom 760), `left` (40 to 500, 560 to 1180) and `right` (580 to 1040, 560 to 1180); a
  VISUAL's `spot` names the nearest of them, and its `box` is the place it is drawn in. The big word:
  `primary` font, at most 400 px, side margin 40, `#FFFFFF`, its vertical centre wanted 60 px below
  the head's top (`belowHeadTop`) or at y 700 with no head (`noHeadY`), the face may cover at most
  the lower 30% of its height (`minVisible` 0.7, the face only); the word is never moved up for the head, and a larger cover
  is kept and noted. The cut-out covers each big word
  plus 3 frames on each side (`padFrames` at `frameRate` 30); a VISUAL lasts 1 s
  (`minSeconds`) to 2 s (`maxSeconds`), a short beat rather than a backdrop, and a big word the
  own timing (its lead and 1.5 s minimum, see Accents). No count per reel.
- Visuals (`decide-17`): the card (`behind.card`, owner decision 2026-11-07, a picture in picture
  card like the ones in talking-head reels): an empty white stroke frame over the footage, in front of
  the speaker, no fill and no text. Its width is a third of the frame's width (`widthShare`, 360 px) at
  4:5 (`aspect`, 360 by 450 px). Its spots (`CARD_SPOTS`, in this order for a tie): `top-left`,
  `top-right`, `bottom-left` and `bottom-right` (each `inset` 40 px in from `PLATFORM_SAFE`) and
  `beside-left` and `beside-right` (`layout.gap` from the moment's face, its top at the face's top). A
  spot is taken only when it is inside `PLATFORM_SAFE`, off the moment's face (the first tier), of every accent,
  big word, list level and the hook shown in its span and of `PLATFORM_BUTTONS` (captions are placed
  after the cards, so they never count); the spot with the most
  free space in the ring around it (`ring`, 60 px) wins. The full size is tried at every spot before
  the smaller step (`smaller`, 0.7: 252 by 315 px, one step only, recorded `shrunk`, rule
  `visual-size`), and then, with no spot off the face free, over the face at either size (noted
  `covers-face`), and last the top-left corner of the safe zone at the full size, over other text, the
  overlap noted (`all-picks`). 0.7, not 0.8 (288 px): on the speech-ten
  clip the free strip beside the speaker is about 260 px wide. A card covers the face only when no corner
  or side off it is free at either size (noted `covers-face`, rule `visual-face`); `stroke` (8 px) is the builder's border.
- The VISUAL's white edge: `preset.behind.edge` (`minContrast` 1.5:1 against the footage within `ring`,
  30 px around it), checked as the card's contrast in "Layout engine" below. No code reads `behind.maxFaceShare`
  (0.4) now: a card's place against the face is the engine's spot rule, a preference (see Placement).
- Pace (`pace`, the preset's `intensity` names its level, `intense` (the pros' level); the pace block is
  that level's; a later level, `calm` or `medium`, is one more name with its own block): something new besides captions at least every 3 s
  as the aim (`extraEverySeconds`, which no code reads: the engine caps and drops nothing by it, and the
  decide prompt is sent no density). The
  written hook (`pace.hook`): from 0.2 s (`fromSeconds`) to 3 s
  (`untilSeconds`), the first seconds that decide whether people keep watching, at most 7 words
  (`maxWords`) and 45 characters (`maxCharacters`, both passed to the prompt as `hook_length`).
- Caption units: kept capitals (`I`, `I'm`, `I've`, `I'll`, `I'd`, `AI`), a number joined with the
  unit after it, a month with its day number, and the glossary (`lock-in`, heard as `locking` or
  `lock in`).

### Builder contract

- `src/build.ts`: `build(edit, transcript, headTrack, preset, measurer) -> { html, assets, checks }`.
  `html` is a HyperFrames composition (`data-composition-id="main"`, a paused GSAP 3.14.2 timeline
  registered on `window.__timelines`); `assets` lists every referenced file with its role
  (`footage`, `font`, `sound`, `mask`), sorted; `checks` is the layout check list. A
  `mask` asset carries its `cutout` ref at `maskPath(mask)` (`masks/<fingerprint>.mp4`).
- Deterministic: no clock, no randomness, no I/O. The same inputs give the same bytes in Node and in
  the browser. One builder serves the preview and the export.
- `src/measure.ts`: `createMeasurer(hb, fonts)` over the initialised `harfbuzzjs` module and the
  font bytes, both passed in by the caller (the worker's `apps/worker/src/edit-measurer.ts` reads
  them from `packages/edit/assets/`, once per process). The `Measurer` returns advance widths
  (`sum(x_advance) * size / upem`) and records every width it measured (`widths()`, what the
  goldens compare). The same wasm on the same font bytes gives identical widths everywhere.
- The builder places each caption, accent, hook and big word at the `position` the layout engine set
  on it (`placedText`, `src/build.ts`), with its `size` and, when it has `break_after`, its two lines
  (rendered `first<br />second`, centred). A shown caption or overlay with no position throws
  `build: <kind> <id> has no position; place the edit first`, and a big word with no `position` or
  `size` throws the same way. `src/html.ts` escapes text and attributes and formats numbers.
- `src/behind.ts`: `spotBox(spot, preset)` (the spot's rectangle), `visualBox(item)` (a VISUAL's
  `box`), `needsCutout(item)` (a big word only: a VISUAL is in front, over the footage), `nearestSpot(box, preset)`,
  `boxFaceShare`, `spotFaceShare`, `bigWordCoveredShare`, `placedBigWord` (a big word at its stored
  `position` and `size`, its width from HarfBuzz at 1 px) and `maskSpans(edit, transcript, preset)`:
  the span of each big word (the items that need the cut-out) padded by `padFrames`, clamped
  to the reel, widened to whole frames, overlapping or touching spans merged, sorted, to the
  millisecond. The builder (one composite per span) and the worker (one mask per span) both call
  it, so they always agree.
- A caption with `hidden_by` is left out (`hiddenCaptionIds(edit, resolved)` in `src/transitions.ts`: the
  captions with `hidden_by`, and a stored list caption with none whose start falls inside its list's layer),
  so the page and the checks never see it. The engine splits a caption in time so that `hidden_by` covers
  only a stretch the text is on screen for (see Placement, "never the same word twice").
- The hook renders like an accent (the primary font, white, the same rise in and fade out, no
  shadow) with its own class: `<span class="text hook f-primary">`, its lines centred by the
  `.hook { text-align: center; }` rule, written only on a page with a hook (so every stored page
  builds byte for byte as before). `TextBox.kind` is `hook` for it.
- Behind the speaker, one composite per mask span, above the footage and under transitions and
  text: an untimed isolated group (`.cutout`, id `cut_<n>`) holding a footage copy (`muted`,
  `data-media-start` equal to its `data-start`), the span's big words (the `<div>` at its measured
  size, with its own start and duration as the hard cut), the mask inverted and multiplied (`.mask-under`, keeps the picture
  where the person is not), and an untimed `plus-lighter` sub-group (`.cutout-front`) of a second
  footage copy times the mask (the person back in front). Every layer is a plain timed element, so
  the player and the render's frame injector show the same pixels. A span with no matching entry
  in `inputs.masks` (start and end within half a millisecond) throws.
- VISUALs (always in front of the speaker): each VISUAL's frame (`clip visual`, track index 30) after
  the composites, above the footage and under transitions and text, with no cut-out (so no mask span
  and no mask). A page whose only behind items are VISUALs writes the `.visual` rule and no composite.

### Transitions tied to a phrase

- `src/transitions.ts`: pure helpers shared by the engine and the builder. `transitionTiming`: the layer
  comes in as its entrance (`seconds`, 0.3 s) ends on the phrase's first word, so it starts 0.3 s before
  that word (never before 0; the fade is finished as the word starts), and goes out at the phrase's last
  word's end. No hold after the phrase and no minimum; only a phrase with no length at all is lengthened
  to the shown floor (`SHOWN_FLOOR_SECONDS`, 0.5 s, from its first word, earlier where the reel ends,
  `transition-min`). On a reel under the floor it gives null and the layer covers the whole reel
  (`transition-time`). The engine then starts it later, never after its first word, when a text picked
  earlier is still on screen (`transition-entrance`: the entrance is shorter, down to none), and the text
  rule (`text-one-at-a-time`) may cut its end.
- Claude gives the LIST as `lists: [{ items: [{ from, to, key_from }] }]`: each list has one or more
  items, and no item has a kind (every LIST item is numbered; `TRANSITION_KINDS` is the stored type only).
  The engine writes each item as a transition item with `words`, `key`, `list` (the list's place in the
  reel, 1, 2, ...), `number` (the item's place in its list, in reel order, 1, 2, ...; left out when the
  list keeps one item, so a one-item list shows no number) and `levels` (`number`, `lead`, `key`, each
  `{ text, position, size, break_after?, start }`). Numbering restarts at 1 in each list.
  The lead-in (words before `key_from`) is caption text and the key phrase accent text, from the style
  roles (`levelStyle`), never a literal font or colour. The layer has no background and no dim:
  its number (only in a list of two or more items) and its text levels over the phrase.
- Each level appears whole on its first word and stays until the layer leaves. The captions of the
  phrase are hidden only while the layer is on screen (`hidden_by` the transition, no position, shown
  through the levels); the words a cut list no longer shows are normal captions. A visual may show during
  a running transition, while the other text picks keep off it (`text-one-at-a-time`). The engine places transitions'
  levels before the captions, in free space inside the layer and the safe zone, off the face where
  possible; every retime, move, shrink, wrap, fallback and overlap is an `EngineNote`.
- The builder renders `levels` as children of the layer. `safe-box` includes levels; a hidden caption
  has no position, so `face` and `timing` never see it. `choicesOf` reads a transition with `words`
  back as its phrase and `key_from`; the items with one `list` number read back as one list, in reel
  order (an item without `list`, an older version's, reads back as a list of its own). One without
  `words` is read by its anchors, with `key_from` its first word.

### The written hook

On social media the first seconds decide whether people keep watching; before the hook, nothing
but captions showed in a reel's first seconds. The basic rule "every text on screen is a spoken
word" is now "spoken words, plus one written hook at the start".

- Its own AI call writes it, the hook call (`hook: { text }`, always, `app_docs/decide-step.md`); the
  components' answer does not carry it. The decide step puts it beside the components as the engine
  input's `hook` (`HookChoice`), and `choicesOf` reads it back as its text (null for a version without
  one), so it round-trips through a change.
- It reads like a social post and never ends with a full stop: a question mark is welcome, an
  exclamation mark allowed. The prompt asks for one line with no sentence-ending dot, and
  `stripHookStop` (`src/decide.ts`) takes any final dots or ellipsis (".", "...", "…", spaces
  after them) off the parsed answer's hook before it is placed and saved, the owner's exact words
  included; a dot inside stays, and a hook of nothing but dots is refused ("a hook needs words").
- Timing: from `pace.hook.fromSeconds` (0.2 s) to `untilSeconds` (3 s), cut to the reel's end; on
  a reel too short for the shown floor (0.5 s) it starts as early as the reel allows, to the reel's end
  (`clamped-to-end`, rule `hook-time`), and is never dropped. Both
  anchors are `anchorAt` (the nearest word end within a second, else a time where nobody speaks),
  so it follows its words through a re-time.
- A fixed slot (owner decision 2026-11-07): every reel has one, and it is placed on every run, first.
  `placeEdit` places `hook` first of the components, before every other extra and the captions. It shows from
  `pace.hook.fromSeconds` (0.2 s) to `untilSeconds` (3 s), and no other item moves it or shrinks it. A text
  pick (accent, question, big word, list) said in its window cuts the hook where it starts
  (`text-one-at-a-time`, noted): the hook then shows from 0.2 s to that start. If that leaves less than the
  shown floor (`SHOWN_FLOOR_SECONDS`, 0.5 s), the hook keeps the floor from 0.2 s and the text pick shows
  over it (`kept-overlapping`). A visual keeps its own times and may show over it (`kept-overlapping`, rule
  `all-picks`).
  Captions keep running below it; nobody says it, so no caption is ever left out for it.
- Placed first on every run (owner decision 2026-11-07): the captions come after it, so the captions in
  its window keep clear of it by the caption rules: each block moves to a free place, shrinks down to the
  floor, and only when nothing else is free goes over the face on the caption line (`covers-face`, rule
  `caption-face`). A caption-heavy opening never pushes the hook out.
- Placement: the accent's font, size and colour, in the upper part of the frame (the safe zone's top
  half, above the face), else the free part of the safe zone; in each place it
  tries one line, then two (the balanced break), at each size down to the floor before it moves on.
  Contrast as for an accent. When nothing fits at any size, its slot is used at the largest size whose
  words fit the safe box in one or two lines, at the upper part's place, over the face only as the last
  resort (noted). Its tiers: the upper part and the free safe zone clear of the face and the text, at each
  size down to the floor; then below the floor; then clear of the text only, over the face (noted
  `covers-face`, rule `hook-face`); only then the slot. Below the floor it shrinks further, to the smallest size at which its words fit the
  safe zone in one or two lines (`hook-size`, `shrunk`), never below `MIN_TEXT_SIZE` (8 px, the schema
  minimum for every text size: the schema refuses a smaller one, so no edit with a smaller size is ever
  built). The hook is never dropped for its size. Notes: `hook-spot` (`moved`), `hook-size` (`shrunk`),
  `hook-wrap` (`wrapped`), `all-picks` (`kept-overlapping`), and `hook-time` (`clamped-to-end`).
- Checks treat it as text: `safe-box`, `timing` (the hook at least `SHOWN_FLOOR_SECONDS`, 0.5 s; an accent,
  question or list level has a length, no minimum) and the glossary check (`glossaryChecks` reads every overlay's text).
- The written hook is an overlay with its own kind (`hook`, keyed once per reel). The studio's
  tracks timeline shows it in its own `Hook` row
  (`app_docs/studio-reel-layout.md`).

### The layout engine's input

- `src/engine-input.ts`: `EngineInput` is what the decide answer hands the layout: `accents`
  (word ranges), `questions`
  (QUESTION: word ranges the engine places as accents, with the ACCENT's look and timing for now; an overlay
  of kind `accent` with id `question-N`, read back as a question by `choicesOf`; left out in an answer saved
  before it, which reads as none), `big_words` (a list of `{ from, to }` word ids: one word, or
  two consecutive ones, equal for one; the same word allowed
  again), `visuals` (a word range and an optional `description`), `lists` (LIST: each `{ items }` a non-empty list of word ranges, each with `key_from`, where its key phrase starts; no kind), `word_fixes` (a word id and its text), and the optional `hook` (`{ text }` or null). No
  times, positions, sizes or spots.
- What a new answer may hold (`decide-17`): no title (the written hook is the one line at the start,
  and the hook call writes it), LIST items in lists of one or more items (no kind), and no `wish`.
- `choicesOf(edit, transcript, preset)` reads a version back as an `EngineInput` (what Claude is
  shown): each item by its anchor words, or the words spoken under it; a caption whose text differs
  from its words is a fix on its first word. A VISUAL reads back with its description. Every big word
  reads back (a two-word one from its first word to its last). The hook reads back as its text, null
  when the version has none.
- Variants (`src/variants.ts`): `VARIANTS` holds the seven entries, keyed by name (`hook/written-line`,
  `accent/above-head`, `question/as-accent`, `bigword/behind`, `visual/card`, `list/numbered`,
  `caption/default`). Each names its component, layer, type, style (a font role and colour; a box's
  stroke), ranked zones (names of the zone table only), timing option, whether its words hide the
  captions, and a box's aspect and width, or a stack's levels. No sizes, no positions. A wrong field or
  an unknown zone fails typecheck.
- The picker (`src/variant-picker.ts`): `pickVariants(input)` maps each pick of the input (a hook when
  there is one, each kind of pick the answer holds, and the captions, always placed) to its entry, one
  per component for now. `editFromAnswer` and the worker's `first_version` step call it and pass the
  result to `placeEdit`. Placement does not read the entries yet; each engine note names its
  component's picked entry as its `variant`.

### Layout engine

`src/engine.ts`, `placeEdit(current, input, picked, transcript, headTrack, preset, measurer, { backgrounds? })`
(`picked` is `pickVariants(input)`) returns `{ tracks, record }`: the edit's tracks as the builder consumes them (every caption, accent,
hook and big word with `position` and `size`, every visual with a `box` and `spot`) and the record of
what it did. Pure and deterministic: no randomness, no clock, no I/O; the same input gives the same
tracks and record. `editFromAnswer` (decide, returning `{ ok, edit, record }`) and the worker's
`first_version` step (with no choices) call it, each with `pickVariants` of its input.

The zones (`src/engine-zones.ts`, `zonesAt(name, S, F)`) are the named areas the placement will use:
each zone's areas inside the one safe zone `S` (the guard minus the notch) and its wanted point, from
the moment's face `F` (null when no head is in the frame). The engine does not call them yet; the
placement still uses its own candidates (the build order of `specs/layout-engine.md`, step 2).

One placement shows every pick the answer proposed. Nothing is dropped for room, for another pick's
time, for the hook, for a transition's rate or for pace. The one drop is the same-text rule (rule
`same-text`): a text pick (an accent, a question, a big word or a list) that shares a word id with another
text pick never shows that word twice while both are on screen. The rule looks only at picks whose placed
spans overlap in time: two picks that share a word but never show together both keep it. Of two that
overlap, a big word keeps the shared words over an accent, a question or a list; between the others the one
placed earlier (its start; on a tie the rank: the hook, the accents, the questions, the big words, the lists)
keeps them. The other shows its own words only: its range is trimmed to its largest contiguous part without
a shared word, and when no word of its own is left it is dropped, noted (`dropped`), its reason naming both
picks and the word. A trimmed or dropped pick is noted `retimed` (rule `same-text`). Each such change places
the answer again (`placeEdit` runs `placeOnce` until no two overlapping picks share a word id), so the rule
holds on the placed times; a dropped pick keeps its position in the answer, so the other picks keep their ids. Text picks never
share the screen in time: they show one at a time, the earlier one cut where the later one starts (or the
later one waiting, for the hook and a big word), noted (`text-one-at-a-time`). A visual may overlap any
pick; each such overlap is kept and noted.

- Inputs: the current version (footage and captions kept, never its sounds; each word fix becomes the text
  of the caption showing that word; old positions and sizes are removed), the answer's choices, the
  transcript with word times, the head track, the preset (fonts and sizes, behind spots as candidates)
  and the HarfBuzz measurer. The safe zone is `SAFE_ZONE`, not a preset field.
- Timing first (owner decision 6):
  - Captions: each from its own word; a group (consecutive captions ending on the same anchor)
    leaves at its last word's end, held so its last caption shows at least 0.25 s, never past the
    next group's start; a last caption that cannot show that long joins the next group.
  - Accent and question: exactly while their words are spoken, from the first word's start to the last
    word's end. No lead and no minimum: the start anchor is the first word, with no offset. A pick with no
    length at all shows the shown floor from its start, earlier where the reel ends (`clamped-to-end`).
  - Big word: from the lead before its first word (`accent.leadSeconds`, 0.2 s; the start anchor is the
    first word with `offset` -0.2) to its last word's end, at least `accent.minSeconds` (1.5 s). Ids `big-word-1`, `big-word-2`, ... in answer order.
  - Visual: from its first word to its last word's end, at least `behind.minSeconds` (1 s) and at most
    `behind.maxSeconds` (2 s), clamped to the reel's end at 0.5 s. There is no sentence bound: a
    visual may run past its short sentence. A fallback that moves it earlier than its sentence is
    noted `retimed` (rule `visual-time`).
  - A big word's lead never starts before 0. Captions have no lead.
  - The hook: from `pace.hook.fromSeconds` to `untilSeconds` ("The written hook" above), its start fixed.
  - Transitions (LIST): from 0.3 s before their phrase's first word (the entrance) to its last word's end;
    no hold (`transitionTiming`, "Transitions tied to a phrase" above).
  - The text picks are then cut so that they show one at a time (see Placement, `text-one-at-a-time`):
    the earlier one ends where the later one starts, and nothing waits. A big word or visual over hidden
    footage moves to the next visible moment (see Placement).
- Scene: the reel is cut into moments at every item edge; each moment's face is the bounding box
  of the robust faces around it (`facesOver` in `src/head-track.ts`: at each head-track sample, the
  samples within 0.5 s, `cx` their median, the width their upper quartile, the top their lower
  quartile, so one bad reading never moves it), padded by 35 px left, 30 px right
  plus `gap` above and below. There is no body rule: the body under the face is no obstacle to any front
  element (captions, accents, the hook and cards may sit on the chest), nor to a big word's visibility share,
  which counts the face only. The mask itself is not read (it is a video).
- Free space (`src/engine-space.ts`, with `TextBox`): an area minus its obstacles (the moment faces over the item's
  time, the text already placed over it, the `PLATFORM_BUTTONS` notch) as the largest free
  rectangles (each rectangle an obstacle cuts becomes its parts left, right, above and below), and
  `placeBox`: the whole-pixel place nearest a wanted point where a box fits.
- Placement by priority:
  - Transitions' text levels first, in their layer's free space (see "Transitions tied to a phrase").
    Then the written hook, in its fixed slot (see "The written hook").
  - Then the other components, each in answer order: accents (questions with them), big words, visuals.
    They never avoid captions: captions are not placed yet, and the captions take the space left.
  - Accent: above the head (its top about 190 px above the head), the upper part of the frame, the
    free part of the safe zone (with no head: the accent line at y 1130, then the safe zone). In
    each candidate it shrinks to the floor (60%) and wraps to two lines (the balanced break) before it
    moves on. Its tiers, each tried for every candidate and size before the next: clear of the face, the
    text and the notch; clear of the text and the notch only (over the face, noted `covers-face`, rule
    `accent-face`); and last
    its default spot, at the largest size that fits down to 8 px (`MIN_TEXT_SIZE`), the text it sits over
    noted (`all-picks`, with what it sits over). A place only at a size under the floor does not count as
    free: the candidate sizes end at the floor, so an accent can be kept over other text while a clear place
    exists at a smaller size.
  - Big word: as large as fits between the side margins (at most `maxSize`, 400 px), its centre
    wanted `belowHeadTop` below the robust head top at its span (or at `noHeadY`), at the nearest
    place inside the frame (40 px margin, never above `PLATFORM_SAFE`'s top 220). The head never moves
    it; the text on screen does: at the largest size that has a place clear of the text over its span,
    the nearest such place to the wanted centre (moved, rule `big-word-spot`). With no clear place at any
    size it keeps its rule's place at the largest size that fits, the text under it noted as an overlap
    (`all-picks`, with the texts). Most of it stays in view: in every column the face (the robust faces over its span, `facesOver`)
    covers at most the lower 30% of its height
    (`bigWordCoveredShare` in `src/behind.ts`, shared with the check). A larger cover is kept and
    noted (`all-picks`, "the person covering N% of it"). Where the word does not fit at its size, the
    next smaller size is tried down to the floor (60%, `shrunk`, rule `big-word-size`); with no place
    at all it is set at the top-left corner of its area.
  - Visual (the card, owner decision 2026-11-07): the first card spot that fits, ranked by the free space
    around it (see "Preset values"), at the full size, then at the smaller step (0.7, noted `shrunk`,
    rule `visual-size`). Tiers, in order: off the face, the accents, the hook, the big words, the list
    levels and the button column, at either size; then over the face but off those texts, at either size
    (noted `covers-face`, rule `visual-face`); last, over other text at the full size, at the top-left
    corner of the safe zone when no spot is free (noted `kept-overlapping`, rule `all-picks`). Written:
    `box` (the card's place and size), `spot` (the nearest preset spot).
  - Card contrast: with the background map, the WCAG ratio of the card's white edge against the footage
    in and 30 px around it (`ring`) must reach `minContrast` (1.5); below it the card tries nearby places
    (the readable-text grid, `readability.moveRadius`, inside `PLATFORM_SAFE`, clear of what the card's tier
    avoids: the other text, the button column, and the face unless the card covers it) and moves to the nearest that reaches it (`contrast-spot`,
    `moved`), else stays (`contrast-stay`, `low-contrast`, `... a visual never gets a shadow or a colour change`). Never a shadow or a colour change; recorded only, never a check. A card without a known
    background is not measured.
  - Captions last, in time order, in the space the components leave at each moment (see the order above),
    one spot per sentence (`sentenceSpans`): the sentence's groups all start at the same place, sized for
    its largest group (at most two lines per group); captions inside a transition take its text area as
    one block instead. They prefer spots off the face, and avoid every component and every other caption. Candidates: beside
    the head (the wider side first, aligned towards the face, near the mouth), below the face, the caption
    line (`fallbackY` to the safe bottom); with no head, the caption line then the safe zone. Every
    candidate is tried at the full size before a smaller one, down to the floor (60%), so captions stay
    readable. A caption that fits no free place even at the floor goes over the face, clear of the other
    text, on the caption line or at the top of the safe zone (`covers-face`, rule `caption-face`). Only
    when no place is clear of the text either, it sits over other text as the last resort, wrapped as far
    as it takes, each unit noted `kept-overlapping` with the texts it sits over.
  - Never the same word twice on screen: the same-text rule above keeps two text picks on screen together
    from sharing a word id, and the `same-text` check (below) fails any spoken word two items show at a shared moment.
    By time: the captions are split in time against the texts on
    screen (the hook shows no word, so it never splits one). A caption's words that an accent, a big word
    or a list's phrase shows while that text is on screen are left out for that stretch (`hidden_by` the
    text, no position): a run of words all shown by one text is one caption, and the other runs stay
    captions of their own (a cut list's later words, a caption's words after an accent), numbered `-2`,
    `-3`, ... after the caption's id. Only the captions left in are placed: a group keeps its own rest, in
    the block's place, size and alignment, and a group with every caption left out shows no caption then.
    The captions left out take no room, so they block no other text. Nothing is recorded for it.
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
  `contrast-spot`, action `moved`); else the text stays where it is, plain white, with no shadow
  and its colour kept, and the record says so (rule `contrast-stay`, action `low-contrast`). Owner
  decision 2026-11-04: move first, never
  a shadow, never a colour change. The big word is never moved for contrast; a caption that already
  covers the face is never moved for it. Low contrast is recorded only: it is no check failure and
  no engine bug, and the version saves as usual. With no `backgrounds` given nothing is measured.
  Example reason: `captions "the time we're living right now push ..." stay in place:
contrast 1.8:1 from 0.28 s to 7.51 s, no free place nearby reaches 4.5:1` (an accent or big word:
  `stays in place`; for a caption over the face or the big word the reason ends with
  `captions over the face are never moved` or `the big word is never moved`). No text
  style anywhere (captions, accents, big words, transition levels) adds a stroke or an
  outline (`-webkit-text-stroke`, `paint-order`, a text shadow).
- Sounds (`src/clicks.ts`, `clicksFor`, owner decision 2026-11-04): the engine writes a new
  version's sound track. One `click` (`click-<item id>`) as each placed visual
  and each big word comes in, on the item's own start anchor (a big word's lead, 0.2 s before its
  word), its end the item's end, so the click follows its item through every retime.
  Nothing else clicks: captions, accents, the hook and transitions stay silent. In
  time order, a click under the sound's gap (0.25 s) after the one kept before it is left out,
  with no note. The current version's sounds are never kept; a stored version's sounds are never
  rewritten (it is never placed again). No switch to turn them off yet.
- Placement: every pick the answer proposed is shown, at its own words' times where the text rule
  allows: an accent or question exactly its words; a big word from the lead before its first word (0.2 s)
  to its last word's end (at least 1.5 s, a target); a visual from its first word to its last word's end
  (1 to 2 s); a list from 0.3 s before its phrase's first word to its last word's end; the hook in its
  window. The text picks then cut each other, never wait (`text-one-at-a-time`, below). Each pick takes its normal spot when a free one exists. When none
  does, it takes its default spot anyway (an accent or a transition's text at the head's upper place
  or the line, a big word at its head rule's centre, a visual at the top-left corner of the safe zone),
  at the largest size that fits and never below `MIN_TEXT_SIZE` (8 px). The overlap is noted
  `kept-overlapping` (rule `all-picks`) with what it sits over (the face, other text, named) or the picks it
  shares its time with. Text never overlaps other text while a free spot exists (Rules): the default spot
  over other text is the last resort for each text, after the face-only tier. The only `dropped` note is the
  same-text rule's (`src/engine.test.ts`, "every pick shown, or dropped where another pick shows its text"). The fallbacks, each noted:
  - A big word or a visual too close to the reel's end for its minimum: the end is the reel's end and the
    start moves earlier, so it shows at least `SHOWN_FLOOR_SECONDS` (0.5 s) (`clamped-to-end`). An accent,
    question or list has no minimum, so it is never shown from earlier; a pick with no length at all
    shows the floor from its start (`clamped-to-end`, rule `accent-time`).
  - Text one at a time (`text-one-at-a-time`, `retimed`), and no text waits: the hook, accents,
    questions, big words and lists never share the screen in time. Walking them in the order they start
    (a tie going to the answer's order, the hook first), the earlier one ends where the later one starts.
    So a text starting inside the hook's window ends the hook there, and a text starting before the hook
    ends where the hook starts. A big word's minimum is a target: a text said later cuts it short. Each
    text starts at its own start (an accent, question or list on its first word, a list's entrance 0.3 s
    before it; a big word at its lead, never earlier than a text starting inside that lead; the hook at its
    slot start), so no text lands after its own words. A text cut to no length, or a hook or big word cut
    shorter than the shown floor (what the checks and the schema need), keeps its start and shows the shown
    floor from there, over the text that cut it (noted, `kept-overlapping`); an accent, question or list
    needs only a positive length. The words a cut text no longer shows are normal captions. A list's
    entrance is never before the end of a text said earlier: it comes in later, the entrance shorter
    (`transition-entrance`, `retimed`). Each note gives both items and their times in plain words. Visuals
    are not text and are never cut.
  - A big word or visual over hidden footage: the next visible moment, the first kept time after the
    cut, else the last one before it (`moved-off-cut`, rule `hidden-footage`). With no visible moment
    at all it stays over the cut, and the schema then refuses that edit.
  - A transition or list pick with no caption text of its own: the words of its phrase are its text
    (`text-from-words`); a text over 300 characters is cut at a word, noted the same way.
  - The hook: its start moves earlier when the reel is shorter than its window (`clamped-to-end`, rule
    `hook-time`); with no free place at any size, its slot at the largest size that fits, the overlap
    noted. The hook keeps its fixed slot in both cases.
- Captions are never dropped: with no free place even at the floor, they take the caption line over
  the face (recorded `covers-face`); only with no free place there either do they sit over other text,
  each caption noted `kept-overlapping` with the texts it sits over. A caption left out while an extra shows its words is not dropped:
  its words are on screen.
- Record: a list of `EngineNote` (`packages/edit/src/engine-note.ts`, the shape of
  `specs/layout-engine.md`): `{ item, component, variant, start, end, rule, outcome, blockers, reason }`,
  with `zone`, `size`, `lines` and `cost` optional. `component` is HOOK, ACCENT, QUESTION, BIGWORD,
  VISUAL, LIST or CAPTION; `variant` is that component's entry (`hook/written-line`, `accent/above-head`,
  `question/as-accent`, `bigword/behind`, `visual/card`, `list/numbered`, `caption/default`); `start` and
  `end` are the placed span in seconds. `outcome` is one of `placed`, `moved` (not its kind's first
  place), `shrunk`, `wrapped`, `retimed` (a clamped or moved-off-cut span, a same-text trim), `covers-face`,
  `dropped` (same-text left no word of its own), `no-spot` (not yet written) or `kept-overlapping` (a text
  kept over other text or another pick; a transitional value, see the layout spec). `blockers` names what
  took the space it did not get: `{ kind: "item" | "caption", id }` for the texts a kept-overlapping text
  sits over, `{ kind: "face" }` for a covers-face note. Every shown element with no other note gets a
  `placed` note, so the record names every element. `reason` says in plain words what happened, with the
  item's text and times, for example
  `{ "item": "visual-1", "component": "VISUAL", "variant": "visual/card", "start": 23.48, "end": 26.23, "rule": "text-overlap", "outcome": "kept-overlapping", "blockers": [{ "kind": "item", "id": "accent-1" }], "reason": "visual 1 sits over the face from 23.48 s to 26.23 s; kept, every pick is shown" }`.
  The rules in the sections above are the placer's own names; the record's `rule` is the name each one
  maps to (`RULE_OF` in `engine-note.ts`): `*-time`, `*-min`, `transition-entrance` and `text-one-at-a-time`
  are `timing`; `*-spot` is `zone`; `*-size` and `*-wrap` are `size`; `*-face` is `face`; `all-picks` is
  `text-overlap`; `transition-text` is `text`; `contrast-spot` and `contrast-stay` are `contrast`
  (readability is out with build step 11); `hidden-footage` and `same-text` keep their names. The
  placer's outcomes map as: `low-contrast`, `text-from-words` to `placed`, `clamped-to-end` and
  `moved-off-cut` to `retimed`; the rest keep their names. A placer rule the table does not name throws,
  so a new rule is named there on purpose. Saved with the version (`versions.engine_record`) and logged by the worker in
  one line per version. No old note shape is read anywhere.
- Final checks: `runChecks` (below) runs on every placed edit. They must never fail on the engine's
  output, except `face` for a caption over the face that the engine recorded as `covers-face`; any
  other failure, `text-overlap` included, is an engine bug, logged with the reel id while the version is
  still saved.

### Checks

`src/checks.ts`, `runChecks`, in a stable order, each failure `{ rule, item, reason }` with a
readable reason string (an empty list means every rule passes):

- `safe-box`: text inside `SAFE_ZONE.box` (`PLATFORM_SAFE`) and clear of `SAFE_ZONE.notch`
  (`PLATFORM_BUTTONS`), the one safe zone (the edge and value that run past the box, or `runs into
the platform button column below y 1164` with the right edge past x 945). A transition's text
  levels count as text.
- `frame`: a big word behind the speaker inside the frame (each edge that leaves it, and the
  word). It crosses the safe box by design, so it is never checked against it.
- `face`: captions clear of the face (the robust faces, `facesOver`, at every moment of the
  caption's span, the same ones the engine avoids). The one failure it allows is a caption the engine
  put over the face and recorded as `covers-face` (its block's note names the other captions it sits with
  in `with`; `apps/worker/src/decide/run-decide.ts` leaves them out of the refusal). A hidden caption has no position, so it is never checked.
- `text-overlap` (`checks.ts`, the single mode's rule): two texts (captions, accents, questions, the hook,
  big words, a list's levels) that share a moment never overlap on screen, except a pair the engine record
  notes as `kept-overlapping` with the other in its `with` (either item's note may name the other). It
  needs the record: `build(edit, ..., { engineRecord })`, which the decide step and the first version pass.
  The engine's output never fails it.
- `same-text` (`checks.ts`): no spoken word (by word id) is shown by two items at a shared moment. The items
  are the captions shown (not those a text hides, `hidden_by`), the accents and questions, the lists and the
  big words (their `words`). The reason names both items and the word. The engine's output never fails it:
  the same-text rule (above) and the caption split keep it so.
- `timing`: captions at least `caption.minSeconds` (0.25 s) on screen, the hook at least
  `SHOWN_FLOOR_SECONDS` (0.5 s), and every other text box (an accent, a question, a list's level) a length
  above zero, with no minimum.
- `big-word-timing`: the big word never shows more than `accent.leadSeconds` (0.2 s) before its
  word (the matching spoken word nearest its start) is said.
- `sound-gap`: two sounds at least the preset's gap (0.25 s) apart.
- `time-in-speech`: a time anchor outside speech (it names the word to anchor to instead).
- `out-of-reel`: an anchor that resolved outside the reel and was clamped.

The checks look at overlaps between texts only (`text-overlap`); a visual over the face is noted
`covers-face` and a visual over a text `kept-overlapping`, like any pick. The glossary check is separate (`src/glossary.ts`, `glossaryChecks`).

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
  masks; every check passes) and `rethink-work-hand.edit.json` (by hand, with accents and a click),
  with `src/testdata/rethink-work/` (its transcript
  and real head track), and `rethink-work-behind.edit.json` (the hand edit with a `top` visual and
  the big word `WORK` behind the speaker, two masks with placeholder fingerprints) on the same data,
  and `rethink-work-hook.edit.json` (the engine's choices with the
  written hook "Gen Z won't work like you did", placed by the engine: its own class, wrapped and
  shrunk in the upper part of the frame), and `rethink-work-request.edit.json` (the request's visual "add images behind me" placed over
  its question sentence, clear of the face, no mask for it).
  `src/test-support/fixtures.ts` imports them as JSON modules so
  both runs build exactly the same inputs.
- `src/build.test.ts` (Node, `measurer.node.ts`) and `src/build.browser.test.ts` (Chromium,
  `measurer.browser.ts`, the same wasm and fonts fetched from the test server) build every fixture
  and compare the page and the widths with the committed goldens in `src/testdata/golden/` byte for
  byte. The Node test also builds each fixture twice and expects the same result.
- Negative proof: during the run a temporary probe (never committed) swapped the browser
  measurer for canvas `measureText` with the same fonts loaded through `FontFace`; the browser
  comparison then failed, so the test detects a measurer that differs from HarfBuzz.
- `scripts/golden.ts` (`yarn workspace @edit-issebya/edit golden`) rewrites the engine-placed
  fixture versions (the hook one included) and every golden from the Node build, all with `ISSEBYA_PRESET`. Commit what it writes. The two engine inputs (hand and behind) have no golden;
  stored versions are never placed again.

## Testing

- `yarn turbo run test --filter=./packages/edit`: the `node` and `browser` Vitest projects
  (`vitest.config.ts`); the browser project needs Install step 3's chromium. `turbo.json` passes
  `PLAYWRIGHT_*` and `CI` through. Also the schema, timeline, checks, transitions, clicks, preset,
  baseline and versions tests, a build of the 50-second edit under 200 ms (`src/build.test.ts`), and
  `src/behind.test.ts` (spots, visual boxes, mask spans padded, clamped and merged, a visual left out
  of them). Each placed fixture's page and widths are compared with its golden in both projects
  (`src/build.test.ts`, `src/build.browser.test.ts`); the two engine inputs (`rethink-work-hand`,
  `rethink-work-behind`) have no golden, since their captions have no positions.
- `apps/studio/db-tests/versions.test.ts` under `yarn test:db`: `save_version`, version
  immutability and its RLS.
- `apps/worker/src/first-version.test.ts` (version 1 saved, kept on a retry),
  `apps/worker/src/edit-import.test.ts` (Node imports the package's TypeScript source) and
  `apps/worker/src/decision-trace.test.ts` (one row per proposal, `kept` or `changed`, the summary line).
- `src/engine.test.ts`, by group:
  - "the layout engine's timing": each caption from its word; an accent exactly its words, no minimum; a
    question as an accent; a big word from the lead before its word, at least 1.5 s, one word or two in
    one element, the same word again; a visual from its first word, 1 to 2 s, shown even past its short
    sentence.
  - "text picks one at a time": an accent cut where a list starts, a list cut by an accent with its later
    words shown as captions, a big word cut by an accent said in its minimum, a visual never cut for an
    accent; no text lands after its own words and no two texts share the screen, on the dense reels.
  - "the layout engine's timing" also: a list's layer starts 0.3 s before its first word, never before 0.
  - "never the same word twice on screen": the caption words an accent or big word shows are left out
    (`and sense of purpose` reads `and`, `it to the world` reads `it to the`), a whole group hidden,
    and a stored caption without the field builds as before.
  - "big words in view": a short big word kept at the head's rule place, noted when the head covers
    more than 30% of it.
  - "the layout engine's placement": no check failing on a dense reel (accents, a big word, visuals and
    a transition together) and on the Intense rhythm with the real head and with a large centred
    face; one spot per sentence; the big word on its word and inside the frame with one bad head
    reading; a long accent shrunk and wrapped; captions over a face that fills the safe zone
    recorded; an accent on the chest (below the face) when that is its best spot; every front element
    over the face on the dense reels with three heads noted `covers-face`, and the face check passing
    only as noted; determinism; the engine placing its own output the same again.
  - "today's failures, placed by the engine": a transition's text levels kept off the face; a visual
    placed over its sentence, nothing dropped.
  - "visuals: corner cards over the footage": a card at a corner or beside the face, inside
    `PLATFORM_SAFE`, clear of the face with no failed check, drawn as a white frame; the full size
    where a side is free and the smaller step where only it fits; a card over the face only when every
    corner and side is taken, noted `covers-face`; the size and ratio kept across a
    reel; a card whose white edge blends with the footage moved, else kept plain and noted
    `low-contrast`.
  - "clicks on visuals and big words": a click as each placed visual and big word comes in and
    nothing else (at `data-volume="0.5012"`, the -6 dB click), a visual the face leaves no corner for
    still clicking, and a stored version's sounds left as they are.
  - "readable text": a caption block moved to a darker free place in its zone, a place kept plain with
    only a note when none reads, an accent moved off a light sweater or kept plain, a big word left in
    place on a light background, nothing changed on a dark background, determinism over a map, and no
    measurement of a transition's levels.
  - "transitions": a transition shows exactly its phrase (in at its first word, out at its last word's
    end, no hold after a long pause), a short phrase keeps its words, the lead-in and
    the key phrase take the style roles inside their area, a face covered only where the face fills
    the area and noted, numbers 1, 2, 3 in reel order, two lists in one reel numbered from 1 in each,
    a one-item list with no number, a placed version read back by `choicesOf` as the same lists, determinism.
  - "a request's visual": the visual of "add images behind me" placed over its sentence with the
    captions kept, its description kept, the committed request fixture matched, and determinism.
  - "the written hook": from 0.2 s to 3 s in the upper part of the frame, off the face, inside the safe
    zone; cut where a text said in its window starts, the floor over it when that is too short, noted;
    an accent said before the hook ends where the hook starts; its place and size kept when an accent and
    a visual are asked for in its window; read back and placed the same again; a
    caption-heavy opening keeps the hook; never below the schema's minimum size, and wide words shrink
    it until two lines fit; a reel too short for its window shows it from earlier, to the reel's end,
    noted.
  - "every pick shown": every pick passes the schema; the text picks one at a time, noted; a visual exact;
    a question shown with the others; the cuts and overlaps said in the record; a visual the face leaves no
    corner for placed over the face, noted `covers-face`; a big word the head hides placed at every height
    where it is, noted; a transition that runs during the hook shown with the hook's window kept.
  - "texts never overlap on screen while a free spot exists": random picks over the fixture reel and over a
    caption-heavy opening never fail `text-overlap`; a big word over the captions of its sentence moved
    clear of them (`big-word-spot`); a text that shares its time with a cut hook's floor noted with it.
  - "nothing the answer picks is dropped": a pick at the reel's end, a pick over a cut, a transition
    with no text of its own and a hook on a 1 s reel are all placed. (Random sets of picks are checked in
    "every pick shown, or dropped where another pick shows its text": a pick is dropped only by `same-text`.)
- `src/decide.test.ts`: the components' JSON schema (word ids, closed objects, no time, position,
  size, font, colour, spot, style or title anywhere, no hook); the hook's answer (one text, required,
  never null, refused above the word and character limits, one plain line, its final stop taken off,
  no wish, time or place); `parseDecideAnswer` refusals (a title, a list with no items, a kind on a LIST
  item, a wish, a checklist, a word fixed twice, a key phrase outside its phrase); visuals and
  big words (one or two plain words, no count cap); QUESTION; `editFromAnswer` keeping the current
  inputs and sounds, dropping the current masks, and placing a big word said just before the reel
  ends beside a visual.
- `src/schema.test.ts` (the overlay kind), `src/glossary.test.ts` (a heard form in the hook).
- `src/checks.test.ts`: the engine-placed fixture versions pass with an empty list; `safe-box` fails
  for a caption at y 1380 and for text in the button column's notch, and passes it higher up, under the
  platform guard whatever the preset's box; `face` fails for a caption over the head; `sound-gap` and
  `time-in-speech` fail as their rules say; `big-word-timing`, `frame` and the big word's own timing
  checks.
- `src/preset.test.ts`: the intersection, the platform guard and its notch (`SAFE_ZONE`), the fallback
  lines inside the safe zone, the numbered kind only, the Intense pace (something new every 3 s, the hook
  to 3 s), and the accent and big word timing.
- `src/engine-zones.test.ts`: the zone table (`zonesAt`), each zone with a head and with none, and every
  zone's areas inside `S` and clear of the notch.
- `src/transitions.test.ts`: `transitionTiming` (in at the first word, out at the last word's end, no hold,
  a phrase with no length lengthened to the floor, a reel's start and end, a reel too short for the floor),
  the style roles, and `hiddenCaptionIds`.
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
- Never let an overlap pass silently: a front pick placed over the face is noted `covers-face` (its rule
  per kind), and a pick placed over other text or another pick is kept and noted (`kept-overlapping`, rule
  `all-picks`).
- Never overlap two texts on screen at a shared moment while a free spot exists for the later one (at any
  candidate and size, the face avoided first): a text is placed clear of every text it shares a moment with,
  and keeps its default spot over other text only when none exists. The note names the pair (`with`), and
  the `text-overlap` check excuses only that pair.
- Never drop a pick except by the same-text rule (a text pick whose every word another text pick on screen
  with it shows, noted `dropped`, rule `same-text`); never drop a caption: with no free place even at the floor, a caption takes
  the caption line over the face (`covers-face`). A caption left out while an extra shows its words is
  not dropped: its words are on screen.
- Never read a single head-track sample for a placement or a check: always the robust faces
  (`facesOver`).
- Never show an accent or question before its first word, nor a big word more than `accent.leadSeconds`
  before its word, nor a list more than its entrance before its first word. Never make a text wait: a text
  pick never starts after its own words, and two text picks (the hook, accents, questions, big words, lists)
  never share the screen in time, the earlier cut where the later starts (`text-one-at-a-time`), except a
  floor the checks need (the hook, a big word), noted. A visual may overlap any pick; each overlap is noted.
- Never show a spoken word twice at once: a caption's words that an accent, a big word or a list shows
  are left out while that text is on screen (the caption split in time, never blinking in or out of its
  group); the words a cut text no longer shows stay on screen as captions. Two text picks on screen together
  never share a word id: of two that do, a big word keeps it, else the earlier, and the other shows its own
  words or is dropped (`same-text`). Two picks that never show together may share one.
  The `same-text` check fails any version where two items show one spoken word at a shared moment.
- Every text on screen is a spoken word, except the one written hook at the start: never more than
  one hook in a version, never a hook with words, and never a caption left out for it.
- Never end the hook with a full stop or an ellipsis (`stripHookStop` takes them off; "?" and "!"
  stay).
- Never drop the hook, never cut it short, and never let another pick move or shrink it. A transition
  or any other pick may show during it (noted).
- The hook's window never shifts: it is placed first, and its only clamp is `hook-time` (a reel too
  short for its window).
- Never let a caption drop the hook: the hook is placed before the captions, and the captions in its
  window keep clear of it (move, shrink, or last, over the face).
- Captions take the space the components leave: no component is placed around a caption (the hook,
  accents, questions, big words, visuals and list levels are placed first and never avoid captions), and
  a caption avoids every component and every other caption. A caption over other text is the last resort
  only, noted.
- Never drop the hook for its size: below the floor it shrinks until its words fit in one or two lines
  (`hook-size`).
- Never move a big word up for the head: a big word the face covers more of than the lower 30%
  (`behind.word.minVisible`) is kept and noted. Never place one above `PLATFORM_SAFE`'s top.
- Never let a visual leave its card: it is a corner card in front of the speaker, never behind them,
  always inside `PLATFORM_SAFE`. It takes a free spot off the face, an accent, the hook, a big word, a
  list level and the button column at the full size, else at `card.smaller`; only when neither is free
  does it cover the face (noted `covers-face`, rule `visual-face`), and only when no spot off other text is
  free does it sit over other text (noted `kept-overlapping`). The engine, never Claude, chooses its place
  and size.
- Never give a visual a fill, a text, a shadow or a colour change: its white stroke is its frame. A
  visual whose white edge blends with the footage moves, else stays, recorded `low-contrast`.
- Never cut out (no mask span, no mask) for a visual: only a big word behind the speaker has a mask.
- Never let Claude write a transition's time, position or size, nor a literal font or colour in a
  transition entry: they come from the words and the style roles.
- Never hold a visual past `behind.maxSeconds` (2 s), or a big word past a second after its word
  (the accent's timing), in a new version; never refuse a stored version for an older, longer
  one.
- Never click on anything but a visual or a big word coming in, never off its start, and never two
  clicks closer than the sound's gap in a new version; never rewrite a stored version's sounds.
- Never place a stored version again: the builder keeps every stored position.
- The engine is pure and deterministic: no randomness, no clock, no I/O.
- Never remove a caption, set it below the floor, or put it outside the safe zone. A caption goes over
  the face only when nothing else is free (`covers-face`).
- The engine never removes or shifts a pick to make room for another. Its only removal is the same-text
  rule (two text picks on screen together sharing a word), and a text pick is never trimmed or dropped for
  anything else; each such change places the answer again.
- Never let a version fail the schema or the checks on the engine's output, except the `face` check
  for a caption recorded `covers-face` (a block's note names its other captions in `with`). The one refusal the engine cannot avoid is a big word or visual
  over footage hidden for the whole reel (no visible moment to move it to).
- The face is a preference for every front element (the hook, accents, questions, list levels, visual
  cards and captions): a spot off the face and off other text first; then over the face but off other
  text, only when no spot off the face is free at any candidate and size (`covers-face`); then over other
  text (`kept-overlapping`). The body under the face is no obstacle to any of them. A big word is behind
  the speaker: the face is no obstacle to it, and its 30% visibility rule stands.
- Never change a text colour to make it readable, and never add a shadow, a stroke or an outline
  to any text: move it, else leave it in place, plain, and record it.
- Never move the big word for contrast.
- Never fail a check or a version on low contrast: it is recorded only.
- A version with a `behind` item is saved only once every mask it names exists; the builder never
  builds a behind item without its mask.
- A big word is checked against the frame, never the safe box.
- Text never enters the platform zones: `PLATFORM_SAFE` and `PLATFORM_BUTTONS` are a guard, never
  a preset value, and no preset or change request moves them.
- Never rewrite a stored version to fit the guard; it shows its failed check.
- Nothing Node-only or browser-only in `packages/edit`; the caller injects the platform.
- Never commit an asset without its licence (`assets/fonts/OFL-*.txt`,
  `assets/sounds/LICENSE-sounds.md`).

## Notes

- The `number` column was added beyond the issue's list: it gives the per-reel "version N", and
  `unique (reel_id, number)` doubles as a guard against two concurrent saves.
- The studio imports only types from the package until slice 9.
- The fixture clip has no person, so the face rule is proven with a synthetic head track
  (`src/checks.test.ts`) and the `rethink-work` data.
- Records saved before the single placement can hold `removed`, `no-room`, `one-extra`,
  `make-room`, `transition-overlap`, `transition-rate`, `hook` and `editorial` notes. They are read and
  shown as stored; no new record writes them.
