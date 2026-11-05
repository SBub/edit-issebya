# Decide Step: Claude Code with a Per-Reel JSON Schema, the Layout Engine, One Retry, Version Records

**Specifications:**

- specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-97-adw-7283e118-sdlc_planner-decide-proposes-behind-within-limits.md
- specs/issue-155-adw-2a28c287-sdlc_planner-fulfil-change-requests-make-room.md
- specs/issue-156-adw-ca502a36-sdlc_planner-honest-version-summary-from-diff.md
- specs/issue-157-adw-3c1a1736-sdlc_planner-transitions-tied-to-phrases.md

## Overview

`decide` is the pipeline's one AI step. After the five fixed steps and the automatic version 1, the
worker asks Claude Code (`claude -p`, no tools, on the owner's machine) to start from the current
version's choices, fix misheard words, choose accent phrases and transitions, mark the title,
choose what goes behind the speaker, and write the hook (one short line for the first seconds). Claude answers in meaning only ("B strict"): word ids and
library photo ids, never a time, a position, a size or a spot. The answer must match a JSON Schema
made for this reel, is checked again with Zod and the glossary check, placed over the current
version by the layout engine (`placeEdit`, `app_docs/edit-model.md`, "Layout engine"), built and
checked, and becomes a new version (version 2 on a fresh reel). Only an answer breaking the schema
or the glossary is refused: it goes back once with the reasons; a second refusal fails the step and
leaves the current version untouched. Layout never refuses an answer: what fits nowhere is dropped
and written to the engine record saved with the version. After a placed answer, an editorial round
gives the editor a second meaning choice for what the engine left out, and the request checklist's
outcome is stored with the version.

## How it works

The answer (`decide-14`) is the layout engine's input plus the request checklist and the records:

```json
{
  "accents": [{ "from": "w0001", "to": "w0004", "title": true }],
  "big_words": [{ "word": "w0008" }],
  "photos": [
    {
      "photo_id": "<library id>",
      "from": "w0020",
      "to": "w0027",
      "reason": "match",
      "wish": "left"
    }
  ],
  "transitions": [{ "kind": "dim", "from": "w0006", "to": "w0008", "key_from": "w0007" }],
  "word_fixes": [{ "word": "w0010", "text": "Studio" }],
  "hook": { "text": "Gen Z won't work like you did" },
  "checklist": [
    {
      "ask": "a photo behind me on the left",
      "wants": "one photo, on the left",
      "fulfilled_by": ["photos[0]"]
    }
  ],
  "behind_rules": { "photos": "keep", "big_word": "keep" },
  "unexpressed": []
}
```

- Everything refers to the transcript by word ids (a range is `from` and `to`, in transcript
  order). The answer is the full list of choices for the new version: what it leaves out is removed.
  No item has a time, an anchor, a position, a size, a font, a colour, a spot or a free `style`;
  every answer object is closed (`z.strictObject`, `additionalProperties: false`), so an answer
  carrying one is refused as the schema's.
- `wish`: an optional placement word on any item, only from `WISHES` (`top`, `bottom`, `left`,
  `right`, `behind`, `front`, `beside_head`, `big`, `small`, `slow`, `long`), set only when the
  owner's request said so. Without a request any wish is refused. The layout engine honours a wish
  when it can (a photo's spot, layer or size; an accent's area or size; on a transition `slow`
  means a slower motion and `long` a longer hold) and records `wish-not-kept` when it cannot.
  `front` (`decide-14`, owner decision 2026-11-04): "put the photo in front" puts the photo in
  front of the speaker, still never over the face; "behind me" is `behind`, still only where it
  stays 70% in view. Without either the engine chooses the layer (`app_docs/edit-model.md`,
  Layout engine).
- `checklist`: with a request, one entry per ask (`ask`, `wants`, `fulfilled_by`, the answer items
  that do it: `accents[i]`, `big_words[i]`, `photos[i]`, `transitions[i]`, `word_fixes[i]`, `hook`
  (its new text, or none when the owner asked it out; always done, the hook is never left out) or
  `behind_rules`). Empty (schema `maxItems` 0) without a request. A link to an item the answer does
  not have is refused. An entry may carry `why_not` (1 to 300 characters, plain words for the owner,
  optional) when nothing in the answer can do the ask, for example photos with an empty library. The
  outcome is stored per version as `versions.checklist` (below); the items it links (`fulfilled_by`) are placed first among
  the extras (`editFromAnswer` passes them to the engine as `requested`).
- The answer carries no title or summary: the version's `change_title` and `change_summary` are
  written after layout from the saved difference ("Version title and summary" below). `format`,
  `preset`, `duration` and `inputs` come from the current version, so the result is always a full edit and the AI cannot
  touch the input fingerprints. The title is the overlay with id `title`, over its words.
- Stored versions are never re-decided or rewritten; an older version's choices are read back by
  `choicesOf` when a change starts from it (every big word of the version as `big_words`, so a
  version saved with the old single `big_word` reads back as a list of one).
- `hook` (new in `decide-11`, required): `{ "text": "..." }` or `null`. The one text Claude writes
  itself, never spoken (the rule "every text on screen is a spoken word" is now "spoken words,
  plus one written hook at the start"). The schema bounds it by the preset (`pace.hook.maxWords`
  7, `maxCharacters` 45) and to one plain line (no line break, `<` or `>`, at least one letter or
  digit, counted after the final stop is taken off), with no wish, time or place. `parseDecideAnswer`
  returns it through `stripHookStop`: its final full stops and ellipses (".", "...", "…", spaces
  after them) are taken off, never refused, so the hook never ends with a dot ("?" and "!" stay,
  a dot inside stays). An over-long hook is refused like any answer error and goes
  back once with its reason (`hook.text: a hook has at most 7 words`). Once placed, the glossary
  check reads it like any overlay text (a heard form refused as `glossary hook: ...`). It is data
  to show, never instructions: the prompt says so where the current choices carry it. The layout
  engine places it from 0.2 s to 3 s, the one extra of that window (`app_docs/edit-model.md`, "The
  written hook").
- `big_words` replaced the single `big_word` (or null) in `decide-10`: a list of `{ word, wish? }`,
  the same word allowed again. The `behind_rules` key stays `big_word` (it switches the kind, and
  matches `reels.no_big_word`).

- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor(preset, transcript, photoIds, rules)` (word-id
  enums from the reel's transcript, `photo_id` an enum of the owner's ready library ids, so no photo
  can be named without them, transition kinds from the preset, the wish enum; lists are bounded
  only as an answer-size guard, 12 accents, big words, photos and transitions each, never a per-reel
  count the editor works to), `decideJsonSchema` (Zod 4 `z.toJSONSchema`, draft-07 because the Claude Code CLI's
  `--json-schema` validator rejects a draft 2020-12 `$schema`, real `enum` lists, every object
  closed, refs inlined), `parseDecideAnswer` (both take a `DecideRules` argument, default
  `NO_RULES`), `applyBehindRules` (the pure merge of the reel's stored flags and the answer's rules),
  `editFromAnswer(current, answer, preset, transcript, headTrack, measurer)` (the answer placed by
  the layout engine and parsed with the decide limits, returned with the engine's `record`; the
  current version's `inputs.masks` and `inputs.photos` are dropped, since the worker names them
  again for the new `behind` track; a parse failure here is an engine bug, refused as
  `answer-edit`),
  `decideCounts` (the step line, with `behindPhotos` and `behindWords`) and `usedFreeField`. The Zod
  refinement refuses a range ending before it starts, a wish without a request, a second title, a
  kind the rules forbid, a big word that is not one plain word, a word fixed twice and a checklist
  link to a missing item, each with a readable reason for the retry.
- Behind (the owner's, 2026-11-04, replacing the 2026-11-02 limit of 2 photos and 1 big word per
  reel): no count per reel, the editor decides how many photos and big words, and a big word may
  come back. A photo shows 1 to 2 s (`behind.minSeconds`, `maxSeconds`), a big word the accent's
  timing (from `accent.leadSeconds`, 0.2 s, before its word to a second after it, at least 1.5 s;
  owner decision 2026-11-04, replacing its 2 s from its word). A photo sits over its sentence for
  one of two reasons, its required `reason` (owner decision 2026-11-04, `decide-13`, replacing "never
  a loose fit"): `match`, it shows what the sentence says (its description or tags), or `mood`, it
  fits the reel's feel and catches the eye without showing what is said, never contradicting or
  misleading (no product photo while another product is named, nothing that changes the meaning).
  No count for mood photos: the editor uses as many as it thinks fit, and each counts toward the
  `extra_every_seconds` rhythm like any extra. A request for photos ("add photos behind me") is
  always fulfilled: the editor picks the best library photos there are (a loose fit as `mood`) and
  links them in the checklist; only an empty library, or photos switched off and not lifted by the
  request, leaves the ask undone with a `why_not`. The engine places the linked photos first and
  makes room for them like any requested item. The reason is stored on the placed item
  (`tracks.behind[].reason`, optional, so older versions parse), read back by `choicesOf`, carried
  to the editorial round with a left-out photo (a photo swapped there fits the same way), given in
  the version diff (`DiffEntry.reason`, never a change on its own) and in the studio track tooltip
  (`photo top, mood photo`). A big word only on a key word, a spoken word by construction. The
  lengths come from the layout engine's timing (a photo from its sentence's start, leaving after at
  most 2 s; a big word like an accent); it shows one extra at a time, so the edit's refinement
  (two behind items at once) never fires on its output.
- Pace (`preset.pace`, one intensity level, Medium the only one so far): the prompt asks for a new
  extra (accent, big word, photo or transition) at least every `extra_every_seconds` (3) of reel on
  meaningful words, never filler, and keeps transitions at their own slower pace, about one per
  `transition_every_seconds` (9), since a transition covers the speaker. The rhythm is the editor's
  aim, not a check: the engine still shows one extra at a time and drops what has no room. A later
  Calm or Intense switch swaps the `pace` block whole.
- `behind_rules: { photos, big_word }`, each `keep`, `forbid` or `allow`: `keep` leaves the reel's
  stored flag, `forbid` sets it, `allow` lifts it. Without a request (the automatic run) the enums
  are only `["keep"]`. A Zod refinement refuses a photo (or big word) while the effective rule
  forbids it. The flags are `reels.no_photos` and `reels.no_big_word`, written only by
  `save_version` in the same transaction as the version (`p_no_photos`, `p_no_big_word`, null =
  unchanged; restore and the first version pass null). With photos forbidden and no request, the
  library sent is empty and the photo enum is `z.never()`.
- `packages/edit/src/schema.ts`: `editSchemaFor` takes optional
  `EditLimits { duration, bounds, photoIds, behindLengths }`; without them stored versions keep parsing with the default
  frame limits. `behindLengths` (the decide limit) refuses a photo outside the preset's 1 to 2 s
  and a big word under the accent's 1.5 s or longer than from the lead before its word to
  `afterSeconds` after it; a stored version saved under the older lengths (2 to 4 s, or a big
  word's 2 s from its word) parses and renders without it. `issueReasons` turns Zod issues into readable reasons.
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
  non-object value or non-JSON throws. Without a script it gives `EMPTY_DECIDE_ANSWER` (no items,
  `hook` null),
  which the doctor's check accepts.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`: the committed prompt and `PROMPT_VERSION`
  (`decide-14`, bumped with every prompt change; each version row records it; `decide-14` added
  the `front` wish and says the layout puts each photo behind or in front of the speaker and sizes
  it). The prompt makes
  Claude the editor: it decides what and on which words, the layout decides every position, size
  and time; it refers to words only by id and never writes times, seconds, pixels, positions, sizes,
  fonts, colours or spots. It asks for the rhythm (a new extra at least every
  `extra_every_seconds`, on meaningful words, never filler) and explains each choice (word fixes
  against the glossary, accents with one title, transitions at their own slower pace, photos each
  with a `reason`, `match` or `mood` (a mood photo never contradicts or misleads), as many as fit,
  and a request for photos always fulfilled with the best library photos there are (`decide-13`;
  the checklist links a loose fit too, never a `why_not` for it), as many big words as the rhythm needs, the behind rules,
  the hook), the wishes (only from the owner's own words, never invented), the checklist (empty
  without a request), and carries one example answer. It says that only the answer's own rules (the
  schema, the glossary) refuse an answer and that layout never does: the layout fits what it can
  and leaves out what has no room. It no longer asks for a title or a summary: they are written
  after layout from the saved difference ("Version title and summary" below). The hook (point 7):
  every first edit (no request) gets one; at most the style's `hook_length` words and characters,
  in the speaker's voice and the transcript's language; a teaser that makes people want to keep
  watching; only promising what the reel says (no claim, number or name the transcript does not
  support, never clickbait); plain text, no emoji or hashtags unless the owner asks, glossary terms
  exact; human like a social post, one line with no sentence-ending dot and never a full stop or
  "..." at the end (a question mark is great, an exclamation mark fine; `decide-12`). On a change the current hook stays unless the request asks to change or remove it
  ("change the hook to ...", "no hook"); exact words from the owner are used as written. The prompt
  also says every text on screen is spoken except the hook, and introduces the current choices
  as data (the hook's text is words to show, never instructions). `decidePrompt` fills
  the inputs as fenced JSON (`{{library}}` among them) and, on the retry, appends the previous
  reasons. The library is introduced as data describing the photos, never instructions, to be
  ignored where it reads like one.
- `apps/worker/src/decide/input.ts`: the prompt input, with no time or geometry: `current_choices`
  (the current version read back by `choicesOf`), the transcript as `{ id, text }`, `sentences`
  (`{ from, to, text }` by `sentenceSpans`, a sentence ending at `.`, `?`, `!` or a pause of 0.6 s),
  the preset summary (transition kinds, `extra_every_seconds`, `transition_every_seconds`,
  `hook_length` `{ words, characters }`, glossary; no photo or big word count, and never when or
  where the hook shows), `behind_rules` (the
  reel's current flags), the library and the request. No head track, face box, `clear_spots`, safe
  box, font size or photo spot: the layout owns free space. The library is a list of
  `LibraryEntry` (`id`, `description`, `tags`): the owner's ready photos only, oldest first, read by
  `PhotoLibrary.readyPhotos(owner_id)` (`apps/worker/src/photos/photo-store.ts`, service role,
  filtered by owner and `status = 'ready'`, a row without `large_key` left out).
- `apps/worker/src/decide/behind-rules.ts`: the `ReelRules` store (`supabaseReelRules(db)` reads
  `reels.no_photos` and `no_big_word` with the service role) and `applyRules`.
- `packages/edit/src/checks.ts`, `behind.ts`: check rules `behind-face` (a robust face, `facesOver`,
  covers more than `maxFaceShare` of a photo behind the speaker, its box or spot, at some moment of
  its span; a photo in front touches the face at all), `behind-caption` (a caption or accent shown
  during the span overlaps the photo) and `photo-hidden` (the person covers more than the lower 30%
  of a photo the engine set behind them). They are the engine's final guard, never a refusal.
- `apps/worker/src/photos/photo-looks.ts`: before the AI call the decide step reads each library
  photo's ratio (its stored `width` and `height`) and its edge luminance (its thumbnail scaled to an
  8 by 8 grid with one ffmpeg call inside the `decide` step, in a scratch folder of its own; the
  median of the border cells) as `PhotoLook`s for `editFromAnswer`. A photo without a size or a
  readable thumbnail just goes without that part; only a cancel stops it.
- `apps/worker/src/decide/run-decide.ts`: `runDecide`, a `runToolsStep` named `decide`. It reads
  the current version and its inputs, builds the schema, and makes at most two calls, never a
  loop. An attempt is refused only when the JSON does not parse, the schema refuses it,
  `editFromAnswer` cannot parse the placed edit or `glossaryChecks` reports a heard form. A placed
  attempt is then built for its layout checks (on the edit naming the masks it will need,
  `withMasks`, whose fingerprints are known before any is made); they never refuse it. A check
  failing on the engine's output is an engine bug: the worker logs
  `decide: engine bug, reel <id>: <rule> <item>: <reason>; ...` and still saves the version, with
  the checks stored on its row (`checks`). The one face covering the engine may make (captions it
  records `covers-face`, when nothing else is free, and a requested item it let cover the face or,
  for a photo, be hidden behind the person as its last make-room step: `behind-face` and
  `photo-hidden`) is not called a bug. With `behind` items, `ensureCutouts` (`apps/worker/src/cutout/ensure-cutouts.ts`) then
  refuses a photo outside the library and makes sure each padded span's mask is stored (a
  `cutout` step row, `app_docs/pipeline.md`) before anything is saved; a failure there comes after
  the AI call, so it is permanent, and no version is saved. It saves through
  the save in this order: the cutouts, the behind rules the answer sets or lifts (`ruleChanges`),
  the unchanged check (a request whose edit is the current one byte for byte and switches no rule
  saves nothing, "Failure" below), the difference (`diffEdits`), the summary
  (`writeVersionSummary`), then `saveVersion` with `parentId` the current version, the request
  (null for the automatic run), model, `PROMPT_VERSION`, `changeTitle` and `changeSummary` from the
  summary, the forbid flags (only where the answer's rule is not
  `keep`), the records below (`free_field` is always empty now: the answer has no free style;
  `used_free_field` still reports a kept item's style) and the engine record (`engine_record`).
  After the save the worker logs the record in one line
  (`apps/worker/src/engine-record.ts`, `engineRecordLine`):
  `engine record, reel <id>, version <n>: <item> <action> (<rule>): <reason>; ...`, or
  `nothing moved`. Step line: `version 2: 1 accent, 1 transition, title set, 1 word fixed`
  (`, hook set` after the title when the version has the hook), with
  `, <n> behind` after it when the version has behind items and `, <n> dropped` when the engine
  dropped items.
- `apps/worker/src/process-job.ts`: runs `runDecide` after `saveFirstVersion`. Never cached: a
  retried job decides again from the then-current version.
- `apps/worker/src/step-runner.ts`: `ToolCall` gains `stdin` and `maxStdoutBytes`; `ToolsStep.work`
  may return `ai` usage; `StepError(message, tail, ai)` fails a step with its own tail (the
  reasons) and the AI usage spent. `apps/worker/src/step-store.ts` writes the `ai_*` columns
  (`aiMeasurements`).
- `apps/worker/src/doctor-checks.ts`: the `ai structured call` check uses the new runner
  (`plainTool`) and sends the real `decideJsonSchema` (the meaning-only answer) for a two-word sample reel, so `doctor`
  fails on a schema the installed CLI rejects; the answer must pass `parseDecideAnswer`. The
  `ai summary call` check sends `summaryPrompt` for a sample difference on `SUMMARY_MODEL` with
  `summaryJsonSchema`, so a model id the installed CLI rejects shows before a real run; the answer
  must pass `parseSummaryAnswer`.
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
- `supabase/migrations/20261103230327_version_engine_record.sql`: `versions` gains
  `engine_record` (a jsonb array, default empty) and `save_version` the last parameter
  `p_engine_record` (default empty); `NewVersion.engine_record`, `VersionMeta.engineRecord`. Old
  rows keep an empty record.

- `packages/edit/src/editorial.ts`, `apps/worker/src/decide/editorial.ts`, `editorial.md`: the
  editorial round. `placeEdit` also returns `unplaced` (the answer's extras it dropped, each with its
  answer ref, kind, words, a reason code in editor terms and whether the owner asked for it) and
  `free` (the sentences, by word ids, with room for an accent, a photo or a big word, found by
  non-committing probes). `runEditorialRounds` runs after a placed attempt: one round on the
  automatic run (only when a left-out item has a free sentence of its kind, so no call is paid for
  nothing), up to `EDITORIAL_ROUNDS.request` (3) on a request while an item the owner asked for is
  left out. Each round sends the items and the sentences with room (the words they were on, why in
  words, no time, size or spot) and the library when a photo is left out; Claude answers per item
  either new words (`from`, `to`, and for a photo optionally another library `photo_id`) or a skip
  with a plain `why` for the owner. `editorialJsonSchema` and `parseEditorialAnswer` are built per
  round (word-id and photo-id enums); `mergeEditorial` applies the choices to the answer (a skip
  removes the item and re-indexes the checklist links) and the whole merged answer is checked by
  `parseDecideAnswer` and placed again. A broken, refused or unusable editorial answer only ends the
  rounds (never a retry, never a failed step) and the version saves with what is placed. The AI
  being unavailable ends them too, except on a request while a requested item is left out: then the
  job waits (`AiUnavailable`). The rounds' notes (rule `editorial`) join the engine record and the
  step line gains `, <n> editorial rounds`.
- `versions.checklist`: `checklistOutcome(checklist, placement)` turns the final checklist into
  `{ ask, wants, fulfilled_by, done, reason }` entries. An ask is done when every item it links is in
  the version (word fixes, transitions and `behind_rules` always are). Otherwise `reason` is each
  left-out item's drop from the engine record plus what the owner can do; with no link, the answer's
  `why_not` or a plain default. Empty without a request, for the first version, a going back and
  every older version.
- `supabase/migrations/20261104013645_version_checklist.sql`: `versions.checklist` (jsonb array,
  default empty) and `save_version`'s last parameter `p_checklist` (default empty);
  `NewVersion.checklist`, `VersionMeta.checklist`.

### Version title and summary

The title and summary the owner reads in the versions list (`app_docs/change-requests.md`) are
written after layout, from what the saved edit changes, never from what the editor meant to do.

- `packages/edit/src/version-diff.ts`: `diffEdits(current, edit, transcript, preset)` lists the
  items added, removed, moved, retimed or changed between the current version and the new edit, per
  kind (`title`, `hook`, `accent`, `photo`, `big_word`, `transition`, `caption`, `sound`, `footage`), each
  with the plain words it is over or its own text (never a word id) and, for a behind photo, its
  spot before and after. Many captions shifted fold into one `captions` moved entry; renumbered ids
  on the same words are not a change. `ruleChanges(before, after)` gives the behind rules switched
  (`photos` or `big_word`, `off` or `on`). Pure and deterministic.
- `apps/worker/src/decide/version-summary.ts`: `writeVersionSummary` makes one call on
  `SUMMARY_MODEL` (`claude-haiku-5-5`, passed as `--model`) with the committed `summary.md`, given
  the request, the checklist outcome, the difference, the rules switched, the description of each
  library photo the difference names (so a `mood` photo is named honestly as a loose fit: "Added
  your photo of chairs on 'a sense of purpose': none of your photos match the topic closely") and the engine record
  (items, actions and reasons, without the `low-contrast` notes and an older record's `shadowed`
  ones: a text left in place is no change the viewer sees), all quoted as fenced JSON
  (`summaryPrompt`).
- `packages/edit/src/version-summary.ts`: the answer schema (`change_title` 1 to 60 characters,
  `change_summary` 1 to 300, closed), the safeguard `checkSummary` and the template
  `summaryTemplate`. The safeguard refuses a word id, a time, a size, a colour code, a font name or
  an internal name (track, slot, preset, overlay, spot), and any kind of item the title or summary
  names that is not in the difference (photos and big words also count when their rule
  switched); a summary sentence may name a kind the owner asked for and the version left out
  (`askedNotDone`) only to say it did not happen. The template writes the title and summary from
  the difference (`No changes` for an empty one, `Photos switched off` for a forbid-only change) and,
  for an item the owner asked for that the engine dropped, why in plain words; its own output
  always passes the safeguard.
- An empty difference makes no call. A refused, invalid or failed call (broken JSON, a schema
  refusal, the safeguard, the AI unavailable, a thrown error) falls back to the template with the
  log line `decide: summary from the template, reel <id>: <why> (summary-7)`; it is never retried,
  never fails the step and never makes the job wait (only a cancel is rethrown).
- The call's tokens and cost are added to the step's usage, but not its model: `steps.ai_model` and
  `versions.model` stay the editor's. `SUMMARY_PROMPT_VERSION` (`summary-7`: a photo with `front: true` in the
  difference is "in front of you", never "behind you"; `summary-6` said how to name a `mood` photo,
  from the photo descriptions it is given; `summary-5` added the hook) is logged with the
  template line, never stored.

### Failure

A request whose new edit is the current version byte for byte and whose behind rules do not change
throws `StepError` with the cause `NothingChanged` (an `AnswerRefused`, `apps/worker/src/failure.ts`;
its rules are `no-change` then the distinct rules of the record's drops and wishes not kept, sorted,
at most 20 in all, `nothingChangedRules`) and the tail `decide: nothing would change, version <n>
stays current` plus the asks not done with their reasons. Nothing is written to R2 or `versions`.
The automatic run (no request) is not a change and still saves.

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
  schema, composition, counts; any number of photos and big words, the same word again, no
  per-reel `maxItems` beyond the size guard; the hook field, its final stop taken off; each photo's
  `reason` required, only `match` or `mood`, and kept on the placed item), `glossary.test.ts`, `ai.test.ts` (parser on the committed real
  result `decide/testdata/claude-result.json`, the fake, the script loader on the committed
  answer), `prompt.test.ts` (the pace filled in, the rhythm and the transitions' slower pace asked,
  no `max_photos` or "at most one word", the hook's rules and `hook_length`, the photo reasons and
  the request for photos fulfilled), `input.test.ts` (the pace in the preset summary, no behind
  count), `run-decide.test.ts` (pass, one retry, an over-long hook and a hook with a heard form
  each sent back once, second failure, nothing
  written on failure; a behind photo: the library quoted as data in the prompt, the mask made
  before the save, `inputs.photos` and `, 1 behind` on the step line; three photos on the 2.7 s clip
  save with one placed and the rest recorded `one-extra`, no refusal; "add photos behind me" with a
  `mood` photo: the ask done, the photo stored with its reason, the summary call given the reason
  and the photo's description) and `step-runner.test.ts` (stdin, cap, `StepError`).
  `run-decide.test.ts` builds its check-refused answer as a word fix writing the heard form
  "Locking" (the schema accepts any fix text, so only the glossary check refuses it); an answer
  carrying a time or a position is refused by the schema; an answer with no choices saves exactly
  version 1's bytes (the engine placing its own output again); a photo with the request's wish
  `left` lands in `left` (no head in the fixture); a title wider than the frame saves in one round,
  wrapped, with the record saved and logged in one line (no layout refusal). On the 2.7 s clip the
  committed answer's title holds the screen, so its accent is dropped (`1 dropped`); the behind
  scripts clear the accents. `engine.test.ts` covers the placement (`app_docs/edit-model.md`);
  `engine-input.test.ts` the read-back.
  After a change to the preset or the layout, re-derive these from the new values; never loosen a
  check to make them pass.
- The worker's and the studio's `test` tasks depend on `^transit` in `turbo.json`, so a change in
  `packages/edit` or `packages/storage` changes their hash and turbo runs them again instead of
  replaying a cached pass; both also hash `fixtures/pipeline/`.
- `decide/testdata/short-speech-answer.json` is the scripted meaning-only answer for the fixture
  clip (title w0001 to w0004, accent w0005, dim w0006 to w0008, fix w0010 "Studio", the hook "A
  short test for the real studio"); a unit test proves it saves in one round with no failed check.
  On the 2.7 s clip the hook holds the screen from 0.2 s to the end, so the engine drops the dim
  (rule `hook`), the title and the accent (`one-extra`): the step line reads
  `0 accents, 0 transitions, no title, hook set, 1 word fixed, 3 dropped`. The studio's round scripts
  (`answerRoundsScript`, behind photos and words) leave the hook out unless a round gives one,
  so the behind items still have the screen.
- `version-diff.test.ts` (`diffEdits`, `ruleChanges`) and `version-summary.test.ts` in
  `packages/edit` (schema, safeguard, template) and in the worker (`summaryPrompt`, one call on the
  small model, the template for a broken, unavailable, refused or decide-shaped answer, no call for
  an empty difference). `run-decide.test.ts` covers the template when the summary names a photo the
  saved edit does not have and when the call fails, nothing saved for a request whose edit is the
  current one byte for byte, and a request that only switches photos off titled from the rule. In
  E2E the scripted answer is a decide answer, so the summary call falls back to the template.
- `editorial.test.ts` in `packages/edit` (schema, merge, checklist outcome) and in the worker (input,
  rounds, caps, failure handling); `run-decide.test.ts` covers the rounds in a decide.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` covers the new columns,
  `checklist` included.
- E2E: `apps/studio/e2e/upload.spec.ts` sets `E2E_MOCK_AI_SCRIPT` to the committed answer and
  checks the decide line, the `ai_*` columns (1500, 456, 0.0123, `claude-opus-5-5`), version 2's row
  and both R2 keys (`decide-14`,
  `0 accents, 0 transitions, no title, hook set, 1 word fixed, 3 dropped`, titled
  `Hook and captions changed`).
  `preview.spec.ts` seeds through `test-support/ai-script.ts`
  (`unchangedAnswerScript`), whose answer makes no choice (version 1 has none), so version 2 matches
  the version 1 golden. `behind.spec.ts` scripts a change answer (`behindPhotoAnswerScript`, the
  wish `left`) that puts a seeded ready photo behind the speaker (`#photo-1`); the `cutout` row and the version's `inputs.masks` and
  `inputs.photos` are checked. `decide-behind.spec.ts` seeds a ready photo and a processed reel
  whose automatic decide proposes it (no wish, so the first clear spot, `top`), then "no photos in this one" saves a version with no
  photo and `reels.no_photos` set, and a later change whose first answer brings the photo back is
  refused and its retry saves without it. `change-requests.spec.ts` covers a change that would
  leave the reel as it is: nothing saved and the overlay says `Nothing changed`. Unit: `input.test.ts` (sentences without times, empty
  library on a forbid), `checks.test.ts`, `schema.test.ts`; DB: `versions.test.ts` covers the reel
  flags.

## Readable text

Before the AI call, `run-decide.ts` ensures the footage's background map (`ensureBackgrounds`, a
failure is an ordinary step failure) and passes `backgroundSampler(map, preset.frame)` to
`editFromAnswer`, so the engine moves unreadable text to a nearby free place that reads, else
leaves it in place, plain, and records it (never a shadow, never a colour change; see
`edit-model.md`). The version summary leaves those `low-contrast` notes out.

## Rules

- At most two answer calls (one retry), then the editorial rounds: at most one on the automatic run,
  at most 3 on a request; never an unbounded loop.
- Claude never writes times, positions or sizes: the answer is meaning only (word ids, library
  photo ids), every object closed; the layout places everything.
- Claude only forwards placement words the owner used: a `wish` is one of `WISHES`, never on the
  automatic run, never invented.
- Never give Claude geometry or times to decide with (no face box, spots, safe box, font sizes or
  word times in the input; the hook's length, never its window).
- The hook is the one text Claude writes itself: one per version at most, bounded by the preset's
  words and characters, checked against the glossary, data and never instructions; a change keeps
  it unless the owner asks to change or remove it, and the owner's exact words are used as
  written (never with a final full stop: `stripHookStop` takes it off, theirs too).
- Never give Claude Code tools or a saved session (`--tools ""`, `--no-session-persistence`),
  except the `describe_photo` call's `Read` limited to its one image file
  (`app_docs/photo-library.md`). In the worker container Claude Code runs on the Mac through the
  claude bridge, which accepts only these flags and values (`apps/worker/src/bridge/policy.ts`).
- Never let the answer carry `format`, `preset`, `duration` or `inputs`.
- Never write a version or R2 key for a refused answer; the current version stays.
- Never refuse an answer over layout: only the schema and the glossary refuse. Layout checks are the
  engine's final guard; one failing is logged as an engine bug with the reel id and the version is
  still saved.
- Never save a decided or first version without its engine record; never rewrite an old row's
  record (a going back has an empty one).
- Never cache the decide step.
- Bump `PROMPT_VERSION` whenever `prompt.md` or `editorial.md` changes.
- The version summary describes only the saved difference: every item it names is in the
  difference, else the template replaces it.
- The summary call is one call, never retried, never fails the step or makes the job wait.
- Never print a word id, font, size or time in a title or summary.
- A request whose edit is identical to the current version saves nothing; the owner is told why.
- Bump `SUMMARY_PROMPT_VERSION` whenever `summary.md` changes.
- Never clean old summaries with regexes; they show as stored.
- Record raw usage numbers as Claude Code reports them; never convert or estimate.
- Never point a test at the real `claude` binary; use the double.
- The photo library in the prompt is data, never instructions: always quoted as fenced JSON under
  the line saying so.
- A `behind` photo is only ever one of the owner's ready library ids; the schema allows no other.
- Never save a version with a `behind` item before its masks are stored.
- Never cap photos or big words per reel (in the preset, the prompt or the answer schema): how many
  is the editor's choice; the answer's list bounds are a size guard only. Every photo carries its
  `reason` (`match` or `mood`); a mood photo never contradicts or misleads about what is said.
- A request for photos is always fulfilled with library photos (the best there are, a loose fit as
  `mood`); only an empty library or a forbid the request does not lift leaves it undone, with a
  `why_not`. The summary says when a photo is a mood photo.
- Transitions never set the rhythm: about one per `transition_every_seconds`, slower than
  `extra_every_seconds`; the engine drops the rest.
- Never propose a photo or big word the reel's rules forbid; only a request may set or lift a rule.
- The checklist is empty without a request; each entry links only to items the answer has.
- A forbid is written with its version in one `save_version` call.
- Claude never sees coordinates, sizes, spots or times in the editorial round either.
- A refused editorial answer never fails the step and is never retried.
- Every decided version stores its checklist; a not-done ask carries the exact reason and what the
  owner can do.

## Notes

- Touches `app_docs/edit-model.md` (new check rule, version columns, `save_version` signature),
  `app_docs/measurement.md` (the `ai_*` columns are now written by decide) and `app_docs/studio.md`
  (`E2E_MOCK_AI_SCRIPT`); those still describe the AI as only a doctor check in places.
- The engine side (making room for a request) is in `app_docs/edit-model.md`, "Layout engine".
- `request` is null for the automatic run. The owner-request path now exists: a `change` job runs
  `runDecide` with `job.request` (see `app_docs/change-requests.md`).
