# The owner's moves: move and resize a text or a visual on screen, turn a visual, and show pictures from the library

**Specifications:**

- Owner request, 2026-11-16 (step 2b of the roadmap): in the studio the owner moves and resizes any
  text component of a version; Save makes a new version marked as edited by the owner; every move is
  kept as learning data for later placement rules.
- Owner feedback, 2026-11-16: no black flash while dragging, snap guides at the frame's centre lines,
  and edge handles that make a text box wider, narrower, taller or shorter at the same text size.
- Owner feedback, 2026-11-16 (top complaint): a dragged or resized text showed in its new place only
  after a visible delay. It must follow the pointer and stay where it is dropped at once, like an
  optimistic update.
- Owner decisions, 2026-11-16 (visuals step 1): the owner moves and resizes a VISUAL in the same
  editor, behind the same `studio-owner-edit` flag; a VISUAL keeps its picture's aspect ratio; its
  only resize is the corner handle, in proportion, like a text's; no edge handles for a VISUAL.
  Rotation and adding images come later.
- Owner decisions, 2026-11-17 (visuals step 2): the owner turns a VISUAL in the same editor, behind
  the same flag: any angle, from a rotate handle above the selected card's box; it snaps upright
  (0 degrees) and to 90, 180 and 270 degrees within a few degrees, with a visible hint while snapped;
  it follows the pointer at once like a drag, and the swap to the rebuilt draft has no jump. Texts
  are never turned, visuals only.
- Owner rule, 2026-11-17: a VISUAL card may go beyond the safe zone, over the platform buttons'
  notch and even past the frame's edge, but at least 20% of the upright rectangle around it stays
  inside the frame, so it is never lost off screen. Text stays bound to the safe zone exactly as
  before. The engine's own placement of cards is unchanged.
- Owner decisions, 2026-11-17 (visuals step 3, pictures from the photo library): in the same editor,
  behind the same flag, a selected VISUAL's `Change picture` and, with nothing selected, `Add
picture here` open one picker of all the owner's ready library photos, newest first (matching a
  photo's tags to the reel comes later). One click swaps the picture: the card keeps its place,
  rescaled to the photo's aspect ratio, and is then moved, resized and turned as usual. An added
  card appears at the paused moment, starting on the word under the playhead and lasting a fixed
  1.5 s (clipped to the reel's end), placed in a corner by the engine's placement; it cannot be
  added over hidden footage. Several cards may show at once, an added one on top. Deleting a
  library photo a version uses stays allowed, with a warning first that counts the versions.

## Overview

On a reel's page the owner presses `Move text`, selects a text component on the paused preview (an
accent, a question, a big word, a list or the hook) or a VISUAL card, drags it to move it, drags its
corner handle to resize it, (a text) drags an edge handle to make its box wider, narrower, taller
or shorter or (a VISUAL) drags its rotate handle to turn it, and presses Save. Save queues an `owner_edit` job; the worker applies the moves to the
version and saves the result as a **new** version titled `Edited by you`. The version the owner
edited stays as it was, and going back works as for any version.

Only the place, the text size and, through an edge handle, the line breaks of a component change.
Never its words, its time on screen or what its variant draws inside its box. An edge handle never
stretches letters: the text keeps its size and is set again on more or fewer lines. A component has one box for its whole time on screen
(not one per frame), so a move moves it for all of it. A VISUAL's box moves and scales: its picture
and its time stay, and its height always follows its picture's aspect ratio, so a card is never
stretched. A VISUAL also turns about its box's centre, by any angle in whole degrees; a text never
turns. Captions are not moved. There is no delete and no timing change.

A card's picture can be one of the owner's library photos (`app_docs/photo-library.md`): `Change
picture` swaps a selected card's stand-in (or earlier photo) for one, and `Add picture here` adds a
new card showing one at the paused moment, on top of the cards already there. The worker trusts
only the photo's id from the browser: it checks the photo is the reel owner's and ready, and reads
its size itself.

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
  `VISUAL`. A QUESTION is read from its item id (`isQuestion` in `src/question.ts`: an accent
  overlay with a `question-` id) alone. Its variant is `question/word-by-word`
  (`app_docs/edit-model.md`, "The question's look"): it builds up word by word, each word an element
  of its own, and ends with a question mark. Its box and `text` are the ones that look draws, the
  question mark included.
- A LIST is one component: the box around its levels (the number, the lead-in, the key phrase), its
  `size` its key phrase's. A VISUAL has no text size (`null`). A turned VISUAL's component also
  has `rotation` (whole degrees clockwise); its `x` to `height` stay its box upright.

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
    same as any other alignment of the same box), its `size` and, with a wrap width, its `breaks`.
    A question's lines are set on the text it draws, its question mark included (`questionText`,
    the same text the engine wraps and the builder draws), so its box never runs past the wrap
    width; its words keep their order and their moments, so re-wrapped lines still reveal word by
    word with the mark on the last word;
  - a big word: its `position` and `size`;
  - a LIST: every level moved with the box and scaled about its top left corner (each level's size
    and its offset inside the box times the key phrase's new size over its old one), at whole pixels.
    With a wrap width its lead-in and key phrase are each set again to it at their own sizes (the
    number keeps its line), and the levels are stacked again from the corner in their order on
    screen, each centred on the widest as the engine stacks them, the gaps the version's scaled.
- A VISUAL's move is `OwnerBoxMove`, `{ id, kind: "box", x, y, width }`: its box's top left corner
  and its width in frame pixels. Its height is derived (`boxHeight`): the width times its stand-in
  picture's height over its width (`VISUAL_STAND_INS`; the box's own ratio for a VISUAL with no
  picture), at whole pixels, and its own height at its own width, so a move that only moves changes
  nothing else. `applyOwnerMoves` writes the item's `box` (whole pixels) and nothing else: not its
  picture, its description or its time. `isBoxMove` tells the two kinds apart.
- A VISUAL's turn: `OwnerBoxMove` has an optional `rotation`, whole degrees clockwise about the
  box's centre (-360 to 360 asked; `wholeDegrees` keeps -179 to 180). With it `applyOwnerMoves`
  writes the item's `rotation` (`schema.ts`: an optional whole number, -179 to 180; none when
  upright, so a card turned back to 0 is the engine's bytes again); without it the card keeps its
  own turn. The box stays the card upright. The builder draws the turn as the CSS `rotate`
  property (`rotate: 30deg`; its origin is the box's centre) on the card's element, never in
  `transform`, which the page's timeline owns, so the preview and the export draw the same turned
  card. A text's move has no turn: `parseOwnerMoves` refuses one.
- A turned card covers the upright rectangle around it (`rotatedBounds`, `visualBounds` in
  `behind.ts`): the frame rule of a card (`ownerMoveProblems`, `settleOwnerMove`) and the
  `card-overlap` check read that rectangle, never the upright box.
- It refuses, with reasons: an id that is no text component of the edit (a caption is not moved), a
  size outside the component's range (`ownerSizeRange`), a component moved twice, a wrap width on a
  big word (`a big word keeps its lines`) or one that is no positive number; a text's move on a
  VISUAL (`a visual moves as a box`), a box move on anything but a VISUAL (`not a visual of this
