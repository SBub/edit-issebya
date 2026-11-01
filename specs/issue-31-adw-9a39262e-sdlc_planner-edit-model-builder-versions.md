# Feature: edit model in packages/edit: word-anchored timeline, immutable versions in R2, HarfBuzz builder

## Metadata

issue_number: `31`
adw_id: `9a39262e`
issue_json: `{"number":31,"title":"feat: edit model in packages/edit: word-anchored timeline, immutable versions in R2, HarfBuzz builder"}`

## Feature Description

Reel studio MVP, slice 8 of 17. Every edit of a reel becomes data: an `edit.json` timeline whose
items are anchored to transcript words, not seconds. A new shared package `packages/edit`
(`@edit-issebya/edit`) holds the edit format (Zod 4 schema), the transcript and head-track types,
the issebya style preset, the **builder** that turns an edit, a transcript and a head track into a
HyperFrames composition (HTML), and the layout checks the schema alone cannot express (safe box,
face box, sound spacing). Word widths are measured with HarfBuzz compiled to WebAssembly
(`harfbuzzjs`), so the same build is byte-identical in Node (the worker) and in Chromium (the
studio). Versions are immutable: each is a complete copy of the edit in R2 plus one `versions` row
(parent, request, model, prompt version, change summary, check results, input fingerprints);
`reels.current_version_id` points at the current one; restoring an old version creates a new one.
After the fixed pipeline steps the worker saves an automatic version 1 built from the preset alone,
so the preview slice (9) and the decide step (10) have something to start from.

## User Story

As the studio owner editing reels
I want every edit stored as a word-anchored, never-changing version that one shared builder turns into the playable page
So that the preview and the export always agree, edits survive retiming, and I can go back to any earlier version without losing history

## Problem Statement

The pipeline (issues 29 and 30) produces footage, a transcript with stable word ids, a cut-out and a
head track, but nothing describes an edit. There is no format the decide step can generate, no way
to build a page from it identically in the browser and the worker, no layout validation that
depends on rendered text widths or the head position, and no versioned storage with history.

## Solution Statement

- `packages/edit`: TypeScript source package (no build step, like `packages/storage`) exporting the
  transcript and head-track types, `editSchema(context)` (Zod 4; per-transcript and per-preset
  refinement so unknown word ids, inverted items and fonts outside the preset are rejected), the
  `ISSEBYA` preset, `createMeasurer(fonts)` (harfbuzzjs, font bytes passed in by the caller),
  `build(edit, transcript, headTrack, preset, measurer)`, `runChecks`, `baselineEdit`, and the
  version operations (`versionKey`, `saveVersion`, `restoreVersion`) written against two small
  interfaces (object store, version store) plus a Supabase version store that only imports types.
- Determinism by construction: no clock, no randomness, numbers formatted with fixed decimals,
  items sorted by a stable key, ESLint rules that ban `Date`, `Math.random`, DOM and Node globals
  and `node:*` imports in the package's non-test source.
- Cross-environment proof: committed golden outputs (`html` and the measured layout) for stored
  fixture versions; the Node run and the Chromium run (Vitest browser mode, Playwright provider)
  each must match the same golden bytes.
- Versions: a migration adds `versions` and `reels.current_version_id`, plus a
  `save_version` database function (service role only) that numbers the version, inserts the row
  and moves `current_version_id` in one transaction. The object is written first with a new
  put-if-absent byte method on `Storage`, which refuses an existing key.
- Worker: after the six fixed steps a new in-process step `first_version` builds the baseline edit,
  runs the checks, saves version 1 (`model` and `request` null) and sets it current; the step line
  reads `first_version: version 1 saved`.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository layout list; add `packages/edit/`.
- `AGENTS.md`: rules (Yarn only, no em-dashes, conventional commits without trailers, docs layout).
- `.adw/project.md`: the ADW profile; add the `edit` workspace row, Build filter, unit and browser
  test layers, the add-dependency command; never rename or reorder the nine headings.
- `docs/conditional-docs.md`: add the line for `app_docs/edit-model.md`; widen the studio and
  pipeline lines for the `versions` table and the `first_version` step.
- `app_docs/studio.md`: tables, RLS, worker, storage doubles and Rules; read before touching
  migrations, the worker, `packages/storage` or the studio's tests.
- `app_docs/measurement.md`: the step runner (`runInProcessStep`, `recordHit`), step summaries;
  the new step goes through it.
- `app_docs/pipeline.md` (arrives with issues 29 and 30): step list, fingerprints, cache layout
  `${R2_KEY_PREFIX}cache/<step>/<fingerprint>/<file>`, the head-track format, `fixtures/pipeline/`.
