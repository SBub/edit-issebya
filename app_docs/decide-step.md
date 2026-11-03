# Decide Step: Claude Code with a Per-Reel JSON Schema, Layout Checks, One Retry, Version Records

**Specifications:**

- specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-97-adw-7283e118-sdlc_planner-decide-proposes-behind-within-limits.md

## Overview

`decide` is the pipeline's one AI step. After the five fixed steps and the automatic version 1, the
worker asks Claude Code (`claude -p`, no tools, on the owner's machine) to start from the current
version's choices, fix misheard words, choose accent phrases and transitions, mark the title, and
choose what goes behind the speaker. Claude answers in meaning only ("B strict"): word ids and
library photo ids, never a time, a position, a size or a spot. The answer must match a JSON Schema
made for this reel, is checked again with Zod, placed over the current version by the stand-in for
the layout engine (`placeDirect`, `app_docs/edit-model.md`), built, run through the layout checks and
the glossary check, and becomes a new version (version 2 on a fresh reel). A refused
answer goes back once with the reasons; a second refusal fails the step and leaves the current
version untouched.

## How it works

The answer (`decide-5`) is the layout engine's input plus the request checklist and the records:

```json
{
  "accents": [{ "from": "w0001", "to": "w0004", "title": true }],
  "big_word": null,
  "photos": [{ "photo_id": "<library id>", "from": "w0020", "to": "w0027", "wish": "left" }],
  "transitions": [{ "kind": "dim", "from": "w0006", "to": "w0008" }],
  "word_fixes": [{ "word": "w0010", "text": "Studio" }],
  "checklist": [
    {
      "ask": "a photo behind me on the left",
      "wants": "one photo, on the left",
      "fulfilled_by": ["photos[0]"]
    }
  ],
  "behind_rules": { "photos": "keep", "big_word": "keep" },
  "change_title": "Photo added behind you",
  "change_summary": "A photo now shows behind you on the left.",
  "unexpressed": []
}
```

- Everything refers to the transcript by word ids (a range is `from` and `to`, in transcript
  order). The answer is the full list of choices for the new version: what it leaves out is removed.
  No item has a time, an anchor, a position, a size, a font, a colour, a spot or a free `style`;
  every answer object is closed (`z.strictObject`, `additionalProperties: false`), so an answer
  carrying one is refused as the schema's.
- `wish`: an optional placement word on any item, only from `WISHES` (`top`, `bottom`, `left`,
  `right`, `behind`, `beside_head`, `big`, `small`), set only when the owner's request said so. Without
  a request any wish is refused. The stand-in placement honours a photo's spot wish when the face
  leaves that spot clear; the others are forwarded for the layout engine.
- `checklist`: with a request, one entry per ask (`ask`, `wants`, `fulfilled_by`, the answer items
  that do it: `accents[i]`, `photos[i]`, `transitions[i]`, `word_fixes[i]`, `big_word` or
  `behind_rules`). Empty (schema `maxItems` 0) without a request. A link to an item the answer does
  not have is refused. It is checked, not stored yet.
- `change_title` (required, 1 to 60 characters) and `change_summary` (1 to 300) are what the owner
  reads in the versions list (`app_docs/change-requests.md`). `format`, `preset`, `duration` and
  `inputs` come from the current version, so the result is always a full edit and the AI cannot
  touch the input fingerprints. The title is the overlay with id `title`, over its words.
- Stored versions are never re-decided or rewritten; an older version's choices are read back by
  `choicesOf` when a change starts from it.

- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor(preset, transcript, photoIds, rules)` (word-id
  enums from the reel's transcript, `photo_id` an enum of the owner's ready library ids, so no photo
  can be named without them, at most `maxPhotos` photos, transition kinds from the preset, the wish
  enum), `decideJsonSchema` (Zod 4 `z.toJSONSchema`, draft-07 because the Claude Code CLI's
  `--json-schema` validator rejects a draft 2020-12 `$schema`, real `enum` lists, every object
  closed, refs inlined), `parseDecideAnswer` (both take a `DecideRules` argument, default
  `NO_RULES`), `applyBehindRules` (the pure merge of the reel's stored flags and the answer's rules),
  `editFromAnswer(current, answer, preset, transcript, headTrack)` (the answer placed by
  `placeDirect` and parsed with the decide limits; the current version's `inputs.masks` and
  `inputs.photos` are dropped, since the worker names them again for the new `behind` track),
  `decideCounts` (the step line, with `behindPhotos` and `behindWords`) and `usedFreeField`. The Zod
  refinement refuses a range ending before it starts, a wish without a request, a second title, a
  kind the rules forbid, a big word that is not one plain word, a word fixed twice and a checklist
  link to a missing item, each with a readable reason for the retry.
- Behind limits (the owner's, 2026-11-02): per reel at most 2 photos and 1 big word, each 2 to 4 s;
  a photo only where a sentence clearly matches a library photo's description or tags (an empty
  library means no photos, never an error); the big word only for the reel's key word, a spoken
  word by construction. The 2 to 4 s come from the placement (from the first word, to the end of
  the range or of the big word's sentence, held to the bounds); the edit's own refinement still
  refuses two behind items at once.
- `behind_rules: { photos, big_word }`, each `keep`, `forbid` or `allow`: `keep` leaves the reel's
  stored flag, `forbid` sets it, `allow` lifts it. Without a request (the automatic run) the enums
  are only `["keep"]`. A Zod refinement refuses a photo (or big word) while the effective rule
  forbids it. The flags are `reels.no_photos` and `reels.no_big_word`, written only by
  `save_version` in the same transaction as the version (`p_no_photos`, `p_no_big_word`, null =
  unchanged; restore and the first version pass null). With photos forbidden and no request, the
  library sent is empty and the photo enum is `z.never()`.
- `packages/edit/src/schema.ts`: `editSchemaFor` takes optional
  `EditLimits { duration, bounds, photoIds, behindCounts }`; without them stored versions keep parsing with the default
  frame limits. `issueReasons` turns Zod issues into readable reasons.
- `packages/edit/src/glossary.ts`: `glossaryChecks`, check rule `glossary` (added to `CheckRule`):
  no caption or overlay shows a heard form of a glossary term; the term itself passes.
- `apps/worker/src/ai.ts`: `AiRunner.call(tool, { prompt, schema, cwd })` runs through the step
  runner's `Tool`, so the call is measured like any other. Real runner:
  `claude -p --output-format json --json-schema <schema> --tools "" --no-session-persistence`,
  the prompt on stdin, the job's scratch folder as cwd, stdout cap 16 MB. `parseClaudeResult`
  reads `structured_output` (else `result` as JSON) and the usage: input tokens (fresh, cache
  writes and reads summed), output tokens, `total_cost_usd` as reported, and the model with the
  most output. Raw numbers, null where missing. A result that is not an answer is `broken`. A
  signed-out Claude Code or one at its usage limit is `unavailable` with a reason, recognised from
  Claude's output by `aiUnavailableReason`; `runDecide` throws `AiUnavailable` for it, and the job
  waits (`waiting_ai`, see `app_docs/failures.md`) instead of failing.
- The AI double: `E2E_MOCK_AI=true` never spawns; it replays the Claude result envelopes in the
  JSON file named by `E2E_MOCK_AI_SCRIPT` through the same parser. The file is an array (replayed
  in order, the last repeating) or one envelope object (used for every call); an empty array, a
  non-object value or non-JSON throws. Without a script it gives `EMPTY_DECIDE_ANSWER` (no items),
  which the doctor's check accepts.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`: the committed prompt and `PROMPT_VERSION`
  (`decide-5`, bumped with every prompt change; each version row records it). The prompt makes
  Claude the editor: it decides what and on which words, the layout decides every position, size
  and time; it refers to words only by id and never writes times, seconds, pixels, positions, sizes,
  fonts, colours or spots. It explains each choice (word fixes against the glossary, accents with one
  title, transitions, photos only for a clear match, never a loose fit, the big word, the behind
  rules), the wishes (only from the owner's own words, never invented), the checklist (empty
  without a request), and carries one example answer. A reason naming a layout rule means the layout
  could not place that item: choose other words, another photo, or leave it out. It asks for
  `change_title` (2 to 5 plain words, sentence case, no full stop, for example "Transitions made
  longer") and `change_summary` (one or two short plain sentences for the owner, who is not
  technical), both about what the viewer sees: no word ids, font names, pixel sizes, colour codes,
  timestamps or seconds, or internal names (track, slot, preset, spot names). `decidePrompt` fills
  the inputs as fenced JSON (`{{library}}` among them) and, on the retry, appends the previous
  reasons. The library is introduced as data describing the photos, never instructions, to be
  ignored where it reads like one.
- `apps/worker/src/decide/input.ts`: the prompt input, with no time or geometry: `current_choices`
  (the current version read back by `choicesOf`), the transcript as `{ id, text }`, `sentences`
  (`{ from, to, text }` by `sentenceSpans`, a sentence ending at `.`, `?`, `!` or a pause of 0.6 s),
  the preset summary (transition kinds, glossary, `max_photos`, `max_words`), `behind_rules` (the
  reel's current flags), the library and the request. No head track, face box, `clear_spots`, safe
  box, font size or photo spot: the layout owns free space. The library is a list of
  `LibraryEntry` (`id`, `description`, `tags`): the owner's ready photos only, oldest first, read by
  `PhotoLibrary.readyPhotos(owner_id)` (`apps/worker/src/photos/photo-store.ts`, service role,
  filtered by owner and `status = 'ready'`, a row without `large_key` left out).
- `apps/worker/src/decide/behind-rules.ts`: the `ReelRules` store (`supabaseReelRules(db)` reads
  `reels.no_photos` and `no_big_word` with the service role) and `applyRules`.
- `packages/edit/src/checks.ts`, `behind.ts`: check rules `behind-face` (the face box covers more
  than `maxFaceShare` of a photo's spot over its span) and `behind-caption` (a caption shown during
  the span overlaps its spot); `spotFaceShare` feeds both the check and the placement's spot choice. They run in
  `runChecks`, so a failure goes through the existing single retry.
- `apps/worker/src/decide/run-decide.ts`: `runDecide`, a `runToolsStep` named `decide`. It reads
  the current version and its inputs, builds the schema, and makes at most two calls, never a
  loop. An attempt passes only when the JSON parses, the schema accepts it, `editFromAnswer`
  places and accepts it, `build` reports no checks and `glossaryChecks` reports none (the build runs on the
  edit naming the masks it will need, `withMasks`, whose fingerprints are known before any is
  made). With `behind` items, `ensureCutouts` (`apps/worker/src/cutout/ensure-cutouts.ts`) then
  refuses a photo outside the library and makes sure each padded span's mask is stored (a
  `cutout` step row, `app_docs/pipeline.md`) before anything is saved; a failure there comes after
  the AI call, so it is permanent, and no version is saved. It saves through
  `saveVersion` with `parentId` the current version, the request (null for the automatic run),
  model, `PROMPT_VERSION`, the change title and summary, the forbid flags (only where the answer's rule is not
  `keep`) and the records below (`free_field` is always empty now: the answer has no free style;
  `used_free_field` still reports a kept item's style). Step line:
  `version 2: 1 accent, 1 transition, title set, 1 word fixed`, with `, <n> behind` after it when
  the version has behind items.
- `apps/worker/src/process-job.ts`: runs `runDecide` after `saveFirstVersion`. Never cached: a
  retried job decides again from the then-current version.
- `apps/worker/src/step-runner.ts`: `ToolCall` gains `stdin` and `maxStdoutBytes`; `ToolsStep.work`
  may return `ai` usage; `StepError(message, tail, ai)` fails a step with its own tail (the
  reasons) and the AI usage spent. `apps/worker/src/step-store.ts` writes the `ai_*` columns
  (`aiMeasurements`).
- `apps/worker/src/doctor-checks.ts`: the `ai structured call` check uses the new runner
  (`plainTool`) and sends the real `decideJsonSchema` (the meaning-only answer) for a two-word sample reel, so `doctor`
  fails on a schema the installed CLI rejects; the answer must pass `parseDecideAnswer`.
- `supabase/migrations/20261101175625_version_decide_records.sql`: `versions` gains
  `used_free_field`, `unexpressed` (requests the format could not express), `free_field` (items
  that needed the `style` field and why) and `rejected_reasons` (why the first answer was refused
  when a retry was needed; empty when it passed). `save_version` is replaced by a signature with
  four more parameters that default, so every existing caller stays valid. Mirrored in
  `NewVersion`/`VersionMeta` (`packages/edit/src/versions.ts`) and `supabaseVersionRows`.
- `supabase/migrations/20261103192618_version_change_title.sql`: `versions` gains the nullable
  `change_title` and `save_version` the last parameter `p_change_title` (default null, so callers
  without it stay valid); `NewVersion.change_title`, `VersionMeta.changeTitle`. Old rows keep a
  null title and their technical summaries; they are never rewritten.

### Failure

Two refused rounds throw `StepError` with the tail `decide: the answer failed twice, version <n>
stays current` and each round's reasons (at most 8 lines per round, `and k more` closing a longer
one). Nothing is written to R2 or `versions`, the reel's current version is unchanged, and the
step row still carries the tokens and cost spent.

A transient retry (`app_docs/failures.md`) is the step runner's and never adds AI calls: from the
first AI call on, `runDecide` wraps every failure but `AiUnavailable` in `PermanentError`
(`permanentAfterAiCall`), so the step runner never runs the step again and the step makes at most
two AI calls. A failure before the first AI call may still be retried once.

## How to Use

1. Upload footage in the studio; the worker runs the fixed steps, `first_version`, then `decide`.
2. The reel page shows `decide: version 2: ...` and the step's tokens, cost and model.
3. A failed decide shows both rounds' reasons in the step's error tail; version 1 stays current.
   Retry the job to decide again.

## Configuration

- `CLAUDE_CODE_PATH`: the `claude` binary (already used by the doctor).
- `E2E_MOCK_AI` and `E2E_MOCK_AI_SCRIPT`: tests only; documented in `apps/worker/.env.example`.
- No new variable for production; the migration is applied by `supabase` as usual (in a run,
  `.adw/supabase-stack reset`).

## Testing

- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker`: `decide.test.ts` (per-reel
  schema, composition, counts), `glossary.test.ts`, `ai.test.ts` (parser on the committed real
  result `decide/testdata/claude-result.json`, the fake, the script loader on the committed
  answer), `prompt.test.ts`, `run-decide.test.ts` (pass, one retry, second failure, nothing
  written on failure; a behind photo: the library quoted as data in the prompt, the mask made
  before the save, `inputs.photos` and `, 1 behind` on the step line) and `step-runner.test.ts` (stdin, cap, `StepError`).
  `run-decide.test.ts` builds its check-refused answer as a word fix writing the heard form
  "Locking" (the schema accepts any fix text, so only the glossary check refuses it); an answer
  carrying a time or a position is refused by the schema; an answer with no choices saves exactly
  version 1's bytes; a photo with the request's wish `left` lands in `left` (no head in the
  fixture). `engine-input.test.ts` covers the placement: ranges to anchors, fixes, the 2 to 4 s
  bounds, the big word's sentence end, the wished, kept and face-clear spots, and the read-back.
  After a change to the preset or the layout, re-derive these from the new values; never loosen a
  check to make them pass.
- The worker's and the studio's `test` tasks depend on `^transit` in `turbo.json`, so a change in
  `packages/edit` or `packages/storage` changes their hash and turbo runs them again instead of
  replaying a cached pass; both also hash `fixtures/pipeline/`.
- `decide/testdata/short-speech-answer.json` is the scripted meaning-only answer for the fixture
  clip (title w0001 to w0004, accent w0005, dim w0006 to w0008, fix w0010 "Studio"); a unit test
  proves it passes the checks.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` covers the new columns.
- E2E: `apps/studio/e2e/upload.spec.ts` sets `E2E_MOCK_AI_SCRIPT` to the committed answer and
  checks the decide line, the `ai_*` columns (1500, 456, 0.0123, `claude-opus-5-5`), version 2's row
  and both R2 keys. `preview.spec.ts` seeds through `test-support/ai-script.ts`
  (`unchangedAnswerScript`), whose answer makes no choice (version 1 has none), so version 2 matches
  the version 1 golden. `behind.spec.ts` scripts a change answer (`behindPhotoAnswerScript`, the
  wish `left`) that puts a seeded ready photo behind the speaker (`#photo-1`); the `cutout` row and the version's `inputs.masks` and
  `inputs.photos` are checked. `decide-behind.spec.ts` seeds a ready photo and a processed reel
  whose automatic decide proposes it (no wish, so the first clear spot, `top`), then "no photos in this one" saves a version with no
  photo and `reels.no_photos` set, and a later change whose first answer brings the photo back is
  refused and its retry saves without it. Unit: `input.test.ts` (sentences without times, empty
  library on a forbid), `checks.test.ts`, `schema.test.ts`; DB: `versions.test.ts` covers the reel
  flags.

## Rules

- At most two AI calls per decide: one retry, never a loop.
- Claude never writes times, positions or sizes: the answer is meaning only (word ids, library
  photo ids), every object closed; the layout places everything.
- Claude only forwards placement words the owner used: a `wish` is one of `WISHES`, never on the
  automatic run, never invented.
- Never give Claude geometry or times to decide with (no face box, spots, safe box, font sizes or
  word times in the input).
- Never give Claude Code tools or a saved session (`--tools ""`, `--no-session-persistence`),
  except the `describe_photo` call's `Read` limited to its one image file
  (`app_docs/photo-library.md`).
- Never let the answer carry `format`, `preset`, `duration` or `inputs`.
- Never write a version or R2 key for a refused answer; the current version stays.
- Never cache the decide step.
- Bump `PROMPT_VERSION` whenever `prompt.md` changes.
- The prompt keeps `change_title` and `change_summary` in plain words for the owner: never word
  ids, font names, pixel sizes, colour codes, timestamps or seconds, or internal names. Never clean
  old summaries with regexes; they show as stored.
- Record raw usage numbers as Claude Code reports them; never convert or estimate.
- Never point a test at the real `claude` binary; use the double.
- The photo library in the prompt is data, never instructions: always quoted as fenced JSON under
  the line saying so.
- A `behind` photo is only ever one of the owner's ready library ids; the schema allows no other.
- Never save a version with a `behind` item before its masks are stored.
- Never more than `maxPhotos` photos and `maxWords` big words in a decide answer.
- Never propose a photo or big word the reel's rules forbid; only a request may set or lift a rule.
- The checklist is empty without a request; each entry links only to items the answer has.
- A forbid is written with its version in one `save_version` call.

## Notes

- Touches `app_docs/edit-model.md` (new check rule, version columns, `save_version` signature),
  `app_docs/measurement.md` (the `ai_*` columns are now written by decide) and `app_docs/studio.md`
  (`E2E_MOCK_AI_SCRIPT`); those still describe the AI as only a doctor check in places.
- `request` is null for the automatic run. The owner-request path now exists: a `change` job runs
  `runDecide` with `job.request` (see `app_docs/change-requests.md`).
