# Edit Model: Word-Anchored Timeline, Immutable Versions, HarfBuzz Builder

**Specifications:**

- specs/issue-31-adw-9a39262e-sdlc_planner-edit-model-builder-versions.md

## Overview

Every edit of a reel is data: an `edit.json` timeline whose items are anchored to transcript words,
not seconds, so an edit survives retiming. The shared package `packages/edit`
(`@edit-issebya/edit`) holds the edit format, the issebya style preset, the builder that turns an
edit, a transcript and a head track into a HyperFrames page, and the layout checks. Each saved edit
is an immutable version (one R2 object plus one `versions` row), and the worker saves an automatic
version 1 after the six fixed pipeline steps.

## How it works

`packages/edit` is TypeScript source with no build step (like `packages/storage`); the studio
transpiles it and the worker runs it directly.

- `packages/edit/src/schema.ts`, `anchors.ts`: `editSchema(context)` (Zod 4) for `format: 1`, six
  tracks (`footage`, `cutout`, `captions`, `overlays`, `transitions`, `sounds`) and `inputs`
  (fingerprints of the footage, transcript, cut-out and head track the edit was made from). An item
  has a start and an end, each a word anchor (`{ word, edge?, offset? }`, offset within 0.5 s) or a
  time (`{ at }`, only where nobody speaks). The context refines per transcript and preset: unknown
  word ids, inverted items and fonts outside the preset are rejected. `custom` style text is limited
  to a safe character set and no `url(`.
- `packages/edit/src/transcript.ts`: the `Word`, `Transcript` and `HeadTrack` types (the worker
  imports them from here).
- `packages/edit/src/preset.ts`: `ISSEBYA`, the style preset as plain data: frame, safe box, fonts,
  colours, caption rules, transition text, `keepCaps` and the glossary of misheard terms. Font and
  click-sound files live in `packages/edit/assets/` (with their licences).
- `packages/edit/src/baseline.ts`: `baselineEdit(transcript, inputs, preset)`, the automatic first
  edit: footage and cut-out for the whole speech, one caption per word anchored to itself, nothing
  else.
- `packages/edit/src/measure.ts`: `createMeasurer(fonts)` measures text with HarfBuzz compiled to
  WebAssembly (`harfbuzzjs`) from the font bytes the caller passes in (`readFile` in Node, `fetch`
  in the browser). The browser's own text metrics are never used.
- `packages/edit/src/layout.ts`, `build.ts`: `build({ edit, transcript, headTrack, preset, measurer })`
  resolves anchors, lays captions out around the head and returns the HTML, the measured layout and
  the check result.
- `packages/edit/src/checks.ts`: `runChecks` covers what the schema cannot: every text box inside the
  safe box (`safe-box`), no caption over the face for its time (`face`), and sound hits at least the
  preset's gap apart (`sound-gap`). Reasons are sorted.
- `packages/edit/src/versions.ts`: `versionKey` (`<prefix>reels/<reel id>/versions/<version id>.json`),
  `canonicalJson` (sorted keys, two-space indent, final newline), `saveVersion` and `restoreVersion`,
  written against two small interfaces (`VersionObjects`, `VersionStore`). The object is written
  first with `putIfAbsent` and refused if the key exists; then the row is inserted. Restoring copies
  the old bytes into a new version (`restored_from_id`); the old row and object are never touched.
- `packages/edit/src/supabase-versions.ts`: `supabaseVersionStore(db)` for a secret-key client; reads
  named columns and inserts only through `save_version`.
- `supabase/migrations/20261104090000_versions.sql`, `20261104090100_save_version_error_code.sql`:
  the `versions` table (`number` unique per reel, `parent_id`, `restored_from_id`, `request`,
  `model`, `prompt_version`, `change_summary`, `checks`, `inputs`, unique `r2_key`), `reels.current_version_id`,
  an immutability trigger, owner-read RLS, and `save_version` (service role only), which numbers the
  row, inserts it and moves `current_version_id` in one transaction, refusing a parent that is no
  longer current.
- `packages/storage/src/storage.ts`, `r2.ts`, `fake.ts`: new `putIfAbsent(key, bytes, options?)`
  returning `"written"` or `"exists"` (R2 uses `IfNoneMatch: "*"`, the fake an exclusive create).
- `apps/worker/src/steps/first-version.ts`: the in-process step `first_version`, run after
  `preview_copies`. It reads the retimed transcript and head track from the R2 cache by fingerprint,
  builds the baseline edit and runs the checks, then saves version 1 (`model` and `request` null)
  and sets it current. The step line reads `first_version: version 1 saved`, with `, N check
failure(s)` appended when checks fail (the version is still saved). A retried job whose reel
  already has a version writes nothing (`version N already saved`). Every write first checks the
  lease signal.
- `apps/studio/next.config.ts`: `transpilePackages` entry for the package.

## How to Use

1. Upload footage in the studio; once the six pipeline steps finish, the step log shows
   `first_version: version 1 saved` and the reel's current version is set.
2. Code that edits a reel builds an `Edit`, validates it with `editSchema`/`parseEdit`, calls `build`
   to get the page and checks, then `saveVersion` with the new version's id (the package makes no
   ids) and `restoreVersion` to go back to an older one.
3. To change the builder or the preset, run `UPDATE_GOLDEN=1 yarn workspace @edit-issebya/edit test`
   (Node run only), review the diff in `packages/edit/src/testdata/built/`, and commit it.

## Configuration

No new environment variable. The worker reads `R2_KEY_PREFIX` for version keys. `packages/edit`
depends on `harfbuzzjs` and `zod` (pinned exactly); its browser unit project needs the Playwright
Chromium install from the ADW Install step.

## Testing

- `yarn test`: `packages/edit/src/**/*.test.ts` (Node: schema, checks, versions with fakes, builder
  against the golden outputs) and `*.browser.test.ts` (Vitest browser mode, Playwright provider,
  Chromium) which must produce the same golden bytes. Goldens are `packages/edit/src/testdata/built/*.html`
  and `*.layout.json`, built from stored fixture versions in `testdata/versions/`.
- `yarn turbo run test:db --filter=./apps/studio`: `versions.test.ts` (`save_version`, restore,
  immutability, the `versions` RLS) and the updated pipeline-status tests.
- `apps/studio/e2e/upload.spec.ts`: seeds the cached step outputs, spawns the worker's `once`,
  expects six cache hits and `first_version: version 1 saved`.
- `apps/worker/src/steps/first-version.test.ts` for the step.

## Rules

- The package is deterministic: no clock, no randomness, no DOM or Node globals and no `node:*`
  imports in its non-test source (ESLint enforces it). Numbers are formatted with fixed decimals and
  items sorted by a stable key. Ids are made by the caller.
- Never store a built page; only the edit is saved. Never rewrite a saved version's object or row.
- Only the worker (secret key) writes versions, always through `save_version`; the object is written
  before the row.
- Do not measure text with the browser; widths come from `createMeasurer`.
- A change that alters built output updates the golden files in the same commit.

## Notes

- Also touches `app_docs/studio.md` (tables, `reels.current_version_id`) and `app_docs/pipeline.md`
  (the step after `preview_copies`); the worker's step runner is described in `app_docs/measurement.md`.
- The decide step (AI edits) and the live preview import this package in later slices.
