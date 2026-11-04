# Feature: Fulfil change requests by making room, one editorial round on the first run

## Metadata

issue_number: `155`
adw_id: `2a28c287`
issue_json: `{"number":155,"title":"engine: fulfil change requests by making room, one editorial round on the first run","body":"(see the issue: make room for checklist-linked items in a fixed order, an editorial round with Claude for what does not fit, the checklist stored with the version)"}`

## Feature Description

The layout engine (`placeEdit`, `packages/edit/src/engine.ts`) places every item of a meaning-only
decide answer and drops what fits nowhere. That is right for the automatic run, but wrong when the owner asked
for something: on 2026-11-03 the request "add images behind me" saved a version identical to the
one before, because the captions of the photo's sentence filled every photo spot and the engine
dropped the photo.

This feature adds two things, both following the owner's decisions of 2026-11-03:

1. **Make room (engine).** For every item the request checklist links (`requested`), the engine no
   longer gives up after the first placement. It escalates through a fixed ladder of steps, each
   one recorded in the engine record (`versions.engine_record`), until the item is placed:
   1. move the captions sharing its time to another free area (full size, still beside the speech);
   2. shrink or wrap those captions, down to the preset floor (60%, never smaller);
   3. remove extras Claude added on its own that stand in the way (an accent, the big word, a
      transition's styling), recorded as `removed`;
   4. shift the requested item's timing within its own sentence;
   5. let the requested item cover the face (the owner: "totally fine sometimes");
   6. if it still does not fit, drop it with the reason. The worker's editorial round then asks Claude
      for another meaning choice.
      It never removes a caption, never sets one below the floor, never puts one over the face for
      this, never leaves the safe zone and never drops another item the owner asked for.
2. **Editorial round (worker).** After the answer is placed, the worker asks Claude a second short
   question in editor terms: what could not be placed and why (in words, no coordinates, sizes or
   times), and the sentences that still have room for that kind of item (by word ids). Claude makes one new
   meaning choice per unplaced item (another sentence, another photo, or skip, with a reason). The
   choice is merged into the answer and the whole answer is placed again. The automatic run gets one
   round. A request gets rounds while a requested item is unplaced, capped at 3. What still does not fit
   is dropped and recorded.

The request checklist is now stored with the version (`versions.checklist`), each ask with whether
it was done and, when not, the exact reason and what the owner can do. Item 6 (the honest summary)
reads it.

## User Story

As the reel studio owner
I want a change request to actually change the reel, with the layout making room for what I asked
for, and the first automatic edit to try another sentence before giving up on a photo
So that I never get a "new" version identical to the old one, and when something truly cannot be
done I am told why and what I can do

## Problem Statement

- A change request can end with nothing done: the requested item is placed like any other extra,
  after all captions, and dropped when the captions and the face leave it no room
  (`placePhoto`'s `no-room`, "every photo spot is under captions or the face").
- On the first run, an item that does not fit is dropped although another sentence had room:
  nobody asks the editor (Claude) for another choice.
- The checklist (what was asked, which items fulfil it) is thrown away after placement, so nothing
  can later say what was asked and what was done.

## Solution Statement

- **Engine (`packages/edit`)**: `placeEdit` keeps its single deterministic pass as an inner
  function (`placeOnce`) that takes a `Room` state (which requested refs are reserved and at
  what step, which unrequested extras are removed, shifted spans, which requested refs may cover
  the face). Without `requested` it runs once with an empty `Room` and its output is byte-identical
  to today's, which the committed goldens prove. With `requested`, `placeEdit` runs the ladder per requested
  item (checklist order), re-running `placeOnce` with an escalating `Room`. It takes the first pass
  in which that item is placed, every earlier requested item stays placed, and no caption block covers the face
  that did not already at the plain pass. Every step taken is written to the record with rule `make-room`. The
  placement also returns `unplaced` (dropped extras with their answer refs and a reason code
  in editor terms) and `free` (sentences by word ids with room for an accent, a photo or the
  big word, found by non-committing probes after placement).
- **Editorial round (`packages/edit/src/editorial.ts` + `apps/worker/src/decide/editorial.ts`)**:
  a per-reel editorial answer schema (meaning only: an unplaced item's ref, a new word range or
  photo id, or skip with a reason for the owner), its JSON Schema for `--json-schema`, a pure
  `mergeEditorial` that applies the choices to the answer (re-indexing the checklist links on a
  skip), and a short committed prompt `editorial.md`. `runDecide` runs the rounds after a
  placed attempt: one on the automatic run (only when some unplaced item has a free sentence of its
  kind, so no call is paid for nothing), up to `EDITORIAL_ROUNDS.request` (3) on a request while a
  requested item is unplaced. A refused or broken editorial answer ends the rounds (never a retry,
  never a failed step), and the version saves with what is placed.
- **Checklist outcome**: `checklistOutcome(answer, placement, editorial)` (pure, `packages/edit`)
  turns the final checklist into stored entries `{ ask, wants, fulfilled_by, done, reason }`.
  A new migration adds `versions.checklist` (jsonb array, default empty) and the last
  `save_version` parameter `p_checklist`, mirrored in `NewVersion`, `VersionMeta`,
  `supabaseVersionRows` and the studio's seeding helper.
- **Prompt**: the decide answer's checklist entries gain an optional `why_not` (plain words for the
  owner when nothing in the answer can do the ask, for example photos with an empty library), and
  `PROMPT_VERSION` becomes `decide-7` (it covers `prompt.md` and the new `editorial.md`).

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (no em-dashes, migrations through
  `supabase migration new`, a user-visible change adds a spec, docs per feature, the profile kept in
  step).
- `.adw/project.md`: commands, filters, Protected rules (no `supabase` command but
  `migration new` and `.adw/supabase-stack reset`; never point at the real `claude` binary).
- `docs/conditional-docs.md`: index; the `edit-model.md` and `decide-step.md` lines are updated.
- `app_docs/edit-model.md` ("Layout engine", Rules): the engine contract this extends (ladder,
  record actions and rules, `unplaced`, `free`).
- `app_docs/decide-step.md` (How it works, Failure, Testing, Rules): the decide step, the
  checklist, the AI double, the two-call rule this changes.
- `app_docs/change-requests.md`: how a `change` job runs `runDecide` with `job.request` (read only,
  to keep the request path intact).
- `packages/edit/src/engine.ts`: `placeEdit`, `Placement`, `PlaceOptions.requested`, `EngineAction`,
  `placeBlock` / `tryBlock` / `leavesPhotoSpot` (the caption reservation for photos already
  there), `placeAccent`, `placeBigWord`, `placePhoto`, `fitTime`, `spotClearOfFace`.
- `packages/edit/src/engine-space.ts`: `placeBox` and free rectangles (used by the probes).
- `packages/edit/src/engine-input.ts`: `EngineInput`, `WISHES`, `choicesOf`.
- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor` (checklist entry gains `why_not`),
  `editFromAnswer` (passes `requested`, returns the placement's `unplaced` and `free`),
  `parseDecideAnswer`.
- `packages/edit/src/behind.ts`: `BEHIND_SPOTS`, `spotBox`, `spotFaceShare`.
- `packages/edit/src/checks.ts`: `behind-face` (a requested photo the engine let cover the face is
  recorded and must not be called an engine bug).
- `packages/edit/src/transcript.ts`: `sentenceSpans` (free sentences by word ids).
- `packages/edit/src/versions.ts`: `NewVersion`, `VersionMeta`, `saveVersion` (new `checklist`).
- `packages/edit/src/index.ts`: exports (knip flags anything unused).
- `packages/edit/src/engine.test.ts`: engine unit tests, `place` helper, `BIG_FACE`, `steadyHead`.
- `packages/edit/src/decide.test.ts`: schema tests (the `why_not` field).
- `packages/edit/scripts/golden.ts`, `packages/edit/src/test-support/fixtures.ts`,
  `packages/edit/src/test-support/goldens.ts`: the committed fixture versions and goldens; the
  2026-11-03 case becomes one.
- `apps/worker/src/decide/run-decide.ts`: the decide step; rounds, checklist outcome, the
  engine-bug filter, the step line.
- `apps/worker/src/decide/run-decide.test.ts`: worker integration tests with the AI double.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`, `prompt.test.ts`: `PROMPT_VERSION`, the
  checklist's `why_not`.
- `apps/worker/src/decide/input.ts`: `sentences`, `LibraryEntry` (reused by the editorial input).
- `apps/worker/src/ai.ts`: `AiRunner`, `fakeAiRunner`, `resultEnvelope` (the double; scripts are
  replayed in order, the last repeating).
- `apps/worker/src/failure.ts`: `AiUnavailable`, `permanentAfterAiCall`.
- `apps/worker/src/version-store.ts`: `supabaseVersionRows` (`p_checklist`).
- `apps/worker/src/engine-record.ts`: the one-line log (unchanged format, new actions appear in it).
- `apps/studio/test-support/versions.ts`: the studio's seeding `save_version` call (`p_checklist`).
- `apps/studio/db-tests/versions.test.ts`: DB tests of `save_version` and the version columns.
- `apps/studio/e2e/upload.spec.ts`: asserts `prompt_version: "decide-6"`; becomes `decide-7`.
- `supabase/migrations/20261103230327_version_engine_record.sql`: the current `save_version`
  signature the new migration drops and replaces.

### New Files

- `packages/edit/src/editorial.ts`: `UnplacedItem`, `FreeSentence` types (re-exported from the
  engine), `editorialAnswerSchemaFor`, `editorialJsonSchema`, `parseEditorialAnswer`,
  `mergeEditorial`, `checklistOutcome`, `ChecklistOutcome`.
- `packages/edit/src/editorial.test.ts`: unit tests of the schema, the merge and the outcome.
- `packages/edit/src/testdata/versions/rethink-work-request.edit.json`,
  `packages/edit/src/testdata/golden/rethink-work-request.html`,
  `packages/edit/src/testdata/golden/rethink-work-request.widths.json`: the 2026-11-03 case placed
  with make room, written by `yarn workspace @edit-issebya/edit golden`.
- `apps/worker/src/decide/editorial.md`: the committed editorial prompt.
- `apps/worker/src/decide/editorial.ts`: `EDITORIAL_ROUNDS`, `editorialInput`, `editorialPrompt`,
  `runEditorialRounds`.
- `apps/worker/src/decide/editorial.test.ts`: unit tests of the rounds with the AI double.
- `supabase/migrations/<stamp>_version_checklist.sql`: created by
  `supabase migration new version_checklist` (never a hand-picked stamp).

## Implementation Plan

### Phase 1: Foundation

- Record vocabulary: `EngineAction` gains `removed` (an extra Claude added on its own, taken out to
  make room). New rule `make-room` for every note the ladder writes, and `editorial` for the notes
  of the editorial round. `covers-face` is reused for a requested item over the face.
- `Placement` gains `unplaced: UnplacedItem[]` and `free: FreeSentence[]`:
  - `UnplacedItem { ref: string; id: string; kind: "accent" | "big_word" | "photo"; from: string;
to: string; photo_id?: string; requested: boolean; why: "no-room" | "busy" | "too-short" |
"hidden" }`. `why` maps the drop rule (`no-room` to `no-room`, `one-extra` to `busy`,
    `accent-time` / `big-word-time` / `photo-time` to `too-short`, `hidden-footage` to `hidden`).
    It is a code, never a text with times or pixels, so the editorial prompt can explain it in
    words.
  - `FreeSentence { from: string; to: string; room_for: ("accent" | "photo" | "big_word")[] }`, only
    sentences with at least one kind, only kinds some unplaced item has, found after the final
    placement by probes that never commit (snapshot and restore `record`, `shown`, `overlays`,
    `behind`, `accepted`): a photo over the whole sentence (the photo timing rule), an accent on the
    sentence's first word (up to its first three words), the big word on the sentence's longest
    plain word. A probe must pass the one-extra rule (`fitTime` against `accepted`) and find a
    place. The list is a hint for Claude; whatever Claude picks is placed again for real.
- Migration and version plumbing for `versions.checklist` (below), so the worker can save it.

### Phase 2: Core Implementation

- **The ladder in `placeEdit`.** Refactor the body into `placeOnce(room)` with no behaviour change,
  then add the outer loop. `Room` holds:
  - `reserve: Map<ref, "move" | "shrink">`. Caption blocks sharing time with a reserved requested
    item must leave it room. For a photo: the existing `leavesPhotoSpot` reservation, strict (no
    fall back to `keep = false`) and only for that photo.
    For an accent or the big word: the item is placed in a pre-pass
    before the captions (obstacles: faces, bodies for an accent, the notch, already placed
    requested items) and its box is an obstacle for every caption block during it. `move` lets
    those blocks try every candidate at the full size only. `shrink` lets them go down the sizes to
    the floor (wrapping to two lines as today). A block that finds no such place makes the pass
    fail for that item: it never goes over the face for this.
  - `removed: Set<ref>`: unrequested accents, the big word and transitions left out of the pass.
    A removed transition's captions become a sentence block, so they can move.
  - `shift: Map<ref, { start, end }>`: a requested item's span moved inside its sentence.
  - `faceOk: Set<ref>`: a requested photo may take a free spot the face covers beyond
    `maxFaceShare` (the least covered free spot first). A requested accent drops faces and bodies
    from its obstacles. The big word already sits behind the head.
  - Order per requested item (checklist order, cumulative): plain pass; `move`; `shrink`; then
    remove the unrequested extras overlapping its span one at a time in a fixed order (accents in
    answer order, the big word, transitions in answer order), each followed by `move` and `shrink`
    again, stopping at the first success; then shifts: photo or accent start on each word start of
    its sentence (nearest the original first) with a span of at least the kind's minimum inside the
    sentence (the big word only shortens to its minimum, never starts before its word), each with
    `shrink`; then `faceOk` with `shrink`. A pass is accepted only if the item is placed, every
    requested item placed before stays placed and no caption block records `covers-face` that the
    plain pass did not. Nothing found: the plain pass's drop stands, its reason ending
    `, after moving and shrinking captions, removing extras, shifting it in its sentence and
allowing the face`.
  - Notes, with rule `make-room`, written once per step that the accepted pass needed. `moved` and
    `shrunk` for each caption block the reservation changed, compared with the plain pass:
    `captions "..." sit <place> to make room for photo 1, as asked`. `removed`:
    `transition 1 (card) removed: its captions covered every photo spot photo 1 needs, as asked`.
    `retimed`: `photo 1 now shows from 24.10 s to 26.10 s, inside its sentence, to find room`.
    `covers-face`: `photo 1 sits in the left spot over part of the face: nothing else was free, as
asked`. The usual notes of the accepted pass (caption-spot, contrast and the rest) stay.
  - Deterministic: no randomness, no clock, the same input gives the same tracks and record.
    Bounded: the ladder is finite (at most 3 removals and one shift per word of the sentence per item).
- **`editFromAnswer`** returns `{ ok, edit, record, unplaced, free }`. `requested` is computed as
  today from `checklist[].fulfilled_by` (only list items and `big_word`. `word_fixes`,
  `transitions` and `behind_rules` are never placed extras).
- **`packages/edit/src/editorial.ts`**:
  - `editorialAnswerSchemaFor(transcript, unplaced, photoIds)`:
    `{ choices: [{ item: enum(unplaced refs), skip: boolean, from?: wordId, to?: wordId,
photo_id?: photoId, why?: string(1..300) }] }`, every object closed. Refinement: one choice
    per unplaced item, exactly once. `skip: true` carries `why` (plain words for the owner: why it
    cannot be done and what they can do) and nothing else. `skip: false` carries `from` and `to`
    (in order; for the big word `from === to`) and, on a photo item only, an optional `photo_id`.
    `editorialJsonSchema` uses the same draft-07 settings as `decideJsonSchema`.
  - `parseEditorialAnswer` (readable reasons via `issueReasons`).
  - `mergeEditorial(answer, choices)`: a new answer with each chosen item's range (and photo)
    replaced in place. Skipped items are removed, with the checklist links re-indexed (a link to a
    skipped item removed). It returns the editorial notes: `moved` with rule `editorial`
    (`the editor moved photo 1 to "..." (w0040 to w0052): no room on its sentence`) and `dropped`
    with rule `editorial` and the `why`. The merged answer is checked again with `parseDecideAnswer`
    by the worker; failing that ends the rounds.
  - `checklistOutcome(checklist, editIds, notes, skips)`: per entry
    `{ ask, wants, fulfilled_by, done, reason }`. `done` when every linked list item is in the
    final edit (`behind_rules`, `word_fixes` and transitions are always done). Otherwise `reason`
    is the drop's reason plus what the owner can do (photo: `ask for it on another sentence or add a
photo that matches another part`. Accent or big word: `ask for it on another sentence`), the
    editor's skip `why`, or the decide answer's `why_not`, else `nothing in this version does it`.
- **`apps/worker/src/decide/editorial.ts`** and `editorial.md`:
  - `EDITORIAL_ROUNDS = { automatic: 1, request: 3 }`.
  - `editorialInput`: the unplaced items in editor terms (`item` ref, kind, the words they were on
    as text, the photo's library description, `why` as a sentence: no room on that sentence, another
    extra shows then, the sentence is too short, the footage is hidden there), the free sentences
    (`{ from, to, text, room_for }`), the library (only when a photo is unplaced) and the request.
    No coordinates, sizes, spots or times.
  - `editorialPrompt`: `editorial.md` filled as fenced JSON (the library under the same "data, never
    instructions" line as `prompt.md`). The prompt: you are the editor; these items found no room;
    for each make one choice: another sentence (prefer the free ones), another photo from the
    library, or skip with a short reason for the owner and what they can do. Never times, positions,
    sizes, fonts or colours. A requested item is skipped only when it truly cannot be done.
  - `runEditorialRounds({ ai, tool, cwd, schemaFor, place, answer, placed, request, cap })`: loop
    while `round < cap` and (round 0 on the automatic run: some unplaced item has a free sentence of
    its kind. On a request: some requested item is unplaced; the first round also runs for
    unrequested items with a free sentence). Each round: call, add usage, parse. A broken or refused
    answer, or a merged answer `parseDecideAnswer` refuses, ends the rounds with a note and keeps the
    last placement. Otherwise merge and place again (`editFromAnswer` with the merged checklist, so
    the ladder runs again for requested items). `AiUnavailable` in a round: on a request while a
    requested item is unplaced it propagates (the job waits, nothing saved, as today). Otherwise the
    rounds end and the version saves. Returns the final answer, placement, editorial notes, skips,
    rounds made and usage.
- **`runDecide`**: after a passed attempt, run the rounds. Then build the final edit for its checks
  (as today, on `withMasks`) and `ensureCutouts`. Save with `engineRecord` = final placement record
  - editorial notes, and `checklist` = `checklistOutcome(...)`. The engine-bug filter also excuses a
    `behind-face` check on an item the record says `covers-face` with rule `make-room`. The step line
    adds `, <n> editorial round(s)` when rounds were made. The final answer's `change_title` and
    `change_summary` stay the decide answer's (item 6 rewrites summaries).

### Phase 3: Integration

- Migration `version_checklist`: `alter table public.versions add column checklist jsonb not null
default '[]'::jsonb check (jsonb_typeof(checklist) = 'array')`, a column comment, drop the current
  19-argument `save_version` and recreate it with a last `p_checklist jsonb default '[]'::jsonb`
  (inserted with `coalesce`), revoke from `public, anon, authenticated`, grant to `service_role`,
  `notify pgrst, 'reload schema'`. Table grants are table-wide, so the column needs none of its own.
  Old rows keep an empty checklist and are never rewritten.
- `NewVersion.checklist: ChecklistOutcome[]`, `VersionMeta.checklist?`, `saveVersion` passing
  `meta.checklist ?? []`. `supabaseVersionRows` and `apps/studio/test-support/versions.ts` send
  `p_checklist`. `first_version` and restore save an empty checklist.
- Decide prompt: checklist entries gain `why_not` (optional, 1 to 300, plain words: why nothing in
  the answer can do this ask and what the owner can do, for example "Your photo library is empty:
  upload photos first"). `PROMPT_VERSION = "decide-7"`. Update `prompt.test.ts`, `run-decide.test.ts`
  and `apps/studio/e2e/upload.spec.ts` (`prompt_version: "decide-7"`).
- Existing E2E scripts stay valid: the upload spec's committed answer drops one accent on the
  one-sentence clip, where no sentence has room (the title holds it), so no round is made and the
  AI usage numbers are unchanged. A single-envelope script replayed into a round is refused as an
  editorial answer and only ends the rounds. Verify both with the unit test below rather than
  assuming.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `AGENTS.md`, `app_docs/edit-model.md` ("Layout engine", Rules), `app_docs/decide-step.md`,
  `app_docs/change-requests.md` and the files above. No Next.js work is involved.

### 2. Reproduce the 2026-11-03 case on the base (test first)

- In `packages/edit/src/engine.test.ts`, add `describe("making room for a request")` with a test
  "add images behind me": `rethink-work-hand`'s edit and transcript, `BIG_FACE`, an answer with a
  `card` transition Claude added on its own over `w84` to `w99` (the card's text area at y 640 to
  1400 puts that sentence's captions over every photo spot), a photo over `w84` to `w99`, and the
  checklist linking only `photos[0]` (`requested: ["photos[0]"]` through `editFromAnswer`). Assert
  the photo is in `behind`, the build checks are empty, and the record shows the `removed` transition
  with rule `make-room`. Run it on the base and confirm it fails (photo dropped, `no-room`). If the
  card does not block every spot on the base, adjust only the answer (another sentence or `panel`)
  until the base drops the photo for captions, and note the choice in the test comment.

### 3. Engine: record vocabulary and placement outputs

- Add `removed` to `EngineAction`. Add `UnplacedItem`, `FreeSentence` and the two `Placement`
  fields. Collect `unplaced` from the drops (with `ref`, `requested`, `why`).
- Refactor `placeEdit`'s body into `placeOnce(room)`. Run `yarn workspace @edit-issebya/edit
golden` and confirm `git status` shows no change to the committed fixtures and goldens (no
  `requested` means byte-identical output).

### 4. Engine: the make-room ladder

- Implement `Room` (`reserve`, `removed`, `shift`, `faceOk`), the requested pre-pass for accents and
  the big word, the strict photo reservation, the acceptance rule and the `make-room` notes as
  described in Phase 2. Keep it deterministic and bounded.
- Implement the `free` probes after the final pass (non-committing).

### 5. Engine unit tests

- In `engine.test.ts` (`making room for a request`), each failing on the base:
  - a requested photo in a sentence whose captions fill every spot is placed by **moving the
    captions** (a reservation `move` note, no `removed`, no `covers-face`; captions at full size);
  - one that needs smaller captions is placed with `shrunk` `make-room` notes, never below the
    floor (every caption `size >= ceil(full * 0.6)`);
  - one blocked by an accent Claude added on its own (unrequested) is placed by **removing the
    accent** (`removed`, `make-room`), while a requested accent in the same place is never removed
    (two requested items: neither dropped, or the later one dropped with its reason);
  - **covering the face only as the late step**: with a face that takes every spot (the `huge`
    head of the existing drop test) and room for nothing else, the requested photo is placed with a
    `covers-face` `make-room` note, and with a smaller face where a shift or caption move suffices
    no `covers-face` note appears;
  - **never removing captions**: in every make-room test, the edit's captions equal the plain
    placement's caption ids and words, each with a position inside `preset.safe`;
  - a requested accent gets its room before the captions (captions moved, recorded);
  - without `requested`, `placeEdit` returns the same tracks and record as the plain pass, and
    `unplaced` / `free` are filled (a dropped accent on a busy sentence lists another sentence with
    `room_for: ["accent"]`);
  - deterministic: the make-room placement twice gives equal tracks and record.

### 6. The 2026-11-03 case as a committed fixture

- In `packages/edit/scripts/golden.ts`, write `rethink-work-request` (the step 2 answer placed with
  `requested: ["photos[0]"]` and the hand edit's background handling as `rethink-work-engine`).
  Register it in `test-support/fixtures.ts` and `test-support/goldens.ts`. Run `yarn workspace
@edit-issebya/edit golden` and commit the three new files only. Add an `engine.test.ts`
  assertion that `editFromAnswer` of that answer equals the stored fixture's tracks and has the
  photo in `behind` (the Node and browser build tests then cover its golden).

### 7. Decide answer: `why_not` and `editFromAnswer`

- `decide.ts`: checklist entry `why_not: z.string().min(1).max(300).optional()`. `editFromAnswer`
  returns `unplaced` and `free`. Extend `decide.test.ts` (the field accepted with a request, the
  JSON Schema still draft-07 and closed).

### 8. Editorial schema, merge and outcome (`packages/edit/src/editorial.ts`)

- Implement and export (through `index.ts`) the schema, JSON Schema, parser, `mergeEditorial`,
  `checklistOutcome`, `ChecklistOutcome`. Add `editorial.test.ts`: one choice per unplaced item
  (missing or twice refused), skip needs `why`, `photo_id` only on photos, a range ending before it
  starts refused. The merge replaces in place and re-indexes links on a skip. The outcome marks a
  placed link done, a dropped one not done with the engine reason and the owner action, an empty
  `fulfilled_by` with `why_not`, a skip with its `why`.

### 9. Version checklist storage

- `supabase migration new version_checklist`, then write the migration (Phase 3).
- `versions.ts` (`NewVersion.checklist`, `VersionMeta.checklist`), `version-store.ts`
  (`p_checklist`), `apps/studio/test-support/versions.ts` (`p_checklist`). First version and
  restore pass an empty checklist.
- `.adw/supabase-stack reset` (the ADW stack only), then extend
  `apps/studio/db-tests/versions.test.ts`: a version saved with a checklist reads it back, one
  saved without it has `[]`, the column refuses a non-array (`check`), and `save_version` stays
  `service_role` only.

### 10. Worker: editorial rounds

- Add `editorial.md`, `editorial.ts` (`EDITORIAL_ROUNDS`, `editorialInput`, `editorialPrompt`,
  `runEditorialRounds`). Wire into `runDecide` (Phase 2), including the engine-bug filter for a
  `make-room` `covers-face` and the `editorial round(s)` step-line part. Bump `PROMPT_VERSION` to
  `decide-7`, add `why_not` to `prompt.md`'s checklist section.
- `editorial.test.ts` (fake AI runner, a stub `place` so the rounds are tested apart from layout):
  - the automatic run makes exactly one round when an unplaced item has a free sentence, and none
    when no sentence has room;
  - a request makes rounds until the requested item is placed (placed at the second round: two
    editorial calls, then stops), never more than 3 (a script that never places it: 3 calls);
  - a skipped requested item ends with its `why` in the outcome (an impossible request);
  - a refused or broken editorial answer ends the rounds without a retry, and the placement before it is kept;
  - `AiUnavailable` on the automatic run ends the rounds. On a request with a requested item
    unplaced it propagates;
  - the prompt has no time, pixel or spot: assert it contains no `s"`-style seconds pattern
    (`/\d+\.\d+ s\b/`), no `px` and none of `top`/`left`/`right` spot names as spots, and quotes the
    library under the data line.
- `run-decide.test.ts`:
  - the committed E2E answer still saves in one round with exactly one AI call (`calls.length ===
1`) and the same usage numbers;
  - a request ("add images behind me") with a ready library photo and a scripted answer linking the
    photo saves a version whose row has `checklist` `[{ ..., done: true, reason: null }]`;
  - an impossible request (empty library, a checklist entry with empty `fulfilled_by` and `why_not`
    "Your photo library is empty: upload photos first") saves a version whose stored checklist entry
    is not done with that reason;
  - an automatic run whose answer has an unplaced item with a free sentence (scripted second
    envelope: an editorial answer moving it) makes two calls, saves the moved item, records the
    `editorial` note and the step line ends `, 1 editorial round`. If the short fixture clip
    (one sentence, `w0001` to `w0010`) can have no free sentence, cover this in
    `editorial.test.ts` with the stub instead and say so in the test comment.
- Update `prompt.test.ts` (`decide-7`, `why_not` described) and `apps/studio/e2e/upload.spec.ts`
  (`prompt_version: "decide-7"`).

### 11. Documentation

- `app_docs/edit-model.md`, "Layout engine": a "Making room for a request" part (the ladder, the
  acceptance rule, the notes, `removed`, the `make-room` rule, `unplaced`, `free`). Add `removed` to
  the action list and `make-room`, `editorial` to the rules. Rules lines: `Never remove a caption,
set it below the floor, put it over the face or outside the safe zone to make room.`; `Never drop
or remove an item the owner asked for to make room for another.`; `Cover the face for a requested
item only after every other step.`; `Without a request the engine never makes room: its output is
the plain pass's.`
- `app_docs/decide-step.md`: the editorial round (When, cap, the meaning-only editorial answer,
  failure handling, the merged re-placement), the stored checklist (`versions.checklist`, the
  migration, `save_version`'s `p_checklist`), `why_not`, `decide-7`, the new tests. Change the
  rule `At most two AI calls per decide` to: `At most two answer calls (one retry), then the
editorial rounds: at most one on the automatic run, at most 3 on a request; never an unbounded
loop.` Add Rules lines: `Claude never sees coordinates, sizes, spots or times in the editorial
round either.`; `A refused editorial answer never fails the step and is never retried.`; `Every
decided version stores its checklist; a not-done ask carries the exact reason and what the owner
can do.`; `Bump PROMPT_VERSION whenever prompt.md or editorial.md changes.`
- `docs/conditional-docs.md`: the `edit-model.md` line mentions making room for a request; the
  `decide-step.md` line mentions the editorial round, `editorial.md` and `versions.checklist`.
- `.adw/project.md`, Tests: `versions.test.ts` also covers the `checklist` column (under the same
  headings, nothing renamed or reordered). No em-dashes anywhere.

### 12. Browser coverage

- No new E2E spec: nothing visible changes in the studio (the stored checklist and record are read
  by item 6 later). The behaviour is decided in `packages/edit` and `apps/worker`, which have no
  browser surface, and is proven by the unit tests above with the AI double. The existing studio
  specs that run the worker's `once` (`upload`, `behind`, `decide-behind`, `change-requests`) are
  the regression layer: only `upload.spec.ts`'s prompt version string changes.

### 13. Run the validation commands

- Run every command in `Validation Commands`, fix what fails without weakening any rule, type or
  test.

## Testing Strategy

### Unit Tests

- `packages/edit/src/engine.test.ts`: the make-room ladder step by step (move, shrink, remove an
  unrequested extra, shift, face last), the invariants (captions never removed, never below the
  floor, never outside the safe box, a requested item never removed for another), determinism,
  `unplaced` and `free`, the 2026-11-03 fixture.
- `packages/edit/src/editorial.test.ts`: the editorial schema, merge and checklist outcome.
- `packages/edit/src/decide.test.ts`: `why_not`.
- `apps/worker/src/decide/editorial.test.ts`: rounds, caps, failure handling, the meaning-only
  prompt.
- `apps/worker/src/decide/run-decide.test.ts`: the stored checklist, the impossible request, the
  unchanged one-call path of the committed answer.
- `apps/worker/src/decide/prompt.test.ts`: `decide-7`.
- DB: `apps/studio/db-tests/versions.test.ts` for `versions.checklist` and `save_version`'s new
  parameter.

### Test Coverage

- `engine.test.ts` "making room for a request" (unit): catches a requested item dropped while
  moving captions, shrinking them, removing Claude's own extras, shifting it or covering the face
  would place it; also catches captions removed or unreadable for it. Fails on the base (the photo
  is dropped `no-room`).
- `engine.test.ts` 2026-11-03 fixture + its golden (unit, Node and browser): catches a regression of
  the exact "add images behind me" case. Fails on the base (no photo).
- `editorial.test.ts` in `packages/edit` (unit): catches a merge that breaks checklist links or an
  editorial answer that could carry geometry. Fails on the base (module absent).
- `editorial.test.ts` in `apps/worker` (unit, AI double): catches a first run without its one round,
  a request that stops before its item is placed or loops past 3, and an impossible request without
  a reason. Fails on the base.
- `run-decide.test.ts` (unit, AI double): catches a decided version saved without its checklist or
  with an impossible ask's reason lost. Fails on the base (no `checklist` on the row).
- `versions.test.ts` (DB): catches `save_version` not storing `p_checklist` or the column missing.
  Fails on the base.

### Edge Cases

- No `requested` (automatic run, first version): output byte-identical to today (goldens unchanged).
- Two requested items competing for the same time: neither removed for the other, the later one
  shifted or dropped with its reason.
- A requested item that only fits over the face: placed late with `covers-face` `make-room`, and
  the worker does not log it as an engine bug.
- A requested photo with an empty library: no photo can be named. The checklist entry has empty
  `fulfilled_by` and `why_not`, and the stored outcome is not done with that reason.
- A removed transition: its captions become a sentence block and are still placed (never dropped).
- An editorial answer that skips a requested item: removed from the answer, links re-indexed, the
  outcome not done with the `why`.
- An editorial answer naming a photo the reel's rules forbid, or a third photo: the merged answer
  is refused by `parseDecideAnswer`, the rounds end, the version saves without it.
- The AI double's single envelope replayed into a round: refused as an editorial answer, rounds end.
- `AiUnavailable` in a round (automatic run vs request with a requested item unplaced).
- A one-sentence clip: no free sentence, no round, no extra AI cost.
- Hidden footage across the shifted span: a shift never crosses it.

## Acceptance Criteria

- A requested item is placed whenever any ladder step can place it, in the order: move captions,
  shrink or wrap captions, remove Claude's own extras, shift within its sentence, cover the face,
  with each step taken recorded under rule `make-room`.
- No step ever removes a caption, sets one below the preset floor, puts one over the face, leaves
  the safe zone or drops or removes another requested item.
- Without a request the engine's output is unchanged (committed goldens untouched).
- The automatic run makes at most one editorial round, and only when an unplaced item has a free
  sentence. A request makes rounds while a requested item is unplaced, at most 3.
- Claude never receives or writes coordinates, sizes, spots or times in either prompt or answer.
- Every decided version stores `checklist` entries `{ ask, wants, fulfilled_by, done, reason }`. A
  truly impossible ask stores the exact reason and what the owner can do.
- The 2026-11-03 "add images behind me" case is a committed fixture version with the photo placed.
- `app_docs/decide-step.md` and `app_docs/edit-model.md` describe the feature with Rules lines,
  `docs/conditional-docs.md` and `.adw/project.md` are in step, and no file has an em-dash.
- Lint, typecheck, knip, format, unit, DB, build and E2E pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: formatting over the whole repository.
- `yarn turbo run lint --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio`:
  lint for the edit package and its dependents (worker, studio).
- `yarn turbo run typecheck --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio`:
  types across the new `Placement`, `NewVersion` and editorial types.
- `yarn knip`: no unused export from `editorial.ts` or the engine.
- `yarn turbo run test --filter=...{./packages/edit} --filter=./apps/worker --filter=./apps/studio`:
  the engine, editorial, decide, run-decide and prompt unit tests, the Node and browser golden
  build tests (with the new fixture) and the migration version guard.
- `yarn workspace @edit-issebya/edit golden && git status --porcelain packages/edit/src/testdata`:
  regenerates the fixtures. Only the three new `rethink-work-request` files may appear (the
  existing fixtures are byte-identical).
- `yarn workspace @edit-issebya/worker test:tools`: the worker's real-tool tests (owner's Mac only,
  never in CI).
- `.adw/supabase-stack reset`: applies the new migration to the ADW stack before the DB and E2E
  tests.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` for `versions.checklist` and
  `save_version`'s `p_checklist`, plus every other DB test against the new signature.
- `yarn turbo run build --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`:
  build (typecheck for the packages and the worker, `next build` for the studio).
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: the
  landing then studio suites (the upload spec's `decide-7`, and the behind, decide-behind and
  change-requests specs that run the worker's `once` through the new rounds), against the
  `/prepare_app` server.

## Notes

- No new library. Zod 4 (already a dependency of `packages/edit`) covers the editorial schema.
- Keep `PROMPT_VERSION` single (`decide-7`) for both prompts. The version row records one value.
- The editorial round never rewrites `change_title` or `change_summary`. Item 6 builds the honest
  summary from `versions.checklist` and `versions.engine_record`.
- The `free` probes are hints only. Whatever Claude picks is placed for real by the engine, and may
  still be dropped and recorded.
- Never point a test at the real `claude` binary. Every AI call in tests goes through
  `fakeAiRunner` or `E2E_MOCK_AI_SCRIPT`.
- Commits: Conventional Commits, bare type, no trailers (`feat: make room for requested items in
the layout engine`, `feat: editorial round and stored checklist in decide`, `docs: ...`).
