# Feature: live preview in the studio: HyperFrames player with a media-ready clock and the sound track

## Metadata

issue_number: `32`
adw_id: `b7898314`
issue_json: `{"number":32,"title":"feat: live preview in the studio: HyperFrames player with a media-ready clock and the sound track"}`

## Feature Description

When a reel's current version opens in the studio, the reel page builds the finished edit in the
browser with the shared builder from `packages/edit` and plays it at once in the HyperFrames player
(`@hyperframes/player`, pinned to the exact version of the worker's `hyperframes`, 0.8.222). The
page loads only what the open reel needs: the current version's `edit.json`, the retimed transcript,
the head track, the preset's fonts and click sounds, and the two small preview copies (footage and
cut-out, about 18 MB together). Nothing built is stored.

A studio wrapper owns play, pause and seek. It never lets the player's clock advance while either
video cannot play from the current point: on play, after every seek and after any stall it holds the
clock, shows a short "Loading" state, and starts the clock only once both videos report they can play
from there. The transition clicks on the edit's `sounds` track are fetched and decoded in advance and
scheduled through one Web Audio `AudioContext` relative to the player's clock, cancelled on pause and
seek, so they land where the export will put them. When the reel's current version changes, the
preview rebuilds without a page reload. Opening the preview sends `studio_preview_opened` once with
`reel_id`. Outside Chromium-based browsers a short note says the preview is built for Chrome; it is
not blocked.

## User Story

As the owner
I want to watch a reel's current version as a live preview in the studio, as often as I like, without waiting for a render
So that I can judge the edit at once, with captions in sync with my voice from the first frame and the clicks on the transitions where the export will have them

## Problem Statement

