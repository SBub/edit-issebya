# Studio look: one-screen reel page, tracks timeline, thumbnail grid

**Specifications:**

- specs/issue-95-adw-f1d8b655-sdlc_planner-studio-one-screen-reel-layout.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

The studio has a dark, editor-like look with the same layout on desktop and phone. The reel page fits
one screen and never scrolls as a page: a large 9:16 preview with its controls and a read-only tracks
timeline, the correction field pinned under it, and Versions in its own scrolling area over the whole
side column. What the studio is doing shows in a small progress overlay over the preview.
The reels list is a grid of thumbnails with a round **+** button that opens the upload in a dialog.
The reel page also carries the owner's photo library: a third column on desktop and the third tab on a
phone.

## How it works

### Reel page

- `apps/studio/src/components/ReelScreen.tsx`: the one responsive layout, CSS only (Tailwind `lg:`
  breakpoint, 1024 px) plus a small tab state. The root is exactly the height it is given; every child
  that can grow is `min-h-0`, and only the list areas scroll inside their own box (no JavaScript
  measures the window). Desktop: header, main column (preview, controls, timeline) with the correction
  field pinned under it, a side panel where Versions spans all three rows of the side column
  (`lg:col-start-2 lg:row-span-3 lg:row-start-1`, still `min-h-0 overflow-y-auto
overscroll-contain`, so its list scrolls inside it), and a third column, the photo library
  (`id="reel-panel-library"`), spanning every row (`lg:grid-cols-[minmax(0,1fr)_20rem_18rem]`, wider
  at `xl:`), with `min-h-0` on its growing children. Phone: the same header and pinned footer, the
  middle split into Edit, Versions and Library tabs (WAI-ARIA tabs: arrows, Home and End wrap over
  the three). The three areas carry `data-testid` `edit-area`, `versions-area` and `library-area`.
  `ReelScreen` takes the library as its `library` prop.
- `apps/studio/src/components/LiveReel.tsx`: keeps the Realtime state as before and hands pieces to
  `ReelScreen`: header (back link, reel name,
  Export), `ReelPreview` with the progress overlay over it, `ChangeRequestForm` and `VersionList`.
  Also holds the shown version (the owner's pick, remembered with the
  current version it was made for). It passes the `library` node through to `ReelScreen`;
  `apps/studio/src/app/reels/[id]/page.tsx` loads the library on the server and renders `PhotoLibrary`
  into it (details in `app_docs/photo-library.md`).
- `apps/studio/src/components/ProgressOverlay.tsx`: the progress overlay, an absolutely positioned
  card in the top-left of the preview (`absolute left-2 top-2 right-2 sm:right-auto sm:max-w-xs`,
  `z-10`), `pointer-events-none` except its own buttons, so Play and the Position slider under it stay
  usable. What it says and when is in `app_docs/status.md`. The reel page has no jobs list, step log
  or status area; the refusal message of a refused reel stays above the preview.
- `apps/studio/src/components/ReelPreview.tsx`, `PreviewPlayer.tsx`: the preview now builds the
  version being shown, not only the current one, and exposes the player's clock to the controls row
  (Play or Pause, `00:00 / 00:52`, the Position slider, Undo, Redo).
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId, versionId?)` signs the URLs
  for any version of that reel (a version id of another reel reads as nothing, under RLS) and returns
  the frames sprite's layout (`framesLayout`) beside the URLs.
- `apps/studio/src/lib/version-steps.ts`: Undo and Redo pick the previous or next saved version by
  number. They move the shown version only: they never create a version or queue a job. "Go back to
  this" stays the only way to make an older version current.
- `apps/studio/src/app/globals.css`, `layout.tsx`: dark theme tokens (Tailwind v4 `@theme`) and
  `color-scheme: dark`; every studio component uses them.

### Tracks timeline

- `apps/studio/src/lib/tracks-timeline.ts`: `timelineRows(edit, transcript)` turns the shown version's
  `resolveTimeline` spans (the same ones the builder uses, so rows sit where the preview plays them)
  into rows Footage, Behind, Captions, Accents, Transitions and Sounds (`TRACK_ROWS`; a legacy
  `cutout` track is never shown). The Behind row holds the version's `behind` items (empty for a
  version without them): a photo labelled `photo <spot>` (for example `photo left`), a big word by
  its text. `formatClock` makes `mm:ss`.
- `apps/studio/src/components/TracksTimeline.tsx`: renders the ruler, the rows and a playhead that
  follows the player's clock. Read only: nothing in it is focusable, selectable, draggable or editable.
  Footage items show frames cut from the frames sprite. Behind items use
  `--color-track-behind` (`#81ecec`, `bg-track-behind`) with dark text (`text-surface`).

### Thumbnails and the reels grid

