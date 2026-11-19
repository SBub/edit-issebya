# The owner's edits: move and resize a text or a visual on screen, fix a text's words in place, turn a visual, and show pictures from the library

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
- Owner decisions, 2026-11-19 (the Edit mode):
  1. The button `Move text` is renamed `Edit`: the mode is for more than moving.
  2. Caption blocks are selectable like the other texts: the owner moves and resizes a block (the
     corner handle, and the edge handles as a text has them) for the whole time of that block, one
     sentence's captions. The earlier rule "captions are not moved" is gone.
  3. Fix words in place: on a selected text (an accent, a question, a big word, a list's lead-in or
     key phrase, the hook, a caption block) the owner edits its text inline (a double-click on the
     text, or the small `Edit text` control on the selection; Enter or a click outside ends the
     edit, Escape cancels it). The box keeps its place and its text size; the text is wrapped again
     inside the box's width and the box grows downward when it needs to; the owner can resize it
     after. Text stays bound to the safe zone and the existing checks apply. The engine places
     nothing again: the human places it. The earlier rule "never its words" is gone.
  4. A fix changes only the element edited. The same spoken word in another element (an accent, the
     hook) keeps its text. The curator's `word_fixes` apply everywhere; the owner's text edit is per
     element.
  5. Timing stays tied to the spoken words: the edited text is spread over the element's same
     spoken words in order (the rule `reveal.ts` uses for a text with another word count), so the
     word-by-word entrance still follows the voice and the time on screen never changes. The hook
     has no spoken words: its text just changes, its window kept, and the new text is typed
     letter by letter like any hook (`hook/typed`), with its caret and its key sounds.
  6. Text edits are saved with Save in the same `owner_edit` job, into a new version `Edited by
you`, like moves, and each one leaves a learning record (the text before, the text after, the
     element, its spoken words) beside the move records.
  7. Limits: no element is added or deleted and no time changes. A text may be at most three times
     the characters of the text it replaces (never fewer than 40 allowed, never more than the
     format holds), and an empty text is refused; each with a clear message.
- Owner feedback, 2026-11-19 (after the first Edit mode build):
  1. The owner's text for a big word follows only the general length limit; the "one or two plain
     words, at most 24 letters" rule stays the AI answer's alone.
  2. A question always keeps its question mark (confirmed).
  3. A font pair change and a Start over must not lose the owner's work: text fixes and places are
     carried (rules in "What later steps do with an owner's version"), and an edit that cannot be
     kept is noted, never dropped silently.
- Owner decisions, 2026-11-19 (option 1, which replaces item 3 for a Start over):
  1. A text fix made on a caption is a transcript correction: kept per spoken word for the reel
     (she wins over the transcript and over the curator's word fixes) and lasting through any
     processing again. The version she saved shows the fix only where she typed it.
  2. Every rebuild uses the corrected transcript: a font pair change and a Start over build from
     it, the captions show the corrections, the AI calls of a Start over (the hook and the
     components) read the corrected words, and elements placed on a corrected word show them.
  3. A fix typed into an accent, a question, a big word, a list or the hook stays on that element
     only and is never a correction.
  4. Start over carries no place, size or element text and not the hook's text (the AI picks
     afresh): only the corrections, and the cards she added by hand.
  5. A font pair change keeps her moves, sizes, caption block moves and element text fixes, plus
     the corrections.
  6. The learning record of a text fix keeps the text before and after (`owner_texts`).

## Overview

On a reel's page the owner presses `Edit`, selects a text component on the paused preview (an
accent, a question, a big word, a list or the hook) or a VISUAL card, drags it to move it, drags its
corner handle to resize it, (a text) drags an edge handle to make its box wider, narrower, taller
or shorter or (a VISUAL) drags its rotate handle to turn it, and presses Save. Save queues an `owner_edit` job; the worker applies the moves to the
version and saves the result as a **new** version titled `Edited by you`. The version the owner
edited stays as it was, and going back works as for any version.

A move changes only the place, the text size and, through an edge handle, the line breaks of a
component. A text edit (below, "A text edit") changes the words of one element and nothing else.
Never a component's time on screen or what its variant draws inside its box. An edge handle never
stretches letters: the text keeps its size and is set again on more or fewer lines. A component has one box for its whole time on screen
(not one per frame), so a move moves it for all of it. A VISUAL's box moves and scales: its picture
and its time stay, and its height always follows its picture's aspect ratio, so a card is never
stretched. A VISUAL also turns about its box's centre, by any angle in whole degrees; a text never
turns. The captions of one spoken sentence are one block (`Captions`): the block moves, resizes
and re-wraps as one box for the sentence's whole time, like any text; a single caption is never
moved on its own. There is no delete and no timing change.

A card's picture can be one of the owner's library photos (`app_docs/photo-library.md`): `Change
picture` swaps a selected card's stand-in (or earlier photo) for one, and `Add picture here` adds a
new card showing one at the paused moment, on top of the cards already there. The worker trusts
only the photo's id from the browser: it checks the photo is the reel owner's and ready, and reads
its size itself.

The owner also fixes words in place: a double-click on a text (or `Edit text` on the selected one)
opens a field over it with its words; Enter or a click outside keeps the owner's text, Escape
drops it. Only that element changes: its box keeps its place and its text size, the text is
wrapped again inside the box's width, and its time and its spoken words stay, so it still comes
in with the voice. Each text edit leaves a learning record in the `owner_texts` table.

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
- A caption block (`packages/edit/src/caption-blocks.ts`) is one more component, after the single
  captions in `components`: `component` `CAPTION`, its id `block_<its first caption's id>` (an
  underscore, which no item id holds, so a block is never taken for an item), its text the
  sentence's captions joined, its `size` theirs, its box the box around them, its time from its
  first caption's start to its last group's end, and `parts`: its groups (`ComponentPart`: the
  captions on screen together, with the group's own box and time, `items` its captions' ids).
  `isCaptionBlock` tells a block from a single caption (only a block has `parts`). The stored edit
  holds no block: `captionBlocks(edit, transcript)` reads it back the way the engine made it
  (`placeCaptions`): a group is a run of consecutive captions ending on the same moment, counted
  over the captions that show and have a place (one a text shows in its place, `hidden_by`, takes
  no room), and a block is the groups whose first caption's first word is in the same spoken
  sentence (`sentenceSpans`).
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
- A caption block's move is a text's move with the block's id (`movedBlock`). A move that only
  moves carries every caption of the sentence with the box. A new size lays the block again from
  the move's corner on its own lines, exactly as the engine lays a block (`layBlock`: the block as
  wide as its widest line, every line centred in it, the lines `caption.lineGap` apart, each
  caption after the ones before it on its line), every caption at the new size. A wrap width sets
  each group again on the fewest balanced lines that fit it, between whole captions (`wrapGroup`;
  a caption is never cut, so a caption wider than the width keeps its line). Its words, its text
  and its times stay; the captions a text shows in their place are left as they are.
  `ownerSizeRange` gives a block a text's range (30 to 400 px), `ownerWrapOptions` every width at
  which one of its groups changes lines, and `settleOwnerMove` and `ownerMoveProblems` bind it to
  the safe zone like any text.
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
- It refuses, with reasons: an id that is no text component of the edit (a single caption is not
  moved, only its block; a block id that names no block: `not a caption block of this version`), a
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

