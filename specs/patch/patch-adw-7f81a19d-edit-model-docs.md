# Patch: write the edit model docs (README line, app_docs/edit-model.md, index line, pipeline and studio doc updates)

## Metadata

adw_id: `7f81a19d`
review_change_request: `Issue #1: Step 17 and the acceptance criterion "`.adw/project.md`, `turbo.json`, `knip.json`, CI, `README.md`, `app_docs/edit-model.md`and`docs/conditional-docs.md`are updated" are only partly done.`git diff --stat origin/develop`touches none of README.md, app_docs/ or docs/. Five things are missing: (1) README.md has no`packages/edit/`line in its workspace list; (2) there is no app_docs/edit-model.md; (3) docs/conditional-docs.md has no line for it; (4) app_docs/pipeline.md has no bullet saying the worker saves the first version after the six steps; (5) app_docs/studio.md does not list the`versions`table or the new write paths (save_version, service role only). Resolution: add the README line, the pipeline bullet, the studio table and write path, create app_docs/edit-model.md with the sections step 17 lists and its index line. No em-dashes. Run`yarn format` afterwards. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-31-adw-7f81a19d-sdlc_planner-edit-model-builder-versions.md`
**Issue:** Step 17's documentation half was never done. The diff against `origin/develop` changes
no file under `README.md`, `app_docs/` or `docs/`: the README workspace list lacks
`packages/edit/`, `app_docs/edit-model.md` does not exist, `docs/conditional-docs.md` has no line
for it, `app_docs/pipeline.md` does not say the worker saves version 1 after the six steps, and
`app_docs/studio.md` lists neither the `versions` table nor `save_version` as a write path. The
document phase writes only one feature doc and its index line and never edits `README.md`, so
nothing later would fix items 1, 4 and 5.
**Solution:** Documentation-only edits on this branch, worded from the code already in the diff
(`packages/edit/src/`, `apps/worker/src/first-version.ts`, `apps/worker/src/version-store.ts`,
`supabase/migrations/20261101153653_versions.sql`): one README line, one pipeline bullet, two
studio doc edits, one new feature doc, one index line, then `yarn format`. No code, test or config
change.

## Files to Modify

Use these files to implement the patch:

- `README.md`: one line in the workspace list.
- `app_docs/pipeline.md`: one bullet under `## How it works`.
- `app_docs/studio.md`: the `versions` table in "Jobs, steps and the lease" (the tables list) and
  `save_version` in the write paths of `## Rules`.
- `app_docs/edit-model.md` (new).
- `docs/conditional-docs.md`: one line.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: README workspace line

- In the fenced workspace list of `README.md`, directly below the
  `packages/storage/ the storage library ...` line, add, aligned with the other lines:
  `packages/edit/    the edit model (format, preset, HarfBuzz builder, versions) the studio and the worker share, workspace @edit-issebya/edit`
- Keep the column alignment of the existing lines (the path column is padded to the width of
  `packages/storage/`). Touch nothing else in the README.

### Step 2: pipeline.md bullet

- Under `## How it works` in `app_docs/pipeline.md`, after the last bullet describing the six steps
  (the preview copies / run-pipeline bullets, before the `### Head-track format` subsection), add one
  bullet: after the six steps the worker saves the automatic first version, the `first_version`
  step (`apps/worker/src/first-version.ts`): version 1 built from the preset alone (no AI) from the
  retimed transcript and the head track, its step line `version 1 saved, ...` (or
  `first version kept, reused` when the reel already has one); see `app_docs/edit-model.md`.
- Check the exact summary strings against `apps/worker/src/first-version.ts` and its test before
  writing them.

### Step 3: studio.md table and write path

- In `### Jobs, steps and the lease` (the bullets that list the tables), add one bullet:
  `supabase/migrations/20261101153653_versions.sql`: table `versions` (per-reel `number`, parent,
  restored-from, request, model, prompt version, change summary, checks, input fingerprints,
  `r2_key`), owner-only `select` RLS for `authenticated`, no `anon` access, rows refused on
  update by a trigger (immutable); `reels.current_version_id` points at the current one. Written
  only through `save_version`, which only `service_role` (the worker) may execute; details in
  `app_docs/edit-model.md`.
- In `## Rules`, next to the `claim_job` rule, add the write path:
  "Never let `authenticated` or `anon` execute `save_version`; versions are written only through
  it, by the service role (the worker), and never updated."
- If the Testing section's DB bullet lists the DB test files, add `versions.test.ts`
  (`save_version`, immutability, RLS) to that list.
- Confirm grants and the trigger against the migration (`revoke all ... from anon/authenticated`,
  `grant select ... to authenticated`, `grant execute on function public.save_version` to
  `service_role` only, `versions_refuse_update`).

### Step 4: create app_docs/edit-model.md and its index line

