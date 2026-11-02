# Feature: Live preview in the studio: HyperFrames player with a media-ready clock and the sound track

## Metadata

issue_number: `32`
adw_id: `086c739a`
issue_json: `{"number":32,"title":"feat: live preview in the studio: HyperFrames player with a media-ready clock and the sound track"}`

## Feature Description

Reel studio MVP, slice 9 of 17. When the owner opens a reel that has a current version, the reel
page shows a live preview: the HyperFrames player (`@hyperframes/player`, pinned to the same exact
version as the worker's `hyperframes`, 0.8.222) playing the page that the one shared builder
(`packages/edit`, `build`) makes in the browser from the current version, with the two small
preview copies of the footage and of the background removal (about 18 MB together) in place of the
full-size files. It is built for Chrome.

Two problems of the bare player are solved by a studio-owned wrapper, without touching the
player's code:

- **Clock sync.** The player starts its clock the moment play is pressed, while each video still
  needs about a tenth of a second to start, so the voice runs behind the captions. The wrapper owns
  play, pause and seek and starts the player's clock only once both videos report they can play
  from the current point (`readyState >= HAVE_FUTURE_DATA`, not seeking), on first play, after
  every seek and after a stall. A short visible "Loading" state covers the pause.
- **Sounds.** The transition clicks live on the edit's `sounds` track. The studio fetches and
  decodes every sound that track uses when the preview opens, and schedules each hit through one
  `AudioContext` relative to the player's clock when playback starts or resumes; scheduled sources
  are cancelled on pause, seek and stall. The builder's `<audio>` clips for those sounds are dropped
  from the page handed to the player, so nothing plays twice.

The preview rebuilds without a page reload when the reel's current version changes (Realtime on the
`reels` row, already followed by `LiveReel`), sends `studio_preview_opened` with `reel_id` once per
preview open, and shows a short non-blocking note in a browser that is not Chromium-based.

## User Story

As the owner of the studio
I want to watch the finished edit of a reel's current version as a live preview in Chrome the moment the reel opens, as often as I like
So that I can judge captions, transitions and clicks in sync with my voice without waiting for a render

## Problem Statement

