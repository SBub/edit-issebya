# Studio look: one-screen reel page, tracks timeline, thumbnail grid

**Specifications:**

- specs/issue-95-adw-f1d8b655-sdlc_planner-studio-one-screen-reel-layout.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-121-adw-98c26124-sdlc_planner-remove-reel-undo-redo.md

## Overview

The studio has a dark, editor-like look with the same layout on desktop and phone. The reel page fits
one screen and never scrolls as a page: a large 9:16 preview with its controls and a tracks timeline
whose ruler is the one scrubber (the rows are read only), all over the full height on the left. On
desktop the right side splits in two rows (68% and 32% of the height): Versions and the photo library side by side in the
top 68%, each scrolling inside itself, and the correction field across both in the bottom 32%,
with a tall text field. On a phone the correction field stays pinned at the bottom. What the studio
is doing shows in a small progress overlay over the preview.
The reels list is a grid of thumbnails with a round **+** button that opens the upload in a dialog.
The reel page also carries the owner's photo library: the top 68% of the third column on desktop and
the third tab on a phone.

## How it works

### Reel page

- `apps/studio/src/components/ReelScreen.tsx`: the one responsive layout, CSS only (Tailwind `lg:`
  breakpoint, 1024 px) plus a small tab state. The root is exactly the height it is given; every child
  that can grow is `min-h-0`, and only the list areas scroll inside their own box (no JavaScript
  measures the window). Desktop: header, then a grid of three columns
  (`lg:grid-cols-[minmax(0,1fr)_20rem_18rem]`, wider at `xl:`) and two rows, 68% and 32%
  (`lg:grid-rows-[minmax(0,17fr)_minmax(0,8fr)]`). The main column (preview, controls, timeline)
  spans both rows (`lg:row-span-2`). Versions is the top 68% of column 2 (`lg:col-start-2
lg:row-start-1`, `min-h-0 overflow-y-auto overscroll-contain`, so its list scrolls inside it), the
  photo library (`id="reel-panel-library"`) the top 68% of column 3 (`lg:col-start-3
lg:row-start-1`, its grid scrolling inside it, the add tile and drop target unchanged), and the
  correction field the bottom 32% across both (`lg:col-span-2 lg:col-start-2 lg:row-start-2`,
  `border-t` and `border-l`). In that area `ChangeRequestForm` grows (`lg:flex-1 lg:min-h-0` on the
  form and the field's box), so the field is tall and Send stays in its bottom right corner; behaviour (Send, disabled states, messages) is the same as on a phone. Phone:
  the same header, the middle split into Edit, Versions and Library tabs (WAI-ARIA tabs: arrows,
  Home and End wrap over the three) and the correction field pinned at the bottom, its usual two-row
  height. The correction field is last in the DOM, after the three panels, so the tab order follows
  the reading order on both (edit, Versions, library, correction field), with no CSS `order`. The
  areas carry `data-testid` `edit-area`, `versions-area`, `library-area` and `change-area`.
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
  `z-10`), `pointer-events-none` except its own buttons, so Play under it stays usable (the ruler
  sits below the preview, clear of it). What it says and when is in `app_docs/status.md`. The reel
  page has no jobs list, step log or status area; the refusal message of a refused reel stays above
  the preview.