Today the reel page shows only the status, jobs and step log. Version 1 of the edit and the preview
copies exist (slices 7 and 8, issue #31), but there is no way to see the edit without a render. A
naive embed of the player would drift: the player starts its clock the moment play is pressed while
each video still needs about a tenth of a second to start, so the voice runs behind the captions for
the first seconds, and again after every seek. The old setup also mixed clicks in after the render,
so its preview had none. Finally, the studio has no way to find the preview copies: their R2 keys are
`cache/preview_copies/<fingerprint>/...` and that fingerprint is computed only inside the worker; it
is neither in the edit nor in any row.

## Solution Statement

1. Start from issue #31's branch (`feat/issue-31-adw-9a39262e-edit-model-builder-versions`, which
   already carries #29 and #30): this slice is blocked by it and the builder, versions and preview
   copies come from it.
2. Record where the preview copies are: a migration adds `reels.preview_copies_fingerprint`, which
   the worker sets after the `preview_copies` step (run or cache hit). Move the cache key layout
   (`cacheKey`) from the worker into `packages/storage` so the worker and the studio derive keys from
   one function.
3. Add `soundHits(edit, transcript, preset)` to `packages/edit`: the resolved time, file, gain and
   length of every item on the `sounds` track. `build` uses it for its `<audio>` lines (goldens stay
   byte-identical), and the studio schedules from it: one source for when a click plays.
4. A server action signs downloads for the five R2 objects of the open reel's current version (R2
   with `R2_STUDIO_*`, or the fake's mock route under `E2E_MOCK_STORAGE=true`); a same-origin route
   serves the preset's fonts and sounds from `packages/edit/assets/`.
5. A client `Preview` component fetches, builds with `build()` (HarfBuzz measurer from the font
   bytes), maps asset paths to URLs and removes the sound `<audio>` lines from the copy handed to the
   player (Web Audio plays them), and renders `PreviewPlayer`.
6. `PreviewPlayer` wraps `<hyperframes-player>` without touching its code: no built-in controls, no
   click-to-play, no player loading card; its own play/pause button, scrubber, time and "Loading"
   status; a readiness gate (`readyState >= HAVE_FUTURE_DATA` and not `seeking`, waiting on
   `canplay`/`seeked`) on both videos before every `play()`; a sound scheduler over one
   `AudioContext`.
7. `LiveReel` adds `current_version_id` to the columns it follows through Realtime and passes it to
   `Preview`, which reloads when it changes. No polling.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; the layout block lists workspaces.
- `AGENTS.md`: repository rules (Yarn only, no em-dashes, conventional commits, docs rules, root-box
  measuring in specs).
- `.adw/project.md`: the ADW profile; its Tests section must list the new spec and its Review section
  the preview on the reel page.
- `docs/conditional-docs.md`: index; gets one line for `app_docs/preview.md`.
- `app_docs/studio.md`: read (changing `apps/studio`, the `reels` table, the storage doubles, studio
  E2E). Its Rules (never poll, never select `*` from `reels`, never let `authenticated` update
  `reels`, R2 worker keys never in `apps/studio/src/`, doubles only under the exact flag) bind this
  slice. Update the `reels` columns it lists.
- `app_docs/edit-model.md` (from #31): read (the builder, `BuildAsset`, preset fonts and sounds,
  goldens). Rules: the package is deterministic with no DOM globals; never store a built page; do not
  measure text with the browser; a change to built output updates the goldens.
- `app_docs/pipeline.md` (from #29/#30): read (`preview_copies`, fingerprints, `cacheKey`, `kept`
  outputs). Update where the preview copies' fingerprint is recorded.
- `app_docs/measurement.md`: read (the `capture` helper, `window.__capturedEvents`, the reserved
  `studio_preview_opened`). Update its event table: `studio_preview_opened` is now sent.
- `packages/edit/src/build.ts`: the builder; its `sounds` loop moves onto `soundHits`. The page it
  makes references `footage.mp4`, `subject.webm` and `assets/<file>` relative paths, and loads GSAP
  from `preset.gsap`.
- `packages/edit/src/anchors.ts`, `schema.ts`, `preset.ts`, `index.ts`: anchor resolution, the
  `sounds` item shape (`sound`, `gainDb`), `ISSEBYA.sounds`, the package's exports.
- `packages/edit/src/build.browser.test.ts`, `packages/edit/src/testdata/node.ts`: how the browser
  build loads fonts (`fetch` of the font bytes) and how Node does (`readFile`): the parity pattern.
- `packages/storage/src/index.ts`, `packages/storage/src/storage.ts`: `Storage.signDownload`,
  `assertStorageKey`, `keyPrefix`; `cacheKey` moves here.
- `apps/worker/src/pipeline/fingerprint.ts`: current home of `cacheKey`.
- `apps/worker/src/pipeline/run-pipeline.ts`, `apps/worker/src/process-job.ts`,
  `apps/worker/src/step-store.ts`: where the fingerprints are known and where reel writes go
  (`StepStore`); the new `preview_copies_fingerprint` write goes here.
- `apps/worker/src/steps/first-version.ts`: shows which fingerprints the edit's `inputs` hold
  (`footage` and `transcript` are the retime fingerprint, `cutout` remove_background's, `headTrack`
  head_track's) and the transcript and head-track cache keys.
- `supabase/migrations/20261104090000_versions.sql`: the `versions` table, its owner-read RLS,
  `reels.current_version_id`.
- `apps/studio/src/app/reels/[id]/page.tsx`, `apps/studio/src/components/LiveReel.tsx`: the reel
  page and its Realtime subscription; the preview mounts here.
- `apps/studio/src/lib/reels.ts` (+ `reels.test.ts`): `REEL_DETAIL_COLUMNS` and `ReelDetail`.
- `apps/studio/src/lib/storage.ts`: `studioStorage()` and `MOCK_UPLOAD_URL_BASE`.
- `apps/studio/src/app/upload-actions.ts`: the pattern for a server action that checks the user and
  signs through `studioStorage()`.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: the fake's GET, which the signed
  downloads point at under the flag.
- `apps/studio/src/lib/track.ts`: `capture("studio_preview_opened", { reel_id })`.
- `apps/studio/next.config.ts`: `transpilePackages`; gets `outputFileTracingIncludes` for the asset
  route.
- `apps/studio/package.json`: gets `@hyperframes/player`.
- `apps/worker/package.json`: the pinned `hyperframes` version to match.
- `apps/studio/e2e/upload.spec.ts`, `apps/studio/e2e/events.ts`, `apps/studio/test-support/*.ts`,
  `apps/studio/playwright.config.ts`, `fixtures/pipeline/manifest.json`: how a spec seeds the
  pipeline cache, runs the worker's `once`, records events and signs in.
- `apps/studio/db-tests/versions.test.ts`, `apps/studio/db-tests/rls.test.ts`: where the new column's
  RLS behaviour is tested.
- `knip.json`, `turbo.json`, `lefthook.yml`: dead-code config (new exports and the `.d.ts`), strict
  env (no new variable expected), hooks.
- `node_modules/@hyperframes/player/README.md` and `dist/hyperframes-player.d.ts` (after install):
  read before wiring. Facts already checked for 0.8.222: the element accepts `srcdoc`; attributes
  `disable-click-to-play`, `assets-loading-ui="none"`, `width`/`height`; events `ready`, `play`,
  `pause`, `timeupdate`, `ended`, `error`; `play()`, `pause()`, `seek()`, `currentTime`, `paused`,
  `ready`, `iframeElement` (open shadow root, same-origin sandbox by default, so
  `iframeElement.contentDocument` reaches the composition). In same-origin mode the player adopts
  timed, unmuted media (`audio[data-start]`, an unmuted `video[data-start]`) into parent-frame proxy
  elements (`_adoptIframeMedia`; a `video` with the `muted` attribute is skipped), and injects its
  runtime from a CDN when the page has `__timelines` but no runtime.
- `node_modules/next/dist/docs/`: the App Router guides for server actions, route handlers and
  `outputFileTracingIncludes` (Next 16).

### New Files

- `supabase/migrations/20261105090000_preview_copies_fingerprint.sql`: `reels.preview_copies_fingerprint text null`, checked `^[0-9a-f]{64}$`; no new grant to `authenticated` beyond the existing select.
- `packages/storage/src/cache-key.ts` (+ `cache-key.test.ts`): `cacheKey(prefix, step, fingerprint, file)` moved from the worker.
- `packages/edit/src/sounds.ts` (+ `sounds.test.ts`): `soundHits(edit, transcript, preset)`.
- `apps/studio/src/lib/preview-sources.ts` (+ `.test.ts`): pure key derivation for the five objects of a version.
- `apps/studio/src/app/preview-actions.ts`: server action `previewSources(reelId)`.
- `apps/studio/src/app/api/edit-assets/[...path]/route.ts` (+ `route.test.ts`): serves the preset's fonts and sounds.
- `apps/studio/src/lib/preview-page.ts` (+ `.test.ts`): maps asset paths to URLs and removes the sound `<audio>` lines in the copy handed to the player.
- `apps/studio/src/lib/media-ready.ts` (+ `.test.ts`): `canPlayFrom(el)` and `whenReady(elements, signal)`.
- `apps/studio/src/lib/sound-schedule.ts` (+ `.test.ts`): which hits to start, and when, from a clock pair.
- `apps/studio/src/lib/player-media.ts`: finds the media elements that actually play (one place for player internals, read only).
- `apps/studio/src/lib/browser.ts` (+ `.test.ts`): `isChromium(navigator)`.
- `apps/studio/src/components/Preview.tsx`: load, build, event, rebuild on version change.
- `apps/studio/src/components/PreviewPlayer.tsx`: the wrapper (controls, clock hold, sounds).
- `apps/studio/src/types/hyperframes-player.d.ts`: JSX intrinsic element typing for `hyperframes-player`.
- `apps/studio/test-support/pipeline.ts`: `seedPipelineCache(storage, prefix)` moved out of `upload.spec.ts`, plus a helper that saves a further version through `saveVersion` and `supabaseVersionStore(admin)`.
- `apps/studio/e2e/preview.spec.ts`: the browser coverage.
- `app_docs/preview.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Bring in #31, record where the preview copies are, share the cache key layout, expose the sound hits
from the edit package, and add the player dependency. None of this changes built output.

### Phase 2: Core Implementation

Pure studio helpers (keys, page mapping, readiness, sound schedule, browser check) with unit tests,
the server action and the asset route, then the `Preview` and `PreviewPlayer` components with the
clock hold and the Web Audio scheduler, and the test hooks that exist only under
`navigator.webdriver`.

### Phase 3: Integration

Mount the preview on the reel page, follow `current_version_id` through the existing Realtime
subscription, send `studio_preview_opened`, add the E2E spec (including the negative proof, run once
and removed), and update the docs and the ADW profile.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Bring in the dependency branch

- Merge `feat/issue-31-adw-9a39262e-edit-model-builder-versions` (local branch, or
  `origin/...` if it has been pushed) into this branch with a merge commit, as #30 and #31 did with
  their predecessors. If #31 has already landed on `develop`, merge `develop` instead.
- `yarn install --immutable`, then confirm `packages/edit`, `app_docs/edit-model.md`,
  `app_docs/pipeline.md` and the `versions` migrations are present.
- Run `supabase migration up --local` (the one allowed database command) so the local stack has the
  #29 to #31 migrations; on failure report and stop.

### 2. Share the cache key layout

- Move `cacheKey` from `apps/worker/src/pipeline/fingerprint.ts` to
  `packages/storage/src/cache-key.ts`, export it from `packages/storage/src/index.ts`, and import it
  in the worker from `@edit-issebya/storage` (no re-export left behind; `fingerprint()` itself stays
  in the worker, it uses `node:crypto`).
- `cache-key.test.ts`: the layout `${prefix}cache/<step>/<fp>/<file>` and that an invalid key throws.

### 3. Record the preview copies' fingerprint

- Migration `supabase/migrations/20261105090000_preview_copies_fingerprint.sql`:
  `alter table public.reels add column preview_copies_fingerprint text check (preview_copies_fingerprint ~ '^[0-9a-f]{64}$');`
  with a header comment (why: the studio's preview finds `cache/preview_copies/<fp>/` through it).
  Check the existing `reels` grants: if `authenticated` select is column-scoped, grant select on the
  new column only; never grant update.
- `StepStore` gets `previewCopies(reelId, fingerprint)` (an update of that column through the
  secret-key client). The worker calls it once the `preview_copies` step is done or a hit (in
  `process-job.ts` after `runPipeline` returns `fingerprints`, before `first_version`), after checking
  the lease signal like every other write. Update the worker's fakes/tests (`run-job.test.ts`,
  `first-version.test.ts` or wherever `StepStore` is faked) and add a test that the fingerprint is
  written with `fingerprints.preview_copies`.
- `apps/studio/db-tests/rls.test.ts` (or `versions.test.ts`): the owner reads their reel's
  `preview_copies_fingerprint`, another user does not, and `authenticated` cannot update it.
- Run `supabase migration up --local`.

### 4. Expose the sound hits from the edit package

- `packages/edit/src/sounds.ts`: `soundHits(edit, transcript, preset)` returns, sorted like
  `resolveAll` (start, then id), `{ id, at, file, path, gain, duration }` per `sounds` item: `at` from
  `itemTimes` (millisecond rounding), `path` = `assets/<file>`, `gain` = `10 ** ((gainDb ?? sound.gainDb) / 20)`,
  `duration` = the preset sound's. It validates through `editSchema` like `build`.
- Rewrite the sounds loop in `build.ts` to use it (keep `volume.toFixed(3)` in the HTML). Export from
  `index.ts`. Run `yarn workspace @edit-issebya/edit test`: the goldens in
  `packages/edit/src/testdata/built/` must not change (no `UPDATE_GOLDEN`).
- `sounds.test.ts`: on `rethink-work-accents` (which has clicks), every hit's `at` equals the
  `data-start` of the matching `<audio id>` in the golden HTML and its gain the `data-volume`; an edit
  with no sounds gives `[]`.

### 5. Add the player

- `yarn workspace @edit-issebya/studio add @hyperframes/player@0.8.222 --exact` (the same version as
  `hyperframes` in `apps/worker/package.json`; if that pin moved, use the new one, and say in
  `app_docs/preview.md` that the two move together).
- Read `node_modules/@hyperframes/player/README.md` and `dist/hyperframes-player.d.ts`, and in the
  dist find how it adopts iframe media into parent-frame proxies and which element plays the
  footage's sound. Note the findings for `player-media.ts` (step 9).
- `apps/studio/src/types/hyperframes-player.d.ts`: declare `hyperframes-player` in React's JSX
  `IntrinsicElements` with the attributes used (`srcdoc`, `width`, `height`,
  `disable-click-to-play`, `assets-loading-ui`, `ref`). Register the element only on the client:
  `await import("@hyperframes/player")` inside an effect (it defines a custom element and touches
  `HTMLElement` at load).

### 6. Pure studio helpers with unit tests

- `src/lib/preview-sources.ts`: `previewKeys({ prefix, version: { r2_key, inputs }, previewFingerprint })`
  returns `{ version, transcript, headTrack, footage, cutout }` keys: the version's `r2_key`;
  `cacheKey(prefix, "retime", inputs.transcript, "transcript.json")`;
  `cacheKey(prefix, "head_track", inputs.headTrack, "head-track.json")`;
  `cacheKey(prefix, "preview_copies", previewFingerprint, "footage.mp4")` and `"subject.webm"`. Every
  key through `assertStorageKey`. Test with the fixture manifest's fingerprints.
- `src/lib/preview-page.ts`: `previewPage(html, assets, urls)` where `urls` maps each
  `BuildAsset.path` to a URL. It rewrites `src="<path>"` and `url("<path>")` occurrences of exactly
  the listed paths, removes every `<audio ...></audio>` line whose `src` is a `sound` asset (the
  sounds track is played through Web Audio; leaving them would play each click twice through the
  player's own audio proxies), and throws on an asset with no URL. It never touches anything else
  (the GSAP script, the timeline). Tests on the golden `rethink-work-accents.html`: no `<audio`
  left, no relative asset path left, and removing the same lines and mapping the URLs back gives the
  golden exactly.
- `src/lib/media-ready.ts`: `canPlayFrom(el)` = `!el.seeking && el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA`
  (use the literal `3` behind a named constant so Node tests run); `whenReady(elements, signal)`
  resolves once every element can play from its current point, re-checking on `canplay`,
  `canplaythrough`, `seeked`, `loadeddata` and `playing`, and rejects with an `AbortError` on abort
  (listeners removed). Tests with `EventTarget` stand-ins: resolves at once when all ready; waits for
  the second element; a `seeking` element blocks; abort rejects and leaves no listener.
- `src/lib/sound-schedule.ts`: `scheduleFrom(hits, playerTime, contextTime)` returns
  `{ id, path, gain, when }[]` for every hit with `at >= playerTime`, `when = contextTime + (at - playerTime)`;
  a hit already started (`at < playerTime`) is skipped, never started mid-click. Tests: start at 0,
  resume mid-reel, a hit exactly at the resume point, none left.
- `src/lib/browser.ts`: `isChromium(nav)` true when `nav.userAgentData?.brands` names `Chromium`, or
  (no client hints) the user agent has `Chrome/` or `Edg/` and not `Firefox/`; Safari and Firefox
  false. Table test with real user-agent strings.

### 7. The server side: signed links and the asset route

- `src/app/preview-actions.ts`: `"use server"` `previewSources(reelId)`. Checks `isReelId`, gets the
  user through `createSupabaseServerClient()` (no user: `{ state: "signed-out" }`), reads
  `current_version_id, preview_copies_fingerprint` from `reels` (named columns, RLS) and the
  version's `r2_key, inputs` from `versions` (RLS). Returns a tagged result: `no-version` (no current
  version yet), `no-previews` (no fingerprint), `not-configured` (`studioStorage()` null or
  `keyPrefix()` null), or `ready` with `versionId` and five URLs from `storage.signDownload(key, { expiresInSeconds: 3600 })`.
  Reads nothing for any other reel and never reads the worker's keys.
- `src/app/api/edit-assets/[...path]/route.ts`: GET serves a file from `@edit-issebya/edit/assets/`
  only when the joined path is one of `ISSEBYA.fonts[*].file` or `ISSEBYA.sounds[*].file` (allow-list;
  anything else 404), with `Content-Type` `font/ttf` or `audio/wav` and a long immutable cache
  header. Resolve the file with `import.meta.resolve` as `first-version.ts` does. Add
  `outputFileTracingIncludes` for this route in `apps/studio/next.config.ts` so the files ship on
  Vercel. `route.test.ts`: a preset font answers 200 with its bytes, `../package.json` and an unknown
  file 404.

### 8. The `Preview` component

- `src/components/Preview.tsx` (`"use client"`), props `{ reelId, versionId }`:
  - Sends `capture("studio_preview_opened", { reel_id })` once per mount (guard with a ref so React
    StrictMode's double effect and later rebuilds do not send it again).
  - On mount and whenever `versionId` changes (an effect keyed on it, aborting the previous load with
    an `AbortController`): call `previewSources`; for `ready`, fetch in parallel the version JSON, the
    transcript, the head track and the font bytes (`/studio/api/edit-assets/<file>`); build with
    `createMeasurer(fonts)` and `build({ edit, transcript, headTrack, preset: ISSEBYA, measurer })`,
    then `measurer.close()`; compute `soundHits`; fetch and `decodeAudioData` each distinct sound path
    once (cached across rebuilds by path); map URLs with `previewPage`; hand `{ srcdoc, hits, buffers }`
    to `PreviewPlayer`. While loading show "Loading preview"; for `no-version`/`no-previews` show "The
    preview appears once processing has finished"; on error show a short error line (no retry loop).
  - A failed check does not block the preview (the checks are shown by later slices).
  - Under `isChromium(navigator)` false: a one-line note "The preview is built for Chrome; it may not
    play correctly in this browser." above the player, never blocking.
  - Test hook, only under `navigator.webdriver` and memory only: `window.__preview = { versionId, html }`
    where `html` is the builder's output before mapping (for parity).

### 9. The `PreviewPlayer` wrapper

- `src/lib/player-media.ts`: `playingMedia(player)` returns the elements whose readiness gates the
  clock: `#footage` and `#cutout` from `player.iframeElement.contentDocument` and, if step 5 showed the
  player plays the footage's sound from a parent-frame proxy, that proxy too. If reaching it needs a
  private field, read it here only, read only, behind a narrow type, with a comment naming the pinned
  version; never assign to the player or its media. This is the one file to revisit on a player bump.
- `src/components/PreviewPlayer.tsx`, props `{ srcdoc, hits, buffers }`:
  - Renders `<hyperframes-player srcdoc={srcdoc} width="1080" height="1920" disable-click-to-play assets-loading-ui="none">`
    without `controls`, sized 9:16 inside the page column, plus its own controls: a Play/Pause button,
    a range input scrubber (step 0.01 s, max = duration from `ready`), the time as `m:ss.s / m:ss.s`,
    and a `role="status"` "Loading" indicator shown while the clock is held.
  - States: `loading` (until `ready`), `paused`, `holding`, `playing`.
  - Play: state `holding`; `player.pause()`; hold at `t = player.currentTime`; await
    `whenReady(playingMedia(player))`; `audioContext.resume()`; read `c0 = audioContext.currentTime`,
    `t0 = player.currentTime`; `player.play()`; schedule `scheduleFrom(hits, t0, c0)` as
    `AudioBufferSourceNode`s through one `GainNode` per hit into the context's destination; state
    `playing`.
  - Pause: `player.pause()`; stop and disconnect every scheduled source; abort any pending wait.
  - Seek (scrubber input): stop scheduled sources; `player.seek(t)`; if it was playing, run the Play
    sequence from `t` (hold until ready again); if paused, just show the frame.
  - Stall while playing (`waiting` or `stalled` on a playing element, or `isStalled`: too little data
    or seeking, with the buffer short of 0.5 s past the current point; a decoder dip or the player's
    own drift-correcting seek inside the buffer is not a stall): pause the player at its current time, cancel sounds, go `holding`, resume through the
    Play sequence.
  - `ended`: stop sources, state `paused`.
  - One `AudioContext` per mounted player, closed on unmount; a new `srcdoc` (rebuild) pauses, cancels
    sounds and resets to `loading`.
  - Test hook, only under `navigator.webdriver` and when a spec put an array on
    `window.__scheduledSounds`: push `{ id, when, contextTime: c0, playerTime: t0 }` for each
    `start(when)` call (memory only), and `{ id, stopped: true }` on cancel.
- No timer polling anywhere: the clock shown in the controls follows the player's `timeupdate`
  events.

### 10. Mount it on the reel page

- `src/lib/reels.ts`: add `current_version_id` to `REEL_DETAIL_COLUMNS` and `ReelDetail`
  (`string | null`); update `reels.test.ts`.
- `LiveReel.tsx`: render `<Preview reelId={reel.id} versionId={reel.current_version_id} />` above the
  status list when `current_version_id` is set (the existing Realtime `reels` UPDATE handler already
  merges the new column, so a new current version rebuilds the preview without a reload); otherwise
  the "appears once processing has finished" line.

### 11. E2E spec (the browser coverage)

- `apps/studio/test-support/pipeline.ts`: move `seedPipelineCache` (and the manifest reader) out of
  `upload.spec.ts` and import it there; add `saveNextVersion(admin, storage, { prefix, reelId, edit })`
  using `saveVersion` with `supabaseVersionStore(admin)` (secret key, test-support only) and the fake
  storage, parented on the reel's current version.
- `apps/studio/e2e/preview.spec.ts`, modelled on `upload.spec.ts` (own user, own `CACHE_PREFIX`,
  `claimableJobIds` guard in `beforeAll`, every seeded key and the user deleted in `afterAll`). Seed
  the reel and its `process` job through the upload form (as `upload.spec.ts` does) or a
  test-support insert of the same rows, seed the pipeline cache, run `runWorkerOnce` with
  `R2_KEY_PREFIX` so the six steps are hits and version 1 is saved. Then save version 2 =
  version 1 plus two `sounds` items `click` anchored to the start of two fixture words at least
  `minSoundGap` apart (ids `click-a`, `click-b`). Tests:
  1. **Player and first caption**: the reel page shows `hyperframes-player`; seek through the
     scrubber to the first caption's resolved start plus `caption.appear`; in
     `page.frameLocator("hyperframes-player iframe")` the first caption word's `#<id>` element has
     the fixture word's text and computed opacity above 0.9.
  2. **Clock waits for media**: before `goto`, `page.route("**/cache/preview_copies/**/subject.webm", ...)`
     delays the response by 2 s (routing also disables the HTTP cache). Press Play; sampled over
     1.5 s, `player.currentTime` stays at 0 (within 0.05 s) and the "Loading" status is visible; once
     the file has arrived, `currentTime` passes 0.3 s within 5 s. On a fresh load the player's own
     first-frame wait holds the clock here too. Then a second page load with an init script that
     records, at each of the player's `play` events, both videos' `readyState`, `seeking` and
     `currentTime` against the player's time, and with `footage.mp4` served as a `206` partial
     response (its first 80%: Chromium reports no metadata for the 43 KB copy before it has read its
     first 32 KiB) and every later request held: wait for `player.assetsReady` (the player's own
     wait is over and cannot hold the clock again on this load), read the footage's buffered end,
     seek 0.15 s past it, press Play; "Loading" is visible and the time holds there (within 0.05 s)
     for 1.5 s; release the rest, the time passes the seek plus 0.2 s within 5 s, and every recorded
     snapshot shows both videos playable at the clock's time (`readyState >= 3`, not `seeking`,
     within 0.25 s).
  3. **Sounds scheduled exactly**: with `window.__scheduledSounds = []` set by an init script, press
     Play from 0: two entries `click-a`, `click-b`, each with `when - contextTime + playerTime` equal
     to its word's start (read from the fixture transcript in Node) within 10 ms. Pause records both
     as stopped when they had not played yet.
  4. **Event once**: with `recordEvents(page)`, exactly one `studio_preview_opened` with
     `{ app: "studio", reel_id }`, including after the version 2 rebuild.
  5. **Rebuild without reload and builder parity**: open the page on version 1, set a
     `window.__noReload` marker, save version 2 through the helper; `window.__preview.versionId`
     becomes version 2's id with the marker still present; then `window.__preview.html` equals,
     byte for byte, `build()` run in the spec's Node process on version 2's edit with the fixture
     transcript and head track and a measurer from the font files read with `readFile` (the worker's
     build path).
- **Negative proof** (not committed): source `.ports.env`, then in `PreviewPlayer` replace
  `await whenReady(playingMedia(player), controller.signal, at);` with
  `await Promise.resolve(); console.log("gate-bypass-probe");` and confirm the dev server serves it
  (`grep -l gate-bypass-probe apps/studio/.next/dev/static/chunks/apps_studio_src_*.js`). Run the
  studio's own Playwright command (`yarn test:e2e -- <file>` also passes the file to the landing
  suite): `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio playwright test preview.spec.ts -g "the clock waits" --repeat-each=3`.
  All 3 must fail. Restore with `git checkout -- apps/studio/src/components/PreviewPlayer.tsx`,
  confirm the probe string is gone from the served chunk, rerun the same command: all 3 must pass.
  State the result in the PR (see Notes).