Versions exist (slice 8, #31) and the pipeline stores small preview copies (slice 7), but the studio
cannot show any of it: the reel page lists jobs and steps only, the studio imports only types from
`packages/edit`, nothing tells the studio where a reel's preview copies are (their `preview_copies`
fingerprint is not in the version's `inputs`), and the bare HyperFrames player would start its clock
before the videos can play and would play the clicks through `<audio>` elements with loose timing.

## Solution Statement

1. **Where the preview copies are.** The worker records them on the reel: a new nullable
   `reels.preview_copies jsonb` column (`{ footage: EditRef, cutout: EditRef }`, each
   `{ step: "preview_copies", fingerprint, file }`), written by the worker right after the pipeline
   and before `first_version`. Owners still cannot write any `reels` column (grants unchanged), so
   the server can trust it. The cache prefix is derived from the version's own `r2_key`
   (`<prefix>reels/<reel_id>/versions/<version_id>.json`): the worker writes the cache and the
   versions under the same prefix, so the studio never needs the worker's `R2_KEY_PREFIX` (and the
   E2E run's per-run prefix just works).
2. **Signed reads (B3).** A server action `loadPreviewSources(reelId)` reads, under RLS, the reel's
   `current_version_id` and `preview_copies` and the current version's `r2_key` and `inputs`, builds
   the five keys (edit, transcript, head track, footage preview, cut-out preview) with a pure,
   unit-tested helper, and signs one download URL for each through `studioStorage()` (R2 with the
   `R2_STUDIO_*` keys, or the fake's `/studio/api/e2e-storage-mock/` route under
   `E2E_MOCK_STORAGE`). The mock route's GET gains HTTP `Range` support (206), as R2 has, so video
   seeking behaves the same.
3. **Static edit assets.** The preset's fonts and click sound come from `packages/edit/assets/`,
   not R2: a route handler `/studio/api/edit-assets/[...path]` serves exactly the files the preset
   names (allow-list from `ISSEBYA_PRESET`), immutable-cached.
4. **Build in the browser (C3).** A client loader fetches the five signed objects and the fonts,
   loads `harfbuzzjs` (same exact version as `packages/edit`) and calls `createMeasurer` and `build`
   from `@edit-issebya/edit`. The built page is never stored. A pure `previewPage(html, assets,
urls, soundIds)` then swaps the asset paths the build lists (`BuildResult.assets`) for their
   preview URLs and drops the sound `<audio>` clips. Nothing else in the page changes; the build
   output itself is byte-identical to the worker's (proved by the E2E parity check).
5. **Wrapper and clock.** A `PreviewPlayer` client component renders `<hyperframes-player>`
   (registered by a client-only dynamic import, `srcdoc` set to the page, no `controls`,
   `disable-click-to-play`, `assets-loading-ui="none"`, `no-load-timeout`) plus its own Play/Pause
   button, a `Position` range slider and a time display. Every play, seek and stall goes through one
   hold-then-start routine backed by a pure, unit-tested readiness predicate.
6. **Sounds.** A pure `soundHits(edit, transcript, preset)` resolves every sound item's start via
   `resolveTimeline`, and `scheduleAt(hits, playhead, ctxNow)` returns `{ id, when, offset }` for
   each hit still ahead (or in progress). The component decodes the buffers once per open and
   starts `AudioBufferSourceNode`s through one `AudioContext` and a `GainNode` per hit.
7. **Events, browser note, rebuild.** `capture("studio_preview_opened", { reel_id })` once per
   preview mount (StrictMode-safe ref guard). `isChromium(navigator)` drives a one-line note. The
   preview reloads its sources whenever `reel.current_version_id` changes in `LiveReel`'s state.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview (read first).
- `AGENTS.md`: rules (Yarn only, no em-dashes, migrations via `supabase migration new`, a
  user-visible change adds a spec, docs one per feature).
- `.adw/project.md`: the ADW profile. Its Tests section lists the studio E2E specs; add the new
  `preview.spec.ts` there in the same change.
- `docs/conditional-docs.md`: add one line for `app_docs/preview.md`.
- `app_docs/studio.md`: matched (anything under `apps/studio`, the `reels` table and migrations,
  `apps/worker`, `packages/storage`, the storage double). Its Rules are invariants: never poll, never
  `select *` from `reels`, no owner `update` on `reels`, never touch real R2 in tests, no client at
  module load.
- `app_docs/edit-model.md`: matched (consuming `packages/edit` from the studio). Rules: one builder,
  never store a built page, nothing platform-specific in `packages/edit`. Its notes say the studio
  imports only types "until slice 9"; update them.
- `app_docs/pipeline.md`: matched (preview copies, their files and settings). Document that the
  worker now records them on the reel.
- `app_docs/measurement.md`: matched (`studio_*` events, `capture`).
- `packages/edit/src/index.ts`, `build.ts`, `measure.ts`, `timeline.ts`, `schema.ts`, `preset.ts`:
  `build`, `BuildResult.assets` (path plus role), `createMeasurer`, `resolveTimeline`, `parseEdit`,
  `transcriptSchema`, `headTrackSchema`, `ISSEBYA_PRESET` (font and sound files, sound gain and
  duration). The builder emits `<video src="<inputs.footage.file>">`, `<video src="<inputs.cutout.file>">`,
  `@font-face ... url("assets/fonts/...")` and one `<audio id="<sound id>" ... data-track-index="60">`
  per sound item.
- `packages/edit/src/test-support/measurer.browser.ts`: how the browser loads harfbuzzjs and the
  fonts; the studio loader mirrors it.
- `packages/edit/src/testdata/golden/baseline-short-speech.html`: the Node build of the baseline
  version over `fixtures/pipeline/`, the parity fixture for the E2E spec.
- `packages/storage/src/storage.ts`, `fake.ts`: `Storage.signDownload`, `isStorageKey`; the fake
  signs to `uploadUrlBase + key`.
- `apps/studio/package.json`: add the new dependencies.
- `apps/studio/next.config.ts`: `transpilePackages`, `basePath: "/studio"`, tracing root; add
  `outputFileTracingIncludes` for the edit assets route if the chosen file access needs it.
- `apps/studio/src/app/reels/[id]/page.tsx`: the reel page; renders `LiveReel`.
- `apps/studio/src/components/LiveReel.tsx`: Realtime on `reels`, `jobs`, `steps`; picks
  `REEL_DETAIL_COLUMNS` from payloads. The preview hangs off its `reel` state.
- `apps/studio/src/lib/reels.ts`: `REEL_DETAIL_COLUMNS`, `ReelDetail`; add `current_version_id`
  and `preview_copies`.
- `apps/studio/src/lib/versions.ts`: `VersionRow`, `VERSION_COLUMNS`.
- `apps/studio/src/lib/storage.ts`: `studioStorage()`, `MOCK_UPLOAD_URL_BASE`.
- `apps/studio/src/app/upload-actions.ts`: the server-action pattern to follow.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` and `route.test.ts`: add `Range`.
- `apps/studio/src/lib/track.ts`: `capture`, the `navigator.webdriver` test-hook pattern (memory
  only) that the build and sound hooks copy.
- `apps/studio/src/lib/supabase-server.ts`: the RLS client for the server action.
- `apps/studio/e2e/upload.spec.ts`, `e2e/events.ts`: seeding `fixtures/pipeline/` under its
  fingerprints, spawning the worker's `once`, `recordEvents`/`eventsNamed`, the `__noReload` marker.
- `apps/studio/test-support/worker.ts`, `fixtures.ts`, `local-supabase.ts`: `runWorkerOnce`,
  `claimableJobIds`, `createTestUser`, `insertReel`, `signInLink`, `localSupabaseAdmin`.
- `apps/studio/playwright.config.ts`: chromium, `workers: 1`, base URL through the landing page.
- `apps/studio/db-tests/rls.test.ts`: owner grants on `reels`; extend with the new column.
- `apps/worker/src/process-job.ts`: `runPipeline` returns `fingerprints`, then `saveFirstVersion`.
- `apps/worker/src/pipeline/preview-copies.ts`: the preview file names (`footage-preview.mp4`,
  `subject-preview.webm`); export them for the recorder.
- `apps/worker/src/step-store.ts`: where the worker writes `reels` (status); add the recorder.
- `fixtures/pipeline/manifest.json`: fingerprints of every fixture step, including
  `preview_copies`.
- `knip.json`, `turbo.json`, `lefthook.yml`: dead-code and task config (no new env variables are
  needed).
- The player's own docs, read from the installed package after adding it:
  `node_modules/@hyperframes/player/README.md` and `dist/hyperframes-player.d.ts` (attributes
  `srcdoc`, `disable-click-to-play`, `assets-loading-ui`, `no-load-timeout`; API `play()`,
  `pause()`, `seek()`, `currentTime`, `paused`, `ready`, `assetsReady`, `iframeElement`; events
  `ready`, `assetsready`, `timeupdate`, `play`, `pause`, `ended`, `audioownershipchange`). It injects
  the HyperFrames runtime from `cdn.jsdelivr.net/npm/@hyperframes/core@0.8.222/...`, and the built
  page loads GSAP 3.14.2 from jsdelivr.
- `node_modules/next/dist/docs/`: read the server actions, route handlers and
  `outputFileTracingIncludes` (`05-config/01-next-config-js/output.md`) guides before the Next work.

### New Files

- `supabase/migrations/<stamp>_reel_preview_copies.sql`: created with
  `supabase migration new reel_preview_copies`.
- `apps/worker/src/preview-copies-record.ts` (+ `.test.ts`): `previewCopiesRefs(fingerprints)` and
  the reel update.
- `apps/studio/src/lib/preview-sources.ts` (+ `.test.ts`): cache prefix from a version key, the five
  storage keys, validation.
- `apps/studio/src/lib/preview-page.ts` (+ `.test.ts`): asset URL swap and sound clip removal.
- `apps/studio/src/lib/preview-clock.ts` (+ `.test.ts`): which media matter at a time, and whether
  they can play from there.
- `apps/studio/src/lib/sound-schedule.ts` (+ `.test.ts`): sound hits and their start times.
- `apps/studio/src/lib/browser.ts` (+ `.test.ts`): `isChromium`.
- `apps/studio/src/lib/edit-assets.ts` (+ `.test.ts`): the allow-list of preset files and their
  content types, and the route URL for a preset path.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts` (+ `route.test.ts`): serves those files.
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId)` server action.
- `apps/studio/src/components/ReelPreview.tsx`: loads sources, builds, owns the open event and the
  browser note, rebuilds on version change.
- `apps/studio/src/components/PreviewPlayer.tsx`: the wrapper around `<hyperframes-player>`
  (clock hold, controls, Web Audio scheduling, test hooks).
- `apps/studio/src/hyperframes-player.d.ts`: JSX intrinsic element typing for
  `hyperframes-player` (React 19 `declare module "react"` form).
- `apps/studio/test-support/pipeline-cache.ts`: `seedPipelineCache(storage, prefix)` extracted from
  `upload.spec.ts`, plus `seedProcessedReel(...)` (source put, reel and job inserted, worker `once`).
- `apps/studio/test-support/versions.ts`: `saveTestVersion(admin, storage, ...)` over
  `saveVersion` from `@edit-issebya/edit` with rows calling the `save_version` RPC as the service
  role (test-support may read the secret key).
- `apps/studio/e2e/preview.spec.ts`: the browser coverage.
- `app_docs/preview.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Dependencies, the `reels.preview_copies` column and the worker writing it, the mock route's `Range`
support, the edit-assets route, the signed-sources server action, and the pure helpers (keys, page
transform, readiness, sound schedule, browser check), each with unit tests.

