# The owner's moves: move and resize a text on screen

**Specifications:**

- Owner request, 2026-11-16 (step 2b of the roadmap): in the studio the owner moves and resizes any
  text component of a version; Save makes a new version marked as edited by the owner; every move is
  kept as learning data for later placement rules.
- Owner feedback, 2026-11-16: no black flash while dragging, snap guides at the frame's centre lines,
  and edge handles that make a text box wider, narrower, taller or shorter at the same text size.
- Owner feedback, 2026-11-16 (top complaint): a dragged or resized text showed in its new place only
  after a visible delay. It must follow the pointer and stay where it is dropped at once, like an
  optimistic update.

## Overview

On a reel's page the owner presses `Move text`, selects a text component on the paused preview (an
accent, a question, a big word, a list or the hook), drags it to move it, drags its corner handle to
resize it or drags an edge handle to make its box wider, narrower, taller or shorter, and presses
Save. Save queues an `owner_edit` job; the worker applies the moves to the
version and saves the result as a **new** version titled `Edited by you`. The version the owner
edited stays as it was, and going back works as for any version.

Only the place, the text size and, through an edge handle, the line breaks of a component change.
Never its words, its time on screen or what its variant draws inside its box. An edge handle never
stretches letters: the text keeps its size and is set again on more or fewer lines. A component has one box for its whole time on screen
(not one per frame), so a move moves it for all of it. Captions and VISUAL cards are not moved (visuals
get their own step later). There is no delete, no timing change and no rotation.

For every component the owner moved or resized, the worker keeps a learning record in the
`owner_moves` table: where the layout engine placed it, where the owner put it and what was on screen
with it at that moment. Placement rules will be learnt from these later.

## How it works

### The box of a component (`packages/edit`)

- `src/components.ts`: `placedComponents` gives every component of a built page with its box in frame
  pixels (`PlacedComponent`: `id`, `component`, `text`, `size`, `start`, `end`, `x`, `y`, `width`,
  `height`). It reads the builder's own text boxes, never a second measurement, so a box is the box on
  screen whatever the component's variant draws inside it. `build` returns it as `components` (the
  same list on every layer).
- The `component` is the engine's name: `HOOK`, `ACCENT`, `QUESTION`, `BIGWORD`, `LIST`, `CAPTION`,
  `VISUAL`. A QUESTION is read from its item id (`question-N`) alone, so it holds whatever the
  question's variant draws.
- A LIST is one component: the box around its levels (the number, the lead-in, the key phrase), its
  `size` its key phrase's. A VISUAL has no text size (`null`).

### A move (`packages/edit/src/owner-edit.ts`)

- `OwnerMove` is `{ id, x, y, size, width? }`: the component's item id, the top left corner of its
  box in frame pixels, its text size (a LIST's is its key phrase's) and, when an edge handle set it,
  its wrap width in frame pixels at that size. A move that only moves keeps the size; one that only
  resizes keeps the corner. Without `width` the version's own lines are kept.
- The wrap width sets the text's lines again: the fewest of the engine's balanced lines
  (`balancedLines` in `engine-place.ts`, the same balancing the engine places with) whose widest
  line fits the width, one word a line when even that is wider (a word is never cut). The box is
  then the widest line wide and the lines tall, so it can come out narrower than the width asked.
