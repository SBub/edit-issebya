# Decide Step: Claude Haiku 5.5 through OpenRouter with a Per-Reel JSON Schema, the Layout Engine, One Retry, Version Records

**Specifications:**

- specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-97-adw-7283e118-sdlc_planner-decide-proposes-behind-within-limits.md
- specs/issue-155-adw-2a28c287-sdlc_planner-fulfil-change-requests-make-room.md
- specs/issue-156-adw-ca502a36-sdlc_planner-honest-version-summary-from-diff.md
- specs/issue-157-adw-3c1a1736-sdlc_planner-transitions-tied-to-phrases.md

## Overview

`decide` is the pipeline's AI step. After the five fixed steps and the automatic version 1, the worker
asks the model (Claude Haiku 5.5 through OpenRouter, the Vercel AI SDK, no tools; see "The AI runner"
below) twice, in order. First the written hook (HOOK), its own call (role `hook`, prompt `reel-hook`, see
"Prompts"). Then the components: the accent
phrases (ACCENT), the big words behind the speaker (BIGWORD), the VISUALS (empty frames, each with a short
description of what it would show), the questions the speaker puts to the viewer (QUESTION), the numbered
list items (LIST), and the misheard words to fix,
with the hook text given to them as data (role `decide`). Claude answers in meaning only: word ids and
short descriptions, never a time, a position, a size or a spot. The decide step reads no
photo library (for now): a visual is a frame, not a photo choice. Each answer must match its JSON Schema made for this reel (the hook's
schema is one text), is checked again with Zod and the glossary check, and the components are placed
over the version by the layout engine together with the hook (`placeEdit`, `app_docs/edit-model.md`,
"Layout engine"), built and checked, and becomes a new version (version 2 on a fresh reel). Only an
answer breaking the schema or the glossary is refused: it goes back once with the reasons; a second
refusal of the hook or of the components fails the step and leaves the current version untouched.
Layout never refuses an answer: nothing is dropped but by the same-text rule (a text pick whose every word another text pick on screen with it shows, a big word keeping the shared words over an accent, a question or a list; its trim or drop is noted), a pick with no free place takes its default spot, its overlap noted, and a text never overlaps another text while a free spot exists. Every note is written to the engine record saved with the version. Nothing asks Claude again about what the engine left out: the decide step makes no
call after the components' answer is placed. Every AI call a decided version made (the hook attempts,
the decide attempts) is stored beside it with its prompt, schema and raw answer
(the version's AI record), so a version can be replayed and diagnosed.

There is no owner request any more: the change box is removed (`app_docs/change-requests.md`). The
automatic run after version 1, and Start over (which decides again from version 1), are the only
runs, and both take the same path.

## The components

The model names each component by its answer list (prompt `reel-components`):

| Component | Answer field | What it is                                                                                                           |
| --------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| ACCENT    | `accents`    | a phrase worth stressing, `{ "from", "to" }`                                                                         |
| QUESTION  | `questions`  | a question the speaker puts to the viewer, often rhetorical, `{ "from", "to" }`; shown with the ACCENT look for now  |
| BIGWORD   | `big_words`  | one or two consecutive plain words shown large behind the speaker, `{ "from", "to" }`                                |
| VISUAL    | `visuals`    | an empty frame over its words, `{ "from", "to", "description" }` (8 words at most)                                   |
| LIST      | `lists`      | the numbered lists: each `{ "items": [...] }` (one or more), an item over its phrase, `{ "from", "to", "key_from" }` |

`word_fixes` (`{ "word", "text" }`) is not a component: it fixes a misheard word on its caption.
HOOK is not one either: it is the hook call's answer (`{ "text" }`, below), never in the components'
answer and never written by the components.

The components' prompt is told a target count (`{{target_picks}}`, the speech's length over the preset's
seconds per pick at the reel's level, `preset.picksEverySeconds`), a guide and no cap: the schema does
not count picks. Claude picks what the script's moments deserve, and the code decides how many show and when (the engine shows every pick, the text picks one at a
time, at their own words' times where that allows, every change noted). The model is told the reel's intensity (`{{intensity}}`)
and the target count (`{{target_picks}}`), see "Prompts". The overlap limits between components
are held by the prompt (see "Prompts"); the schema does not count them.

## How it works

The components' answer is the layout engine's input for the new vocabulary, with the
hook the hook call wrote beside it (`hook`, `{ "text" }`, given to the engine as the one text it is
placed first):

```json
{
  "accents": [{ "from": "w0001", "to": "w0004" }],
  "questions": [{ "from": "w0006", "to": "w0009" }],
  "big_words": [{ "from": "w0008", "to": "w0008" }],
  "visuals": [{ "from": "w0020", "to": "w0027", "description": "a messy desk at night" }],
  "lists": [{ "items": [{ "from": "w0010", "to": "w0011", "key_from": "w0011" }] }],
  "word_fixes": [{ "word": "w0010", "text": "Studio" }]
}
```

- Everything refers to the transcript by word ids (a range is `from` and `to`, in transcript order).
  The answer is the full list of choices for the new version: what it leaves out is removed. No item
  has a time, an anchor, a position, a size, a font, a colour, a spot, a `style`, a `wish`, a title
  or a checklist; every answer object is closed (`z.strictObject`, `additionalProperties: false`), so
  an answer carrying any of them is refused as the schema's ("Unrecognized key").
- LIST is `lists`: each list holds one or more items and an item has no kind (every LIST item is numbered).
  The engine numbers the items of each list 1, 2, ... in reel order, restarting at 1 in each list; a list
  with one item shows no number. An empty list, or a `kind` on an item, is refused.
- There is no title and no summary: a new version saves `change_title` and `change_summary` as null (the
  summary call is gone, "Version title and summary" below). `format`, `preset`, `duration` and
  `inputs` come from the current version, so the result is always a full edit and the AI cannot
  touch the input fingerprints.
- The hook (`hook`, `{ "text" }`, always, never null) is the hook call's answer, not a field of the
  components. Its schema (`hookAnswerSchemaFor`, `hookJsonSchema`) is one closed object: the text,
  bounded by the preset (`pace.hook.maxWords` 7, `maxCharacters` 45) and to one plain line (no line
  break, `<` or `>`, at least one letter or digit, counted after the final stop is taken off), with no
  time or place. `parseHookAnswer` returns the text through `stripHookStop`: its final full stops and
  ellipses are taken off, never refused, so the hook never ends with a dot ("?" and "!" stay). An
  over-long hook is refused like any answer error and goes back once with its reason
  (`text: a hook has at most 7 words`). The hook call also checks the glossary on its text
  (`hookGlossaryReasons`, `heardTerms`), so a heard form goes back to the hook call. The text is data
  to show, never instructions. The layout engine places it from 0.2 s to 3 s, the one extra of that
  window (`app_docs/edit-model.md`, "The written hook").
- `big_words` is a list of `{ from, to }`: one word (equal ids) or two consecutive words, from the
  first spoken word to the last; the same word allowed again. `to` is never before `from`, never
  more than two words apart, and each word must be one plain word (`BEHIND_WORD`).
- `visuals`: each VISUAL sits over its words, with a `description` of what a visual would show: a
  plain line of at most 8 words and 80 characters, with words in it. The description is data for the
  owner and the trace, never shown on screen. The layout puts the frame as a small corner card (a third
  of the frame's width, in front of the speaker): a corner of the safe zone or beside the face, never
  over the face, the smaller step before the corner fallback (`app_docs/edit-model.md`, "Preset values" and "Layout
  engine"). A new answer names no photo: a `photo_id` is refused
  like any unknown key. The description is stored on the placed item (`tracks.behind[].description`, optional)
  and read back by `choicesOf`.
- Behind lengths: a VISUAL shows 1 to 2 s (`behind.minSeconds`, `maxSeconds`), a big word
  its own timing (from `accent.leadSeconds`, 0.2 s, before its first word to its last word's end, at
  least 1.5 s, a target: a text said later in it cuts it short). An accent or a question shows exactly its words (no lead, no minimum). A big word only on a key word, a spoken word by construction.
- Pace (`preset.pace`): the answer carries no rate (the transition kind is given as data, its pace is
  not); the components prompt is told the reel's intensity word and the target count, never a rate. Every pick shows at its own words' times, so the rhythm is the answer's, and a reel too short for a pick clamps it to the reel's end (nothing is dropped for its length).

### Stored versions

Stored versions are never re-decided or rewritten: the engine and the stored edit format read and
render them as saved. The stored `checklist`, `unexpressed` and version title and summary are read
back as stored; `versions.checklist` stays empty for every version written now. `choicesOf` reads
every big word back as a `{ from, to }` list entry.

- `packages/edit/src/decide.ts`: `hookTextSchemaFor(preset)` (the hook's text rules, one place),
  `hookAnswerSchemaFor(preset)` and `hookJsonSchema(preset)` (the hook call's schema),
  `parseHookAnswer(json, preset)` (`{ ok, text }`, the text through `stripHookStop`).
  `decideAnswerSchemaFor(preset, transcript, rules)` (word-id enums from the reel's transcript, the
  LIST as `lists` (items with no kind), `visuals` with their description rules; no list has a count cap, no
  `max` and no `maxItems` (how many of each is the editor's choice, never a per-reel count it works
  to; a limit is added only when a real case shows the need, derived from that case)),
  `decideJsonSchema` (Zod 4
  `z.toJSONSchema`, draft-07, real `enum` lists, every object closed, refs inlined),
  `parseDecideAnswer` (both take the answer, the preset and the transcript),
  `editFromAnswer(current, answer, preset, transcript, headTrack, measurer, backgrounds?)` (the answer placed by the layout engine and parsed with the decide limits, returned as `{ ok, edit, record }`, the record being the engine's; the current version's `inputs.masks` is dropped, since
  the worker names them again for the new `behind` track; a parse failure here is an engine bug,
  refused as `answer-edit`), `decideCounts` (the step line's counts) and `usedFreeField`. The Zod
  refinement refuses a range ending before it starts, a key phrase outside its phrase, a big word that is not one or two consecutive plain words and a word fixed twice, each with a
  readable reason for the retry.
- `packages/edit/src/schema.ts`: `editSchemaFor` takes optional `EditLimits { duration, bounds,
behindLengths }`; without them stored versions keep parsing with the default frame
  limits. `behindLengths` (the decide limit) refuses a VISUAL outside 0.5 to 2 s and a big word outside 0.5 s up to its lead, its words and `afterSeconds` (at least 1.5 s). A stored version parses without it.
- `packages/edit/src/glossary.ts`: `glossaryChecks`, check rule `glossary`: no caption or overlay
  shows a heard form of a glossary term; the term itself passes.
- The AI double: `E2E_MOCK_AI=true` is the real runner over a scripted model (the AI SDK's
  `MockLanguageModelV4`), so the usage, cost, fallback and error mapping run as in production and
  nothing touches the network. It replays the replies in the JSON file named by `E2E_MOCK_AI_SCRIPT`:
  an array (replayed in order, the last repeating) or one reply object (used for every call); an
  empty array, a non-object value or non-JSON throws. A reply is `{ "answer": <json>, "usage"?: {
"input_tokens", "output_tokens", "cost_usd" }, "model"? }`, a string (raw model text, so `"not json"`
  is a broken answer) or `{ "error": { "status", "message"? } }` (an HTTP error: 402 is unavailable, 400
  a refused schema). A reply naming `"role": "hook"` answers only the hook calls (in order, the last
  repeating); a reply naming no role answers every other call. A script with no hook reply throws on
  the hook call. Without a script the double gives the default hook (`DEFAULT_HOOK_ANSWER`) and
  `EMPTY_DECIDE_ANSWER` (no items). It never retries.
- `apps/worker/src/decide/hook.ts`: the hook call's prompt (`reel-hook`, fetched, see "Prompts").
  `hookInput(transcript, preset)` gives the transcript's words in order (no ids, no times, no
  geometry) and the style (`hook_length` `{ words, characters }`, the glossary); `hookPrompt(template,
input, reasons?)` fills them as fenced JSON and, on the retry, appends the refused reasons, and
  returns the text with its identity (`PromptCall`). `hookGlossaryReasons` checks the
  text for a heard form. The answer is `{ "text" }`; its length, its one line and its final stop are
  checked in code (`parseHookAnswer`).
- `apps/worker/src/decide/prompt.ts`: the components' prompt (`reel-components`, fetched, see
  "Prompts"). `decidePrompt(template, input, reasons?)` fills the inputs as fenced JSON and, on the
  retry, appends the previous reasons, and returns the text with its identity (`prompt_version` on the
  version row).
- `apps/worker/src/decide/input.ts`: the components prompt's input, with no time, position or style:
  `script` (`scriptOf`: one entry per sentence, `{ sentence, words: [{ id, text }] }`, a sentence ending
  at `.`, `?`, `!` or a pause of 0.6 s, the word ids the answer names), `hook` (`{ text }`, the hook
  call's text), `intensity` (the preset's level), `target_picks` (`targetPicks`: the speech from its
  first word's start to its last word's end, over `preset.picksEverySeconds[level]`, rounded, at least
  one). `speechAfterHookSeconds` measures from the later of the first word's start and the hook's end
  (`preset.pace.hook.untilSeconds`), so the hook window is not counted in the target. A word of `script` that starts before the hook ends carries `under_hook: true`
  (other words omit the field). Nothing else is sent: no glossary, no current choices, no
  transcript list, no preset summary, no transitions. No photo library is read or sent. No head track, face
  box, `clear_spots`, safe box, font size or spot: the layout owns free space.
- `packages/edit/src/checks.ts`: the layout checks are the engine's final guard, never a refusal of the answer (`app_docs/edit-model.md`, "Checks").
- `apps/worker/src/decide/run-decide.ts`: `runDecide`, a `runToolsStep` named `decide`. It reads the
  current version and its inputs, builds the schemas, and makes the hook call first (`decide.hook`
  span, at most two attempts: a hook refused by its schema or its glossary goes back once with the
  reasons), then the components' call (at most two attempts), never a loop. The three prompts are
  fetched before the first call (`decidePrompts`); a fetch failure is a transient step failure. A hook that fails twice
  fails the step with `decide: the hook failed twice, version <n> stays current` and each round's
  reasons, nothing written, the same as a failed components answer.
  An attempt is refused only when the JSON does not parse, the schema refuses it, `editFromAnswer`
  cannot parse the placed edit or `glossaryChecks` reports a heard form. A placed attempt is then
  built for its layout checks (`withMasks`); they never refuse it. A check failing on the engine's
  output is an engine bug: the worker logs `decide: engine bug, reel <id>: <rule> <item>: <reason>; ...`
  and still saves the version, with the checks stored on its row (`checks`). The one face covering the
  engine may make (captions it records `covers-face`, when nothing else is free) is not called a bug.
  With `behind` items, `ensureCutouts` (`apps/worker/src/cutout/ensure-cutouts.ts`) makes sure each padded span's mask is stored (a `cutout` step row,
  `app_docs/pipeline.md`) before anything is saved; a failure there comes after the AI call, so it is
  permanent, and no version is saved. It then writes the AI record, then `saveVersion` with `parentId`
  the current version, `request` null, model, the components' identity as `promptVersion`,
  `changeTitle` and `changeSummary` null, `checklist` empty,
  `unexpressed` empty, the records below (`free_field` is always empty: the answer has no free style; `used_free_field` reports
  a kept item's style) and the engine record (`engine_record`). After the save the worker logs the
  record in one line (`apps/worker/src/engine-record.ts`, `engineRecordLine`):
  `engine record, reel <id>, version <n>: <item> <action> (<rule>): <reason>; ...`, or `nothing moved`.
  Step line: `version 2: 1 accent, 1 transition, hook set, 1 word fixed`, with `, <n> behind` after it
  when the version has behind items, and `, started over
from version <n>` for Start over.
  There is no title segment: a new answer has no title.
- `apps/worker/src/process-job.ts`: runs `runDecide` after `saveFirstVersion`. Never cached: a retried
  job decides again from the then-current version.
- `apps/worker/src/step-runner.ts`: `ToolsStep.work` may return `ai` usage (the AI calls are HTTP calls
  inside the step's work, so the step's wall time includes them); `StepError(message, tail, ai)` fails a
  step with its own tail (the reasons) and the AI usage spent. `apps/worker/src/step-store.ts` writes the
  `ai_*` columns (`aiMeasurements`).
- `apps/worker/src/doctor-checks.ts`: the `openrouter key` line checks `OPENROUTER_API_KEY` is set (never
  printing it) and is the only AI line by default. The `posthog personal key` line and one `prompt` line
  per prompt (`name@vN`, its label, never its text) come after it (see "Prompts"). Only `yarn workspace @edit-issebya/worker doctor --ai`
  adds the `ai structured call` check, one tiny real call with the real `decideJsonSchema` (the sample
  reply: empty lists), and the `ai hook call` check, one real call with the real `hookJsonSchema` and
  the fetched hook prompt (the sample transcript), so `doctor --ai` fails on a schema the provider rejects; the
  answer must pass `parseDecideAnswer` (`parseHookAnswer` for the hook), and each line names the model
  that answered. These calls are real
  and paid (a fraction of a cent); tests run them with the double only.
- The `versions` columns (`supabase/migrations/20261101175625_version_decide_records.sql`, `20261103192618_version_change_title.sql`,
  `20261103230327_version_engine_record.sql`, `20261104013645_version_checklist.sql`): `used_free_field`,
  `unexpressed`, `free_field`, `rejected_reasons`, `change_title`, `engine_record`, `checklist`. A new
  version writes `unexpressed` and `checklist` empty and `change_title` and `change_summary` null; the
  columns stay for older rows (`NewVersion`,
  `VersionMeta` in `packages/edit/src/versions.ts`, `supabaseVersionRows`).

### Version title and summary (retired)

The version summary call is removed (owner decision 2026-11-08): it cost a call on every version for a
change box that is gone. No title or summary is written now, and nothing computes one: there is no
call, no template and no safeguard. A new version saves `change_title` and `change_summary` as null.
Versions saved earlier keep their stored title and summary, and the studio keeps showing them
(`app_docs/change-requests.md`). The columns and the RPC parameters stay (no migration).

### Failure

A prompt the worker cannot fetch from PostHog fails the step before any AI call, as a transient failure
(`PromptUnavailable`, "Prompts"). A transient retry (`app_docs/failures.md`) is the step runner's and never adds AI calls: from the first
AI call on, `runDecide` wraps every failure but `AiUnavailable` in `PermanentError`
(`permanentAfterAiCall`), so the step runner never runs the step again and the step makes at most two
hook calls and two decide calls. A failure
before the first AI call may still be retried once.

Two refused rounds throw `StepError` with the tail `decide: the answer failed twice, version <n> stays
current` and each round's reasons (at most 8 lines per round, `and k more` closing a longer one). Nothing
is written to R2 or `versions`, the reel's current version is unchanged, and the step row still carries
the tokens and cost spent.

The automatic run is never a no-op refusal: an answer that changes nothing still saves (the version
records it). The `NothingChanged` refusal of the request path is gone.

## How to Use

1. Upload footage in the studio; the worker runs the fixed steps, `first_version`, then `decide`.
2. The reel page shows `decide: version 2: ...` and the step's tokens, cost and model.
3. A failed decide shows both rounds' reasons in the step's error tail; version 1 stays current. Retry
   the job to decide again.
4. Start over decides again from version 1 and saves a new version through the same path.

## Prompts

The prompts the AI calls send are not in this repository. Their text lives only in PostHog prompt
management (project 312096), and the worker fetches each one by name at the label in
`POSTHOG_PROMPT_LABEL` (default `production`). The repository is public and the wording is private
(AGENTS.md): no prompt file, fixture, doc, comment or snapshot holds it, and a test asserts that no
prompt file exists (`apps/worker/src/prompts/no-prompt-files.test.ts`).

- `reel-hook`: the written hook, one short line from what the speaker says (`hook.ts`).
- `reel-components`: the components' answer, meaning only (`prompt.ts`). Its variables, and nothing else:
  `script` (the sentences with their word ids, fenced JSON; a word starting before the hook ends carries
  `under_hook: true`, and the others omit it), `hook` (the written hook's `{ text }`, fenced
  JSON, as data), `intensity` (the reel's edit intensity as one lowercase word, `intense`, `medium` or
  `calm`, the preset's level, `preset.intensity`) and `target_picks` (the target count as a number, see
  `input.ts` above). No glossary is sent; `word_fixes` stays in the answer and is checked by the engine.
  The worker adds nothing else to the prompt; the retry's reasons are appended after it.
- `photo-describe`: a library photo's description and tags (`photos/describe-prompt.ts`).

Each prompt is a template with its `{{variables}}` (the worker fills them as before) and nothing else
the worker reads. The model takes no temperature setting (Haiku 5.5 on OpenRouter has none), so a
prompt carries none and no call sends or records one. The version is fetched with
the label, and its identity `<name>@v<version>` (for example `reel-components@v1`) is recorded in the
version row (`prompt_version`, the components' identity), the AI record (`prompt_version`,
`hook_prompt_version`, and each call's `promptVersion`), a photo row
(`prompt_version`) and the `chat` span (`edit_issebya.ai.prompt_version`).

- `apps/worker/src/prompts/source.ts`: `PromptSource.get(name)` returns `{ name, version, label, text }`;
  `renderPrompt` fills a template and appends a retry's reasons, returning the call's text and
  identity; `decidePrompts` fetches the two decide prompts together.
- `apps/worker/src/prompts/posthog-source.ts`: the source, a plain `fetch` (no SDK) to
  `GET {POSTHOG_HOST}/api/projects/{POSTHOG_PROJECT_ID}/llm_prompts/name/{name}/?label={label}` with
  the header `Authorization: Bearer {POSTHOG_PERSONAL_API_KEY}`. The label is the query parameter of
  that route (the MCP `llma-prompt-get` takes `label` on the same prompt), so no resolve endpoint is
  used. The answer's fields the worker reads are `prompt`, `name`, `version` and `label`; a `config`
  is ignored. It needs three settings: `POSTHOG_PERSONAL_API_KEY`, a personal API key with
  only the `llm_prompt:read` scope, restricted to this project (PostHog user settings, Personal API
  keys); `POSTHOG_PROJECT_ID`, the project's numeric id (PostHog project settings, General, not
  secret); and `POSTHOG_HOST`. No project token is sent or read: the URL carries none, and the source
  never reads `POSTHOG_PROJECT_TOKEN` (the events token) or any other token. Each request times out
  after 10 seconds. The shape of the endpoint was taken from the `@posthog/ai` SDK's prompt client
  (its `llm_prompts/name/` route, the same fields), which it replaces; the PostHog API reference page
  could not be read when this changed, so re-check the route against it when the API docs load.
- Freshness and the last good copy: a version fetched within five minutes is served from memory. When
  PostHog does not answer (a network error, a timeout, a 5xx or a 429), the last version this process
  fetched is served for at most 60 minutes after its fetch, as a stale copy: one warning line
  (`prompts: <name>@v<n> served from the last copy, fetched <m> minutes ago; PostHog did not answer`),
  and `promptStale: true` on each call that uses it (the AI record's call, the `chat` span's
  `edit_issebya.ai.prompt_stale`). The copy lives in memory only: no disk, no log line beyond that
  warning, no repository, and never its text. A prompt never fetched in this process fails. A 404 or a
  missing label is not an outage: it fails and drops the copy, so a
  deleted or relabelled prompt stops running at once.
- `apps/worker/src/prompts/select.ts`: `promptSourceOf(env)`, the placeholder source under
  `E2E_MOCK_PROMPTS=true`, else PostHog. One source per worker process (`process-job.ts`, `doctor.ts`).
- Failure: a prompt that cannot be fetched (no key or token, PostHog unreachable with no copy from
  the last 60 minutes, the prompt or its label missing, a label not on the version served) is `PromptUnavailable`, a transient failure before any AI call, with the
  message `prompts: <name> (label <label>) could not be fetched: <reason>` (`app_docs/failures.md`).
  There is no fallback text in code.
- Tests: `apps/worker/test-support/fake-prompts.ts` holds placeholder templates (one neutral line each,
  with the variables the call fills, versions 1). `E2E_MOCK_PROMPTS=true` selects it for the worker in
  the E2E specs (`apps/studio/test-support/worker.ts`), so the E2E identities are `reel-*@v1` and
  `photo-describe@v1`.
- `yarn workspace @edit-issebya/worker doctor` fetches each of the four prompts and prints its
  identity and label (never its text), after the `posthog personal key` line.

## Configuration

- `OPENROUTER_API_KEY`: the worker's OpenRouter key (`apps/worker/.env.development`, placeholder in
  `apps/worker/.env.example`). Without it every AI call is `unavailable` (`the OpenRouter key is not
set`) and the job waits.
- The model: `AI_MODEL` in `apps/worker/src/ai.ts` (`anthropic/claude-haiku-5.5`), one setting;
  `AI_MODELS` maps each role (`hook`, `decide`, `describe`) to it, the one place to give
  a role another model later.
- `E2E_MOCK_AI` and `E2E_MOCK_AI_SCRIPT`: tests only; documented in `apps/worker/.env.example`.
- `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_PROMPT_LABEL` and
  `POSTHOG_HOST`: the prompts, see "Prompts". `E2E_MOCK_PROMPTS`: tests only.
- No migration for this change.

## Testing

- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker`: `decide.test.ts` (the
  per-reel schema and its closed objects; LIST items with no kind and no `wish` anywhere; the
  refusals of a title, a `dim`, `panel` or `card`, a wish, a checklist, `behind_rules` and `unexpressed`;
  the hook, its final stop taken off; a visual's description limit, and no photo id; `questions` required), `glossary.test.ts`, `ai.test.ts` (the OpenRouter request
  through the real provider over a captured `fetch`, no network; the double; the error mapping),
  `ai-record.test.ts` (the identities in the record), `hook.test.ts` (the hook call's input with no
  ids or times, the hook prompt's fill and retry reasons, the closed one-text schema, the glossary
  reason), `prompt.test.ts` (the components prompt fills its five variables and no other, the script's
  word ids, the intensity and target line, no removed input or glossary sent, the retry reasons), `input.test.ts`
  (the script with word ids and no times, the speech after the hook window, the target at each level, at least one), `run-decide.test.ts` (the hook call first, then the components with the
  hook text as data, the step saving version 2 with the step line `1 accent, 0 transitions, hook set, 1
word fixed`; the AI record holding the hook and decide calls; the hook refused by its
  schema or a heard form sent back once to the hook call; a hook refused twice fails the step with
  `the hook failed twice` and calls no components; one retry on the components, a second refusal failing
  the step, nothing written on failure; the usage of every call summed; a wide accent or a visual on the
  2.7 s clip over the hook, kept and noted; the two behind tests that need a
  placed visual run on the 47 s reel, see "Testing" below) and `step-runner.test.ts`. `ai.test.ts` also covers the
  double's hook lane. `apps/worker/src/decision-trace.test.ts` (`hookOf`: the hook call's text, the last
  readable one, else an older record's decide `hook`). `packages/edit/src/engine.test.ts` ("the written
  hook": the fixed slot, an accent and an image asked for in its window never move or remove it). `run-decide.test.ts` builds its check-refused answer as a word fix
  writing the heard form "Locking" (the schema accepts any fix text, so only the glossary check refuses it).
  `prompts/posthog-source.test.ts` and `prompts/source.test.ts` (the fetch with a
  stubbed `fetch`, the failures, the identity; the last good copy within 60 minutes
  on a network error or a 5xx, refused beyond it, never for a prompt never fetched or a 404; the source
  never reading `POSTHOG_PROJECT_TOKEN`), `prompts/no-prompt-files.test.ts`
  (no prompt file in the repository). `decision-trace.test.ts` (both old and new answers).
  Behind tests on a short clip: the 2.7 s fixture clip is all hook. `run-decide.test.ts` seeds the 47 s
  reel of the packages/edit fixtures (its transcript and head track written over the clip's keys, the
  first version replaced) for the two long-reel tests (`useLongReel`, visual on w18 to w25). The e2e
  specs that place a visual or a transition (`decide-behind.spec.ts`, the preview transition test) seed
  `speech-ten`, the 10 s clip with a person and a transcript (`app_docs/pipeline.md`), with the scripted
  answers of `apps/studio/test-support/ai-script.ts`; the export spec's behind test still seeds the 2.7 s clip.
  After a change to the preset or the layout, re-derive these from the new values; never loosen a check to
  make them pass.
- The worker's and the studio's `test` tasks depend on `^transit` in `turbo.json`, so a change in
  `packages/edit` or `packages/storage` changes their hash and turbo runs them again instead of replaying a
  cached pass; both also hash `fixtures/pipeline/`.
- `decide/testdata/short-speech-answer.json` is the scripted AI replies for the fixture clip: the hook
  reply (role `hook`, "A short test for the real studio") and the decide answer (one accent word,
  w0005, and one fixed word, w0010 "Studio", no transition). The accent is said while the hook shows, so it
  cuts the hook where it starts (noted `text-one-at-a-time`); the accent keeps its own words, and the step
  line reads `1 accent, 0 transitions, hook set, 1 word fixed`.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` covers the new columns, `checklist`
  included.
- E2E: `apps/studio/e2e/upload.spec.ts` sets `E2E_MOCK_AI_SCRIPT` to the committed answer and checks the
  decide line (`1 accent, 0 transitions, hook set, 1 word fixed`), the `ai_*` columns (1800,
  496, 0.0138 over the hook and decide calls, `anthropic/claude-haiku-5.5`), version 2's row (no title and
  no summary, both null), its AI record (`hook` and `decide` calls, `hook_prompt_version` `reel-hook@v1`)
  and both R2 keys (`reel-components@v1`). The E2E run uses the placeholder prompts
  (`E2E_MOCK_PROMPTS`), so every identity it asserts is a fake's.
  `preview.spec.ts` seeds through `test-support/ai-script.ts` (`unchangedAnswerScript`), whose decide
  answer makes no choice; version 2 is then version 1 plus the hook alone (every reel has one), so it no
  longer matches the version 1 golden (see the report of the hook change). `decide-behind.spec.ts` seeds a processed reel whose automatic decide proposes a visual, and the preview shows its frame. `behind.spec.ts` (a change answer with a wish) is removed with the change box.
  `change-requests.spec.ts` covers going back and Start over, not a typed change.

## The AI runner

`apps/worker/src/ai.ts`, one module for every AI call.

- `AI_MODEL = "anthropic/claude-haiku-5.5"` (OpenRouter's slug, checked against OpenRouter's model
  list on 2026-11-05: text, image and file input, `structured_outputs` and `response_format`
  supported), and `AI_MODELS`, the one map from role to model.
- Provider: `@openrouter/ai-sdk-provider` 3.x (its line for `ai@^7`) with `ai` 7, ESM, Node 22+
  (the worker runs Node 24). The model is created with `usage: { include: true }` (OpenRouter's
  usage accounting: the response carries the cost) and `provider: { require_parameters: true }`
  (only endpoints that take every parameter sent, the structured output included).
- `AiRunner.call({ role, prompt, promptVersion, schema, image?, signal?, trace? })`:
  `generateText` with no temperature (the model takes none) and the prompt as the one user message (the image beside it as a JPEG file part, sent as an `image_url` data
  URL), `Output.object` over `jsonSchema(wireSchema(schema))` (strict `json_schema`, named after
  the role), `maxOutputTokens` 16000, `maxRetries` 1 (the AI SDK's backoff: one more try on a
  network error, a 429 or a 5xx), `timeout` 180 s, and the job's signal. The SDK only parses the
  JSON; it never validates it (`jsonSchema` without a validator): the caller's Zod check gives the
  reasons the retry sends back, as before.
- `wireSchema` leaves out what Anthropic's strict outputs refuse (string lengths, number bounds,
  `maxItems`, `minItems` over 1) and the `$schema` line; the Zod check still enforces all of them.
- A schema the provider refuses (HTTP 400) is asked again once in JSON mode (`json_object`), the
  schema appended to the prompt with a fixed reply instruction (no code fence); a second 400 is thrown (a bug, a permanent failure). Haiku may still fence its
  JSON mode answer, so an answer that does not parse goes through `extractJson` (`ai.ts`): a
  leading and trailing Markdown code fence (three backticks, with or without a language such as
  `json`) is stripped, and when text is still left around it the outermost object (the first `{`
  to the last `}`) is taken, nothing else guessed. The exchange keeps the raw answer text. A strict
  JSON Schema answer is never extracted.
- Results: `answer`; `broken` (not JSON, or cut off at the output limit), with the raw text;
  `unavailable` with a reason: no key (`the OpenRouter key is not set`), 401 or 403
  (`the OpenRouter key is refused`), 402 (`the OpenRouter credits are used up`), 429
  (`the rate limit is reached`), 408, a 5xx, a network failure or the timeout
  (`OpenRouter is not answering`), each after the one retry. A cancelled job's signal rethrows;
  anything else is thrown, so from the first call on the step fails for good
  (`permanentAfterAiCall`), as before.
- Usage per call: input tokens (all of them, cache reads and writes included), output tokens, the
  cost OpenRouter reported (`providerMetadata.openrouter.usage.cost`), else the list price, and
  the model that answered (`response.modelId`). Summed per step into `steps.ai_*`; the version's
  `model` is the editor's (`usage.model`).
- Every result carries its exchange (role, model, prompt as sent, its identity `promptVersion`,
  schema, image media type and size, output mode, raw answer text, finish
  reason, usage, error).
- The `chat` span (`app_docs/measurement.md`): `chat anthropic/claude-haiku-5.5`, provider
  `openrouter`, with the prompt's identity.

### The version's AI record

`apps/worker/src/decide/ai-record.ts`: before `saveVersion`, `runDecide` writes
`<prefix>reels/<reel>/versions/<version id>.ai.json` (put-if-absent, under the id the version is
then saved with): `{ format: 1, reel_id, version_id, prompt_version, hook_prompt_version, intensity, target_picks, calls }` (the
two identities, `<name>@v<version>`, the intensity and the target count the components prompt was filled
with; absent in a record written before they were recorded), each call `{ attempt, role,
model, prompt, promptVersion, schema, image, outputMode, answerText, finishReason, usage,
error }` in order: the hook attempts first (role `hook`, attempt 1 and
2), then the decide attempts (role `decide`, 1 and 2). It is a `stored_files` row of kind `version`, step `decide` (`classifyKey`), so it is
kept with the version and deleted with the reel. A decide that saves nothing (refused twice,
nothing changed, waiting) writes no record; its reasons are in the step's error tail. To replay a
version, send each call's `prompt` with its `schema` to its `model`.

### The decision trace

`yarn workspace @edit-issebya/worker trace <reel id>` (no id: the latest 15 reels) prints, by
default, the script view of every version with an AI record: the hook (the text of its last readable
`hook` call, else an older record's decide answer `hook`, `hookOf`), then the transcript in short
lines (`scriptLines`), each line with Claude's picks on it in capitals and the word fixes; what the
engine did is left out. The header names both prompt versions, the hook's (`hook_prompt_version`)
and the components' (`prompt_version`), the reel's intensity and target (`intensity intense, target 24`, when recorded), and
the decide attempts when there were more than one (`traceHeading`). Lines: a sentence ends at `.`, `?` or `!`; a line over 50 characters splits at
the comma nearest its middle; a line still over 60 characters (typical of speech with no
punctuation) splits at its largest speech pause, a gap of 0.35 s or more between two words' timings,
else after the last word that keeps it within 60 characters. The script column is 60 wide. A pick
sits on the line where its words start; a line with several picks prints one row per pick, the
script on the first row and the rest with an empty script column. The picks
use the owner's editor words: `ACCENT` (an accent),
`QUESTION "<words>"` (a question the speaker puts to the viewer), `BIGWORD`, `VISUAL "<description>"` (a visual on its words, the words only when the span is not the whole line), `LIST` (numbered transitions, on single words of one
line and list grouped as one pick, `LIST <list number>`; a list's item is `list <list>.<item>` in the table). `whole line` shows when a
pick is exactly its line. With `--table` it prints instead, for every version with an AI record,
one row per item of the last readable decide answer (and the hook): its engine id (`accent-N` in answer
order, `big-word-N`, `visual-N`, `question-N`, `transition-N`, `hook`; these ids match the engine record and are
not renamed), what Claude proposed in the same words (`accent "..."`, `question "..."`, `bigword "..."`, `visual "..." on "..."`, `list <list>.<item> "..."` for LIST items, `hook "..."`), `kept` (no engine note) or `changed` (placed with notes), and the notes as `action (rule)`; a question is `question "..."` with the engine id `question-N` (its own answer order, not the accents' count); then the counts, the word fixes and the notes on other items (captions)
by action and rule. It reads the `versions` row, the AI record and the transcript with the
worker's own variables and writes nothing (`src/trace.ts`, `src/decision-trace.ts`).

## Readable text

Before the AI call, `run-decide.ts` ensures the footage's background map (`ensureBackgrounds`, a
failure is an ordinary step failure) and passes `backgroundSampler(map, preset.frame)` to
`editFromAnswer`, so the engine moves unreadable text to a nearby free place that reads, else
leaves it in place, plain, and records it (never a shadow, never a colour change; see
`edit-model.md`).

## Rules

- At most two hook calls and two decide calls (one retry each); never an unbounded loop.
- Claude never writes times, positions or sizes: the answer is meaning only (word ids, visual descriptions), every object closed; the layout places everything.
- Claude writes only the new vocabulary: ACCENT (`accents`), QUESTION (`questions`), BIGWORD (`big_words`), VISUAL (`visuals`, each with its description), LIST (`lists`, each a list of items) and `word_fixes` in the components' call;
  the hook (`text`) in its own call, never in the components'. A title,
  a list with no items, a `kind` on a LIST item, a `wish`, a checklist, a behind rule or an unexpressed list is
  refused by the schema.
- No density target in the schema. The target count is the prompt's input only, computed in code from
  the speech and `preset.picksEverySeconds`; the schema does not count picks, and the overlap limits are
  the prompt's (see "Prompts").
- Never give Claude geometry or times to decide with (no face box, spots, safe box, font sizes or word
  times in the input; the hook's length, never its window).
- The hook is the one text Claude writes itself, in its own call, on every reel: always one (never null),
  bounded by the preset's words and characters, checked against the glossary, data and never instructions;
  it is never kept from an earlier version (a run decides it again), and never ends with a full stop
  (`stripHookStop` takes it off). The components' call only receives it as data.
- Never give the model tools, a session or any instructions but our own prompt, fetched from PostHog
  (one user message, no system prompt, no plugins, no CLAUDE.md); `describe_photo` adds only its one image
  (`app_docs/photo-library.md`).
- Every AI call goes through `apps/worker/src/ai.ts` with the model of its role in `AI_MODELS`; never name
  a model anywhere else.
- Never save a decided version without its AI record; never put a key or image bytes in it, never rewrite
  one.
- Never save a decided or first version without its engine record; never rewrite an old row's record.
- Never let the answer carry `format`, `preset`, `duration` or `inputs`.
- Never write a version or R2 key for a refused answer; the current version stays.
- Never refuse an answer over layout: only the schema and the glossary refuse. Layout checks are the
  engine's final guard; one failing is logged as an engine bug with the reel id and the version is still
  saved.
- Never cache the decide step.
- Prompt text is changed only in PostHog prompt management (a new version, moved to the label). The
  worker records the identity it fetched; a prompt never enters the repository (AGENTS.md).
- Never save a version with a `behind` item before its masks are stored.
- Never cap the components' answer lists (accents, questions, big words, visuals, LIST lists and their items, word fixes) or any per reel count (in the preset, the prompt or the answer schema): how many is the editor's choice. No list has a `max` or a `maxItems`. A limit is added only when a real case shows the need, derived from that case. A visual is a frame with a description of at most 8 words.
- Transitions never set the rhythm: a numbered list item is only ever a counted list, and the model is sent no rate. The engine shows every transition the answer names.
- A new answer names no photo: a visual is a frame, and the answer's schema has no photo id.
- The decide step reads no photo library (for now), so none is sent to the model.
- Never write a title or a summary for a new version: `change_title` and `change_summary` are saved null.
- Record the usage numbers as OpenRouter reports them, the cost included; only a call whose response carries
  no cost gets the list price from `PRICES` in `ai.ts` (Haiku 5.5: $0.10 input, $0.50 output per million
  tokens). Never estimate tokens.
- Never let a test call OpenRouter or any network: use the double (`E2E_MOCK_AI`) or a captured `fetch`. Only
  `doctor --ai`, run by the owner, makes real calls.
- A version written now has an empty checklist and no unexpressed list; the owner's request path is dormant
  (`app_docs/change-requests.md`).

## Notes

- The OpenRouter switch (2026-11-05) and an unresolved risk: Anthropic's strict structured outputs may refuse
  a large per-reel schema (word-id enums repeated per field); the runner then asks once in JSON mode and the
  Zod check does the rest. Check `edit_issebya.ai.output_mode` on the `chat` spans after the first real runs.
- The change box is removed (owner decision 2026-11-07): the answer has no checklist, no behind rule and
  no unexpressed list, and its LIST is `lists` (numbered per list, no kind). The reasons are in
  `app_docs/change-requests.md`.
- The engine's placement is in `app_docs/edit-model.md`, "Layout engine".
- The editorial round is removed (owner decision 2026-11-08). The engine is tuned first, so the trace shows
  exactly what the components' call picked and what the engine did with it, with no second call in
  between. Versions decided before the removal keep their editorial calls in the AI record and their
  `editorial` notes in the engine record; the trace skips those calls and reads the notes as stored.
- The version summary call is removed (owner decision 2026-11-08): one AI call per version less, and the
  change box it wrote for is gone. The difference module it read (`packages/edit/src/version-diff.ts`) went
  with it. Versions saved before keep their stored title and summary.
