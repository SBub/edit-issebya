# Feature: decide step (Claude Code with a per-reel JSON Schema, layout checks with one retry, version records)

## Metadata

issue_number: `33`
adw_id: `b632a861`
issue_json: `{"number":33,"title":"feat: decide step: Claude Code with a per-reel JSON Schema, layout checks with one retry, version records"}`

## Feature Description

Slice 10 of the reel studio MVP adds the pipeline's one AI step, `decide`. After the fixed pipeline
steps and the automatic version 1, the worker asks Claude Code (`claude -p`, on the owner's
machine, no tools) to start from the current version and fix misheard words, choose accent words,
transitions and a title. The answer must match a JSON Schema generated for this reel (word-id enums
from its own transcript, times capped at its clip's end, fonts and transition types from the
preset, positions inside the preset's safe box). The worker validates the answer again with Zod,
builds it with the HarfBuzz builder, runs the layout checks and a glossary post-check. A failed
attempt (broken JSON, a schema refusal, a failed check) goes back to the AI once with the reasons;
a second failure fails the step with both rounds' reasons in `error_tail` and leaves the reel's
current version untouched. A passing answer becomes a new version (version 2 on a fresh reel) whose
row records the parent, request, model, prompt version, change summary, checks, inputs, whether
the free style field was used and what the format could not express. The step row carries the
tokens, cost and model Claude Code reported.

## User Story

As the studio owner
I want every processed reel to come out with an AI-decided version that already has fixed words,
accents, transitions and a title, and that never breaks the layout rules
So that I start from a near-finished edit, can see what each AI version cost and how it was made,
and never lose a working version to a bad answer.

## Problem Statement

Today a processed reel stops at the automatic version 1 (captions only, from the preset). The AI
runner exists only as a doctor check (`apps/worker/src/ai.ts`), it reports no usage, runs outside
the measuring step runner, passes the prompt as an argument and has no tools switched off. There
is no per-reel answer schema (the existing `editSchemaFor` allows any time and any frame position),
no glossary post-check, no retry, and the `versions` table cannot record the free-field use or the
requests the format could not express.

## Solution Statement

1. `packages/edit` gets `src/decide.ts`: the decide answer's Zod schema built per reel
   (`decideAnswerSchemaFor(preset, transcript, duration)`), its JSON Schema
   (`decideJsonSchema(...)`, Zod 4 `z.toJSONSchema`, enums as real `enum` lists), the composition of
   an answer with the current version into a full edit (`editFromAnswer`), and the step line counts
   (`decideCounts`). `src/glossary.ts` adds `glossaryChecks` (rule `glossary`). `editSchemaFor`
   gains an optional `{ duration, bounds }` so the same item schemas carry the decide limits while
   stored versions keep parsing with the default (frame) limits.
2. The answer format is **tracks only** plus three short fields: `{ tracks, change_summary,
unexpressed: string[], free_field: { item, reason }[] }`. `format`, `preset`, `duration` and
   `inputs` are fixed and come from the current version, so the result is always a full edit and
   the AI cannot touch the input fingerprints.
3. `apps/worker/src/ai.ts` becomes the AI runner the step uses: `AiRunner.call(tool, request)`
   runs Claude Code through the step runner's `Tool` (so it is measured like every other tool),
   with `-p --output-format json --json-schema <schema> --tools "" --no-session-persistence`, the
   prompt on stdin, the job's scratch folder as cwd, and returns `{ answer | broken, usage }` from
   one parser, `parseClaudeResult`, unit-tested on a committed real result. The fake
   (`E2E_MOCK_AI=true`) replays scripted Claude results from `E2E_MOCK_AI_SCRIPT` (a JSON file)
   through the same parser.
4. `apps/worker/src/decide/`: the committed prompt (`prompt.md`), `PROMPT_VERSION`, the prompt
   input (current edit, transcript with ids, head-track summary, preset with glossary, request),
   and `runDecide`, the step: at most two calls, never a loop.
5. A migration adds `used_free_field`, `unexpressed`, `free_field` and `rejected_reasons` to
   `versions` and replaces `save_version` with a signature that takes them (defaults keep every
   existing caller valid). The step row's `ai_*` columns are written through `StepMeasurements`.
6. `processJob` runs decide after `saveFirstVersion`; decide is never cached.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: repository rules (Yarn only, no em-dashes, migration
  rules, the ADW stack is reset only through `.adw/supabase-stack reset`, profile kept in step).
- `docs/conditional-docs.md`: the index; gets one line for the new doc.
- `app_docs/edit-model.md`: the edit format, preset, builder, checks, versions and `save_version`
  (this change adds exports, a check rule, version columns and a new `save_version` signature, so
  the doc is updated in place).
- `app_docs/measurement.md`: the step runner and the `ai_*` columns (now written by decide).
- `app_docs/studio.md`: worker variables and the AI double (`E2E_MOCK_AI`, new `E2E_MOCK_AI_SCRIPT`).
- `app_docs/pipeline.md`: the pipeline steps and fingerprints (decide runs after them, never cached).
- `app_docs/adw-supabase-stack.md`: how a run applies a new migration (`.adw/supabase-stack reset`).
- `packages/edit/src/schema.ts`: `editSchemaFor`, `parseEdit`; refactor so item schemas take decide
  limits (time max, safe-box positions) and the tracks object is reusable without the refinement.
- `packages/edit/src/preset.ts`: `ISSEBYA_PRESET` (safe box, fonts, transitions, glossary, `cleanWord`).
- `packages/edit/src/layout.ts`: `wordsText` (the default caption text, glossary-aware); exported for
  the glossary check and the "words fixed" count.
- `packages/edit/src/checks.ts`: `Check`, `CheckRule` (add `"glossary"`), `runChecks`.
- `packages/edit/src/build.ts`: `build(...) -> { checks }` used by decide.
- `packages/edit/src/versions.ts`: `NewVersion`, `VersionMeta`, `saveVersion`, `restoreVersion` (new
  fields).
- `packages/edit/src/index.ts`: public exports.
- `packages/edit/src/schema.test.ts`, `packages/edit/src/versions.test.ts`,
  `packages/edit/src/test-support/fixtures.ts`, `packages/edit/src/testdata/versions/`: existing
  tests and fixtures to reuse (the short-speech baseline is version 1 over `fixtures/pipeline/`).
- `apps/worker/src/ai.ts`, `apps/worker/src/ai.test.ts`: the AI runner, the fake, the parser.
- `apps/worker/src/doctor-checks.ts`, `apps/worker/src/doctor.ts`, `apps/worker/src/doctor-checks.test.ts`:
  the doctor's `ai structured call` check, moved to the new runner interface.
- `apps/worker/src/step-runner.ts`: `runToolsStep`, `ToolCall`, `runChild` (needs stdin, a larger
  stdout cap for one call, AI measurements and an explicit failure tail).
- `apps/worker/src/step-store.ts`: `StepMeasurements` (gains the optional `ai_*` fields),
  `supabaseStepStore` (`done`/`failed` already spread measurements).
- `apps/worker/src/errors.ts`, `apps/worker/src/summary.ts`: `errorTail`, `outputTail`, `stepSummary`.
- `apps/worker/src/first-version.ts`, `apps/worker/src/first-version.test.ts`: the pattern to follow
  (reading inputs by fingerprint, saving a version, memory rows in tests).
- `apps/worker/src/process-job.ts`: wires decide after the first version.
- `apps/worker/src/version-store.ts`: `supabaseVersionRows` (reads `current`, saves through the RPC
  with the new parameters).
- `apps/worker/src/recording-steps.ts`: the recording `StepStore` and `stepContext` for unit tests.
- `apps/worker/src/config.ts`: `scratchDir`.
- `apps/worker/.env.example`: documents `E2E_MOCK_AI` (add `E2E_MOCK_AI_SCRIPT`).
- `supabase/migrations/20261101153653_versions.sql`: the current `versions` table and `save_version`.
- `apps/studio/db-tests/versions.test.ts`: `save_version` tests (extend for the new columns).
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` (sets `E2E_MOCK_AI=true`).
- `apps/studio/test-support/pipeline-cache.ts`: `seedProcessedReel` (now ends at the AI's version 2).
- `apps/studio/test-support/versions.ts`: `saveTestVersion` (RPC call; defaults keep it valid).
- `apps/studio/e2e/upload.spec.ts`: the processing spec to extend with the decide line and rows.
- `apps/studio/e2e/preview.spec.ts`: compares the preview build with the version 1 golden; must keep
  passing when the current version is the AI's.
- `apps/studio/src/components/LiveReel.tsx`: renders `step-line` as `name: summary` (no change needed).
- `turbo.json`: `E2E_MOCK_*` and `CLAUDE_CODE_PATH` are already passed through.
- `knip.json`: worker and edit workspaces (new files are imported, so no change expected).
- `node_modules/zod/` (v4.6.7): check `z.toJSONSchema` options (`target`, `io`, `reused`) and how it
  emits `enum`, `additionalProperties` and optional properties before relying on them.

### New Files

- `packages/edit/src/decide.ts`: answer schema, JSON Schema, `editFromAnswer`, `decideCounts`.
- `packages/edit/src/decide.test.ts`: verification 1 (per-reel schema) and the composition/counts.
- `packages/edit/src/glossary.ts`: `glossaryChecks`.
- `packages/edit/src/glossary.test.ts`: verification 6.
- `apps/worker/src/decide/prompt.md`: the committed prompt.
- `apps/worker/src/decide/prompt.ts`: `PROMPT_VERSION`, `decidePrompt(input, previousReasons?)`.
- `apps/worker/src/decide/input.ts`: `headTrackSummary`, `presetSummary`, `decideInput`.
- `apps/worker/src/decide/run-decide.ts`: the step.
- `apps/worker/src/decide/run-decide.test.ts`: verifications 2 to 5, step line, no write on failure.
- `apps/worker/src/decide/prompt.test.ts`: the prompt carries every input and the retry reasons.
- `apps/worker/src/decide/testdata/claude-result.json`: one real `claude -p --output-format json
--json-schema` result, sanitised (verification 7).
- `apps/worker/src/decide/testdata/short-speech-answer.json`: the scripted E2E answer for the
  fixture clip (a Claude result envelope with `structured_output`), proven to pass the checks by a
  unit test.
- `supabase/migrations/<stamp>_version_decide_records.sql`: created with
  `supabase migration new version_decide_records`.
- `app_docs/decide-step.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

- Migration for the version records and the new `save_version`.
- `packages/edit`: limits on `editSchemaFor`, the decide answer schema and its JSON Schema, the
  glossary check, exported default caption text, new version fields.
- Step runner: stdin, per-call stdout cap, AI measurements, explicit failure tail.
- Capture one real Claude Code result and commit it sanitised.

### Phase 2: Core Implementation

- New AI runner interface, parser on the real shape, scripted fake from a file.
- Prompt, `PROMPT_VERSION`, prompt input.
- `runDecide`: call, validate, build, check, one retry, save or fail.

### Phase 3: Integration

- `processJob` runs decide after the first version; the doctor uses the new runner.
- Studio test support passes an AI script; upload spec asserts the decide line, version 2 and the
  AI columns; preview spec keeps its golden by scripting an unchanged answer.
- DB test for the new columns; docs and profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/edit-model.md`, `app_docs/measurement.md`, `app_docs/studio.md`,
  `app_docs/pipeline.md` and `app_docs/adw-supabase-stack.md` in full; their Rules sections are
  invariants (never change a version, put-if-absent keys, only the service role runs
  `save_version`, nothing platform-specific in `packages/edit`, raw AI numbers only).
- Read Zod 4's `toJSONSchema` in `node_modules/zod` (or its docs bundled there) and confirm: `z.enum`
  becomes `{ "enum": [...] }`; which option makes objects `additionalProperties: false`; how
  `.optional()` maps to `required`; that `superRefine` is dropped rather than throwing. Use
  `io: "output"` (or whatever yields `additionalProperties: false` on every object) and
  `target: "draft-2020-12"`; keep refs inlined unless a test proves Claude Code accepts `$defs`.

### 2. Migration: version decide records

- `supabase migration new version_decide_records` (never hand-pick the version).
- In it:
  - `alter table public.versions add column used_free_field boolean not null default false,
add column unexpressed jsonb not null default '[]'::jsonb check (jsonb_typeof(unexpressed) = 'array'),
add column free_field jsonb not null default '[]'::jsonb check (jsonb_typeof(free_field) = 'array'),
add column rejected_reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(rejected_reasons) = 'array');`
    with comments: `unexpressed` is the requests the format could not express, `free_field` the
    items that needed the `style` field and why, `rejected_reasons` the reasons the first answer was
    refused when a retry was needed (empty when the first answer passed).
  - `drop function public.save_version(uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text);`
    then `create function public.save_version(` the same eleven parameters plus
    `p_used_free_field boolean default false, p_unexpressed jsonb default '[]'::jsonb,
p_free_field jsonb default '[]'::jsonb, p_rejected_reasons jsonb default '[]'::jsonb)` with
    the same body (lock, stale-parent refusal, next number, insert, set current) inserting the new
    columns (`coalesce` each jsonb to `'[]'`). Same `security definer`, `set search_path = ''`.
  - Revoke execute from `public, anon, authenticated` and grant to `service_role` on the new
    signature. End with `notify pgrst, 'reload schema';`.
- Never edit `20261101153653_versions.sql`.

### 3. `packages/edit`: schema limits and the decide answer

- `src/schema.ts`: add an optional third argument to `editSchemaFor(preset, transcript, limits?)`,
  `limits: { duration?: number; bounds?: Box }`. When `duration` is set, `{ time }` anchors get
  `.max(duration)`; when `bounds` is set, `position.x` is `min(bounds.left).max(bounds.right)` and
  `position.y` `min(bounds.top).max(bounds.bottom)`. Without limits, behaviour and every stored
  fixture are unchanged. Factor the tracks object out (`tracksSchemaFor(preset, transcript, limits)`,
  internal or exported) and the refinement into a reusable function, so the decide answer can embed
  the tracks without the refinement (JSON-Schema-safe) and the composed edit is re-checked with it.
- `src/layout.ts`: export `wordsText` (rename to `captionWordsText` if clearer) and export it from
  `src/index.ts`.
- `src/checks.ts`: add `"glossary"` to `CheckRule`.
- `src/glossary.ts`: `glossaryChecks(edit, transcript, preset): Check[]`: for every caption and
  overlay, the text it shows (`item.text ?? wordsText(item.words)`, overlays without words use
  `text`), lower-cased and cleaned word by word; for each glossary term, each heard form appearing
  as a run of whole words in that text is a failure `{ rule: "glossary", item: id, reason:
"caption cw0003 shows \"Locking\": write the glossary term \"lock-in\"" }`. The term itself never
  fails. Pure, no platform API.
- `src/decide.ts`:
  - `decideAnswerSchemaFor(preset, transcript, duration)`: `z.object({ tracks:
tracksSchemaFor(preset, transcript, { duration, bounds: preset.safe }), change_summary:
z.string().min(1).max(300), unexpressed: z.array(z.string().min(1).max(300)).max(20),
free_field: z.array(z.object({ item: z.string().regex(ITEM_ID), reason:
z.string().min(1).max(300) })).max(20) })`.
  - `decideJsonSchema(preset, transcript, duration): object`: `z.toJSONSchema` of the above with the
    options found in step 1.
  - `editFromAnswer(current: Edit, answer, preset, transcript)`:
    `{ ok: true, edit } | { ok: false, reasons }`: composes `{ format: 1, preset: preset.id,
duration: current.duration, inputs: current.inputs, tracks: answer.tracks }` and parses it with
    `editSchemaFor(preset, transcript, { duration: current.duration, bounds: preset.safe })` (the
    Zod check again, plus the refinement: duplicate ids, end before start, overlay without words or
    text), returning `parseEdit`-style reasons.
  - `parseDecideAnswer(json, preset, transcript, duration)`: `safeParse` with readable reasons
    (reuse the path/item formatting of `parseEdit`; export a shared helper from `schema.ts`).
  - `decideCounts(edit, transcript, preset)`: `{ accents, transitions, title, wordsFixed }`:
    accents = overlays whose id is not `title`; transitions = `tracks.transitions.length`; title =
    an overlay with id `title` exists; wordsFixed = captions whose `text` is set and differs from
    `wordsText(caption.words)`.
  - `usedFreeField(edit)`: any item (any track, including `hidden` clips' items) with a non-empty
    `style`.
  - Convention (documented in the prompt and the doc): the title is the overlay with id `title`,
    anchored at `{ reel: "start" }`.
- `src/versions.ts`: `NewVersion` gains `used_free_field: boolean; unexpressed: string[];
free_field: { item: string; reason: string }[]; rejected_reasons: string[]`; `VersionMeta` gains
  the same as optional camelCase fields (`usedFreeField`, `unexpressed`, `freeField`,
  `rejectedReasons`) defaulting to `false`/`[]` in `saveBytes`; `restoreVersion` passes the defaults.
- `src/index.ts`: export the new functions and types.
- Tests:
  - `src/decide.test.ts` (verification 1) over the `rethink-work-hand` fixture (and short-speech):
    the generated JSON Schema's word-id enum (find it by walking the schema for an `enum` under a
    `word` property) equals `transcript.words.map(w => w.id)` exactly; the font enum equals
    `FONT_KEYS`; the transition `type` enum equals `TRANSITION_TYPES`; every object in the schema
    has `additionalProperties: false`; the `time` maximum equals the duration. Then
    `parseDecideAnswer` refuses an answer using an id from the other fixture's transcript (pick an
    id absent from this one), a `{ time }` past the duration, a font `"comic-sans"`, and a
    position `x: 900`; and accepts the hand fixture's tracks as an answer. `editFromAnswer` keeps the
    current version's `inputs` and `duration` and refuses a duplicate id. `decideCounts` on a
    crafted edit returns the expected four numbers.
  - `src/glossary.test.ts` (verification 6): a caption with `text: "Locking"` over words heard as
    `locking` fails with rule `glossary`; `text: "lock-in"` passes; a caption without `text` whose
    words are `lock`, `in` passes (the default text is the term); an accent overlay with `text:
