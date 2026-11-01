# Decide step

**Specifications:**

- specs/issue-33-adw-48ca5f11-sdlc_planner-decide-step-claude-schema.md

## Overview

`decide` is the studio's one AI step. After the six fixed pipeline steps and the automatic version
1 (`first_version`), the worker asks Claude Code to fix misheard words and choose the accent words,
the transitions and the title, starting from the reel's current version. The answer must match a
JSON Schema generated for this reel and pass the builder's checks and a glossary check; a bad answer
goes back once with the reasons, and a bad second answer fails the step without touching the reel's
current version. A good answer is saved as a new current version that records how it was made.

## How it works

The `process` job runs `decide` after `first_version` (`apps/worker/src/process-job.ts`). It runs
inside `runToolsStep`, so it gets a `steps` row, measurements and an OpenTelemetry span like every
other step. It is never cached: no fingerprint, no `cache_hit`.

Inputs, read in the worker:

- the current version (`versions.current`, then its object at `r2_key`), parsed with `parseEdit`;
  none is the error `decide: no current version`;
- the retimed `transcript.json` and `retime.json` (`durationSeconds` is the clip length) and the
  `head-track.json`, from the R2 cache by fingerprint, like `first_version`;
- the `ISSEBYA` preset (safe box, fonts, colours, sounds, transitions, glossary, `minSoundGap`).

If the current version already has a `model` or a `prompt_version` (an AI version exists, for
example the job was retried after decide saved) and there is no request, the step writes nothing and
its line is `version N already decided`.

The per-reel schema (`packages/edit/src/decide.ts`):

- `decideAnswerSchema(context)` is a Zod 4 `strictObject` built for one reel from a `DecideContext`
  (`transcript`, `preset`, `clipDuration`). It mirrors the edit format but closes every list: word
  ids are an enum of this transcript's ids (in `captions[].words`, every word anchor and
  `fixed_words[].word`), a time anchor `at` is `0..clipDuration`, a word anchor `offset` is
  `-0.5..0.5`, `style.font`, `sound` and transition `type` are enums of the preset's keys and
  types, `style.color` is a preset colour key or `#RRGGBB`, and `style.position` is inside the
  safe box. `custom` stays as the free field with the character rule of `schema.ts`.
- The answer is `{ tracks, change_summary (1..300), fixed_words: { word, heard, text }[],
unexpressed: string[], free_field: { item, why }[] }`. `inputs` is not part of it: the worker
  copies the parent version's fingerprints (the AI never changes them).
- `decideJsonSchema(context)` is the same schema as JSON Schema (draft 2020-12 keywords, `$schema`
  removed) via `z.toJSONSchema`, with real `enum` lists and `minimum`/`maximum` bounds and the word
  ids once under `$defs.wordId`. It throws when the transcript has no words.
- `editFromAnswer(answer, inputs)` is the full `Edit`; `answerCounts(answer)` feeds the step line.
- Title convention: the overlay whose id is `title`. Every other overlay is an accent.

The call (`apps/worker/src/ai.ts`):

- `claudeRunner` runs `claude -p --output-format json --json-schema <schema> --tools ""
--no-session-persistence` (binary from `CLAUDE_CODE_PATH`, default `claude`) through the step's
  `Tool`, with no shell. The prompt goes on stdin, never in argv. The working folder is
  `<scratchDir>/job-<job id>/decide/`, created for the call and removed in `finally`. The timeout is
  10 minutes (`DECIDE_TIMEOUT_MS`).
- `parseClaudeJson` reads the result envelope (a sample is in
  `apps/worker/src/decide/testdata/claude-result.json`). The answer is `structured_output`, else
  `JSON.parse(result)`. Usage: input tokens are `usage.input_tokens` plus
  `usage.cache_creation_input_tokens` plus `usage.cache_read_input_tokens`, output tokens are
  `usage.output_tokens`, cost is `total_cost_usd`, the model is the `modelUsage` key (keys joined
  with `,` when more than one). A missing number is `null`, never `0`.
