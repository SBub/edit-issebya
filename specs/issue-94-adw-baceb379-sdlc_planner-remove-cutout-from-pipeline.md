# Chore: remove the cut-out from the pipeline and the built page until it returns on demand (#20)

## Metadata

issue_number: `94`
adw_id: `baceb379`
issue_json: `{"number":94,"title":"feat: remove the cut-out from the pipeline and the built page until it returns on demand (#20)"}`

## Chore Description

The pipeline's `remove_background` step cuts the speaker out of the whole retimed clip with
HyperFrames' u2net (7 min 45 s on the first real 52 s reel), and `preview_copies` spends more time
making a small copy of that cut-out. Nothing visible uses it: every built page stacks `footage`
(track 1), `cutout` (track 30), then captions, overlays and transitions (40 and up), and nothing can
sit between footage and cut-out. The owner decided (2026-11-02) to remove it; #20 brings it back on
demand, only for moments where something is placed behind the speaker.

After this chore:

1. The process job's steps are `check_footage`, `convert`, `transcribe`, `retime`, `head_track`,
   `preview_copies`, `first_version`, `decide`. No `remove_background` step, no
   `removing_background` reel status written.
2. `preview_copies` makes `footage-preview.mp4` only (new step version).
3. The edit format no longer requires a cut-out: `inputs.cutout` and `tracks.cutout` are optional.
   `first_version` (the baseline) writes neither. The decide answer schema has no `cutout` track.
   Stored versions that name a cut-out still parse.
4. The shared builder (`packages/edit` `build`) never emits a cut-out `<video>` or a `cutout`
   asset, even for a stored version naming one. Goldens regenerated.
5. The studio (preview sources, preview page, progress) and the worker's render, storage records
   and slimming handle reels with and without a stored cut-out.
6. `fixtures/pipeline/` regenerated with `fixtures:pipeline`.
7. Docs updated.

### The `head_track` conflict, and how this plan resolves it

The issue says "`head_track` keeps its current input", but its current input **is** the cut-out:
`apps/worker/src/pipeline/head-track-step.ts` declares `remove_background/subject.webm` as its only
input and the tracker (`head-track.ts`) reads the alpha channel of each frame (topmost opaque rows
are the head). The head track is load-bearing: `packages/edit` `layoutText` and `runChecks` keep
captions off the face (`faceBox`), and the decide prompt gets a head-track summary. So the step
cannot simply lose its input, and keeping the whole-clip cut-out defeats the chore.

Resolution (smallest change that keeps the head-track format, model and analysis identical):
`head_track` makes its own **sampled** person mask. It reads the retimed footage
(`retime/source.mp4`, the input `remove_background` had), lets ffmpeg keep only the frames it
analyses (one every `sampleSeconds` = 0.25 s, scaled to the analysis size 270x480, the same `fps`
and `scale` filter it already applies when decoding), runs the worker's existing HyperFrames entry
(`remove-background-entry.ts`, same pinned `u2net_human_seg` model, same `--device auto --quality
balanced`) on that small clip into a scratch VP9-alpha WebM, and decodes that exactly as today. About
4 frames per second of footage instead of 30, at 270x480 instead of 1080x1920: roughly a tenth of
the old cost, and no stored cut-out. The mask is a scratch file, deleted in the step, never
uploaded. `head-track.json`'s format is unchanged. This is flagged in Notes for the owner.

## Relevant Files

Use these files to resolve the chore:

Docs and profile

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, Protected (never touch
  `fixtures/footage/short-person.mp4`, never start the worker, no em-dashes, no trailers).
- `docs/conditional-docs.md`: matches `app_docs/pipeline.md`, `app_docs/edit-model.md`,
  `app_docs/preview.md`, `app_docs/export.md`, `app_docs/status.md`, `app_docs/storage.md`,
  `app_docs/decide-step.md`, `app_docs/dashboard.md`, `app_docs/studio.md`.
- `app_docs/pipeline.md`: the steps, statuses, retention tags, head-track format, fixtures, and the
  rule "Background removal stays on HyperFrames' current u2net model ... until issue #20" to replace.
