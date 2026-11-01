# Feature: edit model in packages/edit: word-anchored timeline, immutable versions in R2, HarfBuzz builder

## Metadata

issue_number: `31`
adw_id: `7f81a19d`
issue_json: `{"number":31,"title":"feat: edit model in packages/edit: word-anchored timeline, immutable versions in R2, HarfBuzz builder", ...}` (Reel studio MVP, slice 8 of 17; full body restated in the sections below)

## Feature Description

Every edit of a reel becomes data. A new shared workspace, `packages/edit` (`@edit-issebya/edit`),
holds:

- the transcript type (`{ id, text, start, end }` words, the format `transcribe` and `retime`
  already write);
- the edit format (`edit.json`): a timeline of tracks (footage, cut-out, captions, overlays,
  transitions, sounds) whose items start and end on **words** (seconds only where nobody speaks),
  with per-item properties and a free custom-style field, validated by Zod 4;
- the issebya style preset (frame, safe box, fonts, sizes, colours, click sound, glossary);
- the **builder**, `build(edit, transcript, headTrack, preset, measurer) -> { html, assets, checks }`,
  which turns one version into a HyperFrames composition, measuring every word with HarfBuzz
  (`harfbuzzjs`, WebAssembly), deterministic and free of any Node-only or browser-only API, so the
  studio (preview, slice 9) and the worker (layout checks, export, slice 12) run the very same code;
- the layout checks (text inside the safe box, captions clear of the face, clicks at least 0.25 s
  apart, time anchors outside speech), returned as reason strings;
- version operations (`saveVersion`, `restoreVersion`) over injected row and blob interfaces.

Versions are immutable: each one is a complete `edit.json` in R2 at
`${R2_KEY_PREFIX}reels/<reel_id>/versions/<version_id>.json` (put-if-absent, never replaced) plus a
`versions` row (parent, restored-from, request, model, prompt version, change summary, checks,
input fingerprints). `reels.current_version_id` points at the current one; going back creates a new
version that copies the old one. After the fixed pipeline steps the worker saves an automatic
version 1 built from the preset alone (no AI), so slice 9 has something to play and slice 10's
decide step has a starting point. The studio's step log shows one more line:
`first_version: version 1 saved, ...`.

## User Story

As the reel studio owner
I want every edit of a reel stored as an immutable, word-anchored version that one shared builder
turns into the same HyperFrames page in the browser and in the worker
So that preview and export can never disagree, edits survive re-timing of the footage, and any
earlier version can be brought back without losing history.

## Problem Statement

The pipeline now produces footage, a transcript, a cut-out and a head track, but nothing describes
what the reel should look like. The old `build.py` hard-coded every decision in Python, measured
text with PIL on one machine, used seconds everywhere (so a re-time broke every overlay) and kept
no history. The studio (browser) and the worker (Node) need one shared, deterministic definition of
an edit and one builder whose text measurements are identical in both places, plus an append-only
version history.

## Solution Statement

- Create `packages/edit` as TypeScript source with no build step (the same pattern as
  `packages/storage`): Next transpiles it (`transpilePackages`), Node 24 strips its types because a
  workspace package resolves through its symlink to `packages/edit/src/...`, which is outside
  `node_modules`. This is proven by a worker unit test that spawns plain `node` importing the
  package, and again by the E2E `once` run.
- Platform neutrality is enforced, not hoped for: `packages/edit/tsconfig.json` type-checks `src/`
  (tests excluded) with `lib: ["ES2024"]` and `types: []` (no DOM, no Node types), and the package's
  ESLint config forbids `node:*` and other Node built-in imports, `process`, `Buffer`, `window`,
  `document`, `fetch`, `Date`, `performance`, `Math.random` and `crypto` in non-test source.
  Callers supply the font bytes, the HarfBuzz instance and (for versions) the id generator.
- Zod 4 schema built per reel: `editSchemaFor(preset, transcript)` knows the transcript's word ids
  and the preset's fonts, so an unknown word id, an item ending before it starts and a font outside
  the preset are rejected by the schema itself; it stays `z.toJSONSchema`-compatible for slice 10.
- Builder: resolve anchors to seconds through the transcript, fill unset properties from the
  preset (positions around the head, fonts, sizes, colours), measure with HarfBuzz
  (`sum(x_advance) * size / unitsPerEm`), emit a HyperFrames composition modelled on the reference
  `rethink-work/index.html` (root `data-composition-id="main"`, `<video>` footage and cut-out clips,
  absolutely positioned word spans, `<audio>` clips for clicks at `data-volume` for -13 dB, a paused
  GSAP timeline registered on `window.__timelines["main"]`), with fixed number formatting and a
  stable element order so output is byte-identical everywhere.
- Cross-environment proof: committed fixture versions (the short-speech baseline and a hand-written
  `rethink-work` edit with accents, a transition and a click) are built in Node (Vitest) and in
  Chromium (Vitest browser mode, Playwright provider); both must equal the same committed golden
  HTML and golden widths files byte for byte.
- Versions: a migration adds `versions` (plus a `number` per reel for the "version N" wording),
  `reels.current_version_id` (composite FK so it can only name a version of the same reel), an
  update-refusing trigger (rows never change), owner-only `select` RLS, no `authenticated` write, and
  one `security definer` function `save_version` (service role only) that inserts the row, refuses a
  parent that is not the reel's current version, and moves `current_version_id`, in one transaction.
- Storage gains `putIfAbsent(key, bytes)` (R2 `If-None-Match: *`, the fake via an exclusive link),
  so a version key is never written twice.
- Worker: after `runPipeline`, a `first_version` in-process step reads the retimed transcript,
  `retime.json` (duration) and `head-track.json` from the cache, builds the baseline edit, runs the
  builder's checks, and saves version 1 (`model` null, `request` null). A reel that already has a
  version records a hit instead.

## Relevant Files

Use these files to implement the feature:

