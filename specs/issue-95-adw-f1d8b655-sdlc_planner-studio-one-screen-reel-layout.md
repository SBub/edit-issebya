# Feature: Studio look: one-screen reel page, read-only tracks timeline, thumbnail grid of reels

## Metadata

issue_number: `95`
adw_id: `f1d8b655`
issue_json: `{"number":95,"title":"feat: studio look: one-screen reel page with a read-only tracks timeline, thumbnail grid for reels, equal desktop and phone layouts"}`

## Feature Description

The studio works but reads like a plain document: the reel page is one long column (preview, export,
change box, versions, status, jobs, steps) that needs page scroll, and the reels list is a text list.
This feature gives the studio a dark, editor-like look with equal desktop and phone layouts:

- **Reel page on one screen.** On desktop (1440x900 and up): a header (back link, reel name, Export),
  a main column (large 9:16 preview, a control row with Play or Pause, `00:00 / 00:52`, the Position
  slider, Undo and Redo, a time ruler and one row per track), the correction field with Send pinned
  under it, and a right-hand side panel holding Versions and Status, each scrolling inside its own
  area. On a phone (390x844): the same header and the same pinned correction field, with the middle
  split into three tabs (Edit, Versions, Status). The document never scrolls; long lists scroll
  inside their own box.