- `turbo.json`: strict env mode; `test` task (browser mode needs Playwright's browser cache).
- `knip.json`: one workspace entry per package; add `packages/edit`.
- `package.json` (root): workspaces and root scripts (unchanged scripts).
- `lefthook.yml`: pre-push `yarn test` will now also run the Chromium browser tests.
- `.github/workflows/ci.yml`: the Playwright browser install must move before `yarn test`.
- `packages/storage/src/storage.ts`, `packages/storage/src/r2.ts`, `packages/storage/src/fake.ts`
  and their tests: add `putIfAbsent(key, bytes)`; the R2 one uses `IfNoneMatch: "*"` like
  `putFileIfAbsent`, the fake an exclusive create.
- `packages/storage/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `README.md`: the template for the new package.
- `apps/worker/src/process-job.ts`: wires the pipeline; append the `first_version` step.
- `apps/worker/src/pipeline/run-pipeline.ts`, `definition.ts`, `fingerprint.ts`
  (issues 29/30): return the step fingerprints so the version can name its inputs; `cacheKey`.
- `apps/worker/src/pipeline/transcript.ts` (issue 29): the `Word`/`Transcript` types move to
  `@edit-issebya/edit` and are re-imported here.
- `apps/worker/src/pipeline/head-sample.ts` (issue 30): `HeadSample`; the edit package defines the
  same shape (`HeadTrack = (HeadSample | null)[]`) and the worker imports it from there.
- `apps/worker/src/step-runner.ts`, `apps/worker/src/step-store.ts`: in-process step and hit
  recording.
- `apps/worker/package.json`, `apps/worker/tsconfig.json`: add the dependency.
- `apps/studio/package.json`, `apps/studio/next.config.ts`: add the dependency and
  `transpilePackages` entry (slice 9 imports the builder in the browser).
- `apps/studio/e2e/upload.spec.ts` (issue 30 version): extend with the version step.
- `apps/studio/test-support/fixtures.ts`, `apps/studio/test-support/local-supabase.ts`,
  `apps/studio/db-tests/rls.test.ts`: helpers and patterns for the new DB test.
- `supabase/migrations/*.sql`: style of the existing migrations (comments, revokes, grants,
  `security definer` with `set search_path = ''`, revoke execute from `public, anon, authenticated`).
- `fixtures/pipeline/retime/transcript.json`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/manifest.json` (issue 30): the fixture clip's transcript, head track
  (all `null`: the clip has no person) and fingerprints.
- Reference, read-only, another repository:
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/editing-guide.md` and
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/` (`build.py`,
  `index.html`, `clicks.json`, `transcript.json`, `head-track.json`, `assets/fonts/`,
  `assets/sounds/mouse-click-trimmed.wav`).
- HyperFrames docs shipped with the pinned package in `apps/worker` (`hyperframes docs` run through
  the installed bin, or the docs under `node_modules/hyperframes/`), for the composition structure
  (`data-composition-id`, `data-start`, `data-duration`, `data-track-index`, `data-has-audio`,
  audio clips and their volume, `window.__timelines`).
- `node_modules/vitest` docs for browser mode with `@vitest/browser-playwright` (Vitest 5).

### New Files

- `packages/edit/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `README.md`.
- `packages/edit/assets/fonts/Raleway-Light.ttf`, `packages/edit/assets/fonts/OFL-Raleway.txt`,
  `packages/edit/assets/fonts/GolosText-Bold.ttf`, `packages/edit/assets/fonts/OFL-GolosText.txt`,
  `packages/edit/assets/sounds/mouse-click-trimmed.wav`,
  `packages/edit/assets/sounds/LICENSE-mouse-click.txt`.
- `packages/edit/src/index.ts`: public exports.
- `packages/edit/src/transcript.ts`: `Word`, `Transcript`, `HeadSample`, `HeadTrack`, word lookup.
- `packages/edit/src/schema.ts`: Zod schema factory, `parseEdit`, `Edit` types.
- `packages/edit/src/preset.ts`: `ISSEBYA` preset.
- `packages/edit/src/anchors.ts`: resolve word/time anchors against a transcript.
- `packages/edit/src/measure.ts`: `createMeasurer` over harfbuzzjs.
- `packages/edit/src/layout.ts`: face box, caption placement, fill-from-style.
- `packages/edit/src/checks.ts`: safe box, face box, sound spacing.
- `packages/edit/src/build.ts`: the builder and HTML writer.
- `packages/edit/src/baseline.ts`: `baselineEdit`.
- `packages/edit/src/versions.ts`: `versionKey`, `saveVersion`, `restoreVersion`, interfaces.
- `packages/edit/src/supabase-versions.ts`: `supabaseVersionStore(db)` (type-only Supabase import).
- `packages/edit/src/testdata/`: transcripts, head tracks, stored fixture versions and golden
  outputs (see tasks).
- `packages/edit/src/*.test.ts` (Node) and `packages/edit/src/build.browser.test.ts` (Chromium).
- `supabase/migrations/20261104090000_versions.sql` (timestamp after issue 30's last migration).
- `apps/worker/src/steps/first-version.ts` and `first-version.test.ts`.
- `apps/worker/src/edit-import.test.ts`: proves Node 24 runs the package's TypeScript source.
- `apps/studio/db-tests/versions.test.ts`.
- `app_docs/edit-model.md`.

## Implementation Plan

### Phase 1: Foundation

Bring in the pipeline this slice depends on (issues 29 and 30), create `packages/edit` with its
assets (licences checked), the transcript and head-track types, the preset, the schema and anchor
resolution, and add `putIfAbsent` to `packages/storage`.

### Phase 2: Core Implementation

HarfBuzz measurement, layout (fill from style, captions around the head), checks, the builder's
HyperFrames output, the baseline edit, fixture versions with golden outputs, the Node and Chromium
test projects, the versions migration and the version operations.

### Phase 3: Integration

Worker `first_version` step after the fixed steps, worker import proof, studio dependency and
`transpilePackages`, DB test for RLS and restore, E2E extension, `turbo.json`, `knip.json`, CI,
profile, README and docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Bring in the pipeline from issues 29 and 30

- This slice is blocked by #30 (PR #53, which carries #29's PR #52). Run `git fetch origin` and
  check `git log origin/develop --oneline | grep -i "issue-30"`.
- If PR #53 is merged: `git merge origin/develop` into this branch.
- If it is not merged: merge its branch `feat/issue-30-adw-a6bafcdf-background-removal-head-tracking-previews`
  into this branch (the same way issue 30 merged issue 29's branch), so the step list, the
  fingerprints, the cache layout, `fixtures/pipeline/`, the `hyperframes` pin and its migrations
  are present. Resolve conflicts in favour of the issue 30 code. Say which was done in the PR.
- Confirm `apps/worker/src/pipeline/transcript.ts`, `head-sample.ts`, `run-pipeline.ts`,
  `fixtures/pipeline/manifest.json` and `app_docs/pipeline.md` exist before continuing. If neither
  route is possible, stop and report it.
- Run `yarn install --immutable` after the merge.

### 2. Create the package skeleton

- `packages/edit/package.json`: name `@edit-issebya/edit`, `private`, `type: module`,
  `exports`: `".": "./src/index.ts"`, `"./assets/*": "./assets/*"`; scripts `typecheck`
  (`tsc --noEmit`), `lint`, `lint:fix`, `test` (`vitest run`, runs both projects), engines Node 24.
- Dependencies, added with the profile's command form from the root:
  `yarn workspace @edit-issebya/edit add zod@4.6.7 harfbuzzjs@1.6.4` and
  `yarn workspace @edit-issebya/edit add -D @types/node@^24 eslint@^9 eslint-config-prettier eslint-plugin-no-secrets eslint-plugin-security typescript@5.9.3 typescript-eslint vitest@^5.0.3 @vitest/browser-playwright@5.0.5 playwright@1.64.0 @supabase/supabase-js@^2.118.0`
  (`playwright` pinned to the version `@playwright/test` uses in web and studio, so the one
  Chromium install serves all three; `@supabase/supabase-js` is a dev dependency because the
  package imports its types only). Match versions the other workspaces use.
- `tsconfig.json`, `eslint.config.mjs`, `README.md`: copy `packages/storage`'s, renamed. In the
  ESLint config add, for `src/**/*.ts` except `*.test.ts` and `testdata/`:
  `no-restricted-globals` for `window`, `document`, `navigator`, `process`, `Buffer`, `require`,
  `fetch`, `performance`, `setTimeout`, `Date`; `no-restricted-syntax` banning `Math.random` and
  `new Date`; `no-restricted-imports` banning `node:*`, `fs`, `path`, `crypto`. Each with a message
  naming C3 (one builder, no server-only or browser-only code, no clock, no randomness).
- `vitest.config.ts` with `test.projects`: `node` (include `src/**/*.test.ts`, exclude
  `src/**/*.browser.test.ts`) and `browser` (include `src/**/*.browser.test.ts`,
  `browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] }`).
  Read the Vitest 5 browser-mode docs in `node_modules/vitest` first; adjust to the installed API.
- `README.md` of the package: two lines like the storage package's.

### 3. Copy the assets and check their licences

- Copy from the reference repository (read-only) into `packages/edit/assets/fonts/`:
  `Raleway-Light.ttf`, `GolosText-Bold.ttf`; into `packages/edit/assets/sounds/`:
  `mouse-click-trimmed.wav`.
- Fonts: both are SIL Open Font License 1.1 families on Google Fonts. Fetch the licence texts
  from `https://github.com/google/fonts/raw/main/ofl/raleway/OFL.txt` and
  `https://github.com/google/fonts/raw/main/ofl/golostext/OFL.txt` into `OFL-Raleway.txt` and
  `OFL-GolosText.txt`. Check each font's `name` table (copyright, nameID 0; licence, nameID 13 and
  14, read with a short throwaway harfbuzzjs or `fc-query` call) names OFL and the same authors.
  Neither font uses a Reserved Font Name that renaming would matter for, since the files are
  shipped unmodified.