"lock in"` fails.
  - `src/schema.test.ts`: without limits, a position at x 900 is still accepted (stored versions
    keep parsing); with `bounds: preset.safe` it is refused.
  - `src/versions.test.ts`: the saved row carries the new fields (defaults when not given), and a
    restore writes the defaults.

### 4. Step runner: stdin, stdout cap, AI measurements, explicit tail

- `apps/worker/src/step-store.ts`: `StepMeasurements` gains optional `ai_input_tokens?: number |
null; ai_output_tokens?: number | null; ai_cost_usd?: number | null; ai_model?: string | null`
  (optional, so every existing step and test is unchanged; `done`/`failed` already spread them).
- `apps/worker/src/step-runner.ts`:
  - `ToolCall` gains `stdin?: string` and `maxStdoutBytes?: number`. In `runChild`, when `stdin`
    is set use `"pipe"` for fd 0, write it and end the stream (handle `EPIPE` without crashing);
    otherwise keep `"ignore"`. The `stdout` field is capped at `maxStdoutBytes ?? OUTPUT_CAP`;
    `output` (for the tail and logs) stays capped at 64 KB.
  - `ToolsStep.work` may return `{ what, ai?: AiUsage }` where
    `AiUsage = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
model: string | null }` (define it in `step-store.ts` or `ai.ts`, imported by the runner). The
    runner writes them as the `ai_*` measurements on success.
  - Export `class StepError extends Error` with `tail: string` and optional `ai?: AiUsage`. In
    `runToolsStep`'s catch, a `StepError` becomes the `StepFailure` with `outputTail(error.tail)`
    (not `errorTail(error)`, whose stack frames would push the reasons out) and its `ai` usage in
    the measurements, so a failed decide still records what it cost.
  - Extend `step-runner.test.ts`: a fake `SpawnTool` sees `stdin` and `maxStdoutBytes`; a real
    child (`/bin/cat`) echoes its stdin as stdout; a `work` returning `ai` lands in `done`'s
    measurements; a thrown `StepError` puts its tail and `ai` into `failed`.

### 5. Capture one real Claude Code result (outside the tests)

- On the worker machine, once, by hand (never from a test, never in CI):
  `printf 'Reply with ok set to true.' | "${CLAUDE_CODE_PATH:-claude}" -p --output-format json