- **Read-only tracks timeline.** Rows for Footage (frame thumbnails from the footage preview copy and
  the clip's length), Captions, Accents, Transitions and Sounds, laid out on a ruler from the shown
  version's resolved timeline (`resolveTimeline` from `packages/edit`). A playhead follows the
  player's clock. Nothing in it is focusable, selectable, draggable or editable.
- **Undo and Redo** move the shown version between saved versions (Undo shows the previous version,
  Redo the next). They never create a version or queue a job; "Go back to this" stays the only way
  to make an older version current.
- **Reels list as a thumbnail grid** (3 columns on a phone, more as width allows), each tile with
  its thumbnail (one frame from the footage preview copy, made by the pipeline's `preview_copies`
  step and recorded on the reel), its age and size (`1w · 62.2 MB`) and its status, plus a round
  **+** button that opens the upload in a dialog. The grid is a generic component the photo library
  (next issue) reuses.

All existing behaviour stays: live updates through Realtime, the preview player wrapper and its
clock, Export, changes, versions and going back, Retry, the error disclosure, percent and time left,
"Notify me when ready", the waiting and offline lines, the refusal message.

## User Story

As the studio owner
I want the reel page to look and fit like a phone video editor, with the timeline of my reel visible
and the reels shown as thumbnails
So that I can watch, compare versions and ask for corrections on one screen, on my laptop or my
phone, without scrolling, and find a reel by its picture

## Problem Statement

The reel page needs page scroll to reach the change box, versions and status; there is no view of
what the edit contains over time (captions, accents, transitions, sounds), so the owner cannot see
where things sit before asking for a correction; versions can only be compared by restoring them;
and the reels list gives no picture of each reel. A mobile app is planned, so the phone layout must
be equal to the desktop one from the start, not an afterthought.

## Solution Statement

- Dark theme tokens in `apps/studio/src/app/globals.css` (Tailwind v4 `@theme`), the whole studio
  switched to them, `color-scheme: dark`.
- One responsive layout component (`ReelScreen`) with CSS-only desktop and phone arrangements
  (Tailwind `lg:` breakpoint, 1024 px) and a small tab state for the phone; the page container is
  exactly the dynamic viewport height (`h-dvh`) with `min-h-0` flex children and `overflow-y-auto`
  only on the list areas. No JavaScript measures the window.
- `LiveReel` keeps all its state and Realtime wiring and now composes `ReelScreen`. Jobs, steps and
  the status list move unchanged (same test ids) into an extracted `StatusPanel`.
- The shown version is a page-level selection held in `LiveReel` (derived during render, defaulting
  to `current_version_id` and following it when Realtime moves it). `loadPreviewSources` gains an
  optional `versionId` (read under RLS and checked to belong to the reel), so the preview and the
  timeline show the selected version. Undo and Redo change the selection only.
- A pure helper (`lib/tracks-timeline.ts`) turns the parsed edit and transcript into rows through
  `resolveTimeline`; `ReelPreview` computes it from the edit it already builds (no second fetch, one
  builder) and renders `TracksTimeline` beside the player, fed by the player's clock through a new
  `onPosition` callback on `PreviewPlayer`.
- The `preview_copies` step (version 2 -> 3) also writes `thumbnail.jpg` (one frame) and
  `frames.jpg` (a one-row sprite of small frames every 2 s), both `kept`, both from the retimed
  footage the step already has. `previewCopiesRefs` records them in `reels.preview_copies` with the
  sprite layout; the studio narrows them as optional (old reels show a neutral tile and a plain
  footage bar). No migration: the column is already "null or an object".
- The home page selects the reels with their size, `preview_copies` and the current version's
  `r2_key` (server only), derives each thumbnail's key the same way the preview derives its keys
  (from the version key's prefix), signs it, and renders `ThumbnailGrid`.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`: repository rules (Yarn only, no em-dashes, measure from the root box,
  one feature doc per feature, a user-visible change extends an E2E spec).
- `.adw/project.md`: the ADW profile; its Review section says "The studio pages may scroll", which
  this feature changes for the reel page (update it in the same change, keep the nine headings).
- `docs/conditional-docs.md`: the docs index; the studio and preview lines get the new triggers.
- `app_docs/studio.md`: studio layout and Rules (gets the one-screen rule, the layout, the grid).
- `app_docs/preview.md`: preview player, clock, sources (gets the playhead, the timeline, the
  selected version, the frames sprite). Its Rules (one builder, never poll, never store the built
  page, test hooks only under webdriver, wrap the player never patch it) are invariants here.
- `app_docs/change-requests.md`: the versions list and going back (Undo and Redo sit next to it and
  must not create versions).
- `app_docs/pipeline.md`: the `preview_copies` step, its outputs, `fixtures/pipeline/` and the rule
  "Bump a step's version whenever its behaviour changes, then re-run `fixtures:pipeline`".
- `app_docs/export.md`, `app_docs/status.md`, `app_docs/failures.md`: Export, progress, Retry and the
  waiting and offline lines, which move into the new layout unchanged.
- `app_docs/edit-model.md`: `resolveTimeline` and the edit's tracks.
- `apps/studio/src/app/globals.css`: today a light body colour only; becomes the theme tokens.
- `apps/studio/src/app/layout.tsx`: wraps every page in `max-w-2xl py-10`; becomes a bare dark
  body so each page owns its container.
- `apps/studio/src/app/page.tsx`: reels list; becomes the grid page with **+**.
- `apps/studio/src/app/reels/[id]/page.tsx`: reel page; keeps its server reads, drops its own h1 and
  back link (they move into the layout's header inside `LiveReel`).
- `apps/studio/src/app/not-found.tsx`: keeps working in the dark theme (centred column).
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId)` gains an optional
  `versionId` and returns the frames URL.
- `apps/studio/src/lib/preview-sources.ts`: `parsePreviewCopies`, `previewKeys`, `cachePrefixOf`;
  extended for `thumbnail`, `frames` and the frames layout.
- `apps/studio/src/lib/reels.ts`: column lists, `formatBytes`, `formatCreatedAt`; gets `formatAge`
  and the grid's column list.
- `apps/studio/src/lib/versions.ts`: `VersionListRow`; gets the previous and next helpers (or a new
  `lib/version-steps.ts`, see New Files).
- `apps/studio/src/components/LiveReel.tsx`: all live state; composes the new layout, holds the
  shown-version selection.
- `apps/studio/src/components/ReelPreview.tsx`: loads and builds the preview; gains the selected
  version, the timeline rows and the frames URL.
- `apps/studio/src/components/PreviewPlayer.tsx`: the clock wrapper; gains `onPosition`, a
  `controls` slot for Undo and Redo, and the `00:00 / 00:52` clock format. Its hold-then-start
  routine is not touched.
- `apps/studio/src/components/VersionList.tsx`: marks the shown version (`data-selected`).
- `apps/studio/src/components/ExportPanel.tsx`, `ChangeRequestForm.tsx`, `NotifyToggle.tsx`,
  `RetryButton.tsx`, `LoginForm.tsx`, `NotConfigured.tsx`, `SignOutButton.tsx`, `UploadForm.tsx`:
  restyled to the tokens; behaviour, labels and test ids unchanged.
- `apps/studio/src/components/ReelList.tsx`: replaced by the grid (delete it; knip).
- `packages/edit/src/timeline.ts`, `packages/edit/src/index.ts`, `packages/edit/src/layout.ts`
  (`wordsText`): read only; `resolveTimeline` and `ResolvedItem` are already exported.
- `apps/worker/src/pipeline/preview-copies.ts`, `preview-copies.test.ts`: the step that gains the two
  image outputs.
- `apps/worker/src/preview-copies-record.ts`, `preview-copies-record.test.ts`: the refs recorded on
  the reel.
- `apps/worker/src/pipeline/definition.ts`, `definition.test.ts`, `pipeline-fixtures.test.ts`,
  `run-pipeline.test.ts`, `stored-files.test.ts`: output lists and retention that the new outputs
  flow through.
- `apps/worker/src/make-pipeline-fixtures.ts`, `fixtures/pipeline/`: regenerated for the new step
  version.
- `apps/studio/e2e/reels.spec.ts`: extended for the grid.
- `apps/studio/e2e/preview.spec.ts`: the CDN routing the new spec reuses; must keep passing.
- `apps/studio/e2e/upload.spec.ts`, `multipart-upload.spec.ts`, `footage-refusal.spec.ts`: open the
  upload through **+** now; `upload.spec.ts` also lists the `preview_copies` outputs and their
  `stored_files` rows.
- `apps/studio/e2e/change-requests.spec.ts`, `export.spec.ts`, `progress.spec.ts`,
  `notification.spec.ts`, `step-log.spec.ts`, `retry.spec.ts`, `waiting-ai.spec.ts`,
  `worker-offline.spec.ts`, `disk-guard.spec.ts`, `crash-resume.spec.ts`: run at 1920x1080 (desktop
  layout, everything visible); must keep passing unchanged.
- `apps/studio/test-support/pipeline-cache.ts`, `test-support/versions.ts`,
  `test-support/fixtures.ts`: `seedProcessedReel`, `saveTestVersion`, `insertReel` used by the new
  specs (`insertReel` gains an optional `sourceBytes`).
- `apps/studio/playwright.config.ts`: default viewport 1920x1080; the new spec sets its own sizes.
- `node_modules/next/dist/docs/`: read the App Router guides on layouts and `<dialog>`-free client
  components before Next.js work (AGENTS.md).

### New Files

- `apps/studio/src/components/ReelScreen.tsx`: the one responsive layout (header, main, footer,
  side panel; desktop columns, phone tabs Edit, Versions, Status).
- `apps/studio/src/components/StatusPanel.tsx`: the status list, `NotifyToggle`, Jobs and Steps
  moved out of `LiveReel` unchanged (markup, test ids, `StepProgress`).
- `apps/studio/src/components/TracksTimeline.tsx`: the read-only ruler, track rows and playhead.
- `apps/studio/src/components/ThumbnailGrid.tsx`: the reusable vertical-thumbnail grid.
- `apps/studio/src/components/UploadDialog.tsx`: the round **+** button and the native `<dialog>`
  that keeps `UploadForm` mounted.
- `apps/studio/src/lib/tracks-timeline.ts` and `tracks-timeline.test.ts`: rows, ruler ticks, clock
  format, footage frame index.
- `apps/studio/src/lib/version-steps.ts` and `version-steps.test.ts`: previous and next version,
  and the shown-version derivation.
- `apps/studio/e2e/reel-layout.spec.ts`: one-screen layout at two sizes, tabs, tracks, playhead,
  Undo and Redo.

## Implementation Plan

### Phase 1: Foundation

- Theme tokens and a bare dark root layout; every existing component restyled to the tokens with
  labels, roles and test ids unchanged.
- Pure helpers with unit tests: `formatAge`, `formatClock`, `timelineRows`, `rulerTicks`,
  `frameIndexAt`, `previousVersionId`, `nextVersionId`, `shownVersionId`, the extended
  `parsePreviewCopies` and `thumbnailKey`.
- Worker: `preview_copies` version 3 with `thumbnail.jpg` and `frames.jpg`, the refs recorded,
  fixtures regenerated.

### Phase 2: Core Implementation

- `ReelScreen` layout and `StatusPanel` extraction; `LiveReel` composed on them.
- `loadPreviewSources(reelId, versionId?)`; `ReelPreview` builds the timeline rows from the same
  parsed edit; `PreviewPlayer` reports its clock and hosts Undo and Redo in its control row;
  `TracksTimeline` renders rows, frames and playhead.
- `ThumbnailGrid`, `UploadDialog` and the new home page.

### Phase 3: Integration

- Existing E2E specs adapted only where the upload moved behind **+** and where the list's date
  became an age; the new layout spec and the extended reels spec.
- Docs (`studio.md`, `preview.md`, `pipeline.md`, `change-requests.md` mention of Undo and Redo,
  `conditional-docs.md`), the profile's Review section.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md`, `app_docs/preview.md`, `app_docs/change-requests.md`,
  `app_docs/pipeline.md`, `app_docs/export.md`, `app_docs/status.md` (Rules sections are
  invariants) and the App Router layout guide under `node_modules/next/dist/docs/`.
- Read `apps/studio/e2e/preview.spec.ts` to see how it routes the two jsdelivr scripts and waits
  for `data-preview="ready"`; the new spec reuses that.

### 2. Worker: thumbnail and frames from the preview copy

- In `apps/worker/src/pipeline/preview-copies.ts`:
  - Bump `PREVIEW_VERSION` to 3 with a comment (`3: also a thumbnail and a frames sprite`).
  - Export `THUMBNAIL_FILE = "thumbnail.jpg"`, `FRAMES_FILE = "frames.jpg"` and
    `FOOTAGE_FRAMES = { everySeconds: 2, columns: 32, width: 90, height: 160 }` (32 frames cover
    64 s; a longer reel's later frames are simply absent). Put the thumbnail size
    (`{ width: 270, height: 480 }`) and `FOOTAGE_FRAMES` into the step's `settings` so they are
    part of its fingerprint.
  - `thumbnailArgs(input, output, settings)`: one JPEG, `-vf thumbnail=30,scale=270:480`,
    `-frames:v 1`, `-q:v 4`, no audio. `framesArgs(input, output, settings)`:
    `-vf fps=1/2,scale=90:160,tile=32x1` (built from the settings, not literals), `-frames:v 1`,
    `-q:v 5`, no audio. Both read the step's existing `source.mp4` input (the retimed footage, the
    same file the preview copy is made from, so frame times equal preview times).
  - `outputs`: add both files with `retention: "kept"`; `run` writes each to a `.part.jpg` and
    renames, like the footage copy.
- `apps/worker/src/pipeline/preview-copies.test.ts`: assert the new argument lists, the three
  outputs, all kept, and that the version is 3.
- `apps/worker/src/preview-copies-record.ts`: `previewCopiesRefs` returns
  `{ footage, thumbnail, frames, frames_layout: FOOTAGE_FRAMES }` (refs with `step: "preview_copies"`
  and the step's fingerprint). Update `preview-copies-record.test.ts`.
- Fix any worker test that lists the step's outputs (`definition.test.ts`, `run-pipeline.test.ts`,
  `stored-files.test.ts`) to the new list.
- Regenerate the fixtures: `yarn workspace @edit-issebya/worker fixtures:pipeline`. Then
  `git status fixtures/pipeline`: only `fixtures/pipeline/preview_copies/` and the manifest's
  `preview_copies` entry may change. If another step's committed file changed bytes (its
  fingerprint is unchanged, so it must not), put it back with `git restore <path>` so the
  committed goldens stay valid. `pipeline-fixtures.test.ts` must pass.