### 12. Documentation and profile

- New `app_docs/preview.md` (Overview, How it works, How to Use, Configuration, Testing, Rules,
  Notes): the player and its pinned version (equal to the worker's `hyperframes`), what is fetched
  and from where (signed links for five R2 objects per version, fonts and sounds from the asset
  route), how the wrapper holds the clock (readiness rule, after every seek and stall), how sounds
  are scheduled (Web Audio, from `soundHits`, the sound `<audio>` lines removed from the copy the
  player gets), `preview_copies_fingerprint`, Chrome only, the test hooks. Rules: never patch, fork
  or monkey-patch the player (player internals are read only, only in `player-media.ts`); one builder
  (never a preview-only copy of build logic; the preview only maps URLs and drops sound lines); the
  clock never advances while either video cannot play from the current point; sounds come from the
  edit's `sounds` track only, never hard-coded; never store the built page; no polling (read on open
  and on a new current version only).
- `docs/conditional-docs.md`: "Read `app_docs/preview.md` when changing the studio's live preview,
  the HyperFrames player or its version pin, the clock wrapper, the sound scheduling, the preview's
  signed links or asset route, or `reels.preview_copies_fingerprint`."
- `app_docs/studio.md`: the new `reels` column and the reel page's preview (one line each);
  `app_docs/pipeline.md`: the worker records `preview_copies_fingerprint`; `app_docs/edit-model.md`:
  `soundHits` and the studio as the second consumer; `app_docs/measurement.md`:
  `studio_preview_opened` moves from reserved to sent (on preview open, `reel_id`).