version`) and a VISUAL narrower than 100 px (`MIN_BOX_PX`) or wider than the frame.
- `ownerWrapOptions(edit, id, { x, y, size }, context)`: every wrap width at which the component's
  lines change at that size, widest first, each with the box it gives (read from a build, like
  every box), boxes that come out the same given once. For a LIST the widths at which its lead-in or
  its key phrase changes lines. Null for a big word. `ownerSizeRange` is unchanged: a wrap width has
  no range of its own beyond `settleOwnerMove`'s safe-zone width.
- `ownerSizeRange`: 30 px (`MIN_SIZE_PX`, the placer's floor) to 400 px for an accent, a question or
  the hook; 30 px to the frame's height for a big word; for a LIST the key sizes that keep its
  smallest level at 30 px or more and its largest at 400 px or less (a key of 110 beside a lead-in of
  50 and a number of 300: 66 to 146).
- **The one hard rule of a text is the safe zone.** `ownerMoveProblems(components, ids)` names every
  moved text whose box leaves `SAFE_ZONE.box` or reaches the platform buttons' notch: what the
  platforms cover is never readable, whoever placed the text. **A VISUAL is free of the safe zone**
  (owner rule, 2026-11-17): it may sit over the notch and reach past the frame's edge, and
  `ownerMoveProblems` names it only when less than a fifth (`VISUAL_MIN_SHOWN`, 0.2) of the upright
  rectangle around it is inside the frame (`shownShare`), so it is never lost off screen. The
  schema lets a card's corner be off the frame (`x` from minus to plus the frame's width, `y` the
  same with its height); the `safe-box` check reads texts only, never a card. Everything else is
  the owner's choice:
  a text over the face or over another text is allowed, and the version's stored `checks` record it
  (`text-overlap`, never fatal). The engine's rule 6 (a big word at most 30% behind the head) does
  not bind the owner.
- `fitInSafeZone(box)`: the nearest place inside the safe zone and clear of the notch (clamped into
  the zone, then moved the shorter way out of the notch); null for a box larger than the zone.
- `settleOwnerMove(edit, move, context)` makes one move legal: a wrap width no wider than the safe
  zone, the size brought into its range and shrunk until the box fits the safe zone (a wrap width
  shrinks with the size, so the lines stay), then the box moved the least it must, at whole pixels. The
  studio settles every drag with it, so what the owner sees is what the worker accepts. A VISUAL's
  move is settled by its own rule: its turn brought to whole degrees, its width at least 100 px and
  at most the frame's width (shrunk, its height with it, while its height passes the frame's), then
  moved the least it must (`fitInFrame`: along one axis, or both) to keep a fifth of the rectangle
  around the turned box inside the frame, at whole pixels (the nearest whole corner whose rectangle
  holds). A card dropped anywhere with a fifth of it in the frame stays where it is dropped, past
  the safe zone and the notch included.
- `effectiveMoves(moves, components, after?)` leaves out a move that changes nothing (a text put back
  where the version has it). Without `after` (the worker) a move with a wrap width always counts.
  With `after` (the studio's draft components) a move counts only when its box or size there differs
  from the version's, so a rewrap back to the version's lines is no move.
- `withOwnerCutouts(edit, ids, context)`: a moved big word's `cutout` decided again by the engine's
  own rule (`bigWordNeedsCutout`: the head reaches it over its padded span or not). The worker calls
  it; the studio's draft does not (a mask can only be made by the worker), so a big word dragged onto
  the head shows in front of the speaker in the draft and behind the speaker once saved.
- `parseOwnerMoves(json)`: a job's moves as they arrive (untrusted): 1 to 200 moves
  (`OWNER_MOVES_MAX`), no id twice, each either a text's (an id, finite numbers, a whole size and
  optionally a wrap width, a finite number above 0, at most 100000, never a turn) or a VISUAL's
  (`kind: "box"`, an id, finite numbers, a width like a wrap width, no size and optionally a turn,
  a whole number from -360 to 360); null otherwise. `effectiveMoves` leaves out a VISUAL's move
  whose corner, width and turn are the version's; a turn alone counts.
- `ownerMoveRecords(...)` builds the learning records (below).

### Pictures from the library (`packages/edit/src/owner-edit.ts`, `owner-add.ts`)

- A swap is a VISUAL's box move with `photo_id` (`OwnerBoxMove.photo_id`, a uuid; `parseOwnerMoves`
  refuses another value and any `photo_id` on a text's move). `applyOwnerMoves` and
  `settleOwnerMove` read the photo from the caller's `photos` (`OwnerPhotos`, by id: `{ id, width,
height, description?, tags? }`); a photo not in it is refused (`photo <id> is not a ready photo in
your library`). The card then shows the photo (`photo: { id, width, height }`, its `image`
  dropped, `withPhoto`), its height the photo's aspect at its width, and the edit's
  `inputs.photos` is written from its tracks (`withPhotoInputs`, `app_docs/edit-model.md`).
  `effectiveMoves` counts a swap to another picture as a change; `PlacedComponent.picture` (the
  photo's id or the stand-in's file) tells the pictures apart.
- An add is `OwnerAdd`, `{ id: "owner-visual-N", photo_id, word, x, y, width }` (`parseOwnerAdds`:
  absent is none, at most 20, ids unique and of that shape). `applyOwnerAdds(edit, adds, context)`
  appends each card to the end of the `behind` track, so the page draws it on top of every card
  before it (track 30, in the track's order): start `{ word }`, end the word's start plus
  `OWNER_ADD_SECONDS` (1.5 s) as a word anchor (`anchorAt`), or `{ reel: "end" }`, cut short by the
  reel's end or the next hidden stretch of footage (`ownerAddSpan`; a word inside a hidden stretch,
  or less than the shown floor of 0.5 s left, has no span and is refused), its description the
  photo's (cut at a word to 120 characters), its box the photo's aspect at its width (100 px to the
  frame's width). It gets a click as it comes in (`click-owner-visual-N`, on its start anchor) only
  when no other sound starts within the click's gap (0.25 s, `minGapSeconds`) of it, so the
  `sound-gap` check holds. Refused with reasons: an id already in the edit, a photo not in
  `photos`, a word with no span, a width outside its range.
- `ownerAddWord(transcript, seconds)`: the word under the playhead (spoken then); in a pause between
  words the last one spoken before it, so the card is on screen at the paused moment (with aligned
  word times, `app_docs/pipeline.md`, the transcript has gaps between words; it used to take the next
  word, and a card added in a pause then started after the paused moment); before the first word,
  the first. `nextOwnerVisualId(edit)`: one past the highest `owner-visual-N`.
- `ownerAddPlacement(edit, photo, span, context)`: where the studio puts a new card: the engine's
  own placement of a `visual/card` (`placeElement`: a corner, else beside the face, the card's full
  width where it fits, at the photo's aspect) over the span's faces, with what is on screen then as
  obstacles (a caption blocks it; another card and a big word are kept clear of; a text is not, as
  a card may sit under a text); without the cards when nothing else fits; the safe zone's top left
  corner at a third of its width when even that finds none. The studio then settles it like a move
  (`settleOwnerMove`), so the worker gets a legal box.
- Several cards at once: the schema lets two VISUALs share a moment (the comment in `schema.ts`
  says so), each on track 30; the export composite's front page draws them as the preview does
  (`app_docs/export.md`).

### The editor (`apps/studio`)

- `isMovable` (`MOVABLE_COMPONENTS`): the five text kinds and `VISUAL`.
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
  never the layer; a turned card about the corner it shows at its top left), and a VISUAL's turn
  sets its element's `rotate` (`rotate: -30deg`). The player always restyles `rotate` too
  (`PATCHED` in `live-page.ts`), so a turn the patch set and neither page has is taken off again. An edge handle shows the lines the drop would give: once per press, a page is
  built with each of the component's wrap widths (`ownerWrapOptions`, then `applyOwnerMoves` and
  `build`), and each frame shows the one `resolveAsk` picks, its elements' style and lines
  (`wrapPatch`). On the drop the settled draft's page becomes the page to show: the player restyles
  every element whose style or lines differ between the page on screen and the new page to that
  page's own values (`changedElements`, `restyle`) before the browser paints, then drops the drag's
  patch. A QUESTION's lines are lines of word elements (`PageElement.words`, each line the ids of
  its `question-N_wK` words): the page's timeline reveals each of those elements, so `restyle`
  sets a question's lines by moving its own word elements between lines (a space between two words,
  a line break between two lines), never by writing its html anew, which would leave words the
  timeline never shows. A move or a corner resize writes the question's own element only; its words
  follow it. So the text is where it was dropped on the very next frame, and the rebuilt page swaps in
  later with nothing moving. A patch never writes what the page's timeline animates (`transform`,
  `opacity`, `visibility`, `display`), so the moment on screen stays the timeline's. A drop that
  changes nothing or is refused drops the patch, and Cancel restyles the page back the same way.
  Measured in `owner-edit.spec.ts` on the local stack: pointer up to the final position took 160 to
  192 ms before (the swap), 6 to 11 ms after (the next frame). A turn goes the same way.
- `src/components/MoveLayer.tsx`: the layer over the frame (`data-testid="move-layer"`), given to
  `PreviewPlayer` as its `overlay`.
  - A bar on top (`move-bar`), as tall as the frame's top margin, which the platforms cover and no
    text sits in: the list (`move-pick`, a `select` named `Text or visual to move`, first line
    `Pick a text or visual`, one line per movable component, `Kind: text`; a VISUAL's text is its
    description), `Cancel` (`move-cancel`) and `Save` (`move-save`, off until
    something is moved).
  - A box (`move-box`, `data-component-id`, `data-component`) around each movable component on
    screen at the paused moment: dashed until selected. Clicking it selects it; the selected box
    (`data-selected`) shows its kind above it (`move-kind`: `Accent`, `Question`, `Big word`, `List`,
    `Hook`, `Visual`), a corner handle (`move-handle`) at its bottom right and, for every text but a
    big word (`canRewrap`; never a VISUAL), four edge handles (`move-edge`, `data-edge="left|right|top|bottom"`) at the
    middle of its edges. A VISUAL's box instead has a rotate handle (`move-rotate`, a round handle
    on a short stem above the middle of its top edge), and its kind shows below it. A turned card's
    box turns with it (`rotate` on the box, `data-rotation` its degrees), handles included.
  - Dragging a box moves it; dragging the corner handle resizes it about its top left corner, in
    proportion (the text size; a VISUAL's width, its height following its picture). For a VISUAL
    `moveOfDrag` asks for its box (`{ kind: "box", x, y, width }`). A press that moves less than 3
    screen pixels is a click.
  - Dragging an edge handle keeps the text size and the opposite edge. While it is held the box
    follows the handle. When it is let go, `ownerWrapOptions` gives the lines the text can take and
    `resolveAsk` picks one: the left or right handle the widest lines that fit the width it was
    dragged to (the narrowest when none does), the top or bottom handle the lines whose height is
    nearest the height it was dragged to (the wider of two as near). The left handle keeps the right
    edge, the top handle the bottom edge. A move or a corner resize later keeps the wrap width an
    edge drag set, scaled with the size, so the lines stay.
  - Turning a VISUAL: dragging the rotate handle turns the card about its centre by the angle the
    pointer goes round that centre (`turnOfPointer`, the shorter way), from the card's own turn.
    Within 4 degrees (`SNAP_DEGREES`) of upright, 90, 180 or 270 degrees it snaps onto it
    (`snapAngle`); the turn is whole degrees, -179 to 180. While turning, its angle shows at the
    card's centre (`move-angle`, `12°`); while snapped the angle is highlighted
    (`data-snapped="true"`) and two thin guides cross at the card's centre (`move-turn-guide`,
    `data-axis="horizontal|vertical"`). The drop asks for the card's box with the turn
    (`moveOfDrag`), settled like a move, so a turn that would reach past the safe zone moves the card
    in or shrinks it. A move or a corner resize of a turned card keeps its turn: every VISUAL ask
    carries its `rotation`, so the draft's one move per card always holds it. A turned card's
    corner handle is read along the card's own edges and scales it with the corner it shows at its
    top left kept (`scaledVisual`).
  - Snap guides: while a box (a text's or a VISUAL's) is dragged, its centre snaps to the frame's vertical centre line and
    its horizontal centre line, each axis on its own, when it comes within 8 screen pixels
    (`SNAP_PX`) of one. A thin line (`move-guide`, `data-axis="vertical|horizontal"`) shows while it
    is on that line. The snapped place is still settled (`settleOwnerMove`) when the drag ends, so
    the safe zone wins over a guide.
  - `Change picture` (`move-change-picture`, in the bar while a VISUAL is selected) and `Add picture