### 3. Studio: preview copies, keys and the selected version on the server

- `apps/studio/src/lib/preview-sources.ts`:
  - `PreviewCopies` becomes `{ footage: EditRef; thumbnail: EditRef | null; frames: { ref: EditRef;
everySeconds: number; columns: number; width: number; height: number } | null }`.
    `parsePreviewCopies` narrows the two new parts as optional (a malformed or missing one is
    `null`, never a failure), still ignoring an old `cutout`.
  - `PreviewKeys` gains `frames: string | null` (`cacheKeyOf(prefix, frames.ref, "preview_copies")`).
  - New `thumbnailKey({ r2Key, reelId, versionId, previewCopies })`: the thumbnail's cache key
    through `cachePrefixOf` and `cacheKeyOf`, or `null`.
  - Extend `preview-sources.test.ts`: new parts parsed, bad parts dropped to `null`, an old value
    (footage only) still parses, keys built and malformed refs refused.
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId, versionId?: string | null)`.
  When `versionId` is given it must pass `isReelId` (UUID) and the version is read with
  `.eq("id", versionId).eq("reel_id", reelId)` under RLS (another reel's or another owner's version
  reads as nothing: `failed`); when absent, today's `current_version_id`. Sign `frames` too when
  present (`urls.frames: string | null`). Keep every existing status.

### 4. Studio: pure helpers

- `apps/studio/src/lib/reels.ts`: `formatAge(createdIso, now)`: under a minute `now`, then `5m`,
  `3h`, `2d`, `1w` (7 to 29 days, whole weeks), `3mo` (30 to 364 days, 30-day months), `1y`.
  `REEL_GRID_COLUMNS` = `REEL_COLUMNS` plus `source_bytes, preview_copies,