- Sound: the guide names its source as Freesound 678248 "Mouse Click Sound.mp3" by Pixeliota;
  Freesound lists it as CC0 1.0 (checked while planning; re-check the page before committing).
  Write `LICENSE-mouse-click.txt`: source URL `https://freesound.org/s/678248/`, author, CC0 1.0,
  and that the file was trimmed to the press (onset 8 ms).
- If any licence does not allow redistribution in a public repository, stop and report it; do not
  commit the file.

### 4. Transcript, head track and preset

- `src/transcript.ts`: `Word { id, text, start, end }`, `Transcript { words }` (moved from the
  worker; ids `w0001` style), `HeadSample { t, head_top, cx, head_w }`,
  `HeadTrack = (HeadSample | null)[]`, `wordIndex(transcript): Map<id, Word>`.
- Change `apps/worker/src/pipeline/transcript.ts` and `head-sample.ts` to import these types from
  `@edit-issebya/edit` (re-export where the worker's own code names them) so there is one
  definition.
- `src/preset.ts`: `ISSEBYA` preset, plain data:
  frame `{ width: 1080, height: 1920 }`; `safe: { left: 130, right: 860, top: 260, bottom: 1400 }`;
  `fonts: { primary: { family: "Raleway Light", file: "fonts/Raleway-Light.ttf", weight: 300, size: 110 }, secondary: { family: "Golos Text", file: "fonts/GolosText-Bold.ttf", weight: 700, size: 50 } }`;
  `colors: { text: "#FFFFFF", accent: "#B3E6FF" }`; `shadow: false`;
  `caption: { font: "secondary", lineGap: 85, faceMargin: { left: 35, right: 30 }, faceHeightRatio: 1.35, lowLineTop: 1290, appear: 0.18, rise: 12, fade: 0.15, minOnScreen: 0.25 }`
  (values from `build.py`);
  `accent: { font: "primary", color: "accent", aboveHead: 190 }`;
  `sounds: { click: { file: "sounds/mouse-click-trimmed.wav", gainDb: -13 } }`, `minSoundGap: 0.25`;
  `transitions: ["dim", "panel", "card"]` (T1, T2, T3 of the reference reel);
  `glossary: [{ term: "lock-in", heard: ["locking"] }]` (shown as one word);
  `gsap` script URL pinned as in the reference page.

### 5. Edit schema and anchors

- `src/schema.ts`, Zod 4:
  - Anchor: `{ word: string, edge?: "start" | "end", offset?: number }` (default edge: `start` for
    an item's start, `end` for its end; `offset` seconds, at most 0.5 either way, for the small
    leads the reference uses such as `on("w91", -0.03)`) or `{ at: number }` (seconds, for where
    nobody speaks).
  - Item base: `id` (unique across the edit), `start`, `end`, optional `style`
    (`color`: preset colour key or `#RRGGBB`, `size` px, `position` `{ x, y }` px, `font`: preset
    font key), optional `custom` (free styling: CSS declarations string, restricted to a safe
    character set with no `<`, `>`, `{`, `}`, `"`, `\` and no `url(`, so it cannot leave the style
    attribute or load anything).
  - Tracks (each an array, possibly empty): `footage` and `cutout` (one item each, covering the
    reel), `captions` (`text`, optional `words` it shows), `overlays` (accent text), `transitions`
    (`type` from the preset's list, optional `text`), `sounds` (`sound` key from the preset,
    optional `gainDb`).
  - Top level: `format: 1`, `inputs: { footage, transcript, cutout, headTrack }` (SHA-256 hex
    fingerprints of the producing steps; `headTrack` added beside the three the issue names
    because the head-track step has its own settings and version), `tracks`.
  - `editSchema({ transcript, preset })` adds a `superRefine`: every `word` anchor names a word in
    the transcript; every `font` key and `sound` key exists in the preset; every resolved end is
    after its start; an `{ at }` anchor does not fall inside a spoken word; item ids unique.
    Each issue's message names the item id and the rule.
  - `parseEdit(json, context)` returns the typed edit or throws with all issues;
    `editJsonSchemaBase()` exports the context-free schema (slice 10 generates the per-reel JSON
    Schema from it with `z.toJSONSchema`).
- `src/anchors.ts`: `resolve(anchor, transcript)` and `itemTimes(item, transcript)`: seconds,
  rounded to the millisecond, looked up on every build.

### 6. Measurement with HarfBuzz

- `src/measure.ts`: `createMeasurer(fonts: Record<string, Uint8Array>)`: imports `harfbuzzjs`
  (its top-level await loads the same `harfbuzz.wasm` in Node and the browser), creates one
  `Blob`/`Face`/`Font` per font, and returns `{ width(fontKey, text, px): number, close() }`:
  shape with HarfBuzz, sum `xAdvance`, scale by `px / upem`. Cache by `fontKey|px|text`. No
  font bytes are read here: the caller passes them (`fetch` in the browser, `readFile` in Node).
- Check the module loads under Vite (browser test) and under plain Node (worker). If harfbuzzjs's
  self-location of the wasm fails under Next or Vite, pass the wasm bytes in as well through its
  `createHarfBuzz({ wasmBinary })` path (`harfbuzzjs/dist/harfbuzz.js` with `init`), and export
  the wasm file path for callers; record which in the doc.

### 7. Layout, fill from style, and checks

- `src/layout.ts`:
  - `faceBox(headTrack, t0, t1, preset)`: as `build.py`'s `face_box`: non-null samples with
    `t` in `[t0 - 0.1, t1 + 0.1]`, falling back to all non-null samples; median `cx`, max `head_w`,
    min `head_top`; box `cx - w/2 - 35` to `cx + w/2 + 30`, `top` to `top + 1.35 w`. `null` when
    the track has no sample at all.
  - `placeCaption(...)`: an item with `style.position` keeps it; otherwise deterministic slots
    beside the face box (the wider side first, rows `lineGap` apart starting at the face's top
    plus 20, never above 610 as in `build.py`), else a row above the head, else shrink to fit;
    with no face box, one centred line at `lowLineTop`. Accents (overlays without a position)
    centre above the head (`aboveHead`).
  - Fill whatever the item does not set from the preset: font, size, colour, timing (appear,
    fade, minimum time on screen).
  - Output a layout entry per text item: `{ id, text, font, size, x, y, width, height }`, every
    number rounded to two decimals.
- `src/checks.ts`: `runChecks(layout, resolvedItems, headTrack, preset)` returns
  `{ ok: boolean, reasons: string[] }`:
  - `safe-box`: every text box inside x 130 to 860, y 260 to 1400:
    `"<item id>: outside the safe box (<edge>)"`.
  - `face`: no caption box overlaps the face box for its time window:
    `"<item id>: covers the face"`.
  - `sound-gap`: sound items sorted by start, consecutive hits at least 0.25 s apart:
    `"<item id>: within 0.25 s of <other id>"`.
  - Reasons sorted, so output is stable.

### 8. The builder

- `src/build.ts`: `build({ edit, transcript, headTrack, preset, measurer })` returns
  `{ html, assets, checks, layout }`:
  - `edit` is parsed with `editSchema({ transcript, preset })` first (an invalid edit throws).
  - `html`: a HyperFrames composition modelled on `rethink-work/index.html` and the HyperFrames
    docs: `<html data-resolution="portrait">`, `@font-face` rules for the preset fonts by their
    relative asset paths, `#root` with `data-composition-id="main"`, `data-start="0"`,
    `data-duration`, `data-width`, `data-height`; `<video id="footage" ... data-has-audio="true">`
    (track 1), `<video id="cutout" muted>` (track 30), `#words` layer (track 40), transition
    layers (`dim`, `panel`, `card` as in the reference), one `<audio>` clip per sound item (own
    track index, volume from `gainDb`, using the attribute the HyperFrames audio docs name), a
    script building one paused GSAP timeline registered as `window.__timelines["main"]`.
    Spans carry the item id; text is HTML-escaped; `custom` is appended to the inline style after
    the generated declarations. Seconds printed with three decimals, pixels with two.
  - `assets`: the relative paths the page references, each with a role: `footage` and `cutout`
    (with the fingerprint from `edit.inputs`), `font`, `sound`. The caller maps them to URLs or
    files; nothing is fetched here.
  - Duration: the end of the last word plus the preset's tail, or a `footage` item's end anchor.
  - Never stored: no write anywhere, no cache.
- `src/baseline.ts`: `baselineEdit(transcript, inputs, preset)`: `footage` and `cutout` items from
  the first word's start (`{ at: 0 }`) to the last word's end, one caption per word anchored to
  itself (`start: { word: id }`, `end: { word: id }`, text with the glossary applied), no
  overlays, transitions or sounds.
- `src/index.ts`: export the public API only (knip checks unused exports).

### 9. Test data, fixture versions and golden outputs

- `src/testdata/short-speech/transcript.json` and `head-track.json`: copies of
  `fixtures/pipeline/retime/transcript.json` and `fixtures/pipeline/head_track/head-track.json`
  (or read those directly from the tests; prefer direct reads so there is one copy).
- `src/testdata/rethink-work/transcript.json` and `head-track.json`: from the reference reel
  (read-only source); convert ids `w0`... to the studio's `w0001`... (index plus one, four digits)
  and wrap as `{ "words": [...] }`; record the conversion in a one-line comment in the test that
  reads them, not in the JSON.
- `src/testdata/versions/`: stored fixture versions (complete `edit.json` files):
  `short-speech-baseline.json` (the baseline of the fixture clip), `rethink-work-baseline.json`
  (about 48 s, used for speed), and `rethink-work-accents.json`, written by hand from `build.py`'s
  decisions: accents on `disrupted` and `purpose` (`w0030`, `w0113`) in the primary font and
  accent colour, transition `dim` from `w0092` (offset -0.03) to the end of `w0100` (offset 0.2),
  one `click` sound at that transition's start, and one caption with a `custom` style.
- `src/testdata/built/<name>.html` and `<name>.layout.json`: golden outputs, written by the Node
  test when `UPDATE_GOLDEN=1` is set and compared byte for byte otherwise. Add the folder to
  `.prettierignore` so formatting never rewrites a golden.

### 10. Unit tests in Node

- `src/schema.test.ts`: an edit with an unknown word id, an item whose end resolves before its
  start, a `font: "comic"` outside the preset, an `{ at }` inside a spoken word, a duplicate item
  id and a `custom` style containing `}` or `url(` are each rejected with the item named; the
  fixture versions parse.
- `src/build.test.ts`:
  - goldens: each fixture version builds to exactly its golden `html` and `layout`;
  - determinism: building twice gives byte-identical `html` and equal `layout`;
  - anchors survive retime: the same edit against a second transcript with the same ids and every
    time shifted and stretched (for example `t * 1.1 + 0.5`): every item's start and end in the
    output follow its word (read back from the layout's times and from the timeline script);
  - speed: building `rethink-work-baseline.json` (measurer already created) takes under 200 ms,
    best of three.
- `src/checks.test.ts`: a 40-character word at 110 px fails `safe-box`; a caption with a position
  inside the face box of a synthetic head track fails `face`; two clicks 0.2 s apart fail
  `sound-gap`; the short-speech baseline and the rethink-work baseline pass all checks.
- `src/versions.test.ts` with in-memory stores (see task 13).
- Fonts in Node tests are read with `readFile` from `../assets/fonts/`.

### 11. The same build in Chromium

- `src/build.browser.test.ts`: fetches the font bytes and imports the fixture versions,
  transcripts and goldens through Vite (`?url` and `?raw` imports), creates the measurer, builds
  each fixture version and asserts `html` and `JSON.stringify(layout)` equal the goldens byte for
  byte.
- Negative proof (do it, then remove it): temporarily replace the measurer in this file with one
  built on `OffscreenCanvas` `measureText` (fonts loaded with `FontFace`); run
  `yarn workspace @edit-issebya/edit test` and confirm the browser project fails on the layout
  comparison; restore the HarfBuzz measurer and confirm it passes. Record both outcomes (the
  failing diff's first lines) in the PR description. No probe stays in the code.

### 12. Storage: refuse to overwrite

- Add `putIfAbsent(key: string, body: Uint8Array, options?: { contentType?: string }): Promise<"written" | "exists">`
  to `Storage` in `packages/storage/src/storage.ts`; implement it in `r2.ts` (`PutObjectCommand`
  with `IfNoneMatch: "*"`, a 412 maps to `"exists"`, exactly as `putFileIfAbsent`) and in `fake.ts`
  (write to a temporary name, then link or open with `wx` so an existing key is never replaced).
- Implement it in every other object that satisfies `Storage` (search the repository for
  `: Storage` and `Storage =` including test doubles).
- Tests in `fake.test.ts` and `r2.test.ts`: first write `"written"`, second `"exists"` and the
  bytes unchanged; the R2 test checks the `IfNoneMatch` header and the 412 mapping.

### 13. Versions migration and operations

- `supabase/migrations/20261104090000_versions.sql` (keep it after the last migration present
  after task 1):
  - `public.versions`: `id uuid primary key default gen_random_uuid()`, `reel_id uuid not null
references public.reels (id) on delete cascade`, `owner_id uuid not null references auth.users
(id) on delete cascade`, `number int not null check (number >= 1)` with `unique (reel_id,
number)` (shown as "version N"; ordered and race-safe without trusting `created_at`),
    `parent_id uuid references public.versions (id)`, `restored_from_id uuid references
public.versions (id)`, `request text`, `model text`, `prompt_version text`, `change_summary
text`, `checks jsonb not null`, `inputs jsonb not null`, `r2_key text not null unique`,
    `created_at timestamptz not null default now()`; index on `(reel_id, number)`.
  - Immutable rows: a `before update or delete` trigger that raises unless the row is being
    removed by the reel's cascade (allow delete only through `on delete cascade`: implement as a
    trigger that blocks `update` always; `delete` stays possible only for the service role and
    the cascade, since no grant allows it to `authenticated`).
  - `alter table public.reels add column current_version_id uuid references public.versions (id)
on delete set null`.
  - RLS on; `revoke all on public.versions from anon, authenticated`; `grant select` to
    `authenticated`; policy `versions: owner selects own` (`(select auth.uid()) = owner_id`). No
    insert, update or delete policy: only the worker (secret key) writes.
  - `public.save_version(p_id uuid, p_reel_id uuid, p_parent_id uuid, p_restored_from_id uuid,
p_request text, p_model text, p_prompt_version text, p_change_summary text, p_checks jsonb,
p_inputs jsonb, p_r2_key text) returns public.versions`, `security definer`,
    `set search_path = ''`: locks the reel row (`for update`), checks `p_parent_id` equals the
    reel's `current_version_id` (so two writers cannot fork history silently; raise otherwise),
    sets `owner_id` from the reel, `number` as max plus one, inserts, sets
    `reels.current_version_id`, returns the row. Revoke execute from `public, anon, authenticated`;
    grant to `service_role` only.
  - Add `versions` to `supabase_realtime` only if slice 9 needs it; not now.
- `packages/edit/src/versions.ts`:
  - `versionKey(prefix, reelId, versionId)` = `${prefix}reels/<reel_id>/versions/<version_id>.json`.
  - Interfaces: `VersionObjects { get(key): Promise<Uint8Array | null>; putIfAbsent(key, bytes, opts): Promise<"written" | "exists"> }`
    (a `Storage` satisfies it structurally; no import of the storage package) and
    `VersionStore { current(reelId): Promise<{ id, number } | null>; get(versionId): Promise<VersionRow | null>; insert(row): Promise<VersionRow> }`.
  - `saveVersion({ objects, store, prefix, reelId, id, edit, meta })`: canonical JSON of the edit
    (sorted keys, so the same edit gives the same bytes), `putIfAbsent`; `"exists"` throws
    `version object already exists: <key>`; then `store.insert` (the database function). The
    caller passes the new id (`crypto.randomUUID()` in the worker; the package never generates
    ids itself, since it has no randomness).
  - `restoreVersion({ objects, store, prefix, reelId, fromId, id })`: reads the old row and
    object, saves a new version with the same edit, `parent_id` = the current version,
    `restored_from_id` = `fromId`, `change_summary` `restored version <n>`, `checks` copied,
    `model`/`request` null. The old rows and objects are never touched.
- `packages/edit/src/supabase-versions.ts`: `supabaseVersionStore(db: SupabaseClient)` (type-only
  import) with named column lists, never `*`; `insert` calls `save_version` through `db.rpc`.
- `src/versions.test.ts`: with an in-memory object map and store: saving writes the object and a
  row; saving the same key twice is refused and leaves the first bytes; v1, v2, v3 then
  `restoreVersion(v1)` gives v4 with `restored_from_id = v1`, `parent_id = v3`, its object equal
  to v1's bytes, and v1 to v3 (rows and objects) unchanged.

### 14. Worker: the first version step and the import proof

- Make `runPipeline` return the fingerprints it computed (`{ fingerprints }`) and keep its
  existing behaviour and tests.
- `apps/worker/src/steps/first-version.ts`: an in-process step `first_version` through
  `runInProcessStep` (wall time only):
  - if the reel already has a current version (a retried job), the summary is
    `version <n> already saved` and nothing is written;
  - otherwise read `retime/<fp>/transcript.json` and `head_track/<fp>/head-track.json` from
    storage with `cacheKey`, read the font files from the package's assets with `readFile`
    (`import.meta.resolve("@edit-issebya/edit/assets/fonts/...")`), build `baselineEdit` with
    `inputs` = `{ footage: fp(retime), transcript: fp(retime), cutout: fp(remove_background), headTrack: fp(head_track) }`,
    run `build` (which runs the checks), and `saveVersion` with `model`, `request`,
    `prompt_version` null, `change_summary` `automatic first version from the issebya style`,
    `checks` the build's result; summary `version 1 saved`, plus `, <k> check failures` when the
    checks did not pass (the version is still saved: the decide step fixes it).
  - After an abort (lost lease) it writes nothing more (`signal.throwIfAborted()` before each
    write).
- `apps/worker/src/process-job.ts`: run `firstVersion` after `runPipeline` inside `work`, with
  `supabaseVersionStore(db)` and the job's storage and key prefix.
- `apps/worker/src/steps/first-version.test.ts` (no database, no tools): a fake step store and
  in-memory storage seeded with `fixtures/pipeline/` transcript and head track: the step saves
  one version with the right key, inputs and null model; a second run with a current version
  writes nothing and says `already saved`; an aborted signal writes nothing.
- `apps/worker/src/edit-import.test.ts`: spawns `process.execPath` with
  `--input-type=module -e` importing `@edit-issebya/edit`, building `baselineEdit` from the
  fixture transcript and printing the HTML length, `cwd` `apps/worker`; asserts exit 0. This
  proves Node 24 strips the package's types: Node resolves the workspace symlink to its real path
  under `packages/edit/`, which is outside `node_modules`, the same reason
  `@edit-issebya/storage` already runs without a build step. State this in the PR.
- `apps/worker/package.json`: `yarn workspace @edit-issebya/worker add @edit-issebya/edit@workspace:*`.

### 15. Studio wiring and the DB test

- `yarn workspace @edit-issebya/studio add @edit-issebya/edit@workspace:*`; add
  `"@edit-issebya/edit"` to `transpilePackages` in `apps/studio/next.config.ts` (slice 9 builds in
  the browser; `next build` must still pass with it listed).
- `apps/studio/db-tests/versions.test.ts` (local stack only, through the existing helpers):
  - with the admin client as the worker and a temporary `fakeStorage` folder, save v1 to v3
    through `saveVersion` and `supabaseVersionStore`, then `restoreVersion(v1)`: v4 has
    `restored_from_id = v1`, `parent_id = v3`, `number = 4`; `reels.current_version_id = v4`;
    v1 to v3 rows equal their earlier reads;
  - writing an existing version key is refused and inserts no row;
  - `save_version` with a stale `p_parent_id` raises;
  - RLS: the owner selects their four versions; another signed-in user selects none and sees
    `current_version_id` of no reel of theirs; `authenticated` cannot insert, update or delete
    versions, cannot execute `save_version`; `anon` reads nothing;
  - an update of a version row through the admin client raises (immutable).
- The existing "every public table has RLS" test covers `versions` automatically; add `versions`
  to its `arrayContaining` list.

### 16. E2E: version 1 after the worker's `once`

- Extend `apps/studio/e2e/upload.spec.ts` (issue 30 version): after the six hits, the step log has
  a seventh line `first_version: version 1 saved` (shown live, no reload); `reels.current_version_id`
  is set; the `versions` row has `number` 1, `model` null, `request` null, `parent_id` null and
  `inputs` equal to the fixture manifest's retime, remove_background and head_track fingerprints;
  the object exists in the storage fake at
  `${CACHE_PREFIX}reels/<reel id>/versions/<version id>.json` and parses with `parseEdit`. Delete
  that object in `afterAll`.
- If the step-row assertion in the spec lists exact rows, add the `first_version` row (status
  `done`, `cache_hit` false, wall time only).

### 17. Tooling, CI and profile

- `knip.json`: add `"packages/edit": { "project": ["src/**/*.ts"], "vitest": true }` (check that
  knip resolves the browser project and `?raw` imports; ignore the `testdata` JSON if needed,
  never by weakening a rule for real code).
- `turbo.json`: if Chromium is not found under turbo's strict env mode, add `PLAYWRIGHT_*` (and
  only what is needed) to the `test` task's `passThroughEnv`.
- `.github/workflows/ci.yml`: move `yarn workspace @edit-issebya/web playwright install --with-deps chromium webkit`
  before `yarn test`, since the unit layer now launches Chromium.
- `.prettierignore`: `packages/edit/src/testdata/built/`.
- `.adw/project.md` (headings unchanged):
  - Identity: mention `packages/edit` (`@edit-issebya/edit`), the edit format and builder shared
    by the studio and the worker (TypeScript source, no build).
  - Workspaces: row `| edit | \`packages/edit\` | none (library) | none | none | none | never |`(the issue's "ADW may start: no"; this table uses`never`for libraries); add the package name
to the names list and`edit`to`target_apps` (`packages/edit`).
  - Build: `--filter=./packages/edit`, no build script, its build check is typecheck.
  - Tests: unit layer `packages/edit/src/**/*.test.ts` (Node); new browser unit layer
    `packages/edit/src/**/*.browser.test.ts` (Vitest browser mode, Playwright provider, Chromium,
    run by the same `yarn test`, needs the Chromium install from Install step 3; golden outputs in
    `packages/edit/src/testdata/built/`, rewritten only with `UPDATE_GOLDEN=1` in the Node run);
    DB layer gains `versions.test.ts`.
  - Protected: add `yarn workspace @edit-issebya/edit add <pkg>`; never store a built page; never
    rewrite a version object or row.
- `README.md`: add `packages/edit/  the edit format and builder the studio and the worker share,
workspace @edit-issebya/edit` to the layout block.

### 18. Documentation

- New `app_docs/edit-model.md` with the standard sections (Specifications, Overview, How it
  works, Configuration, Testing, Rules, Notes): the format (tracks, items, word and time anchors,
  edges and offsets, the free `custom` field and its character limits), the preset values, the
  builder contract (`build` inputs and outputs, assets, determinism, no stored page), the checks
  and their reason strings, versions (table, `save_version`, R2 key, immutability, restore), the
  automatic first version, the cross-environment test and goldens, the Node import proof, the asset
  licences. Rules: do not change a version object or row once saved; do not fork the builder per
  environment; do not store a built page; anchors are words, seconds only where nobody speaks; do
  not use Node-only or browser-only APIs, the clock or randomness in `packages/edit/src`; never
  update a golden except through `UPDATE_GOLDEN=1` with the reason in the commit.
- `docs/conditional-docs.md`: one line: read `app_docs/edit-model.md` when changing
  `packages/edit` (format, preset, builder, checks, HarfBuzz measurement), the `versions` table or
  `current_version_id`, `save_version`, the `first_version` step, or the browser test layer.
- `app_docs/pipeline.md`: add the `first_version` step after the fixed steps (one paragraph,
  pointing to the new doc). `app_docs/studio.md`: Rules gain "never grant `authenticated` insert,
  update or delete on `versions`, nor execute on `save_version`".

### 19. Apply the migration and run the validation commands

- `supabase migration up --local` before the DB and E2E tests; if it fails, report the error and
  stop (never reset).
- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `packages/edit` (Node): schema rejections, anchors under retime, determinism, goldens, speed,
  checks, version save, refuse and restore with in-memory stores.
- `packages/edit` (Chromium, Vitest browser mode): the same fixture versions built against the
  same goldens.
- `packages/storage`: `putIfAbsent` in the fake and in R2 (mocked client).
- `apps/worker`: the `first_version` step with fakes; the spawned import proof; existing
  `run-pipeline` tests updated for the returned fingerprints.

### Test Coverage

- `packages/edit/src/build.browser.test.ts` (browser unit layer, new) plus `build.test.ts` (unit):
  catch any difference between the browser and Node builds (measurement, number formatting,
  ordering); the canvas probe proves the comparison can fail.
- `packages/edit/src/build.test.ts` (unit): catches items that stop following their words after a
  retime, any non-determinism, and a build slower than 200 ms.
- `packages/edit/src/checks.test.ts` (unit): catches text outside the safe box, captions over the
  face and clicks closer than 0.25 s.
- `packages/edit/src/schema.test.ts` (unit): catches edits naming unknown words, inverted items,
  fonts outside the preset and unsafe custom styles.
- `packages/edit/src/versions.test.ts` (unit) and `apps/studio/db-tests/versions.test.ts` (DB):
  catch overwritten versions, rewritten history, a wrong restore chain and RLS leaks.
- `packages/storage/src/fake.test.ts`, `r2.test.ts` (unit): catch a store that replaces an
  existing object.
- `apps/worker/src/steps/first-version.test.ts` and `edit-import.test.ts` (unit): catch a missing
  first version, a duplicate on retry, and a package Node cannot run.
- `apps/studio/e2e/upload.spec.ts` (studio E2E): catches the worker not saving version 1 or not
  setting `current_version_id`, and the status page not showing `version 1 saved`.
- The only browser-visible change is one more step line; it is covered by the E2E extension. No
  review screenshots are needed beyond the profile's standard studio captures.

### Edge Cases

- A transcript with one word; an edit whose last item ends on the last word.
- A head track that is all `null` (the fixture clip): captions fall back to the centred low line,
  the face check passes vacuously.
- An `{ at }` anchor inside a pause next to a word boundary (exactly at a word's end is allowed).
- Words longer than any slot: shrunk, and if still outside the safe box, reported, not hidden.
- Non-ASCII text and HTML-special characters (`<`, `&`, quotes) in words: escaped, measured
  correctly by HarfBuzz.
- Two sounds exactly 0.25 s apart: allowed; 0.249 s: refused.
- A retried job after version 1 is saved: no second version.
- A stale `p_parent_id` (two writers): `save_version` raises.
- An object written but the row insert failed: the next attempt uses a new id; the orphan object
  is harmless (slice 14 cleanup can list objects without rows).

## Acceptance Criteria

- `packages/edit` exists, exports the schema, preset, builder, checks, baseline and version
  operations, and its source contains no Node-only or browser-only API, no clock and no
  randomness (enforced by ESLint).
- Fonts and click sound are committed under `packages/edit/assets/` with their licence files
  (OFL for both fonts, CC0 for the click).
- The fixture versions build byte-identically in Node and Chromium against committed goldens; the
  canvas probe made the browser run fail and was removed.
- Rebuilding against a retimed transcript moves every item with its word; two builds are
  byte-identical; the rethink-work baseline builds in under 200 ms in Node.
- The check, schema, version and storage cases in the issue's Verification section pass.
- After the worker's `once` on the fixture clip, the reel has `current_version_id` set and the
  page shows `first_version: version 1 saved`.
- `versions` has RLS (owner selects only), only the service role writes, rows are immutable.
- The worker imports the package's TypeScript directly (proved by a test), stated in the PR.
- `turbo.json`, `knip.json`, CI, `.adw/project.md`, `README.md`, `app_docs/edit-model.md` and
  `docs/conditional-docs.md` are updated; no em-dashes anywhere.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: whole-repository formatting (goldens are ignored).
- `yarn turbo run lint --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: lint, including the package's no-environment rules.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: types across the package and both consumers (the package's build check).
- `yarn knip`: dead code and unused dependencies across all workspaces.
- `yarn turbo run test --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: unit tests, including the Chromium browser project.
- `yarn lint && yarn typecheck && yarn test`: the unfiltered hooks' commands, to prove nothing else regressed.
- `supabase migration up --local`: applies the versions migration to the shared local stack (stop and report on failure; never reset).
- `yarn turbo run test:db --filter=./apps/studio`: RLS, immutability, `save_version` and restore against the local stack.
- `yarn build`: unfiltered build (root files, CI and turbo changed); the studio builds with the new `transpilePackages` entry.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the landing and studio suites, including the extended upload spec (ports from `.ports.env`).

## Notes

- New dependencies (all added with `yarn workspace <name> add`, never another package manager):
  `zod@4.6.7` and `harfbuzzjs@1.6.4` in `@edit-issebya/edit`; dev `vitest`,
  `@vitest/browser-playwright@5.0.5`, `playwright@1.64.0`, `@supabase/supabase-js` (types),
  `typescript`, ESLint packages in `@edit-issebya/edit`; `@edit-issebya/edit@workspace:*` in the
  worker and the studio.
- harfbuzzjs 1.6.4 ships `dist/index.mjs`, which top-level awaits `createHarfBuzz()`; its
  Emscripten loader finds `harfbuzz.wasm` by `fetch` in the browser and by `fs` in Node. The
  compiled code is the same in both; only the loading differs, which is inside the dependency, not
  in the builder. If a bundler cannot locate the wasm, fall back to passing `wasmBinary`
  (task 6).
- Licences checked while planning: Freesound 678248 "Mouse Click Sound.mp3" by Pixeliota is CC0;
  Raleway and Golos Text are OFL 1.1 families (the reference repository's own asset index says
  "licence to confirm" for the sound, so re-check before committing).
- The `versions.number` column and the `save_version` function are additions to the issue's
  column list: the status line says "version 1" and restore needs the reel's current version read
  and moved atomically. `inputs` carries a fourth fingerprint (`headTrack`) beside the three the
  issue names.
- The browser test layer is new to this repository; it runs inside `yarn test`, so the pre-push
  hook and CI need Chromium installed first (Install step 3 locally; CI step moved).
- Dates and numbers with units as one caption, the glossary's multi-word joins, the title,
  chapter numbers and b-roll are not in the baseline; the decide step (slice 10) adds them as
  edit items.
- Manual acceptance (owner, not the pipeline): write `rethink-work`'s edit by hand, build it
  against that reel's transcript and head track, render once with HyperFrames and compare with
  `rethink-work/renders/rethink-work-02.mp4`; differences go to a follow-up issue.
- Out of scope: the player and preview page (9), the decide step and per-reel JSON Schema (10),
  change requests (11), export (12), more styles, a timeline editor.