here` (`move-add-picture`, in the bar while nothing is selected; off where `ownerAddSpan` gives
    no span, such as over hidden footage, its title saying why) open `PicturePicker`
    (`src/components/PicturePicker.tsx`, `picture-picker`): a modal dialog headed `Change picture`
    or `Add a picture here` with every ready photo of the library that has a large copy and a size
    (`pickablePhotos`), newest first, as thumbnails (`picture-option`, `data-photo-id`, named by the
    photo's description). `loadLibrary` fills it when it opens. One click picks and closes it; the
    cross, Escape and the backdrop close it with nothing picked.
  - A swap (`swapAsk`): the card keeps its centre, its area and its turn, its shape the photo's,
    and the box move names the photo; it is settled and the draft built again like a drop. A later
    drag of that card keeps its `photo_id` in the draft's one move for it.
  - An add: the word under the playhead (`ownerAddWord`) and its span (`ownerAddSpan`), the next id,
    the engine's placement (`ownerAddPlacement`), then `applyOwnerAdds` and `settleOwnerMove`; the
    settled box goes into the draft's `adds`, the draft is built again and the new card is
    selected. A later drag of an added card is an ordinary box move on its id, which the worker
    applies after the adds.
  - The draft keeps each picked photo's size, description and tags (`photosRef`, the settling's
    `photos`) and its large copy's signed URL from the library (`built.photoUrls`, by the path the
    page names it at), so the draft page shows the photo before anything is saved.
  - The boxes on screen are drawn in the page's stacking order (`stackedAt`: the cards in the
    track's order, then the texts), so where two overlap the topmost box takes the click, the
    added card over the engine's.
  - Picking a text from the list selects it and seeks the preview to a moment where it shows whole
    (`showMoment`: 0.4 s before its end, or its middle when it is shorter than 0.8 s).
  - A status line at the bottom (`move-status`): `Saving your changes`, `This text does not fit