current_version:versions!current_version_id(r2_key)` (the embed hint names the FK column, since
  `versions.reel_id` is a second relation). Add a `ReelGridRow` type. Unit tests for `formatAge`
  (every boundary) in `reels.test.ts`, and `formatBytes(65_221_017)` = `62.2 MB`.
- `apps/studio/src/lib/tracks-timeline.ts`:
  - `TRACK_ROWS`: `footage` (Footage), `captions` (Captions), `overlays` (Accents), `transitions`
    (Transitions), `sounds` (Sounds), in that order. A legacy `cutout` track is never shown.
  - `timelineRows(edit, transcript)`: `{ duration, rows: { key, label, items: { id, start, end,
label }[] }[] }` from `resolveTimeline(edit, transcript)`; item labels: footage the clip's
    length (`formatClock(end - start)`), captions and word-based accents the words' text (through
    `wordsText` or the transcript words), text accents their text, transitions their type, sounds
    their sound key. Every row is present even when empty.
  - `formatClock(seconds)`: `mm:ss`, floored, never negative (`52.4` -> `00:52`, `0` -> `00:00`).
  - `rulerTicks(duration)`: whole-second ticks with a label every 5 s (every 10 s past 60 s).
  - `frameIndexAt(footageSeconds, layout)`: `floor(t / everySeconds)` clamped to
    `[0, columns - 1]`. A footage clip's frame at reel time `t` uses footage time `t - clip.start`
    (the builder writes no media offset, so each clip plays its file from 0).
  - `tracks-timeline.test.ts`: rows and spans for the committed version 1 golden edit and the
    `short-speech` transcript (read from `packages/edit/src/testdata/` or the fixture the edit
    tests use) equal `resolveTimeline`'s values; empty rows kept; clock, ticks and frame index edge
    cases.
- `apps/studio/src/lib/version-steps.ts`:
  - `previousVersionId(versions, shownId)` and `nextVersionId(versions, shownId)` by `number`
    (`null` at either end or when `shownId` is unknown).
  - `shownVersionId(selection, currentId)`: the selection is `{ id, forCurrent }`; it applies only
    while `forCurrent === currentId`, otherwise the current version is shown. This derives the
    shown version during render, so a new current version (Realtime) resets the view with no
    effect that sets state.
  - `version-steps.test.ts`: ends, gaps in numbering, unknown id, selection dropped when current
    moves.

### 5. Theme and root layout

- `apps/studio/src/app/globals.css`: `color-scheme: dark`; a Tailwind v4 `@theme` block with
  tokens: `--color-surface` (page), `--color-panel`, `--color-raised`, `--color-line`,
  `--color-ink`, `--color-muted` (at least 4.5:1 on panel), `--color-accent`, `--color-danger`,
  `--color-warn`, and one colour per track (`--color-track-footage`, `-captions`, `-accents`,
  `-transitions`, `-sounds`). A global `:focus-visible` outline in the accent colour, and
  `@media (prefers-reduced-motion: reduce)` turning transitions and animations off.
- `apps/studio/src/app/layout.tsx`: body `bg-surface text-ink`, no wrapping `max-w-2xl` main;
  pages set their own container. Login, not-configured and not-found pages render in a centred
  narrow column (`mx-auto max-w-md px-4 py-10`) so they look as before, dark.
- Restyle `LoginForm`, `NotConfigured`, `SignOutButton`, `ExportPanel`, `ChangeRequestForm`,
  `NotifyToggle`, `RetryButton`, `UploadForm`, `VersionList` from `stone-*` to the tokens. Change no
  text, label, role, `id` or `data-testid`.

### 6. Reel screen layout and status panel

- `StatusPanel.tsx`: move the `dl` (Status `reel-status`, Size, Created), `NotifyToggle`, the Jobs
  section and the Steps section with `StepProgress` out of `LiveReel` verbatim (props: reel, jobs,
  steps, versionsById, retryable ids, waiting reason, offline, estimate rates). Headings become
  compact (`text-sm font-semibold`) but keep their text and ids.
- `ReelScreen.tsx` (client, for the phone tab state): props `header`, `main`, `footer`,
  `versions`, `status` (React nodes). Structure:
  - Root `flex h-dvh flex-col overflow-hidden` is not allowed to hide real overflow: every child
    that can grow is `min-h-0` and the list areas (`versions`, `status`, the phone tab panels) are
    `overflow-y-auto overscroll-contain`. The test asserts the document does not scroll AND that
    Send and Export sit inside the root box, so clipping cannot fake a pass.
  - Desktop (`lg:`): header row; below it a two-column grid `grid-cols-[minmax(0,1fr)_22rem]`
    (`xl:` 26rem): left column main (flex column: preview area `min-h-0 flex-1`, timeline, footer
    with the correction field), right column the side panel split in two stacked areas, Versions
    (`flex-1 min-h-0 overflow-y-auto`) and Status (`flex-1 min-h-0 overflow-y-auto`), both visible.
  - Phone: header; a tab list (`role="tablist"`, `aria-label="Reel"`) with three `role="tab"`
    buttons Edit, Versions, Status (`aria-selected`, `aria-controls`, arrow-key roving per WAI-ARIA
    tabs); three `role="tabpanel"` areas of which only the selected one shows (`hidden` attribute
    below `lg`, all shown at `lg:` through `lg:!flex`-style classes); the footer (correction
    field) always visible under the panels.
  - The tab list is `lg:hidden`; on desktop the panels carry no tab semantics conflict (render
    `role="tabpanel"` only below `lg` by giving the panel wrappers `aria-labelledby` only when the
    tab list is shown, or render tab semantics unconditionally and keep the tab list in the DOM
    hidden; pick one and keep axe-clean roles). Tab switch has no animation.
- `LiveReel.tsx`: keep every state, effect and the Realtime channel exactly; compose
  `ReelScreen` with:
  - header: `Link` "Back to your reels" (icon plus visible text, or `aria-label`), `h1` with
    `reelName(reel)` (moved here from `page.tsx`, still level 1), `ExportPanel` on the right.
  - main: the refusal alert, then `ReelPreview` with `reelId`, `versionId={shownId}`, the
    controls (Undo, Redo) and the versions for labels.
  - footer: `ChangeRequestForm` (same props).
  - versions: `VersionList` with `selectedVersionId={shownId}`.
  - status: `StatusPanel`.
  - Selection state: `const [selection, setSelection] = useState<{ id: string; forCurrent: string |
null } | null>(null)`; `shownId = shownVersionId(selection, reel.current_version_id)`. Undo sets
    `{ id: previousVersionId(versions, shownId), forCurrent: reel.current_version_id }`, Redo the
    next. Both are `<button type="button">` with visible labels or `aria-label` "Undo" and "Redo",
    disabled at the ends and while there is no version. They never call a server action.
  - Keep `data-realtime` on the root element.
- `apps/studio/src/app/reels/[id]/page.tsx`: drop the `article`, the back `Link` and the `h1` (now
  in `LiveReel`); keep every read.
- `VersionList.tsx`: prop `selectedVersionId`; the shown item gets `data-selected="true"` and a
  small "showing" label (`data-testid="version-showing"`) when it is not the current one. Nothing
  else changes (going back still queues a `restore`).

### 7. Preview, player clock and tracks timeline

- `PreviewPlayer.tsx`:
  - New optional props `onPosition?: (seconds: number) => void` and `onDuration?: (seconds:
number) => void`, called from the existing `timeupdate`, `ready`, seek and `holdThenStart`
    paths where `setPosition` and `setDuration` already run (call them in those event handlers,
    not from an effect that watches state). Keep a ref to the latest callbacks.
  - New optional `controls?: ReactNode` rendered at the end of the control row (Undo and Redo).
  - The time display becomes `formatClock(position) / formatClock(duration)`
    (`data-testid="preview-clock"`). Keep the Play/Pause button names, the `Position` slider and its
    label, `data-preview`, `data-preview-version` and the `Loading` status exactly.
  - The 9:16 box sizes by the available height: the wrapper is `flex min-h-0 flex-1 flex-col`, the
    box `aspect-[9/16] h-full max-h-full max-w-full self-center` so a tall phone and a wide desktop
    both fit without scroll. Do not change the hold-then-start routine, the stall watching or the
    sound scheduling.
- `ReelPreview.tsx`:
  - Prop `versionId` (the shown one) replaces `currentVersionId`; `loadPreview(reelId, versionId)`
    passes it to `loadPreviewSources`. A load overtaken by a newer selection is dropped as today.
    `studio_preview_opened` stays once per mount.
  - `Built` gains `timeline` (`timelineRows(edit, transcript)` from the edit and transcript it
    already parsed: no second fetch, no second builder) and `frames` (signed URL plus layout, or
    `null`).
  - Holds `position` and `duration` state set only from the player's callbacks, and renders
    `TracksTimeline` under the player with `rows`, `duration` (the edit's), `position`, `frames`.
  - The visible `h2` "Preview" may become visually hidden (`sr-only`) but stays in the DOM.
- `TracksTimeline.tsx`:
  - `<section aria-label="Tracks" data-testid="tracks">`: a ruler (`rulerTicks`), one row per
    `TRACK_ROWS` entry with a visible row label and `data-track="<key>"`, items absolutely placed
    by percentage (`left = start / duration`, `width = (end - start) / duration`, a minimum visible
    width of 2 px) with `data-testid="track-item"`, `data-item-id`, `data-start`, `data-end` (3
    decimals) and a `title` with the label and the span.
  - Footage items: a frame strip. The row's width is read from the row element with a
    `ResizeObserver` (the element's own box, never the window), tiles are `rowHeight * 9 / 16`
    wide, each tile's frame is `frameIndexAt(tileCentreTime - clip.start, layout)` shown as a
    CSS background from the sprite (`background-size: columns * tileWidth px auto`,
    `background-position: -index * tileWidth px 0`). Without frames, a plain bar in the footage
    colour. The clip's length label sits over the strip.
  - Playhead: one absolutely placed line, `data-testid="playhead"`, `data-seconds` (3 decimals),
    moved with `transform: translateX(...)` per position update, no CSS transition (and none under
    reduced motion either). `aria-hidden="true"`; the clock text already reads the time.
  - Read-only: no `button`, `a`, `input`, no `tabindex`, no pointer or drag handlers, no
    `role="slider"`; `select-none`. The whole reel fits the row width (no horizontal scroll).
  - Fits one screen: row height about 20 px, footage row about 36 px; six rows plus the ruler under
    about 190 px.

### 8. Reels grid, upload dialog, home page

- `ThumbnailGrid.tsx` (no `"use client"`, usable from server or client): props `label` (the list's
  accessible name), `items: { id, href, title, imageUrl: string | null, meta: string, badge?:
string }[]`, `empty: ReactNode`. Renders `<ul aria-label={label}>` with
  `grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8`, each `li`
  a `next/link` tile `aspect-[9/16]` with the image (`<img alt="" loading="lazy">`, with an
  eslint-disable line explaining that the URL is a short-lived signed storage URL, never a Next
  image) or a neutral tile (`data-thumbnail="none"`), and under or over it the title, the meta
  (`data-testid="tile-meta"`) and the optional badge (status, keep `data-testid="reel-list-status"`
  for reels by passing it through). Nothing reel-specific inside: the photo library reuses it.
- `UploadDialog.tsx` (client): a round button `aria-label="Upload a reel"` showing **+**, fixed at
  the grid area's bottom right (respecting `env(safe-area-inset-bottom)`), and a native `<dialog>`
  (opened with `showModal()` in the click handler, closed with a Close button and Escape)
  containing a heading "Upload a reel" and `UploadForm`. The `<dialog>` stays in the DOM when
  closed so an upload in progress is never unmounted (Uppy closes on unmount).
- `apps/studio/src/app/page.tsx` signed in: `h-dvh flex flex-col`: header (title "Your reels",
  email, sign out), the grid area `min-h-0 flex-1 overflow-y-auto`, `UploadDialog`. Query
  `REEL_GRID_COLUMNS` (RLS only, newest first, as today). For each row: `thumbnailKey` from the
  current version's `r2_key`, the reel id, the version id and `parsePreviewCopies`, signed with
  `studioStorage()?.signDownload(key, { expiresInSeconds: 3600 })` in one `Promise.all`; a signing
  failure leaves that tile neutral (log, never throw the page). Never pass `r2_key` to a client
  component. Meta: `${formatAge(created_at, now)} · ${formatBytes(source_bytes)}`; `<time
