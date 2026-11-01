# Patch: Write the preview doc, update the touched docs and the ADW profile

## Metadata

adw_id: `b7898314`
review_change_request: `Issue #1: Step 12 (Documentation and profile) and the acceptance criterion 'app_docs/preview.md and its index line exist; the touched docs and the ADW profile are updated' were never done. Since the merge base 2103ffd, the only doc change is one line in app_docs/studio.md about the mock GET's byte ranges. Missing: (a) .adw/project.md Tests does not list preview.spec.ts or its CDN need, and Review does not add the reel page's preview for a processed reel. (b) app_docs/measurement.md line 92 still lists studio_preview_opened as 'reserved, not sent yet'. (c) app_docs/pipeline.md does not say the worker records reels.preview_copies_fingerprint. (d) app_docs/edit-model.md does not mention soundHits or the studio as the second consumer. (e) app_docs/studio.md lacks the new reels columns and the reel page's preview. (f) app_docs/preview.md and its docs/conditional-docs.md line are absent. Resolution: update the profile and the four docs, write app_docs/preview.md and its index line, then run the em-dash grep on every changed file. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-32-adw-b7898314-sdlc_planner-live-preview-hyperframes-player.md`
**Issue:** Step 12 of the spec was skipped. The ADW profile does not know about `apps/studio/e2e/preview.spec.ts` or the preview's review captures, four feature docs describe the pre-preview state (`studio_preview_opened` still "reserved, not sent yet"), and `app_docs/preview.md` with its index line does not exist.
**Solution:** Documentation and profile only, no code change. Write every item on this branch now (do not rely on the document phase): one or two lines in each touched doc, the profile's Tests and Review additions under the existing headings, the new `app_docs/preview.md` and its `docs/conditional-docs.md` line. Every fact below was read from the current source; re-read the named file while writing so each literal is exact.

## Files to Modify

- `.adw/project.md` (Tests and Review paragraphs; the nine `##` headings untouched)
- `app_docs/measurement.md` (events table)
- `app_docs/pipeline.md` (one line after the `preview-copies.ts` bullet)
- `app_docs/edit-model.md` (one line under How it works, the Notes line about later slices)
- `app_docs/studio.md` (Reels and Live status sections)
- `app_docs/preview.md` (new)
- `docs/conditional-docs.md` (one new line)

Do not touch the uncommitted `apps/studio/e2e/preview.spec.ts`, the spec file or `specs/patch/patch-adw-b7898314-preview-gate-negative-proof.md` (they belong to the earlier patch).

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Update the ADW profile (`.adw/project.md`)

- Tests, the E2E paragraph (around line 159 to 166): after the `step-log.spec.ts` clause add a clause for `preview.spec.ts`: seeds a processed reel (its version, transcript, head track and the two preview copies, through `apps/studio/test-support/pipeline.ts`) and checks the player shows the current version with its first caption at its time, the clock holds until both videos can play (at start and after a seek into unbuffered footage), a new current version rebuilds the preview without a reload byte for byte the Node build with one `studio_preview_opened`, and the clicks are scheduled at their word's time; it needs network access to `cdn.jsdelivr.net` (GSAP `gsap@3.14.2`, named by the preset, and the player's runtime `@hyperframes/core@0.8.222/dist/hyperframe.runtime.iife.js`).
- Review, the Studio bullet (line 271 to 275): after "the `received` sample reel's page with its jobs and step log" add "and a processed reel's page with the live preview player (seeded as `preview.spec.ts` seeds it), each at 1920x1080 and 375x667". Keep the sentence about the sign-in URL as is.
- Change no heading, no heading order, no other section.

### Step 2: Update the four touched docs (one line or bullet each)

- `app_docs/measurement.md` events table (lines 87 to 92): add a row `studio_preview_opened` | the live preview opens on a reel page (`Preview.tsx`, once per open) | `reel_id`, `app`; drop `studio_preview_opened` from the reserved row so it reads `studio_change_requested`, `studio_export_requested`, `studio_export_downloaded`. Run `yarn format` afterwards so Prettier realigns the table.
- `app_docs/pipeline.md`: after the `preview-copies.ts` bullet (line 72 to 76) add a bullet: `apps/worker/src/pipeline/record-preview-copies.ts`: after the fixed steps (`preview_copies` run or a cache hit) `process-job.ts` writes the `preview_copies` fingerprint to `reels.preview_copies_fingerprint` (`step-store.ts`, secret key), so the studio's live preview finds the copies under `cache/preview_copies/<fingerprint>/`; after a lost lease nothing is written.
- `app_docs/edit-model.md`: under How it works add a bullet `packages/edit/src/sounds.ts`: `soundHits(edit, transcript, preset)` returns every hit of the `sounds` track (the edit is checked as `build` checks it); the studio's live preview is the second consumer of the package (after the worker), building the page in the browser with the same `build()` and scheduling the clicks from `soundHits`. Replace the Notes line "The decide step (AI edits) and the live preview import this package in later slices." with "The studio's live preview imports this package (see `app_docs/preview.md`); the decide step (AI edits) does in a later slice."
- `app_docs/studio.md`: in Reels add a bullet for `supabase/migrations/20261105090000_preview_copies_fingerprint.sql`: `reels.preview_copies_fingerprint` (64 hex characters or null), readable by the owner under the existing select policy, written only by the worker; and extend the `apps/studio/src/lib/reels.ts` bullet to say `REEL_DETAIL_COLUMNS` includes `current_version_id`. In Live status add a bullet: `LiveReel.tsx` mounts the live preview (`Preview`) on the reel page once the reel has a current version, passes it the version id it follows through Realtime, and shows "The preview appears once processing has finished." before that; see `app_docs/preview.md`.