there`, or why a save did not start.
- `src/lib/owner-edit.ts`: the editor's logic with no DOM in it: `componentLabel`,
  `movableComponents`, `movableAt`, `componentOption`, `showMoment`, `canRewrap`, `resolveAsk`,
  `resizeShare` (the direction the
  handle moved further in, as a share of the box), `draggedBox`, `moveOfDrag`, `snapDrag` (a move drag with its centre snapped to the centre lines),
  `scaledVisual`, `snapAngle`, `turnOfPointer`, `draggedTurn` (the turn a card shows while dragged),
  `withMove`, `boxStyle`.
- Save calls `requestOwnerEdit` (`src/app/change-actions.ts`): it checks the shape of the moves
  (`parseOwnerMoves`), refuses when the `studio-owner-edit` flag is off for the user, refuses a blocked reel like going back does (`changeBlockedReason`, which includes a reel that is exporting: `Move text` cannot be opened then, and an open editor is frozen with the reason and keeps its draft, `app_docs/export.md`) and inserts
  the job `{ kind: "owner_edit", owner_edit: { version_id, moves, adds? } }` under RLS (`adds`
  only when the owner added a card; `moves` may then be empty). The browser never sends a photo's
  size. The editor then waits
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
  - `owner_moves`: the learning table (below); its `component` check accepts `VISUAL`, and the
    `jobs.owner_edit` comment names both kinds of move. A database that applied this migration
    before visuals were added is brought in line by dropping and adding
    `owner_moves_component_check` with `VISUAL` and setting the comment again (the migration is
    edited in place, not added to). Turning a VISUAL added `rotated`, `engine_rotation` and
    `owner_rotation` (with their -179 to 180 checks) and `save_version`'s writing of them (absent
    keys give false and 0); a database that applied the migration before that is brought in line
    by adding the three columns and their checks, setting the comment again and replacing
    `save_version` with the same signature (its grants stay).
  - `save_version` takes `p_edited_from_id` and `p_owner_moves` (both with defaults, so every other
    caller is unchanged) and writes the version and its learning rows in one transaction. Learning
    rows without `p_edited_from_id` are refused.
- `supabase/migrations/20261117122655_owner_photo_cards.sql` (a new migration; the one above is
  left as it is):
  - `jobs_owner_edit_shape_check` is replaced: `{ version_id: string, moves: array, adds?: array }`,
    moves 0 to 200 plus adds 0 to 20, at least one in total, at most 64 KiB. The column comment
    names the swap's `photo_id` and the adds.
  - `owner_moves` gets `added`, `swapped` (booleans, default false), `photo_id` (a plain uuid, no
    foreign key, so a row outlives its photo) and `replaced` (text); `engine_box` becomes nullable,
    and `owner_moves_added_check` holds `added` exactly when `engine_box` is null. Its grants are
    restated per role.
  - `save_version` is replaced with the same signature, writing the four columns (absent keys give
    false and null; a JSON null engine box is stored as null). Its grants are restated: the
    service role only.
- `apps/worker/src/job-kinds.ts`: `owner_edit` runs `runners.owner_edit` with the parsed payload
  (`parseOwnerEdit`: a version id, moves and optional adds, at least one in all); any other payload
  fails the job.
- `apps/worker/src/owner-edit.ts`, `runOwnerEdit`, one step `owner_edit`, no AI call:
  1. Reads the version the job names (it must be one of the reel's), its transcript and head track,
     and builds it for its components.
  2. Reads every photo a swap or an added card names from the `photos` table with the service role
     (`supabasePhotoLibrary(db).readyPhotos(job owner, ids)`: the reel owner's, `ready`, with a
     `large_key`, a width and a height); one that is not fails the job (`photo <id> is not a ready