- `applyOwnerMoves(edit, moves, context)` returns the edit with the moves applied and nothing else
  changed:
  - an accent, a question or the hook: its `position` (the corner, left-aligned, which draws the
    same as any other alignment of the same box), its `size` and, with a wrap width, its `breaks`;
  - a big word: its `position` and `size`;
  - a LIST: every level moved with the box and scaled about its top left corner (each level's size
    and its offset inside the box times the key phrase's new size over its old one), at whole pixels.
    With a wrap width its lead-in and key phrase are each set again to it at their own sizes (the
    number keeps its line), and the levels are stacked again from the corner in their order on
    screen, each centred on the widest as the engine stacks them, the gaps the version's scaled.
- It refuses, with reasons: an id that is no text component of the edit (a caption and a VISUAL are
  not moved), a size outside the component's range (`ownerSizeRange`), a component moved twice, a
  wrap width on a big word (`a big word keeps its lines`) or one that is no positive number.
- `ownerWrapOptions(edit, id, { x, y, size }, context)`: every wrap width at which the component's
  lines change at that size, widest first, each with the box it gives (read from a build, like
  every box), boxes that come out the same given once. For a LIST the widths at which its lead-in or
  its key phrase changes lines. Null for a big word. `ownerSizeRange` is unchanged: a wrap width has
  no range of its own beyond `settleOwnerMove`'s safe-zone width.
- `ownerSizeRange`: 30 px (`MIN_SIZE_PX`, the placer's floor) to 400 px for an accent, a question or
  the hook; 30 px to the frame's height for a big word; for a LIST the key sizes that keep its
  smallest level at 30 px or more and its largest at 400 px or less (a key of 110 beside a lead-in of
  50 and a number of 300: 66 to 146).
- **The one hard rule is the safe zone.** `ownerMoveProblems(components, ids)` names every moved
  component whose box leaves `SAFE_ZONE.box` or reaches the platform buttons' notch: what the
  platforms cover is never readable, whoever placed the text. Everything else is the owner's choice:
  a text over the face or over another text is allowed, and the version's stored `checks` record it
  (`text-overlap`, never fatal). The engine's rule 6 (a big word at most 30% behind the head) does
  not bind the owner.
- `fitInSafeZone(box)`: the nearest place inside the safe zone and clear of the notch (clamped into
  the zone, then moved the shorter way out of the notch); null for a box larger than the zone.
- `settleOwnerMove(edit, move, context)` makes one move legal: a wrap width no wider than the safe
  zone, the size brought into its range and shrunk until the box fits the safe zone (a wrap width
  shrinks with the size, so the lines stay), then the box moved the least it must, at whole pixels. The
  studio settles every drag with it, so what the owner sees is what the worker accepts.
- `effectiveMoves(moves, components, after?)` leaves out a move that changes nothing (a text put back
  where the version has it). Without `after` (the worker) a move with a wrap width always counts.
  With `after` (the studio's draft components) a move counts only when its box or size there differs
  from the version's, so a rewrap back to the version's lines is no move.
- `withOwnerCutouts(edit, ids, context)`: a moved big word's `cutout` decided again by the engine's
  own rule (`bigWordNeedsCutout`: the head reaches it over its padded span or not). The worker calls
  it; the studio's draft does not (a mask can only be made by the worker), so a big word dragged onto
  the head shows in front of the speaker in the draft and behind the speaker once saved.
- `parseOwnerMoves(json)`: a job's moves as they arrive (untrusted): 1 to 200 moves
  (`OWNER_MOVES_MAX`), each an id, finite numbers, a whole size and optionally a wrap width (a finite
  number above 0, at most 100000), no id twice; null otherwise.
- `ownerMoveRecords(...)` builds the learning records (below).

### The editor (`apps/studio`)

- `src/components/ReelPreview.tsx` (`BuiltPreview`): the `Move text` button (`data-testid="move-toggle"`,
  `aria-pressed`) in the player's control row, before `Zones`; desktop only (`lg:`), built for a
  mouse. It pauses the preview and shows the editor; Play is off while it is open; the ruler still
  seeks. The draft is the version's edit with the moves so far. Each finished drag is settled
  (`settleOwnerMove`) and the draft's page is built again by the one builder (`pageOf`, the same call
  as the version's own page). The player loads it behind the page on screen and swaps it in only
  once it shows the same moment with its video frame decoded (`app_docs/preview.md`), so the video
  and the other texts never go black or flicker, during the drag or after it. So the preview never
  shows a text anywhere the saved version would not.
- **Instant moves** (`src/lib/live-page.ts`, `PreviewPlayerHandle.live`): the rebuilt page takes
  a few hundred milliseconds to be ready behind, so the page already on screen is restyled in place
  meanwhile. On every pointer move of a drag `MoveLayer` calls `onDragFrame` with the drag in frame
  pixels (snapped), and `ReelPreview` hands the player a patch: a move sets the component's
  elements' `left` and `top`, a corner resize scales their `font-size` (a VISUAL's `width` and
  `height`) and their corners about the box's top left corner (a LIST: its levels inside its layer,
  never the layer). An edge handle shows the lines the drop would give: once per press, a page is
  built with each of the component's wrap widths (`ownerWrapOptions`, then `applyOwnerMoves` and
  `build`), and each frame shows the one `resolveAsk` picks, its elements' style and lines
  (`wrapPatch`). On the drop the settled draft's page becomes the page to show: the player restyles
  every element whose style or lines differ between the page on screen and the new page to that
  page's own values (`changedElements`, `restyle`) before the browser paints, then drops the drag's
  patch. So the text is where it was dropped on the very next frame, and the rebuilt page swaps in
  later with nothing moving. A patch never writes what the page's timeline animates (`transform`,
  `opacity`, `visibility`, `display`), so the moment on screen stays the timeline's. A drop that
  changes nothing or is refused drops the patch, and Cancel restyles the page back the same way.
  Measured in `owner-edit.spec.ts` on the local stack: pointer up to the final position took 160 to
  192 ms before (the swap), 6 to 11 ms after (the next frame).