- `.adw/project.md`: Tests lists `preview.spec.ts` (needs the CDN for GSAP and the player runtime);
  Review adds the reel page's preview for a processed reel. Keep the nine headings untouched.
- Check every changed file for em-dashes: `grep -rn -P "\x{2014}" <changed files>` prints nothing.

### 13. Run the validation commands

- Run every command in `Validation Commands` below, in order, and fix anything that fails.

## Testing Strategy

### Unit Tests

- `packages/storage/src/cache-key.test.ts`: key layout and rejection.
- `packages/edit/src/sounds.test.ts`: `soundHits` agrees with the golden page's `<audio>` lines; the
  existing Node and Chromium golden tests prove `build` output is unchanged.
- Worker: the `preview_copies_fingerprint` write after the pipeline, with a fake `StepStore`.
- Studio: `preview-sources.test.ts`, `preview-page.test.ts`, `media-ready.test.ts`,
  `sound-schedule.test.ts`, `browser.test.ts`, `edit-assets` `route.test.ts`, updated `reels.test.ts`.
- DB (`test:db`): owner-only read of `preview_copies_fingerprint`, no `authenticated` update.

### Test Coverage

- `apps/studio/e2e/preview.spec.ts` (Playwright, chromium): proves the player renders the built
  version with captions at their anchored times, that the clock holds while either video cannot play
  (at start and after a seek), that clicks are scheduled at anchor plus playback start within 10 ms,
  one `studio_preview_opened`, rebuild on a new version without reload, and Node/Chromium builder
  parity on the page the studio actually built. Nothing covers any of this today; every test fails
  without the feature (no player on the page). The player's own first-frame wait (8 s, once per
  load) also holds the clock at start, so the gate is proven by test 2's seek into unbuffered
  footage after that wait has settled, which fails without the gate (the negative proof).
