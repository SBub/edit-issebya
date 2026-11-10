# Edit Model: Word-Anchored Format, Style Preset, HarfBuzz Builder, Versions

**Specifications:**

- specs/issue-31-adw-7f81a19d-sdlc_planner-edit-model-builder-versions.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-114-adw-9049f8fd-sdlc_planner-platform-safe-zone-guard.md
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
  speaker), any number of items. A VISUAL (`kind: "visual"`, `decide-17`) is a white stroke frame
  showing its stand-in picture, a corner card (the `visual/card` entry), always in front: `box` its place
  and size, which the layout engine always writes, and `image`, the picture's file (one of
  `VISUAL_STAND_INS`, the layout engine's choice). A stored version without `image` renders the empty frame.
  It may carry an optional
  `description` (a short plain phrase of what the frame would show, at most 120 characters, the
  decide answer's own limit is 8 words), which is never shown on screen; the builder draws a
  `div.clip.visual` with a white border of the `visual/card` entry's stroke (8 px), transparent
  inside (the `.visual` rule is written only on a page with a visual). With `image`, the builder draws
  `div.clip.visual-picture` filling the box with an `<img>` of the same box (no crop), the stroke drawn
  over it (the `.visual-picture` rules). Or a big word (`kind: "word"`,
  `text` one or two words of 1 to 24 characters each, with no space inside a
  word and no `<`, `>` or `&`, the two joined by one space: "distribution channel"). It is anchored
  on words like a caption (a big word starts on its first word with a negative
  `offset`, the lead), cuts in and out with no animation. Its optional `cutout` (`false` when the head cannot
  reach it, decision 21; missing = true) says whether it needs the person's cut-out. A big word is a text pick: the text picks (the
  hook, accents, questions, big words and lists) share the screen in time and keep apart on it. A VISUAL
  lasts 1 to 2 s (the `visual/card` entry's timing), less only at the reel's end or over a cut, is not
  text, and may show with any text. A big word lasts from the lead before its first word to its last word's
  end, at least 1.5 s; no text said later cuts it short.
  A refinement refuses an item crossing a footage clip's `hidden` span; with the decide limit
  (`EditLimits.behindLengths`, new versions only) also an item outside its kind's length (a VISUAL 0.5 to 2 s,
  a big word from 0.5 s to the lead, its words and `afterSeconds`), so a stored
  version keeps parsing and rendering. A version without the track parses, and the builder reads it as
  empty.
- `inputs.masks`, optional, filled by the worker before a version with a `behind` item is saved:
  `masks` lists the person masks (`EditMask`, a `{ step: "cutout", fingerprint, file: "mask.mp4",
start, end }` ref plus the span of the reel it covers, in seconds, by start). A version without
  behind items has none; a VISUAL needs no mask, so a version whose behind items are all VISUALs has none, and
  neither does a big word with `cutout: false`.
- Every item has an `id` (`^[a-z][a-z0-9-]{0,63}$`, unique across tracks), a `start` and an `end`
  anchor. An anchor is a word (`{ word, edge?: "start" | "end", offset? }`, offset within plus or
  minus 1 s), a time in seconds (`{ time }`, only where nobody speaks) or the reel's edge
  (`{ reel: "start" | "end" }`). Anchors are resolved at every build (`src/timeline.ts`,
  `resolveAnchor`, `resolveTimeline`, to the millisecond), so items follow their words through a
  re-time.
- Per-item properties: captions and overlays take `words`, `text`, `font` (`primary` or
  `secondary`), `size`, `color` (`#RRGGBB`), `position` (`{ x, y, align }` inside the frame) and
  `breaks` (set in lines: each break is the number of words on the lines before it, ascending, so the builder cuts after each); a big word behind the speaker
  takes `position` (`{ x, y }`, its top left corner in the frame), `size` and `words` (the one or two word
  ids it shows, written by the engine; the same-text check reads them). A caption
  takes an optional `hidden_by` (the id of the accent, big word or list showing its words while it is on
  screen; the builder leaves it out, and a refinement refuses an id that is none of those, the hook
  included).
  The hook (`kind: "hook"`, id `hook`) takes `text` and never `words`: it is the one text on screen
  nobody says. A refinement refuses a hook with words or without text, and a second hook. Versions
  saved before it have none and parse as before.
  The layout engine writes `position` and `size` on every caption, accent, hook and big word it
  places, and a VISUAL's `box`. Positions remain optional in the format because the
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

`src/preset.ts`, `ISSEBYA_PRESET`, the values of the approved `rethink-work` reel. The preset holds
the format's and the builder's values; the layout's values live in the code that owns them: the zone
table (`engine-zones.ts`), the variant entries and the style table (`variants.ts`), the placer's costs
and rule 6 (`engine-place.ts`).

- Frame 1080x1920. The one safe zone `S` (`SAFE_ZONE` in `src/engine-zones.ts`, `box` and `notch`)
  is `PLATFORM_SAFE` minus the `PLATFORM_BUTTONS` notch: text never leaves `box` and never overlaps
  `notch`. The preset holds no safe box of its own.
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
- Fonts: `primary` Raleway Light (`assets/fonts/Raleway-Light.ttf`, weight 300) for accents, the big
  word and a transition's key phrase and number; `secondary` Golos Text Bold
  (`assets/fonts/GolosText-Bold.ttf`, weight 700) for captions and a transition's lead-in (owner
  decision 2026-11-04). The builder lists a font file once even when both roles share it. All text is
  white (`#FFFFFF`). Sizes are not here: the style table (`STYLES` in `src/variants.ts`) holds the
  bases, `accent` 110 px and `caption` 50 px, and the big word's `largest-fit`. An item with no size
  in an edit takes its font's style base.