- `app_docs/edit-model.md`: inputs and tracks, `hidesCutout` on `panel`, asset roles, baseline.
- `app_docs/preview.md`: `reels.preview_copies` shape, signed URLs, page transform, test 2 (clock
  held while the cut-out is held).
- `app_docs/export.md`: render downloads footage and cut-out.
- `app_docs/status.md`: progress steps (`remove_background`, `render`), parsers, rules.
- `app_docs/storage.md`: slimming of `remove_background`'s `subject.webm`, HyperFrames environment.
- `app_docs/decide-step.md`: preset summary (`hides_cutout`), `PROMPT_VERSION` rule (bump only when
  `prompt.md` changes; it does not here).

Worker (`apps/worker`)

- `src/pipeline/definition.ts`: `PIPELINE`, `retentionOf` (must keep classifying retired outputs).
- `src/pipeline/remove-background.ts`: the step to remove; its entry path, args, settings and result
  parser are reused by `head_track`.
- `src/pipeline/remove-background-entry.ts`: HyperFrames' `removeBackground` wrapper, kept (used by
  `head_track`).
- `src/pipeline/remove-background.test.ts`: tests of the reused helpers; the step test goes.
- `src/pipeline/head-track-step.ts`, `head-track-step.test.ts`, `head-track.ts`: new input and run.
- `src/pipeline/preview-copies.ts`, `preview-copies.test.ts`: footage copy only.
- `src/pipeline/run-pipeline.test.ts`: step order, fake HyperFrames, hit/miss sequences.
- `src/pipeline/definition.test.ts`: step names, statuses, retention tags, fingerprints.
- `src/pipeline/cutout.tools.test.ts`, `tools-test-support.ts`: owner's-Mac tool tests.
- `src/pipeline/pipeline-fixtures.test.ts`, `src/make-pipeline-fixtures.ts`: fixtures vs definition.
- `src/preview-copies-record.ts`, `.test.ts`: refs `{ footage }` only.
- `src/first-version.ts`, `first-version.test.ts`: inputs without a cut-out.
- `src/step-store.ts`: `PipelineReelStatus` loses `removing_background`.
- `src/progress-parsers.ts`, `.test.ts`, `src/progress-testdata/remove-background.txt`: the parser
  now drives `head_track`'s progress.
- `src/render/render-step.ts`, `render-project.ts`, `render-call.ts` (comment),
  `render-step.test.ts`, `render-project.test.ts`, `render-test-support.ts`, `render.tools.test.ts`.
- `src/stored-files.ts`, `stored-files.test.ts`, `slimming.test.ts`: old keys still classified.
- `src/ai.ts` (`EMPTY_DECIDE_ANSWER`), `src/decide/input.ts` (`hides_cutout`),
  `src/decide/prompt.test.ts`, `src/decide/testdata/short-speech-answer.json`.
- `src/doctor-checks.ts`: comment on the libvpx-vp9 decoder (still needed by `head_track`).
- `apps/worker/README.md`: if it lists the steps.

Edit package (`packages/edit`)

- `src/schema.ts`: `editInputsSchema`, `tracksSchemaFor`, `refineEdit`.
- `src/decide.ts`: answer schema without `cutout`, `usedFreeField`.
- `src/build.ts`: `AssetRole`, `clip`, `hidesCutout` loop, `assetsOf`.
- `src/preset.ts`: `hidesCutout` removed.
- `src/checks.ts`, `src/timeline.ts`, `src/baseline.ts`: optional `tracks.cutout`; baseline writes none.
- `src/test-support/inputs.ts`: `baselineInputs` without a cut-out.
- `src/baseline.test.ts`, `build.test.ts`, `schema.test.ts`, `decide.test.ts`, `glossary.test.ts`,
  `checks.test.ts`, `versions.test.ts`, `build.browser.test.ts`.
- `src/testdata/versions/rethink-work-hand.edit.json`: stays as is (a stored version naming a
  cut-out); `baseline-short-speech.edit.json` and both `golden/*.html` regenerated by
  `yarn workspace @edit-issebya/edit golden`.