- `media-ready.test.ts`, `sound-schedule.test.ts` (Vitest unit): catch a gate that resolves early or
  a click started mid-hit or at the wrong offset, without a browser.
- `preview-page.test.ts` (unit): catches a double click (an `<audio>` line left for the player) or an
  unmapped asset path.
- `sounds.test.ts` (unit): catches the studio's schedule and the builder's sound lines drifting
  apart.
- `cache-key.test.ts` and the worker's fingerprint-write test (unit), plus the `test:db` RLS case:
  catch the studio looking for preview copies under a key the worker never wrote, or another user
  reading the column.

### Edge Cases

- A reel with no current version yet, or a version but no `preview_copies_fingerprint` (reel
  processed before this slice): the "appears once processing has finished" line, no error.
- A new current version arriving while playing: pause, cancel sounds, rebuild, no reload, no second
  event.
- Seeking while holding (abort the pending wait; only the last seek resumes).
- Seek past the last click, or resume exactly on a click's time.
- A stall mid-playback (slow R2): hold, then resume; clicks rescheduled from the held time.
- `ended`: no sources left scheduled.
- An edit with no `sounds` items: no `AudioContext` work, no fetch of sound files.
- A version whose checks failed still previews.
- Signed links expiring (one hour) on a long-open page: a load error line; a reload fixes it (no
  polling or timed refresh).
