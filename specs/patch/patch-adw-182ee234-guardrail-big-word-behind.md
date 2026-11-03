# Patch: score a big word behind the speaker in the preview-matches-export guardrail

## Metadata

adw_id: `182ee234`
review_change_request: `Issue #1: Spec step 12 and the acceptance criterion 'Preview and export of a version with one photo and one big word match (guardrail at the existing bound)' require the guardrail (apps/studio/e2e-tools/export-matches-preview.spec.ts) to add a version with one top photo and one big word and to score frames inside both spans. The behind case only uses behindPhotoAnswerScript, which writes a single kind: "photo" item. No kind: "word" item appears in the guardrail, so nothing checks that the big word matches between preview and export. render.tools.test.ts renders a word, but it compares export against export only. Resolution: Fixable on this branch. Give the guardrail's behind case one top photo plus one big word, each 2 to 4 s and not overlapping (extend behindPhotoAnswerScript or add a behindWordAnswerScript in apps/studio/test-support/ai-script.ts). Pick MOMENTS so at least one frame falls inside each item's span. Keep the probe scoring at least one frame below the bound. Re-run PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools and record the word moments' scores in app_docs/export.md. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md`

**Issue:** The guardrail's behind case (`apps/studio/e2e-tools/export-matches-preview.spec.ts`,
"a photo behind the speaker matches between preview and export") exports only a `kind: "photo"`
item. No `kind: "word"` item is ever compared preview against export, so the acceptance criterion
"Preview and export of a version with one photo and one big word match" is unchecked.

**Measured constraint (do not re-derive):** the guardrail's reel is seeded from
`fixtures/pipeline/` (the `short-speech.mp4` clip, 2.785986 s). Its transcript runs from w0001
(0.038 s) to the end of w0010 (2.605 s), 2.567 s of speech. `ISSEBYA_PRESET.behind` requires each
item to last 2 to 4 s (`minSeconds: 2`, `maxSeconds: 4`) with no two items overlapping, so a
single version holding a photo **and** a big word needs at least 4 s and is refused by
`parseEdit` on this clip. No longer fixture has committed pipeline outputs (`short-person.mp4` is
4.0 s but has none, and must never be touched). One version with both items is therefore not
possible on this reel; the reviewer's "each 2 to 4 s and not overlapping" cannot be met inside one
version. `render.tools.test.ts` already handles the same limit by rendering the photo and the word
as two versions over the same span.

