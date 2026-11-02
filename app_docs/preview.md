# Studio live preview

**Specifications:**

- specs/issue-32-adw-086c739a-sdlc_planner-studio-live-preview-player.md

## Overview

When the owner opens a reel that has a current version, the reel page plays a live preview of it: the
HyperFrames player (`@hyperframes/player`) shows the page that the one shared builder
(`packages/edit`, `build`) makes in the browser from the current version, using the two small preview
copies of the footage and of the background removal instead of the full-size files. A studio-owned
wrapper fixes the bare player's clock (it starts before the videos can play) and plays the transition
clicks through Web Audio. It is built and tested for Chrome.

## How it works

- `supabase/migrations/20261101165643_reel_preview_copies.sql`: nullable `reels.preview_copies jsonb`
  (`{ footage, cutout }`, each `{ step: "preview_copies", fingerprint, file }`), a check that it is null
  or an object. Owners get no `insert` or `update` grant on it; they only read it.
- `apps/worker/src/preview-copies-record.ts`: `previewCopiesRefs(fingerprints)` and
  `recordPreviewCopies`. `apps/worker/src/process-job.ts` calls them right after the pipeline and before
  `first_version`, so a reel with a current version already says where its preview copies are. A retry
  writes the same value.
- `apps/studio/src/app/preview-actions.ts`: server action `loadPreviewSources(reelId)`. Reads the reel's
  `current_version_id` and `preview_copies` and the version's `r2_key` and `inputs` under RLS, and signs
  one download URL (one hour) for the edit, transcript, head track, footage preview and cut-out preview.
  Returns `ready`, `no-version`, `no-previews`, `unconfigured`, `signed-out` or `failed`.
