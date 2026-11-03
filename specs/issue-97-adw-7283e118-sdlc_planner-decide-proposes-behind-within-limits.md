# Feature: decide proposes up to 2 library photos and 1 big word behind the speaker, within limits

## Metadata

issue_number: `97`
adw_id: `7283e118`
issue_json: `{"number":97,"title":"feat: decide proposes up to 2 library photos and 1 big word behind the speaker, within limits"}`

## Feature Description

After #20 the edit format has a `behind` track (a library photo in one of three preset spots, or one
big word, behind the speaker, cut out on demand) and after #96 the owner has a photo library that
Claude described and tagged. Today the decide step only puts something behind the speaker when the
owner asks for it in a change request. This feature lets the automatic decide (version 2 of a fresh
reel) propose them too, inside hard limits the owner set on 2026-11-02:

- per reel at most **2 photos and 1 big word**, each **2 to 4 seconds**, anchored on words;
- a photo only where a sentence clearly matches a library photo's description or tags (no match,
  no photo; an empty library means no photos, never an error);
- the big word only for the reel's key word, taken from the spoken words;
- the spot (`top`, `left`, `right`) chosen per moment from the head track, so the face does not take
  over the picture and no caption sits on it (two new layout checks, through the existing one retry);
- corrections win: a change request can add, remove or forbid them ("no photos in this one"), and a
  forbid is stored on the reel and holds for every later decide and change run until a later request
  lifts it.

## User Story

As the owner of the studio (a reel editor)
I want the first AI edit to already place a fitting library photo or one big key word behind the
speaker, never more than the agreed limits, and to be able to switch that off for a reel for good
So that most reels need no correction for it, and a reel I said "no photos" for never gets one back

## Problem Statement

Photos and the big word only appear when the owner asks in a correction, so every reel needs a
manual round trip. Letting the AI propose them without limits would be worse: too many items, loose
photo fits, photos where the head covers them or captions run over them, and no way to make a "no
photos" stick across later changes.

## Solution Statement

- **Limits in the schema and in Zod** (`packages/edit`): the preset gains `behind.maxPhotos` (2),
  `behind.maxWords` (1) and `behind.maxFaceShare` (0.4). `EditLimits` gains `behindCounts`; with it
  the `behind` array carries `.max(photos + words)` (a real `maxItems` in the draft-07 JSON Schema)
  and `refineBehind` refuses a third photo or a second word with a readable reason. The 2 to 4 s
  length is already a Zod refinement (`refineBehind`); it stays there, since JSON Schema cannot
  resolve word anchors to times (stated in the doc). `photo_id` stays the enum of the owner's ready
  ids (`z.never()` for an empty library, so an unknown id is refused by both layers).