Studio (`apps/studio`)

- `src/lib/preview-sources.ts`, `.test.ts`: `parsePreviewCopies` accepts `{ footage, cutout? }`,
  keys and URLs have no cut-out.
- `src/app/preview-actions.ts`, `src/components/ReelPreview.tsx`, `src/lib/preview-page.ts`,
  `.test.ts`: footage URL only.
- `src/lib/progress.ts`, `.test.ts`: `PROGRESS_STEPS = ["head_track", "render"]`.
- `src/lib/reels.ts`, `.test.ts`: keep `removing_background` (old reels may hold it); no change.
- `e2e/upload.spec.ts`, `e2e/preview.spec.ts`: step list, rebuildable set, no cut-out video.
- `scripts/posthog-dashboard/`: names no step; verify the dry-run snapshot is unchanged.
- `db-tests/*.test.ts`: insert versions/preview copies naming a cut-out as stored data; jsonb, no
  schema check, so they stay valid. No change.

Fixtures

- `fixtures/pipeline/` (manifest and outputs): regenerated; `remove_background/` and
  `preview_copies/subject-preview.webm` disappear.

### New Files

- `apps/worker/src/pipeline/head-track.tools.test.ts`: replaces `cutout.tools.test.ts` (rename).

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Edit format: cut-out optional (`packages/edit/src/schema.ts`)

- `editInputsSchema`: `cutout: refSchema.optional()`.
- `tracksSchemaFor`: `cutout: z.array(clip).optional()` (stored versions with the track parse;
  new ones omit it). Keep `tracksSchemaFor` usable by the decide answer through a variant without
  the key: export a helper (for example `answerTracksSchemaFor`, or `tracksSchemaFor(...).omit({
cutout: true })` inside `decide.ts`) so the JSON Schema sent to the AI has no `cutout` property.
- `refineEdit`: iterate `edit.tracks.cutout ?? []`.
- Update the `EditInputs`/`EditRef` type derivations if `EditRef` was derived from a now-optional
  field (it is `footage`, still required).

### 2. Edit package consumers

- `checks.ts`, `timeline.ts`, `decide.ts` (`usedFreeField`): `...(tracks.cutout ?? [])`.
- `decide.ts`: `decideAnswerSchemaFor` uses the track schema without `cutout`. `editFromAnswer`
  keeps `inputs: current.inputs` (an old reel's stored cut-out ref is harmless and the AI still
  cannot touch fingerprints).
- `preset.ts`: remove `hidesCutout` from the transition type and the three transitions.
- `build.ts`: `AssetRole = "footage" | "font" | "sound"`; `clip` takes footage only (no `muted`
  branch); delete `for (const item of tracks.cutout) clip("cutout", ...)` and the `hidesCutout`
  loop; `assetsOf` never pushes a cut-out. Update the top comment ("footage and cut-out") to footage.
- `baseline.ts`: no `cutout` track; comment updated. `test-support/inputs.ts`: `baselineInputs`
  without `cutout`.
- `index.ts`: check exports still compile (no removed export referenced).

### 3. Edit package tests and goldens

- `baseline.test.ts`: the empty-transcript case reads "footage only"; assert no `cutout` key in
  `tracks` and `inputs`.
- `build.test.ts`: asset list for `rethink-work-hand` no longer includes `["subject.webm",
"cutout"]`; add a test that `rethink-work-hand.edit.json` (names a cut-out in `inputs` and
  `tracks`) parses and its built page contains no `<video id="cutout"`, no `subject.webm` and no
  `data-track-index="30"`, and its assets have no `cutout` role.
- `schema.test.ts`: an edit without `inputs.cutout` and `tracks.cutout` parses; one with them parses.
- `decide.test.ts`: `decideJsonSchema(...)` has no `cutout` property under `tracks`; an answer
  carrying a `cutout` track does not add one to the edit from `editFromAnswer`.