- `src/components/MoveLayer.tsx`: the layer over the frame (`data-testid="move-layer"`), given to
  `PreviewPlayer` as its `overlay`.
  - A bar on top (`move-bar`), as tall as the frame's top margin, which the platforms cover and no
    text sits in: the list of texts (`move-pick`, a `select` named `Text to move`, one line per
    movable component, `Kind: text`), `Cancel` (`move-cancel`) and `Save` (`move-save`, off until
    something is moved).
  - A box (`move-box`, `data-component-id`, `data-component`) around each movable component on
    screen at the paused moment: dashed until selected. Clicking it selects it; the selected box
    (`data-selected`) shows its kind above it (`move-kind`: `Accent`, `Question`, `Big word`, `List`,
    `Hook`), a corner handle (`move-handle`) at its bottom right and, for every text but a big word
    (`canRewrap`), four edge handles (`move-edge`, `data-edge="left|right|top|bottom"`) at the
    middle of its edges.
  - Dragging a box moves it; dragging the corner handle resizes it about its top left corner, in
    proportion (the text size). A press that moves less than 3 screen pixels is a click.
  - Dragging an edge handle keeps the text size and the opposite edge. While it is held the box
    follows the handle. When it is let go, `ownerWrapOptions` gives the lines the text can take and
    `resolveAsk` picks one: the left or right handle the widest lines that fit the width it was
    dragged to (the narrowest when none does), the top or bottom handle the lines whose height is
    nearest the height it was dragged to (the wider of two as near). The left handle keeps the right
    edge, the top handle the bottom edge. A move or a corner resize later keeps the wrap width an
    edge drag set, scaled with the size, so the lines stay.
  - Snap guides: while a box is dragged, its centre snaps to the frame's vertical centre line and
    its horizontal centre line, each axis on its own, when it comes within 8 screen pixels
    (`SNAP_PX`) of one. A thin line (`move-guide`, `data-axis="vertical|horizontal"`) shows while it
    is on that line. The snapped place is still settled (`settleOwnerMove`) when the drag ends, so
    the safe zone wins over a guide.
  - Picking a text from the list selects it and seeks the preview to a moment where it shows whole
    (`showMoment`: 0.4 s before its end, or its middle when it is shorter than 0.8 s).
  - A status line at the bottom (`move-status`): `Saving your changes`, `This text does not fit
there`, or why a save did not start.
- `src/lib/owner-edit.ts`: the editor's logic with no DOM in it: `componentLabel`,
  `movableComponents`, `movableAt`, `componentOption`, `showMoment`, `canRewrap`, `resolveAsk`,
  `resizeShare` (the direction the
  handle moved further in, as a share of the box), `draggedBox`, `moveOfDrag`, `snapDrag` (a move drag with its centre snapped to the centre lines),
  `withMove`, `boxStyle`.