photo in the owner's library`). The photo's size in the version is the row's.
  3. Applies the added cards (`applyOwnerAdds`), then drops the moves that change nothing; no move
     and no card fails the job (`nothing was moved or resized`).
  4. Applies the moves, decides each moved big word's cut-out again and builds the result with the
     edited version's engine record. A text that breaks the safe zone, or a card with less than a
     fifth of it in the frame, fails the job (`the moves are refused: ...`; refused cards: `the
cards are refused: ...`). All of these are permanent failures, and no version is written.
  5. Finds the engine-placed version the edits started from (`enginePlaced`: back through
     `edited_from_id` and `restored_from_id`) and reads the engine's boxes from it.
  6. Makes the masks a moved big word now needs (`ensureCutouts`; the cache reuses the rest).
  7. Copies the edited version's AI record under the new version's id (so a later re-layout finds the
     same answer) and saves the version: parent the current version, `edited_from_id` the edited
     one, `engine_record` the edited version's, the build's `checks`, no title and no summary, and
     the learning records.
- The step summary reads `version N: M components moved by the owner, from version K`.
- `apps/worker/src/version-store.ts` reads `edited_from_id` and `engine_record` with a version and
  passes the two new parameters to `save_version`.

### The learning data (`owner_moves`)

One row per component moved, resized, turned or swapped, and per card added, in one save, written by
`save_version` with the version.