- Title: `# Edit Model: Word-Anchored Format, Style Preset, HarfBuzz Builder, Versions`. Follow the
  shape of `app_docs/pipeline.md` (short intro, `## Overview`, `## How it works` with subsections,
  `## Testing`, `## Rules`, `## Notes`). Sections, each written from the named source:
  - `## Overview`: `packages/edit` (`@edit-issebya/edit`), TypeScript source, no build, no
    platform API, consumed by `apps/worker` (now) and `apps/studio` (types only until slice 9).
  - `### Format` (`src/schema.ts`, `src/transcript.ts`, `src/timeline.ts`): `edit.json`, tracks
    (footage, cut-out, captions, overlays, transitions, sounds), items, anchors on word ids
    (seconds only where nobody speaks), per-item properties, the free custom-style field, Zod 4
    validation.
  - `### Preset values` (`src/preset.ts`): frame, safe box, fonts (Golos Text Bold, Raleway
    Light), sizes, colours, click sound, glossary; state the actual numbers from the file.
  - `### Builder contract` (`src/build.ts`, `src/measure.ts`, `src/layout.ts`, `src/html.ts`):
    `build(edit, transcript, headTrack, preset, measurer) -> { html, assets, checks }`,
    deterministic, HarfBuzz (`harfbuzzjs`) measuring through the injected `Measurer`, one builder
    for preview and export.
  - `### Checks` (`src/checks.ts`): text inside the safe box, captions clear of the face, clicks at
    least 0.25 s apart, time anchors outside speech; returned as reason strings.
  - `### Versions and restore` (`src/versions.ts`, `apps/worker/src/version-store.ts`, the
    migration): R2 key `${R2_KEY_PREFIX}reels/<reel_id>/versions/<version_id>.json` written with
    put-if-absent, the `versions` row, `save_version` (service role only, parent must be the
    current version), `reels.current_version_id`, the update-refusing trigger; restore creates a
    new version copying the old one (`restored_from_id`).
  - `### First version` (`src/baseline.ts`, `apps/worker/src/first-version.ts`): the
    `first_version` step after the six pipeline steps, preset only, no AI, its step line.
  - `### Cross-environment test and negative proof` (`src/build.test.ts`,
    `src/build.browser.test.ts`, `src/test-support/`, `src/testdata/`, `scripts/golden.ts`): the
    stored fixture versions built in Node and in Chromium, compared byte for byte with the
    committed goldens; how the negative proof shows the comparison fails on a changed measurer or
    output (read the tests for exactly what they prove); regenerating goldens with the script.
  - `## Testing`: `yarn turbo run test --filter=./packages/edit` (node and browser projects, needs
    Install step 3's chromium; `turbo.json` passes `PLAYWRIGHT_*` and `CI`),
    `apps/studio/db-tests/versions.test.ts` under `test:db`, `apps/worker/src/first-version.test.ts`
    and `edit-import.test.ts`, the E2E `upload.spec.ts` ending with version 1 saved.
  - `## Rules`: versions never change; history is never rewritten, going back creates a new
    version; one builder for preview and export, never forked per environment; never store a built
    page; anchors are words, seconds only where nobody speaks; nothing Node-only or browser-only in
    `packages/edit`; never write a version key twice; never commit an asset without its licence.
  - `## Notes`: the `number` column was added beyond the issue's list (per-reel "version N" and
    `unique (reel_id, number)` as a concurrency guard); the studio imports only types until slice
    9; the fixture clip has no person, so the face rule is proven with a synthetic head track and
    the `rethink-work` data.
- No em-dashes; use commas, colons or parentheses.
- In `docs/conditional-docs.md`, append after the last line:
  ``- Read `app_docs/edit-model.md` when changing `packages/edit` (the edit format, preset, builder, HarfBuzz measuring, checks, versions), the `versions` table or `save_version`, `reels.current_version_id`, the worker's `first_version` step, or the browser test layer.``

### Step 5: format and check

- Run `yarn format`, then the Validation commands below.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`: Prettier over the whole repository passes.
- `git diff origin/develop --stat -- README.md app_docs docs`: shows `README.md`,
  `app_docs/edit-model.md`, `app_docs/pipeline.md`, `app_docs/studio.md` and
  `docs/conditional-docs.md`.
- `grep -n "packages/edit/" README.md && grep -n "app_docs/edit-model.md" docs/conditional-docs.md app_docs/pipeline.md app_docs/studio.md && grep -n "save_version" app_docs/studio.md && grep -n "first_version" app_docs/pipeline.md`: every item is present.
- `git diff origin/develop -- README.md app_docs docs | grep -n "—"` prints nothing (no em-dashes
  in the changed docs).
- `yarn knip`: still clean (the commit hook runs it; docs touch no code).

## Patch Scope

**Lines of code to change:** about 130 lines of Markdown (around 110 in the new doc, about 20 across
the four edited files); no code.
**Risk level:** low
**Testing required:** formatting check and presence and em-dash searches; no code paths change, so
no unit, DB or E2E rerun is needed.