### A text edit (`packages/edit/src/owner-text.ts`)

- `OwnerText` is `{ id, part?, text }`: the component's id (a caption block's is its block's), the
  part edited where the component has parts (`part`: a LIST's level, `lead` or `key`; a caption
  block's group, by its first caption's id) and the owner's text. A LIST's number is not a text
  the owner edits. `PlacedComponent.parts` lists a caption block's groups and a LIST's lead-in and
  key phrase, each with its own box and time.
- **The stored format is the edit's own text fields**, so no new field and no new format: an accent,
  a question or the hook gets `text` (an accent or a question keeps its `words`; the builder has
  always drawn an overlay's `text` in place of its words' text, and `wordReveal` has always spread
  such a text over the spoken words); a big word its `text`; a LIST's level its `text`; a caption
  its `text` (the field the curator's word fix writes). A version saved before text edits has
  none of the owner's texts and builds byte for byte as before.
- `cleanOwnerText(raw)`: the text as stored: every run of white space (a line break included) one
  space, none at the ends, no control character.
- `ownerTextLimit(original, formatMax)`: how long a text that replaces `original` may be: three
  times its characters, never fewer than 40 (so a short text can still be rewritten), never more
  than the format holds (200 characters; a list's level 300). `original` is always the text of
  the version being edited, never an earlier draft's, so the limit does not grow edit after edit.
- `ownerTextOf(edit, { id, part })`: the text the element shows now (a question's with its mark, a
  caption group's captions joined) and its limit; null for anything that is no text (a VISUAL, a
  single caption, a list's number).
- `ownerTextProblem(edit, text)`: why a text cannot replace the element's, in the owner's words:
  `A text cannot be empty`, `This text can be at most N characters (it has M)`, `This text cannot
be edited`. A big word has no rule of its own for the owner (owner feedback, 2026-11-19: she
  adapts the size herself): any text within the general limit. The "one or two plain words of at
  most 24 letters" rule is the AI answer's (`decide.ts`) and stays there.
- `applyOwnerTexts(edit, texts, context)` returns the edit with the text edits applied and nothing
  else changed. The element's box is read from a build (like every box); the text is wrapped again
  inside that box's width on the engine's balanced lines (`wrapToWidth`), a word never cut, so the
  box grows downward when the text needs more lines and wider only for a word wider than the box:
  - an accent, a question or the hook: its `text` and `breaks`; the box's top stays and its lines
    stay centred where they were (a question, set left-aligned, keeps its left edge; its mark is
    added when the owner's text has none, never doubled);
  - a big word: its `text` and, when the text needs more than one line inside the word's width,
    its `breaks` (the stored big word takes any text up to 200 characters and optional `breaks`;
    the builder draws its lines centred, measured line by line), its top and centre kept, its
    `words` and time as they were; the worker decides its cut-out again;
  - a LIST's lead-in or key phrase: that level's `text`, that level alone wrapped to the list's
    width (`restack` with the one role; the other level keeps its lines, the number its line), the
    levels stacked again on the list's centre line;
  - a caption block's group (`captionsWithText`): the text's words are spread over the group's
    captions in order (`spreadWords`: as many words as captions, one each; else word i goes to
    caption floor(i x captions / words), the reveal's own rule). A caption given two words shows
    both on its one spoken word. A caption left with no word goes: its spoken words join the
    caption before it, which shows on the first of them, so no spoken word is lost and no time
    changes (the group still starts on its first word and ends where it ended). A caption whose
    text is its words' own keeps no `text`. The edited group is wrapped to the block's width
    between whole captions and the block laid again on its centre line with its top kept; when
    the block is as wide as it was, the other groups' captions are left byte for byte.
- It refuses, with reasons: an element that is no text of the edit (`not a text of this version`),
  a part that is none, an empty text, a text over its limit, a big word that is no big word, an
  element edited twice.
- `effectiveTexts(texts, edit)` leaves out an edit whose text is what the element already shows.
- **Timing.** A text edit writes no anchor and no word id beyond joining a caption that lost its
  word to the one before it. The builder then reveals the element as before: `wordReveal` spreads
  the shown words over the element's spoken words in order, so more words than spoken come in
  together on their spoken word and fewer come in on the first of theirs. The hook, which nobody
  says, is typed as before: `hookReveal` spreads the letters of the new text over the first 60% of
  its window, each but the last with its caret, and `soundCues` puts the key sounds in step with
  them, in the preview and in the export alike (app_docs/edit-model.md).
- **Scope.** Each edit names one element and writes that element only. A caption that shows the
  same spoken word, an accent on it, the hook: none is touched. The curator's `word_fixes` are
  the engine's and apply to every element of the word; the owner's text edit is never turned into
  one.
- `parseOwnerTexts(json)`: a job's text edits as they arrive (untrusted): absent is none; else at
  most 200 (`OWNER_TEXTS_MAX`), each an id, an optional part and a clean text of at most 300
  characters, no element twice; null otherwise.
- `ownerTextRecords(...)` builds the learning records (below).

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
  `sound-gap` check holds. That cue plays the pop, like
  every visual's (`cueSound`, `app_docs/edit-model.md`). Refused with reasons: an id already in the edit, a photo not in
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

- `isMovable` (`MOVABLE_COMPONENTS`): the five text kinds, `VISUAL` and a caption block (never a
  single caption).
- `src/components/ReelPreview.tsx` (`BuiltPreview`): the `Edit` button (`data-testid="edit-toggle"`,
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
  never the layer; a caption block: each of its captions, a caption's line set at the new size
  with the gap between lines kept, as the block is laid; a turned card about the corner it shows
  at its top left), and a VISUAL's turn
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
  follow it. An accent's and a caption's
  words are elements of their own too (`<item>_wK`; `app_docs/edit-model.md`, "The word-by-word
  entrance"), read and set the same way. So the text is where it was dropped on the very next frame, and the rebuilt page swaps in
  later with nothing moving. A patch never writes what the page's timeline animates (`transform`,
  `opacity`, `visibility`, `display`), so the moment on screen stays the timeline's. A drop that
  changes nothing or is refused drops the patch, and Cancel restyles the page back the same way.
  Measured in `owner-edit.spec.ts` on the local stack: pointer up to the final position took 160 to
  192 ms before (the swap), 6 to 11 ms after (the next frame). A turn goes the same way.
- `src/components/MoveLayer.tsx`: the layer over the frame (`data-testid="move-layer"`), given to
  `PreviewPlayer` as its `overlay`.
  - A bar on top (`move-bar`), as tall as the frame's top margin, which the platforms cover and no
    text sits in: the list (`move-pick`, a `select` named `Text or visual to edit`, first line
    `Pick a text or visual`, one line per movable component, `Kind: text`; a VISUAL's text is its
    description), `Cancel` (`move-cancel`) and `Save` (`move-save`, off until
    something is moved).
  - A box (`move-box`, `data-component-id`, `data-component`) around each movable component on
    screen at the paused moment: dashed until selected. Clicking it selects it; the selected box
    (`data-selected`) shows its kind above it (`move-kind`: `Accent`, `Question`, `Big word`, `List`,
    `Hook`, `Visual`, `Captions`), a corner handle (`move-handle`) at its bottom right and, for every text but a
    big word (`canRewrap`; never a VISUAL), four edge handles (`move-edge`, `data-edge="left|right|top|bottom"`) at the
    middle of its edges. A VISUAL's box instead has a rotate handle (`move-rotate`, a round handle
    on a short stem above the middle of its top edge), and its kind shows below it. A turned card's
    box turns with it (`rotate` on the box, `data-rotation` its degrees), handles included. A
    caption block has one box for its sentence (`data-component="CAPTION"`,
    `data-component-id="block_..."`), with the corner handle and the four edge handles; its single
    captions have no box.
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
    track's order, then the caption blocks, then the other texts), so where two overlap the
    topmost box takes the click, the added card over the engine's, and a text inside a sentence's
    box over that box.
  - An inline text edit (`TextField` in `MoveLayer.tsx`): a double-click on a text's box, or `Edit
text` (`move-edit-text`, beside the kind above the selected box; never on a VISUAL), opens a
    field over the text's box (`move-text-field`; the input `move-text-input`, named `Text of this
<kind>`, at least 55% of the frame wide) holding the words the element shows in the draft, all
    selected. The part edited is `textPartAt`'s: a caption block's group on screen at the paused
    moment (the nearest in time when none is), a LIST's level under the pointer (its key phrase
    from `Edit text` or on the number), the whole text otherwise. Under the field a line reads `N
of M characters. Enter to keep, Esc to cancel` (`move-text-count`); the input's `maxlength` is
    the limit, so a text too long cannot be typed. Enter or a click outside the field ends the
    edit and sends the text (`onText`); Escape ends it with nothing sent. While the field is open
    no box is dragged. The field is the editor's own and never part of the built page.
  - Picking a text from the list selects it and seeks the preview to a moment where it shows whole
    (`showMoment`: 0.4 s before its end, or its middle when it is shorter than 0.8 s).
  - A status line at the bottom (`move-status`): `Saving your changes`, `This text does not fit
there`, why a text was refused (`A text cannot be empty. The text stays as it was`), or why a
    save did not start.
- `ReelPreview.tsx`, `editText`: the end of an inline edit. The text is cleaned
  (`cleanOwnerText`) and checked against the version's own text (`ownerTextProblem`); a refused one
  shows its reason and changes nothing. The draft's edit is then made again from the version in
  the worker's own order (`draftEdit`: the added cards, the text edits, the moves), so what shows
  is what Save saves. A box the longer text pushed out of the safe zone is settled like a drag
  (`settleOwnerMove`, the move kept in the draft). The draft's page is built and swapped in like
  after a drag. A text put back to the version's own is no edit (`effectiveTexts`). A move of an
  element whose text the owner edited always stays in the draft (`keptMoves`), as its box is no
  longer the version's. The instant view shows a fixed word at once: a word of a caption, an
  accent or a question is an element of its own, and the page on screen sets that element's text
  (`changedElements` names it, `restyle` writes it), so the page's timeline still reveals the
  same element. A text with another number of words shows whole only once the rebuilt page is
  swapped in, a few hundred milliseconds later.
- `src/lib/owner-edit.ts`: the editor's logic with no DOM in it: `canEditText`, `textPartAt`,
  `textBox`, `componentLabel`,
  `movableComponents`, `movableAt`, `componentOption`, `showMoment`, `canRewrap`, `resolveAsk`,
  `resizeShare` (the direction the
  handle moved further in, as a share of the box), `draggedBox`, `moveOfDrag`, `snapDrag` (a move drag with its centre snapped to the centre lines),
  `scaledVisual`, `snapAngle`, `turnOfPointer`, `draggedTurn` (the turn a card shows while dragged),
  `withMove`, `boxStyle`.
- Save calls `requestOwnerEdit` (`src/app/change-actions.ts`): it checks the shape of the moves
  (`parseOwnerMoves`), refuses when the `studio-owner-edit` flag is off for the user, refuses a blocked reel like going back does (`changeBlockedReason`, which includes a reel that is exporting: `Edit` cannot be opened then, and an open editor is frozen with the reason and keeps its draft, `app_docs/export.md`) and inserts
  the job `{ kind: "owner_edit", owner_edit: { version_id, moves, adds?, texts? } }` under RLS (`adds`
  only when the owner added a card, `texts` only when the owner edited a text, checked with
  `parseOwnerTexts`; `moves` may then be empty). The browser never sends a photo's
  size. The editor then waits
  for its job (`jobs` from `LiveReel`): the progress overlay shows `Saving your changes`, the new
  version replaces the preview by itself like any new version, and the editor closes. A failed job
  leaves the draft open with `Your changes were not saved. Try again`.
- Cancel (or `Edit` again) drops the draft and shows the version as it was. Nothing is queued.
- `src/components/VersionList.tsx`, `src/lib/change-requests.ts`: a version with `edited_from_id`
  reads `Edited by you` (`versionOrigin`, `versionTitle`; the row carries `data-edited`), and its
  details add `You moved, resized or edited text in vN` (`editedFromLabel`, `version-edited-from`). A going
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
- `supabase/migrations/20261119114356_owner_caption_moves.sql` (a new migration):
  `owner_moves_component_check` accepts `CAPTION` (a caption block's row; its `item` is the
  block's id). The grants are restated per role.
- `supabase/migrations/20261119115900_owner_text_edits.sql` (a new migration):
  - `jobs_owner_edit_shape_check` is replaced: `{ version_id, moves, adds?, texts? }`, texts an
    array of 0 to 200, at least one move, card or text in total. The column comment names the
    texts.
  - `owner_texts`: the learning table of the text edits (below), with RLS on and each role granted
    explicitly: `authenticated` selects its own rows, `service_role` everything, `anon` nothing.
  - `save_version` gets one more parameter with a default, `p_owner_texts`, written to
    `owner_texts` in the same transaction as the version and its `owner_moves` rows. A new
    parameter is a new signature, so the old function is dropped first (never an overload) and the
    grants are stated again: the service role only. Text rows without `p_edited_from_id` are
    refused (`owner texts need the version they were made on`).
- `apps/worker/src/job-kinds.ts`: `owner_edit` runs `runners.owner_edit` with the parsed payload
  (`parseOwnerEdit`: a version id, moves, optional adds and optional texts, at least one in all);
  any other payload fails the job.
- `apps/worker/src/owner-edit.ts`, `runOwnerEdit`, one step `owner_edit`, no AI call:
  1. Reads the version the job names (it must be one of the reel's), its transcript and head track,
     and builds it for its components.
  2. Reads every photo a swap or an added card names from the `photos` table with the service role
     (`supabasePhotoLibrary(db).readyPhotos(job owner, ids)`: the reel owner's, `ready`, with a
     `large_key`, a width and a height); one that is not fails the job (`photo <id> is not a ready
photo in the owner's library`). The photo's size in the version is the row's.
  3. Applies the added cards (`applyOwnerAdds`), then the text edits that change a text
     (`effectiveTexts`, `applyOwnerTexts`; a refused one fails the job: `the texts are refused:
...`), then drops the moves that change nothing (a move of an element whose text was edited
     always counts); no move, no card and no text fails the job (`nothing was moved, resized or
edited`).
  4. Applies the moves, decides each moved big word's cut-out again and builds the result with the
     edited version's engine record. A text that breaks the safe zone (moved, or grown by a text
     edit), or a card with less than a
     fifth of it in the frame, fails the job (`the moves are refused: ...`; refused cards: `the
cards are refused: ...`). All of these are permanent failures, and no version is written.
  5. Finds the engine-placed version the edits started from (`enginePlaced`: back through
     `edited_from_id` and `restored_from_id`) and reads the engine's boxes from it.
  6. Makes the masks a moved big word now needs (`ensureCutouts`; the cache reuses the rest).
  7. Copies the edited version's AI record under the new version's id (so a later re-layout finds the
     same answer) and saves the version: parent the current version, `edited_from_id` the edited
     one, `engine_record` the edited version's, the build's `checks`, no title and no summary, and
     the learning records of the moves and of the text edits (`ownerTextRecords`).
- The step summary reads `version N: M components moved by the owner, from version K`, with `and
T texts edited` after `moved` when texts were edited.
- `apps/worker/src/version-store.ts` reads `edited_from_id` and `engine_record` with a version and
  passes the two new parameters to `save_version`.

### The learning data (`owner_moves`)

One row per component moved, resized, turned or swapped, and per card added, in one save, written by
`save_version` with the version.

| Column                                 | What it holds                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`, `reel_id`                  | whose move, on which reel                                                                                                                                                                                                                                                                                                  |
| `version_id`, `from_version_id`        | the owner's version, and the version the owner edited                                                                                                                                                                                                                                                                      |
| `engine_version_id`                    | the engine-placed version the engine's box was read from                                                                                                                                                                                                                                                                   |
| `item`, `component`, `variant`, `text` | the item id (a caption block's `block_<first caption>`), `ACCENT`, `QUESTION`, `BIGWORD`, `LIST`, `HOOK`, `VISUAL` or `CAPTION` (a caption block), the variant entry the engine placed it with (`accent/above-head`; a block's is its captions', `caption/default`), its text (a VISUAL's description; a block's sentence) |
| `start_seconds`, `end_seconds`         | its time on screen                                                                                                                                                                                                                                                                                                         |
| `engine_box`                           | where the engine placed it: `{ x, y, width, height, size }`; null for a card the owner added                                                                                                                                                                                                                               |
| `owner_box`                            | where the owner put it, the same shape                                                                                                                                                                                                                                                                                     |
| `moved`, `resized`                     | which of the two differs: a new corner is a move; a new size, or a box of another width or height (its lines set again), a resize                                                                                                                                                                                          |
| `rotated`                              | a VISUAL turned: its turn differs from the engine's                                                                                                                                                                                                                                                                        |
| `engine_rotation`, `owner_rotation`    | the engine's turn (always 0: the engine never turns a card) and the owner's, whole degrees clockwise (-179 to 180); 0 and 0 for a text. `engine_box` and `owner_box` are the card upright                                                                                                                                  |
| `added`                                | a card the owner added (`owner-visual-N`): no engine box, `moved`, `resized`, `rotated` and `swapped` false                                                                                                                                                                                                                |
| `swapped`                              | a card whose picture differs from the engine's: the owner swapped it for a library photo                                                                                                                                                                                                                                   |
| `photo_id`                             | the library photo the card shows (a plain id: the row outlives the photo); null for a text or a card without one                                                                                                                                                                                                           |
| `replaced`                             | what a swap replaced: the picture of the version edited when it differs (the stand-in's file or the previous photo's id), else the engine's; null without a swap                                                                                                                                                           |
| `wrap_width`                           | the wrap width an edge handle set, in frame pixels at the owner's size; null when the version's lines were kept                                                                                                                                                                                                            |
| `context`                              | the moment (below)                                                                                                                                                                                                                                                                                                         |

`context` is `{ frame, font_pair, head, engine_zone, words, photo, others }`: the frame's size, the
font pair, the head over the component's time (the box around the robust faces of the head track,
`facesOver`; null with no head), the zone the engine took for it (from its engine record), the words
spoken while it shows (the transcript's, joined by spaces), the photo it shows as the library
described it then (`{ description, tags }`, a snapshot quoted as data; null without a photo), and
everything else on screen during its time (`{ item, component, text, start, end, box, rotation?,
moved_by_owner }`, captions and cards included, each where the owner's version has it; `rotation`
only for a turned card; an added card counts as moved by the owner). The captions are listed one
by one where they are, never a block's box on top of them, and a block's own captions are left out
of its record.

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

### The learning data of text edits (`owner_texts`)

One row per text edited in one save, written by `save_version` with the version, beside the
`owner_moves` rows.

| Column                          | What it holds                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `owner_id`, `reel_id`           | whose edit, on which reel                                                                                                     |
| `version_id`, `from_version_id` | the owner's version, and the version the owner edited                                                                         |
| `item`, `part`                  | the element's id (a caption block's `block_<first caption>`) and its part: `lead` or `key`, a group's first caption, or empty |
| `component`, `variant`          | `ACCENT`, `QUESTION`, `BIGWORD`, `LIST`, `HOOK` or `CAPTION`, and the variant entry the engine placed it with                 |
| `before_text`, `after_text`     | the text of the version edited, and the owner's (a question's with its mark); never empty, never the same                     |
| `words`, `word_ids`             | the spoken words the text is tied to, as the transcript has them, and their ids; empty for the hook                           |
| `start_seconds`, `end_seconds`  | its time on screen, which a text edit never changes                                                                           |
| `context`                       | `{ frame, font_pair, size, before_box, after_box }`: the element's box before the edit and in the saved version               |

A sibling table and not more columns on `owner_moves`: a move's row compares two boxes and always
has both, a text edit's row compares two texts and often has no move at all. Like `owner_moves`
it is written in the version's transaction, its rows go with their reel (`reel_id` cascades, so
`delete_reel` removes them) and with the owner's account, `authenticated` only reads its own rows
(RLS `owner_texts: owner selects own`), `anon` nothing, and only `service_role` writes. One row
per element and part and save (`unique (version_id, item, part)`).

```sql
select component, before_text, after_text, words
from owner_texts
order by created_at;
```

### What later steps do with an owner's version

- Every outcome is a new version; nothing rewrites one (`app_docs/edit-model.md`). So Start over, the
  automatic decide, a font pair change and a going back all leave the owner's version in the list,
  with its bytes and its learning rows as they were.
- **A caption fix is a transcript correction of the reel** (owner decisions, 2026-11-19, option 1).
  A text the owner types into a caption says what was really spoken, so it is kept for the reel,
  not only in the version (`packages/edit/src/owner-corrections.ts`, the `owner_word_corrections`
  table below):
  - on Save the worker compares the captions of the version edited with the owner's
    (`captionCorrections`): each caption whose text or words changed gives one correction per
    spoken word it covers. Its first word gets the caption's text, each other word an empty text
    (a word the owner's caption no longer shows: she typed fewer words than were spoken). A
    caption she did not change gives none, so a correction is only ever what she typed. A fix
    typed into an accent, a question, a big word, a list or the hook is that element's only and
    is never a correction;
  - the corrections are written per spoken word, with the word as the transcript had it, before
    the version is saved (`apps/worker/src/word-corrections-store.ts`, an upsert: a later fix of
    the same word replaces the earlier one, and a retry writes the same rows again). The version
    the owner saved shows the fix only where she typed it, exactly as she saw it in the editor;
  - every rebuild reads the reel's corrections (`liveCorrections`: only those whose word is still
    in the transcript with the text it was corrected from, so a reel processed again from other
    words keeps none by accident) and builds from the corrected transcript. The owner wins over
    the transcript and over the curator's `word_fixes` (`withWordCorrections` replaces the
    curator's fix of a corrected word). The engine then writes every caption and every list
    phrase placed on a corrected word with her text, and `applyWordCorrections` marks those
    captions as hers (`edit.owner.texts`, so they are never counted as the curator's words
    fixed), makes a caption she typed over several spoken words one caption again (`relaidBlock`
    inside its block), and writes an accent, a question or a big word placed on a corrected word
    with the corrected words, wrapped inside its box, with no mark (the text is the reel's, not
    that element's). The hook is never touched: it is the AI's written line, not spoken words. A
    caption run that cannot be one caption in the new placement (a text on screen hides part of
    its words) is a note (`rule` `owner-edit`, `outcome` `dropped`), its first word still showing
    her text;
  - on a Start over and on the automatic decide the AI reads the corrected transcript too
    (`correctedTranscript`): in the hook's call and in the components' script each corrected word
    says her text inside the spoken word's punctuation, a word her caption does not show is left
    out (its sentence end moved to the word before it), and every word keeps its id and times.
- **A font pair change keeps the owner's work** (owner feedback, 2026-11-19). It places the same
  AI answer again in another pair, with the corrections, and must not lose what she did by hand.
  Her version says what that is: `edit.owner` (`packages/edit/src/owner-marks.ts`), `{ placed,
texts }`, the ids of the items she placed (`applyOwnerMoves` marks each moved item; a moved
  caption block: each of its captions) and of the texts she wrote (`applyOwnerTexts`; a list's
  level is `<id>/<role>`), sorted, each once. A version she never edited has no `owner` field and
  is placed exactly as before. `carryOwnerEdits(from, placed, context)`
  (`packages/edit/src/owner-carry.ts`) carries each mark onto the new placement, found by its id
  (the same answer gives the same ids), and marks it again, so the next change carries it too:
  - a text of an accent, a question, a big word, a list or the hook: written on the element again
    (`applyOwnerTexts`, bound only by the format's length: it was within its limit when written)
    and wrapped inside the element's box in the new font. A caption's text is not carried from
    the version: it is the reel's correction, already on the placement;
  - a place: the owner's box keeps its top and its centre line (a question its left edge) and its
    text size (the styles' base sizes are the same in every pair, so the owner's size relative to
    the base is her size in pixels); its lines are set again to the owner's box width in the new
    font, when that width gives the owner's own lines back in the owner's font (a list or a
    caption block can hold a level or a group on more lines than its width needs, which is the
    engine's choice and is made again). A caption block is found by its sentence (the block
    showing most of the same spoken words). The box is then settled (`settleOwnerMove`): one that
    no longer fits the safe zone is moved in, or made smaller, the least it must, with a note in
    the engine record (`moved` or `shrunk`), never dropped. A VISUAL's box and turn do not depend
    on the font and are kept as they were; a moved big word's cut-out is decided again. The
    owner's pictures are kept as before (`app_docs/font-pairs.md`, "The relayout job":
    `ownerPictures`, `keepOwnerAdds`);
  - each edit that cannot be kept is one note in the new version's `engine_record`: the old item's
    id, its component, `rule` `owner-edit`, `outcome` `dropped`, and a reason in plain words
    (`your text "..." could not be kept: the new version has no accent on the same words`). The
    step's line counts the corrections shown and the edits carried together: `, 3 of your edits
kept, 2 of your edits could not be kept`.
- **A Start over keeps only the corrections** (owner decisions, 2026-11-19, option 1). It is a
  fresh AI answer: no place, no size, no caption block move and no element text of the owner's
  version goes with it, and not the hook's text; the AI picks everything again from the corrected
  transcript and the captions show her corrections. The cards she added by hand (`Add picture
here`) are kept as they were (`keepOwnerAdds`, the reel's current version read beside version
  1), since no answer can place them again. Nothing is noted as kept or lost; the step's line says
  `, N word corrections of yours kept` (and `, M word corrections of yours could not be kept`).
  The owner's own version stays in the list with everything in it.
- Going back to the owner's version copies its bytes: the moved texts and cards, the fixed words
  and the marks come back.
- Export renders the owner's version like any version (`app_docs/export.md`).

### The reel's transcript corrections (`owner_word_corrections`)

One row per spoken word the owner corrected in a caption, per reel (migration
`20261119154434_owner_word_corrections.sql`). No pipeline step writes it, so a reel processed
again (transcribe and retime caches included) keeps it.

| Column                     | What it holds                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `reel_id`, `word_id`       | the reel and the spoken word's id in its transcript (`w0004`); the primary key, so one row per word   |
| `owner_id`                 | whose correction                                                                                      |
| `text`                     | what her caption shows for the word; empty: the word joined the caption of the word before it         |
| `original_text`            | the word as the transcript had it: the correction holds only while the transcript still has this text |
| `created_at`, `updated_at` | when the word was first corrected, and last                                                           |

The learning record of each fix (the text before and after, per save) stays in `owner_texts`; this
table holds only the reel's current corrections. RLS is on: `authenticated` only reads its own rows
(`owner_word_corrections: owner selects own`), `anon` nothing, and only `service_role` (the worker's
`owner_edit` job) writes. The rows go with their reel (`reel_id` cascades, so `delete_reel` removes
them) and with the owner's account.

```sql
select word_id, original_text, text
from owner_word_corrections
where reel_id = '<reel>'
order by word_id;
```

## How to Use

1. Open a reel in the studio on a desktop and wait for the preview.
2. Press `Edit` under the preview. The preview pauses and a bar appears on top of it.
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
6. To fix a word, double-click the text (or select it and press `Edit text` above its box). A
   field opens over it with its words. Type the text and press Enter, or click outside the field;
   press Esc to leave it as it was. Only that text changes: the same word in a caption, an accent
   or the hook stays. The text keeps its place and size and is set on more lines when it needs
   them; resize or move it after if you want. On a caption block the field holds the captions on
   screen at the paused moment; on a list, the level you double-clicked (the key phrase from
   `Edit text`). A text cannot be empty, and can be at most three times as long as it was (40
   characters at least).
7. Press `Save`. A new version, `Edited by you`, becomes current. Press `Cancel` to drop the changes.
8. To compare, open another version's details in the Versions list and press `Go back to this`.

## Configuration

The whole editor sits behind the PostHog feature flag `studio-owner-edit`, which gates the owner's
editor (`app_docs/feature-flags.md`). It is evaluated on the server for the signed-in user:
off, the reel page renders neither the `Edit` button nor the editor, and `requestOwnerEdit`
refuses (`Editing is not available yet`) before anything is queued. PostHog unconfigured, slow or
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
  spoken (`revealShownAt` at the middle of each word), the mark only with the last word; the
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

- Caption blocks. `packages/edit/src/caption-blocks.test.ts` (unit): every shown caption in one
  group of one block, each group ending on one moment, the blocks in time order; a block as a
  component of the built page (its box around its captions, its parts); a block laid from its
  corner on its stored lines exactly where the engine put its captions; a block moved (every
  caption by the same amount, nothing else changed), resized about its corner on the same lines,
  set on more lines by a narrower wrap width with its words and times kept, settled at the safe
  zone's edge and named when it leaves it; a single caption and a block id that names none
  refused; left out when it changes nothing, and recorded as `CAPTION` with the engine's box, the
  captions' variant and zone, its own captions not among the others. `apps/worker/src/owner-edit.test.ts`:
  a block moved, every caption of the sentence shifted and nothing else, recorded as `CAPTION`
  against the engine's box, and refused past the safe zone. `apps/studio/src/lib/owner-edit.test.ts`:
  a block listed as `Captions` (never a single caption), moved, resized and re-wrapped like a
  text. `live-page.test.ts`: a block's elements are its captions, moved by a drag and scaled about
  the block's corner with the gap between lines kept. `apps/studio/db-tests/owner-edits.test.ts`:
  a `CAPTION` row saved, an unknown component refused.
- `apps/studio/e2e/owner-edit-captions.spec.ts` (`yarn test:e2e`, the fixture clip with the
  QUESTION, whose first four words show as the captions "this is a short"): the button reads
  `Edit` and the list is named `Text or visual to edit`; the block is one line of the list
  (`Captions: this is a short`), selected as `Captions` with a corner handle and four edge
  handles, no box for a single caption; a drag moves all four captions on the pointer at every
  step, at the drop straight after pointer up while the draft is `swapping`, and the same once
  swapped in; the corner handle scales every caption while held, the block's corner kept; the
  right edge handle held in by half sets the captions on more lines at the same size, kept at the
  drop and after the swap. Save queues one move with the block's id and a wrap width, the worker
  saves the version, the preview draws the captions where the owner left them, and the learning
  row is `CAPTION`, `caption/default`, moved and resized, with both boxes and its wrap width. With
  `OWNER_EDIT_SHOTS` it keeps `captions-1-selected.png` to `captions-4-saved.png`.
- Carrying the owner's work. `packages/edit/src/owner-carry.test.ts` (unit): into another font
  pair, every element text fix and every place kept (the box's top, centre line and size; nothing
  outside the safe zone) on a placement made with the reel's correction, the marks carried and
  carried again by a second change; a caption's text never carried from the version (without the
  correction the caption says its spoken word); a version the owner never edited left as the
  engine placed it; a hook as large as the safe zone allows moved in or made smaller in three
  other pairs, noted and never dropped. `schema.test.ts`: a big word takes an owner's longer text
  with `breaks`. `apps/worker/src/owner-edit.test.ts`: a font pair change after the owner's edits
  keeps the accent's text, size and top, the caption fix (from the reel's corrections), the
  block's top and the hook's text, with the marks, no dropped note and the step's line (`N of your
edits kept`), and a second change carries them again; the captions are written from the reel's
  corrections, never from the version's own caption texts (a newer correction wins, and with none
  the captions say the spoken words); a version never edited gets no such line.
- Transcript corrections. `packages/edit/src/owner-corrections.test.ts` (unit): a save's
  corrections are the one caption the owner's text changed, by its spoken word; a word her caption
  no longer shows gets an empty text; another element's fix gives none; only corrections whose
  word still has its original text hold; the transcript the AI reads says her words in the spoken
  word's punctuation, leaves out a word she dropped and keeps its sentence end; in a rebuild the
  corrections win over the curator's fix, show on the caption (marked as hers, never counted as a
  word fixed) and on a component placed on the word, make a caption typed over several words one
  caption again, and are noted when that cannot be. `apps/worker/src/owner-edit.test.ts`: a
  caption fix is written per spoken word with the word as the transcript has it; a fix typed into
  an accent or the hook writes none. `apps/worker/src/decide/run-decide.test.ts`: a Start over
  after the owner's edits sends the corrected words to both AI calls, shows the corrections in the
  captions over the curator's own fix, marks only those captions as hers, keeps no hook text,
  accent text or block place of her version, notes nothing as kept or lost and says `N word
corrections of yours kept`. `apps/studio/db-tests/owner-edits.test.ts`: one row per spoken
  word (a later fix replaces it), a bad word id or a text too long refused, the rows gone with
  their reel; the owner reads only her own rows and writes none, `anon` reads none.
  `apps/studio/db-tests/grants.test.ts` lists the table. `apps/studio/e2e/owner-edit-text.spec.ts`:
  the save writes one correction (`w0004`, `brief`, from `short`) and none for the accent's or the
  hook's text; picking the `bold` pair makes a version set in `bold` whose caption still shows
  `brief`, with `cw0004` among its marks, one dropped note each for the hand-made accent and for
  the hook (this reel's AI answer wrote none) and the step's line `1 of your edits kept, 2 of your
edits could not be kept`; Start over (with the mocked AI's unchanged answer) makes a version
  whose captions read `this is a brief`, whose only mark is `cw0004`, with the AI's hook, without
  the hand-made accent and with no `owner-edit` note, whose AI record shows `brief` and not
  `short` in both calls, and whose step line says `1 word correction of yours kept`.
- Text edits. `packages/edit/src/owner-text.test.ts` (unit): the stored text (one line, single
  spaces, no control character), the limit (three times, 40 at least, the format's most), the
  parsed edits and every malformed one, `spreadWords` against the reveal's own spread; an accent's
  text changed with its words, time, size and every other element kept, its box's top and centre
  line kept; another accent on the same spoken word, the hook and the captions left as they were;
  a longer text wrapped inside the box's width, the box taller and no wider; three words written
  for one spoken word all in on that word (the page's word elements and their tweens), the
  out-fade where it was; the hook's text changed with its window kept, and its new text typed letter by letter with
  its carets and its key sounds in step; a
  question's mark and left edge kept, a typed mark never doubled; a big word changed to any text within
  the general limit, wrapped inside its width with `breaks`, built on centred lines and escaped; a LIST's key phrase changed with the other level's lines
  and the number kept, the number refused; a caption group: one word fixed in that caption only
  with every caption's word and time kept, more words spread over the same captions, fewer words
  joining a caption to the one before with no spoken word lost and the block read back the same,
  the edited group wrapped inside the block's width with the other groups left where they are,
  two groups of one sentence in one save; the limits (empty, too long, an unknown element, an
  element twice); a version with no text edit left as it is and an edit that changes nothing left
  out; a text edit with a move of the same element; the learning records (the text before and
  after, the part, the spoken words and their ids, none for the hook, the boxes).
  `packages/edit/src/owner-edit.test.ts`: a LIST's and a caption block's `parts`.
  `apps/worker/src/owner-edit.test.ts`: `parseOwnerEdit` with texts alone, with moves, and
  malformed; a text edit saved as a new version with only that element's words changed, its time
  and every other element kept, one `owner_texts` record and no move record, the edited version
  not rewritten; a caption group's word and the hook fixed with a move applied after the text,
  each recorded; an empty text, one too long, an element that is no text and a text that changes
  nothing refused with no version written. `apps/studio/src/lib/owner-edit.test.ts`: which
  components have a text to edit, the part an edit is for (a block's group at the paused moment,
  a list's level under the pointer), the field's box. `live-page.test.ts`: a word element whose
  text changed is the one named as changed. `change-requests.test.ts`: the details line.
  `apps/studio/db-tests/owner-edits.test.ts`: a job with texts alone queued; texts that are no
  list, none at all or more than 200 refused; `save_version` writing the text rows with the
  version, read by their owner only and never written by them; rows without the version edited, a
  text that did not change, an empty one, a component with no text and an element twice refused
  with nothing written; the rows gone with their reel. `grants.test.ts` covers `owner_texts`.
- `apps/studio/e2e/owner-edit-text.spec.ts` (`yarn test:e2e`, the fixture clip with the QUESTION
  and an accent added by hand on the spoken word "short", which its caption shows too): `Edit
text` on the selected caption block opens the field with `this is a short` and `15 of 45
characters`; Enter with `this is a brief` shows `brief` at once in that caption's own word
  element, the accent on the same spoken word still `short`, the hook and the other captions
  unchanged, the block's top and size kept, Save enabled. A double-click on the accent opens the
  field with `short` (`5 of 40 characters`); a click outside keeps `short and sweet` (typed with
  stray spaces), the caption still `brief`, and its three words all come in as "short" is spoken.
  Escape on the hook's field changes nothing; an empty text is refused with `A text cannot be
empty. The text stays as it was`; the field's `maxlength` is three times the hook's characters.
  `Edit text` on the hook with `A brief test for the real studio` changes the hook only, its top
  and size kept, and the new text is typed like any hook: every letter an element of its own,
  each but the last with its caret, exactly the letters whose moment has come on screen with one
  caret after the last of them halfway through, and the whole text with no caret past 60% of the
  hook's window (`hookReveal`, `typedCount`).
  Save sends the three texts, the worker saves a version `Edited by you` that draws them, the
  stored edit holds the text on the one caption, the one accent and the hook with their words and
  times as they were and every other overlay unchanged, the caption's new word still comes in on
  its spoken word, and the three `owner_texts` rows hold the text before and after and the spoken
  words (none for the hook, placed with `hook/typed`). With
  `OWNER_EDIT_SHOTS` it keeps `text-1-field-open.png` to `text-4-saved.png`.
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
  the library's Delete on a photo those versions show warns `Used in 2 versions of your reels...`
  first, deletes it all the same, and the version's preview then shows `A photo in this version
was deleted from the library`. Before the Delete, picking the `bold` font pair queues a relayout
  that the worker finishes (`done`, never `Could not set the new font`): the new version is set in
  `bold`, names both photos in `inputs.photos`, shows the engine's card with the swapped photo (no
  stand-in) at the photo's aspect and the added card where the owner put it, both pictures loaded
  in the preview; so the Delete's warning counts 2 versions. With `OWNER_EDIT_SHOTS` it keeps
  `photos-1-picker-open.png`, `photos-2-swapped-picture.png`,
  `photos-3-two-pictures-at-once.png`, `photos-4-font-pair.png` and
  `photos-5-delete-warning.png`.
- The guardrail (`test:tools`, `app_docs/export.md`): after the card past the frame's edge, the
  card's picture swapped for the library photo (its preview showing the signed large copy) matches
  its export at the bound, and a second card added over it (both on track 30 at once, the added one
  drawn last) matches too, while against the one-card previews it falls below the bound.

## Rules

- Never rewrite the version the owner edited: Save makes a new version after the current one.
- Never change anything but the place, the text size and the line breaks of the moved components,
  a moved VISUAL's box and turn, a card's picture swapped for one of the owner's ready library
  photos, and the words of a text the owner edited: not a time, a spoken word or a card's
  description. A line break changes only through a wrap width or a text edit's wrap inside the
  box, on the engine's balanced lines; never stretch or squeeze letters to fill a box.
- Never let a text edit change another element: it writes the one element it names (a caption
  block's group: that group's captions). The same spoken word in a caption, an accent, a list or
  the hook keeps its text. Never turn an owner's text edit into a `word_fixes` entry.
- Never change a time or an anchor in a text edit, and never drop a spoken word: a caption left
  with no word joins its spoken words to the caption before it. The edited text is revealed over
  the element's same spoken words by `wordReveal`.
- Never add or delete a whole element in a text edit (a text, a caption block, a group).
- Never save an empty text or one over `ownerTextLimit` (three times the version's own text, 40
  characters at least, the format's limit at most); the studio says why and the worker refuses.
- Never measure a text's limit against a draft: the original is the version being edited.
- Never place an edited text again with the engine: its box keeps its top and its centre line (a
  question its left edge), the text wraps inside the box's width, and only the safe zone moves
  it (`settleOwnerMove`).
- Never lose the owner's work in a font pair change without saying so: every mark of `edit.owner`
  is carried onto the new placement (`carryOwnerEdits`) or noted in the new version's engine
  record (`rule` `owner-edit`, `outcome` `dropped`) and counted in the step's line. A carried box
  that no longer fits the safe zone is moved in or made smaller and noted, never dropped and never
  left outside the safe zone.
- Never carry a place, a size or an element's text into a Start over, and never the hook's text:
  a Start over is a fresh answer with only the reel's corrections and the cards she added.
- Never carry a component's fix or place onto another component: an element is found by its id
  in the same answer.
- Never treat a fix typed into an accent, a question, a big word, a list or the hook as a
  transcript correction, and never change the hook with a correction.
- Never build a rebuild (a font pair change, a Start over, the automatic decide) from the
  transcript without the reel's live corrections, and never let the curator's `word_fixes` win
  over one.
- Never write `owner_word_corrections` from a pipeline step or from the studio: only the
  `owner_edit` job writes it, with the service role; no step that processes a reel again touches
  it.
- Never write `edit.owner` by hand or from the engine: `applyOwnerMoves`, `applyOwnerTexts`,
  `carryOwnerEdits` and `applyWordCorrections` write it, and a placement made again starts with
  none.
- Never apply the AI answer's big word rule to the owner's text: only the general length limit
  binds it.
- Never apply a save's parts in another order than added cards, text edits, moves: the studio's
  draft (`draftEdit`) and the worker both do, so the draft is what is saved.
- Never save a text edit without its `owner_texts` row, nor the row without the version: both go
  through `save_version` in one transaction; only `service_role` writes the table, and its rows
  go with their reel.
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
  handles only, never the text on screen (its one text is the field of an inline edit, open only
  while the owner types), and is never part of the built page or the export. The instant view
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
- Never move a single caption with this editor: a sentence's captions move, resize and re-wrap as
  one block, and a block is never cut inside a caption.
- Never store a caption block: it is read back from the captions (`captionBlocks`) the way the
  engine made it, so a version saved before blocks were movable has the same blocks.
- Never render the editor or queue an `owner_edit` job for a user whose `studio-owner-edit` flag is
  off: the page and `requestOwnerEdit` both evaluate it on the server.

## Notes

- A big word has no edge handles and a wrap width on it is refused: its lines come from its text
  edit (wrapped inside its width) and its corner handle resizes it.
- A wrap width can only give whole lines. A top or bottom drag picks the nearest height the text
  can take, so the box can come out taller or shorter than the handle was dragged. A LIST's single
  wrap width applies to its lead-in and key phrase together; its number keeps its line.
- Not done yet: touch and phone (the button is hidden below `lg`), keyboard nudging, turning a
  text, deleting a card, timing changes (an added card always lasts 1.5 s), matching the picker's
  photos to the reel by their tags (it shows every ready photo), undo inside the editor (Cancel
  drops everything), and carrying a swapped photo of an answer's card through a Start over (the
  new answer's cards are other cards; a font pair change keeps it).
- A correction is undone only by typing the spoken word back into the caption (it is then stored
  as the word's own text); there is no list of corrections to clear yet. A reel processed again
  whose transcript changed a corrected word drops that correction silently (`liveCorrections`).
- A text edit keeps the element's box width, so a word added to a narrow box (a one-word accent)
  goes on a new line; the owner widens the box with an edge handle after. A word wider than the
  box makes the box that wide.
- A LIST's number and a VISUAL's description are not edited. A caption block is edited one group
  at a time (the captions on screen at the paused moment), not the whole sentence at once.
- The export guardrail (`test:tools`, the owner's Mac only) has no case for an edited text yet:
  the builder draws an owner's text through the same `text` fields it always drew.
- A caption block's time is its sentence's, and its box is the box around all its groups: at a
  paused moment the box can be larger than the captions then on screen, when another group of the
  sentence takes more lines.
- A new version arriving while the editor is open (a job finishing) replaces the preview and closes
  the editor: the draft is lost. The moves are small, so this is accepted for now.
- Other docs this change touches: `app_docs/change-requests.md` (the list's `Edited by you`),
  `app_docs/edit-model.md` (`build`'s `components`, `edited_from_id`, `save_version`),
  `app_docs/preview.md` (the player's `overlay`, `controls` and `pause`), `app_docs/studio.md` (the
  job kind and the table), `app_docs/status.md` (the step's words), `app_docs/studio-reel-layout.md`
  (the control row), `app_docs/export.md` (the guardrail's case), `app_docs/failures.md` (Try again),
  `app_docs/font-pairs.md` (a re-layout carries the owner's work and the corrections),
  `app_docs/decide-step.md` (the AI reads the corrected transcript).