- Captions: `#FFFFFF`, rise 12 px over 0.18 s (`power2.out`), fade out 0.15 s after the group's last word
  (the span ends one fade past it, never past the next group's start; spec decision 25), at least 0.25 s on
  screen, a group breaks at a 0.35 s pause or after 4 units, line gap 14. The caption line (y 1290) is
  the zone table's.
- Layout (`layout`): `gap` 12 px, the gap a text keeps from the face and from other text (and the
  zones' gap above and below the face). The global minimum text size is 30 px (`MIN_SIZE_PX`, the placer).
- Accents, questions and big words: their timing and zones are their entries' (`VARIANTS`). An
  accent or question is timed by its words alone. A big word takes its entry's lead (0.2 s) and minimum
  (1.5 s) from its word. `accent.afterSeconds` (1 s) is not a shown time: it only bounds a big word's
  length in the decide limit (`schema.ts`).
- Transitions (`transitions.numbered`, the LIST): the layer is the full frame, with no background; its
  text levels come in with a fade of 0.3 s (`power2.out`; `seconds` is the entrance), each cut to its own
  spoken time (`caption.inSeconds` at most, so a short key phrase is full by its last word). Their styles and
  spots are the entry's (`list/numbered`: the key phrase and the number `accent`, the lead-in `caption`,
  the number's ratio to the key 300/110) and the zone table's. Stacked levels keep `transition.gap`
  (24 px) apart. Their text stays inside `S` and clear of the notch.
- Click sound: `assets/sounds/mouse-click-trimmed.wav`, 0.23 s, -6 dB (owner decision 2026-11-04;
  a stored click with no `gain_db` plays at it too, in the preview through
  `apps/studio/src/lib/sound-schedule.ts` and in the export through the page's `data-volume`, both from
  `gain_db ?? gainDb`), at least 0.25 s apart.
- Behind (`behind`): `padFrames` 3 and `frameRate` 30: the cut-out covers each big word that needs one plus 3 frames
  on each side. A big word needs it only where the head reaches it (`bigWordNeedsCutout`, the box's bottom
  below the highest robust face's top (`facesOver`, the faces the placer reads) over its padded span less
  `HAIR_MARGIN` 20 px); no head sample in the span, no cut-out. The big word's font and colour are the `bigWord` style's; its face rule (30% of its
  height at most behind the head) is rule 6 in `engine-place.ts`. A VISUAL's card is the `visual/card`
  entry's: a white stroke of 8 px (the style's `stroke.px`, read by the builder's `.visual` rule), its
  width a third of the frame, its height the stand-in picture's own aspect (no crop), its timing 1 s to 2 s (`words-min-max`), a short beat rather than a
  backdrop. The card's corner inset (40 px) is the zone table's `corner`. No count per reel.
- Visuals: a white stroke frame over the footage, in front of the speaker, no fill and no text
  (owner decision 2026-11-07), showing a stand-in picture (owner decision 2026-11-10: a visual shows
  a picture so the owner can judge the text with real pictures; the meaning of the picture is not judged).
  The placer places it as a box from its entry (see Layout engine).
- Stand-in pictures: `VISUAL_STAND_INS` in `src/variants.ts`, three JPEGs under `assets/visuals/`
  (`file`, `width`, `height` as data). They are dev stand-ins until a real image search exists. The Nth
  VISUAL of a reel in start-time order (ties by the answer's order) shows image N mod 3 (`engine.ts`).
- Pace (`pace`, the preset's `intensity` names its level, `intense` (the pros' level); the pace block is
  that level's; a later level, `calm` or `medium`, is one more name with its own block). The written hook
  (`pace.hook`): from 0.2 s (`fromSeconds`) to 3 s (`untilSeconds`), the first seconds that decide
  whether people keep watching, at most 7 words (`maxWords`) and 45 characters (`maxCharacters`, both
  passed to the prompt as `hook_length`). The hook's own timing is its entry's window (`hook/written-line`).
- Caption units: kept capitals (`I`, `I'm`, `I've`, `I'll`, `I'd`, `AI`), a number joined with the
  unit after it, a month with its day number, and the glossary (`lock-in`, heard as `locking` or
  `lock in`).

### Builder contract

- `src/build.ts`: `build(edit, transcript, headTrack, preset, measurer) -> { html, assets, checks }`.
  `html` is a HyperFrames composition (`data-composition-id="main"`, a paused GSAP 3.14.2 timeline
  registered on `window.__timelines`); `assets` lists every referenced file with its role
  (`footage`, `font`, `sound`, `mask`, `visual`), sorted; `checks` is the layout check list. A
  `mask` asset carries its `cutout` ref at `maskPath(mask)` (`masks/<fingerprint>.mp4`).
- Deterministic: no clock, no randomness, no I/O. The same inputs give the same bytes in Node and in
  the browser. One builder serves the preview and the export.
- `src/measure.ts`: `createMeasurer(hb, fonts)` over the initialised `harfbuzzjs` module and the
  font bytes, both passed in by the caller (the worker's `apps/worker/src/edit-measurer.ts` reads
  them from `packages/edit/assets/`, once per process). The `Measurer` returns advance widths
  (`sum(x_advance) * size / upem`) and records every width it measured (`widths()`, what the
  goldens compare). The same wasm on the same font bytes gives identical widths everywhere.
- The builder places each caption, accent, hook and big word at the `position` the layout engine set
  on it (`placedText`, `src/build.ts`), with its `size` and, when it has `breaks`, its lines
  (rendered joined by `<br />`, centred). A shown caption or overlay with no position throws
  `build: <kind> <id> has no position; place the edit first`, and a big word with no `position` or
  `size` throws the same way. `src/html.ts` escapes text and attributes and formats numbers.
- `src/lines.ts`: `textLines(text, breaks)` (a text cut after each of its `breaks`, the builder and the transition levels share it) and `breaksOf(lines)` (the breaks the engine writes for its lines).
- `src/behind.ts`: `visualBox(item)` (a VISUAL's
  `box`), `needsCutout(item)` (a big word whose `cutout` is not false: a VISUAL is in front, over the footage),
  `bigWordNeedsCutout(box, track, span)` and `paddedSpan(span, duration, preset)` (the mask span of an item,
  shared by `maskSpans` and the layout engine's check),
  `bigWordCoveredShare`, `placedBigWord` (a big word at its stored
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
- Big words with `cutout: false` (above the head): plain text (`.word`, track 31, above the VISUALs' cards at
  track 30) over the footage, no composite and no mask; the `.word` rule is written on any page with a big word.
- VISUALs (always in front of the speaker): each VISUAL's frame (`clip visual`, or `clip visual-picture`
  with its picture, track index 30) after the composites, above the footage and under transitions and
  text, with no cut-out (so no mask span and no mask). A page whose only behind items are VISUALs writes
  the `.visual` rule (and the `.visual-picture` rules with a picture) and no composite. Each picture is an
  `assets` entry of role `visual`, served like the fonts (the studio's edit-assets route, the worker's copy
  from packages/edit).

### Transitions tied to a phrase

- `src/transitions.ts`: pure helpers shared by the engine and the builder. `transitionTiming`: the layer
  comes in as its entrance (`seconds`, 0.3 s) ends on the phrase's first word, so it starts 0.3 s before
  that word (never before 0; the fade is finished as the word starts), and its out-fade runs over the
  0.3 s after the phrase's last word, so the layer ends one fade past that word and the phrase is at full
  opacity while spoken (spec decision 25). No hold after the phrase and no minimum; only a phrase with no length at all is lengthened
  to the shown floor (`SHOWN_FLOOR_SECONDS`, 0.5 s, from its first word, earlier where the reel ends,
  `transition-min`). On a reel under the floor it gives null and the layer covers the whole reel
  (`transition-time`). No other text moves or cuts it: a text said at the same time is placed around it,
  and only the same-text rule trims a list that repeats a word another pick shows at that moment.
- Claude gives the LIST as `lists: [{ items: [{ from, to, key_from }] }]`: each list has one or more
  items, and no item has a kind (every LIST item is numbered; `TRANSITION_KINDS` is the stored type only).
  The engine writes each item as a transition item with `words`, `key`, `list` (the list's place in the
  reel, 1, 2, ...), `number` (the item's place in its list, in reel order, 1, 2, ...; left out when the
  list keeps one item, so a one-item list shows no number) and `levels` (`number`, `lead`, `key`, each
  `{ text, position, size, breaks?, start }`). Numbering restarts at 1 in each list.
  The lead-in (words before `key_from`) is caption text and the key phrase accent text, from the style
  roles (`levelStyle`), never a literal font or colour. The layer has no background and no dim:
  its number (only in a list of two or more items) and its text levels over the phrase.
- Each level appears whole on its first word and stays until the layer leaves. The captions of the
  phrase are hidden only while the layer is on screen (`hidden_by` the transition, no position, shown
  through the levels); the words a trimmed list no longer shows are normal captions. Any component may
  show during a running transition: they keep apart on screen, not in time. The engine places each item
  as one stack (its number, lead-in and key phrase, `transition.gap` between, centred) through the
  placer, in its turn among the components by start time, before the captions: zones the upper third
  then anywhere in the safe zone; the stack's size is its key's (110 px, the number 300/110 of it, the
  lead-in 50/110), shrunk together in 10% steps until its smallest level reaches 30 px (a key of 66);
  each level's lines free (`breaks`); never over other text; the face a cost. An item that fits nowhere
  whole is a `no-spot`: left out of the version, its words captions, never three placements. Every move,
  shrink, wrap and retime is an `EngineNote` (`placed`, `moved`, `shrunk`, `wrapped`, `covers-face`,
  `no-spot`, the timing notes).
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
  (`clamped-to-end`, rule `hook-time`). Nothing else changes its time. Both
  anchors are `anchorAt` (the nearest word end within a second, else a time where nobody speaks),
  so it follows its words through a re-time.
- A fixed window (owner decision 2026-11-07; spec decision 13): every reel has one, and it is placed on
  every run. It runs its whole window whatever is said in it: no text pick cuts it, and it cuts none. A
  text pick (accent, question, big word, list) said in its window is placed around it: the components
  are placed in order of their start time, so the hook (0.2 s) comes before nearly everything, and a
  pick said in its window sees it as an obstacle and takes a spot off it (an accent moves down its
  zones, noted `moved` with the hook among its blockers). A visual keeps its own times beside it.
  Captions keep running below it; nobody says it, so no caption is ever left out for it.
- The captions come after every component (owner decision 2026-11-07), so the captions in its window
  keep clear of it: each sentence block goes through the placer with the hook as a text obstacle, wraps
  freely, moves down its zones and shrinks to 30 px before it covers the face (`covers-face`, rule
  `face`); it never sits on the hook. A caption-heavy opening never pushes the hook out.
- Placement: the placer, as for every element (`placeExtra` in `src/engine-elements.ts`, with the
  `hook/written-line` entry): the `accent` style (primary, white, base 110), zones the upper third then
  anywhere in the safe zone, shrunk in 10% steps to 30 px, wrapped freely (cost 0), the face a cost of
  100, never over other text (hard). Notes: `placed`, `moved`, `shrunk`, `wrapped`, `covers-face`, and
  `hook-time` (`clamped-to-end`). A hook that fits nowhere at 30 px or more is a `no-spot`: left out of
  that version and noted (nobody says it, so nothing stands in for it).
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
  `caption/default`). Each names its component, layer, type, style (a text: one of the `STYLES` table,
  `accent`, `caption` or `bigWord`, each a font role, a colour and a base size, `largest-fit` for the
  big word's; a box: its stroke), ranked zones (names of the zone table only), timing option, whether its
  words hide the captions, and a box's aspect and width, or a stack's levels (each with its style, the
  number with its ratio to the key). No size of the entry's own, no positions. A wrong field or an
  unknown zone fails typecheck.
- The picker (`src/variant-picker.ts`): `pickVariants(input)` maps each pick of the input (a hook when
  there is one, each kind of pick the answer holds, and the captions, always placed) to its entry, one
  per component for now. `editFromAnswer` and the worker's `first_version` step call it and pass the
  result to `placeEdit`. Placement reads each entry's zones, style, layer and timing; each engine note names
  its component's entry as its `variant`.

### Layout engine

Built from `specs/layout-engine.md` (steps 1 to 12, branch `feat/engine-simplify`). Claude's answer
says what and on which words; the engine decides every time, position, size and line break. Pure and
deterministic (no clock, no randomness, no I/O). Modules in `packages/edit/src`:

- `engine.ts`: `placeEdit(current, input, picked, transcript, headTrack, preset, measurer)` returns
  `{ tracks, record }`. It runs the loop (below) until no pick is left out and no two picks share a word.
  `editFromAnswer` (decide) and the worker's `first_version` step call it.
- `engine-timing.ts`: the spans from the words (`floorSpan`, `ownSpan`, `visibleSpan`), the caption
  groups (`captionGroups`) and the same-text pass (`sameTextPass`).
- `engine-scene.ts`: the moments (the reel cut at every element edge, `sceneOf`) and each moment's
  robust faces; `placerScene` gives the placer a span's faces and the texts on screen with it.
- `engine-elements.ts`: each component's element through the placer and the writes it makes (overlays,
  behind items, LIST transitions, caption blocks) with their notes.
- `engine-place.ts`: `placeElement`, the placer (candidates, hard rules, costs, tie-break, the
  anchored fit of the big word); `stackPositions` places a LIST's levels.
- `engine-zones.ts`: the zone table, `zonesAt(name, S, F)`; `engine-space.ts`: free rectangles and
  `placeBox`; `engine-note.ts`: the record's shape.
- `variants.ts` (`VARIANTS`, `STYLES`, `timingOf`) and `variant-picker.ts` (`pickVariants`).

#### Inputs

- `EngineInput` (`engine-input.ts`) is the answer: `accents`, `questions`, `big_words` (`{ from, to }`
  word ids), `visuals` (a word range and an optional `description`), `lists` (`{ items }`, each item a
  word range with `key_from`), `word_fixes` and the optional `hook`. Word ids only: no time, position,
  size or spot. `choicesOf` reads a version back as an `EngineInput`.
- The safe zone `S` (`SAFE_ZONE`, `engine-zones.ts`) is `PLATFORM_SAFE` minus the `PLATFORM_BUTTONS`
  notch: every element is inside it and clear of the notch.
- The face: the robust faces (`facesOver`, `head-track.ts`) of each moment; an element's `F` is their
  bounding box, padded 35 px left and 30 px right (`LAYOUT_PADDING`), and `layout.gap` (12 px) above
  and below in the zones. The body under the face is no obstacle.
- The head track is cleaned once, where it is parsed (`headTrackSchema`, `cleanHeadTrack` in
  `head-track.ts`): a sample whose head is narrower than `HEAD_GLITCH_WIDTH_SHARE` (0.7) of the clip's
  median head width is no head (decision 22). Every reader (the placer, the checks, the cut-out, the
  decide step, the render) gets the cleaned track, so the cut-out and the anchors agree.
- Fonts and the measurer (HarfBuzz, `measure.ts`) give every width. Cut footage spans
  (`tracks.footage[].hidden`) keep a behind item off a cut.

#### Variants and the picker

- `VARIANTS` (`variants.ts`) holds seven entries, one per component: `hook/written-line`,
  `accent/above-head`, `question/as-accent`, `bigword/behind`, `visual/card`, `list/numbered`,
  `caption/default`. An entry names its component, `layer` (`front`, or `behind`: the big word, over
  the cut-out), `type` (`text` or `box`), `style`, its ranked `zones`, its `timing` option, whether its
  words `hides` the captions while it shows, and for a box its `aspect` and `width` share, for a stack its
  `levels`. It holds no size and no position. A wrong field or an unknown zone fails typecheck.
- `STYLES` is the style table: `accent` (`primary`, white, base 110), `caption` (`secondary`, white,
  base 50), `bigWord` (`primary`, white, `largest-fit`). Two entries on one style share its base. The
  base is the cap: a text is never set above it, and shrinks from it.
- Timing options: `words`; `words-lead` (a lead before the first word, at least a minimum: the big
  word, 0.2 s and 1.5 s); `words-min-max` (the visual, 1 s to 2 s); `words-entrance` (the list, 0.3 s
  before its first word); `window` (the hook, 0.2 s to 3 s); `caption-groups`. `timingOf(entry, option)`
  reads one option, narrowed.
- `pickVariants(input)` maps each pick to its entry (one per component now) and always includes the
  captions. The picker is the one place a later choice (by intensity, by reel) plugs in.

#### Zones

`zonesAt(name, S, F)` gives each zone's parts (its area inside `S`, notch out) and its wanted point; `F`
is null with no head in the moment.

| Zone                    | Area                                                     | Wanted point                                                 | No head          |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | ---------------- |
| `above-head`            | `S` above `F.top - 12`                                   | centre x of `S`, `F.top - 190`                               | centre x, y 1130 |
| `upper-third`           | top third of `S`                                         | centre x, `S.top`                                            | the same         |
| `beside-face`           | strips of `S` left and right of `F`, to `F.bottom + 120` | at the face's edge, mouth height (0.7 of the face)           | none             |
| `below-face`            | `S` below `F.bottom + 12`                                | the face's centre x, just below it                           | none             |
| `caption-line`          | `S` from y 1290                                          | centre x, y 1290                                             | the same         |
| `corner`                | `S` inset 40 px, four parts                              | each corner (top-left, top-right, bottom-left, bottom-right) | the same         |
| `head-top`              | all of `S`                                               | centre x, `F.top + 60`                                       | centre x, y 700  |
| `anywhere-in-safe-zone` | all of `S`                                               | the centre of `S`                                            | the same         |

A zone is the engine's; an entry only ranks names from this table.

#### Sizes and wrapping

- A text is set at its style's base at most, in 10% steps down to 30 px (`MIN_SIZE_PX`, the one global
  minimum). The big word is `largest-fit`: the largest size that fits at its zone's anchor (`head-top`)
  with no text in the way, moved up towards `S`'s top as rule 6 needs.
- Wrapping is free: any number of lines, balanced breaks (`balancedLines`); the lines are stored as
  `breaks: number[]`. The big word is set on one line (`maxLines` 1). Line height is the size; a caption
  adds `caption.lineGap` (14 px) between its lines.
- A box is its `width` share of the frame at its aspect (the picture's width over its height; the card:
  360 wide, 459 high for the first stand-in), shrunk the same way.
- A LIST item is one stack: its number (ratio 300/110 to the key, when the list has two or more items),
  its lead-in (`caption` style) and its key (`accent` style), `transition.gap` (24 px) apart. The stack
  shrinks until its smallest level reaches 30 px. Its levels are placed at whole pixels, stacked from the
  box's top and centred in the box (`stackPositions`), each as a left-aligned position.
- A caption sentence is one block (`sentenceSpans`): its groups of captions, each caption set whole on
  one line; the block is sized so every group fits, and centred in its box.

#### Placement (the loop)

`placeOnce` in `engine.ts` runs one pass:

1. Timing from the words (`engine-timing.ts`): each element's span from its entry's timing option; a
   pick with no length at all shows the shown floor (0.5 s) from its start, earlier where the reel ends. A text whose
   words another text on screen also shows is trimmed or dropped (rule 4, `sameTextPass`). A caption's
   words a text with `hides` shows are left out while it shows (`hidden_by`, pieces `-2`, `-3`, ...).
   A visual or big word over a cut moves to the next visible moment (`moved-off-cut`).
2. The scene: moments cut at every element edge; each moment's faces.
3. Components in order of their start time, ties by the answer's order (hook, accents, questions, big
   words, visuals, lists): each element is placed by `placeElement` over the texts placed before it that
   share a moment with it (`shown`). A visual's card sees no text but a big word that needs the cut-out,
   and no front text sees it (rules 5 and 6; decisions 9 and 24).
4. Captions last, in time order, one block per sentence, over everything placed.
5. An element with no legal spot is left out of that pass (`no-spot`), and the answer is placed again
   without it. A pass that trims or drops a pick is placed again too, so the rules hold on the final
   times. Every pass removes a word or a pick, so the loop ends.

`placeElement` (the placer): for each zone of the entry's ranking, each zone part, each line count (or
stack level counts, or block line counts), the largest fitting size at most the cap, found on the free
rectangles of the zone (`freeRects`, `placeBox`, whole pixels); the face is an obstacle in a first pass
and allowed in a second. The cheapest candidate wins.