dateTime>` keeps the full `formatCreatedAt` as its `title`.
- Delete `ReelList.tsx`.

### 9. E2E: adapt the specs the move touches

- `upload.spec.ts`, `multipart-upload.spec.ts`, `footage-refusal.spec.ts`: click
  `getByRole("button", { name: "Upload a reel" })` before using `getByLabel("Clip")` (and before
  the visibility check at `multipart-upload.spec.ts:110`). In `upload.spec.ts`, add
  `thumbnail.jpg` and `frames.jpg` wherever the `preview_copies` outputs and their `stored_files`
  rows (kind, step, size) are listed, and assert `reels.preview_copies` now names `thumbnail`,
  `frames` and `frames_layout`.
- `reels.spec.ts`: see step 10.
- Run the remaining studio specs unchanged at 1920x1080; if one fails, fix the layout, not the
  spec, unless the spec read something this feature deliberately changed (only the list's date
  and the upload's location are).

### 10. E2E: new and extended specs (fail without the feature)

- `apps/studio/test-support/fixtures.ts`: `insertReel` gains an optional `sourceBytes`.
- Extend `apps/studio/e2e/reels.spec.ts`:
  - Insert the two reels with `createdAt` relative to now (8 days ago and 2 hours ago) and
    `sourceBytes: 65_221_017` on the older one. Tiles (`list` "Reels" > `listitem`): two, newest
    first, the older one's `tile-meta` is `1w · 62.2 MB`, the newer `2h · Unknown size`, status
    badge `received`; a reel without preview copies shows `data-thumbnail="none"`.
  - Seed one processed reel (`seedProcessedReel`, like `export.spec.ts`) for the same owner: its
    tile has an `img` whose request answers 200 with an `image/jpeg` body.
  - At 390x844 the grid has 3 columns: the first three tiles share a top edge and the fourth
    starts a new row (bounding boxes).
  - **+** (`Upload a reel`) opens the dialog: `getByLabel("Clip")` becomes visible, Close hides
    it. Opening a tile still goes to the reel page (existing assertion kept).
- New `apps/studio/e2e/reel-layout.spec.ts` (chromium, own owner and prefix, cleanup like
  `export.spec.ts`; route the jsdelivr scripts as `preview.spec.ts` does, moving that routing into
  `test-support/preview-routes.ts` if it is inline, and using it from both specs):
  - Setup: `seedProcessedReel` (versions 1 and 2), then 12 `saveTestVersion` calls with the
    current edit (read from the storage double) so there are 14 versions, then 40 extra `steps`
    rows and 8 extra `jobs` rows (`done`) inserted as the admin for the reel.
  - "one screen at 1440x900": `page.setViewportSize({ width: 1440, height: 900 })`, open the reel,
    wait for `data-realtime="ready"` and `data-preview="ready"`. Assert
    `document.documentElement.scrollHeight === document.documentElement.clientHeight` and
    `document.body.scrollHeight <= document.documentElement.clientHeight`; the Send button's and
    the Export button's bounding boxes lie within `document.documentElement.getBoundingClientRect()`;
    the versions list area and the steps area each have `scrollHeight > clientHeight` and computed
    `overflow-y` `auto`; scrolling the versions area (`el.scrollTop = el.scrollHeight`) leaves
    `document.scrollingElement.scrollTop` at 0. Versions and Status are both visible, no tab list
    visible.
  - "one screen at 390x844 with tabs": same no-scroll and inside-root checks; the tab list shows
    Edit selected and the preview visible, the version items hidden; clicking Versions shows
    `version-item`s and hides the preview; clicking Status shows `step-line`s; the correction
    field stays visible on all three tabs.
  - "tracks": at 1440x900, read the current version's edit and the transcript from the storage
    double, compute `resolveTimeline` in the spec, and assert every `track-item`'s
    `data-start`/`data-end` equals it (to the millisecond) in the row of its track; rows
    `footage`, `captions`, `overlays`, `transitions`, `sounds` present in that order; the first
    caption's left edge sits at `start / duration` of the row width within 2 px; the footage item
    has a background image from the `frames.jpg` URL; the tracks section contains no element
    matching `a, button, input, select, textarea, [tabindex], [contenteditable], [draggable=true]`.
  - "playhead": `playhead` `data-seconds` is `0.000`; press Play; poll until it exceeds 0.5 and
    its `transform` changed; press Pause; it stops changing.
  - "undo and redo": the newest version is current and shown; Redo disabled; Undo -> the item
    for the previous number has `data-selected="true"` and `data-preview-version` equals its id
    (preview rebuilt); Redo -> back to the newest; Undo to version 1 -> Undo disabled. Afterwards
    the reel's versions count and jobs count in the database are unchanged and
    `current_version_id` is still the newest (nothing edited).

### 11. Profile and documentation

- `.adw/project.md`, Review section: the studio reel page now never scrolls as a page; studio
  captures are the grid and the reel page at 1440x900 and 390x844 (plus the existing 1920x1080),
  viewport-sized, and the phone captures include each tab. Keep the nine `##` headings and their
  order. Tests section: name `reel-layout.spec.ts` in the studio suite's list.