- `glossary.test.ts`, `checks.test.ts`, `versions.test.ts`: drop `cutout` from hand-built inputs
  and tracks where present (keep at least one stored-shape case naming it in `versions.test.ts` if
  it builds or restores).
- Regenerate: `yarn workspace @edit-issebya/edit golden` (after step 9's fixtures, since the
  baseline reads fingerprints from `fixtures/pipeline/manifest.json`; run it again then). Commit
  the rewritten `baseline-short-speech.edit.json` and both goldens. Do not hand-edit
  `rethink-work-hand.edit.json`.

### 4. Worker: remove the step, keep the HyperFrames mask helpers

- `remove-background.ts`: delete the `removeBackground` `PipelineStep` and
  `REMOVE_BACKGROUND_VERSION`. Keep `REMOVE_BACKGROUND_SETTINGS`, `REMOVE_BACKGROUND_ENTRY`,
  `removeBackgroundArgs`, `parseRemoveBackgroundResult` (now `head_track`'s), and rename the module
  to `person-mask.ts` with names `PERSON_MASK_SETTINGS`, `PERSON_MASK_ENTRY`, `personMaskArgs`,
  `parsePersonMaskResult` (error prefix `head_track: person mask ...`). Keep
  `remove-background-entry.ts` as the HyperFrames entry (name it after the HyperFrames API it
  wraps). Rename the test file accordingly; delete the test of the removed step's `run`, keep the
  args, entry-exists, settings and result-parser tests.
- `definition.ts`: `PIPELINE = [convert, transcribe, retime, headTrack, previewCopies]`.
  Add `RETIRED_OUTPUTS` (`remove_background/subject.webm` rebuildable,
  `preview_copies/subject-preview.webm` kept) consulted by `retentionOf` after the live steps, so
  `classifyKey` still classifies a stored old cut-out and its preview copy instead of throwing.
- `step-store.ts`: drop `"removing_background"` from `PipelineReelStatus` (the DB check constraint
  and the studio's `reels.ts` keep it for old reels; no migration).
- `progress-parsers.ts`: rename `parseRemoveBackgroundProgress` to `parsePersonMaskProgress` (same
  parser); update its test table and keep `progress-testdata/remove-background.txt` (rename the
  fixture file to `person-mask.txt` with the parser).

### 5. Worker: `head_track` makes its own sampled mask

- `head-track-step.ts`: `HEAD_TRACK_VERSION = 2`. Settings `{ ...HEAD_TRACK_SETTINGS, mask:
PERSON_MASK_SETTINGS }` (the HyperFrames version stays in the fingerprint). Input
  `{ step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" }` as `source.mp4`.
- `run`: (a) ffmpeg writes `samples.mp4` in `dir`: `-an`, `-vf fps=1/sampleSeconds,scale=
analysisWidth:analysisHeight`, lossless-enough H.264 (`-c:v libx264 -crf 0 -pix_fmt yuv444p` or
  similar; a pure args function `headTrackSampleArgs` with a unit test); (b) the node entry
  (`tools.hyperframes[0]`, `hyperframesEnv()`, `progress: parsePersonMaskProgress`) writes
  `mask.part.webm`, `parsePersonMaskResult(stdout)`; (c) `headTrackDecodeArgs` on the mask exactly
  as today; (d) remove `samples.mp4`, the mask and `frames.rgba`; write `head-track.json`. Error
  messages say "person mask", not "cut-out". `outputs`, `reelStatus`, `reusedWhat` unchanged.
- `head-track-step.test.ts`: input is `retime/source.mp4`; the three tool calls in order with a
  tool double (sample args, entry args with the progress parser, decode args); intermediates gone.
- `head-track.ts`: comment "one RGBA frame of the person mask".

### 6. Worker: preview copies, record, first version

- `preview-copies.ts`: `PREVIEW_VERSION = 2`; remove `subject` settings, `SUBJECT_PREVIEW_FILE`,
  `subjectPreviewArgs`, the cut-out input and the second encode; outputs footage only. Update
  `preview-copies.test.ts`.
- `preview-copies-record.ts`: `PreviewCopiesRefs = { footage: EditRef }`; update its test.
- `first-version.ts`: inputs without `cutout`; update `first-version.test.ts` expectations.
- `ai.ts`: `EMPTY_DECIDE_ANSWER.tracks` without `cutout`.
- `decide/input.ts`: remove `hides_cutout` from the preset summary; update `prompt.test.ts`
  snapshots if any. `prompt.md` does not change, so `PROMPT_VERSION` stays `decide-1`.
- `decide/testdata/short-speech-answer.json`: remove the `cutout` track.

### 7. Worker: render

- `render-step.ts`: `files: { footage }` only; never download `version.inputs.cutout` (an old
  version may name one; it is ignored).
- `render-project.ts`: `files: { footage: string }`; the role switch has footage, else edit asset.
- `render-call.ts`: comment no longer mentions the cut-out.
- `render-test-support.ts`, `render-project.test.ts`, `render.tools.test.ts`: no cut-out file.
- `render-step.test.ts`: replace "fails the step naming a missing cut-out" with "renders a stored
  version naming a cut-out whose file is absent from storage" (no download of it, export recorded).

### 8. Worker: pipeline tests and tool tests

- `run-pipeline.test.ts`: fake HyperFrames keyed on the entry for `head_track` (write the mask to
  `-o`); every expected sequence drops `start/skipped remove_background` and `status
removing_background`; the retimed-length test says "before head_track"; the "deleted output
  rebuilt" case uses a rebuildable output that still exists (`retime/source.mp4`) and asserts
  `head_track`/`preview_copies` stay hits. Add an assertion that no step named `remove_background`
  starts on a new reel.
- `definition.test.ts`: names/statuses without `remove_background`; retention table without
  `remove_background/subject.webm` and `preview_copies/subject-preview.webm` for live steps, plus a
  `retentionOf` check for the two retired outputs; head_track's input is `retime/source.mp4`.
- `stored-files.test.ts`: keep the `remove_background/subject.webm` → `rebuildable` case (now via
  the retired table) and add `preview_copies/<fp>/subject-preview.webm` → `kept`.
- `slimming.test.ts`: no change needed beyond names, old key still listed as stored data.
- `cutout.tools.test.ts` → `head-track.tools.test.ts`: on `PERSON_CLIP` (read only), `head_track`
  run directly on it as `source.mp4` (the entry's `--info` still reports `u2net_human_seg`; at least
  80 percent of head samples found; sample count equals duration / 0.25 within one), and
  `preview_copies` makes one 540x960 footage copy of the source's duration. Update
  `tools-test-support.ts`'s comment. Never write `fixtures/footage/short-person.mp4`.
- `doctor-checks.ts`: comment lists the head tracker's mask decode, not the cut-out or the
  subject preview.

### 9. Fixtures

- Re-run `yarn workspace @edit-issebya/worker fixtures:pipeline` (real ffmpeg and HyperFrames, on
  the owner's Mac or a machine with the tools). It rewrites `fixtures/pipeline/manifest.json` and
  the outputs; delete the now-unlisted `fixtures/pipeline/remove_background/` and
  `fixtures/pipeline/preview_copies/subject-preview.webm` if the script does not. Check
  `head_track/head-track.json` is still all `null` (no person in `short-speech.mp4`).
- Then re-run `yarn workspace @edit-issebya/edit golden` (step 3) for the new fingerprints.

### 10. Studio

- `src/lib/preview-sources.ts`: `PreviewCopies = { footage: EditRef }`; `parsePreviewCopies`
  requires `footage` and ignores a stored `cutout` (an old reel's column still parses);
  `PreviewKeys` without `cutout`; the null check without it. Tests: old shape `{ footage, cutout }`
  parses to footage only; new shape `{ footage }` parses; keys have no cut-out.
- `src/app/preview-actions.ts`: sign edit, transcript, head track and footage only.
- `src/components/ReelPreview.tsx`, `src/lib/preview-page.ts`: `urls: { footage: string }`; only
  `footage` videos are swapped. `preview-page.test.ts`: assets without a cut-out; add a case where a
  page built from a stored version naming a cut-out has a single `<video>`.
- `src/lib/progress.ts`: `PROGRESS_STEPS = ["head_track", "render"]` and its test (old
  `remove_background` rows simply show no progress). Leave `src/lib/reels.ts` labels as they are.
- `scripts/posthog-dashboard/`: run the dry run and the script's unit tests; nothing names
  `remove_background`, so no snapshot change is expected.

### 11. E2E specs (`apps/studio/e2e/`)

- `upload.spec.ts`: drop `remove_background/subject.webm` from `REBUILDABLE`, the
  `remove_background: background removed, reused` step line and `hit("remove_background")`; after
  the decide step, assert no step row named `remove_background` exists for the reel and no stored
  object key contains `remove_background` or `subject-preview`.
- `preview.spec.ts`: test 2 becomes "the clock waits until the footage can play, on play and after
  a seek": hold the first footage request behind a gate (served as the 3/4 slice when released)
  instead of the cut-out copy; assert the clock holds at 0, advances after release, holds again on a
  seek past the served bytes, then advances. Add to test 1 (live preview): the player's composition
  has exactly one `<video>` (the footage) and no request to `subject-preview.webm` is made.
- Keep `seed`/`pipeline-cache.ts` unchanged (it reads whatever the manifest lists).

### 12. Docs

- `app_docs/pipeline.md`: title and step list without background removal; statuses; `PIPELINE`;
  remove the `remove-background.ts` paragraph and describe `head_track`'s sampled mask (input
  `retime/source.mp4`, sample clip, HyperFrames entry, decode, version 2, intermediates deleted);
  `preview_copies` footage only (version 2); fixtures list; tools test file; retired outputs in
  `retentionOf`. Replace the rule "Background removal stays on HyperFrames' current u2net model
  ... until issue #20 is taken up" with: "No background removal step until #20; #20 brings the
  cut-out back on demand, only for moments where something is placed behind the speaker.
  `head_track` makes its own sampled person mask with HyperFrames' pinned u2net and never stores
  it."
- `app_docs/edit-model.md`: `inputs.cutout` and `tracks.cutout` optional and never written; the
  builder ignores them; `panel` no longer "hides the cut-out"; asset roles `footage`, `font`,
  `sound`; baseline is footage plus captions.
- `app_docs/preview.md`: `reels.preview_copies` is `{ footage }` (old rows with `cutout` still
  parse); signed URLs without the cut-out; transform swaps the footage video; test 2 wording.
- `app_docs/export.md`: render downloads the footage only.
- `app_docs/status.md`: the long steps are `head_track` (its person mask's per-frame progress) and
  `render`; parser name; rules ("Progress only for `head_track` and `render`").
- `app_docs/storage.md`: old `remove_background/subject.webm` and `subject-preview.webm` stay where
  they are, still classified (retired outputs) and slimmed like any rebuildable file; HyperFrames
  environment paragraph names `transcribe` and `head_track`.
- `app_docs/decide-step.md`: preset summary without `hides_cutout`; answer tracks without `cutout`.
- `docs/conditional-docs.md`: pipeline line says "head tracking (with its sampled person mask)"
  instead of "background removal".
- `apps/worker/README.md`: step list if it has one. No em-dashes anywhere.

### 13. Validation

- Run every command in `Validation Commands`, fix failures at their cause, never weaken a test.

## Test Coverage

- Unit, `packages/edit` (Node and browser projects): `build.test.ts` builds the stored
  `rethink-work-hand` version (which names a cut-out) and asserts no `cutout` video, asset or track
  index 30; goldens regenerated without the cut-out element. Fails today (the builder emits it).
- Unit, `packages/edit`: `schema.test.ts` parses an edit without `inputs.cutout`/`tracks.cutout`
  (fails today: required) and one with them; `decide.test.ts` asserts the answer JSON Schema has no
  `cutout` track (fails today); `baseline.test.ts` asserts the baseline has no cut-out.
- Unit, `apps/worker`: `definition.test.ts` and `run-pipeline.test.ts` assert the step order
  without `remove_background` and that no `remove_background` step starts; `head-track-step.test.ts`
  asserts input `retime/source.mp4` and the sample, mask, decode calls; `preview-copies.test.ts`
  one output; `first-version.test.ts` no cut-out input; `stored-files.test.ts` retired keys still
  classified; `render-step.test.ts` renders a version naming an absent cut-out. Each fails today.
- Unit, `apps/studio`: `preview-sources.test.ts` (old and new `preview_copies` shapes, no cut-out
  key), `preview-page.test.ts` (one video), `progress.test.ts` (`head_track` is a progress step).
- E2E, `apps/studio/e2e/upload.spec.ts`: upload to version 2 runs no `remove_background` and stores
  no cut-out; `preview.spec.ts`: the live preview has one `<video>` and never requests
  `subject-preview.webm`, and the clock still waits on the footage.
- Tools (owner's Mac, not CI): `head-track.tools.test.ts` (real HyperFrames mask, at least 80
  percent heads on the person clip) and the studio's `test:tools` preview-matches-export spec.
- No DB test needed: no migration, no table or policy change (`preview_copies` and `inputs` are
  jsonb; the `removing_background` status value stays allowed for old reels).

## Validation Commands

Execute every command to validate the chore is complete with zero regressions.

- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`: lint of every touched workspace.
- `yarn turbo run typecheck --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`: types after the optional cut-out and removed role (also the build check for the worker and the package).
- `yarn knip`: no dead export left by the removed step, subject preview or cut-out role.
- `yarn turbo run test --filter=./apps/worker --filter=./apps/studio --filter=./packages/edit`: unit, golden (Node and browser) and dashboard tests.
- `yarn workspace @edit-issebya/worker test:tools`: real ffmpeg and HyperFrames, the new `head_track` mask on the person clip (owner's Mac only, never in CI).
- `yarn workspace @edit-issebya/studio posthog:dashboard --dry-run`: the dashboard config still builds with no `remove_background` steps (never `--apply`).
- `yarn turbo run test:db --filter=./apps/studio`: DB layer still green against the ADW stack (no migration).
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker --filter=./packages/edit`: the studio builds; the worker and package typecheck.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: landing and studio suites, including the updated upload and preview specs, against the `/prepare_app` server.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn workspace @edit-issebya/studio test:tools`: preview matches export (owner's Mac only).

## Notes

- **Owner decision to confirm (head_track):** the issue's "`head_track` keeps its current input"
  cannot hold, because that input is the cut-out being removed and the tracker needs a person mask.
  This plan keeps the head track (layout and checks depend on it) by having `head_track` mask only
  its own 4-fps, 270x480 samples with the same pinned u2net, never stored. If the owner prefers
  something else (for example #20's Apple Vision mask for the head tracker, or dropping head
  tracking), only step 5, its tests, the fixtures and the pipeline doc change.
- `head_track`'s fingerprint changes (new input, settings, version 2), and `preview_copies`'
  changes (version 2, one input): an existing reel's next `process` job re-runs both; `render` and
  `change` jobs read version inputs, which still point at the old, still-stored outputs.
- Never overwrite or delete a stored output by hand: old `remove_background/subject.webm` and
  `subject-preview.webm` objects and their `stored_files` rows stay; slimming already removes
  rebuildable files no reel needs; the retired-outputs table keeps `classifyKey` from throwing on
  them.
- Do not add a migration: `reels.status`'s check constraint keeps `removing_background` (an old
  reel can still be in it), and both applied migrations' comments that mention the cut-out are
  never edited.
- The time-left estimate for `head_track` uses the median of the owner's last done `head_track`
  rows; older v1 rows (decode only) are faster, so estimates read low until a few v2 rows exist.
  Acceptable; `status.md` says "no estimate yet" under three rows.
- `fixtures:pipeline` and the tools specs need real ffmpeg, ffprobe and HyperFrames; if the run's
  machine lacks them, report it rather than hand-writing fixtures or fingerprints.
- Commit messages: conventional, no scope, no trailers, no AI attribution.