- `apps/studio/src/components/ReelPreview.tsx`, `PreviewPlayer.tsx`: the preview builds the
  reel's current version (`reels.current_version_id`) and exposes the player's clock to the control
  row (Play or Pause at the left, the clock in the centre, then Zones at the right). The row is a
  three-column grid (`grid-cols-[1fr_auto_1fr]`), the outer two columns equal, so the clock sits on
  the row's horizontal centre whatever stands left and right of it.
  Play or Pause is an
  icon button at the left of the row (`data-testid="play-toggle"`): a filled play triangle with
  rounded corners when paused, two filled bars while playing, an inline `aria-hidden` SVG of 28 px in
  `text-ink` (`fill="currentColor"`) with no background, shape or text, a 40x40 tap target, a slight
  opacity change on hover (`enabled:hover:opacity-80`), dimmed when disabled, and the global
  `:focus-visible` ring. Its `aria-label` and `title` switch between `Play` and `Pause`. The clock
  (`data-testid="preview-clock"`) is two stacked lines in `font-mono` with tabular figures: the
  current time on top (`preview-clock-position`, `text-ink`) and the total duration below
  (`preview-clock-duration`, `text-muted`), both `00:00`; a screen-reader-only `/` between them
  keeps the read-out `00:00 / 00:52`. The two 16 px lines fit inside the 40 px button height, so the
  row is no taller than before. The control row has
  no Position slider: the tracks timeline's ruler is the one scrubber. `PreviewPlayer` exposes its
  seek through a `ref` (`PreviewPlayerHandle.seek`), and `ReelPreview`'s `BuiltPreview` hands it to
  `TracksTimeline` as `onSeek`, so a ruler seek takes the same path the slider did (the player's
  seek, the hold-then-start routine, sound scheduling, `onPosition`).
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId, versionId?)` signs the URLs
  for any version of that reel (a version id of another reel reads as nothing, under RLS) and returns
  the frames sprite's layout (`framesLayout`) beside the URLs.
- `apps/studio/src/app/globals.css`, `layout.tsx`: dark theme tokens (Tailwind v4 `@theme`) and
  `color-scheme: dark`; every studio component uses them.

### Tracks timeline

- `apps/studio/src/lib/tracks-timeline.ts`: `timelineRows(edit, transcript)` turns the shown version's
  `resolveTimeline` spans (the same ones the builder uses, so rows sit where the preview plays them)
  into rows Footage, Behind, Captions, Accents, Transitions and Sounds (`TRACK_ROWS`; a legacy
  `cutout` track is never shown). The Behind row holds the version's `behind` items (empty for a
  version without them): a photo labelled `photo <spot>` (for example `photo left`), a big word by
  its text. `formatClock` makes `mm:ss`. `secondsAtX(clientX, box, duration)` maps a pointer x to
  reel seconds from the ruler's own box, clamped to 0 and the duration;
  `scrubKey(key, shift, position, duration)` gives the ruler's key moves (`SCRUB_STEP` 1 s,
  `SCRUB_STEP_LARGE` 5 s).
- `apps/studio/src/components/TracksTimeline.tsx`: renders the ruler, the rows and a playhead that
  follows the player's clock. The ruler is the one scrubber: one focusable element (`role="slider"`,
  named `Position`, `aria-valuemin` 0, `aria-valuemax` the duration, `aria-valuenow` and
  `aria-valuetext` such as `00:12 of 00:52`, `data-testid="ruler"`, a visible focus ring). Pointer
  down on it seeks to the time under the pointer, and a drag keeps seeking (pointer capture, so a
  drag that leaves the ruler keeps scrubbing; `touch-action: none`). Playing stays playing through a
  drag, as it did with the old slider: every seek while playing re-enters the player's
  hold-then-start routine; paused stays paused. Keys: Arrow Left and Right (and Down and Up) step
  1 s, with Shift 5 s; Page Up and Page Down step 5 s; Home and End jump to the start and the end.
  The playhead line, with a dot at its top, is the visible handle and sits under the pointer: while
  the pointer is down it shows the pointer's time (the player settles each seek on a frame
  boundary, up to one frame earlier, which is several px on a phone), and after release it follows
  the player's clock again. The ruler, every row's lane (`track-lane`) and the playhead share one time axis: the same left edge
  after the 80 px label column (`w-20`) and the same width. The rows are read only: nothing in them
  is focusable, selectable, clickable, draggable or editable, and a click on a row does nothing.
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
  server and renders `ThumbnailGrid` (replaces `ReelList`) plus `UploadDialog`. Each reel passes
  `DeleteReelButton` as its tile's `corner`: the bin in the bottom-right corner, always visible (no
  hover), 44 px on a phone (see `app_docs/studio.md`).
- `apps/studio/src/components/ThumbnailGrid.tsx`: generic tile grid, each tile with a thumbnail or
  neutral block, title, a meta line (age and size, `1w · 62.2 MB`) and a status badge
  (`reel-list-status` kept). Title, meta and badge are each optional: an item without them shows
  only its image (the photo library's tiles), and its `label` is then the tile's `aria-label`; the
  reel cards always pass all three. An item has `href` (a link tile) or `onSelect` (a `<button>` tile). Prop
  `aspect`: `"portrait"` (default, 9:16) or `"square"`. Prop `columns`: `"page"` (default, 3 columns
  on a phone, up to 8 on wide screens) or `"panel"` (3 at every width). Optional prop `add`: a dashed
  add tile first in the grid, the tiles' size and aspect, with a **+** and a visible label that is
  also its accessible name, `disabled` and `data-ready`; with no item it is the only tile, under the
  `empty` text. Optional `corner` per item: a control rendered as a sibling of the tile's link,
  never inside it, with the title and meta padded clear of it. Nothing reel-specific: the reels use the defaults without `add`, and the photo
  library uses it with `onSelect`, `aspect="square"`, `columns="panel"` and `add`
  (`app_docs/photo-library.md`).
- `apps/studio/src/components/UploadDialog.tsx`: the round **+** button and a native `<dialog>` with
  `UploadForm`. The dialog stays in the DOM when closed so an upload in progress is never unmounted.
  The button is disabled (`data-ready="false"`) until the client has hydrated.

## How to Use

1. Sign in to the studio. The reels show as a grid of thumbnails; tap one to open it.
2. Tap **+** to open the upload dialog and pick a clip. The reel page opens when the upload finishes.
3. On the reel page, press Play. To move through the video, click or drag the ruler above the
   tracks (the playhead follows the pointer), or focus it and use the arrow keys (Shift for 5 s),
   Home and End. Read the timeline rows against the playhead.
4. Use "Go back to this" in the Versions area to make an older version current (it saves a new
   version copying the old one); the preview always shows the current version.
5. On a phone, switch between the Edit, Versions and Library tabs and type a correction in the
   field pinned at the bottom. On desktop the edit area is the left column, Versions and the
   library sit side by side in the top right, and the correction field fills the bottom right.
   Press Send; use Export in the header.

## Configuration

No new environment variables. Thumbnails and the frames sprite are signed with the studio's existing
read keys (or the storage mock route under `E2E_MOCK_STORAGE`).

## Testing

- Unit: `tracks-timeline` (including `secondsAtX` and `scrubKey`: clamping, Home and End, the
  Shift step), `reels` (`formatAge`), `preview-sources` tests in
  `apps/studio/src/lib/`; the worker's `preview-copies.test.ts` and `preview-copies-record.test.ts`.
- E2E: `apps/studio/e2e/reel-layout.spec.ts` seeds a processed reel with 14 versions and 48 steps and
  checks at 1440x900 and 390x844 that the page never scrolls (Send and Export inside the root box, no
  status area, no step log and no ready-notification control, the phone's Edit, Versions and Library
  tabs with the correction field pinned at the bottom over the full width). On both it checks that
  Send is a square icon button with no text (named by `aria-label` and `title`) inside the field's
  box (`data-testid="change-field"`) at its bottom right, and that the textarea's right padding
  clears it. At 1440x900, 1280x800
  and 1024x768 (the `lg` breakpoint) it checks the desktop split within 1 px: the edit area over the
  full height under the header, Versions and the library side by side each 68% of that height with
  Versions' list scrolling inside it, the correction field below both and as wide as the two, its
  field at least half the area's height, and the DOM order edit, Versions,
  library, correction field (the tab order). It also checks the timeline items at
  `resolveTimeline`'s times with footage frames from the sprite and nothing in the rows focusable
  (the ruler the timeline's one focusable element), the playhead following the clock, and no Undo or
  Redo button, the preview showing the current version and no version marked as showing, at both
  sizes. At both sizes it checks that Play and Pause is one icon
  button (`play-toggle`) with no text and one `aria-hidden` SVG, at least 40x40 and left of the
  clock, with a transparent background on hover, whose accessible name and `title` switch from
  `Play` to `Pause` and back; and that the clock's horizontal centre is within 2 px of the control
  row's, the current time (`00:00`) above the total, and the row no taller than the button. At both sizes it
  checks the ruler as the one scrubber: no
  Position control in the control row and the ruler the page's one `role="slider"`; the ruler's left
  edge and width equal every lane's within 1 px; clicks at 25% and 75% of its box seek the player
  there; a drag keeps the playhead within 2 px of the pointer (also once the clock has settled on a
  frame) and keeps scrubbing past the ruler's end; a click on a row does nothing; arrows, Shift, Home
  and End move the position. Every read waits for the seek to settle (`settledTime`: on a frame,
  within one frame of the target, the same over three reads 100 ms apart), since the player first
  reads the asked-for time and the runtime moves it to a frame boundary later. The seeking
  specs (`preview`, `behind`, `e2e-tools/export-matches-preview`) seek with a real click on the
  ruler (`test-support/ruler.ts`). `reels.spec.ts` checks the
  grid (age and size, status, thumbnail, three columns at 390 px, **+** opening the dialog). `preview`,
  `upload`, `multipart-upload` and `footage-refusal` specs were adjusted to the new markup.
  `photo-library.spec.ts` checks the library right of `edit-area` at 1440x900 and the Library
  tab at 390x844, with no page scroll. `progress-overlay.spec.ts` checks the overlay inside the
  preview, clear of Play and the ruler, at 1440x900 and 390x844.
- Measure edge-aligned elements from the root box, not `window.innerWidth` (see `AGENTS.md`).

## Rules

- The reel page never scrolls as a page at any size; lists scroll inside their own area.
- On desktop the edit area takes the full height; never put the correction field under it. The
  correction field stays last in the DOM, so the tab order follows the reading order; do not
  reorder it with CSS `order`.
- Do not measure the window in JavaScript to size the layout; keep it CSS, with `min-h-0` on growing
  children.
- The ruler is the one scrubber: the only focusable and draggable element in the tracks timeline, and
  the player's control row has no Position slider. Never add a second seek control.
- Track items stay read only: nothing in the rows is focusable, selectable, clickable, draggable or
  editable.
- The ruler, every row's lane and the playhead share one time axis (same left edge after the label
  column, same width). The ruler maps a pointer from its own box, never the window.
- A ruler seek goes through the player's own seek (`PreviewPlayerHandle.seek`); never a second clock.
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
