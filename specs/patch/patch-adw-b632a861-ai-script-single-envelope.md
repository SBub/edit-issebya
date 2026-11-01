# Patch: accept a single result envelope as the AI double's script

## Metadata

adw_id: `b632a861`
review_change_request: `Issue #1: upload.spec.ts fails because E2E_MOCK_AI_SCRIPT points at decide/testdata/short-speech-answer.json, one Claude result envelope (a JSON object), while scriptFrom in apps/worker/src/ai.ts only accepts a non-empty JSON array. The decide step throws before calling the AI, the job fails, and the reel never gets version 2 or the decide line. Make the script loader and the committed E2E answer agree, then re-run PORT=9209 STUDIO_PORT=9109 yarn test:e2e and confirm upload.spec.ts passes (decide line, decide row ai_* numbers 1500, 456, 0.0123, claude-opus-5-5, version 2 row). Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-33-adw-b632a861-sdlc_planner-ai-decide-step.md`
**Issue:** `scriptFrom` (`apps/worker/src/ai.ts:156`) refuses anything but a non-empty JSON array. The committed answer `apps/worker/src/decide/testdata/short-speech-answer.json` is a single envelope object, and `upload.spec.ts` passes its path straight through as `E2E_MOCK_AI_SCRIPT`. The worker's `once` throws `... must be a non-empty JSON array`, so the job fails before decide. `run-decide.test.ts` hides this because it wraps the file in `fakeAiRunner([answer])` itself. `upload.spec.ts:218` also reads the same file as an object (`script.structured_output.change_summary`), so the file must stay an object.
**Solution:** Option (a): `scriptFrom` treats a single JSON object as a one-entry script (wraps it in an array). An empty array, a non-object non-array value (string, number, null, boolean) and non-JSON still throw with a clear message. A new `ai.test.ts` case loads the committed `short-speech-answer.json` through `aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: <path> })`, so the file loader and the committed answer are tested together. No change to the spec, the testdata file or `ai-script.ts` (its comment, "one Claude Code result envelope", becomes accurate as is).

## Files to Modify

- `apps/worker/src/ai.ts` (`scriptFrom` and the comment above `aiRunner`)
- `apps/worker/src/ai.test.ts` (two new cases)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Accept a single object in `scriptFrom`

- In `apps/worker/src/ai.ts`, after `JSON.parse`, replace the array-only check with:
  - if `Array.isArray(script)`: throw `E2E_MOCK_AI_SCRIPT ${path} must be a non-empty JSON array or one result envelope` when it is empty, else return it;
  - else if `script !== null && typeof script === "object"`: return `[script]`;
  - else throw the same message.
- Update the comment above `aiRunner` to say the script is a JSON array of answers replayed in order (the last repeating) or one envelope object, used for every call.

### Step 2: Cover the loader with the committed answer and the refusals

- In `apps/worker/src/ai.test.ts`, inside `describe("aiRunner", ...)`:
  - add `it("loads the committed decide answer, one envelope, as a one-entry script", ...)`: resolve the path with `fileURLToPath(new URL("./decide/testdata/short-speech-answer.json", import.meta.url))` (import `fileURLToPath` from `node:url`), call `aiRunner({ E2E_MOCK_AI: "true", E2E_MOCK_AI_SCRIPT: path }).call(NEVER, REQUEST)` twice, and expect both results to have `kind: "answer"` and an `answer` equal to the file's `structured_output` (read with `readFileSync`, already imported), plus the envelope's measurements as `parseClaudeResult` reports them (assert with `toMatchObject` on the fields `parseClaudeResult` returns for this file: check the existing `parseClaudeResult` tests for the field names, and match the ai_* values the E2E asserts: 1500, 456, 0.0123).
  - extend `it("throws on a missing or malformed script file", ...)`: write `[]`, `"text"` (a JSON string) and `not json` to temp files and expect each to throw `/E2E_MOCK_AI_SCRIPT .* must be a non-empty JSON array or one result envelope/` (the first two) and `/E2E_MOCK_AI_SCRIPT .* is not JSON/` (the third). Make the test `async` for the `writeFile` calls and keep the existing eslint-disable comments on each fs call.

### Step 3: Run the gates and the E2E suite

- Run the Validation commands below in order. Fix any failure properly (never weaken a test).
- For the E2E run, the server must already be up on this run's port, started with the profile's Workspaces dev command; reuse it, never start another or set `CI=1`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check && yarn lint && yarn typecheck && yarn knip`
- `yarn turbo run test --filter=./packages/edit --filter=./apps/worker` then `yarn test`
- `yarn turbo run test:db --filter=./apps/studio` and `yarn build`
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` (here `PORT=9209 STUDIO_PORT=9109`): must exit 0, with `apps/studio/e2e/upload.spec.ts` passing, including the `decide: version 2: 1 accent, 1 transition, title set, 1 word fixed, ...` step line, the decide row's `ai_*` columns (1500, 456, 0.0123, `claude-opus-5-5`) and version 2's row; `preview.spec.ts` still passes.
- `grep -rn $'\u2014' apps/worker/src/ai.ts apps/worker/src/ai.test.ts specs/patch/patch-adw-b632a861-ai-script-single-envelope.md`: must print nothing.

## Patch Scope

**Lines of code to change:** about 35 (8 in `ai.ts`, 25 in `ai.test.ts`)
**Risk level:** low
**Testing required:** worker unit tests for the loader (committed envelope, empty array, non-object, non-JSON), the full unit and DB layers, build, and the full E2E suite with `upload.spec.ts` green end to end.