- `app_docs/studio.md`: a "Layout and theme" subsection (tokens, `ReelScreen` desktop and phone
  arrangements, side panel holding Versions and Status and later the photo library, tabs Edit,
  Versions, Status, the pinned correction field and header Export, `StatusPanel`), the reels grid
  (`ThumbnailGrid`, age and size, thumbnails signed from `preview_copies.thumbnail`, `UploadDialog`),
  testing lines for `reel-layout.spec.ts` and the extended `reels.spec.ts`, and in Rules: "The reel
  page never scrolls as a page; lists scroll inside their own area." and "Do not make the tracks
  timeline editable: no focusable, selectable or draggable element in it."
- `app_docs/preview.md`: the selected version (`loadPreviewSources(reelId, versionId)`, Undo and
  Redo change only what is shown), `onPosition` and the playhead, `TracksTimeline` and
  `timelineRows` through `resolveTimeline`, the frames sprite and `frames_layout`, the clock format.
  Rules: "Undo and Redo never create a version or queue a job." Update the Notes' out-of-scope line
  (a read-only timeline now exists; editing does not).
- `app_docs/pipeline.md`: `preview_copies` version 3 with `thumbnail.jpg` and `frames.jpg` (both
  kept, sizes, sprite layout), the recorded refs, fixtures regenerated.