- `apps/studio/src/lib/preview-sources.ts`: pure. The cache prefix is derived from the version's own
  `r2_key` (`<prefix>reels/<reel_id>/versions/<version_id>.json`), so the studio never needs the
  worker's `R2_KEY_PREFIX`. Builds and validates the five storage keys (64-hex fingerprints, expected
  steps) and narrows the jsonb column.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts` and `src/lib/edit-assets.ts`: serve the
  preset's fonts and click sound from `packages/edit/assets/` (allow-list taken from `ISSEBYA_PRESET`,
  404 for anything else, immutable cache). `outputFileTracingIncludes` in `apps/studio/next.config.ts`
  traces the files into the server output.
- `apps/studio/src/components/ReelPreview.tsx`: loads the sources, fetches the edit, transcript, head
  track and fonts, loads `harfbuzzjs` by client-only dynamic import, calls `createMeasurer` and `build`
  from `@edit-issebya/edit`, runs `previewPage`, fetches the sound files `soundHits` names, and hands
  everything to the player. Sends `studio_preview_opened` (`reel_id`) once per mount, shows the
  waiting, error and "The preview is built for Chrome." lines, and reloads when `current_version_id`
  changes in `LiveReel`'s Realtime state (no page reload, no polling).
- `apps/studio/src/lib/preview-page.ts`: `previewPage(html, assets, urls, soundIds)` swaps the
  footage and cut-out paths for their signed URLs (adding `preload="auto"`), points fonts at the
  edit-assets route and drops the sound items' `<audio>` clips. Throws if the page is not shaped the way
  the builder writes it. Nothing else changes.
- `apps/studio/src/components/PreviewPlayer.tsx`: renders `<hyperframes-player>` (no `controls`,
  `disable-click-to-play`, `assets-loading-ui="none"`, `no-load-timeout`) with its own Play/Pause
  button, `Position` slider, time display and a `Loading` status. Play, seek and stall all go through
  one hold-then-start routine: pause, seek, then wait (event-driven, a newer action supersedes) until
  the player's assets are ready and every active video can play from that point, then resume the
  `AudioContext`, start the player's clock and schedule the sounds. A `waiting` or `stalled` event while
  playing re-enters the routine. Pause, seek and `ended` cancel scheduled sounds. The root carries
  `data-preview="loading|ready"` and `data-preview-version`.
- `apps/studio/src/lib/preview-clock.ts`: `canPlayFrom(media, t)`: every video active at `t` is not
  seeking, has `readyState >= HAVE_FUTURE_DATA` and sits at the target position.
- `apps/studio/src/lib/sound-schedule.ts`: `soundHits(edit, transcript, preset)` resolves every sound
  item through `resolveTimeline`; `scheduleAt(hits, playhead, ctxNow)` returns start times and offsets
  (a hit in progress starts part way in, earlier hits are skipped).
- `apps/studio/src/lib/preview-test-hooks.ts`: `window.__previewBuild` and `window.__previewSounds`,
  set only when `navigator.webdriver` is true, in memory only.
- `apps/studio/src/lib/browser.ts`: `isChromium`.
- `apps/studio/src/lib/node-module-stub.ts` with `turbopack.resolveAlias` in `next.config.ts`: the
  browser gets a stub for Node's `module`, which `harfbuzzjs` imports behind a Node check.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: GET now honours a single `Range` (206,
  416 when unsatisfiable) and guesses `.mp4`, `.webm` and `.json` types, as R2 does, so videos seek.
- `apps/studio/src/components/LiveReel.tsx`, `src/lib/reels.ts`: `current_version_id` and
  `preview_copies` join `REEL_DETAIL_COLUMNS`; `LiveReel` renders `ReelPreview`.
- `apps/studio/test-support/pipeline-cache.ts`, `test-support/versions.ts`: `seedPipelineCache`,
  `seedProcessedReel` and `saveTestVersion`, shared by the E2E specs.

## How to Use

1. Sign in to the studio and open a reel that has a current version (`/studio/reels/<id>`).
2. Wait for the preview to load; press `Play`. A short `Loading` shows while the videos buffer.
3. Drag `Position` to seek; press `Pause` to stop.
4. When a new version is saved, the preview rebuilds by itself.

## Configuration

No new environment variables. The studio signs reads with its existing `R2_STUDIO_*` keys (or the
`E2E_MOCK_STORAGE` mock route). The composition frame still loads the HyperFrames runtime and GSAP from
jsdelivr.

`@hyperframes/player` is pinned in `apps/studio` at exactly the version of `apps/worker`'s
`hyperframes` (0.8.222), and `harfbuzzjs` at exactly `packages/edit`'s (1.6.4). Change them together.
`@hyperframes/core` and `gsap` are dev-only: the spec serves the jsdelivr scripts from them.

## Testing

- Unit: `preview-sources`, `preview-page`, `preview-clock`, `sound-schedule`, `browser`, `edit-assets`
  tests, the edit-assets and mock-storage route tests, and the worker's `preview-copies-record.test.ts`.
- DB: `apps/studio/db-tests/rls.test.ts` checks owners cannot insert or update `preview_copies`.
- E2E: `apps/studio/e2e/preview.spec.ts` (chromium, CDN scripts routed to local packages). Test 1: the
  player, the first caption, one `studio_preview_opened`, and the browser build equal to the worker's
  Node golden byte for byte. Test 2: the clock stays at 0 while the cut-out is held, and stays at a seek
  target while the footage past the served bytes is held. Test 3: a new version rebuilds the preview
  without a reload and the clicks are scheduled within 10 ms of their anchors, with no sound `<audio>`
  left in the frame.

## Rules

- Never patch, fork or copy the player's code; wrap it.
- One builder: never write a preview-only copy of the build logic. The transform only swaps asset
  URLs, adds `preload` and drops the sound clips.
- The clock never advances while a video cannot play from the current point.
- Sounds come only from the edit's sound track, never hard-coded.
- Never poll: read once, then follow Realtime.
- Never store the built page.
- Chrome only, but never block other browsers (show the note).
- Test hooks only under `navigator.webdriver`, in memory only.
- Owners never get a write grant on `reels.preview_copies`: the server signs the keys it names.

## Notes

- Out of scope: the change-request box, export, Safari and iPhone, a timeline editor.
- Audible sync and smoothness on real 50-second footage are the owner's manual acceptance.
- Other docs this change touches and that should be read with it: `app_docs/edit-model.md` (the studio
  now builds in the browser, not only types), `app_docs/pipeline.md` (the worker records the preview
  copies on the reel), `app_docs/studio.md` (the new column, the mock route's `Range`, the edit-assets
  route).