--json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}'
--tools "" --no-session-persistence > /tmp/claude-result.json`.
- Sanitise: replace `session_id`, `uuid` and any id with fixed placeholders
  (`00000000-0000-0000-0000-000000000000`), keep every key and number as captured (usage,
  `total_cost_usd`, `modelUsage`, `structured_output`, `result`, `duration_ms`), and remove any
  personal text. Commit as `apps/worker/src/decide/testdata/claude-result.json`, pretty-printed.
- Record the exact shape (field names and where the answer, tokens, cost and model live) in
  `app_docs/decide-step.md`. The expected shape (to confirm, not to assume): `type`, `subtype`,
  `is_error`, `result`, `structured_output`, `total_cost_usd`, `usage.{input_tokens,
cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`, `modelUsage.<model>.{inputTokens,
outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD}`.
- If `claude` is not available or not logged in, stop this step, say so in the run's report and in
  the doc's Notes ("not captured"), and do not invent a captured file; the parser test then uses
  an envelope written to the documented expected shape and is labelled as such.

### 6. AI runner, parser and fake

- `apps/worker/src/ai.ts`, replacing `runJson`:
  - `AiRequest = { prompt: string; schema: object; cwd: string }`.
  - `AiResult = { kind: "answer"; answer: unknown; usage: AiUsage } | { kind: "broken"; reason:
string; usage: AiUsage }`.
  - `AiRunner = { call(tool: Tool, request: AiRequest): Promise<AiResult> }`.
  - `parseClaudeResult(stdout: string): AiResult`: `JSON.parse` failure, `is_error`, or neither
    `structured_output` nor a JSON `result` gives `broken` with a readable reason (keep any usage
    that could be read). Usage from the captured shape: `inputTokens` = `input_tokens +
cache_creation_input_tokens + cache_read_input_tokens` (every input token Claude Code reports,
    documented), `outputTokens` = `output_tokens`, `costUsd` = `total_cost_usd` as reported,
    `model` = the `modelUsage` key with the most output tokens (null when absent). Raw numbers
    only, never converted.
  - `claudeRunner(path)`: `call(tool, { prompt, schema, cwd })` runs `tool({ file: path, args:
["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "",
"--no-session-persistence"], stdin: prompt, cwd, maxStdoutBytes: 16 * 1024 * 1024 })` and
    returns `parseClaudeResult(stdout)`. No shell interprets anything (the runner's wrapper passes
    arguments through). A non-zero exit throws from the tool (the step fails, no retry: an AI that
    is unavailable is slice 16).
  - `fakeAiRunner(script: unknown[])`: each call returns `parseClaudeResult` of the next entry (a
    string entry is used as raw stdout, so `"not json"` scripts a broken answer; an object entry is
    serialised), then the last entry again; records every request (`calls: AiRequest[]`) for tests.
    It never spawns.
  - `aiRunner(env)`: under exactly `E2E_MOCK_AI === "true"`, the fake over the JSON array read from
    `E2E_MOCK_AI_SCRIPT` when set (a missing or malformed file throws a clear error), otherwise
    over one envelope `{ type: "result", is_error: false, structured_output: { ok: true }, usage:
zeros, total_cost_usd: 0 }` (the doctor's answer). Otherwise Claude Code from
    `CLAUDE_CODE_PATH` (default `claude`).
  - `plainTool: Tool`: a minimal `spawn` with stdin for the doctor (outside any step).
- `doctor-checks.ts`/`doctor.ts`: the `ai structured call` check uses `deps.ai().call(plainTool, {
prompt, schema: AI_SCHEMA, cwd: tmpdir() })` and expects `kind: "answer"` with `ok: true`;
  update `doctor-checks.test.ts`.
- `ai.test.ts`: keep the flag tests; parser on `decide/testdata/claude-result.json` (verification 7) yields the answer, the exact token sums, the cost and the model; broken stdout and
  `is_error` give `broken`; the fake replays a script file written to a temp folder, raw strings
  included; `E2E_MOCK_AI_SCRIPT` pointing at a missing file throws.

### 7. Prompt and its input

- `apps/worker/src/decide/prompt.md`: plain instructions, no em-dashes: you edit a vertical reel
  for the issebya style; start from the current version and change only what improves it; fix
  misheard words by setting a caption's `text` (keep its words), checking every caption against
  the glossary; choose accent words (overlays `kind: "accent"` anchored on their word), transitions
  (`dim`, `panel`, `card`) at topic changes, and a title (the overlay with id `title`, anchored at
  `{ "reel": "start" }`); anchor to words, use `{ time }` only where nobody speaks; keep text inside
  the safe box and captions off the face; leave properties unset to get the style's values; use
  `style` only for what the format cannot express and list each such item in `free_field`; list any
  part of the request the format cannot express in `unexpressed`; write a one-line
  `change_summary`; answer only with the JSON the schema asks for. Placeholders for the inputs.
- `apps/worker/src/decide/prompt.ts`: `export const PROMPT_VERSION = "decide-1"` (bump on every
  prompt change); reads `prompt.md` once (relative to `import.meta.url`); `decidePrompt(input,
previousReasons?: string[])` fills the placeholders with fenced JSON blocks and, when
  `previousReasons` is given, appends "Your previous answer was refused for these reasons. Fix
  them and answer again:" with one reason per line.
- `apps/worker/src/decide/input.ts`: `decideInput({ current, transcript, headTrack, preset,
request })` returning `{ current_version, transcript: [{ id, text, start, end }], head_track,
preset, request }`: `headTrackSummary(track)` = sample count, step (0.25 s), whether a head is
  ever present, the whole-clip `faceBox` (null without a head) and the spans with no head;
  `presetSummary(preset)` = frame, safe box, fonts (key, family, size), caption and accent colours
  and default sizes, transition types with their text regions, sounds, glossary. `request` is the
  request text or null (always null in this slice).
- `prompt.test.ts`: the prompt contains the current version's JSON, every word id, the glossary
  term `lock-in`, the safe box numbers and "(none)" for a null request; with reasons it ends with
  every reason.

### 8. The decide step

- `apps/worker/src/decide/run-decide.ts`, `runDecide({ ctx, storage, rows, blobs, keyPrefix, ai,
scratchDir, request = null, measurer?, newId = randomUUID })`:
  - Step name `decide`, through `runToolsStep(ctx, { name: "decide", work })` (measured; never a
    cache hit, never `recordHit`).
  - Inside `work(tool)`: read `rows.current(reelId)` (null: throw `decide: no current version`),
    the current version row and its edit blob (`blobs.get(r2_key)`), the transcript and head track
    named by the version's `inputs` (as `first-version.ts` reads them, by `cacheKey`), parse the
    current edit with `parseEdit`. Make a scratch folder `mkdtemp(join(scratchDir, "decide-"))`,
    removed in `finally`.
  - Build the schema once (`decideJsonSchema(preset, transcript, current.duration)`) and the
    input once.
  - `attempt(reasons?)`: `ai.call(tool, { prompt: decidePrompt(input, reasons), schema, cwd })`;
    add its usage to a running total (tokens and cost summed, null + n = n, model the last non-null);
    `broken` gives reasons `["the answer was not valid JSON: <reason>"]`; otherwise
    `parseDecideAnswer` reasons, then `editFromAnswer` reasons, then `build(...).checks` reasons
    plus `glossaryChecks` reasons (`<rule> <item>: <reason>`). Returns `{ ok, edit, answer,
reasons }`.
  - Round 1; if it fails, round 2 with round 1's reasons. Exactly two calls at most, no loop.
  - Both failed: throw `new StepError(message, tail, ai)` with tail
    `decide: the answer failed twice, version <n> stays current\nround 1:\n- ...\nround 2:\n- ...`,
    each round's reasons capped at 8 lines plus `- and <k> more` so both rounds fit the 20-line
    tail. Nothing is written to storage or rows.
  - Passed: `ctx.signal.throwIfAborted()`, then `saveVersion({ rows, blobs, keyPrefix, newId }, {
reelId, parentId: currentId, restoredFromId: null, request, model: usage.model, promptVersion:
PROMPT_VERSION, changeSummary: answer.change_summary, checks: [] (the passing build's checks,
which are empty), usedFreeField: usedFreeField(edit) || answer.free_field.length > 0,
unexpressed: answer.unexpressed, freeField: answer.free_field, rejectedReasons: round 1's reasons
when round 2 passed, else [], edit })`. `save_version` refuses a stale parent, so a concurrent
    change never overwrites.
  - Return `{ what: "version <n>: <a> accent(s), <t> transition(s), title set | no title, <w>
word(s) fixed", ai: usage }`; the step line reads e.g.
    `decide: version 2: 1 accent, 1 transition, title set, 1 word fixed, under a second`.
- `version-store.ts`: `save` passes `p_used_free_field`, `p_unexpressed`, `p_free_field`,
  `p_rejected_reasons`. Also update `apps/studio/test-support/versions.ts` the same way.
- `apps/worker/src/decide/testdata/short-speech-answer.json`: a Claude result envelope whose
  `structured_output` is the short-speech baseline's tracks plus one accent on `w0005` ("test"),
  one `dim` transition over a word span, a `title` overlay (short text, `primary` font, inside the
  safe box) and the caption on `w0010` with a fixed `text` (e.g. `"studio"` written `"Studio"`),
  `change_summary`, empty `unexpressed` and `free_field`, and fixed usage numbers and a model
  name. It is the E2E's script, so it lives with the worker.
- `run-decide.test.ts` (fake AI, `fakeStorage` in a temp folder, memory rows like
  `first-version.test.ts`, `recordingSteps`, version 1 saved first with `saveFirstVersion` over
  `fixtures/pipeline/`):
  - Retry once (verification 2): round 1 places the title at `x: 860, align: "left"` so its text
    runs past the safe box's right edge (passes the schema, fails `safe-box`), round 2 is the good
    answer: two calls, the second prompt contains round 1's `safe-box` reason, a new version 2 with
    parent version 1, `checks: []`, `rejected_reasons` holding the reason, `prompt_version:
"decide-1"`, `model` the script's; it is current.
  - Fail twice (verification 3): two safe-box failures: the step's last call is `failed`, its tail
    names `round 1` and `round 2` with their reasons, `current` is still version 1, the rows map
    has one row, and storage under `reels/<id>/versions/` holds exactly one object.
  - Broken JSON (verification 4): round 1 `"not json"`, round 2 the good answer: two calls, version 2
    saved, `rejected_reasons` mentions "not valid JSON".
  - Usage (verification 5): one good answer with usage `{ input 1200 + 300 + 0, output 456, cost
0.0123, model "claude-x" }`: `done`'s measurements carry exactly `ai_input_tokens: 1500,
ai_output_tokens: 456, ai_cost_usd: 0.0123, ai_model: "claude-x"`; two rounds sum.
  - Glossary through the step: an answer captioning "Locking" fails round 1 with rule `glossary`.
  - The committed `short-speech-answer.json` passes in one round and gives the step line
    `version 2: 1 accent, 1 transition, title set, 1 word fixed` (so the E2E script never rots).
  - Free field: an answer with a `style` on one item saves `used_free_field: true` and its
    `free_field` list.
  - Exactly one retry: a script of three bad answers makes exactly two calls.

### 9. Wire decide into the process job

- `process-job.ts`: after `saveFirstVersion`, `await runDecide({ ctx, storage, rows, blobs,
keyPrefix: config.keyPrefix, ai: aiRunner(process.env), scratchDir: config.scratchDir })`. A
  failed decide fails the job like any failed step (its error tail goes to the job); version 1
  stays current. Decide is never cached: a retried job decides again from the then-current
  version.
- Nothing else in the pipeline calls the AI (grep `aiRunner`/`claude` to confirm only
  `process-job.ts` and `doctor.ts` reach it).

### 10. Studio test support and E2E

- `apps/studio/test-support/worker.ts`: no flag change (`E2E_MOCK_AI=true` already); callers pass
  `E2E_MOCK_AI_SCRIPT` in `env`.
- `apps/studio/test-support/ai-script.ts`: `SHORT_SPEECH_ANSWER` (the URL of
  `apps/worker/src/decide/testdata/short-speech-answer.json`) and `unchangedAnswerScript(dir)`,
  which writes a temp script file whose single envelope answers with the tracks of
  `packages/edit/src/testdata/versions/baseline-short-speech.edit.json` (the worker's version 1 over
  `fixtures/pipeline/`), so the AI's version 2 has exactly version 1's bytes.
- `pipeline-cache.ts`: `seedProcessedReel` takes `aiScript?: string` (default: the unchanged
  script) and passes `E2E_MOCK_AI_SCRIPT`; it returns the current (version 2) key and also
  `firstVersionKey`, and both keys go into `keys` for cleanup. `preview.spec.ts` keeps comparing
  with the version 1 golden (the bytes are identical); update its comments ("the current version,
  the AI's unchanged version 2") and make sure its own `saveTestVersion` (now version 3) still uses
  the current version as parent.
- `upload.spec.ts`: run the worker with `E2E_MOCK_AI_SCRIPT` set to `SHORT_SPEECH_ANSWER`. Extend:
  the step lines end with `/^first_version: version 1 saved, /` then
  `/^decide: version 2: 1 accent, 1 transition, title set, 1 word fixed, /`; the steps list gains
  `{ name: "decide", status: "done", cache_hit: false, wall_ms: any, cpu_ms: null, ... }` (the fake
  spawns nothing); a second query selects the decide row's `ai_input_tokens, ai_output_tokens,
ai_cost_usd, ai_model` and expects the script's numbers exactly; the versions query (ordered by
  `number`) returns version 1 as before and version 2 with `parent_id` version 1, `request: null`,
  `model` the script's, `prompt_version: "decide-1"`, `change_summary` the script's, `checks: []`,
  `used_free_field: false`, `unexpressed: []`, `rejected_reasons: []`; `reels.current_version_id`
  is version 2's id; version 2's blob parses with `parseEdit` and contains the `title` overlay;
  clean up both version keys. The page shows the decide step line (the user-visible change).
- `apps/studio/db-tests/versions.test.ts`: `save_version` with the four new arguments stores them;
  without them the defaults apply; `authenticated` still cannot execute it.

### 11. Apply the migration in the run

- `.adw/supabase-stack reset` before `test:db` and E2E (the profile's rule for a run; the issue's
  `supabase migration up --local` is the owner's command outside ADW, which the profile forbids
  agents to run). If the reset fails, report its error and stop; never `supabase db reset`.

### 12. Docs and profile

- New `app_docs/decide-step.md` (no em-dashes): Specifications link to this plan; Overview; inputs
  (current version, transcript with ids, head-track summary, preset with glossary, request); the
  per-reel schema rules (word-id enum, time max, font and transition enums, safe-box positions,
  tracks-only answer plus `change_summary`, `unexpressed`, `free_field`); the CLI call and each flag;
  the captured result shape and which fields give answer, tokens, cost and model; validation order
  (Zod, compose, Zod with refinement, build checks, glossary); the single retry and the failure
  tail; what every version records (columns); the glossary; the step line; the fake and
  `E2E_MOCK_AI_SCRIPT`; never cached; Testing; Rules: AI only in the decide step; exactly one
  retry, never a loop; the current version never changes on a failed decide; the schema is
  generated per reel, never static free strings for word ids or fonts; no tools for the model
  (`--tools ""`); every version records request, parent, model, prompt version, change summary
  and checks; bump `PROMPT_VERSION` with every prompt change; tests never call the real Claude Code.
- `docs/conditional-docs.md`: "Read `app_docs/decide-step.md` when changing the decide step, its
  prompt or `PROMPT_VERSION`, the per-reel answer schema, the Claude Code call or result parser,
  the glossary check, the version decide records, or the AI fake and `E2E_MOCK_AI_SCRIPT`."
- `app_docs/edit-model.md`: the new exports (`decide.ts`, `glossary.ts`, exported `wordsText`), the
  `glossary` rule, `editSchemaFor` limits, the four new version columns and the new `save_version`
  signature (by migration name); the Testing list.
- `app_docs/measurement.md`: the `ai_*` columns are now written by decide (summed over both
  rounds, also on failure), `StepError`, stdin and `maxStdoutBytes` on `ToolCall`.
- `app_docs/studio.md`: `E2E_MOCK_AI_SCRIPT` beside `E2E_MOCK_AI`, the doctor's AI check through the
  new runner, the upload spec ending at version 2.
- `apps/worker/.env.example`: `E2E_MOCK_AI_SCRIPT=` with a one-line comment (tests only).
- `.adw/project.md` Tests section: the `upload.spec.ts` description now ends "then the
  `first_version` step saves version 1 and the `decide` step (AI fake) saves version 2"; the
  `preview.spec.ts` one notes the unchanged AI answer. Do not rename or reorder its headings.

### 13. Validation

- Run every command in `Validation Commands`, in order, and fix every failure properly (never
  weaken a rule, type or test).

## Testing Strategy

### Unit Tests

- `packages/edit/src/decide.test.ts`: per-reel JSON Schema enums and bounds; answer refusals (other
  reel's id, time past the end, unknown font, x 900); composition keeps inputs and duration; counts.
- `packages/edit/src/glossary.test.ts`: misspelled glossary words fail, the term passes.
- `packages/edit/src/schema.test.ts`, `versions.test.ts`: limits are opt-in; new version fields.
- `apps/worker/src/ai.test.ts`: parser on the captured real shape; broken and error envelopes; the
  scripted fake from a file.
- `apps/worker/src/step-runner.test.ts`: stdin, stdout cap, AI measurements, `StepError` tail.
- `apps/worker/src/decide/prompt.test.ts`: inputs and retry reasons in the prompt.
- `apps/worker/src/decide/run-decide.test.ts`: retry once, fail twice (nothing written), broken
  JSON retried, usage exact, glossary, free field, at most two calls, the E2E answer passes.
- `apps/worker/src/doctor-checks.test.ts`: the AI check on the new interface.
- DB layer: `apps/studio/db-tests/versions.test.ts` for the new columns and signature.

### Test Coverage

- `packages/edit/src/decide.test.ts` (unit, edit `node` project): catches a static or loose answer
  schema (free-string word ids or fonts, no time cap, frame-wide positions); fails today because
  `decide.ts` does not exist.
- `packages/edit/src/glossary.test.ts` (unit): catches a caption still showing "Locking"; nothing
  checks the glossary on caption text today.
- `apps/worker/src/decide/run-decide.test.ts` (unit, worker): catches a missing or looping retry, a
  version written after two failures, a lost current version, broken JSON not retried, and usage
  not landing in the step's AI columns; none of this exists today.
- `apps/worker/src/ai.test.ts` (unit): catches a parser that misreads the real Claude Code result
  (tokens, cost, model); today's parser reads no usage at all.
- `apps/worker/src/step-runner.test.ts` (unit): catches a prompt not reaching stdin and a failed
  step losing its reasons to stack frames.
- `apps/studio/db-tests/versions.test.ts` (DB): catches `save_version` not storing the new records.
- `apps/studio/e2e/upload.spec.ts` (E2E, chromium): catches a process job that stops at version 1
  or a decide step line missing from the reel page; fails today because no `decide` line exists.

### Edge Cases

- Broken stdout, `is_error: true`, an envelope with neither `structured_output` nor JSON `result`.
- An answer that passes the JSON Schema but fails the refinement (duplicate id, end before start).
- An answer that passes Zod but fails `safe-box`, `face`, `out-of-reel` or `glossary`.
- A reel with no head in frame (the fixture clip): head-track summary says so; the face rule passes.
- A title overlay with `text` and no `words`.
- Usage fields missing in a result: null, not 0; two rounds sum with nulls.
- A lost lease during the AI call: the child is killed, nothing is written.
- A concurrent new version between read and save: `save_version` refuses the stale parent.
- More than 8 reasons per round: the tail stays within 20 lines.
- An existing reel with only version 1 and a retried job: decide runs again from the current version.
- `E2E_MOCK_AI_SCRIPT` unset under the fake: the doctor still passes; decide fails visibly.

## Acceptance Criteria

- A freshly processed reel (fakes on) ends with version 2 current, made by decide, with `parent_id`
  version 1, `model`, `prompt_version` `decide-1`, `change_summary`, `checks` `[]`, and the
  free-field and could-not-express records; the reel page shows
  `decide: version 2: 1 accent, 1 transition, title set, 1 word fixed, ...`.
- The decide step row carries `ai_input_tokens`, `ai_output_tokens`, `ai_cost_usd` and `ai_model`
  exactly as the result reported them (summed over two rounds).
- The answer schema is generated per reel with real `enum` lists for word ids, fonts and transition
  types, a time maximum and safe-box position bounds.
- A failing answer is retried exactly once with its reasons in the prompt; two failures fail the step
  with both rounds' reasons in `error_tail`, and no version row or R2 object is written.
- Claude Code runs with `-p --output-format json --json-schema <schema> --tools ""
--no-session-persistence`, the prompt on stdin, through the measuring step runner in a scratch
  folder; tests never call it.
- A committed real result parses into answer, tokens, cost and model.
- Every gate in Validation Commands passes; no em-dashes in any changed file.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: whole-repository formatting.
- `yarn lint`: lint every workspace (the change spans `packages/edit`, `apps/worker`, `apps/studio`).
- `yarn typecheck`: types across the edit package, the worker and the studio's test support.
- `yarn knip`: no unused files or exports (new modules are all imported).
- `yarn test`: unit layers, including the edit package's node and browser projects (goldens
  unchanged), the worker's decide, AI and step-runner tests, and the migration version guard.
- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker`: the two targets' unit
  tests on their own, for a focused re-run.
- `.adw/supabase-stack reset`: applies the new migration to the ADW stack (stop and report on failure).
- `yarn turbo run test:db --filter=./apps/studio`: `save_version` with the new columns, RLS unchanged.
- `yarn build`: every app still builds.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the landing suite, then the studio
  suite with `upload.spec.ts` (version 2 and the decide line) and `preview.spec.ts` (golden still
  matches), against the server `/prepare_app` started.
- `grep -rn $'\u2014' app_docs docs apps/worker/src packages/edit/src specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md supabase/migrations`:
  must print nothing (no em-dashes).

## Notes

- No new dependency: Zod 4 (`z.toJSONSchema`) is already in `packages/edit`.
- The issue says to run `supabase migration up --local`; the profile's Protected section forbids
  agents that command and prescribes `.adw/supabase-stack reset` after adding a migration in a run.
  The profile wins inside ADW; the owner applies it to their own stack with `supabase migration up
--local`.
- The title has no field of its own in format 1: it is the accent overlay with id `title`
  anchored at the reel start, as the old `rethink-work` reel's title was text over the first
  seconds. A dedicated title item can come with a later format.
- Four version columns instead of the issue's example two: `rejected_reasons` keeps "what the checks
  said" about a refused first answer, and `free_field` keeps which items needed the free field and
  why, the signal for what to add to the format next.
- `reels.status` gets no `deciding` value in this slice (it would need the status constraint and
  `PipelineReelStatus` changed); the step line shows progress. A later slice can add it.
- A retried `process` job decides again (decide is never cached), which costs a second AI call; a
  smarter skip (for example, when the current version was already made by decide with the same
  inputs and a null request) is left for slice 11, where requests arrive.
- No Claude Code timeout is added; a lost lease kills the child through the step runner's signal.
  Waiting when the AI is unavailable or logged out is slice 16.
- The real-result capture in step 5 is the one real Claude Code call of this run; it runs by hand
  on the worker machine, never in a test or CI. The pipeline will not verify the quality of the
  AI's choices on real footage; that is the owner's manual acceptance against
  `rethink-work-02.mp4` (record tokens and cost from the step row).
- Browser surface: only the new step line on the reel page, covered by `upload.spec.ts`; no visual
  review is needed beyond the existing studio captures.