### Phase 2: Core Implementation

`ReelPreview` (fetch, build, transform, event, note, rebuild on version change) and `PreviewPlayer`
(the `<hyperframes-player>` element, play/pause/seek controls, the hold-until-ready routine, the
Web Audio sound scheduler, the `navigator.webdriver` test hooks).

### Phase 3: Integration

Mount the preview in the reel page through `LiveReel`, extract the E2E seeding helpers, write
`preview.spec.ts` (including the negative proof run), update the docs and the ADW profile, run every
gate.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the docs and the player

- Read `app_docs/studio.md`, `app_docs/edit-model.md`, `app_docs/pipeline.md`,
  `app_docs/measurement.md` in full, and the Next guides named above.
- Add the dependencies from the root (exact versions, no caret):
  `yarn workspace @edit-issebya/studio add @hyperframes/player@0.8.222 harfbuzzjs@1.6.4`
  and, for the spec's offline CDN stand-ins,
  `yarn workspace @edit-issebya/studio add -D @hyperframes/core@0.8.222 gsap@3.14.2`.
  Make sure `package.json` holds `"0.8.222"`, `"1.6.4"`, `"3.14.2"` without `^`. The player version
  must equal `apps/worker`'s `hyperframes` pin; note that coupling in `app_docs/preview.md`.
- Read `node_modules/@hyperframes/player/README.md` and `dist/hyperframes-player.d.ts`. Confirm
  `srcdoc`, `disable-click-to-play`, `assets-loading-ui`, `no-load-timeout`, the open shadow root,
  `iframeElement`, and the `audioownershipchange` event (the player moves media to parent-frame
  proxies only when autoplay is blocked). Never fork, patch or copy its code.