- `app_docs/change-requests.md`: one line that Undo and Redo sit beside the versions and only
  change the shown version.
- `docs/conditional-docs.md`: studio line adds "the studio layout, theme tokens, `ReelScreen`, the
  reels grid or `ThumbnailGrid`, the upload dialog"; preview line adds "the tracks timeline, the
  playhead, Undo and Redo, `reel-layout.spec.ts`"; pipeline line adds "the thumbnail or frames
  sprite".
- No em-dashes anywhere; no AI attribution in any file, commit or PR.

### 12. Validation

- Run every command in `Validation Commands` and fix anything that fails. Review screenshots
  (review phase) at 1440x900 and 390x844 must show no page scrollbar.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/tracks-timeline.test.ts`: `timelineRows` against a committed edit and
  transcript (spans equal `resolveTimeline`, order of rows, empty rows kept, labels, no cut-out
  row), `formatClock`, `rulerTicks`, `frameIndexAt`.
- `apps/studio/src/lib/version-steps.test.ts`: previous and next by number, ends, unknown id,
  `shownVersionId` dropping a selection made for an older current version.
- `apps/studio/src/lib/reels.test.ts`: `formatAge` at each unit boundary, the issue's
  `62.2 MB` example.
- `apps/studio/src/lib/preview-sources.test.ts`: the new optional parts, `frames` key,
  `thumbnailKey`, old values still parsing.
- `apps/worker/src/pipeline/preview-copies.test.ts`, `apps/worker/src/preview-copies-record.test.ts`:
  the new arguments, outputs, version and refs; `pipeline-fixtures.test.ts` proves the fixtures
  were regenerated.

### Test Coverage

- E2E `apps/studio/e2e/reel-layout.spec.ts`, "one screen at 1440x900" and "at 390x844 with tabs":
  catches page scroll on the reel page and lists that do not scroll in their own area; fails today
  (the page is a long scrolling column with no tabs).
- E2E `reel-layout.spec.ts`, "tracks" and "playhead": catches a missing or mis-timed track row, a
  focusable control inside the timeline and a playhead not following the clock; fails today (no
  timeline).
- E2E `reel-layout.spec.ts`, "undo and redo": catches Undo or Redo showing the wrong version or
  writing anything; fails today (no such buttons).
- E2E `apps/studio/e2e/reels.spec.ts` (extended): catches a missing tile, wrong age or size, a
  missing thumbnail, fewer than 3 columns on a phone and a **+** that does not open the upload;
  fails today (a text list).
- E2E `apps/studio/e2e/upload.spec.ts` (extended): catches the thumbnail and frames outputs not
  being stored, recorded or tracked in `stored_files`.
- Unit `tracks-timeline.test.ts`, `version-steps.test.ts`, `reels.test.ts`,
  `preview-sources.test.ts`, worker `preview-copies*.test.ts`: the pure rules above, cheaper than
  the browser and failing without the new helpers.
- No DB test needed: no migration, no policy or grant change (`reels.preview_copies` stays
  worker-written and owner-readable; its check is unchanged).

### Edge Cases

- A reel with no version yet (uploading, processing, refused): the layout still fits, the timeline
  area shows the preview's waiting message, Undo and Redo disabled, the grid tile neutral.
- An old reel whose `preview_copies` has only `footage` (or a legacy `cutout`): preview works,
  footage row is a plain bar, grid tile neutral.
- A reel longer than 64 s: frames past the sprite repeat the last tile index (clamped), no error.
- A footage clip that does not start at 0, or several clips: frames use `t - clip.start`.
- Items of zero or tiny length: still at least 2 px wide and at the right left edge.
- A new current version arrives through Realtime while the owner shows an older one: the view
  switches to the new current version (selection dropped), the preview rebuilds once.
- Undo pressed twice quickly: the earlier preview load is dropped (stale guard), the newest wins.
- `versionId` of another reel or another owner sent to `loadPreviewSources`: `failed`, nothing
  signed.
- Storage not configured on the home page: tiles neutral, page renders.
- Phone landscape or a short desktop window (for example 1280x600): still no page scroll; the
  preview shrinks.
- Keyboard: tabs reachable and arrow-key switchable, Undo, Redo, Play, Send, Export and **+** show a
  visible focus ring; the timeline takes no focus. Reduced motion: no transitions on tabs,
  playhead or dialog.
- The upload dialog closed during an upload: the upload continues (form stays mounted) and the
  reel page opens when it finishes, as today.

## Acceptance Criteria

- At 1440x900 and 390x844 the reel page's `document.documentElement.scrollHeight` equals its
  `clientHeight` for a reel with 14 versions and 48 steps; versions and steps scroll in their own
  areas; Send and Export are inside the root box on both sizes.
- Desktop shows preview, control row, timeline, correction field and a right side panel with
  Versions and Status at once; the phone shows tabs Edit, Versions and Status that switch content,
  with the correction field and Export always visible.
- The control row shows Play or Pause, `mm:ss / mm:ss`, Undo and Redo (real buttons); Undo and Redo
  show the previous and next saved version and never create a version or a job.
- The tracks timeline shows rows Footage, Captions, Accents, Transitions, Sounds with items at
  `resolveTimeline`'s times, footage frames from the preview copy's sprite, a playhead following
  the player's clock, and no focusable or draggable element.
- The reels list is a grid of 9:16 tiles (3 columns at 390 px, more on wider screens), each with
  its thumbnail or a neutral tile, `age · size` and status; **+** opens the upload.
- `preview_copies` is version 3 with `thumbnail.jpg` and `frames.jpg` kept, recorded on the reel,
  tracked in `stored_files`; `fixtures/pipeline/` regenerated with only `preview_copies` changed.
- All existing studio specs pass unchanged except the documented upload and list adaptations.
- Docs and the profile updated; the new Rules lines present; no em-dashes; no AI attribution.
- Lint, typecheck, knip, format, unit, build, DB, E2E and CI green.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check` - Prettier over the whole repository (write with `yarn format` first).
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker` - ESLint for both changed
  workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker` - `next typegen` and
  `tsc --noEmit` for the studio, `tsc` for the worker.
