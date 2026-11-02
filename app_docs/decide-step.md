# Decide Step: Claude Code with a Per-Reel JSON Schema, Layout Checks, One Retry, Version Records

**Specifications:**

- specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md

## Overview

`decide` is the pipeline's one AI step. After the six fixed steps and the automatic version 1, the
worker asks Claude Code (`claude -p`, no tools, on the owner's machine) to start from the current
version, fix misheard words, choose accent words and transitions, and set a title. The answer must
match a JSON Schema made for this reel, is checked again with Zod, built, run through the layout
checks and the glossary check, and becomes a new version (version 2 on a fresh reel). A refused
answer goes back once with the reasons; a second refusal fails the step and leaves the current
version untouched.

## How it works

The answer is tracks only plus three short fields:
`{ tracks, change_summary, unexpressed: string[], free_field: { item, reason }[] }`. `format`,
`preset`, `duration` and `inputs` come from the current version, so the result is always a full edit
and the AI cannot touch the input fingerprints. By convention the title is the overlay with id
`title`, anchored at `{ reel: "start" }`.

- `packages/edit/src/decide.ts`: `decideAnswerSchemaFor(preset, transcript, duration)` (word-id
  enums from the reel's transcript, `{ time }` anchors capped at the clip's end, positions inside
  the preset's safe box, fonts and transition types from the preset), `decideJsonSchema` (Zod 4
  `z.toJSONSchema`, draft 2020-12, real `enum` lists, every object closed, refs inlined),
  `parseDecideAnswer`, `editFromAnswer` (the answer's tracks over the current version, parsed with
  the decide limits), `decideCounts` (the step line) and `usedFreeField`.
- `packages/edit/src/schema.ts`: `editSchemaFor` and the new `tracksSchemaFor` take optional
  `EditLimits { duration, bounds }`; without them stored versions keep parsing with the default
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
  non-object value or non-JSON throws.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`: the committed prompt and `PROMPT_VERSION`
  (`decide-1`, bumped with every prompt change; each version row records it). `decidePrompt` fills
  the inputs as fenced JSON and, on the retry, appends the previous reasons.
- `apps/worker/src/decide/input.ts`: the prompt input: current edit, transcript with ids, head
  track summary, preset with glossary, and the request.
- `apps/worker/src/decide/run-decide.ts`: `runDecide`, a `runToolsStep` named `decide`. It reads
  the current version and its inputs, builds the schema, and makes at most two calls, never a
  loop. An attempt passes only when the JSON parses, the schema accepts it, `editFromAnswer`
  accepts it, `build` reports no checks and `glossaryChecks` reports none. It saves through
  `saveVersion` with `parentId` the current version, the request (null for the automatic run),
  model, `PROMPT_VERSION`, the change summary, and the records below. Step line:
  `version 2: 1 accent, 1 transition, title set, 1 word fixed`.
- `apps/worker/src/process-job.ts`: runs `runDecide` after `saveFirstVersion`. Never cached: a
  retried job decides again from the then-current version.
- `apps/worker/src/step-runner.ts`: `ToolCall` gains `stdin` and `maxStdoutBytes`; `ToolsStep.work`
  may return `ai` usage; `StepError(message, tail, ai)` fails a step with its own tail (the
  reasons) and the AI usage spent. `apps/worker/src/step-store.ts` writes the `ai_*` columns
  (`aiMeasurements`).
- `apps/worker/src/doctor-checks.ts`: the `ai structured call` check uses the new runner
  (`plainTool`).
- `supabase/migrations/20261101175625_version_decide_records.sql`: `versions` gains
  `used_free_field`, `unexpressed` (requests the format could not express), `free_field` (items
  that needed the `style` field and why) and `rejected_reasons` (why the first answer was refused
  when a retry was needed; empty when it passed). `save_version` is replaced by a signature with
  four more parameters that default, so every existing caller stays valid. Mirrored in
  `NewVersion`/`VersionMeta` (`packages/edit/src/versions.ts`) and `supabaseVersionRows`.

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
  written on failure) and `step-runner.test.ts` (stdin, cap, `StepError`).
- `decide/testdata/short-speech-answer.json` is the scripted answer for the fixture clip; a unit
  test proves it passes the checks.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` covers the new columns.
- E2E: `apps/studio/e2e/upload.spec.ts` sets `E2E_MOCK_AI_SCRIPT` to the committed answer and
  checks the decide line, the `ai_*` columns (1500, 456, 0.0123, `claude-opus-5-5`), version 2's row
  and both R2 keys. `preview.spec.ts` seeds through `test-support/ai-script.ts`
  (`unchangedAnswerScript`), whose answer repeats version 1's tracks, so version 2 matches the
  version 1 golden.

## Rules

- At most two AI calls per decide: one retry, never a loop.
- Never give Claude Code tools or a saved session (`--tools ""`, `--no-session-persistence`).
- Never let the answer carry `format`, `preset`, `duration` or `inputs`.
- Never write a version or R2 key for a refused answer; the current version stays.
- Never cache the decide step.
- Bump `PROMPT_VERSION` whenever `prompt.md` changes.
- Record raw usage numbers as Claude Code reports them; never convert or estimate.
- Never point a test at the real `claude` binary; use the double.

## Notes

- Touches `app_docs/edit-model.md` (new check rule, version columns, `save_version` signature),
  `app_docs/measurement.md` (the `ai_*` columns are now written by decide) and `app_docs/studio.md`
  (`E2E_MOCK_AI_SCRIPT`); those still describe the AI as only a doctor check in places.
- `request` is null for the automatic run. The owner-request path now exists: a `change` job runs
  `runDecide` with `job.request` (see `app_docs/change-requests.md`).