### 2. Migration: `reels.preview_copies`

- `supabase migration new reel_preview_copies` (never hand-pick the version). In it:
  `alter table public.reels add column preview_copies jsonb` with a check that it is null or a JSON
  object, and a comment: written only by the worker (service role) after the pipeline; owners keep
  no `update` grant and no `insert` grant on it. No grant or policy changes; `reels` is already in
  the Realtime publication.
- Run `.adw/supabase-stack reset` (the only allowed way) before `test:db` and E2E.
- Extend `apps/studio/db-tests/rls.test.ts`: an owner cannot insert a reel with `preview_copies`
  set, and cannot update it (both refused), while selecting it on their own reel works.

### 3. Worker records the preview copies

- Export the two preview file names from `apps/worker/src/pipeline/preview-copies.ts`.
- New `apps/worker/src/preview-copies-record.ts`: `previewCopiesRefs(fingerprints)` returns
  `{ footage: { step: "preview_copies", fingerprint, file: "footage-preview.mp4" }, cutout: { ..., file: "subject-preview.webm" } }`
  (throws when the fingerprint is missing), and `recordPreviewCopies(db, reelId, refs)` updates
  `reels.preview_copies` (named column, error thrown with a readable message).
- Call it in `apps/worker/src/process-job.ts` right after `runPipeline` returns and before
  `saveFirstVersion`, so a reel that gets a current version already has its preview copies. A
  retried job writes the same value again (idempotent).
- Unit test `preview-copies-record.test.ts`: the refs for a fingerprint map, the missing-fingerprint
  error, and the update call shape with a stub client.

### 4. Mock storage route: `Range`

- In `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` GET: answer
  `Accept-Ranges: bytes`; for a single `bytes=a-b` / `bytes=a-` range answer 206 with
  `Content-Range` and the slice; an unsatisfiable range 416; no range 200 as today. Still 404 unless
  `E2E_MOCK_STORAGE` is exactly `"true"`. Add a guessed `Content-Type` for `.mp4`, `.webm`, `.json`.
- Extend `route.test.ts`: 206 slice and headers, open-ended range, 416, and the unchanged 404 when the
  flag is off.

### 5. Edit assets route

