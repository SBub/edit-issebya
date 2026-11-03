# Studio live preview

**Specifications:**

- specs/issue-32-adw-086c739a-sdlc_planner-studio-live-preview-player.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-114-adw-9049f8fd-sdlc_planner-platform-safe-zone-guard.md

## Overview

When the owner opens a reel that has a current version, the reel page plays a live preview of it: the
HyperFrames player (`@hyperframes/player`) shows the page that the one shared builder
(`packages/edit`, `build`) makes in the browser from the current version, using the small preview
copy of the footage instead of the full-size file. A studio-owned
wrapper fixes the bare player's clock (it starts before the videos can play) and plays the transition
clicks through Web Audio. It is built and tested for Chrome.

## How it works

- `supabase/migrations/20261101165643_reel_preview_copies.sql`: nullable `reels.preview_copies jsonb`
  (`{ footage }`, `{ step: "preview_copies", fingerprint, file }`; old rows with `cutout` still parse), a check that it is null
  or an object. Owners get no `insert` or `update` grant on it; they only read it.
- `apps/worker/src/preview-copies-record.ts`: `previewCopiesRefs(fingerprints)` and
  `recordPreviewCopies`. `apps/worker/src/process-job.ts` calls them right after the pipeline and before
  `first_version`, so a reel with a current version already says where its preview copies are. A retry
  writes the same value.
- `apps/studio/src/app/preview-actions.ts`: server action `loadPreviewSources(reelId)`. Reads the reel's
  `current_version_id` and `preview_copies` and the version's `r2_key` and `inputs` under RLS, and signs
  one download URL (one hour) for the edit, transcript, head track and footage preview.
  For a version with `behind` items it also reads each photo the version names from its own
  `photos` row under RLS (`id`, `large_key`, `status`; the key is the row's, never built from the
  id), HEADs each mask before signing anything, and signs both by the path the page names them at
  (`urls.masks` and `urls.photos`, `{ path, url }` each).
  Returns `ready`, `no-version`, `no-previews`, `photo-missing` (a photo the version shows is not a
  ready photo of the owner's, for example deleted from the library), `cutout-cleared` (a mask the
  version needs was cleared by the slimming), `unconfigured`, `signed-out` or `failed`.
- `apps/studio/src/lib/preview-sources.ts`: pure. The cache prefix is derived from the version's own
  `r2_key` (`<prefix>reels/<reel_id>/versions/<version_id>.json`), so the studio never needs the
  worker's `R2_KEY_PREFIX`. Builds and validates the five storage keys (64-hex fingerprints, expected
  steps) and narrows the jsonb column. `previewKeys` also returns `masks` (each `inputs.masks`
  entry as `{ path: maskPath(mask), key }`, step `cutout`) and `photoIds` (`inputs.photos`, each a
  uuid); a version without them has none, and a malformed list fails the whole read.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts` and `src/lib/edit-assets.ts`: serve the
  preset's fonts and click sound from `packages/edit/assets/` (allow-list taken from `ISSEBYA_PRESET`,
  404 for anything else, immutable cache). `outputFileTracingIncludes` in `apps/studio/next.config.ts`
  traces the files into the server output.
- `apps/studio/src/components/ReelPreview.tsx`: loads the sources, fetches the edit, transcript, head
  track and fonts, loads `harfbuzzjs` by client-only dynamic import, calls `createMeasurer` and `build`
  from `@edit-issebya/edit`, runs `previewPage`, fetches the sound files `soundHits` names, and hands
  everything to the player. `photo-missing` shows `A photo in this version was deleted from the