- `README.md`: the workspace list at the top gets a `packages/edit/` line.
- `AGENTS.md`: repository rules (Yarn only, no em-dashes, migrations via `supabase migration new`,
  feature docs, `.adw/project.md` upkeep).
- `docs/conditional-docs.md`: add the line for `app_docs/edit-model.md`.
- `app_docs/studio.md`: matches (tables, RLS, migrations, `apps/worker`, `packages/storage`, DB and
  E2E tests). Rules to keep: no `*` selects, no client at module load, never point a test at real R2
  / AI / hosted project, never put large content in rows (the edit lives in R2, the row holds
  metadata and the small `checks`/`inputs` JSON), only the worker writes job and step state.
- `app_docs/pipeline.md`: matches (fingerprints, R2 cache, transcript and head-track formats,
  HyperFrames, `fixtures/pipeline/`). Rules: never overwrite a stored output, word ids never change,
  never write to `issebya-homes-reels`, never touch `fixtures/footage/short-person.mp4`.
- `app_docs/measurement.md`: matches (the step runner; the new step uses `runInProcessStep` /
  `recordHit`).
- `app_docs/adw-supabase-stack.md`: how a run applies a new migration (`.adw/supabase-stack reset`).
- `.adw/project.md`: Identity, Workspaces, Build, Tests, Protected need the new workspace and the new
  browser test layer; never rename or reorder the nine headings.
- `package.json` (root), `turbo.json`, `knip.json`, `lefthook.yml`, `.github/workflows/ci.yml`: task
  wiring, dead-code config, CI order (the Playwright browser install must move before `yarn test`).
- `packages/storage/src/storage.ts`, `r2.ts`, `fake.ts`, `r2.test.ts`, `fake.test.ts`, `index.ts`:
  add `putIfAbsent`; follow the existing `putFileIfAbsent` pattern and tests.
- `packages/storage/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`,
  `README.md`: the template for the new package.