- An unreadable answer (envelope or answer not JSON, no structured output) throws `AiAnswerError`,
  which `decide` counts as a failed attempt. `is_error: true`, a non-zero exit or a timeout throws a
  plain error and fails the step at once, with no retry.

The prompt (`apps/worker/src/decide/prompt.ts`, `prompt.md`): `prompt.md` followed by `## Input`
with one canonical JSON object: `current_edit` (tracks), `transcript` (id, text, start, end),
`head_track` (`headTrackSummary`: per half second, the head's `top`, `left`, `right` in whole
pixels, or `null`), `preset` (frame, safe box, fonts, colours, sounds, transitions, glossary,
`minSoundGap`) and `request` (`null` for the first edit). `PROMPT_VERSION` (`decide-1`) names the
prompt a version was made with. `retryPrompt` appends `## Your previous answer failed these checks`,
one reason per line, and "Answer again with the full answer."

The checks (`apps/worker/src/decide/attempt.ts`, `evaluateAttempt`), in order: the per-reel Zod
schema (`schema: <path>: <message>`), `parseEdit` against the transcript and preset, `build` and its
checks (`safe-box`, `face`, `sound-gap`), then `glossaryCheck` (`packages/edit/src/glossary.ts`): a
caption, overlay or transition text holding a glossary `heard` variant as a whole word, any case,
gives `<item id>: glossary: "<as written>" should be "<term>"`. A passing attempt has no reasons.

Retry and failure (`apps/worker/src/decide/decide.ts`): one call; if it fails, exactly one more call
with `retryPrompt`; never a loop. Two failures throw a `StepTailError` whose tail is
`decide failed twice`, `round 1: ...`, `round 2: ...` (each round capped at 8 reasons of 200
characters, then `and N more`), so both rounds fit the 20 lines and 4096 bytes of `error_tail`.
Nothing is written to R2 or `versions`, and `current_version_id` does not move.

Saving: a passing answer goes through `saveVersion` with the lease-guarded wrappers
(`apps/worker/src/steps/version-io.ts`, shared with `first_version`), a lost lease before the save
writes nothing. The new version records `parent_id` (the version decide started from; `save_version`
refuses a parent that moved), `request`, `model`, `prompt_version`, `change_summary`, `checks` (the
passing round's), `inputs` (the parent's), and the three fields added by
`supabase/migrations/20261106090000_decide_versions.sql`: `used_free_field` (computed by the worker
from the saved edit: any item with `custom`, never from the AI's claim), `free_field` (the AI's
`{ item, why }` list) and `unexpressed` (requests the format could not express). Version 1 and
restores carry the defaults or copy them from the restored version.