- Save calls `requestOwnerEdit` (`src/app/change-actions.ts`): it checks the shape of the moves
  (`parseOwnerMoves`), refuses when the `studio-owner-edit` flag is off for the user, refuses a blocked reel like going back does (`changeBlockedReason`) and inserts
  the job `{ kind: "owner_edit", owner_edit: { version_id, moves } }` under RLS. The editor then waits
  for its job (`jobs` from `LiveReel`): the progress overlay shows `Saving your changes`, the new
  version replaces the preview by itself like any new version, and the editor closes. A failed job
  leaves the draft open with `Your changes were not saved. Try again`.
- Cancel (or `Move text` again) drops the draft and shows the version as it was. Nothing is queued.
- `src/components/VersionList.tsx`, `src/lib/change-requests.ts`: a version with `edited_from_id`
  reads `Edited by you` (`versionOrigin`, `versionTitle`; the row carries `data-edited`), and its
  details add `You moved or resized text in vN` (`editedFromLabel`, `version-edited-from`). A going
  back to it reads `Back to vN` like any going back.
- `src/lib/step-words.ts`: the step `owner_edit` reads `Saving your changes` (failed: `Could not save
your changes`); `JOB_STEPS.owner_edit` is that one step.
- `src/app/retry-actions.ts`: Try again on a failed `owner_edit` job queues it again with the same
  version and moves.

### The job and the worker

- `supabase/migrations/20261116121249_owner_edits.sql`:
  - `jobs.kind` accepts `owner_edit`; `jobs.owner_edit jsonb` is set for that kind only
    (`jobs_owner_edit_check`) and must be `{ version_id: string, moves: array of 1 to 200 }`
    (`jobs_owner_edit_shape_check`). The owner inserts it with the `(reel_id, kind)` grant, an
    `insert (owner_edit)` grant and the policy `jobs: owner inserts an owner edit job for own reel`
    (queued, own reel), which mirrors the relayout policy.
  - `versions.edited_from_id`: the version the owner edited, of the same reel (a foreign key like
    `parent_id`); null for every other version.
  - `owner_moves`: the learning table (below).
  - `save_version` takes `p_edited_from_id` and `p_owner_moves` (both with defaults, so every other
    caller is unchanged) and writes the version and its learning rows in one transaction. Learning
    rows without `p_edited_from_id` are refused.
- `apps/worker/src/job-kinds.ts`: `owner_edit` runs `runners.owner_edit` with the parsed payload
  (`parseOwnerEdit`); a payload that is not a version id and moves fails the job.
- `apps/worker/src/owner-edit.ts`, `runOwnerEdit`, one step `owner_edit`, no AI call:
  1. Reads the version the job names (it must be one of the reel's), its transcript and head track,
     and builds it for its components.
  2. Drops the moves that change nothing; none left fails the job (`nothing was moved or resized`).
  3. Applies the moves, decides each moved big word's cut-out again and builds the result with the
     edited version's engine record. A move that breaks the safe zone fails the job (`the moves are
refused: ...`). All of these are permanent failures, and no version is written.
  4. Finds the engine-placed version the edits started from (`enginePlaced`: back through
     `edited_from_id` and `restored_from_id`) and reads the engine's boxes from it.
  5. Makes the masks a moved big word now needs (`ensureCutouts`; the cache reuses the rest).
  6. Copies the edited version's AI record under the new version's id (so a later re-layout finds the
     same answer) and saves the version: parent the current version, `edited_from_id` the edited
     one, `engine_record` the edited version's, the build's `checks`, no title and no summary, and
     the learning records.
- The step summary reads `version N: M components moved by the owner, from version K`.
- `apps/worker/src/version-store.ts` reads `edited_from_id` and `engine_record` with a version and
  passes the two new parameters to `save_version`.

### The learning data (`owner_moves`)

One row per component moved or resized in one save, written by `save_version` with the version.

| Column                                 | What it holds                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`, `reel_id`                  | whose move, on which reel                                                                                                                   |
| `version_id`, `from_version_id`        | the owner's version, and the version the owner edited                                                                                       |
| `engine_version_id`                    | the engine-placed version the engine's box was read from                                                                                    |
| `item`, `component`, `variant`, `text` | the item id, `ACCENT`, `QUESTION`, `BIGWORD`, `LIST` or `HOOK`, the variant entry the engine placed it with (`accent/above-head`), its text |
| `start_seconds`, `end_seconds`         | its time on screen                                                                                                                          |
| `engine_box`                           | where the engine placed it: `{ x, y, width, height, size }`                                                                                 |
| `owner_box`                            | where the owner put it, the same shape                                                                                                      |
| `moved`, `resized`                     | which of the two differs: a new corner is a move; a new size, or a box of another width or height (its lines set again), a resize           |
| `wrap_width`                           | the wrap width an edge handle set, in frame pixels at the owner's size; null when the version's lines were kept                             |
| `context`                              | the moment (below)                                                                                                                          |

`context` is `{ frame, font_pair, head, engine_zone, others }`: the frame's size, the font pair, the
head over the component's time (the box around the robust faces of the head track, `facesOver`; null
with no head), the zone the engine took for it (from its engine record), and everything else on
screen during its time (`{ item, component, text, start, end, box, moved_by_owner }`, captions and
cards included, each where the owner's version has it).

Why a table, and why these keys:

- **A table, not the version's record.** The moves are read across reels to find rules, so one row
  per move with plain columns (`component`, `variant`, `moved`, `resized`) is what the analysis
  queries. The version's row (`engine_record`) stays what the engine did.
- **In the same transaction as the version.** `save_version` writes both, so there is never a saved
  owner version without its rows, nor rows for a version that was not saved.
- **The rows go with their reel.** `reel_id` references the reel `on delete cascade`, so
  `delete_reel` removes them with the reel: they are only needed until placement is worked out
  (owner decision, 2026-11-16). `version_id`, `from_version_id` and `engine_version_id` are plain
  ids, as the versions go with the same reel. A row is self-contained (boxes, head, the others, the
  text), so it can be read without the reel. Rows also go with the owner's account (`owner_id`
  cascades).
