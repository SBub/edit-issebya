# Live preview: HyperFrames player, media-ready clock and the sound track

The reel page of a processed reel plays its current version in the browser through the HyperFrames
player, with the studio's own controls, a clock that waits for both videos and the edit's clicks
played through Web Audio.

**Specifications:**

- specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md

## Overview

Once a reel has a current version, its page in the studio shows a live preview. The page the player
plays is built by `build()` from `packages/edit` in the browser, on open and on each new
`current_version_id` the reel page receives through Realtime. It is never stored.

## How it works

- `apps/studio/package.json`: `@hyperframes/player` pinned at `0.8.222`, equal to the worker's
  `hyperframes`.
- `apps/studio/src/app/preview-actions.ts`: the server action `previewSources(reelId)` reads
  `current_version_id` and `preview_copies_fingerprint` through the signed-in user's client (RLS
  decides) and signs five download links for one hour (`DOWNLOAD_URL_SECONDS`): the edit, the
  transcript, the head track and the two preview copies (`previewKeys` in
  `src/lib/preview-sources.ts`). Its states are `ready`, `no-version`, `no-previews`,
  `not-configured`, `signed-out` and `failed`. A page open longer than an hour shows a load error;
  a reload signs new links.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts`: serves the fonts and click sounds from
  `packages/edit/assets/` same-origin, only files the preset names, otherwise 404 (traced into the
  route's output by `next.config.ts`).
- `apps/studio/src/components/Preview.tsx`: fetches the sources, builds the page, decodes each sound
  once with an `OfflineAudioContext`, sends `studio_preview_opened` once per open, and shows
  "Loading preview" and the Chrome note.
- `apps/studio/src/lib/preview-page.ts`: the copy the player gets maps each asset path to its URL
  and removes the `<audio>` line of every sound asset; nothing else changes.
- `apps/studio/src/components/PreviewPlayer.tsx` and `src/lib/media-ready.ts`: the studio's own
  controls and the readiness rule (not seeking, `HAVE_FUTURE_DATA`, at the held time), applied on
  Play, after every seek and after a stall (data too low and the buffer short of the lookahead).
  While the clock is held the player shows "Loading". No timer.
- `apps/studio/src/lib/sound-schedule.ts`: the clicks come from `soundHits` and start through one
  `AudioContext` at their offset from the clock start; a hit already begun is skipped, and all are
  stopped on pause, seek and the end.
- `apps/studio/src/lib/player-media.ts`: the one read-only reader of the player's internals (the
  iframe's `#footage` and `#cutout`, and the parent-frame proxies when audio is promoted).
- `apps/studio/src/lib/browser.ts`: the Chromium check; elsewhere a note ("The preview is built for
  Chrome; it may not play correctly in this browser."), never a block.

## How to Use

1. Open a processed reel's page in the studio (its step log ends with
   `first_version: version 1 saved`).
2. Press Play; the clock starts once both videos can play.
3. Seek; the clock holds ("Loading") until both videos can play from the new point.

## Configuration

- The studio's R2 variables (see `app_docs/studio.md`), or `E2E_MOCK_STORAGE=true`, whose mock GET
  answers one `Range`.
- Network access to `cdn.jsdelivr.net` for GSAP (`gsap@3.14.2`, named by the preset) and the
  player's runtime (`@hyperframes/core@0.8.222/dist/hyperframe.runtime.iife.js`).
- Nothing new in `turbo.json`.

## Testing

- Unit (`yarn test`): `media-ready`, `preview-page`, `preview-sources`, `sound-schedule` and
  `browser` in `apps/studio/src/lib/`, the asset route's `route.test.ts`,
  `packages/edit/src/sounds.test.ts` and `apps/worker/src/pipeline/record-preview-copies.test.ts`.
- DB (`yarn test:db`): `apps/studio/db-tests/versions.test.ts` covers the RLS of
  `reels.preview_copies_fingerprint`.
- E2E: `apps/studio/e2e/preview.spec.ts`, four tests: the current version with its first caption
  at its time, the clock waiting for both videos (at start and after a seek into unbuffered
  footage), a new current version rebuilt without a reload byte for byte the Node build with one
  event, and the clicks scheduled at their word's time.
- Seeding: `apps/studio/test-support/pipeline.ts` seeds a processed reel (version, transcript, head
  track and the two preview copies from `fixtures/pipeline/`) into the worktree's `.e2e-storage/`
  with no worker run. `yarn workspace @edit-issebya/studio e2e:sign-in-url` (see
  `apps/studio/scripts/e2e-sign-in-url.ts`) creates the `sample-processed-take.mp4` reel the same
  way when the storage lacks it, so the preview can be opened by hand or in review.
- Test hooks: `window.__preview` (`versionId` and `html`); `window.__scheduledSounds`, recorded only
  under `navigator.webdriver` when a spec put an array there; `data-testid="preview-time"`.

## Rules

- Never patch, fork or monkey-patch the player; its internals are read only, and only in
  `player-media.ts`.
- Never keep a preview-only copy of build logic: there is one builder, and the preview only maps
  URLs and drops sound lines.
- Never let the clock advance while either video cannot play from the current point.
- Never hard-code a sound: clicks come only from the edit's `sounds` track.
- Never store the built page.
- Never poll: read on open and on a new current version only.
- Never bump `@hyperframes/player` apart from the worker's `hyperframes`.

## Notes

- Chrome only by design; other browsers get a note, not a block.
- A bump of the player means re-reading `player-media.ts`.
- Also touches `app_docs/studio.md` (the new `reels` column, the reel page), `app_docs/pipeline.md`
  (recording the fingerprint), `app_docs/edit-model.md` (`soundHits`) and `app_docs/measurement.md`
  (`studio_preview_opened`).
