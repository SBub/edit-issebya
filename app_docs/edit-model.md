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
  (`kind: "accent"`, or `kind: "hook"` for the written hook, below; an older version's title is the accent with id `title`), `transitions` (`numbered` for a new answer; `dim` and `panel` are older versions' kinds, and `card` is no longer in the library but stays in the stored format so old versions render), `sounds` (`click`) and the optional
  `behind` track. `inputs.cutout` and `tracks.cutout` (the old whole-clip cut-out) are optional and
  never written now (old versions may hold them); the builder ignores them.
- `tracks.behind`: what sits behind the speaker, any number of items. An item is a VISUAL
  (`kind: "visual"`, `decide-17`), an empty white stroke frame, a corner card (`behind.card`): `layer`
  `front`, `box` its place and size, `spot` the preset spot nearest it, no `photo_id`, no `reason`
  and no picture asset. It may carry an optional
  `description` (a short plain phrase of what the frame would show, at most 120 characters, the
  decide answer's own limit is 8 words), which is never shown on screen; the builder draws a
  `div.clip.visual` with a white border of the preset's card stroke (`card.stroke`, 8 px), transparent
  inside (the `.visual` rule is written only on a page with a visual). Or a library
  photo (`kind: "photo"`, an older version's; a new answer never names one; `photo_id` a photo's uuid, `spot` one of `top`, `left`, `right`, and the
  optional `reason`, `match` or `mood`, why the editor chose it: written from `decide-13` on, absent
  in older versions, never rendered; the optional `layer`, `behind` or `front`, and `box`
  (`{ x, y, width, height }`, whole pixels in the frame), both written by the layout engine from
  `decide-14` on: absent, the photo is behind the speaker and covers its spot exactly, as every
  older version renders; with a `box`, `spot` names the preset spot nearest it) or a big
  word (`kind: "word"`, `text` one or two words of 1 to 24 characters each, with no space inside a
  word and no `<`, `>` or `&`, the two joined by one space: "distribution channel"). It is anchored
  on words like a caption (a big word starts on its first word with a negative
  `offset`, the lead), cuts in and out with no animation, and only one is shown at a time. In a new
  version a photo lasts the preset's 1 to 2 s and a big word the accent's timing (at least 1.5 s,
  at most from the lead before its first word to a second after its last); one saved before 2026-11-04 may
  last 2 to 4 s, or 2 s from its word. A refinement refuses two overlapping items (`clean` placement
  only, see "Placement") and an item crossing a footage clip's `hidden` span; with the decide limit (`EditLimits.behindLengths`, new
  versions only) also an item outside its kind's length, so a stored version keeps parsing and
  rendering. A version without the track parses, and the builder reads it as empty.
- `inputs.masks` and `inputs.photos`, both optional, filled by the worker before a version with a
  `behind` item is saved: `masks` lists the person masks (`EditMask`, a `{ step: "cutout",
fingerprint, file: "mask.mp4", start, end }` ref plus the span of the reel it covers, in
  seconds, by start), `photos` the library photo ids the track names (sorted, unique; none for a
  visual, which names no photo). A version
  without behind items has neither; one whose only items are photos in front of the speaker has
  `photos` and no `masks` (nothing to cut out).
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
  the big word also take an optional `shadow` (`1` or `2`), legacy: a soft text shadow the engine
  set before 2026-11-04 when the text would be hard to read. The engine never writes it now; it is
  kept so older versions parse and render unchanged (the builder renders it as the preset's legacy
  `readability.shadows` `text-shadow`). A caption
  takes an optional `hidden_by` (the id of the accent or big word showing its words while it would
  show; the builder leaves it out, and a refinement refuses an id that is no accent or big word,
  the hook included).
  The hook (`kind: "hook"`, id `hook`) takes `text` and never `words`: it is the one text on screen
  nobody says. A refinement refuses a hook with words or without text, and a second hook. Versions
  saved before it have none and parse as before.
  The layout engine
  writes `position` and `size` on every caption, accent and big word it places; versions saved
  before it have none;
  footage clips take `hidden` spans; transitions a replacement `color`; sounds
  `gain_db` (-60 to 12). Unset properties come from the preset.
- `style` is the free custom-style field: CSS property to value, added to the element. Values
  cannot leave the style attribute (no `;`, `{`, `}`, `<`, `>`, backslash or `url(`).