- **The engine's box is the engine's, even after several edits.** When the owner edits their own
  edit, or a going back to it, the engine box is still read from the engine-placed version
  (`engine_version_id`), so every row compares the engine with the owner's last word. Two saves that
  move the same component leave two rows; the later one is the owner's final choice.

Access: `authenticated` only reads its own rows (RLS `owner_moves: owner selects own`), `anon`
nothing, and only `service_role` writes (through `save_version`).

A first query for the analysis:

```sql
select component, variant, moved, resized,
       (owner_box->>'y')::numeric - (engine_box->>'y')::numeric as moved_down_px,
       (owner_box->>'size')::numeric / (engine_box->>'size')::numeric as size_share,
       context->'head' as head, context->>'engine_zone' as engine_zone
from owner_moves
order by created_at;
```

### What later steps do with an owner's version

- Every outcome is a new version; nothing rewrites one (`app_docs/edit-model.md`). So Start over, the
  automatic decide, a font pair change and a going back all leave the owner's version in the list,
  with its bytes and its learning rows as they were.
- Start over decides from version 1, so its new version has the engine's placement, not the owner's.
- A font pair change (`relayout`) places the version's AI answer again in the new pair, so its new
  version has the engine's placement too. The owner's moves are not carried into the new pair.
- Going back to the owner's version copies its bytes: the moved texts come back.
- Export renders the owner's version like any version (`app_docs/export.md`).

## How to Use

1. Open a reel in the studio on a desktop and wait for the preview.
2. Press `Move text` under the preview. The preview pauses and a bar appears on top of it.
3. Select a text: click its box on the preview (go to a moment where it shows with the ruler), or
   pick it from the list in the bar. Its kind shows above its box.
4. Drag the box to move it. Drag the square handle at its bottom right corner to make it larger or
   smaller. Drag a small handle on the left or right edge to make the box wider or narrower, or on the
   top or bottom edge to make it taller or shorter: the text keeps its size and moves onto fewer or
   more lines. A big word has no edge handles. The preview is built again after each drag and replaces the old one without a flicker.
   Near the middle of the frame the text snaps to the centre lines and a thin guide shows. A text stops at the edge of the safe zone.
5. Press `Save`. A new version, `Edited by you`, becomes current. Press `Cancel` to drop the changes.
6. To compare, open another version's details in the Versions list and press `Go back to this`.

## Configuration