#### Hard rules (never broken; a candidate that breaks one is not a candidate)

1. Everything inside `S`, clear of the notch (the big word too).
2. Captions are always visible: nothing covers a caption. Captions are placed last, over the components,
   and avoid each other.
3. Everything spoken is on screen, as a caption or inside a component (the caption split in time).
4. The same text never shows twice at one moment (`same-text`).
5. Text never overlaps text, with `layout.gap` (12 px) between. A front text (a caption, an accent, a big
   word with no cut-out) is no obstacle to a card, and the card draws under it; a big word that needs the
   cut-out and a card never overlap while both show (decision 24). A caption block that has no legal spot at 30 px is set over the texts on
   screen, inside `S`, noted `no-spot` (decision 19); the strict `text-overlap` check excuses exactly
   those pairs.
6. A big word (behind): the face hides at most 30% of its height (`MIN_VISIBLE_SHARE` 0.7 in
   `engine-place.ts`, `bigWordCoveredShare`, the unpadded faces over the span).

#### Soft costs

| Cost        | Charged                                                                        | Value |
| ----------- | ------------------------------------------------------------------------------ | ----- |
| face        | the box overlaps `F` in any moment of its span (flat; a behind text pays none) | 100   |
| zone step   | one step down the entry's zone ranking                                         | 10    |
| shrink step | one 10% step below the full size (a box or a text: its base or width share)    | 10    |
| wrap        | one line beyond one (a stack counts its levels' lines)                         | 0     |

Tie-break, in order: the cheaper cost, the earlier zone, the larger size, fewer lines, the higher spot,
the further left spot; between the parts of one zone, the spot nearest the part's want, then the part's
order. These are tuning values (`PLACE_COSTS`), tuned on real reels.

#### No legal spot

An element that has no candidate at 30 px or more is left out of that version: its words stay captions
(rule 3) and its `no-spot` note names what took the space. A caption block is never left out: it is
set over the texts on screen, inside `S`, with a `no-spot` note on each of its captions. A block that
fits nowhere even then is an error (none in the goldens or the seeded sweeps).

#### Record

Structured notes, `EngineNote` (`engine-note.ts`), saved with the version in `versions.engine_record`
and logged by the worker in one line (`engineRecordLine`). Every shown element has at least one note
(`placed` when nothing was given up); one note per outcome.

```
{ item, component, variant, start, end, rule, outcome, blockers, zone?, size?, lines?, cost?, reason }
```

- `component`: HOOK, ACCENT, QUESTION, BIGWORD, VISUAL, LIST or CAPTION. `variant`: the entry's name.
- `rule`: the placer's `zone`, `size`, `face` and `no-spot`; the engine's timing and text notes name
  their rule (`hook-time`, `accent-time`, `big-word-time`, `visual-time`, `transition-time`,
  `transition-min`, `caption-min`, `transition-text`, `hidden-footage`, `same-text`).
- `outcome`: `placed`, `moved`, `shrunk`, `wrapped`, `covers-face`, `retimed`, `dropped`, `no-spot`.
- `blockers`: `{ kind: "caption", id }`, `{ kind: "item", id }`, `{ kind: "face" }`,
  `{ kind: "safe-zone", edge }` or `{ kind: "buttons" }`: what took the space it did not get.
- `reason`: plain words with the item's text and times.

The checks (below) read the record: `face` excuses a caption whose note is `covers-face`;
`text-overlap` excuses a caption's `no-spot` pair. Neither check reads any other shape.

### Checks

`src/checks.ts`, `runChecks`, in a stable order, each failure `{ rule, item, reason }` with a
readable reason string (an empty list means every rule passes):

- `safe-box`: text inside `SAFE_ZONE.box` (`PLATFORM_SAFE`) and clear of `SAFE_ZONE.notch`
  (`PLATFORM_BUTTONS`), the one safe zone (the edge and value that run past the box, or `runs into
the platform button column below y 1164` with the right edge past x 945). A transition's text
  levels count as text, and so does a big word behind the speaker (`big word <id> ("<text>")`, its box
  from `placedBigWord`): decision 2 of `specs/layout-engine.md`, it keeps `S` like every text; there is
  no `frame` check.
- `face`: captions clear of the face (the robust faces, `facesOver`, at every moment of the
  caption's span, the same ones the engine avoids). The one failure it allows is a caption the engine
  put over the face and recorded as `covers-face` (a block's note is written for each of its captions;
  `apps/worker/src/decide/run-decide.ts` leaves them out of the refusal). A hidden caption has no position, so it is never checked.
- `text-overlap` (`checks.ts`, the single mode's rule): two texts (captions, accents, questions, the hook,
  big words, a list's levels) that share a moment never overlap on screen. Strict (rule 5 is hard); the
  one excuse is a caption the engine record notes `no-spot` (component `CAPTION`) whose blockers name the
  other text (decision 19: the caption had no legal spot and is never left out). It
  needs the record: `build(edit, ..., { engineRecord })`, which the decide step and the first version pass.
  The engine's output never fails it.
- `card-overlap` (`checks.ts`): a big word that needs the cut-out (`needsCutout`) and a visual's card never
  overlap while both show (decision 24); the reason names the word and the card. A big word with no cut-out
  is front text and may sit on a card. The engine's output never fails it.
- `same-text` (`checks.ts`): no spoken word (by word id) is shown by two items at a shared moment. The items
  are the captions shown (not those a text hides, `hidden_by`), the accents and questions, the lists and the
  big words (their `words`). The reason names both items and the word. The engine's output never fails it:
  the same-text rule (above) and the caption split keep it so.
- `timing`: captions at least `caption.minSeconds` (0.25 s) on screen, the hook at least
  `SHOWN_FLOOR_SECONDS` (0.5 s), and every other text box (an accent, a question, a list's level) a length
  above zero, with no minimum.
- `big-word-timing`: the big word never shows more than its entry's lead (`words-lead`, 0.2 s) before its
  word (the matching spoken word nearest its start) is said.
- `sound-gap`: two sounds at least the preset's gap (0.25 s) apart.
- `time-in-speech`: a time anchor outside speech (it names the word to anchor to instead).
- `out-of-reel`: an anchor that resolved outside the reel and was clamped.

The checks look at overlaps between texts (`text-overlap`) and between a cut-out big word and a visual's
card (`card-overlap`, decision 24; a big word with no cut-out may sit on a card and draws above it). A
visual over the face is noted `covers-face` like any front pick, and a visual under a text is no overlap
(decision 9: the card draws under the text). The glossary check is separate (`src/glossary.ts`,
`glossaryChecks`).

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
  baseline and versions tests, a build of the 50-second edit under 200 ms and a caption drawn above a
  card that overlaps it (the text track 50 after the visual track 30; `src/build.test.ts`), and
  `src/behind.test.ts` (visual boxes, mask spans padded, clamped and merged, a visual left out
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
  - "text picks share the screen in time": a list starting on an accent's last word trimmed to its own
    words (the earlier accent keeps the word), an accent said inside a list whose words it repeats
    dropped, a list kept whole where a big word starts inside its last word, a big word's minimum kept
    with an accent said inside it, a visual never cut; the real-reel case, a LIST item "what we do" and
    the big word "AI" far apart on screen both kept for their full spans; a key phrase wider than the
    safe zone wrapped inside it; no text lands after its own words and no text cuts another's time, on
    the dense reels.
  - "the layout engine's timing" also: a list's layer starts 0.3 s before its first word, never before 0.
  - "never the same word twice on screen": the caption words an accent or big word shows are left out
    (`and sense of purpose` reads `and`, `it to the world` reads `it to the`), a whole group hidden,
    and a stored caption without the field builds as before.
  - "big words in view": a short big word kept at the head's rule place, noted when the head covers
    more than 30% of it.
  - "the layout engine's placement": no check failing on a dense reel (accents, a big word, visuals and
    a transition together) and on the Intense rhythm with the real head and with a large centred
    face; one spot per sentence; the big word on its word and inside the frame with one bad head
    reading; a long accent wrapped at its base size; captions over a face that fills the safe zone
    recorded; an accent on the chest (below the face) when that is its best spot; every front element
    over the face on the dense reels with three heads noted `covers-face`, and the face check passing
    only as noted; determinism; the engine placing its own output the same again.
  - "today's failures, placed by the engine": a transition's text levels kept off the face; a visual
    placed over its sentence, nothing dropped.
  - "big words: the cut-out only where the head reaches them" (`src/engine.test.ts`): a big word with no
    head over its span is plain text with no mask; one the head reaches keeps its cut-out and mask span
    (`src/behind.test.ts`: `bigWordNeedsCutout` at the hair margin, the highest robust face, one stray reading
    not deciding, no head in the span, the cleaned track's glitches not deciding).
  - "a big word behind the speaker never sits on a visual card" (decision 24): a word that needs the
    cut-out and a card it shows with keep apart in either order, with `checks` empty; a word with no
    cut-out sits on a card and is drawn above it (track 31 over the card's 30); the checker flags a
    cut-out word moved onto a card and passes the same word with no cut-out.
  - "the head track's glitch samples" (decisions 22 and 23): the five glitch readings of the real clip
    (46.25 to 47.25 s) anchor a big word on the real head's top (564), cut out, its lower 30% behind the
    head, not on the glitch tops (424).
- `src/head-track.test.ts`: the glitch cleaning (`cleanHeadTrack`): the samples under 0.7 of the median
  head width dropped and the real ones kept, a clip of similar widths unchanged, the floor exact, the
  schema applying it, a track with no head as it is.
  - "visuals: corner cards over the footage": a card at a corner or beside the face, inside the safe
    zone, clear of the face with no failed check, drawn as a white frame, never wider than 360 and at
    its picture's aspect; the full card where a corner holds it (the large centred face: the bottom-left corner, `placed`),
    the strip beside the face at full size where no corner does (the speech-ten head, `moved`, one zone
    step), and the card shrunk in a corner where that is cheaper (the fixture head: 296 by 377, two
    shrink steps); a card over the face only when nothing off it holds one (a face filling the safe
    zone), noted `covers-face`; the ratio kept across a reel; decision 9, a card and an accent said while
    it shows each placed as when alone, neither among the other's blockers, the card drawn under the text.
  - "clicks on visuals and big words": a click as each placed visual and big word comes in and
    nothing else (at `data-volume="0.5012"`, the -6 dB click), a visual the face leaves no spot off it
    for still clicking, and a stored version's sounds left as they are.
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
    caption-heavy opening keeps the hook; never under the placer's 30 px (a very long word shrinks to
    it on one line, a long sentence wraps at the base), and wide words shrink and wrap freely; a reel
    too short for its window shows it from earlier, to the reel's end, noted.
  - "every pick shown": every pick passes the schema; no accent cut in time; a visual exact;
    a question shown with the others; the cuts and overlaps said in the record; a visual the face leaves no
    corner for placed over the face, noted `covers-face`; a big word the head hides placed at every height
    where it is, noted; a transition that runs during the hook shown with the hook's window kept.
  - "texts never overlap on screen while a free spot exists": random picks over the fixture reel and over a
    caption-heavy opening never fail `text-overlap`; a big word over the captions of its sentence moved
    clear of them; a text that shares its time with a cut hook's floor noted with it.
  - "captions through the placer, as sentence blocks": every caption the caption entry's, in its zones,
    never above 50 px nor under 30; a sentence's captions at one size, one spot; captions text to each
    other and to every component; a block with no legal spot (a face filling `S`, a 60-caption opening, a
    hook and a list) set over the texts inside the safe zone and noted `no-spot` on each caption, the
    strict `text-overlap` check passing with the record and failing without it; deterministic.
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
  `time-in-speech` fail as their rules say; `safe-box` for a big word set past the safe box's bottom;
  `big-word-timing` and the big word's own timing checks.
- `src/preset.test.ts`: the intersection, the platform guard and its notch (`SAFE_ZONE`), the fallback
  lines inside the safe zone, the numbered kind only, the Intense pace (something new every 3 s, the hook
  to 3 s), and the accent and big word timing.
- `src/engine-zones.test.ts`: the zone table (`zonesAt`), each zone with a head and with none, and every
  zone's areas inside `S` and clear of the notch.
- `src/engine-place.test.ts`: the placer on synthetic scenes: an empty scene (`placed`, the top centre
  of the upper third, above the head; a short accent at its base 110 and never larger; the accent line
  with no head; a long accent shrunk in 10% steps from the base), a crowded upper third (one zone step,
  the crowd as blockers, determinism, `shrunk`), the face (avoided at a zone step; covered only when
  nothing off it passes; the behind big word grown to the largest fit at no face cost, and rule 6 as a
  hard filter), no legal spot (a text that took S, a word too wide for S, a caption blocking a card), the
  30 px floor, wrapping (free for a largest-fit text, before shrinking for a capped one, as little
  shrinking as it must, a zone step over shrink steps, three lines, the caption line gap), a box under a
  text and a card over a text, and the notch.
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
- Never let an overlap pass silently: a front pick or a caption block placed over the face is noted
  `covers-face` (rule `face`), and a caption block set over other text for want of a legal spot is noted
  `no-spot` with the texts it sits over. A text over a visual's card is no overlap (decision 9).
- Never overlap two texts on screen at a shared moment (rule 5, hard): a component with no legal spot is
  left out (`no-spot`); a caption block with none, never left out, alone sits over text, inside the safe
  zone, and its `no-spot` note names the pair, the one pair the strict `text-overlap` check excuses
  (decision 19).
- Never drop a pick except by the same-text rule (a text pick whose every word another text pick on screen
  with it shows, noted `dropped`, rule `same-text`); never drop a caption: a block with no spot off the face
  covers it (`covers-face`); one with no legal spot at all sits over the texts (`no-spot`). A caption left
  out while an extra shows its words is
  not dropped: its words are on screen.
- Never read a single head-track sample for a placement or a check: always the robust faces
  (`facesOver`), of the head track as `headTrackSchema` parses it (glitch samples dropped, decision 22).
- Never show an accent or question before its first word, nor a big word more than its entry's lead (0.2 s)
  before its word, nor a list more than its entrance before its first word. Never make a text wait and
  never cut a text's time for another: a text pick never starts after its own words, and two picks (the
  hook, accents, questions, big words, lists, visuals) may share the screen in time; they conflict only
  where they overlap on screen at the same moment, and the placer keeps them apart.
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
- Never cut the hook's time and never drop it for another pick: it runs its whole window, and a pick
  said in that window is placed around it. Its spot is the placer's, like any element's (a pick said
  before 0.2 s is placed before it, by start time, and the hook then avoids it).
- The hook's window never shifts: its only clamp is `hook-time` (a reel too short for its window).
- Never let a caption drop the hook: the hook is placed before the captions, and the captions in its
  window keep clear of it (move, shrink, or last, over the face).
- Captions take the space the components leave: no component is placed around a caption (the hook,
  accents, questions, big words, visuals and list levels are placed first and never avoid captions), and
  a caption avoids every component and every other caption. A caption over other text is the last resort
  only, noted.
- The hook shrinks to the placer's 30 px and wraps freely before it gives anything up; a hook that fits
  nowhere at 30 px or more is a `no-spot` like any element, left out of that version and noted (never
  set under 30 px, never over other text).
- Never move a big word up for the head: a big word the face covers more of than the lower 30%
  (rule 6 of the layout engine, 30%) is kept and noted. Never place one above `PLATFORM_SAFE`'s top.
- Never give a big word `cutout: false` while its box reaches the head over its padded span (the box's
  bottom below the highest robust face's top less `HAIR_MARGIN`); a word the head cannot reach is plain
  text over the footage, with no mask.
- Never let a big word that needs the cut-out sit on a visual's card while both show (decision 24). A big
  word with no cut-out may sit on a card: it is front text, drawn above the card (track 31).
- Never let a visual leave its card: it is a corner card in front of the speaker, never behind them,
  always inside the safe zone `S` and off the button column. The placer gives it a corner, then the strip
  beside the face, the full card (360 wide) where the spot holds it, else shrunk from it at its picture's aspect in 10%
  steps, never under 30 px wide; only when nothing off the face holds a card does it cover the face
  (noted `covers-face`, rule `face`). A front text is no obstacle to the card and the card none to it: a
  text may sit on a card, and the card draws under it (track 30 under the text track 50); a big word that
  needs the cut-out is the exception (decision 24). The engine,
  never Claude, chooses its place and size.
- Never give a visual a fill, a text, a shadow or a colour change: its white stroke is its frame.
- Never cut out (no mask span, no mask) for a visual: only a big word behind the speaker has a mask.
- Never let Claude write a transition's time, position or size, nor a literal font or colour in a
  transition entry: they come from the words and the style roles.
- Never hold a visual past its entry's maximum (2 s), or a big word past a second after its word
  (`afterSeconds`), in a new version; never refuse a stored version for an older, longer
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
  for a caption recorded `covers-face` (a block's note is written for each of its captions). The one refusal the engine cannot avoid is a big word or visual
  over footage hidden for the whole reel (no visible moment to move it to).
- The face is a preference for every front element (the hook, accents, questions, list levels, visual
  cards and captions): a spot off the face and off other text first; then over the face but off other
  text, only when no spot off the face is free at any candidate and size (`covers-face`). A component
  (the hook, an accent, a question, a big word, a LIST stack) is never set over other text: with no
  legal spot it is left out (`no-spot`); a caption block alone, never left out, sits over text with no
  legal spot (`no-spot`, decision 19); a visual's card is no obstacle to front text and text none to it (decision 9), but a big word that needs the cut-out never sits on one (decision 24). Never set a text above its style's
  base size (`accent` 110, `caption` 50): the placer only shrinks from it; the big word alone takes the
  largest fit, anchored at the head top (never a roomier spot elsewhere). The body under the face is no
  obstacle to any of them. A big word is behind
  the speaker: the face is no obstacle to it, and its 30% visibility rule is hard: it moves up and
  shrinks at the head top until the rule holds, and is left out when nothing does.
- Never add a shadow, a stroke or an outline to any text, and never change a text colour.
- A version with a `behind` item is saved only once every mask it names exists; the builder never
  builds a behind item without its mask.
- A big word is checked against the safe box `S` like every text (`safe-box`); there is no `frame`
  check and no frame margin for it.
- Text never enters the platform zones: `PLATFORM_SAFE` and `PLATFORM_BUTTONS` are a guard, never
  a preset value, and no preset or change request moves them.
- Never rewrite a stored version to fit the guard; it shows its failed check.
- Nothing Node-only or browser-only in `packages/edit`; the caller injects the platform.
- Never commit an asset without its licence (`assets/fonts/OFL-*.txt`,
  `assets/sounds/LICENSE-sounds.md`, `assets/visuals/LICENSE-visuals.md`).

## Notes

- The `number` column was added beyond the issue's list: it gives the per-reel "version N", and
  `unique (reel_id, number)` doubles as a guard against two concurrent saves.
- The studio imports only types from the package until slice 9.
- The fixture clip has no person, so the face rule is proven with a synthetic head track
  (`src/checks.test.ts`) and the `rethink-work` data.
