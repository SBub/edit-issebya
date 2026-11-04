# Feature: Transitions tied to a phrase Claude picks, two text levels, numbered, no card

## Metadata

issue_number: `157`
adw_id: `3c1a1736`
issue_json: `{"number":157,"title":"engine: transitions tied to a phrase Claude picks, two text levels, numbered, no card (replaces #112)"}`

## Feature Description

Transitions today are a layer (`dim`, `panel`, `card`) anchored from the first word of a phrase to
the end of its last word, with the captions spoken under it set as one block in a fixed text area
written for an old safe zone. They start and end apart from the words they carry and feel like
glitches.

This feature rebuilds transitions on the layout engine (`placeEdit`, `packages/edit/src/engine.ts`)
with the owner's decisions from #112 (2026-11-03):

- Claude picks the phrase by word ids and marks where its key phrase starts:
  `{ kind, from, to, key_from }`. Nothing else: never a time, a position or a size.
- The engine computes the timing from the words: the entrance finishes as the phrase's first word
  starts; the layer has left when the word after the phrase starts, holding at most about 1 s after
  the phrase's last word; never shorter than 1.5 s.
- Inside the layer, two text levels: the lead-in (the words before `key_from`) in caption text and
  the key phrase (from `key_from` to `to`) in accent text. Each appears whole on its first word and
  stays until the transition leaves. Those captions show only there, never also in their usual
  place. The engine places both levels in free space inside the layer and the safe zone, off the
  face where possible, and records every move like other items.
- A new kind `numbered`: a large number in accent text over a light dim, lead-in and key phrase
  below, for any list Claude finds. `card` is removed from the library (old stored versions keep
  rendering it).
- Each kind carries a short description Claude reads. Text and backgrounds come from style roles
  (accent text, caption text, background), never a literal font or colour in the transition entry.
- About one transition per 7 s of reel; the same kind may repeat.
- A running transition replaces the extras: no accent, photo or big word shows during one.
- Corrections: "longer" or "cover more" changes the phrase; "slower", "smoother" or "stay longer"
  changes the motion speed or the hold (two new wishes, `slow` and `long`); the summary says which.

## User Story

As the reel owner
I want transitions that arrive with the phrase they carry, show that phrase inside them in two
clear levels, and leave when the speaker moves on
So that transitions read as deliberate edits instead of glitches, and I can ask for them longer or
slower in plain words

## Problem Statement

A transition's span is its words' span, so the layer fades in after the first word has started
and fades out before the last word ends; it can be as short as a few tenths of a second. Captions
inside it are packed into a fixed text area (`preset.transitions[kind].text`) from the old safe
zone, a block of 20 lines at most, with no distinction between the lead-in and the point being
made, and they may sit on the face. Accents, photos and the big word can show on top of a running
transition. `card` duplicates `dim`. The prompt shows Claude bare kind names with no description,
and a request for a slower or longer transition has no way to be expressed.

## Solution Statement

Keep the meaning/geometry split of the layout engine (`app_docs/edit-model.md`, "Layout engine"):

1. Answer and engine input: `TransitionChoice` becomes `{ kind, from, to, key_from, wish? }`, kinds
   from the new library list `TRANSITION_KINDS = ["dim", "panel", "numbered"]`. The decide schema
   refuses `card`, a `key_from` outside `from..to`, and (as before) a range ending before it starts.
   Wishes gain `slow` and `long`.
2. Edit format (`schema.ts`): a transition item gains optional engine-written fields: `words` (the
   phrase's word ids), `key` (the key phrase's first word id), `pace: "slow"`, `hold: "long"`,
   `number` (for `numbered`) and `levels` (the placed text: `number`, `lead`, `key`, each
   `{ text, position, size, break_after?, start }`). `TRANSITION_TYPES` (the stored format) keeps
   `card` so stored versions keep parsing and rendering; the library and the decide enum do not.
3. Preset (`preset.ts`): a `background` style role (`#121212`). Each transition entry has no colour
   or font: `shade` (the background role's opacity), `layer`, `motion`, `seconds`, `ease`, `area`
   (where its levels may go, inside the layer and the safe zone), `want` (the wanted top of the
   level stack), and `description` (the line Claude reads; library kinds only). `numbered` adds
   `numberSize`. Levels take their font, size and colour from `preset.caption` (lead) and
   `preset.accent` (number, key). New preset values under `transition`: `minSeconds` 1.5,
   `holdSeconds` 1, `longHoldSeconds` 2, `slowFactor` 1.6, `perSeconds` 7. The legacy `card` entry
   and every entry's legacy `text` box stay for versions saved before (the builder's old path in
   `layout.ts`).
4. Engine: transitions are timed first (edges, hold, minimum, rate, no overlap), then their levels
   are placed before the captions (a transition takes the screen over), then the captions outside
   every transition, then the extras; a running transition is an accepted span the one-extra rule
   never trims. Captions whose first word is in a kept transition's `words` are hidden (no position,
   shown only through the levels). Every retime, move, shrink, wrap, covered face and drop is an
   `EngineNote`.