The whole editor sits behind the PostHog feature flag `studio-owner-edit`, which gates the owner's
Move editor (`app_docs/feature-flags.md`). It is evaluated on the server for the signed-in user:
off, the reel page renders neither the `Move text` button nor the editor, and `requestOwnerEdit`
refuses (`Moving is not available yet`) before anything is queued. PostHog unconfigured, slow or
unreachable means off. The specs turn it on with `E2E_MOCK_FLAGS=studio-owner-edit` (the studio's
Playwright config and the ADW dev command set it). The job needs no AI and no prompt. A moved big word that now needs a cut-out uses the mask tool
like decide does (`E2E_MOCK_MASK` in specs).

## Testing

- `packages/edit/src/owner-edit.test.ts` (unit): the components of a built page (kind, text, one box;
  a LIST's box; a question by its id; what is movable); a move, a resize, a big word, a LIST moved and
  resized as one box, nothing else changed; the refusals; the size ranges; `fitInSafeZone` (the
  edges, the notch, a box too large); `ownerMoveProblems`; `settleOwnerMove` (a drag past the edge, a
  resize too large, the 30 px floor, a caption refused); `parseOwnerMoves`; `effectiveMoves`; a moved
  big word's cut-out; the learning records (the engine's box, the owner's, the head, the others, a
  component moved earlier). The rewrap: a text narrower (more lines) and wider (one line) at the
  same size, a LIST's lead-in and key phrase rewrapped and stacked again, a wrap width on a big word
  or of 0 refused, `ownerWrapOptions` (widest first, each taller than the one before; null for a big
  word), a wrap width settled to the safe zone's width, a parsed wrap width, `effectiveMoves` with
  the draft's boxes, and a rewrap recorded as a resize with its wrap width.
- `apps/worker/src/owner-edit.test.ts` (unit): a new version after the current one, marked as the
  owner's, the edited version not rewritten; one learning record per moved component; a wrap width
  setting the hook's lines again, recorded as a resize with `wrap_width`; the AI record copied; an
  earlier version edited; the engine's box read from the engine-placed version on a second edit; the
  refusals (outside the safe zone, a caption, an unknown component, a size under 30 px, nothing
  moved, a version of another reel), each writing no version. `job-kinds.test.ts`: the dispatch and
  a bad payload.
- `apps/studio/src/lib/owner-edit.test.ts` (unit): labels, the list of texts, what is on screen at a
  moment, the moment a picked text shows, a drag as a move, as a resize and on each edge handle,
  which components can be rewrapped, the lines an edge drag picks (`resolveAsk`), snapping to the
  centre lines, the draft's moves. `preview-clock.test.ts`: `showsFrameAt`.
  `live-page.test.ts`: a move, a corner resize, a LIST's levels moved and scaled inside their layer, a
  VISUAL scaled, an edge drag left to the rebuilt lines, a wrapped page's elements moved, the elements
  that differ between two pages, and a restyle that never touches what the timeline animates.
  `change-requests.test.ts`: `Edited by you` and the details line.
- `apps/studio/db-tests/owner-edits.test.ts` (`yarn test:db`): the job's insert policy, column grant
  and payload checks; `save_version` with the edited-from version and the learning rows (their
  `wrap_width` included), in one transaction; the owner reads only their own rows and never writes
  one; the rows go with their reel and another reel's rows stay. `grants.test.ts` covers
  `owner_moves` like every public table.
- `apps/studio/e2e/owner-edit.spec.ts` (`yarn test:e2e`): the editor opens paused, a picked text is
  selected with its kind and a handle; a drag moves it; instant moves: read after each pointer move
  the page on screen draws the text on the pointer (within 2 frame pixels), straight after pointer
  up it is at the dropped place while the draft is still `swapping`, and a watch on every frame
  from the drop through the swap finds it never anywhere else (pointer up to the final position is
  logged and must be under 50 ms); a held right edge handle already shows the text on more lines
  and the drop keeps them; and a watch on every animation frame during
  and after that drag finds no frame showing `Loading`, no player on screen, a player not ready or
  hidden, or a video with no decoded frame; a drag past the safe zone stops at its edge; the corner
  handle resizes it; a held drag near the middle snaps to both centre lines with both guides shown
  and drops centred; the right edge handle sets the hook on more lines at the same size and the
  bottom one back on two; Cancel drops the draft; Save queues the moves and the worker saves version
  3 `Edited by you` with the edited version unchanged; the learning rows; going back to the version
  before and to the owner's version; Start over leaving the owner's version and its rows alone; and
  another owner refused. With `OWNER_EDIT_SHOTS` set to a folder it keeps screenshots, among them
  the snap guides (`4-snap-guides.png`) and the edge handles (`5-edge-handles.png`,
  `6-edge-narrower.png`).