- Non-Chromium browser: note shown, preview still mounted.
- The mock storage GET serves one byte range, as R2 does: without `Accept-Ranges` and a 206 the
  browser cannot seek a video and lands every seek at 0, even on a small, fully loaded copy.

## Acceptance Criteria

- `@hyperframes/player` is in `apps/studio/package.json` at exactly the worker's `hyperframes`
  version (0.8.222), and no file under `node_modules/@hyperframes/player` is patched (no
  `.yarn/patches`, no `patch:` protocol).
- The reel page of a processed reel shows the player playing its current version, built in the
  browser by `build()` from `packages/edit`; the built page is never written anywhere.
- Play, pause and seek go only through the studio's controls; the player's clock never advances
  while either video cannot play from the current point, at start, after every seek and after a stall;
  a visible "Loading" status covers the hold.
- Clicks come only from the edit's `sounds` track, are decoded in advance and started through one
  `AudioContext` at anchor time plus playback start (within 10 ms), cancelled on pause and seek, and
  never also played by the player.
- A new `current_version_id` rebuilds the preview without a page reload; the studio never polls.
- Exactly one `studio_preview_opened` with `reel_id` per preview open.
- A non-Chromium browser sees the Chrome note and the preview.
- The studio's page equals the Node build of the same version byte for byte.
- The worker records `reels.preview_copies_fingerprint`; only the owner can read it and nobody but the
  worker writes it.