- `yarn knip` - dead code over the repository (the deleted `ReelList`, every new export used).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker` - unit tests, including
  `pipeline-fixtures.test.ts` (fixtures regenerated) and the migration version guard.
- `yarn workspace @edit-issebya/worker test:tools` - the real ffmpeg run of `preview_copies` with the
  two new outputs (owner's Mac only, as the profile says; skip in CI).
- `yarn turbo run test:db --filter=./apps/studio` - DB layer unchanged and still green against the
  ADW stack (no migration, so no reset needed).
- `yarn turbo run build --filter=./apps/studio` - the studio's `next build`.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e` - the landing suite then the studio
  suite, including `reel-layout.spec.ts` and the extended `reels.spec.ts` and `upload.spec.ts`,
  against the `/prepare_app` servers (run by the test phase).

## Notes

- **Undo and Redo interpretation.** The issue says Undo and Redo "move between saved versions ...
  never edit anything". Today the only way to make another version current is "Go back to this",
  which queues a `restore` job and creates a new version, so Undo and Redo cannot call it without
  editing. This plan makes them change the shown version (preview, timeline and the version list's
  `data-selected` mark), leaving "Go back to this" as the way to make it current. If the owner
  meant "make the previous version current", that is a follow-up that reuses `requestRestore`.
- **No Title row.** The issue lists a Title track, but `packages/edit` has no title item (tracks are
  footage, captions, overlays of kind `accent`, transitions, sounds; `cutout` is legacy). Adding a
  title kind is an edit-model change outside this issue. The rows come from `TRACK_ROWS`, so a
  future title kind adds one entry. Say so in the PR.
- **Why frames come from the pipeline, not the browser.** The bucket's CORS allows `PUT` only
  (`app_docs/upload.md`), so a canvas drawn from the signed R2 video would be tainted and changing
  CORS is an owner step. The step already has the retimed footage; two small JPEGs (about 15 KB and
  40 KB) cost one ffmpeg call each, are cached under the step's fingerprint like every output, and
  the browser caches each signed URL for the page.
- Existing reels keep their version 2 `preview_copies` until reprocessed; they show neutral tiles
  and plain footage bars. No backfill in this issue.
- The side panel is the photo library's future home (next issue); keep `ReelScreen`'s side area a
  generic slot and `ThumbnailGrid` free of reel-specific code.
- No new dependency. Tailwind v4 is already the studio's styling setup.
- The Workspaces table marks only `web` as startable; the studio is reached through it, so the
  review phase captures `/studio` and `/studio/reels/<id>` at 1440x900 and 390x844 (each phone tab)
  plus 1920x1080, viewport-sized, and checks for no page scrollbar.
- Recommended workflow: `adw_sdlc_iso`.
