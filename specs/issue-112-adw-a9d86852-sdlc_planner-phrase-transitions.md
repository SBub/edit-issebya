# Feature: transitions tied to a phrase, two text levels from the style roles, a numbered point, no card

## Metadata

issue_number: `112`
adw_id: `a9d86852`
issue_json: `{"number":112,"title":"transitions: tied to a phrase Claude picks, two text levels from the style roles, a numbered point, no card"}`

## Feature Description

Today a transition is a timed layer (`dim`, `panel`, `card`) whose `start` and `end` anchors the
decide step picks freely, apart from the words it carries. It can start mid-word, end
mid-sentence and last a fraction of a second, so it reads as a glitch. The captions under it are
moved into its text area, one caption at a time.

This feature makes a transition carry a **phrase**: a run of words Claude picks (first and last
word id), usually a lead-in plus a key phrase, with the word where the key phrase starts. The
builder derives the transition's times from those words and the preset: the entrance motion ends
as the first word starts, the layer holds through the pause after the last word and leaves when
the next word starts (at most 1 s of hold), and a transition shorter than 1.5 s is refused. Inside
the transition the lead-in is set in the style's **caption text** role and the key phrase in its
**accent text** role, each level appearing whole on its first word and staying until the
transition leaves; those words' captions are not also shown in their usual place.