- `apps/worker/src/pipeline/preview-copies.ts`: the `preview_copies` step is now version 3 and also
  makes `thumbnail.jpg` (270x480, one representative frame of the first 30) and `frames.jpg` (one row
  of 32 frames of 90x160, one every 2 seconds, so a longer reel's later frames are absent), both from
  the same retimed footage as the preview copy. `apps/worker/src/preview-copies-record.ts` records
  `thumbnail`, `frames` and `frames_layout` in `reels.preview_copies`. Fixtures under
  `fixtures/pipeline/preview_copies/` carry both images.
- `apps/studio/src/lib/preview-sources.ts`: parses the new fields (`thumbnail`, `frames`,
  `frames_layout`); a missing or malformed one is null, never a failure, so an older reel still
  plays. `thumbnailKey` derives the thumbnail's key from the current version's key prefix.
- `apps/studio/src/lib/reels.ts`: `REEL_GRID_COLUMNS` (summary, `source_bytes`, `current_version_id`,
  `preview_copies` and the current version's `r2_key`, embedded through the named constraint
  `reels_current_version_fkey`) and `formatAge` (`now`, `5m`, `3h`, `2d`, `1w`, `3mo`, `1y`). Server
  only: the key never reaches a client component.
- `apps/studio/src/app/page.tsx`: signed in, reads the grid columns, signs each thumbnail on the
  server and renders `ThumbnailGrid` (replaces `ReelList`) plus `UploadDialog`.
- `apps/studio/src/components/ThumbnailGrid.tsx`: generic tile grid, each tile with a thumbnail or
  neutral block, title, a meta line (age and size, `1w · 62.2 MB`) and a status badge
  (`reel-list-status` kept). An item has `href` (a link tile) or `onSelect` (a `<button>` tile). Prop
  `aspect`: `"portrait"` (default, 9:16) or `"square"`. Prop `columns`: `"page"` (default, 3 columns
  on a phone, up to 8 on wide screens) or `"panel"` (3 at every width). Optional prop `add`: a dashed
  add tile first in the grid, the tiles' size and aspect, with a **+** and a visible label that is
  also its accessible name, `disabled` and `data-ready`; with no item it is the only tile, under the
  `empty` text. Nothing reel-specific: the reels use the defaults without `add`, and the photo
  library uses it with `onSelect`, `aspect="square"`, `columns="panel"` and `add`
  (`app_docs/photo-library.md`).
- `apps/studio/src/components/UploadDialog.tsx`: the round **+** button and a native `<dialog>` with
  `UploadForm`. The dialog stays in the DOM when closed so an upload in progress is never unmounted.
  The button is disabled (`data-ready="false"`) until the client has hydrated.

## How to Use

1. Sign in to the studio. The reels show as a grid of thumbnails; tap one to open it.
2. Tap **+** to open the upload dialog and pick a clip. The reel page opens when the upload finishes.
3. On the reel page, press Play, drag Position, and read the timeline rows against the playhead.
4. Use Undo and Redo to look at the previous or next saved version; use "Go back to this" in the
   Versions area to make it current.
5. On a phone, switch between the Edit, Versions and Library tabs; on desktop the library is
   the right-hand column. Type a correction in the field pinned at the bottom and press Send; use
   Export in the header.

## Configuration

No new environment variables. Thumbnails and the frames sprite are signed with the studio's existing
read keys (or the storage mock route under `E2E_MOCK_STORAGE`).

## Testing

- Unit: `tracks-timeline`, `version-steps`, `reels` (`formatAge`), `preview-sources` tests in
  `apps/studio/src/lib/`; the worker's `preview-copies.test.ts` and `preview-copies-record.test.ts`.
- E2E: `apps/studio/e2e/reel-layout.spec.ts` seeds a processed reel with 14 versions and 48 steps and
  checks at 1440x900 and 390x844 that the page never scrolls (Send and Export inside the root box, no
  status area, no step log and no ready-notification control, Versions as tall as the side column within 1 px with its list
  scrolling inside it, the phone's Edit, Versions and Library tabs), the timeline items at
  `resolveTimeline`'s times with footage frames from the sprite and nothing focusable, the playhead
  following the clock, and Undo and Redo changing only the shown version. `reels.spec.ts` checks the
  grid (age and size, status, thumbnail, three columns at 390 px, **+** opening the dialog). `preview`,
  `upload`, `multipart-upload` and `footage-refusal` specs were adjusted to the new markup.
  `photo-library.spec.ts` checks the library column right of `edit-area` at 1440x900 and the Library
  tab at 390x844, with no page scroll. `progress-overlay.spec.ts` checks the overlay inside the
  preview, clear of Play and the Position slider, at 1440x900 and 390x844.
- Measure edge-aligned elements from the root box, not `window.innerWidth` (see `AGENTS.md`).

## Rules

- The reel page never scrolls as a page at any size; lists scroll inside their own area.
- Do not measure the window in JavaScript to size the layout; keep it CSS, with `min-h-0` on growing
  children.
- The tracks timeline is read only: nothing in it is focusable, selectable, draggable or editable.
- Undo and Redo never create a version or queue a job.
- Row spans come from `resolveTimeline`; never compute a second timeline for the display.
- The thumbnail's storage key is derived and signed on the server and never reaches a client
  component; select named columns from `reels`, never `*`.
- `ThumbnailGrid` stays free of reel-specific code.
- Do not unmount `UploadForm` when the upload dialog closes.
- A missing or malformed thumbnail or frames sprite is null, never a failure.
- The overlay never blocks the player's controls: `pointer-events` off except its own buttons.

## Notes

- Touches `apps/worker` (the `preview_copies` step, version 3, so existing reels re-run that step to
  get a thumbnail and a frames sprite), `fixtures/pipeline/` and `.adw/project.md`; most of the change
  is in `apps/studio`.
- Other docs to read with it: `app_docs/studio.md` (its reels-list and `LiveReel` lines predate this
  layout: `ReelList` is replaced by `ThumbnailGrid`), `app_docs/preview.md`, `app_docs/change-requests.md`, `app_docs/status.md`,
  `app_docs/photo-library.md`.
- Out of scope: editing from the timeline.