- `apps/worker/src/process-job.ts`: wire the first-version step after `runPipeline`.
- `apps/worker/src/pipeline/run-pipeline.ts`: return the fingerprints (and source ref) it computed.
- `apps/worker/src/pipeline/definition.ts`, `fingerprint.ts` (`cacheKey`), `retime-plan.ts`
  (`RetimePlan.durationSeconds`), `head-track.ts` (the head-track entry type), `transcript.ts` (the
  transcript type to replace with the package's).
- `apps/worker/src/step-runner.ts` (`runInProcessStep`, `recordHit`), `step-store.ts`,
  `summary.ts` (`stepSummary` gives `version 1 saved, under a second, 3.1 KB`).
- `apps/worker/src/storage.ts`, `config.ts` (`keyPrefix`), `supabase.ts`, `package.json`,
  `tsconfig.json`, `vitest.config.ts`.
- `apps/studio/next.config.ts` (`transpilePackages`), `apps/studio/package.json`.
- `apps/studio/src/lib/jobs.ts`, `reels.ts`: column-list conventions for the new `versions.ts`.
- `apps/studio/db-tests/rls.test.ts`, `jobs.test.ts`, `apps/studio/test-support/fixtures.ts`,
  `local-supabase.ts`: patterns and helpers for the new `versions.test.ts`.
- `apps/studio/e2e/upload.spec.ts`, `apps/studio/test-support/worker.ts`: the E2E to extend.
- `supabase/migrations/20261031174750_job_queue.sql`: grant / RLS / `security definer` function
  patterns to copy.
- `fixtures/pipeline/retime/transcript.json`, `retime.json`, `fixtures/pipeline/head_track/head-track.json`,
  `fixtures/pipeline/manifest.json`: the fixture clip's inputs for the baseline version.
- `apps/worker/src/pipeline/testdata/rethink-work/`: existing reference data.
- `node_modules/hyperframes/dist/docs/compositions.md`, `data-attributes.md`, `gsap.md`,
  `rendering.md`, `examples.md`: read before choosing the page structure (pinned `hyperframes`
  0.8.222).
- Read-only reference (another repository, never write to it):
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/editing-guide.md`,
  `.../editing/asset-index.md`, `.../editing/videos/rethink-work/{build.py,index.html,clicks.json,transcript.json,head-track.json,assets/fonts/,assets/sounds/}`.

### New Files

- `packages/edit/package.json`: `@edit-issebya/edit`, `type: module`, `exports`
  `{ ".": "./src/index.ts", "./assets/*": "./assets/*" }`, scripts `typecheck`, `lint`,
  `lint:fix`, `test` (`vitest run`, both projects), `golden` (regenerates goldens in Node).
- `packages/edit/tsconfig.json` (src only, `lib: ["ES2024"]`, `types: []`),
  `packages/edit/tsconfig.test.json` (tests, scripts, configs: node and vitest browser types).
- `packages/edit/eslint.config.mjs`: storage's config plus the platform-neutral restrictions.
- `packages/edit/vitest.config.ts`: projects `node` and `browser` (chromium, Playwright provider).
- `packages/edit/README.md`: one paragraph plus links, like storage's.
- `packages/edit/assets/fonts/Raleway-Light.ttf`, `GolosText-Bold.ttf`, `OFL-Raleway.txt`,
  `OFL-GolosText.txt`; `packages/edit/assets/sounds/mouse-click-trimmed.wav`, `LICENSE-sounds.md`.
- `packages/edit/src/index.ts`: the public API.
- `packages/edit/src/transcript.ts`: `Word`, `Transcript`, `transcriptSchema`.
- `packages/edit/src/head-track.ts`: `HeadSample`, `HeadTrack`, `faceBox(track, t0, t1)`.
- `packages/edit/src/schema.ts`: anchors, items, tracks, `editSchemaFor(preset, transcript)`,
  `parseEdit`.
- `packages/edit/src/preset.ts`: `ISSEBYA_PRESET`.
- `packages/edit/src/measure.ts`: `createMeasurer(hb, fonts)`, `Measurer`.
- `packages/edit/src/timeline.ts`: `resolveTimeline(edit, transcript)` (anchors to seconds).
- `packages/edit/src/layout.ts`: fills positions from the preset (slots around the head).
- `packages/edit/src/checks.ts`: `runChecks`.
- `packages/edit/src/html.ts`: escaping, number formatting, the composition writer.
- `packages/edit/src/build.ts`: `build(...)`.
- `packages/edit/src/baseline.ts`: `baselineEdit(transcript, inputs, preset)`.
- `packages/edit/src/versions.ts`: `versionKey`, `VersionRows`, `VersionBlobs`, `saveVersion`,
  `restoreVersion`.
- `packages/edit/src/*.test.ts`: unit tests (node project), `packages/edit/src/build.browser.test.ts`
  (browser project), `packages/edit/src/test-support/` (Node and browser measurer loaders, fixture
  list shared by both runs).
- `packages/edit/src/testdata/rethink-work/transcript.json`, `head-track.json` (copied from the
  reference reel), `packages/edit/src/testdata/versions/baseline-short-speech.edit.json`,
  `rethink-work-hand.edit.json`, `packages/edit/src/testdata/golden/*.html`, `*.widths.json`.
- `packages/edit/scripts/golden.ts`: writes the goldens from the Node build.
- `supabase/migrations/<stamped>_versions.sql` (created with `supabase migration new versions`).
- `apps/worker/src/edit-measurer.ts`: loads the HarfBuzz wasm and the two fonts from the package's
  assets with `node:fs`, once per process.
- `apps/worker/src/first-version.ts`, `first-version.test.ts`: the step.
- `apps/worker/src/version-store.ts`: Supabase and storage adapters for `VersionRows` / `VersionBlobs`.
- `apps/worker/src/edit-import.test.ts`: proves plain Node imports the package's TypeScript source.
- `apps/studio/src/lib/versions.ts`: `VERSION_COLUMNS`, `VersionRow` (typed with the package's
  `Check` and `EditInputs`).
- `apps/studio/db-tests/versions.test.ts`.
- `app_docs/edit-model.md`.

## Implementation Plan

### Phase 1: Foundation

Licences and assets first (a blocker if one fails), then the package skeleton with its
platform-neutral guard rails, the `putIfAbsent` storage primitive, and the migration.

### Phase 2: Core Implementation

Transcript and head-track types, schema, preset, measurer, timeline resolution, layout, checks,
HTML writer, `build`, `baselineEdit`, version operations; fixtures, goldens and the Node and
browser test projects.

### Phase 3: Integration

Worker first-version step, studio wiring, E2E extension, CI order, turbo / knip / profile / docs.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Check the asset licences (stop if one fails)

- Fonts: confirm both are SIL OFL 1.1 from the font files' own name table (nameID 0 copyright,
  13 licence, 14 licence URL), e.g. with a short throwaway Node script using `harfbuzzjs` after it is
  added (step 3), or `fc-query`. Copy the matching official `OFL.txt` (Google Fonts `ofl/raleway/`
  and `ofl/golostext/`, carrying each project's own copyright line) as `OFL-Raleway.txt` and
  `OFL-GolosText.txt`.
- Click: the reference `asset-index.md` says the source is Freesound 678248 by pixeliota,
  "licence to confirm". Open `https://freesound.org/s/678248/` (WebFetch) and read its licence.
  CC0: record it in `assets/sounds/LICENSE-sounds.md` (source URL, author, licence, "trimmed to the
  press, onset 8 ms"). CC BY 4.0: same file with the required attribution. Any licence that does not
  allow redistribution in a public repository (NC, ND with the trim, Sampling+, or unknown): **stop
  the run and report it**; do not commit the sound.
- Copy `Raleway-Light.ttf`, `GolosText-Bold.ttf` and `mouse-click-trimmed.wav` from
  `.../videos/rethink-work/assets/` into `packages/edit/assets/fonts/` and `assets/sounds/`
  (read-only source; never write there). Measure the click's duration once (`ffprobe`) for the preset.

### 2. Storage: `putIfAbsent`

- `packages/storage/src/storage.ts`: add
  `putIfAbsent(key, body: Uint8Array, options?: { contentType?: string }): Promise<"written" | "exists">`
  with the same comment style as `putFileIfAbsent`.
- `r2.ts`: `PutObjectCommand` with `IfNoneMatch: "*"`; HTTP 412 means `"exists"` (reuse the
  existing 412 handling of `putFileIfAbsent`).
- `fake.ts`: write a temp file, then `link` to the final path; `EEXIST` means `"exists"`; remove the
  temp file either way.
- Tests in `r2.test.ts` and `fake.test.ts` mirroring the `putFileIfAbsent` ones: written once,
  second call `"exists"` and bytes unchanged, the R2 command carries `IfNoneMatch: "*"`.

### 3. Create the `packages/edit` workspace

- Folder, `package.json` (dependencies `zod` 4.6.7 and `harfbuzzjs` 1.6.4; devDependencies as in
  storage plus `@vitest/browser-playwright` matching the installed vitest (5.0.5) and `playwright`
  pinned to `1.64.0`, the version `@playwright/test` uses, so the installed chromium is shared), run
  `yarn install` from the root, then add with the profile's command form:
  `yarn workspace @edit-issebya/edit add zod@4.6.7 harfbuzzjs@1.6.4` and
  `yarn workspace @edit-issebya/edit add -D @vitest/browser-playwright@5.0.5 playwright@1.64.0`
  (plus the same eslint/typescript/vitest/@types/node devDependencies storage lists).
- `tsconfig.json`: as storage's but `lib: ["ES2024"]`, `types: []`, `include: ["src/**/*.ts"]`,
  `exclude: ["node_modules", "src/**/*.test.ts", "src/test-support/**"]`. `tsconfig.test.json`:
  extends it with `types: ["node", "@vitest/browser/providers/playwright"]` (or the type entry the
  installed provider documents), `lib` adding `DOM`, including tests, `test-support`, `scripts`,
  `vitest.config.ts`. `typecheck`: `tsc --noEmit && tsc --noEmit -p tsconfig.test.json`. If
  `harfbuzzjs`'s types need `WebAssembly` declarations missing from `ES2024`, declare the minimum in
  a local `src/wasm.d.ts`, never by adding `DOM` to the source config.
- `eslint.config.mjs`: storage's config, plus for `src/**/*.ts` excluding tests and `test-support`:
  `no-restricted-imports` (patterns `node:*`, `fs`, `path`, `os`, `child_process`, `crypto`,
  `@edit-issebya/storage`, `@supabase/*`), `no-restricted-globals` (`process`, `Buffer`, `window`,
  `document`, `fetch`, `navigator`, `crypto`, `performance`, `Date`, `setTimeout`, `setInterval`),
  `no-restricted-properties` (`Math.random`). A comment says why (one builder for both places, no
  clock, no randomness).
- `vitest.config.ts`: `test.projects` `node` (`src/**/*.test.ts` minus `*.browser.test.ts`) and
  `browser` (`src/**/*.browser.test.ts`, `browser: { enabled: true, headless: true, provider:
playwright(), instances: [{ browser: "chromium" }] }`); `server.fs.allow` the repository root so
  the browser run can import `fixtures/pipeline/` JSON and the package's assets. Read
  `node_modules/vitest/` browser-mode docs for the 5.x option names before writing it.
- `README.md` like storage's.

### 4. The versions migration

- `supabase migration new versions` (never hand-pick the version), then write:
  - `public.versions`: `id uuid primary key`, `reel_id uuid not null references reels on delete
cascade`, `owner_id uuid not null references auth.users on delete cascade`, `number int not null
check (number >= 1)`, `parent_id uuid`, `restored_from_id uuid`, `request text`, `model text`,
    `prompt_version text`, `change_summary text`, `checks jsonb not null default '[]'`, `inputs jsonb
not null`, `r2_key text not null unique`, `created_at timestamptz not null default now()`;
    `unique (reel_id, number)`, `unique (id, reel_id)`; `(parent_id, reel_id)` and
    `(restored_from_id, reel_id)` reference `versions (id, reel_id)` (same reel only).
  - `reels.current_version_id uuid`, foreign key `(current_version_id, id) references versions (id,
reel_id) on delete set null (current_version_id)`.
  - Trigger `before update on versions` raising an exception: rows never change, even for the
    service role (deletes stay possible only through the reel's cascade).
  - RLS on, policy `versions: owner selects own` (`(select auth.uid()) = owner_id`), `revoke all`
    from `anon` and `authenticated`, `grant select` to `authenticated`. No insert, update or delete
    for `authenticated`; `reels` grants unchanged (the owner cannot set `current_version_id`).
  - `save_version(p_id, p_reel_id, p_parent_id, p_restored_from_id, p_request, p_model,
p_prompt_version, p_change_summary, p_checks, p_inputs, p_r2_key) returns int` (`security
definer`, `set search_path = ''`): locks the reel row, refuses unless `p_parent_id is not
distinct from reels.current_version_id`, inserts with `owner_id` from the reel and `number =
coalesce(max, 0) + 1`, sets `current_version_id`, returns the number. Execute revoked from
    `public, anon, authenticated`, granted to `service_role` only.
  - `versions` joins the `supabase_realtime` publication (slice 9 follows it).
- Apply it to the ADW stack only with `.adw/supabase-stack reset` (the profile's Protected section
  forbids `supabase migration up` by hand; the issue's `supabase migration up --local` maps to this).
  If it fails, report its error and stop.

### 5. Transcript, head track, preset

- `transcript.ts`: `Word { id, text, start, end }` (seconds), `Transcript { words }`, Zod schema
  (ids unique, `end >= start`). The worker's `pipeline/transcript.ts` keeps its writer but imports
  the type from the package so the two cannot drift.
- `head-track.ts`: `HeadSample = { t, head_top, cx, head_w } | null`, one entry per 0.25 s;
  `faceBox(track, t0, t1)` ported from `build.py` (`cx` the median, width the max, top the min over
  samples within 0.1 s of the span, padded 35 / 30 px, height `head_w * 1.35`); `null` when no
  sample has a head (the fixture clip).
- `preset.ts`: `ISSEBYA_PRESET` with `id: "issebya"`, frame 1080x1920, safe box x 130 to 860, y 260
  to 1400; fonts `primary` (Raleway Light, `assets/fonts/Raleway-Light.ttf`, weight 300, 110 px) and
  `secondary` (Golos Text Bold, `assets/fonts/GolosText-Bold.ttf`, weight 700, 50 px); colours white
  `#FFFFFF` and accent `#B3E6FF`; no shadow; caption appear animation (from `index.html`: opacity
  0 to 1, y 12 to 0, 0.18 s, `power2.out`; out 0.15 s); caption grouping (break at a pause of at
  least 0.35 s or after 4 words); the no-head fallback caption line (centred, top 1290); transition
  types `dim` (rgba(0,0,0,0.62) full frame, 0.3 s fades), `panel` (#121212 panel from y 1150, 0.5 s
  `power3.inOut`, cut-out hidden), `card` (rgba(8,8,8,0.9) full frame), each with its text region;
  sound `click` (`assets/sounds/mouse-click-trimmed.wav`, measured duration, -13 dB, minimum gap
  0.25 s, only on transitions); units joined with a preceding number (`%`, `percent`, `hours`,
  `minutes`, `seconds`, `days`, `weeks`, `months`, `years`, `k`, `km`, `kg`) and month names with a
  day number; glossary `[{ term: "lock-in", heard: [["locking"], ["lock", "in"]] }]` (always one
  word).

### 6. Schema

- `schema.ts`: `Anchor = { word: WordId, edge?: "start" | "end", offset?: number }` (offset within
  plus or minus 1 s, for small nudges like `build.py`'s `on(w, -0.03)`) or `{ time: number }` (only
  where nobody speaks) or `{ reel: "start" | "end" }`. Item base: `id` (unique across the edit),
  `start`, `end`, optional `style` (the free custom-style field: a record of CSS property to value,
  keys `^[a-z-]+$`, values refusing `; { } < > \` and `url(`, so nothing escapes the attribute).
  Tracks: `footage` and `cutout` (`{ id, start, end, hidden?: [{start, end}] }`), `captions`
  (`words: WordId[]` as one unit, `text?`, `font?`, `size?`, `color?`, `position?: { x, y, align:
"left" | "right" | "center" }`), `overlays` (`kind: "accent"`, same text properties),
  `transitions` (`type`, `color?`), `sounds` (`sound`, `gain_db?`). Edit root: `format: 1`,
  `preset: "issebya"`, `inputs: { footage, transcript, cutout, head_track }` (each the producer ref
  `{ step, fingerprint, file }`) and `duration` (seconds, from `retime.json`).
- `editSchemaFor(preset, transcript)`: ids become a `z.enum` of the transcript's word ids (so
  slice 10's per-reel JSON Schema lists them), fonts a `z.enum` of the preset's font keys,
  colours `^#[0-9A-Fa-f]{6}$`; a `superRefine` resolves each item's anchors and rejects `end <
start`. `parseEdit(json, preset, transcript)` returns `{ ok: true, edit } | { ok: false, reasons }`
  with readable reasons naming the item.

### 7. Measurer

- `measure.ts`: `createMeasurer(hb, fonts: Record<FontKey, Uint8Array>)` where `hb` is the
  initialised `harfbuzzjs` instance the caller passes (read `node_modules/harfbuzzjs/README.md` and
  `dist/index.d.mts` for the 1.6.4 API and how its wasm is located; packages/edit itself never
  fetches or reads files). `width(font, sizePx, text)`: shape with HarfBuzz at the face's units per
  em, sum `x_advance`, multiply by `size / upem`; cache per `(font, text)`; free HarfBuzz objects.
  `widths()` returns the cache as a sorted record for the golden comparison.
- `src/test-support/measurer.node.ts` (reads the wasm via `import.meta.resolve` and the fonts with
  `node:fs`) and `measurer.browser.ts` (fetches `?url` imports). `apps/worker/src/edit-measurer.ts`
  does what the Node loader does, once per process.

### 8. Timeline, layout, checks

- `timeline.ts`: `resolveTimeline(edit, transcript)` maps every item to `{ start, end }` seconds:
  word anchor `start`/`end` edge plus offset, `time` as is, `reel` 0 or `duration`; rounded to
  milliseconds. Every build calls it, so items follow their words.
- `layout.ts`: positions for items that set none: captions in slots beside the face box for the
  caption's group span (port `_slots`: right-anchored on the left side, left-anchored on the right,
  rows 85 px apart from y 610, wider side first), accents centred in the widest gap above the head
  (`max(top + 25, face_top - 190)`), captions inside a transition's span in that transition's text
  region; no head: the fallback line. Widths come from the measurer, never from estimates. Output
  boxes `{ itemId, x, y, width, height = size }` in frame pixels.
- `checks.ts`: `runChecks(boxes, resolved, headTrack, preset)` returns `Check[]` (`{ rule, item,
reason }`; empty means all pass): `safe-box` (any text box outside x 130 to 860 or y 260 to 1400:
  "caption c12 (\"word\") runs past the safe box: right edge 912 > 860"), `face` (a caption box
  intersecting the face box during its span), `sound-gap` (two hits closer than the preset's
  0.25 s), `time-in-speech` (a `time` anchor inside a word's start to end).

### 9. HTML writer and `build`

- Read the pinned HyperFrames docs (`compositions.md`, `data-attributes.md`, `gsap.md`,
  `rendering.md`) and the reference `index.html` first.
- `html.ts`: `escapeHtml`, `px(n)` (rounded integer), `sec(n)` (`toFixed(3)`), attribute order
  fixed. Page: `<html lang="en" data-resolution="portrait">`, `@font-face` per preset font with
  relative `assets/fonts/...` URLs, root `<div id="root" data-composition-id="main" data-start="0"
data-duration=... data-width="1080" data-height="1920">`, `<video id="footage" class="clip full"
src="source.mp4" data-has-audio="true">`, `<video id="cutout" ... src="subject.webm" muted>`,
  transition layers, one `<span>` per caption / accent (id from the item id), one `<audio
class="clip" src="assets/sounds/mouse-click-trimmed.wav" data-start data-duration
data-volume="0.2239">` per sound (10^(-13/20) to four places), and one inline script building a
  paused GSAP timeline in item order, registered on `window.__timelines["main"]`. The GSAP script
  tag follows what the HyperFrames docs prescribe for 0.8.222.
- `build.ts`: `build(edit, transcript, headTrack, preset, measurer)` returns `{ html, assets,
checks }`; `assets` lists every referenced file with its role (`footage`, `cutout` from
  `edit.inputs`, fonts and sounds from `packages/edit/assets`), sorted. No clock, no randomness, no
  I/O.

### 10. Baseline edit

- `baseline.ts`: `baselineEdit(transcript, { inputs, duration }, preset)`: footage and cutout items
  over the whole reel (`{ reel: "start" }` to `{ reel: "end" }`), one caption per word (or per unit:
  number plus unit, month plus day, glossary term), each starting on its own word and ending on the
  last word of its group (end edge); no positions (the builder fills them), no accents, transitions
  or sounds. Item ids `c<first word id>`.

### 11. Versions

- `versions.ts`: `versionKey(prefix, reelId, versionId)` (`${prefix}reels/<reel>/versions/<id>.json`),
  interfaces `VersionBlobs { get(key); putIfAbsent(key, bytes) }` and `VersionRows { current(reelId);
get(id); save(row): Promise<number> }`, `saveVersion(deps, { reelId, parentId, restoredFromId,
edit, request, model, promptVersion, changeSummary, checks })` (serialises the edit as canonical
  JSON bytes with `TextEncoder`, refuses when the blob key already exists: "version key exists,
  versions are never rewritten", then saves the row), and `restoreVersion(deps, { reelId,
versionId })` (reads the old row and blob, saves a new version copying the edit, `inputs` and
  `checks`, `restored_from_id` = the old id, `parent_id` = the current id, `change_summary`
  `restored version N`). `deps.newId` is supplied by the caller (`crypto.randomUUID` in the worker).

### 12. Fixtures, goldens, Node and browser tests

- Copy the reference reel's `transcript.json` and `head-track.json` into
  `src/testdata/rethink-work/`. Write `src/testdata/versions/baseline-short-speech.edit.json`
  (`baselineEdit` over `fixtures/pipeline/retime/transcript.json` with the manifest's fingerprints)
  and `rethink-work-hand.edit.json` by hand from `build.py`'s decisions: accents `w29` "disrupted"
  and `w112` "purpose" (primary font, `#B3E6FF`), the `JOIN` "Gen Z" unit, the `panel` transition
  from `w126` (offset -0.03) to `w133` end, and one `click` at that transition's start.
- `src/test-support/fixtures.ts`: the fixture list (edit, transcript, head track) imported as JSON
  modules, so the Node and browser runs build exactly the same inputs.
- `scripts/golden.ts` (`yarn workspace @edit-issebya/edit golden`): builds every fixture in Node and
  writes `src/testdata/golden/<name>.html` and `<name>.widths.json`. Commit the goldens.
- Node tests (`*.test.ts`): schema, timeline, layout, checks, build, baseline, versions, golden
  match, speed (see Testing Strategy).
- `build.browser.test.ts`: in Chromium, loads the measurer from the same wasm and fonts, builds
  every fixture and expects HTML and widths equal to the goldens byte for byte.
- Negative proof (temporary, not committed): swap the browser run's measurer for one using canvas
  `measureText` with the same fonts loaded through `FontFace`, run
  `yarn workspace @edit-issebya/edit test`, confirm the browser comparison fails, then remove the
  probe. Record the failing output in the PR description.

### 13. Worker integration

- `run-pipeline.ts`: return `{ fingerprints }` (no behaviour change; update its tests' expectations).
- `version-store.ts`: `supabaseVersionRows(db)` (`current` reads `reels.current_version_id`,
  `get` reads named columns, `save` calls the `save_version` RPC) and `storageVersionBlobs(storage)`
  (`get`, `putIfAbsent`).
- `first-version.ts`: `saveFirstVersion({ ctx, storage, db, keyPrefix, fingerprints })`: if the
  reel already has a current version, `recordHit` (`first_version`, `first version kept, reused`);
  otherwise `runInProcessStep` named `first_version`: `storage.get` the retime `transcript.json` and
  `retime.json` and the `head_track` `head-track.json` by `cacheKey`, parse them, build
  `baselineEdit`, run `build` for its `checks`, `saveVersion` (`request` null, `model` null,
  `prompt_version` null, `change_summary` `automatic first version from the issebya style`), and
  return `{ what: "version 1 saved", sizeBytes: <edit bytes> }`. Failed checks are stored on the
  row, not fatal.
- `process-job.ts`: `work` runs `runPipeline`, then `saveFirstVersion` under the same signal.
- `first-version.test.ts`: in-memory `VersionRows`, `fakeStorage` in a temp folder seeded with the
  `fixtures/pipeline/` JSON, a recording `StepStore`: one version saved with number 1, blob at the
  expected key, checks empty, summary starts `version 1 saved`; a second run records the hit and
  writes nothing.
- `edit-import.test.ts`: spawns `process.execPath --input-type=module -e "const m = await
import('@edit-issebya/edit'); if (typeof m.build !== 'function') process.exit(2)"` with `cwd`
  `apps/worker` and expects exit 0 (Node 24 strips the package's types because its symlink resolves
  outside `node_modules`; no build step).
- `apps/worker/package.json`: add `"@edit-issebya/edit": "workspace:*"`.

### 14. Studio wiring

- `apps/studio/package.json`: `"@edit-issebya/edit": "workspace:*"`; `next.config.ts`:
  `transpilePackages: ["@edit-issebya/storage", "@edit-issebya/edit"]`.
- `apps/studio/src/lib/versions.ts`: `VERSION_COLUMNS` (named, never `*`) and `VersionRow` typed
  with the package's `Check` and `EditInputs`; used by the DB test now and by slice 9's page.

### 15. DB integration test

- `apps/studio/db-tests/versions.test.ts` (users from `createTestUser`, reels from `insertReel`):
  the owner reads their versions; another user reads none; `authenticated` cannot insert, update or
  delete a version, nor update `reels.current_version_id`; `save_version` from the admin numbers 1,
  2, 3 and moves `current_version_id`; a stale `p_parent_id` is refused; an update of a version row
  fails even as the admin (trigger); `current_version_id` naming another reel's version is refused;
  `anon` and `authenticated` cannot execute `save_version`. `rls.test.ts`'s "every public table"
  check covers `versions` automatically.

### 16. E2E: the status page shows version 1

- Extend `apps/studio/e2e/upload.spec.ts`: the step lines gain a seventh entry matching
  `/^first_version: version 1 saved, /`; the `steps` rows gain `first_version` (`status` `done`,
  `cache_hit` false, `wall_ms` a number, the other measurements null); the reel row's
  `current_version_id` is set; its `versions` row has `number` 1, `model`, `request` and
  `parent_id` null, `checks` `[]` and `r2_key` `${CACHE_PREFIX}reels/<reel>/versions/<id>.json`; the
  fake storage holds that key and it parses with `parseEdit`. `afterAll` deletes that key.
  The spec fails without the feature (no seventh line, no `current_version_id`).

### 17. Wiring, CI, profile, docs

- `turbo.json`: `@edit-issebya/edit#test` with inputs `$TURBO_DEFAULT$` and
  `$TURBO_ROOT$/fixtures/pipeline/**`, and `passThroughEnv` `["PLAYWRIGHT_*", "CI"]` (strict env
  mode: the browser project must still find chromium; confirm with a cache-cleared
  `yarn turbo run test --filter=./packages/edit --force`).
- `knip.json`: workspace `packages/edit` (`project: ["src/**/*.ts", "scripts/**/*.ts"]`, `entry:
["scripts/*.ts"]`, `vitest: true`), and fix anything knip reports.
- `.github/workflows/ci.yml`: move `yarn workspace @edit-issebya/web playwright install --with-deps
chromium webkit` before `yarn test` (one install still serves E2E), with a comment why.
- `.adw/project.md`: Identity (mention `packages/edit`, `@edit-issebya/edit`, source only), the
  Workspaces table row `edit | packages/edit | none (library) | none | none | none | never` (the
  issue's "ADW may start: no"), package names and `target_apps` (`edit` for `packages/edit`), Build
  (`--filter=./packages/edit`; no build script, its check is typecheck), Tests (unit
  `packages/edit/src/**/*.test.ts`; the new browser layer `packages/edit/src/**/*.browser.test.ts`,
  Vitest browser mode, Playwright provider, chromium, run inside `yarn test`, needs Install step
  3's chromium; `versions.test.ts` in the DB list; the E2E `upload.spec.ts` now ends with the
  `first_version` step), Install step 3 (the same chromium serves the edit package's browser run),
  Protected (`yarn workspace @edit-issebya/edit add <pkg>`). Keep the nine headings untouched.
- `README.md`: one line `packages/edit/` in the workspace list.
- `app_docs/edit-model.md`: overview, the format (tracks, items, anchors, the free style field),
  preset values, the builder contract, the checks, versions and restore, the first version, the
  cross-environment test and the negative proof, testing, Rules (versions never change; history is
  never rewritten, going back creates a new version; one builder for preview and export, never
  forked per environment; never store a built page; anchors are words, seconds only where nobody
  speaks; nothing Node-only or browser-only in `packages/edit`; never write a version key twice;
  never commit an asset without its licence), Notes (`number` column added beyond the issue's list,
  why; studio imports only types until slice 9).
- `docs/conditional-docs.md`: "Read `app_docs/edit-model.md` when changing `packages/edit` (the
  edit format, preset, builder, HarfBuzz measuring, checks, versions), the `versions` table or
  `save_version`, `reels.current_version_id`, the worker's `first_version` step, or the browser
  test layer."
- `app_docs/pipeline.md`: one bullet under How it works: after the six steps the worker saves the
  first version (see `app_docs/edit-model.md`). `app_docs/studio.md`: the `versions` table in the
  tables list and the rule list's write paths.
- No em-dashes in any new or changed file (a search for the em-dash character over the diff).

### 18. Run the validation commands

- Run every command in `Validation Commands`, in order; fix every failure at its cause.

## Testing Strategy

### Unit Tests

- `packages/edit` (node project):
  - `schema.test.ts`: the baseline and hand fixtures parse; an unknown word id, an item whose end
    resolves before its start, a font outside the preset, a malformed colour and a style value with
    `;` or `<` are each rejected with a reason naming the item; `z.toJSONSchema(editSchemaFor(...))`
    does not throw.
  - `timeline.test.ts`: the same edit against two transcripts with identical ids and different
    times (shifted and stretched): every item's resolved start and end equal its word's time in the
    respective transcript (plus offset); `time` and `reel` anchors unaffected except `reel: end`
    following `duration`.
  - `checks.test.ts`: a 40-character word as an accent at 110 px fails `safe-box`; a caption
    positioned inside the face box (a synthetic head track) fails `face`; two clicks 0.2 s apart
    fail `sound-gap`; a `time` anchor inside a word fails `time-in-speech`; the baseline of the
    fixture clip and the hand-written edit pass all (empty list).
  - `build.test.ts`: building twice gives identical `html`, `assets` and `checks`; every fixture
    equals its committed golden HTML and widths; text is escaped; the speed test builds the
    hand-written 50-second `rethink-work` edit (162 words) with a ready measurer, one warm-up, and
    asserts the build is under 200 ms (HarfBuzz and font loading excluded, as they happen once per
    process).
  - `baseline.test.ts`: one caption per word or unit, "lock-in" joined from "Locking" and from
    "lock" "in", a number with its unit joined, no overlays, transitions or sounds.
  - `versions.test.ts`: `saveVersion` writes the blob and the row; a second write of the same key is
    refused and leaves the bytes unchanged; `restoreVersion(v1)` with current v3 creates v4 with
    `restored_from_id` v1, `parent_id` v3, the same edit bytes as v1, and v1 to v3 (rows and blobs)
    deep-equal to their snapshots from before.
- `packages/edit` (browser project): `build.browser.test.ts` as in step 12.
- `packages/storage`: `putIfAbsent` in the R2 and fake tests.
- `apps/worker`: `first-version.test.ts`, `edit-import.test.ts`, updated `run-pipeline.test.ts`.

### Test Coverage

- `packages/edit/src/build.browser.test.ts` (new browser layer, Vitest browser mode, chromium) plus
  the Node golden test in `build.test.ts` (unit): catches any difference between the browser and
  Node builds, including a measurement that is not HarfBuzz (proven by the temporary canvas probe).
- `packages/edit/src/timeline.test.ts` (unit): catches an item that stops following its word after
  a re-time.
- `packages/edit/src/build.test.ts` determinism and speed cases (unit): catches a clock, randomness
  or unstable ordering in the output, and a builder too slow for the preview.
- `packages/edit/src/checks.test.ts` (unit): catches each layout rule not firing (safe box, face,
  sound gap, time inside speech) and the baseline failing its own checks.
- `packages/edit/src/schema.test.ts` (unit): catches unknown word ids, reversed items and foreign
  fonts reaching the builder.
- `packages/edit/src/versions.test.ts` (unit) and `packages/storage` `putIfAbsent` tests (unit):
  catch a version key written twice and a restore that rewrites history.
- `apps/worker/src/edit-import.test.ts` (unit): catches the worker no longer able to import the
  package's TypeScript source with plain Node.
- `apps/worker/src/first-version.test.ts` (unit): catches the worker not saving version 1, or saving
  a second one on retry.
- `apps/studio/db-tests/versions.test.ts` (DB integration): catches missing RLS, an owner write
  path, a mutable version row, a stale-parent save and a cross-reel current version.
- `apps/studio/e2e/upload.spec.ts` (E2E, extended): catches the end-to-end path (pipeline, then
  version 1 in R2, row and `current_version_id`, then the `first_version` line on the reel page).

### Edge Cases

- A clip with no head anywhere (the fixture clip): captions use the fallback line and pass the face
  check (no face box).
- A word longer than the slot beside the head: placed on the wider side or the fallback line; if it
  still cannot fit, the check reports it (never silently clipped).
- Two captions sharing a unit (`Gen Z`), glossary joins, punctuation stripped like `build.py`'s
  `clean`, and caption `text` overrides (`want?`).
- An offset anchor that resolves before 0 or after `duration`: clamped and reported.
- `restoreVersion` of the current version (allowed: a new version copying it) and of a version of
  another reel (refused by the composite key).
- Concurrent saves: `save_version` locks the reel and checks the parent, so the second fails.
- A job retry after version 1 exists: hit, no second version.
- An empty transcript: baseline with footage and cutout only, still a valid version.
- Text with `<`, `&` or quotes: escaped in the HTML.

## Acceptance Criteria

- `packages/edit` exists as `@edit-issebya/edit`, source only, imported by the worker (proven by a
  plain-Node import test and the E2E `once`) and depended on by the studio (transpiled by Next).
- The package's source type-checks with no DOM and no Node types, and its lint forbids Node and
  browser globals, clocks and randomness.
- Fonts and the click sound are committed with licence files, or the run stopped and reported a
  licence that does not allow it.
- Node and Chromium builds of the stored fixture versions produce byte-identical HTML and widths
  (both equal the committed goldens); the canvas probe made the browser run fail and was removed.
- Building twice is byte-identical; items follow their words across two transcripts; the 50-second
  edit builds in under 200 ms in Node.
- The checks fail as specified (40-character word, caption over the face, clicks 0.2 s apart) and
  the fixture baseline passes all.
- The schema rejects an unknown word id, a reversed item and a font outside the preset.
- Versions are written put-if-absent to `${R2_KEY_PREFIX}reels/<reel_id>/versions/<version_id>.json`;
  a second write of a key is refused; `restoreVersion(v1)` from v3 creates v4 with
  `restored_from_id` v1 and `parent_id` v3 and leaves v1 to v3 unchanged; version rows cannot be
  updated; another user sees no versions; only the service role saves.
- After `once`, the reel has `current_version_id` set and the reel page shows
  `first_version: version 1 saved, ...`.
- `.adw/project.md`, `turbo.json`, `knip.json`, CI, `README.md`, `app_docs/edit-model.md` and
  `docs/conditional-docs.md` are updated; no em-dashes anywhere.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: applies the new migration to this run's ADW stack (the only allowed
  way; if it fails, report and stop).
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: lint every touched workspace, including the platform-neutral restrictions.
- `yarn turbo run typecheck --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: the package's two configs (source with no DOM or Node types, and tests) and every consumer.
- `yarn knip`: no unused files, exports or dependencies across the repository.
- `yarn turbo run test --filter=./packages/edit --filter=./packages/storage --filter=./apps/worker --filter=./apps/studio`: unit tests, including the Chromium browser run of the edit package and the migration version guard.
- `yarn turbo run test --filter=./packages/edit --force`: the same package run without the turbo cache, proving the browser project finds chromium under strict env mode.
- `yarn turbo run test:db --filter=./apps/studio`: RLS, `save_version`, immutability and cross-reel guards on the ADW stack.
- `yarn build`: every workspace still builds (root change: turbo, CI, profile).
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites; `upload.spec.ts` now ends with version 1 saved (run against the `/prepare_app` server started with the Workspaces dev command).

## Notes

- New dependencies, all in `packages/edit` through `yarn workspace @edit-issebya/edit add`: `zod`
  4.6.7 and `harfbuzzjs` 1.6.4 (runtime); `@vitest/browser-playwright` 5.0.5 and `playwright`
  1.64.0 (dev, the browser test layer). `@edit-issebya/edit` is added as a workspace dependency to
  `apps/worker` and `apps/studio`.
- Conflict with the issue text: the issue says to run `supabase migration up --local`, but the
  profile's Protected section forbids that command in a run and names `.adw/supabase-stack reset`
  as the only way to apply migrations to the ADW stack. The plan follows the profile.
- `versions.number` is added beyond the issue's column list: "version 1 saved" and "v1 to v4" need
  a per-reel sequence, and `unique (reel_id, number)` doubles as a concurrency guard.
- "ADW may start: no" in the issue maps to the profile's existing value `never` for libraries.
- The fixture clip has no person, so its head track is all `null`; the face rule is proven with a
  synthetic head track and with the `rethink-work` data, whose head track is real.
- Node 24 type stripping: the worker already imports `@edit-issebya/storage` this way; the new
  import test makes it an explicit, regression-tested fact for `@edit-issebya/edit`. No build step.
- No new UI beyond one more step line; the reel page's surface is covered by the extended E2E
  spec, so no extra review screenshots are needed.
- Manual acceptance (owner, outside the pipeline): build `rethink-work-hand.edit.json` against that
  reel's transcript and head track, render once with HyperFrames, compare with
  `rethink-work/renders/rethink-work-02.mp4`; differences become a follow-up issue.
- Out of scope: the player and preview page (slice 9), the decide step and per-reel JSON Schema
  (slice 10), change requests (11), export (12), more styles, a timeline editor.