- `apps/studio/src/lib/edit-assets.ts`: `EDIT_ASSET_FILES` built from `ISSEBYA_PRESET.fonts[*].file`
  and `ISSEBYA_PRESET.sounds[*].file` with content types (`font/ttf`, `audio/wav`), and
  `editAssetUrl(path)` = `/studio/api/edit-assets/<path>`.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts`: GET serves only an allow-listed path
  (404 for anything else, including `..`), from `packages/edit/assets/`, with
  `Cache-Control: public, max-age=31536000, immutable`. Choose a file access that works under
  `next dev` and under `next build && next start` (CI runs `start`): if the files are not traced
  into the server output, add `outputFileTracingIncludes` for the route with
  `../../packages/edit/assets/**` in `apps/studio/next.config.ts`. Read the Next docs first.
- Unit tests: `edit-assets.test.ts` (the allow-list equals the preset's files) and `route.test.ts`
  (a font answers 200 with its bytes and type; an unknown path and a traversal path answer 404).

### 6. Preview sources (server)

- `apps/studio/src/lib/preview-sources.ts`, pure:
  - `cachePrefixOf(r2Key, reelId, versionId)`: strips the exact suffix
    `reels/<reel_id>/versions/<version_id>.json`; `null` when the key does not end with it or the
    prefix fails `keyPrefix` rules.
  - `previewKeys({ r2Key, reelId, versionId, inputs, previewCopies })`: `{ edit: r2Key, transcript,
headTrack, footage, cutout }`, each `<prefix>cache/<step>/<fingerprint>/<file>`; every
    fingerprint must be 64 lower-case hex, every step the expected one (`retime` or whatever
    `inputs.transcript.step` says, `head_track`, `preview_copies`), every key `isStorageKey`;
    otherwise `null`.
  - `parsePreviewCopies(value)`: narrows the jsonb column (Zod is available through
    `@edit-issebya/edit`'s schema types; a small hand check is fine).
  - Tests: prefix derivation with an empty and a nested prefix, a foreign key refused, a malformed
    fingerprint refused, the exact keys for the `fixtures/pipeline/` fingerprints.
- `apps/studio/src/app/preview-actions.ts`, `"use server"`: `loadPreviewSources(reelId)`.
  Checks `isReelId`, gets the user from `createSupabaseServerClient()`, selects
  `id, current_version_id, preview_copies` from `reels` (named columns, RLS) and
  `id, r2_key, inputs` from `versions` for the current version (RLS), creates `studioStorage()` per
  call, and signs each key with `signDownload(key, { expiresInSeconds: 3600 })`. Returns a tagged
  result: `{ status: "ready", versionId, urls: { edit, transcript, headTrack, footage, cutout } }`,
  or `"no-version"`, `"no-previews"`, `"unconfigured"`, `"signed-out"`. Never touches the worker keys
  or the secret key.

### 7. Page transform

- `apps/studio/src/lib/preview-page.ts`: `previewPage(html, assets, urls, soundIds)`:
  - For each `BuildAsset`: role `footage` and `cutout` map to the signed preview URLs, `font` to
    `editAssetUrl(path)`. Replace only the exact attribute forms the builder writes
    (`src="<path>"` and `url("<path>")`), HTML-attribute-escaped; throw if an asset path is not
    found exactly where expected.
  - Remove each `<audio id="<sound id>" ...></audio>` line for the sound items (they play through
    Web Audio); throw if one is missing.
  - Add `preload="auto"` to the two `<video>` tags so a paused video buffers ahead.
  - Nothing else changes.
- `preview-page.test.ts`: build `baseline-short-speech` and `rethink-work-hand` from
  `packages/edit`'s committed fixtures (import the edit JSON, transcripts and head tracks the way
  `packages/edit/src/test-support/fixtures.ts` does, or import that module through a relative path
  if knip and tsconfig allow; otherwise use the golden HTML plus a hand-written asset list). Assert:
  no `source.mp4`/`subject.webm` left, the preview URLs present, font URLs rewritten, no
  `data-track-index="60"` left for the hand edit with a click, every other line identical to the
  input.

### 8. Readiness and sound schedule (pure)

- `apps/studio/src/lib/preview-clock.ts`:
  - `HAVE_FUTURE_DATA = 3`.
  - `activeAt(media, t)`: the media whose `[data-start, data-start + data-duration)` contains `t`
    (as numbers read by the caller into `{ start, duration, readyState, seeking }`).
  - `canPlayFrom(media, t)`: every active one has `!seeking && readyState >= HAVE_FUTURE_DATA`, and
    there is at least one when the reel has clips.
  - Tests: all ready, one at `HAVE_CURRENT_DATA`, one seeking, a clip outside its window ignored, the
    boundary at `start + duration`.
- `apps/studio/src/lib/sound-schedule.ts`:
  - `soundHits(edit, transcript, preset)`: for each `tracks.sounds` item `{ id, file, at, gain,
duration }` with `at = resolveTimeline(edit, transcript).get(id).start`, `file` from the preset,
    `gain = 10 ** ((gain_db ?? preset gainDb) / 20)`, `duration` the preset's (clamped to the reel
    end as the builder does). Never a hard-coded sound.
  - `scheduleAt(hits, playhead, ctxNow)`: for hits with `at >= playhead` `{ id, when: ctxNow + (at -
playhead), offset: 0 }`; for a hit in progress (`at < playhead < at + duration`) `{ when: ctxNow,
offset: playhead - at }`; earlier hits skipped.
  - Tests: two clicks at known word anchors over `fixtures/pipeline/retime/transcript.json`
    (`w0002` at 0.267, `w0005` at 0.881), from playhead 0 and from mid-reel, the in-progress offset,
    the gain conversion for -13 dB.
- `apps/studio/src/lib/browser.ts`: `isChromium(nav)` true when `userAgentData.brands` names
  `Chromium` or, without `userAgentData`, the UA has `Chrome/` or `Chromium/`; false for Safari and
  Firefox UAs. Test with fixed UA strings.

### 9. `PreviewPlayer` (the wrapper)

- `apps/studio/src/hyperframes-player.d.ts`: intrinsic element typing for `hyperframes-player`.
- `apps/studio/src/components/PreviewPlayer.tsx` (`"use client"`), props
  `{ html, hits, buffers-loader or decoded buffers, versionId }`:
  - Register the element with `useEffect(() => { void import("@hyperframes/player"); }, [])` (never
    at module load on the server). Render `<hyperframes-player width="1080" height="1920"
disable-click-to-play assets-loading-ui="none" no-load-timeout>` in a 9:16 box; set `srcdoc`
    through the ref when `html` changes. No `controls` attribute: the wrapper's own controls are the
    only way to play, pause and seek.
  - Controls: a button named `Play`/`Pause`, an `<input type="range" aria-label="Position"
min="0" max={duration} step="0.01">`, a time display, and `role="status"` text `Loading` while
    holding. The root carries `data-preview="loading|ready"` and `data-preview-version={versionId}`.
  - Media: `mediaElements()` returns the iframe document's `video[data-start]`
    (`player.iframeElement.contentDocument`); if the player reports `audioownershipchange` with
    owner `parent`, use the parent proxies it exposes in its published types (`_parentMedia[].el`),
    read-only. Map each to `{ start, duration, readyState, seeking }` for `canPlayFrom`.
  - `holdThenStart(t)`: one routine for play, seek and stall. Cancel scheduled sounds, `pause()` the
    player if playing, `seek(t)` when the target differs from the current time, set state `loading`,
    then wait (event-driven: `canplay`, `canplaythrough`, `seeked`, `loadeddata`, `progress`,
    `waiting` listeners on the media, plus the player's `assetsready`; no interval polling) until
    `player.assetsReady && canPlayFrom(media, t)`. A newer play/seek/pause supersedes a pending wait
    (generation counter). Then `ctx.resume()`, read `T0 = ctx.currentTime` and `p0 =
player.currentTime`, call `player.play()`, and schedule sounds with `scheduleAt(hits, p0, T0)`.
  - Stall: a `waiting` or `stalled` event on an active video while playing calls
    `holdThenStart(player.currentTime)`, so the clock never runs while a video cannot play.
  - Pause, seek and `ended`: stop and disconnect every scheduled `AudioBufferSourceNode`.
  - Seek from the slider (`input` event): while playing `holdThenStart(value)`; while paused
    `player.seek(value)` and leave the clock stopped.
  - Sound engine: one `AudioContext` per mounted preview, created on open (decoding works on a
    suspended context) and resumed in the Play click; each hit gets `createBufferSource` ->
    `GainNode(gain)` -> destination, `start(when, offset)`. Close the context on unmount.
  - Test hooks (only when `navigator.webdriver === true`, memory only, like `track.ts`):
    `window.__previewBuild = html as built by packages/edit` (set by `ReelPreview`, before the
    transform) and `window.__previewSounds = { playbacks: [{ ctxTime: T0, playhead: p0 }], starts:
[{ id, when, offset }] }` pushed at every schedule. Declare both on `Window`.

### 10. `ReelPreview` and the reel page

- `apps/studio/src/components/ReelPreview.tsx` (`"use client"`), props
  `{ reelId, currentVersionId, previewCopiesReady }`:
  - When `currentVersionId` is null: a short "The preview appears once the first version is saved."
    line. When set: call `loadPreviewSources(reelId)`; on `"ready"` fetch the edit, transcript and
    head track JSON and the font bytes (`editAssetUrl`) in parallel; parse with
    `transcriptSchema`, `headTrackSchema`, `parseEdit(edit, ISSEBYA_PRESET, transcript)`;
    `const hb = await import("harfbuzzjs")`; `build(edit, transcript, headTrack, ISSEBYA_PRESET,
createMeasurer(hb, fonts))`; `previewPage(...)`; fetch and decode the sound files the
    `soundHits` name. Pass everything to `PreviewPlayer`. Show a readable error line on failure.
  - Rebuild on version change: the loader effect depends on `currentVersionId`; a stale load is
    discarded (abort flag). No reload, no polling: the trigger is `LiveReel`'s Realtime state.
  - `capture("studio_preview_opened", { reel_id })` once per mount, the first time a page is handed
    to the player (a `useRef` guard, so StrictMode and later rebuilds do not send it again).
  - The browser note: when `!isChromium(navigator)` (read after mount), one line "The preview is
    built for Chrome." Playback is not blocked.
- `apps/studio/src/lib/reels.ts`: add `current_version_id` and `preview_copies` to
  `REEL_DETAIL_COLUMNS` and `ReelDetail`; update `reels.test.ts` if it pins the column list.
- `apps/studio/src/components/LiveReel.tsx`: render `<ReelPreview reelId currentVersionId={reel.current_version_id} ... />`
  above the status list (it already merges Realtime `reels` updates through `pickColumns`).
  Confirm `apps/studio/src/app/reels/[id]/page.tsx` still selects through `REEL_DETAIL_COLUMNS`.

### 11. E2E seeding helpers

- Move `seedPipelineCache` from `apps/studio/e2e/upload.spec.ts` into
  `apps/studio/test-support/pipeline-cache.ts` (`seedPipelineCache(storage, prefix)` returning the
  keys) and make `upload.spec.ts` use it, unchanged in behaviour.
- Add `seedProcessedReel({ admin, storage, ownerId, prefix })`: puts
  `fixtures/footage/short-speech.mp4` at a source key under the prefix, inserts the reel (status
  `uploaded`, `source_key`, `source_bytes`, `source_name`) and a queued `process` job through the
  admin client (extend `insertReel` or insert directly), seeds the cache, runs `runWorkerOnce({
R2_KEY_PREFIX: prefix })`, and returns `{ reelId, versionId, versionKey, keys }`; asserts exit 0
  and that `reels.preview_copies` and `current_version_id` are set.
- `apps/studio/test-support/versions.ts`: `saveTestVersion(...)` over `saveVersion` (parent the
  current version) with rows calling the `save_version` RPC and blobs through the fake's
  `putIfAbsent`; returns the version id and key for cleanup.

### 12. Browser coverage: `apps/studio/e2e/preview.spec.ts`

Modelled on `upload.spec.ts` (same leftover-job guard, test user, per-run `CACHE_PREFIX`,
cleanup of every seeded key, version key, source key and the user in `afterAll`). Before each
`page.goto`, route the two CDN scripts to local files so the spec needs no network:
`https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.222/dist/hyperframe.runtime.iife.js` to
`@hyperframes/core`'s file and `https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js` to
`gsap`'s (resolved with `import.meta.resolve`). The composition frame is found through
`page.frames()` (the `about:srcdoc` frame) or a frame locator through the open shadow root.

- **Test 1, player, first caption, event, parity.** `recordEvents(page)`; sign in; open the reel.
  Expect the player visible and `data-preview="ready"`. Expect exactly one
  `studio_preview_opened` with `{ app: "studio", reel_id }` (`expect.poll` on `eventsNamed`).
  Parity: `window.__previewBuild` equals `packages/edit/src/testdata/golden/baseline-short-speech.html`
  read in Node, byte for byte (the worker's Node build of the same version). Seek with the
  `Position` slider to the first caption's anchored time plus 0.25 s (from the fixture transcript,
  `w0001` at 0.038 s); in the composition frame `#cw0001` has text `this` (captions are lower-cased) and computed opacity
  above 0.5.
- **Test 2, the clock waits for media.** Before `goto`:
  - Route `**/cache/preview_copies/*/subject-preview.webm`: hold every request until the test calls
    `releaseCutout()`.
  - Route `**/cache/preview_copies/*/footage-preview.mp4`: answer the first request with the first
    three quarters of the bytes (at least 32 KiB, the block Chromium's media reader waits for) as a 206 (`route.fetch()` the full object, slice, set `Content-Range` with
    the true total); hold every later request until `releaseFootage()`.
  - Press `Play`. For 2 s, sampling every 100 ms through `page.evaluate`, the player element's
    `currentTime` stays at 0 (within 1 ms) and `Loading` is visible. Call `releaseCutout()`; expect
    `currentTime` to pass 0.2 s.
  - While playing, set `Position` to about 80% of the duration (a point past the bytes served).
    For 2 s `currentTime` stays at the target (within 50 ms); call `releaseFootage()`; expect it to
    pass the target plus 0.1 s.
  - The seek part is the discriminating half (the player itself gates its first play on its own
    asset wait); if the negative proof below does not make the spec fail, tighten the spec until it
    does.
- **Test 3, the version changes live and sounds are scheduled exactly.** Open the reel, set
  `window.__noReload = "marker"`. Save version 2 with `saveTestVersion`: the version 1 edit plus two
  `click` sounds anchored on `w0002` and `w0005` (ids `click-a`, `click-b`, at least 0.25 s apart).
  Expect `data-preview-version` to become version 2's id and the marker to survive (no reload).
  Press `Play`; `expect.poll` until `window.__previewSounds.starts` has two entries; with the last
  `playbacks` entry `{ ctxTime, playhead }` and the anchors' resolved starts computed in Node with
  `resolveTimeline(edit, transcript)` from `@edit-issebya/edit`, assert for each hit
  `|when - (ctxTime - playhead) - at| <= 0.010`. Also assert the composition frame has no
  `audio[data-track-index="60"]`.
- **Negative proof (task, not committed).** Temporarily make the wrapper's readiness wait resolve
  at once (for example `canPlayFrom` returns true), run
  `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e -- preview.spec.ts` and confirm test 2
  fails; revert the probe, rerun green, and record the result in `app_docs/preview.md` Notes and the
  PR description.

### 13. Documentation and profile

- New `app_docs/preview.md` (Specifications link to this plan; Overview; How it works: the player
  and its pinned version coupled to the worker's `hyperframes`, what is fetched and from where
  (signed URLs, cache prefix from the version key, `reels.preview_copies`, the edit-assets route,
  jsdelivr for the runtime and GSAP), the page transform, the wrapper's hold-then-start routine and
  stall handling, the sound scheduling, the open event, the Chrome note, rebuild on version change;
  Testing; Rules: never patch, fork or copy the player's code, wrap it; one builder, never a
  preview-only copy of build logic, and the transform only swaps asset URLs, adds `preload` and
  drops the sound clips; the clock never advances while either video cannot play from the current
  point; sounds only from the edit's sound track, never hard-coded; no polling, read once then
  Realtime; never store the built page; Chrome only, never block other browsers; test hooks only
  under `navigator.webdriver`, memory only. Notes: the negative proof result, Safari and iPhone out
  of scope).
- `docs/conditional-docs.md`: one line, "Read `app_docs/preview.md` when changing the studio's live
  preview, the HyperFrames player wrapper or its pin, the preview's clock or sound scheduling, the
  edit-assets route, `reels.preview_copies`, or `preview.spec.ts`."
- `app_docs/edit-model.md`: replace "imports only types until slice 9" with the studio building in
  the browser (link to `preview.md`).
- `app_docs/pipeline.md`: the worker records the preview copies in `reels.preview_copies` after the
  pipeline.
- `app_docs/studio.md`: the new column (owner read-only), the mock route's `Range` support, the
  edit-assets route.
- `.adw/project.md` Tests section: add `preview.spec.ts` to the studio E2E list (headings untouched).
- No em-dashes anywhere.

### 14. Validation

- Run every command in `Validation Commands`, then the E2E suite as the test phase does. Fix any
  failure at its cause; never weaken a rule, type or test.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/preview-sources.test.ts`: prefix from a version key, the five keys for the
  fixture fingerprints, foreign or malformed values refused.
- `apps/studio/src/lib/preview-page.test.ts`: URL swap, sound clip removal, `preload`, everything
  else unchanged, throws on a missing asset.
- `apps/studio/src/lib/preview-clock.test.ts`: readiness predicate over active clips.
- `apps/studio/src/lib/sound-schedule.test.ts`: hit times from word anchors, schedule from any
  playhead, in-progress offset, gain.
- `apps/studio/src/lib/browser.test.ts`: Chromium detection.
- `apps/studio/src/lib/edit-assets.test.ts` and `src/app/api/edit-assets/[...path]/route.test.ts`:
  allow-list and serving.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`: `Range` support.
- `apps/worker/src/preview-copies-record.test.ts`: refs and the reel update.
- DB layer: `apps/studio/db-tests/rls.test.ts`, the owner cannot write `preview_copies`.

### Test Coverage

- `apps/studio/e2e/preview.spec.ts` (E2E, chromium): test 1 catches a missing player, a wrong
  caption timing, a missing or duplicated `studio_preview_opened` and any drift between the
  browser build and the worker's Node build; test 2 catches a clock that runs while a video cannot
  play (proved by the negative probe); test 3 catches sounds scheduled off their anchors, sounds
  played twice through `<audio>`, and a preview that does not rebuild live on a version change.
- Unit tests above (Vitest, `yarn test`): each pure helper fails without this feature (the files do
  not exist today); `route.test.ts` for the mock route fails without `Range`.
- `apps/studio/db-tests/rls.test.ts` (DB layer, `test:db`): fails if a later change grants owners a
  write on `preview_copies`, which would let the server sign keys an owner chose.
- `apps/worker/src/preview-copies-record.test.ts` (unit): fails if the worker stops recording where
  the preview copies are.

### Edge Cases

- Reel without a version yet (processing): the preview shows its waiting line; it appears via
  Realtime when version 1 lands, without a reload.
- Reel with a version but no `preview_copies` (made before this slice): `"no-previews"` line, no
  crash.
- Storage unconfigured: `"unconfigured"` line.
- Seek while loading, double-click on Play, pause during the hold: the newest action wins.
- Seek past the end or to exactly the duration; `ended` stops scheduled sounds.
- A sound hit straddling the playhead after a seek starts with an offset; hits before it are not
  played.
- A video stalls mid-play: clock held, sounds cancelled, then resumed together.
- Player falls back to parent-frame media (autoplay blocked): readiness reads the proxies.
- Non-Chromium browser: note shown, playback still allowed.
- StrictMode double effects in dev: one open event, one `AudioContext`.
- A version change while a previous load is in flight: the stale result is dropped.

## Acceptance Criteria

- `@hyperframes/player` is pinned in `apps/studio` at exactly the worker's `hyperframes` version
  (0.8.222), unmodified; `harfbuzzjs` at exactly `packages/edit`'s 1.6.4.
- Opening a processed reel shows the player playing the current version built in the browser by
  `packages/edit`'s `build`, with the two preview copies; the build equals the worker's Node build
  byte for byte.
- The clock does not advance while either video cannot play from the current point, on first play,
  after every seek and on a stall; a "Loading" state shows meanwhile.
- Clicks come only from the edit's sound track, are decoded on open and scheduled through one
  `AudioContext` within 10 ms of their anchors relative to the playback start; cancelled on pause
  and seek; the page's own sound `<audio>` clips are not played.
- A version change rebuilds the preview without a reload; nothing polls.
- `studio_preview_opened` with `reel_id` is captured once per preview open.
- A non-Chromium browser sees a one-line note and can still play.
- `app_docs/preview.md` and its index line exist; the profile lists the new spec; every gate passes
  and the negative proof is recorded.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: apply the new migration to the ADW stack before the DB and E2E layers.
- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker`: ESLint for both touched workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker`: types, including the JSX element typing and the player's types.
- `yarn knip`: no unused files, exports or dependencies (the new dependencies are used).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker`: unit tests, including the new helpers, the mock route's `Range` and the worker recorder.
- `yarn turbo run test --filter=./packages/edit`: the builder's Node and browser goldens stay unchanged.
- `yarn turbo run test:db --filter=./apps/studio`: RLS including the new column.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/web`: the studio builds with the player, harfbuzzjs's wasm and the edit-assets route.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the full gate the issue names.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites, including `preview.spec.ts` (values from `.ports.env`; the `/prepare_app` server must already be up).

## Notes

- New dependencies (Yarn, the profile's add command, exact pins): `@hyperframes/player@0.8.222`
  and `harfbuzzjs@1.6.4` in `apps/studio`; dev-only `@hyperframes/core@0.8.222` and `gsap@3.14.2`
  in `apps/studio` so the spec serves the jsdelivr scripts locally. If knip cannot see the dev-only
  ones (used through `import.meta.resolve` in the spec), list them in `knip.json`'s studio
  `ignoreDependencies` with a comment rather than dropping them.
- Design decision: the preview copies' location is recorded on the reel (`reels.preview_copies`)
  rather than computed in the studio, because their fingerprint depends on the worker's
  `PREVIEW_SETTINGS` and step version; duplicating those in the studio would split one fact across
  two apps. The column is not part of the edit format, so `packages/edit` and its goldens do not
  change.
- In production the composition iframe still loads the HyperFrames runtime and GSAP from jsdelivr,
  as the player and the builder are designed; only the spec swaps them for local files.
- harfbuzzjs finds its wasm with `new URL("harfbuzz.wasm", import.meta.url)` and uses top-level
  await; load it with a client-only dynamic `import()` and confirm it under `next dev` and
  `next build`.
- Headless Chromium has a working `AudioContext` without a sound device; the Play click is the user
  gesture that resumes it.
- The pipeline will not verify playback smoothness on real 50-second footage or audible sync; that
  is the owner's manual acceptance against
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/renders/rethink-work-02.mp4`
  (read-only).
- Out of scope: the change-request box (slice 11), export (slice 12), Safari and iPhone, a timeline
  editor, the browser notification (slice 15).