- `apps/studio/e2e-tools/export-matches-preview.spec.ts` (`test:tools`, the owner's Mac only): `a
moved, a resized and a widened component match between preview and export`: the guardrail's
  version with its hook resized, moved and widened (a wrap width) and its LIST moved, saved by a real
  `owner_edit` job, exported and compared with its preview at the guardrail's moments and bound;
  against the previews of the version before the moves the same export falls below the bound.

## Rules

- Never rewrite the version the owner edited: Save makes a new version after the current one.
- Never change anything but the place, the text size and the line breaks of the moved components:
  not a word, a time, a caption or a card. A line break changes only through a wrap width, on the
  engine's balanced lines; never stretch or squeeze letters to fill a box.
- Never save a moved component outside the safe zone or in the buttons' notch. The studio settles
  every drag (`settleOwnerMove`) and the worker refuses the job.
- Never draw the draft with anything but the one builder: the editor's layer draws boxes and
  handles only, never text, and is never part of the built page or the export. The instant view
  only restyles the builder's own elements on the page on screen (their place, size and lines, from
  a page the builder built, or scaled from them while a corner is held), and a drop always ends on
  the rebuilt page's own values.
- Never make the owner wait for the rebuilt page to see a drag or a drop: the page on screen is
  restyled at once, and the swap that follows never moves anything.
- Never let the instant view write what the page's timeline animates (`transform`, `opacity`,
  `visibility`, `display`).
- Never blank the preview for a draft: the player swaps the rebuilt page in only once it shows the
  same moment (`app_docs/preview.md`).
- Never read a component's box from anything but the builder's own boxes (`build`'s `components`).
- Never tie a move to how a component's variant draws its text: a move acts on the component's box.
- Never save an owner's version without its learning rows, nor the rows without the version: both
  go through `save_version` in one transaction.
- Never let the owner write, change or delete an `owner_moves` row; only `service_role` writes.
- Never keep `owner_moves` rows after their reel is deleted: `reel_id` cascades.
- Never call an AI model in an `owner_edit` job.
- Never move a caption or a VISUAL card with this editor.
- Never render the editor or queue an `owner_edit` job for a user whose `studio-owner-edit` flag is
  off: the page and `requestOwnerEdit` both evaluate it on the server.

## Notes

- A big word cannot be rewrapped: it is one or two words, and its schema has no `breaks`. Its corner
  handle still resizes it; it has no edge handles, and a wrap width on it is refused.
- A wrap width can only give whole lines. A top or bottom drag picks the nearest height the text
  can take, so the box can come out taller or shorter than the handle was dragged. A LIST's single
  wrap width applies to its lead-in and key phrase together; its number keeps its line.
- Not done yet: touch and phone (the button is hidden below `lg`), keyboard nudging, moving a VISUAL,
  rotation, deleting, timing changes, undo inside the editor (Cancel drops everything), and carrying
  the owner's moves into another font pair.
- A new version arriving while the editor is open (a job finishing) replaces the preview and closes
  the editor: the draft is lost. The moves are small, so this is accepted for now.
- Other docs this change touches: `app_docs/change-requests.md` (the list's `Edited by you`),
  `app_docs/edit-model.md` (`build`'s `components`, `edited_from_id`, `save_version`),
  `app_docs/preview.md` (the player's `overlay`, `controls` and `pause`), `app_docs/studio.md` (the
  job kind and the table), `app_docs/status.md` (the step's words), `app_docs/studio-reel-layout.md`
  (the control row), `app_docs/export.md` (the guardrail's case), `app_docs/failures.md` (Try again),
  `app_docs/font-pairs.md` (a re-layout does not carry the moves).