| Column                                 | What it holds                                                                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`, `reel_id`                  | whose move, on which reel                                                                                                                                                                 |
| `version_id`, `from_version_id`        | the owner's version, and the version the owner edited                                                                                                                                     |
| `engine_version_id`                    | the engine-placed version the engine's box was read from                                                                                                                                  |
| `item`, `component`, `variant`, `text` | the item id, `ACCENT`, `QUESTION`, `BIGWORD`, `LIST`, `HOOK` or `VISUAL`, the variant entry the engine placed it with (`accent/above-head`), its text (a VISUAL's description)            |
| `start_seconds`, `end_seconds`         | its time on screen                                                                                                                                                                        |
| `engine_box`                           | where the engine placed it: `{ x, y, width, height, size }`; null for a card the owner added                                                                                              |
| `owner_box`                            | where the owner put it, the same shape                                                                                                                                                    |
| `moved`, `resized`                     | which of the two differs: a new corner is a move; a new size, or a box of another width or height (its lines set again), a resize                                                         |
| `rotated`                              | a VISUAL turned: its turn differs from the engine's                                                                                                                                       |
| `engine_rotation`, `owner_rotation`    | the engine's turn (always 0: the engine never turns a card) and the owner's, whole degrees clockwise (-179 to 180); 0 and 0 for a text. `engine_box` and `owner_box` are the card upright |
| `added`                                | a card the owner added (`owner-visual-N`): no engine box, `moved`, `resized`, `rotated` and `swapped` false                                                                               |
| `swapped`                              | a card whose picture differs from the engine's: the owner swapped it for a library photo                                                                                                  |
| `photo_id`                             | the library photo the card shows (a plain id: the row outlives the photo); null for a text or a card without one                                                                          |
| `replaced`                             | what a swap replaced: the picture of the version edited when it differs (the stand-in's file or the previous photo's id), else the engine's; null without a swap                          |
| `wrap_width`                           | the wrap width an edge handle set, in frame pixels at the owner's size; null when the version's lines were kept                                                                           |
| `context`                              | the moment (below)                                                                                                                                                                        |

`context` is `{ frame, font_pair, head, engine_zone, words, photo, others }`: the frame's size, the
font pair, the head over the component's time (the box around the robust faces of the head track,
`facesOver`; null with no head), the zone the engine took for it (from its engine record), the words
spoken while it shows (the transcript's, joined by spaces), the photo it shows as the library
described it then (`{ description, tags }`, a snapshot quoted as data; null without a photo), and
everything else on screen during its time (`{ item, component, text, start, end, box, rotation?,
moved_by_owner }`, captions and cards included, each where the owner's version has it; `rotation`
only for a turned card; an added card counts as moved by the owner).

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
- Going back to the owner's version copies its bytes: the moved texts and cards come back.
- Export renders the owner's version like any version (`app_docs/export.md`).

## How to Use

1. Open a reel in the studio on a desktop and wait for the preview.
2. Press `Move text` under the preview. The preview pauses and a bar appears on top of it.
3. Select a text or a visual card: click its box on the preview (go to a moment where it shows with
   the ruler), or pick it from the list in the bar. Its kind shows above its box.
4. Drag the box to move it. Drag the square handle at its bottom right corner to make it larger or
   smaller. Drag a small handle on the left or right edge to make the box wider or narrower, or on the
   top or bottom edge to make it taller or shorter: the text keeps its size and moves onto fewer or
   more lines. A big word and a visual have no edge handles; a visual's corner handle scales the
   card with its picture's shape kept. To turn a visual, drag the round handle above its box: the
   card turns about its middle, its angle shows on it, and near upright or a quarter turn it snaps
   there and two thin guides cross on it. The text or card follows the pointer at once and stays where
   it is dropped; the preview is built again after each drag and replaces the old one without a
   flicker or a jump.
   Near the middle of the frame the text snaps to the centre lines and a thin guide shows. A text stops at the edge of the safe zone.
   A visual card may go past the safe zone, into a corner or partly off the frame; dragged so far
   that less than a fifth of it would show, it comes back until a fifth does.
5. To show one of your library photos on a card, select the card and press `Change picture`, then
   click a photo: the card keeps its place and takes the photo's shape. To add a new card, select
   nothing (click beside the boxes), pause where it should start and press `Add picture here`, then
   click a photo: the card shows from the word being spoken for 1.5 s, in a corner, on top of any
   card already there. Either can then be moved, resized and turned like any card. Over hidden
   footage `Add picture here` is off.
6. Press `Save`. A new version, `Edited by you`, becomes current. Press `Cancel` to drop the changes.
7. To compare, open another version's details in the Versions list and press `Go back to this`.

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
  component moved earlier). A VISUAL: movable, moved and scaled as a box with its picture's aspect
  ratio, nothing else changed; a box move on a text, one narrower than 100 px and one made twice
  refused; settled into the bottom right corner over the notch where it was dropped (past the safe
  zone), brought back from far off the frame until a fifth of it shows, at the frame's width when
  wider and at the 100 px floor; `fitInFrame` (unchanged with a fifth in, one axis, a corner);
  parsed; left out when it changes nothing; recorded with no size and no wrap width. A turned
  VISUAL: turned in whole degrees (-350 is 10, -190 is 170, 0 upright with no `rotation`), drawn
  with `rotate` and never `transform`, a move with no turn keeping it; a turn of 12.5 degrees and a
  turn on a text refused; the frame rule read from the rectangle around it; settled with a fifth of
  that rectangle in the frame and its turn kept, left where it is past the safe zone; a turn alone counted by `effectiveMoves` and recorded as
  `rotated` with `engine_rotation` 0 and the owner's. A QUESTION (`question/word-by-word`): one box
  holding its question mark, measured as drawn; moved and resized by its corner with its words,
  mark and reveal kept; its wrap options read from its text with the mark (every box within its
  width), re-wrapped with every word its own element in order, the mark on the last only and each
  word still cut in at its moment, settled with the same lines; recorded as `QUESTION` with its
  variant, its text with the mark and its wrap width. `engine.test.ts`: the `card-overlap` check
  reads a card turned 45 degrees beside a big word as overlapping it. The rewrap: a text narrower (more lines) and wider (one line) at the
  same size, a LIST's lead-in and key phrase rewrapped and stacked again, a wrap width on a big word
  or of 0 refused, `ownerWrapOptions` (widest first, each taller than the one before; null for a big
  word), a wrap width settled to the safe zone's width, a parsed wrap width, `effectiveMoves` with
  the draft's boxes, and a rewrap recorded as a resize with its wrap width.
- `apps/worker/src/owner-edit.test.ts` (unit): a new version after the current one, marked as the
  owner's, the edited version not rewritten; one learning record per moved component; a wrap width
  setting the hook's lines again, recorded as a resize with `wrap_width`; a VISUAL moved and scaled
  as a box with its aspect ratio kept and recorded as `VISUAL`, then turned -15 degrees with its box
  kept and recorded as `rotated` against the engine's upright card, then moved into the bottom
  right corner past the safe zone and the frame's edge and saved, and one with less than a fifth
  in the frame refused with no version written; the AI record copied; an
  earlier version edited; the engine's box read from the engine-placed version on a second edit; the
  refusals (outside the safe zone, a caption, an unknown component, a size under 30 px, nothing
  moved, a version of another reel), each writing no version. `job-kinds.test.ts`: the dispatch and
  a bad payload.
- `apps/studio/src/lib/owner-edit.test.ts` (unit): labels, the list of texts and visuals, what is on
  screen at a moment, a VISUAL's drag as a box move or a proportional resize (never an edge), the moment a picked text shows, a drag as a move, as a resize and on each edge handle,
  which components can be rewrapped, the lines an edge drag picks (`resolveAsk`), snapping to the
  centre lines, the draft's moves; the rotate handle: the turn round the centre, the snaps to 0, 90,
  180 and 270 degrees within 4 degrees, the ask with the turn (none for a text), a turned card moved
  and scaled with its turn and its shown corner kept. `preview-clock.test.ts`: `showsFrameAt`.
  `live-page.test.ts`: a move, a corner resize, a LIST's levels moved and scaled inside their layer, a
  VISUAL scaled, a VISUAL turned with `rotate` (a text never), a turned VISUAL scaled about its
  shown corner, an edge drag left to the rebuilt lines, a wrapped page's elements moved, the elements
  that differ between two pages, and a restyle that never touches what the timeline animates. A
  QUESTION: its words on other lines named as changed, a wrapped page's question carried as lines
  of word elements, and a restyle that sets its lines by moving its own word elements (never new
  ones) and changes nothing for words that are not its own.
  `change-requests.test.ts`: `Edited by you` and the details line.
- `apps/studio/db-tests/owner-edits.test.ts` (`yarn test:db`): the job's insert policy, column grant
  and payload checks; `save_version` with the edited-from version and the learning rows (their
  `wrap_width` included, and a VISUAL's row with its boxes, no size and its turn: `rotated`,
  `engine_rotation` 0, `owner_rotation`), in one transaction; a turn past 180 degrees refused; a job
  with a VISUAL's box move and turn queued; the owner reads only their own rows and never writes
  one; the rows go with their reel and another reel's rows stay. `grants.test.ts` covers
  `owner_moves` like every public table.
- `apps/studio/e2e/owner-edit.spec.ts` (`yarn test:e2e`): the editor opens paused, a picked text is
  selected with its kind and a handle; a drag moves it, and a watch on every animation frame during
  and after that drag finds no frame showing `Loading`, no player on screen, a player not ready or
  hidden, or a video with no decoded frame; instant moves: read after each pointer move the page on
  screen draws the text on the pointer (within 2 frame pixels), straight after pointer up it is at
  the dropped place while the draft is still `swapping`, and a watch on every frame from the drop
  through the swap finds it never anywhere else (pointer up to the final position is logged and must
  be under 50 ms); a held right edge handle already shows the text on more lines and the drop keeps
  them; a drag past the safe zone stops at its edge; the corner
  handle resizes it; a held drag near the middle snaps to both centre lines with both guides shown
  and drops centred; the right edge handle sets the hook on more lines at the same size and the
  bottom one back on two; Cancel drops the draft; Save queues the moves and the worker saves version
  3 `Edited by you` with the edited version unchanged; the learning rows; going back to the version
  before and to the owner's version; Start over leaving the owner's version and its rows alone; and
  another owner refused. With `OWNER_EDIT_SHOTS` set to a folder it keeps screenshots, among them
  the snap guides (`4-snap-guides.png`) and the edge handles (`5-edge-handles.png`,
  `6-edge-narrower.png`).
- `apps/studio/e2e/owner-edit-visual.spec.ts` (`yarn test:e2e`, the speech-ten clip with one VISUAL):
  the VISUAL picked from the list is selected with `Visual`, a corner handle and no edge handle; a
  drag moves it on the pointer at every step, it is at the drop straight after pointer up while the
  draft is `swapping`, and the swapped-in page draws it at the same place; the corner handle scales it
  about its corner with its aspect ratio kept, already while held; it snaps to both centre lines
  with the guides; Save queues one box move, the worker saves the version with the card's new box,
  the preview draws it there, and the learning row is `VISUAL` with both boxes, `size` null, moved
  and resized, no wrap width. The rotate handle (one on screen, on the card): the card turns on the
  pointer at every step (its element's `rotate`, never `transform`), its angle shown, at the drop
  straight after pointer up while the draft is `swapping`, the same turn and the same box once
  swapped in; held near a quarter turn it snaps to 90 degrees with the angle highlighted and both
  guides, 6 degrees past it no snap and no guide, 3 degrees from upright it snaps to 0; dropped at a
  quarter turn. Save sends the box move with `rotation: 90`, the saved version draws the card turned
  90 degrees and the row is `rotated` with `engine_rotation` 0 and `owner_rotation` 90. With
  The card is then dragged with its centre onto the frame's right edge, low over the notch: it
  stays where it is dropped (not clamped to the safe zone), Save keeps it there in the saved
  version, and its learning row holds that box. With
  `OWNER_EDIT_SHOTS` it keeps `visual-1-selected-with-corner-handle.png`, `visual-2-moved.png`,
  `visual-3-resized.png`, `visual-4-centred.png`, `visual-5-turned.png`,
  `visual-6-snapped-quarter-turn.png`, `visual-7-snapped-upright.png` and
  `visual-8-past-the-safe-zone.png`.
- `apps/studio/e2e/owner-edit-question.spec.ts` (`yarn test:e2e`, the fixture clip with the
  QUESTION "test clip for the real studio?" placed by the engine and saved with its record): picked
  from the list it is selected as `Question` with a corner handle and four edge handles, every word
  its own element; a drag moves it on the pointer at every step, its lines and the words shown
  unchanged, at the drop straight after pointer up and the same once swapped in; the corner handle
  scales it while held; the right edge handle held in by half sets it on more lines at the same
  size with the same words shown (its own word elements moved onto the lines), kept at the drop and
  after the swap. Save queues its move with a wrap width, the worker saves it, the saved version
  draws it at the owner's place on the owner's lines and still builds it up word by word as it is
  spoken (`questionShownAt` at the middle of each word), the mark only with the last word; the
  learning row is `QUESTION`, `question/word-by-word`, its text with the mark, moved and resized,
  with its wrap width. With `OWNER_EDIT_SHOTS` it keeps `question-1-selected.png`,
  `question-2-edge-held.png` and `question-3-saved-revealed.png`.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts` (`test:tools`, the owner's Mac only): `a
moved, a resized and a widened component match between preview and export`: the guardrail's
  version with its hook resized, moved and widened (a wrap width) and its LIST moved, saved by a real
  `owner_edit` job, exported and compared with its preview at the guardrail's moments and bound;
  against the previews of the version before the moves the same export falls below the bound. In the
  behind case, the VISUAL's version is then edited by a real `owner_edit` job (the card moved to the
  middle of the frame and scaled to seven tenths, its aspect ratio kept), exported and compared with
  its preview the same way, and against the engine's previews it falls below the bound. That
  version is then turned 45 degrees by another `owner_edit` job (its box kept): its preview draws
  `rotate: 45deg` and no `transform`, the export matches its preview at the bound, and against the
  upright card's previews it falls below the bound. A last `owner_edit` puts the card upright with
  its right half past the frame's right edge, low over the notch: its export matches its preview
  at the bound. Measured 2026-11-17: every case at or above
  the bound, against the version before the moves at most 0.919066 mid-reel, and the turned card
  against the upright previews 0.94604 at its lowest (`app_docs/export.md`).

- Pictures from the library. `packages/edit/src/owner-edit.test.ts`: a swap's `photo_id` parsed
  (another value and one on a text refused); the photo shown in place of the stand-in at its aspect
  ratio and named in `inputs.photos`, a photo not vouched for refused by `applyOwnerMoves` and
  `settleOwnerMove`; a swap settled with its photo, counted by `effectiveMoves`, recorded as
  `swapped` with `photo_id`, `replaced` (the stand-in's file), the photo's description and tags and
  the words spoken. `packages/edit/src/owner-add.test.ts`: `parseOwnerAdds` (absent, a malformed
  card, more than 20); the word under the playhead, the one just spoken in a pause, the first and the last; the 1.5 s span, cut by the
  reel's end and the next hidden footage, none inside it or with under 0.5 s left;
  `nextOwnerVisualId`; a card added at the end of the track with the photo at its aspect, its
  description, `inputs.photos`, its time and its click; no click within the gap of another sound
  (and no `sound-gap` check); the refusals; the engine's placement off the card already there,
  settled with no problem. `apps/worker/src/owner-edit.test.ts`: `parseOwnerEdit` with adds alone or
  with a swap, and malformed ones; a swap sized from the library (the worker's photo, never the
  job's) and recorded; a card added over the engine's card, last in the track, with its click, and a
  second on the engine card's word with none; recorded as `added` with no engine box; a photo not in
  the owner's library refused with no version written. `apps/studio/src/lib/owner-edit.test.ts`:
  `stackedAt` (cards under texts, two cards in the track's order), `pickablePhotos`, `swapAsk` (its
  centre, area and turn kept). `apps/studio/db-tests/owner-edits.test.ts`: a job with adds alone
  and with a swap queued; no move and no card, adds not a list, and more than 20 refused; a swapped
  card's row with its photo and what it replaced, an added card's with no engine box, and an added
  card with an engine box or a moved one without refused, nothing written.
- `apps/studio/e2e/owner-edit-photos.spec.ts` (`yarn test:e2e`, the speech-ten clip with one VISUAL,
  two ready photos and one being described): `Change picture` (only with a card selected) opens the
  picker with the two ready photos, newest first, and not the one being described; one click swaps
  the picture, the card's centre kept and its shape the photo's, its `<img>` loaded; a drag then
  keeps the photo. With nothing selected `Add picture here` opens the picker; the picked photo
  appears as `owner-visual-1`, selected, both cards on screen at the paused moment, the added one
  last in the page and in the editor. Save sends the swap as a box move with `photo_id` and the
  card in `adds`, no photo size; the worker saves a version naming both photos in `inputs.photos`
  that draws both cards where the draft had them, with the large copies signed from the library;
  the rows: the swap (`swapped`, `replaced` the stand-in's file, the engine's box) and the added
  card (`added`, no engine box), both with the words and the photo's description and tags. Then
  the library's Delete on a photo that version shows warns `Used in 1 version of your reels...`
  first, deletes it all the same, and the version's preview then shows `A photo in this version
was deleted from the library`. With `OWNER_EDIT_SHOTS` it keeps `photos-1-picker-open.png`,
  `photos-2-swapped-picture.png`, `photos-3-two-pictures-at-once.png` and
  `photos-4-delete-warning.png`.
- The guardrail (`test:tools`, `app_docs/export.md`): after the card past the frame's edge, the
  card's picture swapped for the library photo (its preview showing the signed large copy) matches
  its export at the bound, and a second card added over it (both on track 30 at once, the added one
  drawn last) matches too, while against the one-card previews it falls below the bound.

## Rules

- Never rewrite the version the owner edited: Save makes a new version after the current one.
- Never change anything but the place, the text size and the line breaks of the moved components,
  a moved VISUAL's box and turn, and a card's picture swapped for one of the owner's ready library
  photos: not a word, a time, a caption or a card's description. A line break changes only through
  a wrap width, on the engine's balanced lines; never stretch or squeeze letters to fill a box.
- Never trust a photo's size or ownership from the browser: the worker reads each photo a swap or
  an added card shows from the `photos` table with the service role (the reel owner's, `ready`,
  with a `large_key`, `supabasePhotoLibrary`) and writes its `width` and `height` itself; any other
  photo fails the job and no version is written.
- Never save a moved text outside the safe zone or in the buttons' notch. The studio settles every
  drag (`settleOwnerMove`) and the worker refuses the job. The safe zone is the one hard rule for
  text only: a VISUAL is free of it and of the notch, even past the frame's edge, but never with
  less than a fifth of the upright rectangle around it inside the frame (`VISUAL_MIN_SHOWN`); the
  studio settles a card's drag to that and the worker refuses one that breaks it.
- Never stretch a VISUAL: its height always follows its picture's aspect ratio (`boxHeight`), and it
  has no edge handles.
- Never turn a text: only a VISUAL has a rotate handle and a `rotation`; a text's move with a turn
  is refused.
- Never draw a turn in `transform`: the builder and the instant view write the `rotate` property,
  so the page's timeline keeps `transform`.
- Never read a turned card's place from its upright box for the frame rule or an overlap: read the
  rectangle around it (`visualBounds`, `rotatedBounds`).
- Never draw the draft with anything but the one builder: the editor's layer draws boxes and
  handles only, never text, and is never part of the built page or the export. The instant view
  only restyles the builder's own elements on the page on screen (their place, size and lines, from
  a page the builder built, or scaled from them while a corner is held), and a drop always ends on
  the rebuilt page's own values.
- Never make the owner wait for the rebuilt page to see a drag or a drop: the page on screen is
  restyled at once, and the swap that follows never moves anything.
- Never let the instant view write what the page's timeline animates (`transform`, `opacity`,
  `visibility`, `display`).
- Never write a QUESTION's words anew in the instant view: its lines change only by moving the
  page's own word elements, which its timeline reveals.
- Never set a QUESTION's lines on its words without its question mark: the engine, the builder and
  a re-wrap all read `questionText`.
- Never blank the preview for a draft: the player swaps the rebuilt page in only once it shows the
  same moment (`app_docs/preview.md`).
- Never read a component's box from anything but the builder's own boxes (`build`'s `components`).
- Never tie a move to how a component's variant draws its text: a move acts on the component's box.
- Never save an owner's version without its learning rows, nor the rows without the version: both
  go through `save_version` in one transaction.
- Never let the owner write, change or delete an `owner_moves` row; only `service_role` writes.
- Never keep `owner_moves` rows after their reel is deleted: `reel_id` cascades.
- Never call an AI model in an `owner_edit` job.
- Never let a swap or an added card show a photo that is not the reel owner's ready photo with a
  large copy: the worker reads them itself; the browser sends only ids.
- Never add a card over hidden footage or past the reel's end: its span is `ownerAddSpan`'s, from the
  word under the playhead for `OWNER_ADD_SECONDS`, cut short by either; the studio's button is off
  and the worker refuses one.
- Never give an added card a click within the click's gap of another sound (`sound-gap`).
- Never draw an added card under the cards already there: it goes to the end of the `behind` track,
  and the editor stacks its boxes in the page's order (`stackedAt`).
- Never move a caption with this editor.
- Never render the editor or queue an `owner_edit` job for a user whose `studio-owner-edit` flag is
  off: the page and `requestOwnerEdit` both evaluate it on the server.

## Notes

- A big word cannot be rewrapped: it is one or two words, and its schema has no `breaks`. Its corner
  handle still resizes it; it has no edge handles, and a wrap width on it is refused.
- A wrap width can only give whole lines. A top or bottom drag picks the nearest height the text
  can take, so the box can come out taller or shorter than the handle was dragged. A LIST's single
  wrap width applies to its lead-in and key phrase together; its number keeps its line.
- Not done yet: touch and phone (the button is hidden below `lg`), keyboard nudging, turning a
  text, deleting a card, timing changes (an added card always lasts 1.5 s), matching the picker's
  photos to the reel by their tags (it shows every ready photo), undo inside the editor (Cancel
  drops everything), and carrying the owner's moves into another font pair.
- A new version arriving while the editor is open (a job finishing) replaces the preview and closes
  the editor: the draft is lost. The moves are small, so this is accepted for now.
- Other docs this change touches: `app_docs/change-requests.md` (the list's `Edited by you`),
  `app_docs/edit-model.md` (`build`'s `components`, `edited_from_id`, `save_version`),
  `app_docs/preview.md` (the player's `overlay`, `controls` and `pause`), `app_docs/studio.md` (the
  job kind and the table), `app_docs/status.md` (the step's words), `app_docs/studio-reel-layout.md`
  (the control row), `app_docs/export.md` (the guardrail's case), `app_docs/failures.md` (Try again),
  `app_docs/font-pairs.md` (a re-layout does not carry the moves).