The library becomes `dim`, `panel` and a new `numbered` (a large number in accent text over a
light dim, lead-in and key phrase below), each with a short description Claude reads. `card` leaves
the library (stored versions with a `card` or with old timed transitions still parse and build
exactly as they do now). The preset gains named style roles (`accentText`, `captionText`,
`background`) so that no transition entry names a font or a colour, and checks for length,
density, overlap with `behind` items and other transitions, the text area inside the platform safe
zone and text contrast. The decide prompt explains the library, the phrase rule, the two levels,
the density and the wording rule for corrections ("longer" changes the phrase, "slower" or "stay
longer" changes the bounded motion or hold fields), and the version summary says which was
changed.

## User Story

As the reel owner
I want each transition to wrap a phrase I can read, entering before its first word and leaving
when the next word starts, with the lead-in and the key phrase set in my style's caption and
accent text
So that transitions look like the ones in my reference reels instead of a short glitch, and a
"make the transitions slower" request does exactly that

## Problem Statement

`decide` gives every transition free start and end anchors (`packages/edit/src/schema.ts`,
`transition` with `base` timing), chosen apart from the words it carries, with fast fades (dim
0.3 s, panel 0.5 s, card 0.25 s in `packages/edit/src/preset.ts`). The prompt
(`apps/worker/src/decide/prompt.md`, step 3) places transitions "where the topic changes". The
result starts mid-word, can be shorter than its own motion, shows captions one by one in a box
meant for a statement, and the owner's first change request was "make transitions longer, i can't
preview them properly they are more like a glitch". The preset also names literal colours and
fonts per transition, so a later font pair or colour wheel would have to edit every transition.

## Solution Statement

1. **Format.** A second transition shape, the _phrase transition_:
   `{ id, type, from, to, key_from?, number?, motion_seconds?, hold_seconds?, style? }`, with
   `from`, `to` and `key_from` word ids (word-id enums per reel). It carries no times. The old
   _timed transition_ shape (`{ id, type: dim|panel|card, start, end, color?, style? }`) still
   parses so stored versions keep working; only the decide answer is limited to phrase
   transitions of type `dim`, `panel` or `numbered`.
2. **Preset.** Style roles `roles.accentText`, `roles.captionText` (font key, colour, size) and
   `roles.background` (colour). The fonts keep only family, file and weight; the size moves to the
   role. A library `transitions` record (`dim`, `panel`, `numbered`) whose entries name a layer,
   the background role with a strength, a motion, motion seconds, an ease, a text area inside the
   safe box and a description Claude reads, and never a font or a colour. A frozen
   `legacyTransitions` record (`dim`, `panel`, `card`) holds today's exact looks so old timed
   transitions build byte for byte as now. Preset settings `transitionRules`: max hold 1 s, min
   length 1.5 s, one per 7 s, and the bounded ranges for `motion_seconds` and `hold_seconds`.
3. **Timing.** `resolveTimeline` derives a phrase transition's span: start = first word's start
   minus the motion seconds; end = the next word's start, capped at the last word's end plus the
   hold (default 1 s), capped at the reel's end. A start before 0 is clamped and reported by the
   existing `out-of-reel` check. Everything that reads spans (layout, checks, the studio tracks
   timeline, sound scheduling, specs) goes through it, so preview and export agree.
4. **Builder and layout.** A phrase transition's two levels are laid out in its text area: for
   `numbered` the number first (accent text, the entry's number scale), then the lead-in (caption
   text) and the key phrase (accent text), each a centred block; a level wider or taller than the
   area shrinks to a floor, and what still does not fit is reported by a check. Level text comes
   from the phrase's captions (their fixed `text` kept) and the words no caption carries. The lead
   appears whole at its first word, the key phrase at `key_from`, both fade with the layer's exit.
   Captions starting inside a phrase are not placed elsewhere; a caption shown in its usual place
   ends no later than the transition's start.
5. **Checks.** New rules in `runChecks`: `transition-length`, `transition-density`,
   `transition-behind`, `transition-overlap`, `transition-area`, `transition-fit`,
   `transition-accent` and `contrast`, each with a plain reason the decide retry can act on.
6. **Decide.** The prompt and `presetSummary` describe the library from its descriptions, the
   roles, the phrase rule, the two levels, the density and the correction wording rule; the answer
   schema offers only phrase transitions. `PROMPT_VERSION` becomes `decide-4`.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md` - repository rules (Yarn only, no em-dashes, docs one per feature, every
  "never" in a feature doc is an invariant).
- `.adw/project.md` - the profile: test layers, filters (`--filter=...{./packages/edit}` adds the
  studio and the worker), the E2E suite and what never runs.
- `docs/conditional-docs.md` - matches `app_docs/edit-model.md`, `app_docs/decide-step.md`,
  `app_docs/preview.md`, `app_docs/export.md` and `app_docs/change-requests.md` (the slower request
  spec).
- `app_docs/edit-model.md` - the format, preset values, builder, checks and their Rules; updated.
- `app_docs/decide-step.md` - the prompt, `PROMPT_VERSION`, the answer schema, the scripted answer;
  updated.
- `app_docs/preview.md` - live preview shares the build; note the derived transition times.
- `app_docs/export.md` - the render uses the same build; note it, and that the guardrail compares
  the new transitions too.
- `app_docs/change-requests.md` - the change box flow the new E2E spec uses (read only).
- `packages/edit/src/schema.ts` - `tracksSchemaFor`: add the phrase transition shape beside the
  timed one; `refineEdit`: phrase rules (`to` not before `from`, `key_from` inside the phrase,
  `number` exactly for `numbered`, no `card` phrase); its item loop must skip items without
  `start`/`end`.
- `packages/edit/src/preset.ts` - roles, library transitions with descriptions, legacy looks,
  transition rules, `TRANSITION_TYPES` (`dim`, `panel`, `numbered`), `LEGACY_TRANSITION_TYPES`
  (`dim`, `panel`, `card`); `caption` and `accent` lose `font` and `color` (moved to the roles).
- `packages/edit/src/timeline.ts` - `resolveTimeline` derives phrase transition spans; a helper
  `phraseOf(item, transcript)` returning the lead and key word lists.
- `packages/edit/src/layout.ts` - text item defaults from the roles; the two levels (and the
  number) in the transition text area; absorbed captions; captions cut at the transition start.
- `packages/edit/src/build.ts` - background from the role and strength for phrase transitions,
  legacy looks for timed ones, motion seconds from the item or the entry, level reveal and exit
  tweens; the `@font-face` and `.f-*` rules unchanged.
- `packages/edit/src/checks.ts` - the new rules; the `time-in-speech` and `out-of-reel` loops must
  handle items without anchors.
- `packages/edit/src/behind.ts` - calls `resolveTimeline`; check it still compiles with the new
  signature.
- `packages/edit/src/decide.ts` - decide answer: `transitions` limited to phrase transitions with
  the library types and the bounded fields; `decideCounts` unchanged in meaning.
- `packages/edit/src/index.ts` - export the new types and helpers the worker and studio need
  (`TransitionItem` variants, `isPhraseTransition`, `contrastRatio` if the worker or studio uses
  it; knip fails on unused exports, so export only what is consumed).
- `packages/edit/src/baseline.ts`, `packages/edit/src/glossary.ts` - read the caption role instead
  of `preset.caption.font`/`color` where they do.
- `packages/edit/src/test-support/fixtures.ts`, `goldens.ts`, `golden.ts`,
  `packages/edit/scripts/golden.ts` - add the new golden fixture.
- `packages/edit/src/testdata/versions/rethink-work-hand.edit.json` - keeps its timed `panel`: the
  proof that old timed transitions still build byte for byte (its golden must not change).
- `packages/edit/src/*.test.ts` (`schema`, `preset`, `timeline`, `layout`, `checks`, `build`,
  `decide`) - extended.
- `apps/worker/src/decide/prompt.md`, `prompt.ts` - the prompt and `PROMPT_VERSION`.
- `apps/worker/src/decide/input.ts` - `presetSummary`: roles, library with descriptions, rules and
  ranges, no per-font size.
- `apps/worker/src/decide/prompt.test.ts`, `input.test.ts`, `run-decide.test.ts` - the prompt text,
  the summary and the answer pipeline (line 634's comment names the dim text region).
- `apps/worker/src/decide/testdata/short-speech-answer.json` - the committed scripted answer: its
  `dim-clip` becomes a phrase transition.
- `apps/worker/src/ai.ts` - its fallback tracks literal (`transitions: []`) stays valid; check.
- `apps/worker/src/edit-measurer.ts` - reads `preset.fonts[key].file` only; check.
- `apps/studio/src/lib/tracks-timeline.ts`, `tracks-timeline.test.ts` - label a `numbered`
  transition (`numbered 3`); spans already come from `resolveTimeline`.
- `apps/studio/src/lib/sound-schedule.ts`, `apps/studio/src/components/ReelPreview.tsx`,
  `apps/studio/src/lib/edit-assets.ts` - consumers of `resolveTimeline` and `preset.fonts`; check
  they compile.
- `apps/studio/test-support/ai-script.ts` - `roundEnvelope` drops the committed answer's
  transitions when it adds behind items (a transition and a behind item never overlap; the
  fixture clip is 2.69 s, so every behind item covers the whole clip); a new
  `slowerTransitionsAnswerScript(dir)`.
- `apps/studio/e2e/upload.spec.ts`, `decide-behind.spec.ts`, `behind.spec.ts` - use the committed
  answer; must keep passing ("1 transition" in the step line stays).
- `apps/studio/e2e/preview.spec.ts`, `change-requests.spec.ts` - models for the new spec (preview
  frame locator, CDN routing, worker `once`, versions list).
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`, `apps/worker/src/render/render.tools.test.ts`
  - owner-only tool tests that call `resolveTimeline`; must still compile.

### New Files

- `packages/edit/src/testdata/versions/rethink-work-transitions.edit.json` - the hand version with
  its timed panel replaced by one `dim` (lead-in plus key phrase), one `panel` (key phrase only)
  and one `numbered`.
- `packages/edit/src/testdata/golden/rethink-work-transitions.html` and
  `rethink-work-transitions.widths.json` - its golden, written by
  `yarn workspace @edit-issebya/edit golden`.
- `packages/edit/src/contrast.ts` and `contrast.test.ts` - WCAG relative luminance and contrast
  ratio of two `#RRGGBB` colours (pure, small).
- `apps/studio/e2e/transitions.spec.ts` - the E2E spec below.

## Implementation Plan

### Phase 1: Foundation

Preset roles and library, the legacy looks, the transition rules, the contrast helper and the
format's second transition shape, with old versions parsing and building byte for byte (the three
existing goldens unchanged is the gate for this phase).

### Phase 2: Core Implementation

Derived timing in `resolveTimeline`, the two levels (and the number) in layout and build, the
caption absorption and cut, and the new checks with plain reasons. A new golden fixture proves the
three library transitions.

### Phase 3: Integration

The decide answer schema, `presetSummary`, the prompt and `PROMPT_VERSION`, the committed scripted
answer, the studio's timeline label and test helpers, a new E2E spec, then the docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before editing

- Read `app_docs/edit-model.md`, `app_docs/decide-step.md`, `app_docs/preview.md`,
  `app_docs/export.md` and their Rules sections; every "never" there stays true or is changed in
  the same commit with the reason.
- Read `packages/edit/scripts/golden.ts` to see how goldens are written.

### 2. Style roles in the preset (`packages/edit/src/preset.ts`)

- `PresetFont` keeps `family`, `file`, `weight`; drop `size`.
- Add `interface TextRole { font: FontKey; color: string; size: number }` and
  `interface Preset["roles"] = { accentText: TextRole; captionText: TextRole; background: { color: string } }`.
- Values: `accentText` `{ font: "primary", color: "#B3E6FF", size: 110 }`, `captionText`
  `{ font: "secondary", color: "#FFFFFF", size: 50 }`, `background` `{ color: "#121212" }` (the
  panel's solid today).
- Remove `font` and `color` from `preset.caption` and `preset.accent`; keep their other values.
- Add `fontSize(preset, font)`: the size of the first role (accent, then caption) using that font.
  It replaces every `preset.fonts[font].size` (layout's default size), so an item that sets
  `font` and no `size` keeps today's size and the goldens do not move.
- `behind.word` keeps its own `font`, `color` and `maxSize` (a behind item, not a transition).
- Update every reader: `layout.ts` (`textItem` defaults: caption kind from `roles.captionText`,
  accent kind from `roles.accentText`), `baseline.ts`, `glossary.ts`, `apps/worker/src/decide/input.ts`.
- `preset.test.ts`: the roles exist, no role colour is missing, `fontSize` maps `primary` to 110
  and `secondary` to 50.

### 3. Library, legacy looks and rules in the preset

- `TRANSITION_TYPES = ["dim", "panel", "numbered"]` (what `decide` may choose) and
  `LEGACY_TRANSITION_TYPES = ["dim", "panel", "card"]` (what a stored timed transition may name).
- `interface LibraryTransition { layer: Box; background: { role: "background"; strength: number };
motion: "fade" | "slide"; seconds: number; ease: string; text: Box; description: string;
numberScale?: number }`. No font, no colour. Values (starting values, the owner tunes by eye):
  - `dim`: layer the frame, strength 0.62, fade, 0.3 s, `power2.out`, text
    `{ left: 130, right: 840, top: 700, bottom: 1164 }`, description "the key thought of the
    reel, with its lead-in".
  - `panel`: layer `{ left: 0, right: 1080, top: 914, bottom: 1920 }`, strength 1, slide, 0.5 s,
    `power3.inOut`, text `{ left: 130, right: 840, top: 964, bottom: 1164 }` (already inside the
    zone since #114), description "a short statement that should stand alone".
  - `numbered`: layer the frame, strength 0.4 (a light dim), fade, 0.3 s, `power2.out`, text
    `{ left: 130, right: 840, top: 560, bottom: 1164 }`, `numberScale` 1.6, description "one
    point of a list; points named in a row are numbered 1, 2, 3 even when not counted aloud".
- `legacyTransitions: Record<LegacyTransitionType, PresetTransition>`: today's `dim`, `panel` and
  `card` values copied exactly (literal backgrounds included), with a comment that it is the
  frozen look of stored timed transitions, never offered to `decide`, never extended.
- `transitionRules`: `{ maxHoldSeconds: 1, minSeconds: 1.5, densitySeconds: 7,
motionRange: { min: 0.2, max: 1.5 }, holdRange: { min: 0, max: 2 }, shrinkFloor: 0.6 }`.
- Export `backgroundCss(color, strength)`: `#RRGGBB` at strength 1, else
  `rgba(r, g, b, strength)`.
- `preset.test.ts`: every library entry's text area is inside `intersectBox(safe, PLATFORM_SAFE)`
  (replaces the current text-area test), the panel layer top is at or above its text top, every
  entry has a non-empty description, no library entry has a `font` or `color` key, and
  `legacyTransitions` equals today's literal values (the guard that old versions keep their look).

### 4. Contrast helper (`packages/edit/src/contrast.ts`)

- `contrastRatio(a, b)` for two `#RRGGBB` colours: WCAG 2 relative luminance, `(L1 + 0.05) /
(L2 + 0.05)`, lighter over darker. `MIN_LARGE_TEXT_CONTRAST = 3`.
- `contrast.test.ts`: white on black is 21, a colour on itself is 1, `#B3E6FF` on `#121212` is at
  least 3, `#FFFFFF` on `#F0F0F0` is under 3.

### 5. The phrase transition in the format (`packages/edit/src/schema.ts`)

- In `tracksSchemaFor` build two shapes:
  - `timedTransition`: today's object with `type: z.enum(LEGACY_TRANSITION_TYPES)`, `start`,
    `end`, `color?`, `style?`.
  - `phraseTransition`: `{ id, type: z.enum(TRANSITION_TYPES), from: wordId, to: wordId,
key_from: wordId.optional(), number: z.number().int().min(1).max(9).optional(),
motion_seconds: z.number().min(range.min).max(range.max).optional(),
hold_seconds: z.number().min(hold.min).max(hold.max).optional(), style? }`.
  - `transitions: z.array(z.union([phraseTransition, timedTransition]))` in the stored schema.
    Export `phraseTransitionSchemaFor(preset, transcript)` for the decide schema. Both convert to
    JSON Schema (`anyOf`).
- Types: `PhraseTransitionItem`, `TimedTransitionItem`, `TransitionItem` (the union) and
  `isPhraseTransition(item)` (`"from" in item`).
- `refineEdit`: its item loop resolves `start`/`end` only for items that have them (a phrase
  transition has none). Add `refinePhrases` (also run by the decide answer): `to` not before
  `from` in transcript order; `key_from`, when set, inside `from..to`; `number` set exactly when
  `type` is `numbered`, with reasons such as `transition t1: numbered needs its number` and
  `transition t1: key_from w12 is outside the phrase w20 to w25`.
- `schema.test.ts`: a phrase transition parses; the hand fixture's timed panel still parses; a
  stored timed `card` parses; a phrase `card` is refused; `key_from` outside the phrase, `to`
  before `from`, `numbered` without `number` and `dim` with `number` are refused with readable
  reasons; `motion_seconds` outside its range is refused.

### 6. Derived times (`packages/edit/src/timeline.ts`)

- `resolveTimeline(edit, transcript, preset = ISSEBYA_PRESET)` (optional third parameter so the
  studio and the tool tests compile unchanged; the builder passes its preset).
- `phraseSpan(item, words, duration, preset)`: `motion = item.motion_seconds ?? entry.seconds`;
  `start = first.start - motion`; `hold = item.hold_seconds ?? rules.maxHoldSeconds`;
  `end = min(next ? next.start : Infinity, last.end + hold, duration)` and never before
  `last.end` unless the reel ends first. Clamp to the reel as today (`clamped` set, so
  `out-of-reel` reports a phrase starting too early for its entrance).
- `phraseWords(item, transcript)`: `{ lead: Word[]; key: Word[] }` (lead empty when `key_from` is
  unset or equals `from`).
- `timeline.test.ts`: the lead equals the motion (dim 0.3, panel 0.5, a `motion_seconds` 0.8 gives
  0.8); the end is the next word's start when the pause is under 1 s; the end is last word end
  plus 1 s when the pause is longer; `hold_seconds` 0 ends on the last word; a phrase ending on
  the last word ends at the reel's end; a phrase whose first word is under its motion from 0 is
  clamped; a re-timed transcript moves the span with its words.

### 7. Two levels in the layout (`packages/edit/src/layout.ts`)

- `TextBox` gains `kind: "caption" | "accent" | "number"` and an optional `transitionId`.
- For each phrase transition (span from `resolveTimeline`):
  - Captions whose first word is in the phrase are absorbed (not placed elsewhere, not emitted as
    their own boxes).
  - Level text: walk the phrase's words; a word covered by an absorbed caption takes that
    caption's `text` once (so a fixed word stays fixed), a word no caption carries takes
    `wordsText([id])`. Lead words form the lead level, key words the key level.
  - Blocks, top to bottom in the entry's text area: the number (`numbered` only, accent role,
    size `accentText.size * numberScale`, its text `String(number)`), the lead (caption role),
    the key phrase (accent role), separated by `caption.lineGap`. Each block wraps centred at the
    area's width; if the stack is taller than the area, every size scales down together in steps
    of 5% to `shrinkFloor`; the stack is vertically centred in the area. What still does not fit
    is laid out anyway (the safe-box and `transition-fit` checks report it).
  - Box times: the number and the lead start at the transition's start plus the motion (the
    first word's start), the key at `key_from`'s start (the phrase's first word when unset); all
    end at the transition's end.
- Timed (legacy) transitions keep today's behaviour exactly (captions starting inside move into
  the legacy text area as before).
- A caption placed in its usual place whose span crosses a phrase transition's start ends at that
  start (its box `end` is cut), so it never shows under the layer.
- `layout.test.ts`: the absorbed captions produce no boxes of their own; the lead box is
  caption-role font and colour, the key box accent-role; a fixed caption text appears in the
  level; the reveal times; the numbered number box; a long key phrase in the panel shrinks and
  stays inside the area.

### 8. The builder (`packages/edit/src/build.ts`)

- Pass `preset` to `resolveTimeline`.
- Transition loop: a timed item uses `preset.legacyTransitions[type]` and today's code path
  unchanged (byte for byte). A phrase item uses `preset.transitions[type]`, background
  `backgroundCss(preset.roles.background.color, entry.background.strength)`, and
  `motion = item.motion_seconds ?? entry.seconds` for both the entrance (`start`) and the exit
  (`end - motion`).
- Text: emit the transition's level boxes inside `#text` like other boxes (class `text f-<font>`,
  ids `<transitionId>-number`, `-lead`, `-key`). Entrance tween as captions (rise and
  `caption.inSeconds`) at the box start; exit tween `opacity: 0` with the layer's exit (same
  start, same duration), not the caption fade.
- `build.test.ts`: old fixtures' goldens unchanged; a phrase dim's layer `data-start` equals the
  first word's start minus 0.3 and its background is `rgba(18, 18, 18, 0.62)`; `motion_seconds`
  0.8 moves `data-start` and both tweens; a stored timed `card` builds with today's literal
  background.

### 9. Checks (`packages/edit/src/checks.ts`)

Add the rules to `CheckRule`; each only looks at phrase transitions (timed ones keep today's
checks only, so stored versions report what they reported before):

- `transition-length`: span under `minSeconds` (`transition t1 lasts 1.20 s, at least 1.5 s:
cover more words or pick a longer phrase`).
- `transition-density`: more than `max(1, ceil(duration / densitySeconds))` transitions (`3
transitions in a 14.0 s reel, at most 2 (one per 7 s): drop one`).
- `transition-behind`: a transition's span overlaps a `behind` item's (`transition t1 overlaps
behind photo-1; a transition and a behind item never show together`).
- `transition-overlap`: two transitions overlap.
- `transition-area`: the entry's text area is outside `intersectBox(preset.safe, PLATFORM_SAFE)`.
- `transition-fit`: a level box ends outside the text area after shrinking (`the key phrase of
t1 does not fit the panel's text area: pick fewer words or use dim`).
- `transition-accent`: an accent overlay (not `title`) whose `words` are inside a phrase (`accent
a1 is on a word of transition t1, which already sets its key phrase in accent text`).
- `contrast`: for each used entry, `captionText.color` and `accentText.color` against
  `roles.background.color` under 3:1 (`accent text #E0E0E0 on background #F0F0F0 has contrast
1.1, under 3`). The check measures against the background colour itself (it guards the
  style's colour pairing, not the footage).
- The `time-in-speech` and `out-of-reel` loops skip anchors a phrase transition does not have;
  `out-of-reel` still uses `resolved.clamped` for it.
- `checks.test.ts`: one test per rule that fails without it (a 1.2 s phrase; three transitions in
  a short reel; a transition over a behind photo; two overlapping; a preset whose text area runs
  to y 1300; a preset with `background` `#F0F0F0` and accent `#E0E0E0`; an accent inside a
  phrase), and the hand fixture still reports none.

### 10. Golden fixture with the three library transitions

- `rethink-work-transitions.edit.json`: the hand version with its timed `t-fund-life` replaced by:
  - `t-want` `dim`, `from: "w145"`, `key_from: "w158"`, `to: "w161"` ("maybe because we never
    stepped far away from our routine to actually hear" / "what we really want").
  - `t-fund-life` `panel`, `from: "w126"`, `to: "w133"`, no `key_from` (key phrase only, "work
    should fund life, not take it over").
  - `t-live` `numbered`, `number: 3`, `from: "w91"`, `key_from: "w96"`, `to: "w99"` ("they
    don't live to work" / "they work to live").
- Add it to `FIXTURES`, `GOLDENS` and the golden script; run
  `yarn workspace @edit-issebya/edit golden`; check `git diff` shows the three old goldens
  unchanged and only the new files added; read the new HTML for the expected `data-start`
  values (42.23, 35.34, 23.79) and the level spans.
- The browser test (`build.browser.test.ts`) runs every fixture, so it covers the new one.
- `build.test.ts`: build the new fixture, assert zero checks.

### 11. Decide answer schema (`packages/edit/src/decide.ts`)

- `decideAnswerSchemaFor`: `tracks` = `tracksSchemaFor(...).omit({ cutout: true }).extend({
transitions: z.array(phraseTransitionSchemaFor(preset, transcript)) })`, so the JSON Schema
  offers `dim`, `panel` and `numbered`, word-id enums for `from`, `to`, `key_from`, and the
  bounded `motion_seconds` and `hold_seconds`; the refinement runs `refinePhrases`.
- `editFromAnswer` unchanged otherwise (the stored schema accepts phrase transitions).
- `decide.test.ts`: the JSON Schema lists exactly the three types, `from`/`to`/`key_from` as the
  reel's word ids, `motion_seconds` with min and max, and has no `start`/`end` on a transition; a
  timed transition or a `card` in an answer is refused.

### 12. Decide input and prompt (`apps/worker/src/decide/`)

- `input.ts` `presetSummary`: `roles` (font family, colour, size per text role; background
  colour), `transitions` as the library (`type`, `description`, `text_region`, `motion`,
  `motion_seconds` default and range, `background_strength`), `transition_rules` (min length,
  default and max hold, one per 7 s). Drop the per-font `size`.
- `prompt.md`, step 3 rewritten:
  - A transition carries a phrase: pick its words, never times (`from`, `to`, and `key_from`
    where the key phrase starts; leave `key_from` out for a key phrase only).
  - The builder starts it before the first word and ends it when the next word starts (at most
    the hold after the last word); a phrase must give at least 1.5 s with that lead and hold.
  - The lead-in is shown in caption text and the key phrase in accent text, inside the
    transition; do not put an accent on a word inside a phrase.
  - About one transition per 7 s; the same type may repeat; never during a behind item or
    another transition.
  - Pick the type from the library's descriptions; `numbered` for each point of a list Claude
    finds, numbered 1, 2, 3 in order even when not counted aloud.
- A new rule for requests: "longer" or "cover more" changes the phrase; "slower" or "smoother"
  raises `motion_seconds`; "stay longer" raises `hold_seconds`; within their ranges. The
  `change_summary` says which was changed, and that a speed or hold change applies to this reel
  only.
- `prompt.ts`: `PROMPT_VERSION = "decide-4"`.
- `prompt.test.ts`, `input.test.ts`: the prompt names the three types and the wording rule; the
  summary carries the descriptions, roles and rules and no `card`.

### 13. Committed scripted answer and worker tests

- `apps/worker/src/decide/testdata/short-speech-answer.json`: `dim-clip` becomes
  `{ "id": "dim-clip", "type": "dim", "from": "w0006", "key_from": "w0009", "to": "w0010" }`
  ("clip for the" / "real Studio"; span 0.99 to 2.69 s, 1.70 s, inside the 2.69 s clip; the
  accent on `test` (w0005) is outside the phrase). Keep its title, accent and fixed word.
- `run-decide.test.ts`: the step line test still reads `1 transition`; update the dim region
  comment (line 634) and any fixture coordinates that relied on the old dim text area; add a test
  that a first answer with a 1.2 s phrase is refused with the `transition-length` reason and a
  retry with a longer phrase passes.

### 14. Studio

- `tracks-timeline.ts`: a `numbered` transition's label is `numbered <n>`; `tracks-timeline.test.ts`
  covers it.
- `apps/studio/test-support/ai-script.ts`:
  - `roundEnvelope` sets `tracks.transitions = []` when it adds behind items (a transition and a
    behind item never overlap, and the fixture clip's behind items cover the whole clip).
  - Add `slowerTransitionsAnswerScript(dir)`: the committed answer with `motion_seconds: 0.6` on
    `dim-clip` and `change_summary` "made the transitions slower (0.6 s motion), for this reel
    only".
- Confirm `upload.spec.ts`, `behind.spec.ts`, `decide-behind.spec.ts` and `preview.spec.ts` need
  no other change (the preview spec's version 2 is the unchanged answer, no transitions).

### 15. E2E spec (`apps/studio/e2e/transitions.spec.ts`)

Modelled on `change-requests.spec.ts` (serial, one page, CDN routed through
`routePreviewCdn`, the worker's `once` with `E2E_MOCK_AI_SCRIPT`). 1440x900 (the project's
default viewport).

- Seed a processed reel with `aiScript: SHORT_SPEECH_ANSWER` (the committed answer).
- Read version 2's `edit.json` from storage: its one transition has `from`, `to`, `key_from` and
  no `start`/`end`.
- Open the reel page; in the preview frame (`hyperframes-player iframe`) the `#dim-clip` layer's
  `data-start` is `0.990` (w0006's start minus 0.3) and its end (`data-start` plus
  `data-duration`) is `2.690`; `#dim-clip-lead` has text "clip for the" and `#dim-clip-key` "real
  Studio"; no caption span for w0006 to w0010 exists outside them.
- Send "make the transitions slower" with `slowerTransitionsAnswerScript`, run `once`: version 3
  becomes current without a reload, its `#dim-clip` `data-start` is `0.690`, and its version item
  shows "made the transitions slower (0.6 s motion), for this reel only".
- The spec fails without the feature: version 2 would carry `start`/`end` and no lead or key
  spans.

### 16. Docs

- `app_docs/edit-model.md`: the phrase transition shape and the timed one kept for stored
  versions; roles; the library with descriptions; legacy looks; transition rules; derived timing;
  the two levels and the absorbed captions; the new checks. Rules: "never name a font or colour in
  a library transition", "never change `legacyTransitions`", "never store times on a phrase
  transition". Link this spec.
- `app_docs/decide-step.md`: the answer schema's transitions, the prompt's phrase and wording
  rules, `decide-4`, the committed answer's phrase transition, `roundEnvelope` dropping
  transitions beside behind items. Link this spec.
- `app_docs/preview.md` and `app_docs/export.md`: one line each that transition times are derived
  by the shared build, so preview and export agree; the guardrail compares them unchanged.
- `docs/conditional-docs.md`: extend the `edit-model.md` line with "transitions (phrase, roles,
  library)" and the `decide-step.md` line with "the transition wording rule".
- No em-dashes anywhere.

### 17. Validation

Run every command in `Validation Commands`, fix what fails, and confirm the three old goldens are
unchanged in `git diff --stat`.

## Testing Strategy

### Unit Tests

- `preset.test.ts`: roles, `fontSize`, library text areas inside the guard, descriptions present,
  no font or colour in an entry, legacy looks frozen.
- `contrast.test.ts`: ratios.
- `schema.test.ts`: both shapes parse; old timed and `card` parse; phrase errors refused.
- `timeline.test.ts`: lead equals motion, hold to the next word or 1 s, reel end, clamp,
  `motion_seconds` and `hold_seconds`, re-time.
- `layout.test.ts`: two levels, roles, reveal times, absorbed and cut captions, number, shrink.
- `checks.test.ts`: each new rule, plus no regression on the hand fixture.
- `build.test.ts` and `build.browser.test.ts`: the new golden; the old goldens byte for byte; a
  legacy `card`.
- `decide.test.ts`: JSON Schema shape, refusal of timed or `card` transitions.
- Worker `prompt.test.ts`, `input.test.ts`, `run-decide.test.ts`: prompt text, summary, a
  `transition-length` refusal and a passing retry.
- Studio `tracks-timeline.test.ts`: the `numbered` label.

### Test Coverage

- Unit (`packages/edit`, Vitest node): `timeline.test.ts` derived spans: catches a transition not
  starting a motion before its first word or not ending at the next word or 1 s hold; nothing
  checks this today because times are free.
- Unit: `checks.test.ts` new rules: catches a phrase under 1.5 s, over-density, overlap with
  `behind` or another transition, a text area outside the safe zone, a low-contrast colour pair
  and an accent inside a phrase; none of these rules exists today.
- Unit: `layout.test.ts` levels: catches the lead-in not in caption text, the key phrase not in
  accent text, wrong reveal times or captions shown twice.
- Unit (node and browser): `rethink-work-transitions` golden: catches any change in the built page
  of `dim`, `panel` and `numbered`; the three unchanged old goldens catch a regression in stored
  timed transitions.
- Unit: `schema.test.ts` and `decide.test.ts`: catch the format or the decide schema accepting
  free times or `card` from Claude, or refusing a stored old version.
- Unit (worker): `run-decide.test.ts` refusal and retry, `prompt.test.ts` wording rule and
  `decide-4`.
- E2E (studio, Playwright chromium): `transitions.spec.ts`: catches a fresh reel's transition not
  sitting on its words in the live preview, and "make the transitions slower" not lengthening the
  motion or the summary not saying so.

### Edge Cases

- The phrase's first word starts less than the motion after 0: clamped, `out-of-reel` refuses it.
- The phrase ends on the last word: the transition ends at the reel's end.
- The pause after the last word is longer than the hold: ends at last word end plus the hold.
- The pause is shorter than the exit motion: the exit starts before the last word ends (allowed,
  the motion still finishes as the next word starts).
- `key_from` unset or equal to `from`: key phrase only, no lead box.
- `key_from` equal to `to`: a one-word key phrase.
- A caption with a fixed `text` inside the phrase: the fix shows in the level.
- A multi-word caption unit (glossary term, number with unit) inside the phrase: its text once.
- A caption group that started before the transition: cut at the transition start.
- A key phrase too long for the panel: shrinks to the floor, then `transition-fit` refuses.
- A reel shorter than 7 s: at most one transition.
- A stored version with a timed `card`, a timed `dim` with `color`: builds with today's bytes.
- A `numbered` without `number`, a `dim` with one: refused.
- A preset with low contrast colours: `contrast` fails for every used transition.

## Acceptance Criteria

- A phrase transition stores words, never times; its span is derived at every build: start = first
  word's start minus the motion seconds, end = the next word's start capped at last word end plus
  the hold (1 s default) and at the reel's end.
- A phrase transition under 1.5 s, more than one per 7 s (at least one allowed), overlapping a
  `behind` item or another transition, with a text area outside the platform safe zone, with
  levels that do not fit, with an accent inside its phrase, or with text under 3:1 contrast
  against the background role, fails a check with a plain reason, and the decide retry receives
  it.
- Inside a phrase transition the lead-in is in the caption text role and the key phrase in the
  accent text role, each appearing whole on its first word and leaving with the transition; the
  phrase's captions are not shown elsewhere; `numbered` shows its number in accent text above.
- The library is `dim`, `panel`, `numbered`, each with a description; no library entry names a
  font or colour; `decide` cannot choose `card` or give times.
- `rethink-work-hand`, `rethink-work-behind` and `baseline-short-speech` goldens are byte for byte
  unchanged; the new `rethink-work-transitions` golden passes in Node and in the browser.
- `PROMPT_VERSION` is `decide-4`; the prompt carries the phrase rule, the levels, the density and
  the wording rule; a scripted "make the transitions slower" answer gives a longer motion and a
  summary that says so (E2E).
- Lint, typecheck, knip, format, unit, build, `test:db` and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - Prettier over the repository.
- `yarn turbo run lint --filter=...{./packages/edit}` - lint the edit package and its dependents
  (studio, worker).
- `yarn turbo run typecheck --filter=...{./packages/edit}` - types across the package, studio and
  worker (the `resolveTimeline` and preset changes reach all three).
- `yarn knip` - no unused export left by the new helpers or the removed `card` path.
- `yarn turbo run test --filter=...{./packages/edit}` - unit tests: edit (node and browser
  goldens), studio, worker.
- `yarn turbo run build --filter=./packages/edit --filter=./apps/studio --filter=./apps/worker` -
  the studio's `next build` with the changed package (the package and worker build check is
  typecheck).
- `yarn turbo run test:db --filter=./apps/studio` - no schema change, but the studio target runs it
  in the test phase.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - run by the test phase with the
  `/prepare_app` server up; includes the new `apps/studio/e2e/transitions.spec.ts` and the specs
  using the committed answer.

## Notes

- No new dependency.
- No migration and no database change: transitions live in `edit.json`.
- `git log` shows #114 (platform safe zone) merged on the base branch, so the dim and panel text
  areas here sit inside `intersectBox(STYLE_SAFE, PLATFORM_SAFE)` (bottom 1164, right 840).
- **Contrast against the background colour alone.** The check guards the style's colour pairing
  (a later colour wheel), not the footage under a partial dim; with today's roles the accent
  `#B3E6FF` and caption `#FFFFFF` on `#121212` both pass. If the owner wants the dim strength
  counted, a later issue can composite over a reference frame colour.
- **Background colour change for new dims.** New phrase `dim` and `numbered` layers use the
  `background` role (`#121212`) at their strength instead of pure black; old stored versions keep
  black through `legacyTransitions`. The owner checks the look by eye on the acceptance reel.
- **Panel motion.** The reference describes the video moving up into a smaller box; today's panel
  slides a solid layer up over the lower part. This plan keeps the slide (moving or scaling the
  footage is a builder change of its own); the owner judges it by eye at acceptance and can open
  a follow-up.
- Starting values (text areas, strengths, `numberScale` 1.6, ranges 0.2 to 1.5 s motion and 0 to
  2 s hold, shrink floor 0.6) are taste values for the owner to tune.
- Out of scope, as the issue says: remembering speed or hold across reels (no defaults store yet;
  the summary says "for this reel only"), #111's caption and partial answer work (whichever lands
  second rebases), font pairs and a colour wheel.
- The owner-only tool tests (`yarn workspace @edit-issebya/studio test:tools`,
  `yarn workspace @edit-issebya/worker test:tools`) are not run in a run; they only need to
  compile with the optional `preset` parameter.
- Owner acceptance after merge: one real reel in development, judged by eye against the three
  reference frames.