- `app_docs/preview.md` and its index line exist; the touched docs and the ADW profile are updated;
  no em-dash in any file.
- Every validation command below passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage --filter=./packages/edit`: lint every touched workspace.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage --filter=./packages/edit`: types, including the JSX typing of the player element and the worker and storage changes (their build check).
- `yarn knip`: no unused export, file or dependency (the moved `cacheKey`, `soundHits`, the player dependency).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker --filter=./packages/storage --filter=./packages/edit`: unit tests, including the edit package's Node and Chromium golden runs (unchanged output).
- `supabase migration up --local`: applies the new migration to the shared local stack (the only allowed database command; on failure report and stop).
- `yarn turbo run test:db --filter=./apps/studio`: RLS on the new column, versions and the existing DB tests.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with the player, the server action and the asset route.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the issue's full gate, unfiltered, since the change spans four workspaces and `supabase/`.
- `set -a; . ./.ports.env; set +a; PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e`: both E2E suites against the run's servers, including `apps/studio/e2e/preview.spec.ts` and the updated `upload.spec.ts`.

## Notes

- **Blocked by #31.** This branch was cut from `develop` before #29 to #31 merged; step 1 merges
  #31's branch. If #31's final code differs from what this plan read (from its worktree at
  `000e0bf`), follow the code and keep the plan's intent.
- **Gap in the issue's "Current state"**: nothing records where the preview copies are (their key
  needs the `preview_copies` fingerprint, computed only in the worker). This plan adds
  `reels.preview_copies_fingerprint`. Rejected alternatives: computing the fingerprint in the studio
  (duplicates the worker's step settings and versions), adding it to the edit format (would change
  `format: 1` and the goldens), a `steps.fingerprint` column (the `steps` column set is pinned by
  `steps-measurements.test.ts` and its doc).
- **Removing the sound `<audio>` lines** from the copy handed to the player is not a second builder:
  it is a fixed, tested transform of the builder's output; the export (slice 12) renders the builder's
  page as is, with the same track. Without it, the player would also play each click through its
  parent-frame audio proxies.
- **Player internals**: the voice of the footage may play from a parent-frame proxy the player
  creates (0.8.222). The readiness gate must cover the element that actually plays. If that needs a
  private field, it is read in `player-media.ts` only, never written; the E2E seek test guards it on
  every player bump.
- **CDN**: the built page loads GSAP from `preset.gsap` (jsDelivr) and the player injects its runtime
  from a CDN; the E2E spec needs network access to them (CI has it). Vendoring them would change the
  builder's output and is out of scope.
- **R2 CORS**: the browser `fetch`es the version JSON, transcript and head track from signed R2 URLs.
  The bucket's CORS rule must allow `GET` from the studio's origin (the upload already needs `PUT`).
  Tell the owner before manual acceptance; the E2E fake is same-origin.
- **New dependency**: `@hyperframes/player@0.8.222` (exact) in `@edit-issebya/studio`, added with
  `yarn workspace @edit-issebya/studio add @hyperframes/player@0.8.222 --exact`; it pulls
  `@hyperframes/core@0.8.222`.
- **Manual acceptance (owner)**: a real reel processed on the worker's machine, opened in Chrome:
  captions match the voice from the first second and after seeks, clicks land on transitions;
  compare by eye and ear with
  `/Users/sveta/Dev/issebya/issebya-homes-reels/editing/videos/rethink-work/renders/rethink-work-02.mp4`
  (read only). The pipeline does not verify smoothness on real 50-second footage or audible sync.
- **Negative proof, run 2026-11-01**: the first version of test 2 passed with the gate bypassed
  because `@hyperframes/player` 0.8.222 runs its own first-frame wait on every load
  (`_waitForAssetsReady`: every video visible at time 0 must reach `readyState >= 3`, or 8 s pass);
  until it settles `play()` only sets `_pendingPlay`, and both halves held a whole file from the
  first byte. A seek does not reset `_assetsReady`, so test 2's second half now seeks past the
  buffered end of a partly served footage once that wait is over. Bypass: `whenReady(...)` replaced
  by `await Promise.resolve(); console.log("gate-bypass-probe");`, confirmed in the served chunk.
  Command: `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn workspace @edit-issebya/studio playwright test preview.spec.ts -g "the clock waits" --repeat-each=3`.
  Gate bypassed: 3 of 3 failed on `expect(page.getByText("Loading", { exact: true })).toBeVisible()`
  after the seek (the clock started at once). With that line and the drift check commented out, 3 of
  3 still failed on `playableAtClock`: at the player's `play` the footage reported
  `readyState: 1, seeking: true` at the clock's 2.3 s. Gate restored (`git status --short
apps/studio/src` empty, probe string gone from the served chunk): 3 of 3 passed.
- Out of scope: the change-request box (slice 11), export (slice 12), Safari and iPhone, a timeline
  editor, the browser notification (slice 15).
