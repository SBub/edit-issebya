# Feature: Honest version summary written from the saved difference by a second short call

## Metadata

issue_number: `156`
adw_id: `ca502a36`
issue_json: `{"number":156,"title":"decide: honest version summary written from the saved difference by a second short call"}`

## Feature Description

Today the version title and summary the owner reads in the Versions list (`change_title`,
`change_summary`) are written by Claude inside the decide answer, before the layout engine runs.
The engine may then drop, move or retime what Claude chose, so the summary describes an intention,
not the saved edit (2026-11-03: v4 said "Photo added behind you" while its edit was byte for byte
v3's).

This feature moves the title and summary after layout. The decide answer loses `change_title` and
`change_summary`. Once the final edit is placed (after the editorial rounds and the cut-outs), code
computes a structured difference between the current version's edit and the new one (items added,
removed, moved, retimed, changed, plus the reel's behind rule flags switched on or off). A second,
short Claude call on a small model (`claude-haiku-5-5`, through the existing runner with a new model
option) gets only the owner's request, the stored checklist outcome, that difference and the engine
record, and writes `change_title` (2 to 5 plain words) and `change_summary` (one or two plain
sentences). A code safeguard then checks the text: every kind of item it names must be in the
difference, and it must carry no word id, font, size or time. When the check fails, or the call
fails in any way, a code template written from the difference and the record replaces it.

A change request whose new edit is byte for byte the current one (and changes no behind rule) is
never saved as a version: the job fails as a refused answer with the rule `no-change` (plus the
engine's drop rules), and the progress overlay tells the owner "Nothing changed" and why, with
Change the request and Keep the current version.

## User Story

As the owner of a reel
I want each version's title and summary to describe exactly what changed in the saved edit
So that I can trust the Versions list and never read "Photo added" on a version that shows no photo

## Problem Statement

`change_title` and `change_summary` are part of the decide answer (`packages/edit/src/decide.ts`,
`decideAnswerSchemaFor`) and are saved as is by `runDecide`
(`apps/worker/src/decide/run-decide.ts`, `changeTitle: answer.change_title`). The layout engine
(`placeEdit`) never refuses an answer: it drops, moves and retimes items and records why in
`versions.engine_record`. So the summary can name items the saved edit does not have, and a change
that ends identical to the current version is still saved as a new "changed" version with a
summary of something that did not happen.

## Solution Statement

1. `packages/edit/src/version-diff.ts`: `diffEdits(before, after, transcript, preset)`, a pure,
   deterministic structured diff of two edits over every track, each entry
   `{ kind, action, id, text?, photo_id?, spot? }` with `action` one of `added`, `removed`,
   `moved`, `retimed`, `changed`, keyed by a stable identity per kind (below). Plus
   `ruleChanges(before, after)` for the behind flags.
2. `packages/edit/src/version-summary.ts`: the summary answer schema
   (`summaryAnswerSchema`, `summaryJsonSchema`, `parseSummaryAnswer`), the safeguard
   (`checkSummary(summary, diff, preset)`), and the template
   (`summaryTemplate(diff, record, checklist)`), all pure.
3. `apps/worker/src/ai.ts`: `AiRequest.model?: string` passed as `--model <model>` (validated), the
   fake recording it.
4. `apps/worker/src/decide/version-summary.ts` and `summary.md`: the summary call
   (`writeVersionSummary`), one call, never retried, on `SUMMARY_MODEL = "claude-haiku-5-5"`; its
   input quoted as fenced JSON data; any failure (broken, unavailable, refused by the safeguard,
   thrown) gives the template and a log line. An empty diff makes no call.
5. `run-decide.ts`: after `ensureCutouts`, compare the new edit's bytes with the current blob; on a
   request with identical bytes and no rule change, throw `NothingChanged` (an `AnswerRefused` with
   rules `no-change` plus the record's drop rules), saving nothing. Otherwise compute the diff, run
   the summary call, save the version with its title and summary.
6. Remove `change_title` / `change_summary` from the decide answer schema, prompt (bump
   `PROMPT_VERSION` to `decide-8`), committed answers, the doctor check and the E2E scripts.
7. Studio: `RULE_WORDS` gains `no-change` and the engine drop rules; the overlay's failure headline
   reads `Nothing changed` when the rules include `no-change`.

No migration: `change_title`, `change_summary`, `engine_record`, `checklist`, `failure_kind`
(`answer_refused`) and `failure_rules` (any 1 to 20 rule names) already exist.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (Yarn only, no em-dashes, no trailers, profile in step).
- `.adw/project.md`: the profile; its Tests section describes `upload.spec.ts`,
  `change-requests.spec.ts` and `decide-behind.spec.ts`; update those lines for the new behaviour.
- `docs/conditional-docs.md`: the `decide-step.md` and `change-requests.md` lines gain the summary
  call and the version diff.
- `app_docs/decide-step.md`: the decide answer, prompt, records, failure, Rules; the main doc to
  update (summary call section, Rules lines).
- `app_docs/change-requests.md`: Versions list texts, "A change that decides on no edit"; gains
  Rules lines ("the summary describes only the saved difference", "an unchanged edit is never saved
  as a change").
- `app_docs/edit-model.md`: the edit format, item ids, layout engine and engine record; gains the
  version diff module.
- `app_docs/status.md`, `app_docs/failures.md`: the overlay's refused-answer state and
  `failure_rules`; gain `no-change`.
- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor` (drop `change_title`, `change_summary`).
- `packages/edit/src/schema.ts`: the item shapes (ids, anchors, `words`, `text`, `spot`,
  `position`, `photo_id`) the diff compares.
- `packages/edit/src/engine.ts`: `EngineNote`, `EngineAction`, item ids (`title`,
  `transition-n`, `photo-n`, `big-word`), the drop rules (`no-room`, `one-extra`,
  `hidden-footage`, `make-room`, `wish`).
- `packages/edit/src/editorial.ts`: `ChecklistOutcome` (input of the summary call and the template).
- `packages/edit/src/versions.ts`: `editBytes` (the byte comparison), `VersionMeta`.
- `packages/edit/src/preset.ts`: font names the safeguard refuses.
- `packages/edit/src/index.ts`: exports.
- `packages/edit/src/decide.test.ts`, `editorial.test.ts`: answer fixtures carrying the two fields.
- `apps/worker/src/ai.ts`, `ai.test.ts`: `AiRequest`, `claudeRunner`, `fakeAiRunner`,
  `EMPTY_DECIDE_ANSWER`.
- `apps/worker/src/decide/run-decide.ts`, `run-decide.test.ts`: the save path.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`, `prompt.test.ts`: decide prompt and version.
- `apps/worker/src/decide/editorial.test.ts`: fixture answer carrying the two fields.
- `apps/worker/src/decide/testdata/short-speech-answer.json`: the committed scripted answer.
- `apps/worker/src/failure.ts`, `failure.test.ts`: `AnswerRefused`; add `NothingChanged`.
- `apps/worker/src/run-job.ts`, `run-job.test.ts`: `jobFailure` maps it to `answer_refused` rules.
- `apps/worker/src/step-store.ts`: `addUsage` (the summary's model must not replace the editor's).
- `apps/worker/src/doctor-checks.ts`, `doctor-checks.test.ts`: the `ai structured call` check
  prompt names the two fields; add an `ai summary call` check on the small model.
- `apps/studio/src/lib/step-words.ts`, `progress-overlay.ts`, `progress-overlay.test.ts`: the
  overlay's refused state.
- `apps/studio/test-support/ai-script.ts`: E2E answer scripts (drop the two fields and the
  `changeSummary`/`changeTitle` round options).
- `apps/studio/e2e/upload.spec.ts`, `change-requests.spec.ts`, `decide-behind.spec.ts`,
  `behind.spec.ts`: specs asserting `change_title`, `decide-7` or the round options.

### New Files

- `packages/edit/src/version-diff.ts`, `packages/edit/src/version-diff.test.ts`
- `packages/edit/src/version-summary.ts`, `packages/edit/src/version-summary.test.ts`
- `apps/worker/src/decide/summary.md` (the summary prompt)
- `apps/worker/src/decide/version-summary.ts`, `apps/worker/src/decide/version-summary.test.ts`

## Implementation Plan

### Phase 1: Foundation

The pure parts in `packages/edit`: the diff, the summary schema, the safeguard and the template, all
deterministic and unit-tested, with no platform API (the package rule). The model option on the AI
runner.

### Phase 2: Core Implementation

The worker's summary call (prompt, input, one call, fallbacks), the decide answer and prompt without
the two fields, the identical-edit refusal for requests, and the save path using the summary.

### Phase 3: Integration

The studio's overlay words for `no-change`, the doctor check, the E2E scripts and specs, the docs and
the profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. The structured diff (`packages/edit/src/version-diff.ts`)

- Export types `DiffKind = "title" | "accent" | "photo" | "big_word" | "transition" | "caption" |
"sound" | "footage"`, `DiffAction = "added" | "removed" | "moved" | "retimed" | "changed"`,
  `DiffEntry { kind; action; id; text?: string; photo_id?: string; spot?: { from?: string; to?:
string } }` and `EditDiff { items: DiffEntry[]; rules: RuleChange[] }` with
  `RuleChange { rule: "photos" | "big_word"; to: "off" | "on" }`.
- `diffEdits(before: Edit, after: Edit, transcript: Transcript, preset: Preset): DiffEntry[]`.
  Identity per kind (so the engine renumbering ids never reads as remove plus add):
  - title: the overlay with id `title`; accent: any other overlay, keyed by its `words` (joined),
    else its id; photo: the behind photo's `photo_id`; big word: the behind word's `text`;
    transition: its `type` plus its start anchor's word (else id); caption, sound, footage: id.
  - Per matched pair: `retimed` when `start` or `end` anchors differ; `moved` when a placement
    field differs (`spot`, `position`, size or area fields of the item: compare everything except
    anchors, `words`, `text`, `style` and ids; a `spot` change also fills `spot.from`/`spot.to`);
    `changed` when `text`, `type`, `sound` or `style` differ. A pair may give several entries, one
    per action, in that fixed order.
  - `text`: the plain words the item is over (`wordsText(words, transcript, preset)`) or the
    item's own text (big word, a fixed caption's new text); never a word id.
  - Captions: report only `changed` (a fixed word) per caption, and fold every caption `moved` or
    `retimed` into one entry `{ kind: "caption", action: "moved", id: "captions" }` so a new photo
    shifting captions does not flood the list.
  - Order: by kind in the `DiffKind` order above, then by the item's start in the transcript. Same
    inputs give the same output (deterministic, no `Map` iteration over unordered keys).
- `ruleChanges(before: BehindForbid, after: BehindForbid): RuleChange[]` (photos or big word
  switched `off` when a forbid is set, `on` when lifted).
- Identical edits (`canonicalJson` equal) give `[]`.
- Export from `packages/edit/src/index.ts`.
- `version-diff.test.ts` (node project): identical edit gives `[]`; a photo added; a photo removed;
  a photo whose spot changed is `moved` with `spot` from and to; an accent on new words is
  `removed` plus `added`; same words with new anchors is `retimed`; renumbered transition ids with
  the same type and start word give no entry; a caption text fix is one `changed` with the new text;
  many captions shifted give exactly one `captions moved` entry; no entry carries a `w\d{4}` id in
  `text`; `ruleChanges` both ways. Build fixtures from the existing edit test helpers in
  `packages/edit/src/test-support/` and `testdata/`.

### 2. Summary schema, safeguard and template (`packages/edit/src/version-summary.ts`)

- `summaryAnswerSchema`: `z.strictObject({ change_title: z.string().min(1).max(60),
change_summary: z.string().min(1).max(300) })`; `summaryJsonSchema()` with the same
  `z.toJSONSchema` options as `decideJsonSchema` (draft-07, `io: "output"`, inline);
  `parseSummaryAnswer(json)` returning `{ ok, answer } | { ok: false, reasons }` via `issueReasons`.
- `checkSummary(answer, diff: EditDiff, preset): { ok: true } | { ok: false; reasons: string[] }`:
  - Refuses a word id (`/\bw\d{3,}\b/i`), any digit followed by `s`, `sec`, `second`, `px`, `pt`,
    `%`, a time like `0:03`, a colour code (`#` plus hex), any font family name from the preset
    (`preset.fonts`), and internal names (`track`, `slot`, `preset`, `overlay`, `spot`).
  - Names: a fixed vocabulary per `DiffKind` (photo: photo, photos, picture, image; big word: big
    word, key word; title: title, heading, opening line; accent: accent, highlight, stands out,
    emphasis; transition: transition, fade, dim, cut; caption: caption, captions, spelling, word
    fixed, misheard; sound: sound, whoosh; footage: footage, clip, trimmed). Matching is case
    insensitive on whole words. Every kind the title or summary names must have at least one entry
    of that kind in `diff.items`; photos and big word also pass when the matching rule is in
    `diff.rules`. Reason per miss: `names a <kind> that is not in the saved difference`.
- `summaryTemplate(diff, record: EngineNote[], checklist: ChecklistOutcome[]): { title; summary }`:
  - Title (2 to 5 words, sentence case, no full stop): one kind changed gives `<Kind> <verb>`
    (`Photo added`, `Photo removed`, `Photo moved`, `Transitions changed`, `Words fixed`,
    `Captions adjusted`, `Photos switched off`); two kinds give `<Kind> and <kind> changed`; more
    give `Several things changed`; an empty diff gives `No changes`.
  - Summary: one plain sentence per kind (at most two sentences, the rest folded as `and a few
smaller changes`), using the item's quoted words where short (`A photo now shows behind you
while you say "the kitchen".`); then, when the record dropped an item the checklist linked
    (`done: false`), one sentence from the checklist reason (`The photo you asked for did not fit:
<reason>`), cut so the whole stays within 300 characters. Empty diff: `Nothing in the reel
changed.` Never a word id, number of seconds, font, size or spot name.
  - The template's own output always passes `checkSummary` (asserted in the test).
- Export from `index.ts`.
- `version-summary.test.ts`: the schema refuses extra keys, empty and over-long strings; the
  safeguard refuses a summary naming a dropped photo (the issue's case: diff with no photo entry,
  record `photo-1 dropped`, summary "A photo now shows behind you"); refuses `w0004`, `2.5 s`,
  `48px`, a preset font name; accepts a summary naming only kinds in the diff; accepts "Photos
  switched off" with a rule change and no item; the template's wording for one kind, two kinds,
  many kinds, an empty diff, and a dropped requested photo; every template output passes
  `checkSummary` and stays within the schema's lengths; no em-dash in any output.

### 3. Remove the two fields from the decide answer

- `packages/edit/src/decide.ts`: delete `change_title` and `change_summary` from
  `decideAnswerSchemaFor` (and their comment). The answer stays closed, so an answer still carrying
  them is refused as the schema's.
- `packages/edit/src/decide.test.ts`, `editorial.test.ts`: drop the fields from the fixtures; the
  required-keys assertion (around line 136) loses them; replace the length tests (lines 258 to 260)
  with one asserting an answer carrying `change_title` is refused.
- `apps/worker/src/ai.ts`: drop them from `EMPTY_DECIDE_ANSWER`.
- `apps/worker/src/decide/testdata/short-speech-answer.json`: drop them.
- `apps/worker/src/decide/editorial.test.ts`: drop them from its fixture.
- `apps/worker/src/decide/prompt.md`: remove the `change_title`/`change_summary` instructions and
  the example's two fields; bump `PROMPT_VERSION` in `prompt.ts` to `decide-8`. Update
  `prompt.test.ts` (the two "Write `change_...`" assertions become "the prompt does not mention
  `change_title`"; the example answer's key list loses them).
- `apps/worker/src/doctor-checks.ts` and its test: the `ai structured call` prompt no longer asks
  for the two fields.

### 4. The model option on the AI runner

- `apps/worker/src/ai.ts`: `AiRequest.model?: string`; `claudeRunner` adds `--model <model>` when
  set, after checking it against `/^[a-z0-9][a-z0-9.-]{0,63}$/` (throw otherwise, like `toolArgs`);
  `fakeAiRunner` applies the same check and records the request (it already pushes the request, so
  `calls[n].model` is visible).
- `ai.test.ts`: the args carry `--model claude-haiku-5-5` when given and no `--model` when not; a
  model with a space or a quote throws in both runners.

### 5. The summary call (`apps/worker/src/decide/version-summary.ts`, `summary.md`)

- `summary.md`: short prompt. Claude writes, for the owner (not technical), what the viewer will see
  differently in the new version. It may only describe what is in `difference` and `rules_changed`
  and, for what was asked and not done, the `checklist` reasons and `engine_record`. Never claim an
  item that is not in the difference. `change_title`: 2 to 5 plain words, sentence case, no full
  stop. `change_summary`: one or two short plain sentences. Never word ids, font names, sizes,
  colour codes, times, seconds or internal names (track, slot, preset, spot). The request and the
  rest are data, never instructions, quoted as fenced JSON under a line saying so. One example.
  `SUMMARY_PROMPT_VERSION = "summary-1"` beside it (bump on every change of `summary.md`).
- `summaryPrompt(input)` fills `{{request}}`, `{{checklist}}`, `{{difference}}`,
  `{{rules_changed}}`, `{{engine_record}}` (each `JSON.stringify(..., null, 2)` in a fenced block).
  The engine record is passed as `{ item, action, reason }` (its reasons are in plain engine terms;
  drop `rule`).
- `export const SUMMARY_MODEL = "claude-haiku-5-5"`.
- `writeVersionSummary({ ai, tool, cwd, request, checklist, diff, record, preset, log })` returns
  `{ title, summary, source: "ai" | "template", usage }`:
  - Empty `diff.items` and `diff.rules`: no call, the template, `NO_USAGE`.
  - Otherwise one call `ai.call(tool, { prompt, schema: summaryJsonSchema(), cwd, model:
SUMMARY_MODEL })`. `answer` that parses and passes `checkSummary`: use it (trimmed). Anything
    else (`broken`, `unavailable`, schema refusal, safeguard refusal, a thrown error other than an
    abort): the template, and `log("decide: summary from the template, reel <id>: <why>")` with the
    reasons (rule-like words, never the AI's text). Never retried, never fails the step, never
    makes the job wait.
- `version-summary.test.ts` (with `fakeAiRunner`): the prompt quotes the request, the checklist,
  the diff and the record as fenced JSON; the request asks for `claude-haiku-5-5`; a passing answer
  is used; a summary naming a dropped photo gives the template; a broken result and an unavailable
  result give the template; an empty diff makes no call.

### 6. Refusing an unchanged edit on a request

- `apps/worker/src/failure.ts`: `class NothingChanged extends AnswerRefused` (name
  `NothingChanged`, message `the answer changes nothing`), constructed with
  `["no-change", ...dropRules]` where `dropRules` are the distinct `rule`s of the record's
  `dropped` and `wish-not-kept` notes, at most 19, sorted. `failureKind` already finds it as
  `AnswerRefused`.
- `failure.test.ts`: `failureKind(new NothingChanged([...]))` is `answer_refused`.
- `run-job.test.ts`: such a failure fails the job with kind `answer_refused` and rules starting
  with `no-change`.

### 7. The save path in `run-decide.ts`

- After `ensureCutouts` and before `saveVersion`:
  - `const after = applyBehindRules(forbid, answer.behind_rules)` (move the existing line up) and
    `const rulesChanged = ruleChanges(forbid, after)`.
  - When `request !== null` and `editBytes(edit)` equals the current blob `bytes` (byte compare)
    and `rulesChanged` is empty: throw a `StepError` whose tail is `decide: nothing would change,
version <n> stays current` followed by each not-done checklist entry's `ask: reason` (at most 8
    lines), with the usage so far, `{ cause: new NothingChanged(rules, attempts) }` (`attempts` 1
    or 2). Nothing is written to R2 or `versions`. The automatic run (request null) is not a change
    and still saves (as today, the E2E's version 2 equal to version 1).
  - `const diff = { items: diffEdits(current, edit, transcript, preset), rules: rulesChanged }`.
  - `const summary = await writeVersionSummary({ ..., request, checklist: checklistOutcome(...),
diff, record })`; compute the checklist outcome once and reuse it for the save.
  - Usage: add the summary call's tokens and cost to the step's usage, but not its model
    (`addUsage(usage, { ...summary.usage, model: null })`), so `steps.ai_model` and
    `versions.model` stay the editor's model.
  - `saveVersion` takes `changeTitle: summary.title`, `changeSummary: summary.summary`.
- `run-decide.test.ts`:
  - The existing pass test: the fake script is `[decideEnvelope, summaryEnvelope]`; assert
    `ai.calls[1].model === "claude-haiku-5-5"`, its prompt contains the diff entries (for example
    `"kind": "title"` and `"action": "added"`) and the engine record's `accent-1` drop, and the
    saved row's `change_title`/`change_summary` are the summary envelope's (replace the line 170
    reads of the decide answer's fields).
  - A summary envelope naming a photo while the record dropped it: the saved title is the
    template's.
  - A summary call returning the decide envelope (the E2E case: script of one envelope): the
    template, and the step still succeeds.
  - "saves exactly version 1's bytes for an answer with no choices": unchanged for the automatic
    run; also assert only one AI call was made (empty diff, no summary call) and the title is
    `No changes`.
  - New: the same no-choice answer with a request: the step throws, the cause is `NothingChanged`
    with rules starting `no-change`, `rows.save` and `blobs.putIfAbsent` were never called for a
    version key.
  - New: a request whose answer only sets `behind_rules.photos: "forbid"` on a reel without photos
    saves a version (rule change) titled from the summary or the template `Photos switched off`.
  - Re-derive the token sums in the existing usage assertions (the summary call adds its tokens).

### 8. Studio overlay words

- `apps/studio/src/lib/step-words.ts`: `RULE_WORDS` gains `"no-change": "your reel would look the
same"`, `"no-room": "there was no free room on screen"`, `"one-extra": "something else already
shows at that moment"`, `"hidden-footage": "that part of the clip is cut"`, `wish: "the place you
asked for was taken"`, `"make-room": "there was no room even after making space"`.
- `apps/studio/src/lib/progress-overlay.ts` `failureState`: when the refused job's
  `failure_rules` include `no-change`, the headline is `Nothing changed` (else as today). Actions
  stay Change the request and Keep the current version.
- `progress-overlay.test.ts`: a failed change job with rules `["no-change", "no-room"]` gives the
  headline `Nothing changed`, the reason `Your reel would look the same and there was no free room
on screen`, actions `change_request`, `keep_current`.

### 9. Doctor check for the small model

- `apps/worker/src/doctor-checks.ts`: an `ai summary call` check sending `summaryJsonSchema()` with
  `model: SUMMARY_MODEL` through `plainTool` (a two-line sample diff), passing when the answer
  parses with `parseSummaryAnswer`, so an unknown model id or a refused schema shows in `doctor`.
  Under the double it accepts a scripted summary envelope like the existing check.
- `doctor-checks.test.ts`: the check passes on a summary envelope and fails on a broken one, and
  sends `--model claude-haiku-5-5`.

### 10. E2E scripts and specs (the studio suite)

- `apps/studio/test-support/ai-script.ts`: drop `change_title`/`change_summary` from
  `unchangedAnswerScript` and `roundEnvelope`; remove `changeSummary`/`changeTitle` from
  `AnswerRound` and every caller (`behind.spec.ts`, `decide-behind.spec.ts`). With one decide
  envelope repeating, the summary call gets a decide answer and falls back to the template: the
  specs assert the template's text, which is deterministic.
- `apps/studio/e2e/upload.spec.ts`: version 2's `change_title` and `change_summary` are the
  template's for its diff (derive the exact strings from `summaryTemplate` on the run, for example
  title added, transition added, word fixed gives `Several things changed`), `prompt_version`
  `decide-8`, the `ai_*` tokens and cost include the second call (re-derive), `ai_model` still
  `claude-opus-5-5`.
- `apps/studio/e2e/change-requests.spec.ts`:
  - v3's stored and shown title becomes the template's (replace `"Title and one accent added"`),
    and `What changed` shows the template summary.
  - New test (fails without the feature): on a processed reel seeded with the unchanged answer,
    send a change scripted with `unchangedAnswerScript`; after the worker's `once` no version 3
    exists, the current version is unchanged, the job is `failed` with `failure_kind`
    `answer_refused` and `failure_rules` starting with `no-change`, the reel stays `processed`, and
    the overlay shows `Nothing changed` with `Your reel would look the same`, Change the request
    and Keep the current version, no Try again.
- `apps/studio/e2e/decide-behind.spec.ts`: the later change's passing retry must differ from
  version 3 now (an identical retry would save nothing): make that round change a visible item (for
  example `transitions: []` through a new `AnswerRound.transitions` option), and assert version 4's
  title is the template's (`Transition removed`), the flag kept.
- `apps/studio/e2e/behind.spec.ts`: version 3's title is the template's (`Photo added`), never the
  scripted text.

### 11. Documentation and profile

- `app_docs/decide-step.md`: the answer example and field list without the two fields (`decide-8`);
  a new "Version title and summary" section (diff, summary call on `claude-haiku-5-5`, inputs,
  safeguard, template, fallbacks, usage added without the model, `SUMMARY_PROMPT_VERSION`); the
  `runDecide` paragraph's save order; Failure gains the unchanged request; Testing names the new
  tests; Rules: replace the prompt-keeps-plain-words line with: "The version summary describes only
  the saved difference: every item it names is in the difference, else the template replaces it",
  "The summary call is one call, never retried, never fails the step or makes the job wait",
  "Never print a word id, font, size or time in a title or summary", "A request whose edit is
  identical to the current version saves nothing; the owner is told why", "Bump
  `SUMMARY_PROMPT_VERSION` whenever `summary.md` changes". Add the issue's spec to Specifications.
- `app_docs/change-requests.md`: Texts line (written after layout from the difference, not by the
  decide answer); replace the Notes line about no edit with the `Nothing changed` overlay; Rules
  section with "the summary describes only the saved difference" and "an unchanged edit is never
  saved as a change".
- `app_docs/edit-model.md`: `version-diff.ts` and `version-summary.ts` in the package overview.
- `app_docs/status.md` and `app_docs/failures.md`: `no-change` and the `Nothing changed` headline.
- `docs/conditional-docs.md`: the `decide-step.md` line adds the summary call, the version diff and
  `summary.md`; the `change-requests.md` line adds unchanged requests.
- `.adw/project.md` Tests section: the `change-requests.spec.ts` sentence adds "an unchanged change
  saves nothing and the overlay says `Nothing changed`"; nothing else in the profile changes (no
  script, port or env file).

### 12. Run the validation commands

- Run every command in `Validation Commands` below and fix every failure without weakening a check.

## Testing Strategy

### Unit Tests

- `packages/edit/src/version-diff.test.ts`: the diff per kind and action, identity across renumbered
  ids, captions folded, identical edits empty, rule changes.
- `packages/edit/src/version-summary.test.ts`: schema, safeguard (dropped photo, ids, times, fonts,
  internal names), template wording and lengths, template output passing the safeguard.
- `packages/edit/src/decide.test.ts`: the answer refuses `change_title`.
- `apps/worker/src/ai.test.ts`: `--model`.
- `apps/worker/src/decide/version-summary.test.ts`: prompt contents, model, fallbacks, no call on an
  empty diff.
- `apps/worker/src/decide/run-decide.test.ts`: summary call receives diff and record; template on a
  dishonest summary; unchanged request saves nothing; rule-only change saves.
- `apps/worker/src/failure.test.ts`, `run-job.test.ts`: `NothingChanged` as `answer_refused`.
- `apps/studio/src/lib/progress-overlay.test.ts`: the `Nothing changed` state.
- `apps/worker/src/doctor-checks.test.ts`: the summary check.

### Test Coverage

- `version-diff.test.ts` (unit, `packages/edit`): catches a diff that reports renumbered items as
  changes or misses a dropped photo; no diff exists today.
- `version-summary.test.ts` (unit, `packages/edit`): catches a summary naming a photo the saved edit
  does not have reaching the owner (the 2026-11-03 v4 bug); fails today, no safeguard exists.
- `run-decide.test.ts` (unit, worker): catches the version saved with the decide answer's
  intention instead of the summary call's text, and an identical edit saved as a change; both fail
  today.
- `version-summary.test.ts` (unit, worker) and `ai.test.ts`: catch the summary call running on the
  editor's model or without the diff and record.
- `progress-overlay.test.ts` (unit, studio): catches an unchanged change shown as `Could not finish
styling` with no reason.
- `change-requests.spec.ts` new test (E2E, studio): catches an identical change saved as version 3
  or the owner not told; fails today (today a version 3 is saved).
- The DB layer needs no new test: no migration, no new column or policy (`failure_rules` already
  takes any rule name; `failure-and-size-columns.test.ts` covers it).

### Edge Cases

- Engine renumbers `photo-1`/`transition-1` between versions: no spurious added plus removed.
- A photo whose spot moved: `moved`, the summary may say it moved, not that it was added.
- The answer asked for a photo the engine dropped: diff has no photo, the summary may not claim it;
  the template says it did not fit, with the checklist reason.
- A request that only switches photos off on a reel with none: the edit is identical but a rule
  changed, so a version is saved (`Photos switched off`).
- Automatic run with no choices: saved (not a change), no summary call, title `No changes`.
- Summary call unavailable (usage limit) or broken: template, the step succeeds, the job never waits
  for the summary.
- Summary answer with a word id, a time, a font name, or over 300 characters: template.
- The E2E double replaying a decide envelope to the summary call: template, deterministic.
- A cancelled job during the summary call: the abort still ends the step (the summary helper
  rethrows an abort, `ctx.signal.throwIfAborted()` after it).
- Old versions keep their stored titles and summaries; nothing rewrites them.

## Acceptance Criteria

- The decide answer schema has no `change_title` or `change_summary`; an answer carrying one is
  refused; `PROMPT_VERSION` is `decide-8`.
- Every decided version's `change_title` and `change_summary` come from the summary call on
  `claude-haiku-5-5` or the template, written after layout from the diff, the record and the
  checklist.
- A summary naming an item kind absent from the diff, or containing a word id, font, size or time,
  is replaced by the template.
- A change request whose edit equals the current version's bytes and changes no rule saves no
  version, fails the job as `answer_refused` with `no-change` first in `failure_rules`, keeps the
  reel `processed`, and the overlay shows `Nothing changed` with a plain reason.
- The summary call never fails the step, never retries, never makes the job wait; its tokens and
  cost are in the step's `ai_*` columns, its model is not.
- No em-dash in any changed file; no AI attribution anywhere.
- Lint, typecheck, knip, format, unit, build, `test:db` and E2E green.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - formatting over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio --filter=...{./packages/edit}` - lint of every touched workspace and the edit package's dependents.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio --filter=...{./packages/edit}` - types, including the removed answer fields at every caller.
- `yarn knip` - no dead export left by the removed fields or the new modules.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio --filter=...{./packages/edit}` - the unit layers (diff, summary, run-decide, overlay) and the edit package's browser goldens.
- `yarn workspace @edit-issebya/worker test:tools` - the worker is a target; the real-tool tests on the owner's Mac.
- `yarn turbo run test:db --filter=./apps/studio` - DB layer unchanged but run after unit as the profile orders.
- `yarn turbo run build --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit` - build check (typecheck for the worker and the package, `next build` for the studio).
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - the E2E suites against the run's `/prepare_app` servers (`upload`, `change-requests`, `behind`, `decide-behind` specs exercise the change).

## Notes

- No new dependency, no migration, no new environment variable.
- The identical-edit rule applies to change requests only: the automatic decide after version 1 is
  not a change, and `preview.spec.ts` and the seeded reels rely on its version 2 equal to version 1.
  If the owner wants the automatic run to skip an identical version too, that is a follow-up
  touching every seeded spec's version numbers.
- The safeguard works on item kinds (a fixed vocabulary), not on full meaning: a summary saying
  "photo added" when the diff has only a photo `moved` passes the kind check. A follow-up could
  compare the verb with the action per kind; the template stays the safe fallback.
- The summary prompt has its own version (`SUMMARY_PROMPT_VERSION`) logged with the template line;
  it is not stored on the row (`versions.prompt_version` stays the editor's). Storing it would need
  a migration; out of scope.
- The haiku model id `claude-haiku-5-5` is a constant (`SUMMARY_MODEL`); the doctor's new check
  shows an id the installed CLI rejects before a real run does.
- Commits: Conventional Commits, no trailers, no em-dashes.