library` and `cutout-cleared` shows `This version's cut-out was cleared to save space; Export
rebuilds it` in place of the player. Sends `studio_preview_opened` (`reel_id`) once per mount, shows the
  waiting, error and "The preview is built for Chrome" lines, and reloads when `current_version_id`
  changes in `LiveReel`'s Realtime state (no page reload, no polling).
- `apps/studio/src/lib/preview-page.ts`: `previewPage(html, assets, urls, soundIds)` swaps the
  footage path for its signed URL (the cut-out's footage copies included), each `mask` asset's
  path for its signed URL (both adding `preload="auto"`) and each `photo` asset's `<img>` path for
  its signed URL, points fonts at the edit-assets route and drops the sound items' `<audio>` clips.
  Throws if the page is not shaped the way the builder writes it, or a mask or photo has no URL.
  Nothing else changes.
- `apps/studio/src/components/PreviewPlayer.tsx`: renders `<hyperframes-player>` (no `controls`,
  `disable-click-to-play`, `assets-loading-ui="none"`, `no-load-timeout`) with its own Play/Pause
  icon button (named by `aria-label`, no hover background), a clock centred in the control row (current
  time over total duration), Zones at the right, then an
  `Expand preview` / `Collapse preview` icon button at the row's right end (`preview-expand`;
  its outer glyphs on the tracks panel's edges; expanded, the tracks timeline and Zones are hidden and the preview fills the
  edit area, without remounting the player; `app_docs/studio-reel-layout.md`) and a `Loading` status; its seek is exposed through a `ref`
  (`PreviewPlayerHandle.seek`) to the tracks timeline's ruler, the one scrubber
  (`app_docs/studio-reel-layout.md`). Play, seek and stall all go through
  one hold-then-start routine: pause, seek, then wait (event-driven, a newer action supersedes) until
  the player's assets are ready and every active video can play from that point, then resume the
  `AudioContext`, start the player's clock and schedule the sounds. A `waiting` or `stalled` event while
  playing re-enters the routine. Pause, seek and `ended` cancel scheduled sounds.
  The player sends `timeupdate` at most every 100 ms, so while paused the wrapper also reports the
  player's time after each message from its frame when it changed: the clock and the playhead rest
  on the player's paused time, never a few frames before it. The root carries
  `data-preview="loading|ready"` and `data-preview-version`.
- `apps/studio/src/components/PlatformZones.tsx`, `src/lib/platform-zones.ts`: the player's `Zones`
  button (`aria-pressed`, off on every open, never saved, switched off when the preview expands and
  left off on collapse) shows a non-interactive layer
  (`data-testid="platform-zones"`, `aria-hidden`, `pointer-events-none`) over the preview that
  shades what TikTok and Instagram cover: the four margins outside `PLATFORM_SAFE` (`top`,
  `bottom`, `left`, `right`) and the button column's notch (`buttons`, from `PLATFORM_BUTTONS`).
  `platformZones(frame, safe, buttons)` gives them as percentages of the frame, so they scale with
  the player. It is never part of
  the built page or the export.
- `apps/studio/src/lib/preview-clock.ts`: `canPlayFrom(media, t)`: every video active at `t` is not
  seeking, has `readyState >= HAVE_FUTURE_DATA` and sits at the target position.
  `mediaTimeAt(item, t)` is `t - start + mediaStart`: the wrapper reads each video's
  `data-media-start` (a cut-out's footage copy starts inside its file; 0 when unset), so a seek
  places the copy at the same footage frame as the main clip.
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
2. Wait for the preview to load; press Play (the triangle icon). A short `Loading` shows while the videos buffer.
3. Click or drag the ruler above the tracks to seek; press Pause (the two bars) to stop.
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
  They cover the masks' keys and paths, malformed mask and photo lists, mask and photo URLs swapped
  in, and `data-media-start` in the seek target.
- DB: `apps/studio/db-tests/rls.test.ts` checks owners cannot insert or update `preview_copies`.
- E2E: `apps/studio/e2e/preview.spec.ts` (chromium, CDN scripts routed to local packages). Test 1: the
  player, the first caption, one `studio_preview_opened`, and the browser build equal to the worker's
  Node golden byte for byte. Test 1 also asserts one `<video>` in the frame and no
  `subject-preview.webm` request. Test 2: the clock stays at 0 while the footage is held, and stays
  at a seek target while the footage past the served bytes is held. Test 3: a new version rebuilds the preview
  without a reload and the clicks are scheduled within 10 ms of their anchors, with no sound `<audio>`
  left in the frame.
- Unit: `platform-zones.test.ts` (the top zone's height 220/1920, the bottom zone's top at
  1470/1920, the left zone's width 35/1080, the right zone's left at 1045/1080, the `buttons` notch
  from 945/1080 across and 1164/1920 down to the right and bottom zones, no overlap). E2E: `preview.spec.ts` toggles Zones: the layer is absent, then shown with
  its zones at the guard's edges (the bottom at 1470, the right at 1045, the notch at 945 and
  1164), Play still works through it, and it hides again.
- E2E: `apps/studio/e2e/behind.spec.ts`: a change puts a library photo behind the speaker; the
  preview shows the photo over the `left` spot inside its span (from the signed `large` copy, two
  mask videos from `cache/cutout/`) and not after it, and the timeline's Behind row shows
  `photo left`.

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
- A cleared mask is a notice, never a preview without the cut-out (it would differ from the
  export).
- The Zones layer takes no clicks and is never saved or built into the page. Expanding the preview
  switches it off; collapsing never switches it back on.
- A photo's key always comes from its own `photos` row read under RLS, never built from the id.

## Notes

- Out of scope: the change-request box, export, Safari and iPhone, a timeline editor.
- Audible sync and smoothness on real 50-second footage are the owner's manual acceptance.
- Other docs this change touches and that should be read with it: `app_docs/edit-model.md` (the studio
  now builds in the browser, not only types), `app_docs/pipeline.md` (the worker records the preview
  copies on the reel), `app_docs/studio.md` (the new column, the mock route's `Range`, the edit-assets
  route).