5. Builder (`build.ts`): a transition with `levels` renders them as children of its layer (so they
   fade or slide with it), each revealed on its own word with the caption rise; the background is the
   role colour at the entry's opacity; the captions it hides are not rendered. A transition without
   `levels` (a stored version) renders exactly as before.
6. Checks: `safe-box` and `text-overlap` include levels; `face`, `timing` and `text-overlap` skip
   hidden captions.
7. Read-back (`choicesOf`): a transition with `words` reads back as its phrase, `key_from` its `key`
   and `wish` from `pace`/`hold`; an older one by its anchors with `key_from = from`; a stored
   `card` reads back as `dim`.
8. Prompt (`decide-9`): the kinds with their descriptions (from the preset), `key_from`, about one
   per 7 s, `numbered` for list items, and the correction mapping of decision 7. Version diff and
   summary template name what changed: the phrase, or the motion speed or hold.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: conventions (Yarn only, no em-dashes, Conventional
  Commits, no trailers, profile Tests and Protected rules).
- `docs/conditional-docs.md`: index; the lines for `app_docs/edit-model.md`, `app_docs/decide-step.md`
  and `app_docs/preview.md` match this work.
- `app_docs/edit-model.md`: format, preset values, builder contract, layout engine, checks, golden
  rules ("Never place a stored version again", "Never drop a caption", "Never show more than one
  extra at a time"). Updated by this change.
- `app_docs/decide-step.md`: answer shape (`decide-8`), schema, prompt, wishes, checklist, summary,
  testing notes ("After a change to the preset or the layout, re-derive these from the new values").
  Updated by this change.
- `app_docs/preview.md`: the live preview and `export-matches-preview`; read for the e2e seek helpers.
- `app_docs/change-requests.md`: the versions list shows the summary written from the diff.
- `packages/edit/src/preset.ts`: `TransitionType`, `TRANSITION_TYPES`, `PresetTransition`,
  `ISSEBYA_PRESET.transitions`; add roles, `TRANSITION_KINDS`, descriptions, `numbered`, timing values.
- `packages/edit/src/schema.ts`: the transition item (lines ~132-137); add the optional engine fields
  and their refinements (`key` in `words`, levels inside `bounds`).
- `packages/edit/src/engine-input.ts`: `WISHES`, `TransitionChoice`, `choicesOf`.
- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor` (transition object, `key_from` refinement,
  kinds), `decideCounts`, `editFromAnswer`.
- `packages/edit/src/engine.ts`: `placeOnce` (transition items at ~804-820, caption blocks of kind
  `transition` at ~1161-1190 and ~1261-1271, readability skip at ~1501, `fitTime` at ~1981,
  `tryExtra` at ~1561, the `WHY` map at ~2059, the pass's `transitions` at ~2188, `anchorAt` at ~166),
  `Room.removed` for make-room.
- `packages/edit/src/engine-space.ts`: free rectangles and `placeBox`, reused for the level stack.
- `packages/edit/src/head-track.ts`: `facesOver` (robust faces).
- `packages/edit/src/build.ts`: transition rendering (~200-235), text rendering (~237 on).
- `packages/edit/src/layout.ts`: the legacy transition text area path (~192-258); hidden captions
  must not reach it.
- `packages/edit/src/checks.ts`: `safe-box`, `text-overlap`, `face`, `timing`.
- `packages/edit/src/timeline.ts`: `resolveTimeline` over every track.
- `packages/edit/src/version-diff.ts`: transition entries (~161) and `changed` details.
- `packages/edit/src/version-summary.ts`: template wording and safeguard (`checkSummary`).
- `packages/edit/src/editorial.ts`: `checklistOutcome` (transitions "always are" done; no longer true).
- `packages/edit/src/index.ts`: exports (`TRANSITION_KINDS`, new types).
- `packages/edit/src/test-support/request.ts`, `test-support/fixtures.ts`: the 2026-11-03 request
  case uses a `card`; switch it to `dim`.
- `packages/edit/src/engine.test.ts`, `decide.test.ts`, `engine-input.test.ts`, `schema.test.ts`,
  `checks.test.ts`, `build.test.ts`, `build.browser.test.ts`, `preset.test.ts`,
  `version-diff.test.ts`, `version-summary.test.ts`, `editorial.test.ts`, `layout.test.ts`.
- `packages/edit/scripts/golden.ts` and `src/testdata/versions/*.edit.json`,
  `src/testdata/golden/*`: engine-placed fixtures and goldens are rewritten by
  `yarn workspace @edit-issebya/edit golden`; hand-made ones keep their goldens.
- `apps/worker/src/decide/prompt.md`, `prompt.ts` (`PROMPT_VERSION`), `prompt.test.ts`.
- `apps/worker/src/decide/input.ts` (`presetSummary`), `input.test.ts`.
- `apps/worker/src/decide/editorial.md`: mention transitions are never offered again (bump covered by
  `PROMPT_VERSION`).
- `apps/worker/src/decide/summary.md` (`SUMMARY_PROMPT_VERSION` if changed),
  `version-summary.ts`, `version-summary.test.ts`.
- `apps/worker/src/decide/testdata/short-speech-answer.json`: the committed answer; add `key_from`.
- `apps/worker/src/decide/run-decide.test.ts`, `apps/worker/src/doctor-checks.ts` and its test (the
  sample answer must still pass `parseDecideAnswer`).
- `apps/studio/test-support/ai-script.ts`: scripted answers; transitions need `key_from`.
- `apps/studio/e2e/upload.spec.ts`: decide line and `decide-8`; re-derive.
- `apps/studio/e2e/change-requests.spec.ts`, `decide-behind.spec.ts`: summary texts naming a
  transition; re-derive.
- `apps/studio/e2e/preview.spec.ts`: extended with a transition's two levels (below).
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: `guardrailEdit` gets an engine-placed
  `numbered` transition with levels.
- `apps/studio/src/lib/tracks-timeline.ts` and test: Transitions row labels by `type`; confirm
  `numbered` shows (no code change expected).

### New Files

- `packages/edit/src/transitions.ts`: pure helpers used by the engine and the builder:
  `transitionTiming(choice, words, duration, preset)` (the edges, hold, minimum, as numbers and
  anchors), `hiddenCaptionIds(edit)` (captions shown only through a transition's levels),
  `levelStyle(role, preset)` (font, size, colour from `preset.caption` or `preset.accent`) and
  `transitionBackground(entry, preset, color?)`.
- `packages/edit/src/transitions.test.ts`: unit tests of those helpers.
- `packages/edit/src/testdata/versions/rethink-work-transitions.edit.json` and
  `src/testdata/golden/rethink-work-transitions.html`, `.widths.json`: one engine-placed fixture
  holding a `dim`, a `panel` and two `numbered` transitions on the `rethink-work` data, written by
  `scripts/golden.ts`.

## Implementation Plan

### Phase 1: Foundation

Preset roles and library, the format fields, the answer and engine input, the read-back. Nothing is
placed differently yet; old fixtures still build byte for byte (except the `dim` background now from
the role, see Notes).

### Phase 2: Core Implementation

The engine's transition timing, rate and overlap rules, the one-extra rule with transitions, the
level placement in free space, hidden captions, the record; the builder rendering levels; the checks.

### Phase 3: Integration

Prompt `decide-9`, preset summary with descriptions, version diff and summary template for phrase
versus motion/hold changes, checklist outcome for dropped transitions, fixtures and goldens, worker
and studio tests and E2E re-derived, the preview spec, the export guardrail, docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/edit-model.md`, `app_docs/decide-step.md`, `app_docs/preview.md` in full and
  `packages/edit/src/engine.ts` around `placeOnce`, `fitTime`, `tryExtra`, `captionCandidates`,
  `placeBlock` and the pass return, so the new code follows the existing patterns (records,
  `SLACK`, `ms`, `at`, `quote`, `anchorAt`, `sizesFrom`, `balancedBreak`, free space via
  `engine-space.ts`).

### 2. Preset: roles, library, timing values

- `preset.ts`:
  - `TransitionType = "dim" | "panel" | "numbered" | "card"`; `TRANSITION_TYPES` (stored format)
    lists all four; new `TRANSITION_KINDS = ["dim", "panel", "numbered"] as const` (the library);
    `TransitionKind` its type. Comment that `card` is kept only so stored versions parse and render.
  - `Preset.background: string` (`"#121212"`), the background style role.
  - `PresetTransition`: drop `background`; add `shade: number` (opacity of the background role),
    `area: Box` (where the levels may go; inside `layer` and `STYLE_SAFE`), `want: number` (the
    wanted top y of the level stack), `description?: string` (library kinds), `numberSize?: number`
    (numbered); keep `layer`, `motion`, `seconds`, `ease` and the legacy `text` box (old versions).
  - `Preset.transition: { minSeconds: 1.5, holdSeconds: 1, longHoldSeconds: 2, slowFactor: 1.6,
perSeconds: 7, gap: 24 }` (`gap`: between stacked levels).
  - Values (starting values the owner tunes by eye):
    - `dim`: full frame, shade 0.62, fade 0.3 s `power2.out`, area the safe box (130, 860, 260,
      1400), want 1180, text 1180 to 1400 (legacy), description "darkens the whole picture: for a
      turn in the story or a strong statement".
    - `panel`: layer y 1150 to 1920, shade 1, slide 0.5 s `power3.inOut`, area 130 to 860, 1170 to
      1400, want 1180, text 1200 to 1400 (legacy), description "a dark panel slides up over the
      lower part: for an aside, a definition or a short explanation".
    - `numbered`: full frame, shade 0.38 (light dim), fade 0.3 s `power2.out`, area the safe box,
      want 640, `numberSize` 300, description "a large number over a light dim with the phrase
      below: for each item of a list the speaker goes through, numbered in order".
    - `card` (legacy, not offered): full frame, shade 0.9, fade 0.25 s, area and text 130 to 860,
      640 to 1400, no description.
- `preset.test.ts`: every library kind has a description and an `area` inside its layer,
  `STYLE_SAFE` and `PLATFORM_SAFE` and left of `PLATFORM_BUTTONS`; no transition entry holds a colour
  or font (no `#`, `rgb`, `font` key); `TRANSITION_KINDS` has no `card`; the `numbered` number at
  `numberSize` fits the area width.

### 3. Format: transition item fields

- `schema.ts` transition object adds, all optional: `words` (array of word ids, min 1), `key` (word
  id), `pace: z.literal("slow")`, `hold: z.literal("long")`, `number` (int 1 to 99), `levels`
  (`{ number?, lead?, key }`, each `{ text (1 to 300 chars, the same escaping rules as captions),
start: anchor, position: { x, y, align }, size, break_after? }`, positions inside `bounds`). A
  refinement refuses a `key` not in `words`, `levels` without `words`, a `number` level on a kind
  other than `numbered`. Old versions without them parse unchanged; `card` still parses.
- `schema.test.ts`: a stored `card` parses; the new fields parse; `key` outside `words` refused.

### 4. Engine input, wishes, read-back

- `engine-input.ts`: add `slow` and `long` to `WISHES` (comment: transitions only; the engine
  records `wish-not-kept` on another kind). `TransitionChoice` gains `key_from: string`, `kind:
TransitionKind`.
- `choicesOf`: a transition with `words` reads back `{ kind, from: words[0], to: words.at(-1),
key_from: key ?? words[0], wish }` (`pace: "slow"` gives `slow`, `hold: "long"` gives `long`;
  both set: `slow`); without `words` by `under()` with `key_from = from`; a stored `card` reads back
  as `dim`.
- `engine-input.test.ts`: read-back of a new transition (phrase, key, wish), of an old one, of a
  card as dim; placing the read-back again gives the same tracks.

### 5. Decide answer schema

- `decide.ts`: transitions `z.strictObject({ kind: z.enum(TRANSITION_KINDS), from, to, key_from:
wordId, wish })`. The refinement adds: `key_from` before `from` or after `to` refused ("key phrase
  starts on wN, outside wA to wB"). Keep `MAX_TRANSITIONS`. `decideJsonSchema` follows (no `card` in
  the enum).
- `decide.test.ts`: `card` refused by the schema and absent from the JSON Schema enum; `key_from`
  outside the phrase refused with its reason; `numbered` accepted; `slow` and `long` refused without
  a request.

### 6. Transition helpers

- New `transitions.ts`:
  - `transitionTiming(choice, words, duration, preset)`: `s` = entry `seconds` (times `slowFactor`
    with `slow`), `hold` = `holdSeconds` (`longHoldSeconds` with `long`). `start = first.start - s`
    (at least 0); `leave = min(next.start ?? duration, last.end + hold)`; the layer has finished
    leaving at `leave` (the exit runs from `leave - s`). Under `minSeconds`: `leave = start +
minSeconds`, clamped to the reel; still under, `start` moves earlier down to 0; still under, it
    is too short (dropped, rule `transition-time`). Returns times, whether it was lengthened, and the
    anchors: start `{ word: from, offset: -s }` (or `{ reel: "start" }` when clamped), end via the
    engine's `anchorAt` logic (move `anchorAt` here or export it from a shared module; keep one copy).
  - `hiddenCaptionIds(edit)`: ids of captions whose first word is in a transition's `words` when it
    has `levels`.
  - `levelStyle(role, preset)`: `lead` gives `preset.caption` font, size, colour; `key` gives
    `preset.accent` font, size, colour; `number` the accent font and colour at `numberSize`.
  - `transitionBackground(entry, preset, color?)`: `color` if the item sets one, else the
    `background` role at `shade` as `rgba(r, g, b, a)` (or the hex when shade is 1).
- `transitions.test.ts`: the entrance finishes as the first word starts; the layer is gone as the
  next word starts; a long pause holds 1 s (2 s with `long`); `slow` motion 1.6 times; a short phrase
  lengthened to 1.5 s; a phrase at the reel start clamped to `{ reel: "start" }`; a reel under 1.5 s
  too short; level styles come from the caption and accent roles; the background from the role.

### 7. Engine: timing, rate, overlap, one-extra

- In `placeOnce`, replace the transition items block (~804-820): for each kept (not `room.removed`)
  choice, compute `transitionTiming`. Order: requested first (`requested` refs), then answer order.
  - Rate: at most `max(1, round(duration / perSeconds))` transitions; the rest dropped (rule
    `transition-rate`, reason `transition 3 (dim) on "..." dropped: about one transition per 7 s, this
reel has room for 2`).
  - Overlap: a transition whose span overlaps one already kept: the earlier one ends at the later's
    start if it still lasts `minSeconds` (action `retimed`, rule `transition-overlap`), else the later
    is dropped (rule `transition-overlap`).
  - Lengthened to the minimum: action `retimed`, rule `transition-min`. Too short: dropped,
    `transition-time`. A `wish` other than `slow` or `long` on a transition, or `slow`/`long` on
    another kind: `wish-not-kept` (rule `wish`).
  - Number `numbered` transitions 1, 2, ... in reel order of the kept ones.
- One extra at a time: push every kept transition into `accepted` as an `Extra` of kind
  `transition` before any extra is tried (add `transition` to `ExtraKind` internally, never to the
  editorial `UnplacedItem` kinds). In `fitTime`, an accepted transition is never trimmed: an extra
  starting during one is dropped (rule `one-extra`, reason `... a transition is running from X s to
Y s`); an extra running into a later transition ends at its start down to its minimum, else is
  dropped. Requested extras keep their make-room ladder: `room.removed` already removes Claude's own
  transitions in their way.
- `placed` (pass refs) includes kept transitions so `checklistOutcome` can tell a dropped one.

### 8. Engine: levels in free space, hidden captions

- After timing, before the caption blocks, place each kept transition's levels:
  - Texts: `lead` = the caption texts of the words `from` to before `key_from` (after word fixes,
    `wordsText`), absent when `key_from == from`; `key` = `key_from` to `to`; `number` = `String(n)`
    for `numbered`.
  - Stack top to bottom: number, lead, key, `transition.gap` apart, centred on one x; each level at
    most two lines (`balancedBreak`), measured with HarfBuzz at its role's size.
  - Area: the entry's `area`; obstacles: the robust faces over the span (`facesDuring`, padded as for
    captions), `PLATFORM_BUTTONS`, text already placed over the span (earlier transitions' levels).
  - Search: `placeBox` nearest `(area centre x, want + h / 2)`, full size first, then each level
    wrapped, then all levels shrunk together step by step to the floor (`minScale`); recorded
    `shrunk`/`wrapped` (rules `transition-size`, `transition-wrap`); not its first place: `moved`
    (rule `transition-spot`). Nothing free at the floor: the faces are ignored and the stack goes
    nearest `want` (action `covers-face`, rule `transition-face`). Should that not fit either (an
    area too small for the floor), the transition is dropped (rule `no-room`) before any caption is
    grouped, so its captions show as usual.
  - Each level's `start`: the number at the layer's start anchor, the lead on `{ word: from }`, the
    key on `{ word: key_from }`. All end with the layer.
  - Write `words`, `key`, `pace`, `hold`, `number`, `levels` on the item.
- Captions: a unit whose caption's first word is in a kept transition's `words` is hidden: it joins
  no block, gets no `position`/`size`/`shadow`, and `outCaptions` writes it without them (remove the
  `kind: "transition"` caption block and its candidate; keep `CaptionBlock.kind` only if still
  needed). Captions outside (for example after the phrase during a lengthened tail) are placed as
  usual, avoiding the levels (they are placed text).
- Remove the transition branch in `captionCandidates` and the readability comment about captions
  inside a transition; levels are not contrast-measured (they sit on the layer).
- `free()` probes and `probe` restore state as before; transitions' levels count as placed text in
  probes.
- Make-room: a requested transition goes first in the transition order; a requested extra may still
  remove a transition Claude added on its own (unchanged rule); never a requested transition.

### 9. Builder and layout

- `build.ts`: compute `hiddenCaptionIds(edit)`; filter those captions out before `layoutText` and
  rendering. For a transition with `levels`: the layer's background from `transitionBackground`; each
  level a child `<div>` of the layer, positioned relative to the layer (`x - layer.left`, `y -
layer.top`), font, size, colour from `levelStyle`, two lines rendered `first<br />second` centred,
  `opacity: 0` and revealed with the caption's rise (`preset.caption` rise and ease) at its start;
  timings to the millisecond via `resolveTimeline`. For a transition with `pace: "slow"` the motion
  is `seconds * slowFactor`. A transition without `levels` renders exactly as before (background
  from the role, see Notes).
- `layout.ts`: unchanged for stored versions; it never sees hidden captions.
- `timeline.ts`: resolve level start anchors (or resolve them in the builder through
  `resolveAnchor`); keep determinism.

### 10. Checks

- `checks.ts`: `safe-box` and `text-overlap` include every level box (measured like captions; the
  number in the accent font); `face`, `timing` and the caption part of `text-overlap` skip
  `hiddenCaptionIds`. Levels are not in the `face` check (the engine records `covers-face` when it
  must), keep `runChecks` order stable.
- `checks.test.ts`: a level past the safe box fails `safe-box`; a caption over a level fails
  `text-overlap`; hidden captions trip no `timing` check.

### 11. Engine unit tests (`engine.test.ts`)

Add a `describe("transitions")` block on the `rethink-work` data and synthetic transcripts:

- edges: the item's resolved start is the first word's start minus the motion; it has left when the
  next word starts; a phrase followed by a 3 s pause holds 1 s (`long`: 2 s); `slow` stretches the
  motion.
- the 1.5 s minimum: a two-word phrase is lengthened, recorded `retimed` (`transition-min`).
- two text levels: lead in caption font, size and colour, key in accent; both inside the entry's
  area, the safe zone, left of `PLATFORM_BUTTONS`; off the robust face at every moment; with a face
  filling the area, `covers-face` recorded; the phrase's captions have no position and the builder
  shows them nowhere else; captions after the phrase avoid the levels; `runChecks` passes.
- each level starts on its first word (lead on `from`, key on `key_from`) and ends with the layer.
- rate: eight transitions on the 47 s reel keep `round(47 / 7) = 7`, the eighth dropped
  `transition-rate`; the same kind twice is kept.
- overlap: two overlapping transitions: earlier retimed or later dropped.
- one extra: an accent inside a transition is dropped (`one-extra`); an accent before one ends at its
  start.
- `numbered`: three list items numbered 1, 2, 3 in reel order with the number level above lead and
  key.
- no `card`: `TRANSITION_KINDS` excludes it; the old "keeps card captions off the face" test becomes
  the `dim` case of the levels-off-face test.
- determinism and placing the engine's output again (via `choicesOf`) give the same tracks.
- Update `test-support/request.ts` and the make-room tests (lines ~617-765) to a `dim` Claude added
  on its own; re-derive reasons (`transition 1 (dim) removed: ...`).

### 12. Version diff, summary, checklist outcome

- `version-diff.ts`: a transition entry compares `words` (phrase changed: `retimed` with the new
  words, "now covers ..."), `pace` and `hold` (`changed`: `slower` / `holds longer`), kind
  (`changed`). Old transitions without `words` compare as before.
- `version-summary.ts` template: "The transition on \"...\" now covers \"...\"" for a phrase change,
  "The transition on \"...\" moves slower" or "stays longer" for pace or hold; safeguard unchanged
  (no internal names: never `pace`, `hold`, `levels`). Add these to `version-summary.test.ts` and
  `version-diff.test.ts`.
- `apps/worker/src/decide/summary.md`: one line saying a transition change is either its phrase or
  its speed or hold, and to say which; bump `SUMMARY_PROMPT_VERSION` to `summary-2`.
- `editorial.ts` `checklistOutcome`: a linked transition is done only when it is in the version;
  otherwise its drop reason from the record plus what the owner can do. Update the comment and
  `editorial.test.ts`.

### 13. Prompt and worker

- `apps/worker/src/decide/input.ts` `presetSummary`: `transitions` becomes `[{ kind, description }]`
  for `TRANSITION_KINDS` only, plus `transition_every_seconds: 7`. `input.test.ts` updated (no
  `card`).
- `prompt.md`: transitions section: each `{ "kind", "from", "to", "key_from" }`, the phrase usually a
  short lead-in plus the key phrase, `key_from` the key phrase's first word, kinds as described in
  the style input, about one per 7 s of reel (the same kind may repeat), `numbered` for each item of
  a list, numbered in order; corrections: "longer" or "cover more" changes `from`/`to`; "slower",
  "smoother" give the wish `slow`, "stay longer" the wish `long`. Add `slow` and `long` to the wish
  list. The example answer gains `key_from`. No times, sizes, fonts or colours.
  `editorial.md`: transitions are never in the round (one line). Bump `PROMPT_VERSION` to
  `decide-9`.
- `prompt.test.ts`: the prompt names `key_from`, every library kind with its description, no
  `card`, `decide-9`.
- `decide/testdata/short-speech-answer.json`: the dim gets `"key_from": "w0007"`.
- `run-decide.test.ts`, `doctor-checks.ts`/test: re-derive the step line and counts from the new
  engine (the title may now be cut by the transition); never loosen an assertion.
- `decideCounts`: unchanged shape; `, <n> dropped` includes dropped transitions.

### 14. Fixtures and goldens

- `scripts/golden.ts`: add `rethink-work-transitions`: the `rethink-work-engine` choices plus
  transitions `dim` w26 to w33 (key_from w30), `panel` w126 to w133 (key_from w128) and two
  `numbered` list items far enough apart to both be kept (for example w100 to w103 key_from w102 and
  w104 to w112 key_from w104; if the overlap rule drops one, pick phrases from the reel that keep
  both and say which in the test). The fixture's existing transition in `rethink-work-engine` and
  `rethink-work-readable` gets a `key_from` in its read-back choices.
- `test-support/fixtures.ts` imports the new fixture; `build.test.ts` and `build.browser.test.ts`
  compare it with its golden in both projects; add a check that the golden holds one layer per kind
  and the three level texts of each.
- Run `yarn workspace @edit-issebya/edit golden` and commit what it writes. The hand-made fixtures
  (`rethink-work-hand`, `rethink-work-behind`) are never placed again; their goldens change only by
  the `panel` background (identical, shade 1 of `#121212`), so they must stay byte-identical: if
  they differ, fix the builder, not the golden.

### 15. Studio E2E: the two levels in the live preview

- Extend `apps/studio/e2e/preview.spec.ts` with one test, modelled on "a new version rebuilds the
  preview live ...": save a version (`saveTestVersion`) whose edit is version 2's choices placed
  through `editFromAnswer` with a `numbered` transition over `w0006` to `w0008`, `key_from` `w0007`
  (build it in a small helper in `apps/studio/test-support/`, using the committed transcript and
  head track the spec already reads). Seek on the ruler (`seekOnRuler`) into the phrase and assert in
  the composition frame: `#transition-1` visible holding the number `1`, the lead text of `w0006` in
  the caption colour and the key text of `w0007`..`w0008` in the accent colour (computed style), and
  no caption element for `w0006`..`w0008` visible (`#cw0006` absent or hidden). Fails without the
  feature (no levels, captions shown). Seek after the next word and assert the layer has left and the
  next caption shows.
- Re-derive `upload.spec.ts` (`decide-9`, the decide step line), `change-requests.spec.ts` and
  `decide-behind.spec.ts` summary texts from the new template, and `apps/studio/test-support/ai-script.ts`
  answers (transitions with `key_from`).
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: `guardrailEdit` replaces the time-anchored
  `dim-guard` with an engine-placed `numbered` transition with levels (through the same helper), so
  the export is compared with the preview on a layer carrying text.

### 16. Documentation

- `app_docs/edit-model.md`: Format (transition fields, `card` kept only for stored versions),
  Preset values (background role, entries without colour or font, `numbered`, timing values,
  descriptions), Builder contract (levels inside the layer, hidden captions), Layout engine (timing
  first: transition edges, hold, minimum, rate, overlap; the one-extra rule with transitions; levels
  placed before captions; new rules `transition-time`, `transition-min`, `transition-rate`,
  `transition-overlap`, `transition-spot`, `transition-size`, `transition-wrap`, `transition-face`),
  Checks, Testing, and Rules lines:
  - "A transition's entrance finishes as its phrase's first word starts and it has left when the
    word after the phrase starts, holding at most 1 s (2 s when asked), never shorter than 1.5 s."
  - "Never show a transition's captions also in their usual place: they show only as its levels."
  - "Never show an accent, a photo or the big word during a transition."
  - "Never write a literal font or colour in a transition entry: text and backgrounds come from the
    style roles."
  - "Never offer `card`; stored versions keep rendering it."
  - "About one transition per 7 s of reel."
- `app_docs/decide-step.md`: answer (`decide-9`) example with `key_from`, the schema refinements,
  the wishes `slow` and `long`, the preset summary with descriptions, the corrections mapping, the
  checklist outcome for a dropped transition, the summary saying phrase versus speed or hold,
  Testing (re-derived counts), Rules lines:
  - "A transition is `{ kind, from, to, key_from }` by word ids; Claude never times it."
  - "\"Longer\" or \"cover more\" changes a transition's phrase; \"slower\", \"smoother\" or \"stay
    longer\" its speed or hold, and the summary says which."
  - Update the specification lists of both docs with this plan's path.
- `docs/conditional-docs.md`: extend the `edit-model.md` line with "transitions (timing, levels,
  `numbered`)"; no new doc.
- `.adw/project.md`: no change needed (no script, port, env file or doc location changes); confirm.

### 17. Validation

- Run every command in `Validation Commands`, in order, and fix failures at their cause.

## Testing Strategy

### Unit Tests

- `packages/edit/src/transitions.test.ts`: timing (edges, hold, `long`, `slow`, minimum, clamps,
  too short), roles.
- `packages/edit/src/engine.test.ts`: the `transitions` block of task 11, the re-derived make-room
  cases.
- `packages/edit/src/decide.test.ts`, `engine-input.test.ts`, `schema.test.ts`, `checks.test.ts`,
  `preset.test.ts`, `version-diff.test.ts`, `version-summary.test.ts`, `editorial.test.ts`.
- `packages/edit/src/build.test.ts` and `build.browser.test.ts`: the new golden in Node and Chromium.
- `apps/worker/src/decide/prompt.test.ts`, `input.test.ts`, `run-decide.test.ts`,
  `version-summary.test.ts`, `doctor-checks.test.ts`.

### Test Coverage

- Unit, `transitions.test.ts`: the entrance finishing on the first word, the exit on the next word,
  the 1 s hold and the 1.5 s minimum; today the span is the words' span and nothing tests edges.
- Unit, `engine.test.ts` "two text levels in free space": lead in caption text, key in accent text,
  inside the area and off the face, phrase captions hidden; today captions sit as a block in a fixed
  area and may cover the face.
- Unit, `engine.test.ts` "about one per 7 s": the eighth transition on a 47 s reel dropped with
  `transition-rate`; today any number is kept.
- Unit, `engine.test.ts` "no extra during a transition": an accent inside a running transition
  dropped (`one-extra`); today it shows on top.
- Unit, `engine.test.ts` "numbered list": numbers 1, 2, 3 in reel order; the kind does not exist
  today.
- Unit, `decide.test.ts` "no card", "key_from inside the phrase": today `card` is accepted and
  `key_from` does not exist.
- Unit, `version-summary.test.ts`: the template says "now covers" for a phrase change and "moves
  slower" or "stays longer" for a pace or hold change; today it cannot tell them apart.
- Golden, `build.test.ts`/`build.browser.test.ts` `rethink-work-transitions`: each kind's layer and
  levels byte for byte in Node and Chromium; no golden covers `numbered` or levels today.
- E2E, `apps/studio/e2e/preview.spec.ts`: the live preview shows the number, lead-in and key phrase
  inside the transition and not the phrase's captions; fails today (captions shown, no levels).
- Owner's Mac only, `apps/studio/e2e-tools/export-matches-preview.spec.ts`: the export matches the
  preview on a transition carrying levels.

### Edge Cases

- `key_from == from` (no lead-in): only the key level (and the number) show.
- The phrase at the very start of the reel (entrance clamped, `{ reel: "start" }`), and the last
  phrase of the reel (no next word: leaves at `last.end + hold`, clamped to the reel's end).
- A reel shorter than 1.5 s: every transition dropped `transition-time`.
- A long pause after the phrase: hold capped at 1 s, `long` at 2 s.
- Back-to-back list items: overlap rule (earlier shortened to the later's start when it keeps
  1.5 s, else the later dropped).
- A face filling the area: levels cover the face, recorded `covers-face` (`transition-face`).
- A word fix inside the phrase: the level text uses the fixed text.
- A footage `hidden` span inside the phrase: the transition still shows (it is not a behind item);
  confirm `runChecks` passes.
- A requested photo where Claude's own transition stands: make-room removes the transition (as
  today); a requested transition is never removed for another item.
- Old stored versions with `card`, or a transition without `words`: parse, build unchanged, read
  back (`card` as `dim`, `key_from = from`).
- A transition wish other than `slow`/`long`, or `slow` on an accent: `wish-not-kept`.
- More than one `numbered` transition separated by a `dim`: numbering continues (1, 2) in reel order.

## Acceptance Criteria

- The decide answer's transition is exactly `{ kind, from, to, key_from }` (plus optional `wish`),
  kinds `dim`, `panel`, `numbered`; `card` is refused by the schema and absent from the JSON Schema
  and the prompt; `PROMPT_VERSION` is `decide-9`.
- On every engine-placed version, each transition's entrance finishes as its first word starts, it
  has left when the word after its phrase starts or 1 s (2 s with `long`) after its last word,
  whichever is first, and it lasts at least 1.5 s; deviations are recorded.
- Inside each transition the lead-in shows in caption text and the key phrase in accent text, each
  appearing whole on its first word and staying until the layer leaves, placed inside the safe zone
  and the layer, off the face when any free place exists; the phrase's captions are not shown
  elsewhere.
- `numbered` shows a large accent-text number (1, 2, ... in reel order) over a light dim with the
  lead-in and key phrase below.
- No transition entry in the preset holds a literal colour or font; the background comes from the
  `background` role and text from the caption and accent roles; each library kind has a description
  Claude reads.
- At most `max(1, round(duration / 7))` transitions are kept; no accent, photo or big word shows
  during a running transition.
- A version changing only a transition's phrase is summarised as covering new words; one changing
  only its pace or hold as slower or staying longer.
- Stored versions (including `card` and pre-engine hand edits) parse and build byte-identically to
  their committed goldens (the hand-made goldens are unchanged).
- `runChecks` passes on every engine-placed fixture; `app_docs/edit-model.md` and
  `app_docs/decide-step.md` carry the new Rules lines.
- Lint, typecheck, knip, format, unit, DB, build and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - formatting over the whole repository.
- `yarn turbo run lint --filter=...{./packages/edit}` - lint the edit package and its dependents (studio, worker).
- `yarn turbo run typecheck --filter=...{./packages/edit}` - types across the package, the worker and the studio.
- `yarn knip` - no dead export left behind (for example the removed transition caption block helpers).
- `yarn turbo run test --filter=...{./packages/edit}` - unit tests: the edit package's node and browser projects (goldens in Chromium), the worker's decide tests and the studio's unit tests.
- `yarn workspace @edit-issebya/edit golden && git status --porcelain packages/edit/src/testdata` - the golden script reproduces the committed fixtures and goldens exactly (empty output after the commit).
- `yarn workspace @edit-issebya/worker test:tools` - the worker's tool tests on the owner's Mac (render and the pipeline on the committed clip, untouched but it imports the package).
- `yarn turbo run test:db --filter=./apps/studio` - DB layer against the ADW stack (no migration in this change; guards `save_version` with the new engine record).
- `yarn turbo run build --filter=./packages/edit --filter=./apps/studio --filter=./apps/worker` - the build check (typecheck for the package and worker, `next build` for the studio).
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools` - the preview-matches-export guardrail with the levelled transition, against the run's servers from `/prepare_app`, owner's Mac only.

## Notes

- No new dependency, no migration: the transition's new fields live in the edit JSON in R2; the
  engine record (`versions.engine_record`, jsonb) takes the new rules as is.
- Background role: the `dim` layer moves from black at 62% to the role colour `#121212` at 62%, a
  barely visible change on versions saved before; `panel` (shade 1) is byte-identical, so the
  hand-made goldens do not change. If the owner wants stored versions pixel-identical, a `card`/`dim`
  legacy override can keep `rgba(0, 0, 0, 0.62)` for items without `levels`; ask before adding it.
- The number of a `numbered` transition is the engine's count in reel order (Claude never writes
  it); a reel with two separate lists numbers on across them. If the owner wants each list to
  restart, a later issue can add an optional `restart` meaning flag to the answer.
- One `wish` per choice: a request for "slower and longer" keeps `slow` only; recorded so the
  summary can say the hold was not changed.
- Levels are not contrast-measured: they sit on the layer (dark at 0.62 and 1; `numbered`'s 0.38 is
  lighter). If the owner finds `numbered` text hard to read on bright footage, the readability pass
  can be extended to levels over the blended layer in a later issue.
- Starting values (shades, `want`, `area`, `numberSize`, `slowFactor`, `gap`) are tuned by eye by the
  owner on a real reel, like the behind spots.
- Re-derive every count and summary string in worker and E2E tests from the new engine output;
  never loosen a check or assertion to make it pass.
- The plan's `adw_id` and `issue_number` come from the issue JSON (157) and the branch
  (`3c1a1736`); the run's variables arrived shifted.