- **Behind rules on the answer**: the decide answer gains a required, closed
  `behind_rules: { photos: "keep" | "forbid" | "allow", big_word: "keep" | "forbid" | "allow" }`.
  `keep` leaves the reel's flag, `forbid` sets it, `allow` lifts it. Without a request (the automatic
  run) both enums are only `["keep"]`. A Zod refinement on the answer refuses a photo (or a word)
  while the effective rule (stored flag with the answer's rule applied) forbids it, and, on the
  automatic run, a big word whose text is not one of the words spoken inside its own span.
- **Stored on the reel**: a migration adds `reels.no_photos` and `reels.no_big_word` (boolean, not
  null, default false) and replaces `save_version` with two more defaulting parameters
  (`p_no_photos`, `p_no_big_word`, null = unchanged) written in the same transaction as the version,
  so a saved "no photos" version and its flag can never disagree. Restore and the first version pass
  null, so going back never lifts or sets a forbid.
- **Prompt inputs** (`apps/worker/src/decide/`): the library stays quoted as fenced JSON under the
  data-not-instructions line; the head track summary gains `spans`, one per spoken sentence (word
  ids, times, the face box over it and `clear_spots`, the spots passing the face rule); the input
  gains `behind_rules` (the reel's current flags). Step 5 of `prompt.md` is rewritten to the owner's
  rules. `PROMPT_VERSION` becomes `decide-3`. With photos forbidden and no request, the library sent
  is empty and the photo enum is `z.never()`.
- **Layout checks** (`packages/edit/src/checks.ts`): `behind-face` (the share of a photo's spot the
  face box covers over the photo's span is at most `preset.behind.maxFaceShare`) and
  `behind-caption` (no caption shown during the photo's span intersects its spot). They run in
  `runChecks`, so the decide build reports them and a failure goes through the existing single retry.
  The shared helper `spotFaceShare` in `behind.ts` feeds both the check and the prompt's
  `clear_spots`, so the two never disagree.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: repository rules, migration rule, test layers; the
  profile's Tests section lists every E2E spec and DB test and must name the new ones.
- `docs/conditional-docs.md`: index; the decide-step and edit-model lines gain the new terms.
- `app_docs/decide-step.md`: the decide step's schema, prompt, retry and Rules (invariants: two AI
  calls at most, the library quoted as data, `photo_id` only a ready library id, masks before save).
- `app_docs/edit-model.md`: the edit format, `behind` track, checks, `save_version`, preset.
- `app_docs/change-requests.md`: change jobs run `runDecide` with the request; documents the forbid.
- `app_docs/photo-library.md`: the ready library the decide step reads (no change expected; read for
  `readyPhotos` semantics).
- `app_docs/pipeline.md`: the head track format and the on-demand cut-out (read only).
- `packages/edit/src/preset.ts`: `PresetBehind` and `ISSEBYA_PRESET.behind` (new limits).
- `packages/edit/src/schema.ts`: `EditLimits`, `tracksSchemaFor`, `refineEdit`, `refineBehind`.
- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor`, `decideJsonSchema`, `parseDecideAnswer`,
  `editFromAnswer` (gain the behind rules and counts).
- `packages/edit/src/checks.ts`: `CheckRule`, `runChecks` (two new rules).
- `packages/edit/src/behind.ts`: `spotBox`; new `spotFaceShare`.
- `packages/edit/src/head-track.ts`: `faceBox` (used with zero padding like the caption face check).
- `packages/edit/src/layout.ts`: `TextBox` (captions' boxes and spans for `behind-caption`).
- `packages/edit/src/build.ts`: calls `runChecks` with the resolved timeline (passes the boxes).
- `packages/edit/src/versions.ts`: `NewVersion`, `VersionMeta`, `saveVersion` (forbid parameters).
- `packages/edit/src/index.ts`: exports.
- `packages/edit/src/testdata/versions/rethink-work-behind.edit.json` and
  `packages/edit/src/testdata/golden/rethink-work-behind.*`: the stored fixture with a `top` photo.
  Measured during planning: during that photo (5.206 to 7.838 s) captions `cw18`, `cw19`, `cw21` to
  `cw24`, `cw26`, `cw27` (x 136 to 393, y 610 to 745) sit inside the `top` spot, so the new
  `behind-caption` check would fail it, and `checks.test.ts` asserts every fixture passes. In the
  `right` spot (x 580 to 1040) no caption crosses it and the face covers 31% of it, under 0.4.
- `packages/edit/src/checks.test.ts`, `schema.test.ts`, `decide.test.ts`, `behind.test.ts`,
  `timeline.test.ts`, `versions.test.ts`: unit tests to extend and adjust.
- `packages/edit/scripts/golden.ts` (`yarn workspace @edit-issebya/edit golden`): regenerates goldens.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`: the prompt and `PROMPT_VERSION`.
- `apps/worker/src/decide/input.ts`: `headTrackSummary`, `presetSummary`, `decideInput`.
- `apps/worker/src/decide/run-decide.ts`: reads the library, builds the schema, two attempts, saves.
- `apps/worker/src/decide/run-decide.test.ts`, `prompt.test.ts`: worker unit tests.
- `apps/worker/src/decide/testdata/short-speech-answer.json`: the committed scripted answer (gains
  `behind_rules`).
- `apps/worker/src/ai.ts` (`EMPTY_DECIDE_ANSWER`), `apps/worker/src/doctor-checks.ts` and their tests:
  must keep passing the new required field.
- `apps/worker/src/version-store.ts`: `supabaseVersionRows` maps `NewVersion` to `save_version`.
- `apps/worker/src/process-job.ts`: wires `runDecide` (gains the reel rules store).
- `apps/worker/src/photos/photo-store.ts`: `PhotoLibrary.readyPhotos` (unchanged; empty library ok).
- `apps/worker/src/cutout/test-support.ts`: refers to the fixture's top photo.
- `apps/studio/src/lib/tracks-timeline.test.ts`, `apps/studio/src/lib/preview-page.test.ts`: use the
  `rethink-work-behind` fixture (`photo top`).
- `apps/studio/test-support/ai-script.ts`: scripted answers (`unchangedAnswerScript`,
  `writeBehindAnswer`, `behindPhotoAnswerScript`); gains the rules and a multi-envelope helper.
- `apps/studio/test-support/pipeline-cache.ts` (`seedProcessedReel({ aiScript })`),
  `apps/studio/test-support/photos.ts` (`seedReadyPhoto`), `apps/studio/test-support/worker.ts`.
- `apps/studio/e2e/behind.spec.ts`: model for the new spec (seeking, the photo box, Behind row).
- `apps/studio/db-tests/versions.test.ts`: `save_version` DB tests to extend.
- `supabase/migrations/20261101175625_version_decide_records.sql`: the current `save_version` (its
  body, revoke and grant are the model for the replacement).

### New Files

- `supabase/migrations/<stamped>_reel_behind_rules.sql`: created with
  `supabase migration new reel_behind_rules`; adds the two reel columns and replaces `save_version`.
- `apps/worker/src/decide/behind-rules.ts`: `BehindRules` type, `ReelRules` store
  (`read(reelId)`), `supabaseReelRules(db)` (service role, `reels.no_photos, no_big_word`) and
  `applyRules(stored, answerRules)`.
- `apps/worker/src/decide/input.test.ts`: unit tests for `sentenceSpans` and the summary's `spans`.
- `apps/studio/e2e/decide-behind.spec.ts`: the browser spec.

## Implementation Plan

### Phase 1: Foundation

Preset limits, the shared `spotFaceShare` helper, `EditLimits.behindCounts` with the array cap and
the per-kind refinement, the two layout checks, and the fixture moved to the `right` spot with its
golden regenerated, so `packages/edit` passes on its own.

### Phase 2: Core Implementation

The decide answer's `behind_rules`, the rule refinement (forbid, spoken key word, request-only
`forbid`/`allow`), the migration with the reel columns and the new `save_version`, `NewVersion` and
`supabaseVersionRows` carrying the forbid, the worker's reel rules store, the prompt input
(`spans`, `clear_spots`, `behind_rules`) and the rewritten step 5 with `PROMPT_VERSION` `decide-3`.

### Phase 3: Integration

`runDecide` reads the reel's rules, builds the schema with them, saves the effective flags with the
version; `process-job.ts` wires the store; scripted answers and helpers gain the field; the new E2E
spec; docs and the profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before touching code

- Read `app_docs/decide-step.md`, `app_docs/edit-model.md`, `app_docs/change-requests.md` and their
  Rules sections; every "never" there stays true (two AI calls at most, library quoted as data,
  `photo_id` only a ready library id, masks stored before the version, never cache decide, bump
  `PROMPT_VERSION` with `prompt.md`).

### 2. Preset limits (`packages/edit/src/preset.ts`)

- Add to `PresetBehind`: `maxPhotos: number`, `maxWords: number` (per version) and
  `maxFaceShare: number` (the largest share, 0 to 1, of a photo's spot the face box may cover).
- `ISSEBYA_PRESET.behind`: `maxPhotos: 2`, `maxWords: 1`, `maxFaceShare: 0.4`, under the existing
  "Starting values; the owner tunes them by eye" comment.

### 3. `spotFaceShare` (`packages/edit/src/behind.ts`)

- `export function spotFaceShare(spot: BehindSpot, face: Box | null, preset: Preset): number`: the
  intersection area of `spotBox(spot)` and `face` divided by the spot's area; 0 for a null face.
- Export it from `index.ts`. Unit test in `behind.test.ts`: no face gives 0; a face fully inside
  `left` gives face area over spot area; a face outside gives 0.

### 4. Behind counts in the schema (`packages/edit/src/schema.ts`)

- `EditLimits` gains `behindCounts?: { photos: number; words: number }` (comment: the decide limits;
  stored versions parse without them).
- In `tracksSchemaFor`, when `behindCounts` is set the `behind` array is
  `z.array(behind).max(photos + words)` (shows as `maxItems` in the JSON Schema).
- Pass `limits` into `refineEdit` and `refineBehind`; with `behindCounts`, add an issue per extra
  item: `behind <id>: a third photo; at most 2 photos per reel` (wording from the numbers) and
  `behind <id>: a second big word; at most 1 per reel`, in item order.
- Tests in `schema.test.ts`: with the counts, three photos are refused (the third named), two words
  are refused, two photos and one word pass; without the counts three photos still parse (stored
  versions are not limited); a 5-second photo is refused (existing length rule, asserted again here
  for the issue's verification).

### 5. Layout checks (`packages/edit/src/checks.ts`)

- `CheckRule` gains `"behind-face"` and `"behind-caption"`.
- `runChecks` takes the behind photos' resolved spans from `resolved` (already passed). For each
  `behind` item of kind `photo`:
  - `behind-face`: `face = faceBox(headTrack, start, end, { left: 0, right: 0 })`; when
    `spotFaceShare(item.spot, face, preset) > preset.behind.maxFaceShare + SLACK`, push
    `{ rule: "behind-face", item: id, reason: "photo <id> in the <spot> spot: the face covers <n>% of it, more than <max>%; pick a spot clear of the head" }`.
  - `behind-caption`: every caption box whose `[start, end)` overlaps the photo's span and whose
    rectangle overlaps `spotBox(item.spot)` gives
    `{ rule: "behind-caption", item: id, reason: "photo <id> in the <spot> spot sits under caption <cid> (<text>); pick another spot" }`.
- Keep the stable order: append the two rules after `frame` and before `face` (update the function
  comment).
- Tests in `checks.test.ts` (on `rethink-work-hand`/`rethink-work-behind` inputs, like the existing
  ones): a photo in `left` over a face fully inside the spot fails `behind-face`; the same photo with
  an empty head track passes; a photo in `top` during the captions measured above fails
  `behind-caption` naming the caption; the existing "passes the stored fixture versions" test must
  still pass (step 6).

### 6. Move the stored fixture's photo to `right`

- In `packages/edit/src/testdata/versions/rethink-work-behind.edit.json` set `behind-photo`'s
  `spot` to `"right"` (planning measured: no caption crosses it, face share 31%).
- Regenerate its golden with `yarn workspace @edit-issebya/edit golden` and review the diff (only
  the photo's `style` line and anything derived from it should change).
- Update the tests that name the old spot: `behind.test.ts` (the `<img id="behind-photo" ...>` line:
  `left: 580px; top: 560px; width: 460px; height: 620px`), `apps/studio/src/lib/tracks-timeline.test.ts`
  (`photo right`), `apps/studio/src/lib/preview-page.test.ts` and the comment in
  `apps/worker/src/cutout/test-support.ts` if they mention `top`. Run `packages/edit`'s Node and
  browser tests: the browser layer compares the same golden byte for byte.

### 7. Behind rules on the decide answer (`packages/edit/src/decide.ts`)

- `export type BehindRule = "keep" | "forbid" | "allow"` and
  `export interface DecideRules { requested: boolean; forbid: { photos: boolean; bigWord: boolean } }`
  with `NO_RULES` (`requested: false`, both false) as the default.
- `decideAnswerSchemaFor(preset, transcript, duration, photoIds = [], rules = NO_RULES)`:
  - tracks with limits `{ duration, bounds: preset.safe, photoIds, behindCounts: { photos: preset.behind.maxPhotos, words: preset.behind.maxWords } }`;
  - `behind_rules: z.object({ photos: rule, big_word: rule })` where `rule` is
    `z.enum(["keep", "forbid", "allow"])` when `rules.requested`, else `z.enum(["keep"])`;
  - `.superRefine`: the effective forbid (`forbid` sets, `allow` lifts, `keep` keeps the stored one)
    refuses each photo item while photos are forbidden (`behind <id>: photos are switched off for
this reel by the owner; leave them out`) and each word item while the big word is; on the
    automatic run (`!rules.requested`) a word item whose text, compared through `cleanWord` and
    case-insensitively, is not one of the transcript words resolved inside its span is refused
    (`behind <id>: the big word must be one of the words spoken while it shows`).
- `decideJsonSchema` and `parseDecideAnswer` take the same `rules` argument and pass it through
  (the JSON Schema drops the refinement, as it already does for `editSchemaFor`).
- `editFromAnswer` parses with the same `behindCounts`, so Zod checks the counts on the composed
  edit too.
- Export `BehindRule`, `DecideRules`, `NO_RULES` and an `applyBehindRules(stored, answer)` helper
  (pure, used by the refinement and by the worker) from `index.ts`.
- Tests in `decide.test.ts`: the JSON Schema is draft-07, `behind` has `maxItems: 3`, `photo_id`
  is an `enum` of the given ids, `behind_rules` enums are `["keep"]` without a request and all three
  with one; `parseDecideAnswer` refuses an unknown photo id, a third photo, a 5-second photo, a photo
  under a stored photos forbid with `keep`, accepts one under a stored forbid with `allow`, refuses
  `forbid` on the automatic run, refuses an unspoken big word on the automatic run and accepts it on
  a requested run; an empty library makes `photo_id` refuse every id.

### 8. Migration: reel behind rules and `save_version`

- `supabase migration new reel_behind_rules` (never hand-pick the version).
- `alter table public.reels add column no_photos boolean not null default false, add column no_big_word boolean not null default false;` with column comments ("set by a change request, lifted only by a later one").
- Drop the 15-argument `save_version` and create it again with two more parameters
  `p_no_photos boolean default null, p_no_big_word boolean default null`; the body is the current one
  plus, in the same `update public.reels`, `no_photos = coalesce(p_no_photos, no_photos)` and
  `no_big_word = coalesce(p_no_big_word, no_big_word)`. Revoke from `public, anon, authenticated`,
  grant to `service_role` with the full 17-type signature; `notify pgrst, 'reload schema'`.
- The owner keeps table-level `select` on `reels` (reads the flags); no new insert or update grant,
  so only the worker writes them.
- Run `.adw/supabase-stack reset` before the DB and E2E tests.

### 9. Versions mirror (`packages/edit/src/versions.ts`, `apps/worker/src/version-store.ts`)

- `NewVersion` gains `no_photos?: boolean | null` and `no_big_word?: boolean | null`; `VersionMeta`
  gains `forbid?: { photos: boolean | null; bigWord: boolean | null }`, mapped by `saveBytes`
  (absent: null). `restoreVersion` and the first version pass nothing.
- `supabaseVersionRows.save` passes `p_no_photos` and `p_no_big_word`.
- `versions.test.ts` (unit): the meta reaches the row; restore leaves both null.

### 10. DB test (`apps/studio/db-tests/versions.test.ts`)

- `save_version` with `p_no_photos => true` sets `reels.no_photos`; a later call with null leaves
  it true; `false` lifts it; `p_no_big_word` likewise; an authenticated owner can read both columns
  and cannot update them (RLS/grant refusal).

### 11. Worker reel rules (`apps/worker/src/decide/behind-rules.ts`)

- `ReelRules { read(reelId): Promise<{ photos: boolean; bigWord: boolean }> }` and
  `supabaseReelRules(db)` (select `no_photos, no_big_word` from `reels` by id; `supabaseFailure` on
  error, a missing reel throws).

### 12. Prompt input (`apps/worker/src/decide/input.ts`)

- `sentenceSpans(transcript)`: consecutive words grouped into spoken sentences, a sentence ending
  after a word whose text ends in `.`, `?` or `!`, or before a pause of at least
  `SENTENCE_PAUSE_SECONDS` (0.6) to the next word.
- `headTrackSummary(track, transcript, preset)` adds
  `spans: { from: wordId; to: wordId; start; end; face_box: Box | null; clear_spots: BehindSpot[] }[]`,
  `face_box` from `faceBox(track, start, end, { left: 0, right: 0 })` and `clear_spots` the spots
  with `spotFaceShare <= preset.behind.maxFaceShare` (all three without a head).
- `presetSummary`'s `behind` gains `max_photos`, `max_words`, `max_face_share`.
- `DecideInput` gains `behind_rules: { photos_forbidden: boolean; big_word_forbidden: boolean }`.
- `decideInput` takes `rules` and, when photos are forbidden and there is no request, sends an empty
  library.
- `input.test.ts`: sentences split on punctuation and on a pause; `clear_spots` drops a spot the
  face covers more than the preset allows and keeps all three with no head; the library is emptied
  only for a forbidden, request-less run.

### 13. Prompt (`apps/worker/src/decide/prompt.md`, `prompt.ts`)

- Rewrite step 5: the `behind` track may hold at most 2 photos and 1 big word per reel, each 2 to 4
  seconds, anchored on words, a hard cut, one at a time; a photo only where a sentence clearly
  matches a library photo's description or tags, never a loose fit, no match no photo, an empty
  library no photo; the big word only for the reel's key word, written as it is spoken in its span;
  the spot from the sentence's `clear_spots` in the head summary, keeping captions off the photo;
  keep, move, swap or remove as today.
- Add a step for corrections: when the request says to drop or forbid photos or the big word ("no
  photos in this one"), leave them out and set `behind_rules` to `forbid`; when it asks for them
  again, `allow`; otherwise `keep`. While `behind_rules` in the input says forbidden, add none
  unless the request lifts it. Without a request, always `keep`.
- Add `{{behind_rules}}` (fenced JSON) and describe `spans` in the head-track line. Keep the
  library under the existing data-not-instructions line, fenced.
- `PROMPT_VERSION = "decide-3"`.
- `prompt.test.ts`: the library appears as fenced JSON after the data line (an instruction-like
  description stays inside the fence), `behind_rules` and `spans` are filled, the version is
  `decide-3`.

### 14. `runDecide` (`apps/worker/src/decide/run-decide.ts`)

- `DecideRun` gains `rules?: ReelRules` (none: nothing forbidden).
- Read the stored flags; `decideRules = { requested: request !== null, forbid }`; when photos are
  forbidden and there is no request, `photoIds = []` and the library sent is empty.
- Pass `decideRules` to `decideJsonSchema`, `parseDecideAnswer` and `decideInput`; the two
  attempts, the build checks (now including `behind-face` and `behind-caption`) and the retry are
  unchanged.
- After a pass, compute the effective flags with `applyBehindRules` and pass to `saveVersion`
  `forbid: { photos, bigWord }` only where the answer's rule is not `keep` (null otherwise).
- `process-job.ts`: pass `rules: supabaseReelRules(db)`.
- `run-decide.test.ts`: a fresh run with a one-photo library and an answer placing it saves it
  (`, 1 behind`); an answer with a third photo is refused then the retry passes, with
  `rejected_reasons` naming it; a change with `behind_rules.photos: "forbid"` and no photo saves
  with `no_photos: true`; with the stored forbid a later answer with a photo and `keep` is refused
  and its retry without passes, saving `no_photos: null`; an empty library sends `[]` and an empty
  `photo_id` enum and still saves; a `behind-face` failure in round one goes through the retry.

### 15. Scripted answers and other callers

- Add `"behind_rules": { "photos": "keep", "big_word": "keep" }` to
  `apps/worker/src/decide/testdata/short-speech-answer.json`, `EMPTY_DECIDE_ANSWER` in `ai.ts`, the
  doctor's sample answer, `unchangedAnswerScript` in `apps/studio/test-support/ai-script.ts` and
  any answer literal the tests build (typecheck and the unit tests find them).
- `ai-script.ts`: `writeBehindAnswer` takes optional `rules` and a list of rounds; add
  `forbidPhotosAnswerScript(dir)` (the committed answer, no `behind`, `photos: "forbid"`) and
  `answerRoundsScript(dir, rounds)` writing several envelopes (replayed in order) for the refused
  then passing case.

### 16. E2E spec (`apps/studio/e2e/decide-behind.spec.ts`)

- Model it on `behind.spec.ts` (same cleanup, `claimableJobIds` guard, 1440x900, serial).
- Seed a ready photo with `seedReadyPhoto`, then `seedProcessedReel({ aiScript })` with
  `behindPhotoAnswerScript(dir, photo.id, "left")`: the `process` job's decide proposes it.
  Assert version 2 has `tracks.behind` with one photo item, spot `left`, `inputs.photos` equal to
  `[photo.id]` and one mask; open the reel page, the timeline's Behind row shows `photo left`.
- Send `no photos in this one`, run `once` with `forbidPhotosAnswerScript`: version 3 has no
  `behind` items, `inputs.photos` absent, `reels.no_photos` is true, the Behind row is empty.
- Send `make the title shorter`, run `once` with `answerRoundsScript`: round one places the photo
  with `keep` (refused), round two leaves it out. Version 4 has no photo, its `rejected_reasons`
  contain `photos are switched off for this reel`, `reels.no_photos` stays true, the Behind row is
  empty.
- The spec fails without the feature: version 2 would carry no `behind_rules` field (scripted
  answer refused), and nothing would set `no_photos` or refuse round one.

### 17. Docs and profile

- `app_docs/decide-step.md`: the limits and where each is enforced (JSON Schema: enums and
  `maxItems`; Zod: counts, length, forbid, spoken key word), `behind_rules`, `spans` and
  `clear_spots`, `decide-3`, the new checks in the attempt, the new spec and tests. Add Rules:
  "Never more than `maxPhotos` photos and `maxWords` big words in a decide answer", "Never propose a
  photo or big word the reel's rules forbid; only a request may set or lift a rule", "A forbid is
  written with its version in one `save_version` call".
- `app_docs/edit-model.md`: preset fields, `behindCounts`, the two check rules, the fixture's spot,
  `save_version`'s 17 parameters, `reels.no_photos` and `no_big_word`.
- `app_docs/change-requests.md`: "no photos" / "no big word" and how they are lifted; restore keeps
  the flags.
- `docs/conditional-docs.md`: the decide-step line names the behind limits and the reel's behind
  rules; the edit-model line names the `behind-face` and `behind-caption` checks.
- `.adw/project.md` Tests section: add `decide-behind.spec.ts` to the E2E list and the reel rules
  case to `versions.test.ts`'s description (nine headings untouched).
- No em-dashes anywhere.

### 18. Validate

- Run every command in `Validation Commands` (after `.adw/supabase-stack reset`).

## Testing Strategy

### Unit Tests

- `packages/edit`: `schema.test.ts` (counts, length), `decide.test.ts` (JSON Schema shape, rules
  enums, forbid, spoken key word, unknown id, empty library), `checks.test.ts` (`behind-face`,
  `behind-caption`, fixtures pass), `behind.test.ts` (`spotFaceShare`, the moved photo), browser
  goldens.
- `apps/worker`: `input.test.ts` (sentences, `clear_spots`, library emptied), `prompt.test.ts`
  (library as fenced data, rules filled, `decide-3`), `run-decide.test.ts` (propose, refuse a third
  photo, forbid saved, forbid holds, empty library, face check retry), `ai.test.ts` and
  `doctor-checks.test.ts` still passing with the new field.
- `apps/studio`: `tracks-timeline.test.ts` and `preview-page.test.ts` after the fixture move.

### Test Coverage

- Unit, `packages/edit/src/decide.test.ts`: a third photo, a 5-second photo and an unknown photo id
  are refused, and a photo under a stored forbid; catches the AI exceeding the owner's limits, which
  nothing refuses today (three photos parse now).
- Unit, `packages/edit/src/checks.test.ts`: `behind-face` and `behind-caption`; catches a photo the
  head covers or a caption runs over, which no check reports today.
- Unit, `apps/worker/src/decide/prompt.test.ts` and `input.test.ts`: the library quoted as data,
  `spans` with `clear_spots`, `behind_rules`; catches a prompt missing the inputs the AI needs.
- Unit, `apps/worker/src/decide/run-decide.test.ts`: the forbid flag saved with the version and
  honoured on the next run; nothing stores or honours it today.
- DB, `apps/studio/db-tests/versions.test.ts`: `save_version` writes and keeps the reel flags and
  the owner cannot change them; catches a migration that drops or mis-grants them.
- E2E, `apps/studio/e2e/decide-behind.spec.ts`: a fresh reel's version 2 has the photo in `left`,
  "no photos in this one" removes it, a later change keeps it out; fails today because the answer
  has no `behind_rules` and no rule is stored.

### Edge Cases

- Empty library: `photo_id` is `z.never()`, the library is `[]`, the step still saves (no error).
- Photos forbidden on an automatic run (a Retry of a `process` job after a forbid): no library, no
  photo enum, rules only `keep`.
- A forbid and an `allow` for the other kind in one answer; `allow` when nothing is forbidden (no-op,
  saves null for that kind is fine since the value is unchanged; save `false` explicitly).
- Lift and add in one answer (`allow` plus a photo) passes.
- No head in the clip: `clear_spots` all three, `behind-face` passes.
- A photo spanning two sentences: `behind-face` uses the face over the photo's own span.
- A third photo, a second word, a 1.9 s and a 4.1 s item; a word not spoken in its span on the
  automatic run; a requested word not spoken (allowed).
- Restore after a forbid keeps the flag; a restored version naming a photo still builds (stored
  versions are not limited).

## Acceptance Criteria

- The decide answer's JSON Schema is draft-07 with `photo_id` an enum of the owner's ready ids,
  `spot` an enum, `behind` `maxItems` 3, and `behind_rules` enums (`keep` only without a request).
- Zod refuses a third photo, a second big word, an item outside 2 to 4 s, an unknown photo id, a
  forbidden kind, and on the automatic run a big word not spoken in its span.
- `runChecks` reports `behind-face` and `behind-caption`; a failing first answer gets the existing
  one retry and never a third call.
- The prompt quotes the library as fenced JSON under the data-not-instructions line, includes
  `spans` with `clear_spots` and `behind_rules`; `PROMPT_VERSION` is `decide-3`.
- `reels.no_photos` and `reels.no_big_word` are written only through `save_version` with the version,
  hold for later decide and change runs, are lifted only by a later request, and are unchanged by
  restore.
- An empty library gives a version with no photos and no error.
- Every stored fixture still builds with no checks; goldens match in Node and in the browser.
- Lint, typecheck, knip, format, unit, DB, build and E2E pass; no em-dashes; no AI attribution.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: applies the new migration to the ADW stack before DB and E2E tests.
- `yarn format:check`: formatting over the whole repository.
- `yarn turbo run lint --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: lint of the three changed workspaces.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: typecheck (also the build check of `packages/edit` and the worker).
- `yarn knip`: no unused export or file (new helpers must be used).
- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: unit tests, the edit package's browser goldens and the migration version guard.
- `yarn turbo run test:db --filter=./apps/studio`: `save_version` and the reel rule columns against the ADW stack.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with the changed package.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E suites, including `decide-behind.spec.ts`, `behind.spec.ts`, `upload.spec.ts` and `change-requests.spec.ts` (needs the `/prepare_app` server on this run's port).

## Notes

- No new dependency.
- The worker workspace has no browser surface; the browser evidence is the studio spec. The tools
  layers (`test:tools`) are untouched: no ffmpeg, HyperFrames or mask tool change. The owner may run
  `yarn workspace @edit-issebya/studio test:tools` on their Mac, but the guardrail uses the `top` spot
  on a clip with no head and captions at y 1290, so the new checks do not refuse it.
- Interpretation recorded for the owner: `behind-face` measures how much of the photo the face box
  covers (the photo is behind the speaker, so the face itself is never hidden; what suffers is the
  picture). `maxFaceShare` 0.4 is a starting value to tune by eye, like the spots. `behind-caption`
  covers captions only, as the issue says; accent overlays may still sit on a photo (the fixture
  clip's accent line at y 1130 is inside the `left` and `right` spots, which `behind.spec.ts` uses).
- The 2 to 4 s length and the per-kind counts cannot be written in draft-07 JSON Schema (anchors
  resolve to times only against the transcript, and `maxContains` is newer than draft-07); the JSON
  Schema carries `maxItems` and the enums, Zod carries the rest, each with a readable reason for the
  retry.
- The limits apply to change runs too (the same schema); a correction can add, move, swap, remove
  or forbid within them.
- Not in scope: showing the reel's behind rules in the studio UI (the change summary says what was
  done); a follow-up could show "photos off" beside the change box.
- Owner acceptance after merge: one real reel in development, end to end, judged by eye.
