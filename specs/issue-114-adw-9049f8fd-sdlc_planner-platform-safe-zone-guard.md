# Feature: Keep all text inside the TikTok and Instagram safe zone

## Metadata

issue_number: `114`
adw_id: `9049f8fd`
issue_json: `{"number":114,"title":"guard: keep all text inside the TikTok and Instagram safe zone (move the style's safe box bottom to 1164)"}`

## Feature Description

TikTok and Instagram Reels put their own interface over the edges of a posted reel: the top tabs,
the right column of like, comment and share buttons, and the name, caption and audio lines at the
bottom. Any text the studio places there is hidden once the reel is posted. Today the issebya
style's safe box (`packages/edit/src/preset.ts`, `safe: { left: 130, right: 860, top: 260,
bottom: 1400 }`) lets text go down to y 1400 and right to x 860, well inside the area TikTok
covers.

This feature adds a platform guard: a `PLATFORM_SAFE` box (top 252, left 120, right 840, bottom
1164 at 1080x1920, the stricter edge of TikTok and Instagram on each side). The style's safe box
becomes the intersection of its own box and the guard (left 130, right 840, top 260, bottom
1164). Every preset value that put text outside it moves inside: the caption fallback line, the
accent's no-head line, and the `dim`, `panel` and `card` text areas (the `panel` layer moves up
with its text). The layout stops caption rows beside the head above the bottom edge and keeps
centred lines (fallback, below the face, transition text) from running past it. The existing
`safe-box` check checks every text item against the guard, whatever a preset says, so no change
request and no future preset can move text into the platform zones. The studio preview gets a
small "Zones" toggle that shades what the platforms cover, so the owner can see what a platform
hides.

## User Story

As the reel owner
I want every caption, accent and transition line to stay clear of TikTok's and Instagram's own
interface
So that nothing the studio writes is hidden when I post the reel

## Problem Statement

The style's safe box was taken from the approved `rethink-work` reel without the platforms'
interface in mind. At the bottom it allows 236 px more than TikTok leaves visible (1400 against
1164), and on the right 20 px more (860 against 840). Values that sit in the covered area today:
`caption.fallbackY` 1290 (captions when no head is in the frame), the accent `noHeadY` 1130 (an
accent 110 px tall reaches 1240), the `dim` text area (1180 to 1400), the `panel` text area (1200
to 1400) and the `card` text area bottom (1400). The caption rows beside the head stop at
`safe.bottom - 60`, and the line below the face starts at `face.bottom + 14` with no bottom bound,
so either can fall below 1164. The `safe-box` check only knows the preset's box, so it cannot
catch any of this.

## Solution Statement

1. **Guard in the package, not in the taste values.** `packages/edit/src/preset.ts` exports
   `PLATFORM_SAFE` (a module constant with a comment naming its source, not a field of `Preset`,
   so no preset and no change request can loosen it) and `intersectBox(a, b)`.
   `ISSEBYA_PRESET.safe` becomes `intersectBox(STYLE_SAFE, PLATFORM_SAFE)` where `STYLE_SAFE` is
   today's `{ left: 130, right: 860, top: 260, bottom: 1400 }`, giving `{ left: 130, right: 840,
top: 260, bottom: 1164 }`.
2. **Move what sits outside**, each bottom value moved up by 236 px (1400 minus 1164), so the
   owner's spacing between lines is kept:
   - `caption.fallbackY` 1290 to 1054 (a one-line caption ends at 1104).
   - `accent.noHeadY` 1130 to 894 (ends at 1004, the same 50 px above the caption line as today).
   - `dim.text` `{ 130, 840, 944, 1164 }`; `panel.layer` top 1150 to 914 and `panel.text`
     `{ 130, 840, 964, 1164 }`; `card.text` `{ 130, 840, 640, 1164 }`.
   - The big word's `noHeadY` (700) stays: a 400 px word centred there spans 500 to 900, inside
     the guard's top and bottom. A unit test proves it.
   - A probe during planning built the three stored fixtures with exactly these values: no check
     fails, the lowest text box ends at y 1104 and the right-most at x 791.
3. **Layout stops at the bottom edge** (`packages/edit/src/layout.ts`):
   - `slotsBeside`: a caption takes a slot only if `slot.y + item.size <= safe.bottom` (as well as
     the room test). A row too low for the caption is skipped, so the caption goes to the next
     free slot (the other side or a higher row), and otherwise to the line below the face.
   - `lines(items, region, ...)` takes the region's `bottom`: when the wrapped block would run
     past it, the block's top moves up to `bottom - blockHeight` (never above the region's top's
     own lower bound `safe.top`). The fallback region gets `bottom: safe.bottom`; transition text
     areas already carry a bottom.
   - Unplaced captions (too wide for every slot): below the face when the block fits above
     `safe.bottom`; otherwise above the face (`face.top - lineGap - blockHeight`) when that is not
     above `safe.top`; otherwise the block clamped to the bottom edge, where the `face` check
     reports it. So text avoids the face by default and the check is still the safety net.
4. **Checks** (`packages/edit/src/checks.ts`): the `safe-box` check checks every caption and
   accent against `intersectBox(preset.safe, PLATFORM_SAFE)`, with the same plain reason
   (`... runs past the safe box: bottom edge 1350 > 1164`). Stored versions still parse; a stored
   version whose explicit `position` falls outside shows its failed check and is never rewritten.
   The decide schema's `bounds` and the prompt's `safe_box` already read `preset.safe`, so new AI
   answers are bounded by the new box with no worker change.
5. **Studio preview toggle** (`apps/studio`): a "Zones" button (`aria-pressed`) in the player's
   control row shows or hides a non-interactive layer over the preview that shades the four
   platform zones, from `PLATFORM_SAFE` and the frame, in percentages so it scales with the
   player. Off by default, never saved, never part of the built page or the export.
6. **Docs**: `app_docs/edit-model.md` (the guard, its source, the moved values, the layout rules,
   a new Rule) and `app_docs/preview.md` (the toggle).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules (no em-dashes, Yarn only, conventional
  commits with no trailers, feature docs own their Rules).
- `docs/conditional-docs.md`: index; the `edit-model.md` and `preview.md` lines match this task.
- `app_docs/edit-model.md`: the preset values, the checks and the Rules this change edits. Its
  Rule "A big word is checked against the frame, never the safe box" is kept.
- `app_docs/preview.md`: the studio live preview, its rules (never patch the player, one builder),
  where the toggle is documented.
- `app_docs/decide-step.md`: read only; the decide schema bounds positions by `preset.safe` and
  the prompt carries `safe_box`, both follow the new box with no change and no `PROMPT_VERSION`
  bump (the prompt text is unchanged).
- `packages/edit/src/preset.ts`: `Preset.safe`, `ISSEBYA_PRESET` values; gains `PLATFORM_SAFE`,
  `STYLE_SAFE` and `intersectBox`.
- `packages/edit/src/layout.ts`: `slotsBeside`, `lines`, the fallback and below-face placement,
  the accent's no-head line.
- `packages/edit/src/checks.ts`: the `safe-box` check.
- `packages/edit/src/behind.ts`: `bigWordLayout` (read only, the no-head line is checked by test).
- `packages/edit/src/index.ts`: exports `PLATFORM_SAFE` for the studio.
- `packages/edit/src/checks.test.ts`: existing `safe-box` regex names `860`; becomes `840`; new
  guard tests go here.
- `packages/edit/src/schema.test.ts`, `packages/edit/src/decide.test.ts`: bounded-position tests
  that read `ISSEBYA_PRESET.safe` (confirm they still hold).
- `packages/edit/src/build.test.ts`, `packages/edit/src/build.browser.test.ts`,
  `packages/edit/src/test-support/fixtures.ts`, `packages/edit/src/test-support/golden.ts`,
  `packages/edit/scripts/golden.ts`, `packages/edit/src/testdata/golden/*`: the goldens change
  (text positions, the panel layer, wrap widths) and are rewritten with the golden script.
- `apps/worker/src/decide/input.ts` (`presetSummary`): read only, sends `preset.safe`.
- `apps/studio/src/components/PreviewPlayer.tsx`: the player stage (`relative aspect-[9/16]`) and
  the control row where the toggle and the zone layer go.
- `apps/studio/src/components/ReelPreview.tsx`: read only, passes `controls` to the player.
- `apps/studio/e2e/preview.spec.ts`: the spec extended for the toggle (it opens a processed reel's
  built preview).
- `apps/studio/e2e/reel-layout.spec.ts`: read only; the control row must still fit at 390x844
  (Send and Export inside the root box, no page scroll), so run it after adding the button.
- `node_modules/next/dist/docs/`: read the relevant client component guide before the studio work.

### New Files

- `apps/studio/src/lib/platform-zones.ts`: pure `platformZones(frame, safe)`: the four covered
  rectangles (top, bottom, left, right) as percentages of the frame.
- `apps/studio/src/lib/platform-zones.test.ts`: its unit test.
- `apps/studio/src/components/PlatformZones.tsx`: the shaded, `pointer-events-none`,
  `aria-hidden` layer (`data-testid="platform-zones"`) drawn inside the player stage.

## Implementation Plan

### Phase 1: Foundation

Add the guard to `packages/edit`: `PLATFORM_SAFE`, `STYLE_SAFE`, `intersectBox`, the preset's
`safe` as their intersection, and the moved values. Unit-test the intersection and that every
moved value is inside it.

### Phase 2: Core Implementation

Bound the layout at the bottom edge (slots, wrapped lines, unplaced captions), point the
`safe-box` check at `intersectBox(preset.safe, PLATFORM_SAFE)`, and rewrite the goldens. Prove
with tests that no fixture's text leaves the guard and that a text item at y 1300 fails with a
readable reason, even under a preset whose own box is looser.

### Phase 3: Integration

Export `PLATFORM_SAFE`, add the studio's "Zones" toggle and its spec, and update the two feature
docs and the index line.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before changing

- Read `app_docs/edit-model.md`, `app_docs/preview.md`, `app_docs/decide-step.md` (Rules
  sections are invariants) and the Next client component docs under `node_modules/next/dist/docs/`.

### 2. Guard and preset values (`packages/edit/src/preset.ts`)

- Add and export `intersectBox(a: Box, b: Box): Box` (max of lefts and tops, min of rights and
  bottoms).
- Add and export `PLATFORM_SAFE: Box = { left: 120, right: 840, top: 252, bottom: 1164 }` with a
  comment: where TikTok and Instagram Reels leave text visible at 1080x1920; the stricter edge of
  the two platforms on each side (TikTok's reference: top 252, left 120, a 240 px right margin
  beside the button column, 756 px covered at the bottom); a guard, not a taste value: no preset
  and no change request moves it (owner decision, issue #114, 2026-11-03).
- Add a non-exported `STYLE_SAFE = { left: 130, right: 860, top: 260, bottom: 1400 }` (the
  `rethink-work` style's own box) and set `ISSEBYA_PRESET.safe: intersectBox(STYLE_SAFE,
PLATFORM_SAFE)`. Update the `Preset.safe` comment ("Text never leaves it; always inside
  `PLATFORM_SAFE`").
- Move the values: `caption.fallbackY` 1054, `accent.noHeadY` 894, `dim.text` `{ left: 130,
right: 840, top: 944, bottom: 1164 }`, `panel.layer` `{ left: 0, right: 1080, top: 914,
bottom: 1920 }`, `panel.text` `{ left: 130, right: 840, top: 964, bottom: 1164 }`, `card.text`
  `{ left: 130, right: 840, top: 640, bottom: 1164 }`. Leave `behind.word.noHeadY` at 700.

### 3. Layout bound at the bottom edge (`packages/edit/src/layout.ts`)

- `lines`: take `region: Box` (with `bottom`). Compute the wrapped block's height first (sum of
  each row's largest size plus `lineGap` between rows); start at
  `Math.max(preset.safe.top, Math.min(region.top, region.bottom - blockHeight))`. A block that fits
  is placed exactly as today (goldens move only because the values moved).
- `slotsBeside` / the slot pick: a slot is free for a caption only if its room fits the width and
  `slot.y + item.size <= preset.safe.bottom`. Remove the `- 60` assumptions only if they become
  redundant; keep the row loop deterministic.
- Fallback region: `{ left: safe.left, right: safe.right, top: caption.fallbackY, bottom:
safe.bottom }`.
- Unplaced captions: below the face (`top = max(fallbackY, face.bottom + lineGap)`) when the block
  ends at or above `safe.bottom`; else above the face (`top = face.top - lineGap - blockHeight`)
  when that is at or below `safe.top`; else the bottom-clamped block. Write the comment saying
  why (the face check stays the safety net).
- Accents keep `Math.max(safe.top + 25, face.top - aboveHead)` with a head and `noHeadY` without;
  update the function comments to name the bottom edge rule.

### 4. Check against the guard (`packages/edit/src/checks.ts`)

- In the `safe-box` loop use `const safe = intersectBox(preset.safe, PLATFORM_SAFE)` instead of
  `preset.safe`. Keep the reason format. Update the header comment ("text inside the safe box,
  never past the platform guard").

### 5. Export (`packages/edit/src/index.ts`)

- Export `PLATFORM_SAFE` (the studio uses it). Export `intersectBox` only if something outside the
  package imports it (knip must stay green).

### 6. Unit tests (`packages/edit`)

- `src/preset.test.ts` (new) or `src/checks.test.ts`: `intersectBox` of two boxes;
  `ISSEBYA_PRESET.safe` equals `{ left: 130, right: 840, top: 260, bottom: 1164 }`; each moved
  value is inside it: the caption fallback line (`fallbackY + fonts[caption.font].size <=
safe.bottom`), the accent no-head line (`noHeadY + accent size <= safe.bottom`), every
  transition `text` box inside `safe`; the no-head big word (`bigWordLayout` with an all-`null`
  head track) has `y >= PLATFORM_SAFE.top` and `y + height <= PLATFORM_SAFE.bottom`.
- `src/checks.test.ts`:
  - Update the 40-character accent regex to `right edge \d+ > 840`.
  - A caption with `position { x: 540, y: 1300, align: "center" }` fails `safe-box` with reason
    matching `/runs past the safe box: bottom edge 1350 > 1164$/`.
  - The same edit under a preset copy whose `safe` is `{ left: 0, right: 1080, top: 0, bottom:
1920 }` still fails `safe-box` with `bottom edge 1350 > 1164` (the guard, not the preset).
  - For every stored fixture, the boxes from `layoutText` all satisfy `x >= 120`, `x + width <=
840`, `y >= 252`, `y + height <= 1164` (verification 2: no text below 1164 or right of 840 in
    the `rethink-work` builds), and the checks list stays empty.
- Layout tests (in `checks.test.ts` or a new `src/layout.test.ts`), each through `layoutText` with
  a synthetic head track:
  - A head whose face bottom is about 1150 (low in the frame) and a caption group: no caption box
    ends below 1164, and none overlaps the face.
  - No head and a group that wraps to two lines (long words): the block ends at or above 1164.
  - A caption with `size` 120 beside the head: it never takes a slot whose row would push it
    past 1164.

### 7. Goldens

- Run `yarn workspace @edit-issebya/edit golden` and commit what it writes
  (`src/testdata/golden/*`, and the baseline fixture version if it changes). Read the diff: only
  text positions, the panel layer and widths from the narrower wrap should change.

### 8. Studio toggle (`apps/studio`)

- `src/lib/platform-zones.ts`: `platformZones(frame: { width; height }, safe: Box)` returns
  `{ id: "top" | "bottom" | "left" | "right", left, top, width, height }` in percent of the frame:
  top `0..safe.top` full width, bottom `safe.bottom..height` full width, left `0..safe.left` and
  right `safe.right..width` between the two.
- `src/lib/platform-zones.test.ts`: with `ISSEBYA_PRESET.frame` and `PLATFORM_SAFE`, the bottom
  zone's top is `1164 / 1920 * 100`, the right zone's left `840 / 1080 * 100`, the four zones do
  not overlap.
- `src/components/PlatformZones.tsx`: `aria-hidden`, `pointer-events-none`, absolutely positioned
  over the stage (`inset-0`), each zone a translucent shaded `div` (`data-zone="<id>"`) with a
  thin outline; `data-testid="platform-zones"`.
- `src/components/PreviewPlayer.tsx`: local `useState(false)` for the zones; render
  `<PlatformZones />` inside the stage `div` when on (below the Loading status in order is fine);
  add a small button "Zones" with `aria-pressed` and `title="Show what TikTok and Instagram
cover"` in the control row before `{controls}`. No effect, no stored state, nothing in the built
  page. Keep the row fitting at 390 px (short label, `flex-none`, same small size as Undo and
  Redo).

### 9. E2E spec (`apps/studio/e2e/preview.spec.ts`)

- Add a test after the preview is ready: the `platform-zones` layer is absent; clicking the
  "Zones" button sets `aria-pressed="true"` and shows it; the `bottom` zone's top edge, measured
  with `getBoundingClientRect` relative to the stage's box, is at `1164 / 1920` of the stage height
  (within 1 px) and the `right` zone's left at `840 / 1080` of its width; Play still works with the
  layer on (the layer takes no clicks); clicking again hides it. Fails without the feature (no
  button, no layer).

### 10. Docs

- `app_docs/edit-model.md`:
  - Preset values: "safe box left 130, right 840, top 260, bottom 1164: the style's own box (130,
    860, 260, 1400) cut to `PLATFORM_SAFE`"; a short paragraph on `PLATFORM_SAFE` (values, source:
    the stricter of TikTok and Instagram at 1080x1920, the owner's decision of 2026-11-03, a guard
    no change request moves); caption fallback line y 1054, accents y 894 with no head, the
    transitions' text areas and the panel layer at y 914.
  - Builder contract / layout: the bottom-edge rules (slots, wrapped blocks moved up, unplaced
    captions below, else above the face).
  - Checks: `safe-box` checks against `intersectBox(preset.safe, PLATFORM_SAFE)`.
  - Rules: add "Text never enters the platform zones: `PLATFORM_SAFE` is a guard, never a preset
    value, and no preset or change request moves it." and "Never rewrite a stored version to fit
    the guard; it shows its failed check." Keep the big word rule as is.
- `app_docs/preview.md`: the Zones toggle (where, what it draws, from `PLATFORM_SAFE`, never in the
  built page or the export), its unit test and the `preview.spec.ts` test; add the spec of issue
  114 to its Specifications list.
- `docs/conditional-docs.md`: extend the `edit-model.md` line with "the platform safe zone
  (`PLATFORM_SAFE`)" and the `preview.md` line with "the platform zones toggle".
- No em-dashes anywhere.

### 11. Run the validation commands

- Run every command in `Validation Commands` and fix any failure without weakening a test or rule.

## Testing Strategy

### Unit Tests

- `packages/edit`: `intersectBox`; the preset's safe box equal to the intersection; each moved
  value inside it; the no-head big word inside the guard's top and bottom; a text item at y 1300
  failing `safe-box` with `bottom edge 1350 > 1164`, under the preset and under a looser preset;
  every fixture's text boxes inside 120..840 by 252..1164 with no failed check; the low-head,
  two-line fallback and large-caption layout cases; the rewritten goldens in the Node and browser
  projects.
- `apps/studio`: `platformZones` percentages and non-overlap.

### Test Coverage

- `packages/edit/src/checks.test.ts` (unit, Node): a caption at y 1300 fails `safe-box` with a
  readable reason, also under a preset whose own box is looser; catches the guard being lost or
  read from the preset alone (today it passes, 1350 < 1400).
- `packages/edit/src/checks.test.ts` or `layout.test.ts` (unit, Node): no fixture text below 1164
  or right of 840, and the low-face, wrapped-fallback and large-caption cases end above 1164;
  catches text placed into the bottom zone (today the fallback line sits at 1290).
- `packages/edit/src/preset.test.ts` (unit, Node): the intersection box and every moved value
  inside it; catches a preset value drifting back into a zone.
- `packages/edit/src/build.test.ts` and `build.browser.test.ts` (unit, Node and browser goldens):
  the rewritten goldens pin the new positions byte for byte in both environments.
- `apps/studio/src/lib/platform-zones.test.ts` (unit): the zone rectangles from `PLATFORM_SAFE`.
- `apps/studio/e2e/preview.spec.ts` (E2E, chromium): the Zones toggle shows the shaded zones at
  the guard's edges over the live preview and hides them again; nothing covers this today.

### Edge Cases

- No head in the frame and a caption group that wraps to two lines: block moved up to end at 1164.
- A face whose bottom is below 1164 (head low in the frame): captions go beside or above the face,
  never below 1164.
- A caption with a large custom `size` beside the head: skips rows that would cross 1164.
- A stored version with an explicit `position` below 1164: parses, builds, shows its `safe-box`
  check, is not rewritten.
- A preset whose own `safe` is looser than the guard: the check still uses the guard.
- An accent over 710 px wide (narrower box now): fails `safe-box` with its left and right edges.
- The big word: still checked against the frame only; its no-head line inside the guard
  vertically.
- Toggle on at 390x844: the control row still fits, the page still never scrolls, Play still
  clickable through the layer.

## Acceptance Criteria

- `PLATFORM_SAFE` is `{ left: 120, right: 840, top: 252, bottom: 1164 }` with a comment naming its
  source; `ISSEBYA_PRESET.safe` is `{ left: 130, right: 840, top: 260, bottom: 1164 }`.
- `caption.fallbackY`, `accent.noHeadY`, the `dim`, `panel` and `card` text areas (and the panel
  layer) sit inside the new box, and unit tests prove each.
- No text box from the stored fixtures ends below 1164 or right of 840; their checks list stays
  empty; the goldens are rewritten and match in Node and the browser.
- A text item at y 1300 fails `safe-box` with `bottom edge 1350 > 1164`, also under a preset with
  a looser box.
- Stored versions still parse; none is rewritten.
- The studio preview has a "Zones" toggle that shades the four platform zones at the guard's edges
  and hides them again, covered by `preview.spec.ts`; `reel-layout.spec.ts` still passes.
- `app_docs/edit-model.md`, `app_docs/preview.md` and `docs/conditional-docs.md` are updated; no
  em-dashes; lint, typecheck, knip, format, unit, build, DB and E2E green.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: formatting over the whole repository (run `yarn format` first if it fails).
- `yarn turbo run lint --filter=./packages/edit --filter=./apps/studio --filter=./apps/worker`:
  lint in the changed workspaces and the worker that consumes the preset.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./apps/studio --filter=./apps/worker`:
  types across the package and both consumers.
- `yarn knip`: no unused export (`PLATFORM_SAFE`, `intersectBox`, the new studio files).
- `yarn turbo run test --filter=./packages/edit --filter=./apps/studio --filter=./apps/worker`:
  unit tests, the Node and browser goldens, the guard and layout tests, `platform-zones`, and the
  worker's decide input tests.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with the toggle (the package
  and the worker have no build; their check is typecheck).
- `yarn turbo run test:db --filter=./apps/studio`: no regression in the DB layer (no migration in
  this change).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: run by the test phase; the extended
  `preview.spec.ts`, `reel-layout.spec.ts` and every spec that builds a version.

## Notes

- No new dependency. No migration. No `PROMPT_VERSION` bump: the prompt text does not change; the
  decide answer's position bounds and the prompt's `safe_box` read `preset.safe` and follow it.
- Coordination with #112 (transitions tied to a phrase, blocked by this issue): #112 is still open
  and builds on this box, so this change moves the transition text areas itself (each bottom value
  up by 236 px, the panel layer with its text). #112 replaces them later.
- The values were probed during planning against the three stored fixtures (`baseline-short-speech`,
  `rethink-work-hand`, `rethink-work-behind`): no failed check, lowest text at y 1104, right-most at
  x 791.
- Open question for the owner, not decided here: the big word behind the speaker is centred
  across the frame with 40 px margins, so it reaches into the right button column. It stays
  checked against the frame only (the existing invariant in `app_docs/edit-model.md`); vertically
  its no-head line already sits inside the guard. Moving it inside `PLATFORM_SAFE` horizontally
  would make it smaller or off-centre, a taste call for a later issue.
- The panel's solid layer now starts at y 914 (was 1150), so it covers more of the frame; the
  owner judges it by eye on a real reel (the acceptance after merge), with the Zones toggle on.
- Owner acceptance after merge: one real reel in development, judged by eye with the Zones toggle.