The step row and line: `ai_input_tokens`, `ai_output_tokens`, `ai_cost_usd` and `ai_model` hold
the summed usage of every call that returned, as raw numbers, on success and on failure
(`runToolsStep`'s `reportAi`, `StepStore.done`/`failed`). The line is
`decided: N accent(s), N transition(s), title set` (or `no title`)`, N word(s) fixed`, plus
`, retried once` when round 2 was needed, then the runner's duration.

The step runner (`apps/worker/src/step-runner.ts`) gained what decide needs: `ToolCall.input` (stdin,
then closed), `ToolCall.timeoutMs` (SIGTERM then SIGKILL, fails with `timed out after N s`),
`StepTailError` (a step sets its own error tail) and the `ai` reporter.

The reel page shows the current version: `LiveReel` renders `version N`
(`data-testid="current-version"`, nothing before version 1) and follows a new
`current_version_id` from Realtime by reading that version's number
(`apps/studio/src/lib/reels.ts`, `versionNumberOf`).

- `packages/edit/src/decide.ts`: per-reel Zod and JSON Schema, `editFromAnswer`, `answerCounts`.
- `packages/edit/src/glossary.ts`: `glossaryCheck`.
- `packages/edit/src/versions.ts`, `supabase-versions.ts`: the three new record fields.
- `apps/worker/src/decide/decide.ts`: the step, the single retry, the save.
- `apps/worker/src/decide/attempt.ts`: one answer through every check.
- `apps/worker/src/decide/prompt.ts`, `prompt.md`: the prompt, `PROMPT_VERSION`.
- `apps/worker/src/ai.ts`: Claude Code call, result parser, scripted fake.
- `apps/worker/src/doctor-checks.ts`: the only other AI caller (`{ ok: true }` check).
- `fixtures/decide/short-speech.json`: the fake's scripted answer and usage for the E2E reel.

## How to Use

1. Upload a reel in the studio. The worker's `process` job runs the six fixed steps, `first_version`
   (version 1), then `decide`.
2. Open the reel page: the step log shows the `decide` line, and the edit line shows `version 2`
   when the AI's answer passed.
3. On a failed `decide`, open the step's collapsed error tail: it names both rounds' reasons. The
   reel stays on version 1.
4. A change request (a later slice) passes `request` to `decide`; nothing reads one yet.

## Configuration

- `CLAUDE_CODE_PATH`: the `claude` binary (default `claude`); the owner's machine must be logged in.
- `E2E_MOCK_AI=true`: the AI double instead of Claude Code.
- `E2E_MOCK_AI_SCRIPT`: with the double, a JSON array of scripted answers
  (`{ output, usage? }` or `{ stdout }`, played in order, the last repeated; a relative path is from
  the repository root). Empty gives `{ ok: true }` for the doctor. `runWorkerOnce` in
  `apps/studio/test-support/worker.ts` sets it to `fixtures/decide/short-speech.json` by default.
  Both reach the worker through `runWorkerOnce`'s child env, so `turbo.json` needs no entry.

## Testing

- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker --filter=./apps/studio`:
  `decide.test.ts` and `glossary.test.ts` in `packages/edit` (the exported JSON Schema is also
  checked with `ajv`), `ai.test.ts` (parser on the captured result, `AiAnswerError`, the scripted
  fake), `step-runner.test.ts` (stdin, timeout, `StepTailError`, AI usage), and in
  `apps/worker/src/decide/` `prompt.test.ts`, `decide.test.ts` (retry, double failure, broken JSON,
  usage, glossary, `already decided`, lost lease) and `fixture-answer.test.ts` (the E2E script
  passes every check on the seeded fixtures).
- `yarn turbo run test:db --filter=./apps/studio`: `save_version` stores the new fields and refuses a
  non-array `p_unexpressed` (needs `supabase migration up --local`).
- `apps/studio/e2e/upload.spec.ts`: the decide step line, the AI columns, version 2 current without
  a reload, and the version 2 row and object.

## Rules

- AI is called only from `decide` (and the doctor's check). No other module imports `ai.ts`.
- Exactly one retry, never a loop.
- The reel's current version never changes on a failed decide; a failed round writes no object and
  no row.
- The model gets no tools (`--tools ""`), and the prompt never appears in argv.
- The schema is generated per reel from its own transcript, clip length and preset, never a static
  one.
- Change `PROMPT_VERSION` in the same commit as any edit of `prompt.md`.
- `used_free_field` is computed from the saved edit, never taken from the AI.
- Tests never call the real Claude Code.

## Notes

- `checks` on a version is the passing round's result. Round 1's reasons of a retried success show
  only as `retried once` in the step line and in the OpenTelemetry logs.
- Waiting for an unavailable or logged-out AI is a later slice: here such a call fails the step.
- Also touches `app_docs/edit-model.md` (new `versions` columns, `save_version` signature,
  `decide.ts`, `glossary.ts`), `app_docs/measurement.md` (`input`, `timeoutMs`, `StepTailError`, AI
  columns now written), `app_docs/studio.md` (the fake script, the version line on the reel page)
  and `app_docs/pipeline.md` (decide after `first_version`, never cached).
- The branch also carries `supabase/migrations/20261105090000_preview_copies_fingerprint.sql`,
  copied unchanged from the live preview branch so the shared local stack's history matches.