- Validation is Zod 4. `editSchemaFor(preset, transcript)` is built per reel: word ids are the
  transcript's and fonts the preset's, so an unknown word or font is refused by the schema itself;
  a refinement refuses a duplicate id, an end before its start, an overlay with neither words
  nor text, and a `behind` item breaking its rules above. `EditLimits.behindLengths` adds the behind
  lengths (the decide limit); `EditLimits.photoIds` limits
  `photo_id` to the given ids (the decide step passes none: a new answer names no photo); without it
  any uuid parses. `src/transcript.ts` is the studio transcript (`{ words: [{ id, text, start, end }] }`).

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
  accents, the big word and the key phrase of a transition, `secondary` Golos Text Bold
  (`assets/fonts/GolosText-Bold.ttf`, weight 700, 50 px) for captions and a transition's lead-in
  (owner decision 2026-11-04, after a day's trial of Raleway for captions too). The builder lists
  a font file once even when both roles share it. All text is white (`#FFFFFF`: captions, accents,
  the big word, transition levels by their roles).
- Captions: `#FFFFFF`, rise 12 px over 0.18 s (`power2.out`), fade out 0.15 s, at least 0.25 s on
  screen, a group breaks at a 0.35 s pause or after 4 units, fallback line y 1290 when no head is
  in the frame, line gap 14.
- Accents: `#FFFFFF`, 190 px above the head, y 1130 with no head, from 0.2 s (`leadSeconds`,
  so the entrance has finished as the word is heard) before the first word to 1 s
  (`afterSeconds`) after the last, at least 1.5 s (`minSeconds`). The big word takes the same
  three numbers. Slots beside the head (versions
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
- Click sound: `assets/sounds/mouse-click-trimmed.wav`, 0.23 s, -6 dB (owner decision 2026-11-04,
  louder than the -13 dB before; a stored click with no `gain_db` plays at it too, in the preview
  through `apps/studio/src/lib/sound-schedule.ts` and in the export through the page's
  `data-volume`, both from `gain_db ?? gainDb`), at least 0.25 s apart.
- Behind (`behind`, starting values the owner tunes by eye): photo spots `top` (left 90, right 990,
  top 160, bottom 760), `left` (40 to 500, 560 to 1180) and `right` (580 to 1040, 560 to 1180),
  each covered exactly by the photo. The big word: `primary` font, at most 400 px, side margin
  40, `#FFFFFF`, its vertical centre wanted 60 px below the head's top (`belowHeadTop`) or at
  y 700 with no head (`noHeadY`), moved up until the person covers at most the lower 30% of its
  height (`minVisible` 0.7). The cut-out covers each item plus 3 frames on each side (`padFrames`
  at `frameRate` 30); a photo lasts 1 s (`minSeconds`) to 2 s (`maxSeconds`), a short beat rather
  than a backdrop, and a big word the accent's timing. No count per reel.
- Visuals (`decide-17`): the card (`behind.card`, owner decision 2026-11-07, a picture in picture
  card like the ones in talking-head reels): an empty white stroke frame over the footage, in front of
  the speaker, no fill and no text. Its width is a third of the frame's width (`widthShare`, 360 px) at
  4:5 (`aspect`, 360 by 450 px). Its spots (`CARD_SPOTS`, in this order for a tie): `top-left`,
  `top-right`, `bottom-left` and `bottom-right` (each `inset` 40 px in from `PLATFORM_SAFE`) and
  `beside-left` and `beside-right` (`layout.gap` from the moment's face, its top at the face's top). A
  spot is taken only when it is inside `PLATFORM_SAFE`, clear of the moment's face, of every caption,
  accent, big word and the hook shown in its span and of `PLATFORM_BUTTONS`; the spot with the most
  free space in the ring around it (`ring`, 60 px) wins. The full size is tried at every spot before
  the smaller step (`smaller`, 0.7: 252 by 315 px, one step only, recorded `shrunk`, rule
  `visual-size`), and then (`clean`) the visual is dropped (`no-room`); `all` puts it at the corner at the full size, overlap noted. 0.7, not 0.8 (288 px): on the speech-ten
  clip the free strip beside the speaker is about 260 px wide. A card never covers the face: no
  make-room step lets it. `stroke` (8 px) is the builder's border.
- Photos (`behind.photo`): the engine places no photo now. An older version's photo keeps the place
  it was stored with (`box`, `layer`, `spot`) and renders as before; placed again, it reads back as a
  card. `minVisible` (0.7) is what a stored photo behind the speaker is checked against (`photo-hidden`),
  and a card's white edge needs `minContrast` (1.5:1) against the footage within `ring` (30 px) around it.
- Pace (`pace`, the preset's `intensity` names its level, `intense` (the pros' level); the pace block is
  that level's; a later level, `calm` or `medium`, is one more name with its own block): something new besides captions at least every 3 s
  (`extraEverySeconds`; the decide prompt asks for no density, so the number is not sent to it)
  and about one transition per 9 s (`transitionEverySeconds`, the engine's cap, was
  `transition.perSeconds` 7), slower than the rhythm since a transition covers the speaker. The
  written hook (`pace.hook`): from 0.2 s (`fromSeconds`, the accent's lead) to 3 s
  (`untilSeconds`), the first seconds that decide whether people keep watching, at most 7 words
  (`maxWords`) and 45 characters (`maxCharacters`, both passed to the prompt as `hook_length`).
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
- `src/behind.ts`: `spotBox(spot, preset)` (the spot's rectangle), `photoBox(item, preset)` (a
  photo's `box`, else its spot), `needsCutout(item)` (a big word, and a photo not in front),
  `nearestSpot(box, preset)`, `boxFaceShare`, `personBoxes` (the face and the body under it),
  `placedBigWord` (a big word at
  its stored `position` and `size`, its width from HarfBuzz at 1 px), `bigWordLayout` (for a
  version saved before the engine: the big word
  as large as fits between the side margins, at most the preset's size and at least 8 px, centred
  across the frame, its centre below the head's top at the item's start or at `noHeadY`; its width
  from HarfBuzz at 1 px, so the measurer records it and the goldens cover it) and
  `maskSpans(edit, transcript, preset)`: the span of each item that needs the cut-out (never a photo
  in front) padded by `padFrames`, clamped to
  the reel, widened to whole frames, overlapping or touching spans merged, sorted, to the
  millisecond. The builder (one composite per span) and the worker (one mask per span) both call
  it, so they always agree.
- A caption with `hidden_by` is left out like a transition's own captions (`hiddenCaptionIds` in
  `src/transitions.ts`), so the page and the checks never see it.
- The hook renders like an accent (the primary font, white, the same rise in and fade out, no
  shadow) with its own class: `<span class="text hook f-primary">`, its lines centred by the
  `.hook { text-align: center; }` rule, written only on a page with a hook (so every stored page
  builds byte for byte as before). `TextBox.kind` is `hook` for it.
- Behind the speaker, one composite per mask span, above the footage and under transitions and
  text: an untimed isolated group (`.cutout`, id `cut_<n>`) holding a footage copy (`muted`,
  `data-media-start` equal to its `data-start`), the span's behind items (a photo `<img>` exactly
  over its spot, or the big word `<div>` at its measured size, each with its own start and
  duration as the hard cut), the mask inverted and multiplied (`.mask-under`, keeps the picture
  where the person is not), and an untimed `plus-lighter` sub-group (`.cutout-front`) of a second
  footage copy times the mask (the person back in front). Every layer is a plain timed element, so
  the player and the render's frame injector show the same pixels. A span with no matching entry
  in `inputs.masks` (start and end within half a millisecond) throws. A photo is drawn over its
  `box` (its spot without one).
- In front of the speaker (`layer: "front"`): the photo's `<img>` (`clip photo`, track index 30)
  after the composites, above the footage and under transitions and text, with no cut-out (so no
  mask span and no mask). A page whose only photos are in front writes the `.photo` rule alone,
  never the composite's rules; every stored page builds byte for byte as before.

### Transitions tied to a phrase

- `src/transitions.ts`: pure helpers shared by the engine and the builder. `transitionTiming`: the
  layer's entrance finishes as the phrase's first word starts, it has left when the word after the
  phrase starts (holding at most `transition.holdSeconds`, 1 s, after the last word; `long` wish
  `longHoldSeconds`, 2 s; `slow` wish multiplies the motion by `slowFactor`, 1.6), never shorter
  than `minSeconds` (1.5 s; later end first, then earlier start, else the transition is dropped).
  About one per `pace.transitionEverySeconds` (9 s) of reel, no overlap.
- Claude gives `{ kind, from, to, key_from }`, and a new answer may give `numbered` only (`NEW_TRANSITION_KINDS`,
  the LIST component). The library's kinds are `TRANSITION_KINDS`: `dim`, `panel` and `numbered`; the first two
  are older versions', each with a `description` the prompt reads when the kind is offered. The engine writes the transition item's
  `words`, `key`, `pace`, `hold`, `number` and `levels` (`number`, `lead`, `key`, each `{ text,
position, size, break_after?, start }`). The lead-in (words before `key_from`) is caption text
  and the key phrase accent text, from the style roles (`levelStyle`), never a literal font or
  colour; the layer's background is the `background` role at the kind's `shade`
  (`transitionBackground`). `numbered` shows a large number over a light dim.
- Each level appears whole on its first word and stays until the layer leaves. The captions
  inside the phrase are hidden (`hiddenCaptionIds`: no position, shown only through the levels), and
  no accent, photo or big word shows during a running transition. The engine places transitions'
  levels before the captions, in free space inside the layer and the safe zone, off the face where
  possible; every retime, move, shrink, wrap and drop is an `EngineNote`.
- The builder renders `levels` as children of the layer; a transition without `levels` (a stored
  version) renders as before. `safe-box` and `text-overlap` include levels; `face`, `timing` and
  `text-overlap` skip hidden captions. `choicesOf` reads a transition with `words` back as its
  phrase, `key_from` and `wish`; an older one by its anchors with `key_from = from`; a stored `card`
  reads back as `dim`.

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
  a reel too short to show it `accent.minSeconds` (1.5 s) it is dropped in `clean` (rule `hook-time`) and clamped to the reel in `all`. Both
  anchors are `anchorAt` (the nearest word end within a second, else a time where nobody speaks),
  so it follows its words through a re-time.
- A fixed slot (owner decision 2026-11-07): every reel has one, and it is placed on every run, first.
  `placeEdit` puts `hook` first in `requested`, so it is the first extra placed, before every accent,
  big word and photo. It shows from `pace.hook.fromSeconds` (0.2 s) to `untilSeconds` (3 s) and no
  other item moves it: nothing shifts, shrinks or cuts it short, and no make-room step removes it (it
  is not an extra the editor added). An accent, big word or photo whose words fall in its window is
  dropped (`one-extra`); one that starts after the hook has gone shows then. A transition that would
  show during the hook is dropped (rule `hook`). In `clean` its only drop is a reel too short for it
  (`hook-time`), recorded; `all` clamps it to the reel instead. Captions keep running below it; nobody says it, so no caption is ever left
  out for it.
- Reserved before the captions, on every run (owner decision 2026-11-07): the plain pass places the
  hook first, then the captions, so the captions in its window keep clear of it by the caption rules:
  each block moves to a free place, shrinks down to the floor, and only when nothing else is free goes
  on the caption line over the face (`covers-face`, rule `caption-face`, never dropped). A caption-heavy
  opening therefore never drops the hook (`no-room` no longer comes from the captions).
- Placement: the accent's font, size and colour, in the upper part of the frame (the safe zone's
  top half, above the face and the body under it), else the free part of the safe zone; in each
  place it tries one line, then two (the balanced break), at each size down to the floor before
  it moves on. Contrast as for an accent. When nothing fits, the make-room ladder runs for it as
  for a request; its `make-room` notes never say `as asked` unless the owner's checklist linked it.
  Below the floor the hook shrinks further, to the smallest size at which its words fit the safe
  zone in one or two lines (`hook-size`, `shrunk`), never below `MIN_TEXT_SIZE` (8 px, the schema
  minimum for every text size: the schema refuses a smaller one, so no edit with a smaller size is
  ever built). A long word or sentence that fits no place down to 8 px goes through the make-room
  ladder, which may cover the face as its last step (`make-room`, `covers-face`); the hook is then
  never dropped for its size. Notes: `hook-spot` (`moved`), `hook-size` (`shrunk`), `hook-wrap` (`wrapped`), `make-room`,
  `no-room` (`clean`: `dropped`, only when no size and place is left at all, which the schema's limits make
  unreachable in practice).
- Checks treat it as text: `safe-box`, `text-overlap`, `timing` (at least `accent.minSeconds`) and
  the glossary check (`glossaryChecks` reads every overlay's text).
- The written hook is an overlay with its own kind (`hook`, keyed once per reel). The studio's
  tracks timeline shows it in its own `Hook` row
  (`app_docs/studio-reel-layout.md`).

### The layout engine's input

- `src/engine-input.ts`: `EngineInput` is what the decide answer hands the layout: `accents`
  (word ranges; an older version's title is one with `title: true`, a new answer never sets it), `big_words` (a list of `{ from, to }` word ids: one word, or
  two consecutive ones, equal for one; an older `{ word }` reads as one word; the same word allowed
  again), `visuals` (a word range and an optional `description`; a new answer names no photo), `transitions` (a kind, a word range and `key_from`, where the key phrase starts; a new answer gives `numbered` only), `word_fixes` (a word id and its text), each
  with an optional `wish` from `WISHES` (an older version's: a new answer carries none) (`top`, `bottom`, `left`, `right`, `behind`, `beside_head`,
  `big`, `small`, `slow`, `long`), and the optional `hook` (`{ text }` or null, no wish). No
  times, positions, sizes or spots.
- What a new answer may hold (`decide-17`, the change box removed 2026-11-07): no title (the written hook is
  the title now, and the hook call writes it), transitions of kind `numbered` only (LIST), no `wish`. What an older version may hold, and
  the engine still places and renders: a title (the accent with id `title`, read back as an accent with
  `title: true`), transitions of kind `dim` and `panel` (a stored `card` reads back as `dim`), any `wish`
  from `WISHES`.
- `choicesOf(edit, transcript, preset)` reads a version back as an `EngineInput` (what Claude is
  shown): each item by its anchor words, or the words spoken under it (an older version's written
  title); a caption whose text differs from its words is a fix on its first word. A VISUAL reads back
  with its description; an older library photo reads back as a visual over the same words (with no
  description), so the choices placed again place a frame in its place. Every big word reads back
  (an older version's one big word as a list of one; a two-word one from its first word to its last). The hook reads back as its text, null when
  the version has none.

### Layout engine

`src/engine.ts`, `placeEdit(current, input, transcript, headTrack, preset, measurer, { requested })`
returns `{ tracks, record }`: the edit's tracks as the builder consumes them (every caption, accent
and big word with `position` and `size`, every visual with a `box` and `spot`) and the record of what
it did.
Pure and deterministic: no randomness, no clock, no I/O; the same input gives the same tracks and
record. `editFromAnswer` (decide) and the worker's `first_version` step (with no choices) call it.

- Inputs: the current version (footage and captions kept, never its sounds; each word fix becomes the text
  of the caption showing that word; old positions and sizes are dropped), the answer's choices, the
  transcript with word times, the head track, the preset (safe box, fonts and sizes, transition
  text areas, behind spots as candidates) and the HarfBuzz measurer.
- Timing first (owner decision 6):
  - Captions: each from its own word; a group (consecutive captions ending on the same anchor)
    leaves at its last word's end, held so its last caption shows at least 0.25 s, never past the
    next group's start; a last caption that cannot show that long joins the next group.
  - Accent: from `accent.leadSeconds` (0.2 s) before its first word to 1 s after its last, at
    least 1.5 s (the start anchor is the first word with `offset` -0.2).
  - Big word: the accent's timing (owner decision 2026-11-04, replacing 2 s from its word): from
    the lead before its spoken word to 1 s after it, at least 1.5 s; cut short only by the reel's
    end or the one-at-a-time rule, down to 1.5 s. Ids `big-word-1`, `big-word-2`, ... in answer
    order (`big-word` in older versions).
  - The lead never starts before 0 and gives way to the extra before: when that one leaves after
    the lead would start but by the word, the accent or big word comes in as it leaves (and keeps
    its minimum by leaving later); one still showing at the word is cut short there, as before.
    Captions have no lead.
  - Visual: from its sentence's start (from its first word when that is more than 1 s into a long
    sentence), leaving at the sentence's end or 2 s later, whichever comes first, at least 1 s,
    taking the pauses around a short sentence but never another sentence's words; dropped when that
    is under 1 s.
  - At most one extra (the hook, an accent, a big word or a visual) at a time on top of the
    captions: a later extra may cut an earlier one short down to its minimum, or end itself before
    a later one down to its minimum; else it is dropped. The hook and a running transition are
    never cut short. Behind items never cross a hidden span of footage.
  - The hook: from `pace.hook.fromSeconds` to `untilSeconds` ("The written hook" above); a
    transition that would show during it is dropped (rule `hook`).
- Scene: the reel is cut into moments at every item edge; each moment's face is the bounding box
  of the robust faces around it (`facesOver` in `src/head-track.ts`: at each head-track sample, the
  samples within 0.5 s, `cx` their median, the width their upper quartile, the top their lower
  quartile, so one bad reading never moves it), padded like the old layout (35 px left, 30 px right)
  plus `gap` above and below. The body under the face (1.8 head widths wide, to the frame's bottom)
  is an obstacle for accents only: captions may sit on the chest, the big word may have its lower 30%
  behind the person, and a card may cover the body (never the face). The mask itself is not read (it is a video).
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
    so captions stay readable. A sentence that shares its time with a planned visual first tries
    only places that leave a card spot free.
  - Then the extras: the hook first, the items the request checklist links (`requested`, item 5
    strengthens this), then accents, big words, visuals, each in answer order.
  - Accent: above the head (its top about 190 px above the head), the upper part of the frame, the
    free part of the safe zone (with no head: the accent line at y 1130, then the safe zone); a
    `top`, `bottom`, `left`, `right` or `beside_head` wish goes first, `small` starts at 80%. In
    each candidate it shrinks to the floor and wraps to two lines (the balanced break) before it
    moves on.
  - Big word: as large as fits between the side margins (at most `maxSize`), its centre wanted
    `belowHeadTop` below the robust head top at its word (or at `noHeadY`), placed nearest that
    inside the frame (40 px margin, never above `PLATFORM_SAFE`'s top 220) clear of every text
    shown with it. Most of it stays in view: in every column the person (the robust faces over
    its span, `facesOver`, and the body under them, 1.8 head widths wide) covers at most the lower
    30% of its height (`bigWordCoveredShare` in `src/behind.ts`, shared with the check). Short of
    that the wanted centre moves up 10 px at a time to the top (recorded `moved`, rule
    `big-word-visible`), then the next smaller size is tried down to the floor (`shrunk`, rule
    `big-word-visible`); with no place at all it is dropped in `clean` (`big-word-visible`, the editor's
    `no-room`).
  - Never the same word twice on screen: once the extras are placed, a caption whose words an
    accent or big word shows (never the hook: nobody says it) at some moment of the caption's own span is left out for that whole
    span (`hidden_by`, no position), so no word blinks in or out of its group; a caption that
    appears after the extra has left shows as usual. The rest of its group is set again at the
    block's place, size and alignment, inside its old box (the sentence keeps its one spot, and
    nothing else moves); a group with every caption hidden shows no caption then. Nothing is
    recorded for it.
  - Visual (the card, owner decision 2026-11-07): the first spot of the card that fits, at the full
    size and then at the smaller step, ranked by the free space around it (see "Preset values").
    Written: `layer` `front`, `box` (the card's place and size), `spot` (the nearest preset spot).
    Notes: `visual-size` (`shrunk`, the smaller step: `visual 1 set at 252 by 315 px instead of 360 by
450: no corner or side of the face is free at full size from 5.21 s to 7.21 s`), `no-room`
    (`dropped`: no spot free at either size: `visual 1: no free corner or place beside the face from
... at full size or smaller, clear of the face, the captions and the hook`), and the contrast notes
    below. Captions placed before it keep their spots clear of it; a requested card is reserved
    before the captions, as any requested extra.
  - Card contrast: with the background map, the WCAG ratio of the card's white edge against the footage
    in and 30 px around it (`ring`) must reach `minContrast` (1.5); below it the card tries nearby places
    (the readable-text grid, `readability.moveRadius`, inside `PLATFORM_SAFE`, clear of the face, the
    captions, the hook and the button column) and moves to the nearest that reaches it (`contrast-spot`,
    `moved`), else stays (`contrast-stay`, `low-contrast`, `... a visual never gets a shadow or a colour
change`). Never a shadow or a colour change; recorded only, never a check. A card without a known
    background is not measured.
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
  decision 2026-11-04 (replacing the soft shadow, which read as a black stroke): move first, never
  a shadow, never a colour change. The big word is never moved for contrast; a caption that already
  covers the face is never moved for it. Low contrast is recorded only: it is no check failure and
  no engine bug, and the version saves as usual. With no `backgrounds` given the engine behaves as
  before. Example reason: `captions "the time we're living right now push ..." stay in place:
contrast 1.8:1 from 0.28 s to 7.51 s, no free place nearby reaches 4.5:1` (an accent or big word:
  `stays in place`; for a caption over the face or the big word the reason ends with
  `captions over the face are never moved` or `the big word is never moved`). Versions saved before the decision keep their stored `shadow`, and their
  records the legacy rule `contrast-shadow`, action `shadowed`; both are left as they are. No text
  style anywhere (captions, accents, the title, big words, transition levels) adds a stroke or an
  outline (`-webkit-text-stroke`, `paint-order`, a text shadow).
- Sounds (`src/clicks.ts`, `clicksFor`, owner decision 2026-11-04): the engine writes a new
  version's sound track. One `click` (`click-<item id>`) as each placed photo, behind or in front,
  and each big word comes in, on the item's own start anchor (a big word's lead, 0.2 s before its
  word), its end the item's end, so the click follows its item through every retime and goes when
  it is dropped. Nothing else clicks: captions, accents, the hook and transitions stay silent. In
  time order, a click under the sound's gap (0.25 s) after the one kept before it is left out,
  with no note. The current version's sounds are never kept; a stored version's sounds are never
  rewritten (it is never placed again). No switch to turn them off yet.
- Placement (`preset.placement`, the worker's preset is `all`; `CLEAN_PRESET` is `clean`). In `all`
  every pick the answer proposed is shown at its own words' times: an accent or big word from the
  lead before its first word (0.2 s) to its last word's end (at least 1.5 s, or the shown floor
  below); a visual from its first word to its last word's end (up to 2 s, the behind length); a
  transition at its own timing. Nothing is dropped for room, for another extra, for the hook, for a
  transition's rate or overlap, or for pace, and the make-room ladder never runs. Each pick takes its
  normal spot when a free one exists; when none does, its default spot anyway (an accent or the
  transition text at the head's upper place or the line, a big word at its head rule's centre, a
  visual at the top-left corner), at the largest size that fits and never below `MIN_TEXT_SIZE`, and
  it is noted `kept-overlapping` (rule `all-picks`) with what it sits over (the face, other text) or
  the picks it shares its time with. Overlaps between picks are kept: the one-at-a-time rule of the
  behind track and the checks `text-overlap`, `behind-caption`, `big-word-hidden` and `behind-face`
  (a card over the face) are the `clean` layout's, not applied in `all`.
  No `dropped` note is ever written in `all` (a seeded property test checks it). The fallbacks, each noted:
  - Too close to the reel's end for its minimum: the end is the reel's end and the start moves
    earlier, so it shows at least `ALL_SHOWN_SECONDS` (0.5 s) (`clamped-to-end`). The schema and the
    checks take the same 0.5 s in `all`.
  - A big word or visual over hidden footage: the next visible moment, the first kept time after the
    cut, else the last one before it (`moved-off-cut`). With no visible moment at all it stays over
    the cut, and the schema then refuses that edit.
  - A transition or list pick with no caption text of its own: the words of its phrase are its text
    (`text-from-words`); a text over 300 characters is cut at a word, noted the same way.
  - The hook: its start moves earlier when the reel is shorter than its floor (`clamped-to-end`); with
    no free place at any size, its slot at the largest size that fits, overlap noted.
  - An accent, big word or visual with no free place at all: its default spot at the smallest size
    (an accent in two lines at the safe box's corner), overlap noted.
    The hook keeps its fixed slot in both.
- Drops (`clean` only; `all` drops nothing for room, see "Placement"): an extra that fits nowhere is
  dropped and recorded. Captions are never dropped: with no free place even at the floor, they take
  the caption line over the face (recorded `covers-face`).
- Record: a list of `EngineNote` `{ item, action, rule, reason }`, `action` one of `moved` (not its
  kind's first place), `shrunk`, `wrapped`, `retimed`, `dropped`, `covers-face`, `wish-not-kept`, `low-contrast`, `removed` (and, in older
  records only, `shadowed`), `kept-overlapping` (`all` only: a pick kept over the face, other text or
  another pick, rule `all-picks`), `clamped-to-end`, `moved-off-cut` and `text-from-words` (`all` only, see "Placement"),
  `reason` in plain words with the item's text and times, for example
  `{ "item": "photo-1", "action": "dropped", "rule": "no-room", "reason": "photo 1: every photo spot
is under captions or the face from 23.48 s to 26.23 s" }`. Rules: `caption-min`, `caption-spot`,
  `caption-size`, `caption-face`, `accent-time`, `accent-spot`, `accent-size`, `accent-wrap`,
  `big-word-time`, `big-word-size`, `big-word-visible`, `visual-time`, `visual-size`,
  (`photo-time`, `photo-layer`, `photo-size` and `photo-spot` in older records), `hidden-footage`, `one-extra`,
  `hook`, `hook-time`, `hook-spot`, `hook-size`, `hook-wrap`,
  `no-room`, `wish`, `contrast-spot`, `contrast-stay` (`contrast-shadow` in older records), `make-room`, and `editorial` in the records of versions decided before the editorial round was removed. Saved with the version (`versions.engine_record`) and logged by the worker in
  one line per version.
- Final checks: `runChecks` (below) runs on every placed edit. They must never fail on the engine's
  output; one that does is an engine bug, logged with the reel id while the version is still saved.

#### Making room for a request

Without `requested` and without a hook the engine makes no room: one plain pass (`placeOnce`),
byte-identical to the committed goldens. The hook is always requested (first, ref `hook`) and reserved
in the plain pass too (before the captions, "The written hook"). With
it (`editFromAnswer` passes the checklist's linked items), each requested
item the plain pass leaves out, in checklist order, gets room step by step until it is placed: the
captions sharing its time move (full size), then shrink or wrap down to the floor, then extras the
editor added on its own that stand in the way (and transitions covering every place it needs) are
removed, then it shifts inside its sentence, and only last it may cover the face. A step's pass is
taken only when the item is placed, every requested item placed before stays placed, and no caption
block goes over the face that did not already. Each step is recorded under the rule `make-room`
(action `moved`, `shrunk`, `retimed`, `removed` or `covers-face`); an item for which nothing works
keeps its `dropped` note with the steps tried. `placeEdit` also returns `unplaced` (extras dropped,
with answer ref, kind and a reason code) and `free` (sentences with room for each kind), the engine's own
report; no step asks Claude about them any more (`app_docs/decide-step.md`). A visual never takes that last step: its card never covers the face, so a requested visual with no
spot free at either size is dropped with the steps tried (the `make-room` tail).

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
- `behind-face`, `behind-caption` (`app_docs/decide-step.md`): a photo behind the speaker (its box,
  else its spot) not taken over by the face, a photo in front never over any part of the face, and
  no caption or accent over either.
- `photo-hidden`: a photo the engine set behind the speaker (one with a `box`) has at most its
  lower 30% behind the person (`behind.photo.minVisible`, `bigWordCoveredShare`). A stored photo in
  a spot is not checked for it.
- `face`: captions clear of the face (the robust faces, `facesOver`, at every moment of the
  caption's span, the same ones the engine avoids).
- `text-overlap`: no caption, accent, hook or big word on another one shown at the same time.
- `timing`: captions at least `caption.minSeconds` (0.25 s) and accents and the hook at least
  `accent.minSeconds` (1.5 s) on screen.
- `big-word-timing`: the big word never shows more than `accent.leadSeconds` (0.2 s) before its
  word (the matching spoken word nearest its start) is said.
- `big-word-hidden`: the person covers at most the lower 30% of a big word's height
  (`bigWordCoveredShare`), so it is not hidden by the head. A version saved before 2026-11-04
  with a big word at head height shows this failed check.
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
  in `inputs`) on the same data, and `rethink-work-hook.edit.json` (the engine's choices with the
  written hook "Gen Z won't work like you did", placed by the engine: its own class, wrapped and
  shrunk in the upper part of the frame), and `rethink-work-front.edit.json` (the engine's choices
  with every visual requested: each a card clear of the face, no mask for it).
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
  fixture versions (the hook one included) and every golden from the Node build, all with `CLEAN_PRESET` (the strict layout the goldens have always held). Commit what it writes. The hand-made
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
- `src/engine.test.ts`: each timing rule (captions, accents and big words from the lead before
  their word to a second after it, the lead giving way to the extra before, the same word again,
  photos 2 s from their sentence's start, drops under the minimum, one extra
  at a time, the request's items first, about one transition per 9 s), no check failing on a dense
  reel (a title, four accents, a big word, two photos and a panel) and on the Intense rhythm (an
  extra on every sentence and two transitions: one extra at a time, nothing during a transition,
  photos 1 to 2 s, big words on the accent's timing, no word twice on screen, every left-out
  item's drop recorded) with the real head and with a large
  centred face, one spot per sentence, the big word on its word and inside the frame with one bad
  head reading, a long title shrunk and wrapped (and one too long dropped), captions over a face
  that fills the safe zone recorded, today's failures (two accents in a row, captions on the big
  word, card captions on the face, a photo whose sentence's captions filled every spot, a photo
  with no free spot dropped with its reason), the captions an accent or big word shows left out
  (`and sense of purpose` reads `and`, `it to the world` reads `it to the`, a whole group hidden),
  a short big word moved up out from behind a large face and one dropped under a head at the safe
  top, determinism, and the engine placing its own output
  the same again. The written hook: from 0.2 s to 3 s in the upper part of the frame with no
  failed check and no caption left out for it, an accent in its window dropped (`busy`) and one
  after it shown, never cut short, an accent and an image asked for in its window never moving or
  removing it (`src/engine.test.ts`, "the written hook"), a transition in its window dropped (rule `hook`), room made with
  the face covered last and never `as asked`, read back and placed the same again, dropped only on
  a reel too short for it. `src/decide.test.ts` (the answer field: required, null for none, the
  words and characters caps, one plain line, no wish or time, linked from the checklist, placed on
  the fixture clip), `src/schema.test.ts` (the overlay kind), `src/glossary.test.ts` (a heard
  form in the hook). `src/checks.test.ts` also shows the new checks finding the old fixed-spot
  placement's faults in the hand-made versions.
- Clicks: `src/clicks.test.ts` (one per photo and big word in time order, the first of two under
  the gap kept, -6 dB) and `src/engine.test.ts` (a click on each placed photo and big word and
  nothing else, the current version's sounds not kept, a dropped item's click gone, a retimed
  item's click on its start, the stored hand edit's click as it was, `data-volume="0.5012"`).
- Visual cards (`src/engine.test.ts`, "visuals: corner cards over the footage"): on the speech-ten
  head (336 px wide, its top near y 568, centred) and two other heads, a card at a corner or beside the
  face, inside `PLATFORM_SAFE`, clear of the face with no failed check; the full size where a side is
  free and the smaller step (`shrunk`) where only it fits; no card over the face, the hook window or a
  caption on a dense reel with a hook; dropped with `no-room` when no spot fits at either size; the size
  and ratio kept across a reel; the white edge moved or kept with `low-contrast`; a requested card never
  covering the face (the `make-room` tail). `src/checks.test.ts` (a front photo over the face fails
  `behind-face`, `photo-hidden` over 30%, a stored spot photo never checked), `src/build.test.ts`
  (a front-only page), `src/behind.test.ts`, `src/schema.test.ts` (`front`, "in front of you"); the worker's
  `cutout/spans.test.ts` and `cutout/ensure-cutouts.test.ts` (no mask for a front photo). The
  visual's own tests (`src/engine.test.ts`: a visual in front as a white frame, its contrast note,
  an old version's photo still rendered; `src/decide.test.ts`: the answer's schema).
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
- In `clean`, never let text overlap text, or a photo or visual (behind or in front) sit under a caption or an accent: the engine places
  nothing on what is already placed, and `text-overlap` and `behind-caption` guard it. In `all` such an overlap is kept and noted
  (`kept-overlapping`), never silent.
- Never drop a caption. In `clean`, only extras (accents, big words, visuals) are dropped for room, each with a
  recorded reason. In `all`, no pick is dropped at all: the fallbacks in "Placement" show it. A caption left out while an extra shows its words is not dropped: its words
  are on screen.
- Never read a single head-track sample for a placement or a check: always the robust faces
  (`facesOver`).
- In `clean`, never show more than one extra at a time on top of the captions. Always (both modes), an accent or big word is
  never shown more than `accent.leadSeconds` before its word, and the lead never cuts into the extra before (`all` takes
  the lead as its start and never moves it to fit).
- Never show a spoken word twice at once: a caption whose words an accent or big word shows is
  left out while it shows, for its whole span (never blinking in or out of its group).
- Every text on screen is a spoken word, except the one written hook at the start: never more than
  one hook in a version, never a hook with words, and never a caption left out for it.
- Never end the hook with a full stop or an ellipsis (`stripHookStop` takes them off; "?" and "!"
  stay).
- Never drop the hook while any make-room step finds it a place, never cut it short, and never
  run a transition during it.
- Never move, shorten, remove or cut short the hook for another item: the hook is placed first, the other
  extras wait, are dropped or are cut short by it (never the reverse), and its window never shifts
  (`shiftsOf`). In `clean` its only drop is `hook-time` (a reel too short for it); `all` clamps it to the reel and never drops it.
- Never let a caption drop the hook: the hook is reserved before the captions on every run, and the
  captions in its window keep clear of it (move, shrink, or last, over the face).
- Never drop the hook for its size: below the floor it shrinks until its words fit in one or two lines
  (`hook-size`).
- In `clean`, never let the person cover more than the lower 30% of a big word (`behind.word.minVisible`)
  in a new version; in `all` a big word the person covers more of is kept and noted. Never place one above `PLATFORM_SAFE`'s top.
- Never let a visual leave its card: it is a corner card in front of the speaker, never behind them,
  never over the face, a caption, an accent, the hook, a big word or the button column, always inside
  `PLATFORM_SAFE`; the only size below the full card is `card.smaller`, and a visual that fits at
  neither is dropped with `no-room` in `clean`; in `all` it takes the top-left corner at the full size, overlap noted. The engine, never Claude, chooses its place and size.
- Never give a visual a fill, a text, a shadow or a colour change: its white stroke is its frame. Never
  give a photo a frame, an edge or a shadow: a card whose edge blends with the footage moves, else stays,
  recorded `low-contrast`.
- Never cut out (no mask span, no mask) for a photo or a card in front of the speaker.
- Never let Claude write a transition's time, position or size, nor a literal font or colour in a
  transition entry: they come from the words and the style roles.
- In `clean`, never show an accent, photo or big word during a running transition (`all` shows them, noted).
- Never hold a photo past `behind.maxSeconds` (2 s), or a big word past a second after its word
  (the accent's timing), in a new version; never refuse a stored version for an older, longer
  one.
- Never click on anything but a photo or a big word coming in, never off its start, and never two
  clicks closer than the sound's gap in a new version; never rewrite a stored version's sounds.
- Never place a stored version again: the builder keeps every stored position, and a version saved
  before the engine keeps the old fixed-spot placement.
- The engine is pure and deterministic: no randomness, no clock, no I/O.
- Never remove a caption, set it below the floor, put it over the face or outside the safe zone to
  make room.
- Never drop or remove an item the owner asked for to make room for another.
- Never let an `all` edit fail the schema or the checks: its overlaps are the only ones allowed, and every pick is in the edit. The one exception: a big word or visual over footage hidden for the whole reel (no visible moment to move it to).
- Cover the face for a requested item only after every other step; a visual's card never covers it.
- Without a request the engine never makes room, except for the hook: with no hook its output is
  the plain pass's. In `all` the make-room ladder never runs: nothing is dropped to make room.
- Never change a text colour to make it readable, and never add a shadow, a stroke or an outline
  to any text in a new version: move it, else leave it in place, plain, and record it.
- Never move the big word for contrast.
- Never fail a check or a version on low contrast: it is recorded only.
- Never rewrite an older version's stored `shadow`; the builder keeps rendering it.
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
