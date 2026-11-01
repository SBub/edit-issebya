# Feature: decide step: Claude Code with a per-reel JSON Schema, layout checks with one retry, version records

## Metadata

issue_number: `33`
adw_id: `48ca5f11`
issue_json: `{"number":33,"title":"feat: decide step: Claude Code with a per-reel JSON Schema, layout checks with one retry, version records"}`

## Feature Description

The reel studio's one AI step, **decide**. After the six fixed pipeline steps and the automatic
version 1 (`first_version`), the worker asks Claude Code (`claude -p`, on the owner's machine) to
fix misheard words and choose the accent words, the transitions and the title, starting from the
reel's current version. The answer must match a JSON Schema generated for this reel (its own word
ids as an enum, times capped at its clip's length, the preset's fonts, colours, sounds and
transition types as enums, positions inside the preset's safe box). Claude Code enforces that
schema while it answers (`--json-schema`). The worker then validates the answer again with Zod,
builds it with the `packages/edit` builder, runs the builder checks (safe box, face, sound gap) and
a deterministic glossary post-check. A failure goes back to the AI once with the reasons; a second
failure fails the step with both rounds' reasons in `error_tail`, and the reel's current version
does not change. On success the result is saved as a new version with a full record of how it was
made (parent, request, model, prompt version, change summary, checks, inputs, whether the free
`custom` field was used and which requests the format could not express), and it becomes current.
The step reports its own tokens, cost and model on its `steps` row.

## User Story

As the studio owner
I want the worker to turn the automatic version 1 of a processed reel into an AI-edited version 2,
checked against the reel's own words, clip length and the style's rules
So that a freshly processed reel already has fixed words, accents, transitions and a title, while a
bad AI answer can never replace a version that worked

## Problem Statement

After #31 a processed reel ends with version 1: one caption per word, no accents, no transitions, no
title, misheard brand words left as heard. The only creative step left, choosing those, needs a
model, and a model's answer can be wrong in two ways: structurally (a word id that does not exist,
a time past the clip's end, a font the preset does not have, text outside the safe box) and
visually (text running past the edge after measuring, a caption over the face). Neither must ever
reach the reel's current version, and every AI version must say exactly how it was made so the
format can grow from what the AI could not express.

## Solution Statement

- `packages/edit` gains `decideAnswerSchema(context)` (Zod 4, per reel) and
  `decideJsonSchema(context)` (its JSON Schema via `z.toJSONSchema`, with real `enum` lists), the
  answer type, `editFromAnswer(answer, inputs)` (a full `Edit`), and `glossaryCheck(edit, preset)`.
- `apps/worker` gains `src/decide/` with the committed prompt (`prompt.md`, `PROMPT_VERSION`), the
  prompt input builder (current edit, transcript with ids, head-track summary, preset with glossary,
  request), the attempt evaluator (Zod, build, checks, glossary) and the `decide` step: one Claude
  call, at most one retry with the reasons, then `saveVersion` with the new record fields.
- The AI runner (`src/ai.ts`) calls Claude Code through the measuring step runner (`runToolsStep`
  with a `Tool`), passing the prompt on stdin, and returns the structured answer plus usage (input
  and output tokens, cost, model) parsed from the result envelope. Its fake returns scripted answers
  and usage; under `E2E_MOCK_AI=true` the script comes from the file `E2E_MOCK_AI_SCRIPT` names.
- The step runner learns three small things: stdin for a tool call (`input`), a per-call timeout
  (`timeoutMs`), a step-provided error tail (`StepTailError`) and AI usage on the row (done and
  failed).
- A migration adds `used_free_field`, `free_field` and `unexpressed` to `versions` and extends
  `save_version` with them.
- The `process` job runs `decide` after `first_version`; a reel whose current version already came
  from the AI is not decided again by a retried process job. Decide is never cached.
- The reel page shows the current version's number (`version 2`), so the E2E can see it.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository layout and run instructions (the worker section; `packages/edit` line comes with #31).
- `AGENTS.md`: rules (Yarn only, no em-dashes, no trailers, docs one per feature, `.adw/project.md` kept in step).
- `.adw/project.md`: profile; Protected (only `supabase migration up --local`), Tests (layers and E2E), Build (filters).
- `docs/conditional-docs.md`: index; add the decide-step line.
- `app_docs/edit-model.md` (from #31): edit format, `editSchema`, `editJsonSchemaBase`, preset and glossary, builder, checks, versions, `save_version`, `first_version`. Its Rules (deterministic package, never rewrite a version, writes only through `save_version`, object before row, measure only with `createMeasurer`) are invariants here.
- `app_docs/measurement.md`: step runner, AI columns (`ai_input_tokens`, `ai_output_tokens`, `ai_cost_usd`, `ai_model`), summary and error-tail rules. Raw numbers only.
- `app_docs/studio.md`: `steps`, `versions`, reel page, the storage and AI test doubles, `runWorkerOnce`, DB and E2E tests.
- `app_docs/pipeline.md` (from #29/#30): the fixed steps, fingerprints and the R2 cache (`cacheKey`), retime outputs (`retime.json` with `durationSeconds`, `transcript.json`), head track.
- `packages/edit/src/schema.ts`: `editJsonSchemaBase`, `editSchema`, `parseEdit`, the item shapes the per-reel schema mirrors (anchors, `style`, `custom`).
- `packages/edit/src/preset.ts`: `ISSEBYA` (safe box 130..860 x 260..1400, fonts, colours, sounds, `transitions`, `glossary`).
- `packages/edit/src/build.ts`, `checks.ts`, `layout.ts`: `build()` returns `checks` (`safe-box`, `face`, `sound-gap`).
- `packages/edit/src/versions.ts`, `supabase-versions.ts`, `index.ts`: `VersionRow`, `VersionMeta`, `saveVersion`, `restoreVersion`, the column list and the `save_version` RPC call.
- `packages/edit/src/testdata/rethink-work/transcript.json`, `head-track.json`: the fixture transcript for the schema test.
- `packages/edit/package.json`, `vitest.config.ts`: package deps and test projects.
- `apps/worker/src/ai.ts`, `ai.test.ts`: `AiRunner`, `parseClaudeJson`, `fakeAiRunner`, `aiRunner(env)`.
- `apps/worker/src/doctor-checks.ts`, `doctor-checks.test.ts`: the only current AI caller (`runJson`), to adapt.
- `apps/worker/src/step-runner.ts`, `step-runner.test.ts`: `ToolCall`, `runChild`, `runToolsStep`, `StepFailure`, `withStep`.
- `apps/worker/src/step-store.ts`: `StepStore.done` / `failed` (add AI usage).
- `apps/worker/src/steps/first-version.ts`, `first-version.test.ts`: the pattern for an in-worker step reading cached inputs by fingerprint, lease-guarded writes, `saveVersion`, and its fakes.
- `apps/worker/src/process-job.ts`: wiring; `decide` goes after `firstVersion`.
- `apps/worker/src/config.ts`: `WorkerConfig` (`scratchDir`, `keyPrefix`).
- `apps/worker/src/pipeline/fingerprint.ts`: `cacheKey`.
- `apps/worker/src/summary.ts`, `errors.ts`: `stepSummary`, `outputTail` (20 lines, 4096 bytes).
- `apps/worker/.env.example`: the `E2E_MOCK_AI` comment; add `E2E_MOCK_AI_SCRIPT` (placeholder, empty).
- `supabase/migrations/20261104090000_versions.sql`, `20261104090100_save_version_error_code.sql`: the current `versions` table and `save_version` body to extend.
- `apps/studio/db-tests/versions.test.ts`: `save_version` tests to extend.
- `apps/studio/e2e/upload.spec.ts`, `apps/studio/test-support/worker.ts`: the spec that spawns `once` on the seeded short-speech fixtures, and the spawn helper.
- `apps/studio/src/app/reels/[id]/page.tsx`, `src/components/LiveReel.tsx`, `src/lib/reels.ts`: the reel page, its Realtime follow and `REEL_DETAIL_COLUMNS`.
- `fixtures/pipeline/` (`manifest.json`, `retime/transcript.json`, `retime/retime.json`, `head_track/head-track.json`): the short-speech cache the E2E seeds (words `w0001`..`w0010`, `durationSeconds` about 2.69).
- `knip.json`, `turbo.json`: dead-code config (new files must be reachable) and env lists (no new turbo env is needed, see Notes).
- `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/brief.md`, `build.py`: the old setup's title (an opening line above the head, static from 0 s), accents and three transitions with clicks, to shape the prompt. Read only; nothing is copied into the repo except prompt guidance.

### New Files

- `supabase/migrations/20261105090000_decide_versions.sql`: `versions.used_free_field`, `free_field`, `unexpressed`; `save_version` with three more parameters.
- `packages/edit/src/decide.ts`: `decideAnswerSchema`, `decideJsonSchema`, `DecideAnswer`, `editFromAnswer`, `answerCounts`.
- `packages/edit/src/decide.test.ts`: per-reel schema tests (Verification 1).
- `packages/edit/src/glossary.ts`, `glossary.test.ts`: `glossaryCheck` (Verification 6).
- `apps/worker/src/decide/prompt.md`: the committed prompt.
- `apps/worker/src/decide/prompt.ts`, `prompt.test.ts`: `PROMPT_VERSION`, `decidePrompt(input)`, `retryPrompt(prompt, reasons)`, `headTrackSummary`.
- `apps/worker/src/decide/attempt.ts`: `evaluateAttempt` (Zod, build, checks, glossary into one reason list).
- `apps/worker/src/decide/decide.ts`, `decide.test.ts`: the `decide` step (Verifications 2 to 5).
- `apps/worker/src/decide/testdata/claude-result.json`: one real, scrubbed `claude -p --output-format json --json-schema` result (Verification 7).
- `fixtures/decide/short-speech.json`: the fake's scripted answer and usage for the E2E reel.
- `apps/worker/src/decide/fixture-answer.test.ts`: proves the E2E script passes every check on the seeded fixtures.
- `app_docs/decide-step.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Bring #31 into this branch, then add the database columns, the version-record fields, the per-reel
answer schema and the glossary check in `packages/edit`, and the step-runner and AI-runner
capabilities the step needs (stdin, timeout, step-owned error tail, AI usage on the row, usage
parsed from the Claude envelope, a scriptable fake).

### Phase 2: Core Implementation

The prompt and its input, the attempt evaluator, and the `decide` step with exactly one retry,
saving a new version only on a passing attempt, with full records and usage.

### Phase 3: Integration

Wire `decide` into the `process` job after `first_version`, adapt `doctor`, show the current version
number on the reel page, extend the upload E2E with the fake script, capture the real result shape,
and document.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Base the branch on #31

- This branch was cut from `develop` at `7d82d00`, which has neither `packages/edit` nor the
  `versions` table. Merge `feat/issue-31-adw-9a39262e-edit-model-builder-versions` into it
  (`git merge --no-edit feat/issue-31-adw-9a39262e-edit-model-builder-versions`), the same way #32's
  branch did (`2103ffd`). If #31 has reached `develop` by then, merge `develop` instead. Resolve
  nothing by hand unless git reports a conflict; then `yarn install --immutable`.
- Run `supabase migration up --local` now (applies #29 to #31's migrations if the stack lacks them).
  If it fails, report the error and stop; never reset.
- Every path below refers to the tree after this merge.

### 2. Migration: version record fields

- Create `supabase/migrations/20261105090000_decide_versions.sql`:
  - `alter table public.versions add column used_free_field boolean not null default false, add column free_field jsonb not null default '[]'::jsonb, add column unexpressed jsonb not null default '[]'::jsonb;`
    with checks `jsonb_typeof(free_field) = 'array'` and `jsonb_typeof(unexpressed) = 'array'`.
    Comment: `used_free_field` is computed by the worker from the saved edit (any item with
    `custom`); `free_field` is the AI's list of `{ item, why }`; `unexpressed` is the AI's list of
    requests the format could not express. Existing rows get the defaults (the immutability trigger
    fires on update only, and `add column ... default` does not fire row triggers).
  - `drop function public.save_version(uuid, uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, text);`
    then `create function public.save_version(...)` with the same 11 parameters plus
    `p_used_free_field boolean, p_free_field jsonb, p_unexpressed jsonb`, the body copied from
    `20261104090100_save_version_error_code.sql` (its error codes kept exactly) with the three
    columns added to the insert. Repeat the `revoke execute ... from public, anon, authenticated` and
    `grant execute ... to service_role` for the new signature.
- Run `supabase migration up --local`. On failure report and stop.

### 3. Version records in `packages/edit`

- `versions.ts`: `VersionRow` gains `used_free_field: boolean`, `free_field: { item: string; why: string }[]`,
  `unexpressed: string[]`. `VersionMeta` gains optional `freeField` and `unexpressed` (default `[]`).
  `saveVersion` computes `used_free_field` from the edit (any item in any track with `custom`
  set), never from the AI's claim. `restoreVersion` copies the three fields from the version it
  restores (they describe the edit's bytes).
- `supabase-versions.ts`: add the three columns to `COLUMNS` and pass `p_used_free_field`,
  `p_free_field`, `p_unexpressed` to the RPC.
- Update `versions.test.ts` and `first-version.ts` / `first-version.test.ts` (version 1:
  `used_free_field` false, both lists empty).
- `apps/studio/db-tests/versions.test.ts`: extend: `save_version` stores the three fields; the
  defaults on a call that passes `false`, `[]`, `[]`; a non-array `p_unexpressed` is refused.

### 4. Per-reel answer schema in `packages/edit`

- Create `packages/edit/src/decide.ts`:
  - `interface DecideContext { transcript: Transcript; preset: Preset; clipDuration: number }`.
  - `decideAnswerSchema(context)`: a Zod 4 `strictObject` built per reel, structurally mirroring
    `schema.ts` (reuse its exported pieces where they fit; export small builders from `schema.ts`
    if needed, never weaken its existing rules):
    - word ids: `z.enum(transcript.words.map((w) => w.id))` used in every word anchor and in
      `captions[].words`; give it `.meta({ id: "wordId" })` so the JSON Schema holds the list once
      under `$defs`.
    - time anchors: `at` within `0..clipDuration`; word-anchor `offset` keeps `-0.5..0.5`.
    - `style.font`: `z.enum(Object.keys(preset.fonts))`; `style.color`: preset colour keys enum or
      `#RRGGBB` pattern; `sound`: `z.enum(Object.keys(preset.sounds))`; transition `type`:
      `z.enum(preset.transitions)`.
    - `style.position`: `x` in `safe.left..safe.right`, `y` in `safe.top..safe.bottom` (130..860,
      260..1400 for `ISSEBYA`).
    - `custom` kept as the free field, with the same character rule as `schema.ts`.
    - The answer object: `{ tracks, change_summary: string (1..300), fixed_words: { word: wordId, heard: string, text: string }[], unexpressed: string[] (each 1..300), free_field: { item: string, why: string }[] }`.
      `inputs` is not part of the answer: the worker copies it from the parent version (the AI may
      not change fingerprints). `format` is added by `editFromAnswer`.
    - Title convention: the overlay whose id is `title`. Accents: every other overlay.
  - `decideJsonSchema(context)`: `z.toJSONSchema(decideAnswerSchema(context), { target: "draft-2020-12" })`
    (or the draft Claude Code accepts; record which in the doc). The output must contain real
    `enum` arrays (word ids, fonts, sounds, transitions, colour keys) and `minimum`/`maximum` for
    `at` and positions. Throw at generation time if the transcript has no words.
  - `editFromAnswer(answer, inputs): Edit` returns `{ format: 1, inputs, tracks: answer.tracks }`.
  - `answerCounts(answer)`: `{ accents, transitions, title: boolean, fixedWords }` for the step line.
- Export them from `index.ts`.
- `decide.test.ts` (Verification 1), on `testdata/rethink-work/transcript.json` with `ISSEBYA` and
  a clip duration:
  - the JSON Schema's word-id `enum` equals the transcript's ids, in order;
  - the font, sound and transition enums equal the preset's;
  - a valid answer (from `testdata/versions/rethink-work-accents.json`'s tracks) passes;
  - an answer using an id not in this transcript (`w9999`, or an id from the short-speech
    transcript that this one lacks), a `{ at }` past the clip's end, a font `"comic"`, and a
    position at `x: 900` each fail, with the Zod schema and with the exported JSON Schema checked by
    a JSON Schema validator (`ajv/dist/2020`, dev dependency, see Notes), so the schema Claude
    enforces is proven, not just the Zod one.

### 5. Glossary post-check in `packages/edit`

- Create `packages/edit/src/glossary.ts`: `glossaryCheck(edit, preset): CheckResult`. For every
  glossary entry and every `heard` variant, any caption, overlay or transition `text` that contains
  the heard word as a whole word, case-insensitive (`\b` on both sides, escaped), gives the reason
  `<item id>: glossary: "<as written>" should be "<term>"`. Reasons sorted, same shape as
  `runChecks`. Deterministic, no `node:*`.
- `glossary.test.ts` (Verification 6): an edit with a caption `Locking` fails with that reason; with
  `lock-in` it passes; `blocking` (not a whole word) passes.

### 6. Step runner: stdin, timeout, step-owned tail, AI usage

- `step-runner.ts`:
  - `ToolCall` gains `input?: string` (written to the child's stdin, then closed; stdin stays
    `"ignore"` when absent) and `timeoutMs?: number` (on expiry the group gets SIGTERM, then SIGKILL
    after `KILL_AFTER_MS`, like a lost lease, and the call fails with `timed out after N s`).
  - Export `class StepTailError extends Error { readonly tail: string }`. In `runToolsStep`'s
    catch, a `StepTailError` becomes a `StepFailure` with its own `tail` (passed through
    `outputTail`) instead of the stack's last lines, so both rounds' reasons reach `error_tail`.
  - `ToolsStep.work` receives a second argument `ai: (usage: AiUsage) => void`; usage reported
    through it is summed (tokens and cost added, model the last non-null) and written on the row on
    both success and failure. `AiUsage` is `{ inputTokens: number | null; outputTokens: number | null; costUsd: number | null; model: string | null }`,
    defined in `step-store.ts` (or `ai.ts`, whichever keeps imports acyclic).
- `step-store.ts`: `done` and `failed` take an optional `ai?: AiUsage` and write `ai_input_tokens`,
  `ai_output_tokens`, `ai_cost_usd`, `ai_model` only when given. Raw numbers as reported (no
  conversion, no rounding).
- `step-runner.test.ts`: a real child (`/bin/cat`) receives `input` on stdin and returns it; a
  `timeoutMs` kills a `sleep` and fails the step; a `StepTailError`'s tail is the row's
  `error_tail`; reported usage reaches the fake store's `done` and `failed` exactly.

### 7. AI runner: Claude Code through a `Tool`, usage, scriptable fake

- `ai.ts`:
  - `interface AiCall { prompt: string; schema: object; tool?: Tool; cwd?: string }`,
    `interface AiResult { output: unknown; usage: AiUsage }`, `AiRunner.runJson(call): Promise<AiResult>`.
  - `export class AiAnswerError extends Error {}`: the answer is unusable (result text not JSON, no
    structured output). `decide` treats it as a failed attempt; any other error (non-zero exit,
    `is_error: true`, timeout) fails the step at once, without a retry (waiting for an unavailable
    AI is slice 16).
  - `parseClaudeJson(stdout): AiResult`: the envelope must parse (else `AiAnswerError`);
    `is_error` throws a plain `Error`; output from `structured_output`, else `JSON.parse(result)`
    (failure is `AiAnswerError`). Usage from the envelope as captured in step 15 (expected:
    `usage.input_tokens` plus `usage.cache_creation_input_tokens` plus `usage.cache_read_input_tokens`
    as input, `usage.output_tokens` as output, `total_cost_usd` as cost, the model from the
    `modelUsage` key(s), joined with `,` if more than one). Missing fields give `null`, never `0`.
    Adjust these names to the captured file; the doc records the real ones.
  - `claudeRunner(path)`: calls `tool({ file: path, args: ["-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--tools", "", "--no-session-persistence"], input: prompt, cwd, timeoutMs: DECIDE_TIMEOUT_MS })`
    (10 minutes). Without a `tool` (the doctor), a plain `execFile`-based tool with stdin is used.
    Nothing goes through a shell; the prompt never appears in argv.
  - `fakeAiRunner(script: FakeAnswer[])`, where `FakeAnswer` is
    `{ output: unknown; usage?: Partial<AiUsage> } | { stdout: string }`. A `stdout` entry runs
    through `parseClaudeJson`, so "not valid JSON" exercises the real parser. It also records every
    call's prompt (`runner.prompts`) for tests. In order, then the last again (as today).
  - `aiRunner(env)`: under `E2E_MOCK_AI=true`, if `E2E_MOCK_AI_SCRIPT` names a file, the fake reads
    that JSON array at first call (relative paths resolve from the repository root); without it,
    the existing `[{ output: { ok: true } }]` default stays (the doctor). Otherwise Claude Code at
    `CLAUDE_CODE_PATH` (default `claude`).
- `doctor-checks.ts`: `runJson({ prompt, schema })` and read `.output`; tests updated.
- `ai.test.ts`: the existing cases on the new shape; a `stdout: "not json"` fake entry throws
  `AiAnswerError`; `E2E_MOCK_AI_SCRIPT` is read; and Verification 7 (step 15's file parses into
  output, tokens, cost and model, all non-null).
- Add `E2E_MOCK_AI_SCRIPT=` (empty) with a one-line comment to `apps/worker/.env.example`.

### 8. The prompt and its input

- `apps/worker/src/decide/prompt.md`: plain instructions, no secrets, no personal text. It says:
  the input is the current edit, the transcript with ids, a head-track summary, the preset (fonts,
  colours, sounds, transitions, safe box, glossary) and the owner's request (empty means "make the
  first edit"); fix misheard words in caption text (always the glossary terms), choose a few accent
  words (overlays, short, key words), up to three transitions at topic changes with a click sound on
  each (sounds at least `minSoundGap` apart), and a title overlay with id `title` from `{ at: 0 }`
  that clears before the first sentence ends; keep captions off the face (the summary says where
  the head is); keep every element inside the safe box; return the full tracks (anything not
  changed copied as is); fill `change_summary`, `fixed_words`, and `unexpressed` / `free_field`
  whenever something could not be said in the format or needed `custom`. Shape the guidance from
  the old setup's `brief.md` (title above the head, accents, three transitions with clicks).
- `apps/worker/src/decide/prompt.ts`:
  - `export const PROMPT_VERSION = "decide-1"`; bump it in the same commit as any `prompt.md` edit
    (the doc's Rules say so).
  - `decidePrompt({ edit, transcript, headTrack, preset, request })`: `prompt.md` (read with
    `readFile(new URL("./prompt.md", import.meta.url))`) followed by an `## Input` section holding
    one canonical JSON object `{ current_edit: tracks, transcript: [{ id, text, start, end }], head_track: summary, preset: { frame, safe, fonts (keys, family, size), colors, sounds, transitions, glossary, minSoundGap }, request }`.
  - `headTrackSummary(headTrack)`: per half-second window, the head box (`top`, `left`, `right`
    from `cx` and `head_w`) or `null`, numbers rounded to whole pixels, so the prompt stays small.
  - `retryPrompt(prompt, reasons)`: the first prompt plus `## Your previous answer failed these checks`
    and one reason per line, then "Answer again with the full answer."
- `prompt.test.ts`: the input section holds the transcript ids and the glossary; `retryPrompt`
  contains every reason; `PROMPT_VERSION` is non-empty.

### 9. Attempt evaluation

- `apps/worker/src/decide/attempt.ts`: `evaluateAttempt({ output, context, inputs, transcript, headTrack, preset, measurer })`
  returns `{ ok: true, answer, edit, checks } | { ok: false, reasons }`:
  1. `decideAnswerSchema(context).safeParse(output)`; issues become reasons (`schema: <path>: <message>`).
  2. `edit = editFromAnswer(answer, inputs)`, then `parseEdit(edit, { transcript, preset })`
     (defence in depth: duplicate ids, inverted items, a time inside a spoken word).
  3. `build(...)`: its `checks.reasons`.
  4. `glossaryCheck(edit, preset)`: its reasons.
     The final `checks` is `{ ok, reasons }` over steps 3 and 4 (sorted); a passing attempt has no
     reasons at all.

### 10. The decide step

- `apps/worker/src/decide/decide.ts`, `decide({ ctx, storage, keyPrefix, scratchDir, fingerprints, versions, ai, request = null, newId = randomUUID, spawnTool? })`:
  - `runToolsStep(ctx, { name: "decide", work: async (tool, reportAi) => ... }, spawnTool)`.
  - Read the current version (`versions.current`, `versions.get`, the object at `r2_key`);
    none is an error (`decide: no current version`). In the `process` job, if the current version
    has a non-null `model` (an AI version already exists, e.g. the job was retried after decide
    saved), return `version N already decided` and write nothing.
  - Read the retimed `transcript.json` and `retime.json` (`durationSeconds` is the clip duration)
    and the head track from the cache by fingerprint, as `first_version` does (copy its `readJson`
    and `fingerprintOf` pattern; extract a shared helper into `steps/` only if knip and lint stay
    clean).
  - Work in `<scratchDir>/job-<job id>/decide/` (created, then removed in `finally`); it is the
    Claude call's `cwd`.
  - Round 1: `ai.runJson({ prompt, schema: decideJsonSchema(context), tool, cwd })`, `reportAi(usage)`
    for every call that returned. `AiAnswerError` gives the reason `answer: <message>`; then
    `evaluateAttempt`. On failure, round 2 with `retryPrompt(prompt, reasons)`. Exactly one retry,
    never a loop.
  - Both rounds failed: throw `StepTailError` whose message and tail are
    `decide failed twice\nround 1: <reasons joined with "; ">\nround 2: <reasons joined with "; ">`,
    each round capped at the first 8 reasons plus `and N more`, so both fit `outputTail`'s 20 lines
    and 4096 bytes. Nothing is written to R2 or `versions`; `current_version_id` is untouched.
  - Passed: `saveVersion` with the lease-guarded `objects` and `store` wrappers from
    `first_version`, `meta: { request, model: usage.model, promptVersion: PROMPT_VERSION, changeSummary: answer.change_summary, checks, freeField: answer.free_field, unexpressed: answer.unexpressed }`,
    `inputs` from the parent version. `parent_id` is the version it started from (set by
    `saveVersion` from `current`; `save_version` refuses a parent that moved).
  - Step line: `decided: N accent(s), N transition(s), title set` (or `no title`)`, N word(s) fixed`,
    plus `, retried once` when round 2 was needed, then the runner's duration (e.g.
    `decided: 1 accent, 1 transition, title set, 1 word fixed, under a second`).
  - The row's AI columns hold the summed usage of both calls on success and on failure.
- Never cached: no fingerprint, no `recordHit`.
- `decide.test.ts` with `fakeAiRunner`, the in-memory version store and storage fakes from
  `first-version.test.ts` (seeded with the short-speech fixtures and a version 1), a fixed `newId`
  and a fake step store:
  - Verification 2: answer 1 has a title at `position: { x: 140, y: 270 }` long enough to cross the
    safe box's right edge after measuring (schema-valid, `safe-box` fails), answer 2 passes: two
    calls; `runner.prompts[1]` contains the round 1 reason; one new version (`number` 2,
    `parent_id` version 1, `model`, `prompt_version` `decide-1`, `change_summary`, `checks`
    `{ ok: true, reasons: [] }`, the parent's `inputs`); current moved to it; line ends with
    `retried once`.
  - Verification 3: two failing answers: step `failed`, `error_tail` contains `round 1:` and
    `round 2:` with both reasons; current version id unchanged; no new version row; the storage
    fake has no new key under `reels/<id>/versions/`.
  - Verification 4: `{ stdout: "not json" }` then a passing answer: two calls, version saved.
  - Verification 5: scripted usage `{ inputTokens: 1234, outputTokens: 567, costUsd: 0.0123, model: "claude-test" }`
    on one call lands exactly in the fake store's `done` AI fields; two calls are summed.
  - A glossary failure (`Locking` in a caption) counts as a failed round with the glossary reason.
  - A version-1 `model` non-null short-circuits to `already decided`; a lost lease (aborted
    signal) before the save writes nothing.
  - `used_free_field` true when the passing answer sets `custom` on an item; `free_field` and
    `unexpressed` saved as answered.

### 11. Wire into the process job

- `process-job.ts`: after `firstVersion`, `await decide({ ctx, storage, keyPrefix: config.keyPrefix, scratchDir: config.scratchDir, fingerprints, versions, ai: aiRunner() })`.
  Update the header comment. The `process` job is the only caller in this slice (no request).
- No other module imports `ai.ts` except `doctor` and `decide` (the "AI only here" rule).

### 12. The E2E fake script

- `fixtures/decide/short-speech.json`: a JSON array of one `{ output, usage }` for the short-speech
  reel (words `w0001`..`w0010`, clip about 2.69 s): the version 1 captions with one word fixed (for
  example `w0010` `studio.` shown as `studio`, listed in `fixed_words`), one accent overlay, one
  transition with a click sound, a `title` overlay from `{ at: 0 }`, `change_summary`, empty
  `unexpressed` and `free_field`, and usage `{ inputTokens: 1200, outputTokens: 340, costUsd: 0.0215, model: "claude-fake" }`.
- `apps/worker/src/decide/fixture-answer.test.ts`: loads that file and the seeded
  `fixtures/pipeline/` transcript, `retime.json` and head track, and asserts `evaluateAttempt`
  passes with no reasons, so the E2E cannot fail on a layout surprise.
- `apps/studio/test-support/worker.ts`: `runWorkerOnce` sets
  `E2E_MOCK_AI_SCRIPT: <repo root>/fixtures/decide/short-speech.json` by default (callers may
  override).

### 13. Reel page shows the current version

- `apps/studio/src/lib/reels.ts`: add `current_version_id` to `REEL_DETAIL_COLUMNS` and `ReelDetail`
  (#32 adds the same; keep one copy on merge).
- `page.tsx`: read the current version's `number` (owner RLS select on `versions`) and pass it to
  `LiveReel`. `LiveReel.tsx`: show `version N` in a line with `data-testid="current-version"`
  (nothing before version 1). When a Realtime reel update brings a new `current_version_id`, fetch
  that version's number in the update handler (no effect that syncs state) and show it.
- `apps/studio/src/lib/reels.test.ts`: the detail columns include `current_version_id`.

### 14. Extend the upload E2E

- `apps/studio/e2e/upload.spec.ts` (fails without this feature):
  - the step lines gain `/^decide: decided: 1 accent, 1 transition, title set, 1 word fixed, /`
    (match what the script produces) after `first_version`;
  - the `steps` rows gain `decide`, `status` `done`, `cache_hit` false, and `ai_input_tokens` 1200,
    `ai_output_tokens` 340, `ai_cost_usd` 0.0215, `ai_model` `claude-fake` (select those columns);
  - `getByTestId("current-version")` shows `version 2` without a reload (the `__noReload` marker
    holds);
  - the current version row is `number` 2, `parent_id` the version 1 id, `model` `claude-fake`,
    `prompt_version` `decide-1`, `request` null, `used_free_field` false, `checks.ok` true, and its
    R2 object exists; version 1 is still there, unchanged. Clean both version objects up in the
    spec's existing teardown.

### 15. Capture the real result shape (outside the tests)

- On this machine (the owner's), run once, never from a test:
  `printf 'Reply with ok set to true.' | "${CLAUDE_CODE_PATH:-claude}" -p --output-format json --json-schema '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}' --tools "" --no-session-persistence`.
- Save stdout to `apps/worker/src/decide/testdata/claude-result.json` after removing anything
  personal or secret (`session_id` replaced with a zero UUID, any path or account detail removed);
  keep the field names, the usage numbers, the cost and the model.
- Adjust `parseClaudeJson`'s field names to it and record the shape in the doc. If Claude Code
  cannot run here, do not invent a file: stop at this step and report it.

### 16. Documentation

- Create `app_docs/decide-step.md` (Overview, How it works, How to Use, Configuration, Testing,
  Rules, Notes) covering: inputs; the per-reel schema rules; the CLI call and every flag; stdin;
  the result shape (field names from step 15); the checks, the glossary post-check and the single
  retry; the error tail; what every version records (`parent_id`, `request`, `model`,
  `prompt_version`, `change_summary`, `checks`, `inputs`, `used_free_field`, `free_field`,
  `unexpressed`); the title and accent conventions; the step line; usage columns; the fake and
  `E2E_MOCK_AI_SCRIPT`; never cached. Rules: AI only in this step (and the doctor's check); exactly
  one retry, never a loop; the current version never changes on a failed decide; no tools for the
  model (`--tools ""`), the prompt never in argv; the schema is generated per reel, never static;
  `PROMPT_VERSION` changes with `prompt.md`; tests never call the real Claude Code.
- `docs/conditional-docs.md`: one line: read `app_docs/decide-step.md` when changing the decide
  step, its prompt or `PROMPT_VERSION`, the per-reel answer schema, the glossary check, the Claude
  Code call or its result parser, the AI fake or `E2E_MOCK_AI_SCRIPT`, or the version record fields
  `used_free_field`, `free_field`, `unexpressed`.
- Update in place: `app_docs/edit-model.md` (the new version columns and `save_version` signature,
  `decide.ts`, `glossary.ts`), `app_docs/measurement.md` (`input`, `timeoutMs`, `StepTailError`, AI
  columns now written), `app_docs/studio.md` (the fake script, the reel page version line),
  `app_docs/pipeline.md` (decide after `first_version`, never cached). `README.md` and
  `.adw/project.md` need no change unless a script, port or env file moved (none does). No
  em-dashes anywhere.

### 17. Run the validation commands

- Run every command in `Validation Commands` below, in order, and fix anything that fails without
  weakening a rule, type or test.

## Testing Strategy

### Unit Tests

- `packages/edit/src/decide.test.ts`: per-reel enums and bounds, Zod and exported JSON Schema both
  reject a foreign id, a time past the end, a foreign font, `x: 900`.
- `packages/edit/src/glossary.test.ts`: `Locking` fails, `lock-in` passes, `blocking` passes.
- `packages/edit/src/versions.test.ts`: the three new fields saved and restored; `used_free_field`
  derived from the edit.
- `apps/worker/src/step-runner.test.ts`: stdin, timeout, `StepTailError`, AI usage on done and failed.
- `apps/worker/src/ai.test.ts`: parser on the captured real result; `AiAnswerError` for broken JSON;
  the scripted fake and `E2E_MOCK_AI_SCRIPT`.
- `apps/worker/src/decide/prompt.test.ts`, `decide.test.ts`, `fixture-answer.test.ts` as described.
- `apps/studio/db-tests/versions.test.ts` (DB layer): `save_version` with the new parameters.

### Test Coverage

- `packages/edit/src/decide.test.ts` (unit): catches a schema that is static or lets a foreign word id, a late time, a foreign font or an out-of-box position through (Verification 1).
- `packages/edit/src/glossary.test.ts` (unit): catches a misheard glossary word left in caption text (Verification 6).
- `apps/worker/src/decide/decide.test.ts` (unit): catches a missing or repeated retry, a reason-less retry prompt, a version saved or current moved on double failure, broken JSON not retried, usage not stored exactly (Verifications 2 to 5).
- `apps/worker/src/ai.test.ts` (unit): catches a parser that does not match Claude Code's real result (Verification 7).
- `apps/worker/src/step-runner.test.ts` (unit): catches stdin, timeout, tail or AI usage not reaching the row.
- `apps/worker/src/decide/fixture-answer.test.ts` (unit): catches an E2E script that would fail the checks.
- `apps/studio/db-tests/versions.test.ts` (DB): catches `save_version` not storing the record fields.
- `apps/studio/e2e/upload.spec.ts` (E2E): catches the process job not running decide, the step line, the AI columns or version 2 not shown current (Verification 8).

### Edge Cases

- Broken JSON, or an envelope without structured output: a failed attempt, retried once.
- `is_error: true`, non-zero exit or timeout: the step fails at once (no retry), current unchanged.
- First round passes: one call, no `retried once`.
- Schema-valid answer failing only the glossary or only `face` or `sound-gap`.
- An answer that changes nothing: still a new version (the request, empty here, was answered); the
  line shows zero counts.
- An answer with `custom` on an item: `used_free_field` true; an AI that claims `free_field` without
  setting `custom` still records its list but `used_free_field` stays false.
- Many reasons per round: both rounds still visible in `error_tail` (capped per round).
- Lease lost during the call or before the save: nothing written.
- A retried process job after decide saved: `already decided`, no third version.
- `save_version` refusing a parent that moved: the step fails, nothing current changes.
- Missing cached input (transcript, retime, head track) or current version object: step fails with
  the key named.
- A transcript with one word (enum of one); a clip whose `durationSeconds` is below the last word's
  end is not expected but the bound is the clip's own duration.

## Acceptance Criteria

- A processed reel (fakes) ends with version 2 current, `parent_id` version 1, `model`,
  `prompt_version`, `change_summary`, `checks`, `inputs`, `used_free_field`, `free_field`,
  `unexpressed` recorded, and its step log shows the decide line.
- The JSON Schema passed to Claude Code is generated per reel with real `enum` lists for word ids,
  fonts, sounds and transitions and bounds for times and positions.
- Claude Code is invoked with `-p --output-format json --json-schema <schema> --tools "" --no-session-persistence`, prompt on stdin, in the job's scratch folder, through `runToolsStep`.
- Exactly one retry with the reasons; a double failure fails the step with both rounds in
  `error_tail`, no new version row or R2 object, and `current_version_id` unchanged.
- The step row holds the reported tokens, cost and model as raw numbers.
- A glossary word still heard wrong fails the post-check.
- No module other than `decide` and `doctor` calls the AI runner; tests never call Claude Code.
- `app_docs/decide-step.md` exists with a Rules section; `docs/conditional-docs.md` has its line; no
  em-dashes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared stack before `test:db` and E2E (on failure report and stop; never reset).
- `yarn turbo run lint --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: lint of the three touched workspaces.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: types (also the build check of the worker and the edit package).
- `yarn knip`: no unused files, exports or dependencies (new `decide/` modules and `ajv` reachable).
- `yarn format:check`: Prettier over the repository.
- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`: the unit layer, including every new test.
- `yarn turbo run test:db --filter=./apps/studio`: `save_version` with the new fields on the local stack.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with the reel page change.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the issue's unfiltered gates.
- `grep -rn "$(printf '\342\200\224')" app_docs docs specs apps packages supabase fixtures --include='*.md' --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.json' ; test $? -eq 1`: no em-dashes.

The E2E suites (`PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`) are run by the test
phase against the `/prepare_app` server; `upload.spec.ts` covers Verification 8.

## Notes

- Dependency: `ajv` (exact pin, latest 8.x) as a dev dependency of `packages/edit` only, for
  validating the exported JSON Schema in `decide.test.ts`:
  `yarn workspace @edit-issebya/edit add -D ajv@<exact version>`. Zod 4 (already a dependency)
  provides `z.toJSONSchema`; no other library is needed.
- No new turbo env entry: `E2E_MOCK_AI` and `E2E_MOCK_AI_SCRIPT` reach the worker only through
  `runWorkerOnce`'s explicit child env (it spawns `yarn workspace ... once`, not a turbo task).
- Merge order: this slice depends on #31 and is planned against its branch. #32 (live preview) also
  adds `current_version_id` to `REEL_DETAIL_COLUMNS`; whichever lands second keeps one copy.
- `checks` on the version is the passing round's result. The failed round 1 reasons of a retried
  success are visible in the step line (`retried once`) and the OTel logs, not on the version; if
  the owner wants them on the version, a later slice can add them.
- Change requests (slice 11) pass `request` to `decide`; nothing here reads a request yet. Waiting
  for an unavailable or logged-out AI is slice 16: here such a call fails the step.
- The pipeline cannot verify the AI's choices on real footage or the real result shape beyond the
  committed sample; the owner's manual acceptance compares version 2 with
  `rethink-work/renders/rethink-work-02.mp4` and records the step row's tokens and cost.