### Step 3: Write `app_docs/preview.md`

Sections in this order: `# Live preview: HyperFrames player, media-ready clock and the sound track`, one summary paragraph, then `## Overview`, `## How it works`, `## How to Use`, `## Configuration`, `## Testing`, `## Rules`, `## Notes`. Content, from the source:

- Overview: the reel page of a processed reel plays its current version in the browser; the page is built by `build()` from `packages/edit` on open and on each new `current_version_id`, never stored.
- How it works, one bullet per file:
  - `apps/studio/package.json`: `@hyperframes/player` pinned at `0.8.222`, equal to the worker's `hyperframes`.
  - `apps/studio/src/app/preview-actions.ts`: server action `previewSources(reelId)`, reads `current_version_id` and `preview_copies_fingerprint` through the signed-in user's client (RLS decides), signs five download links for one hour (`DOWNLOAD_URL_SECONDS`): the edit, transcript, head track and the two preview copies (`previewKeys` in `src/lib/preview-sources.ts`); states `ready`, `no-version`, `no-previews`, `not-configured`, `signed-out`, `failed`. A page open longer than an hour shows a load error; a reload signs new links.
  - `apps/studio/src/app/api/edit-assets/[...path]/route.ts`: same-origin fonts and click sounds from `packages/edit/assets/`, only files the preset names, otherwise 404 (traced in by `next.config.ts`).
  - `src/components/Preview.tsx`: fetches, builds, decodes each sound once with an `OfflineAudioContext`, sends `studio_preview_opened` once per open, shows "Loading preview" and the Chrome note.
  - `src/lib/preview-page.ts`: the copy the player gets maps each asset path to its URL and removes the `<audio>` line of every sound asset; nothing else changes.
  - `src/components/PreviewPlayer.tsx` and `src/lib/media-ready.ts`: the studio's own controls; the readiness rule (not seeking, `HAVE_FUTURE_DATA`, at the held time), applied on Play, after every seek and after a stall (data too low and the buffer short of the lookahead); the hold shows "Loading"; no timer.
  - `src/lib/sound-schedule.ts`: clicks from `soundHits`, started through one `AudioContext` at their offset from the clock start, a hit already begun skipped, all stopped on pause, seek and the end.
  - `src/lib/player-media.ts`: the one read-only reader of the player's internals (the iframe's `#footage` and `#cutout`, the parent-frame proxies when audio is promoted).
  - `src/lib/browser.ts`: Chromium check; elsewhere a note ("The preview is built for Chrome; it may not play correctly in this browser."), never a block.
- How to Use: open a processed reel's page in the studio, press Play, seek.
- Configuration: the studio's R2 variables (or `E2E_MOCK_STORAGE=true`, whose mock GET answers one `Range`); network access to `cdn.jsdelivr.net` for GSAP and the player runtime; nothing new in `turbo.json`.
- Testing: the unit tests (`media-ready`, `preview-page`, `preview-sources`, `sound-schedule`, `browser`, the asset route, `packages/edit/src/sounds.test.ts`, `record-preview-copies.test.ts`), `apps/studio/db-tests/versions.test.ts` for the new column's RLS, and `apps/studio/e2e/preview.spec.ts` with its four tests and test hooks (`window.__preview` with `versionId` and `html`; `window.__scheduledSounds`, recorded only under `navigator.webdriver` when a spec put an array there; `data-testid="preview-time"`).
- Rules (each one a bullet): Never patch, fork or monkey-patch the player; its internals are read only and only in `player-media.ts`. Never keep a preview-only copy of build logic: there is one builder, and the preview only maps URLs and drops sound lines. Never let the clock advance while either video cannot play from the current point. Never hard-code a sound: clicks come only from the edit's `sounds` track. Never store the built page. Never poll: read on open and on a new current version only. Never bump `@hyperframes/player` apart from the worker's `hyperframes`.
- Notes: Chrome only by design; a bump of the player means re-reading `player-media.ts`.

### Step 4: Index line and checks

- Append to `docs/conditional-docs.md`, in the style of the last two lines: "- `app_docs/preview.md`: read when changing the studio's live preview, the HyperFrames player or its version pin, the clock wrapper, the sound scheduling, the preview's signed links or asset route, or `reels.preview_copies_fingerprint`."
- Run `yarn format`, then the em-dash grep below; fix anything it prints.

## Validation

- `grep -n -P "\x{2014}" .adw/project.md app_docs/measurement.md app_docs/pipeline.md app_docs/edit-model.md app_docs/studio.md app_docs/preview.md docs/conditional-docs.md specs/patch/patch-adw-b7898314-preview-docs-and-profile.md` prints nothing.
- `grep -c "^## " .adw/project.md` prints `9`, and `grep "^## " .adw/project.md` lists Identity, Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review in that order.
- `grep -n "preview.md" docs/conditional-docs.md` prints one line; `grep -n "reserved" app_docs/measurement.md` no longer names `studio_preview_opened`.
- `yarn format:check`
- `yarn knip`

## Patch Scope

**Lines of code to change:** about 130 lines of documentation (about 100 new in `app_docs/preview.md`, about 30 across the profile, four docs and the index), no code.
**Risk level:** low
**Testing required:** formatting, the em-dash grep and the heading check; no test runs needed since no code changes.