**Solution:** Cover the big word in the guardrail's behind case as a second change version, the
same way the render tools test does: after the photo and its probe, a scripted change puts one big
word (`WORK`) behind the speaker over w0001 to the end of w0010 (2.567 s, inside 2 to 4 s). All
three `MOMENTS` (0.5, 1.5, 2.5 s) fall inside that span (and inside the photo's identical span), so
every scored frame of each version is inside its item. The word version is exported with the real
render and the real mask, and every frame must score at or above `PREVIEW_EXPORT_SSIM_BOUND`
(0.9855, unchanged). The existing photo probe (60 px lower) stays and must still score at least one
frame below the bound. The spec comment and `app_docs/export.md` state why the photo and the word
are two versions, and the word's scores are recorded.

## Files to Modify

Use these files to implement the patch:

- `apps/studio/test-support/ai-script.ts`: add `behindWordAnswerScript`, sharing the envelope
  writing with `behindPhotoAnswerScript`.
- `apps/studio/e2e-tools/export-matches-preview.spec.ts`: export and score the big word version in
  the behind case; update the case's comment.
- `app_docs/export.md`: acceptance line and the measured scores table get the big word column.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Add `behindWordAnswerScript` in `apps/studio/test-support/ai-script.ts`

- Extract the shared body of `behindPhotoAnswerScript` into a private helper
  `writeBehindAnswer(dir, item, changeSummary)`: reads `SHORT_SPEECH_ANSWER`, sets
  `structured_output.tracks.behind = [item]` and `change_summary`, writes
  `behind-answer-<uuid>.json` into `dir` (keep the existing eslint disable comments), returns the
  path. `behindPhotoAnswerScript` keeps its signature and output exactly and calls the helper.
- Add and export
  `behindWordAnswerScript(dir: string, text: string): Promise<string>`, writing one item
  `{ id: "behind-word", kind: "word", text, start: { word: "w0001" }, end: { word: "w0010", edge: "end" } }`
  with change summary `put the word ${text} behind me`. Comment: one big word behind the speaker
  over w0001 to the end of w0010 (about 2.6 s), the photo's span, since the clip is too short for
  two 2 to 4 s items in one version.
- The export is consumed by the spec in Step 2, so `yarn knip` stays clean.

### Step 2: Score the big word in the guardrail's behind case

- In `apps/studio/e2e-tools/export-matches-preview.spec.ts`, import `behindWordAnswerScript`
  beside `behindPhotoAnswerScript`.
- Inside the existing `try` of "a photo behind the speaker matches between preview and export",
  after the photo probe's assertion, add:
  `const wordId = await changeTo(await behindWordAnswerScript(dir, "WORK"), "the word WORK behind me");`,
  `await openPreview(wordId);`, `const wordPreviews = await capturePreview("behind-word");`,
  `const { mp4: wordMp4 } = await exportNow("behind-word");`, then assert every score of
  `await scores("behind-word", wordMp4, wordPreviews)` is
  `toBeGreaterThanOrEqual(PREVIEW_EXPORT_SSIM_BOUND)`.
- Rename the test to "a photo and a big word behind the speaker match between preview and export".
- Rewrite the comment above `changeTo`: the photo (`top` spot) and the big word are each 2.567 s
  over the whole speech, as two versions, because the fixture's speech (0.038 to 2.605 s) is too
  short for two non-overlapping 2 to 4 s items in one version; every `MOMENT` is inside both
  spans; the photo moved by 60 px is the probe. Remove the sentence saying the big word is covered
  only by the worker's render tools test.
- Do not change `PREVIEW_EXPORT_SSIM_BOUND`, `MOMENTS`, `PROBE_SHIFT_PX`, the real mask
  (`E2E_MOCK_MASK: ""`) or the real render. If the word scores below the bound, find the cause in
  the measurement or the composite (for example the big word's font loading differently in the
  preview and the render) and fix it in our code; never loosen the case or the bound.
- The `finally` block's `cutout` `stored_files` sweep already collects the word version's mask.

### Step 3: Run the guardrail and record the scores in `app_docs/export.md`

- Run the guardrail (Validation, command 6) and read the `behind-word: SSIM ...` line, plus the
  `behind` and `behind-probe` lines.
- In "Preview matches export guardrail", extend the Acceptance bullet: every frame of the photo
  behind the speaker and of one big word behind the speaker (`WORK`, a second version over the same
  span, since the fixture speech is too short for both in one version) scores at or above the
  bound; the probes as before.
- Add a `Big word behind` column to the composition-box scores table with the measured values at
  0.5, 1.5 and 2.5 s; update the photo columns if this run's values differ. No em-dashes.

## Validation

Execute every command to validate the patch is complete with zero regressions. From the worktree
root, with `.ports.env` sourced (`set -a; . ./.ports.env; set +a`) and the `/prepare_app` server
already up on this run's port.

1. `yarn turbo run lint --filter=./apps/studio`
2. `yarn turbo run typecheck --filter=./apps/studio`
3. `yarn knip && yarn format:check`
4. `yarn turbo run test --filter=./apps/studio`
5. `yarn turbo run build --filter=./apps/studio`
6. `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio test:tools`: all four
   cases pass; `behind-word` scores at or above 0.9855 at 0.5, 1.5 and 2.5 s, and `behind-probe`
   has at least one frame below 0.9855.

## Patch Scope

**Lines of code to change:** about 60 (ai-script.ts about 25, spec about 20, export.md about 15)
**Risk level:** low
**Testing required:** the studio's tool test (real HyperFrames, real `vseg` mask) on the owner's
Mac, plus lint, typecheck, knip, format, unit and build for the studio.
