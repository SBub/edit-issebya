# Studio look: one-screen reel page, tracks timeline, thumbnail grid

**Specifications:**

- specs/issue-95-adw-f1d8b655-sdlc_planner-studio-one-screen-reel-layout.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md
- specs/issue-121-adw-98c26124-sdlc_planner-remove-reel-undo-redo.md

## Overview

The studio has a dark, editor-like look with the same layout on desktop and phone. The reel page fits
one screen and never scrolls as a page: a large 9:16 preview with its controls and a tracks timeline
whose ruler is the one scrubber (the rows are read only), all over the full height on the left. On desktop the right side holds Versions and the photo library side by side, each over the full
height and scrolling inside itself, with no change box under them. On a phone the same parts sit
behind tabs. What the studio is doing shows in a small progress overlay over the preview.
The reels list is a grid of thumbnails with a white, rounded **+** button that opens the upload in a dialog.
The studio has one corner radius, on four elements only, and one exception: track items have a small 4px radius (see Corner radius).
The reel page also carries the owner's photo library: the top 68% of the third column on desktop and
the third tab on a phone.

## How it works

### Reel page

- `apps/studio/src/components/ReelScreen.tsx`: the one responsive layout, CSS only (Tailwind `lg:`
  breakpoint, 1024 px) plus a small tab state. The root is exactly the height it is given; every child
  that can grow is `min-h-0`, and only the list areas scroll inside their own box (no JavaScript
  measures the window). Desktop: header, then a grid of three columns
  (`lg:grid-cols-[minmax(0,1fr)_20rem_18rem]`, wider at `xl:`) over one row of full height: the main
  column (preview, controls, timeline) in column 1, and on its right the versions column (`lg:col-start-2`):
  a tool panel on its top half, the font pair picker (`FontPairPicker.tsx`, six samples, `app_docs/font-pairs.md`),
  and the versions list in the lower part (Versions, `lg:col-start-2`,
  `min-h-0 overflow-y-auto overscroll-contain`, no padding of its own, so its list of fixed-height
  version rows (no time or date, edge to edge of the area), each opened with its arrow, scrolls
  inside it; rows and texts in `app_docs/change-requests.md`; the temporary Start over button sits at
  the right of the `Versions` heading) and the photo library (`id="reel-panel-library"`, column 3, its
  grid scrolling inside it, the add tile and drop target unchanged). The change box is removed
  (`app_docs/change-requests.md`), so nothing sits under the two columns. Phone: the same header, the
  middle split into Edit, Versions and Library tabs (WAI-ARIA tabs: arrows, Home and End wrap over the
  three), one shown. The areas carry `data-testid` `edit-area`, `versions-area` and `library-area`; the
  DOM order is edit, Versions, library, so the tab order follows the reading order on both, with no CSS
  `order`. `ReelScreen` takes the library as its `library` prop.
- `apps/studio/src/components/LiveReel.tsx`: keeps the Realtime state as before and hands pieces to
  `ReelScreen`: header (back link, reel name,
  Export), `ReelPreview` with the progress overlay over it and `VersionList` (with Start over).
  Also holds the shown version (the owner's pick, remembered with the
  current version it was made for). It passes the `library` node through to `ReelScreen`;
  `apps/studio/src/app/reels/[id]/page.tsx` loads the library on the server and renders `PhotoLibrary`
  into it (details in `app_docs/photo-library.md`).
- `apps/studio/src/components/ProgressOverlay.tsx`: the progress overlay, an absolutely positioned
  card at the top right of the preview, like a notification (`absolute top-0 right-0 w-full
max-w-xs`, `z-10`; owner, 2026-11-03). Its top edge sits exactly on the preview frame's top edge
  (it was `top-2`, which left it lower than the reel) and its right edge on the edit area's right
  content edge, the edge the control row's expand icon and the tracks panel end on, on desktop and
  phone, collapsed and expanded: its positioned parent spans the edit area's content box and the
  frame starts at its top, so `top-0 right-0` lines them up. It is at most `max-w-xs` wide and never
  wider than its parent, its text wrapping. Where the free space right of the 9:16 reel is wide
  enough it sits there; where it is not (phone, narrow windows, expanded preview) it overlays the
  reel's top-right corner. Before this change it sat at the top left (`left-2 right-2
sm:right-auto`) and could cover up to 320 px of the reel's top-left. Its bar is a `bg-line` track
  with a white `bg-primary` fill. It is `pointer-events-none` except its own buttons, so Play under
  it stays usable (the ruler
  sits below the preview, clear of it). What it says and when is in `app_docs/status.md`. The reel
  page has no jobs list, step log or status area; the refusal message of a refused reel stays above
  the preview.
- `apps/studio/src/components/ReelPreview.tsx`, `PreviewPlayer.tsx`: the preview builds the
  reel's current version (`reels.current_version_id`) and exposes the player's clock to the control
  row (Play or Pause at the left, the clock in the centre, then Zones and last the expand button at
  the right). The row is a three-column grid (`grid-cols-[1fr_auto_1fr]`), the outer two columns
  equal, so the clock sits on the row's horizontal centre whatever stands left and right of it.
  Play or Pause is an
  icon button at the left of the row (`data-testid="play-toggle"`): a filled play triangle with
  rounded corners when paused, two filled bars while playing, an inline `aria-hidden` SVG of 28 px in
  `text-ink` (`fill="currentColor"`) with no background, shape or text, a 40x40 tap target, a slight
  opacity change on hover (`enabled:hover:opacity-80`), dimmed when disabled, and the global
  `:focus-visible` ring. Its `aria-label` and `title` switch between `Play` and `Pause`. The clock
  (`data-testid="preview-clock"`) is two stacked lines in `font-mono` with tabular figures: the
  current time on top (`preview-clock-position`, `text-ink`) and the total duration below
  (`preview-clock-duration`, `text-muted`), both `00:00`; a screen-reader-only `/` between them
  keeps the read-out `00:00 / 00:52`. Temporary testing aid, to be removed: while
  `SHOW_MILLISECONDS` in `tracks-timeline.ts` is true, both lines (and the ruler's `aria-valuetext`)
  come from `clockText` and show milliseconds, `00:03.412` over `00:57.140`, so caption sync can be
  judged by eye; the monospace tabular figures keep the width steady while playing. The two 16 px lines fit inside the 40 px button height, so the
  row is no taller than before. The control row has
  no Position slider: the tracks timeline's ruler is the one scrubber. `PreviewPlayer` exposes its
  seek through a `ref` (`PreviewPlayerHandle.seek`), and `ReelPreview`'s `BuiltPreview` hands it to
  `TracksTimeline` as `onSeek`, so a ruler seek takes the same path the slider did (the player's
  seek, the hold-then-start routine, sound scheduling, `onPosition`).
- Control row edges (owner, 2026-11-03): the row spans the same width as the tracks panel
  (`tracks`, the edit area's content box), and its outer glyphs sit exactly on that box's edges:
  the visible left edge of the play triangle or the pause bars on the panel's left edge, the
  visible right edge of the expand or collapse arrows on its right edge. Each SVG's viewBox starts
  (Play `7.4 0 24 24`, Pause `6 0 24 24`) or ends (expand `-2 0 24 24`) on its glyph's visible edge,
  stroke included, and the SVG sits at the outer end of its 40x40 button (`justify-start` for
  Play or Pause, `justify-end` for expand), so the tap targets stay 40x40 and stay inside the row.
  The clock stays on the row's centre and Zones keeps its place in the right
  group. Expanded, the row keeps the same edges (the edit area's content box) with no panel below.
- Expand and collapse (owner, 2026-11-03): the last button of the control row
  (`data-testid="preview-expand"`) is an icon button in the Play/Pause style: an inline `aria-hidden`
  SVG of 24 px in `text-ink` (four arrows out to the corners when collapsed, four arrows in from them
  when expanded), no background or shape, a 40x40 tap target, a slight opacity change on hover, the
  global `:focus-visible` ring, `aria-pressed`, and `aria-label` and `title` `Expand preview` or
  `Collapse preview`. `ReelPreview` holds the state (`expanded`, React state: collapsed on every
  open, never saved, kept across a version switch) and passes it to `BuiltPreview` and
  `PreviewPlayer` (`expanded`, `onExpandedChange`). Expanded, `BuiltPreview` does not render the
  tracks timeline (ruler included), so the player's `flex-1` box takes the whole edit area (the left
  column on desktop, the Edit tab on a phone) and its 9:16 frame grows, at the box's top edge and centred
  horizontally (`items-start` plus `justify-center`, so the progress overlay, anchored to the box's top,
  lines up with the frame's top whatever its height). The frame's height is
  the smaller of that box's height and the height 9:16 gives its width (container units on the box in
  `PreviewPlayer`), so the frame never clamps its width and stays 9:16 when the box is taller than that
  (a tall phone without the change box); the control row keeps
  only Play or Pause, the clock (still centred by the grid) and the expand button, with Zones not
  rendered. Expanding switches the Zones layer off (the expand
  button's click handler sets `PreviewPlayer`'s `zones` state to false, since its button is
  hidden); collapsing does not switch it back on. The right side and the
  phone's tabs do not change. Toggling only changes the markup around
  `<hyperframes-player>`: the player is never remounted, paused or seeked, so playback goes on.
- `apps/studio/src/app/preview-actions.ts`: `loadPreviewSources(reelId, versionId?)` signs the URLs
  for any version of that reel (a version id of another reel reads as nothing, under RLS) and returns
  the frames sprite's layout (`framesLayout`) beside the URLs.
- `apps/studio/src/app/globals.css`, `layout.tsx`: dark theme tokens (Tailwind v4 `@theme`) and
  `color-scheme: dark`; every studio component uses them.

### Dark theme tokens

The studio is pitch black (owner, 2026-11-03). Tokens in `apps/studio/src/app/globals.css`:

| Token                            | Value                | Use                                                                                                                                                                           |
| -------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-surface`                | `#000000`            | The page (`body`) and every area: the reels list and its grid, the reel page's edit area with the preview, Versions, Library, dialogs, the progress overlay (`bg-surface/85`) |
| `--color-chrome`                 | `#15171b`            | The lifted surfaces only: the header bars (reels list and reel page), the phone's tab bar, the tracks timeline panel (`data-testid="tracks"`)                                 |
| `--color-raised`                 | `#1f2228`            | Hover, the selected version row, inputs, progress tracks, thumbnail placeholders                                                                                              |
| `--color-line`                   | `#2e323a`            | Borders and dividers (1.63:1 on black, subtle but visible); the preview frame has a `ring-line` edge                                                                          |
| `--color-ink`                    | `#eceef1`            | Text: 18.1:1 on black, 15.4:1 on chrome                                                                                                                                       |
| `--color-muted`                  | `#a3a9b3`            | Secondary text: 8.9:1 on black, 7.6:1 on chrome, 6.7:1 on raised (WCAG AA for small text everywhere)                                                                          |
| `--color-accent`                 | `#7cc4ff`            | Current marks (tab underline, playhead, the current version mark), focus rings, links, drop outlines                                                                          |
| `--color-primary`                | `#ffffff`            | Filled primary buttons (`bg-primary`): Export, Send sign-in link, Upload and the + button; progress fills                                                                     |
| `--color-on-primary`             | `#000000`            | Text and icons on primary buttons (`text-on-primary`)                                                                                                                         |
| `--color-danger`, `--color-warn` | `#ff8a80`, `#f5c451` | Errors and warnings                                                                                                                                                           |
| `--color-track-*`                | unchanged            | Track item colours                                                                                                                                                            |

Primary buttons are white with black content (owner, 2026-11-03): every filled button uses
`bg-primary text-on-primary`, `enabled:hover:opacity-90` on hover and `disabled:opacity-50` while
disabled; none uses `bg-accent`. Before this change they were filled with the accent blue. Their
corner radius rules are unchanged (see Corner radius).

Progress fills are white too (owner, 2026-11-03): the progress overlay's bar, the export bar (its
pulsing `bg-primary/60` block while waiting and its `bg-primary` fill while rendering) and the
upload `<progress>` (`::-webkit-progress-value` and `::-moz-progress-bar`) fill with `bg-primary`.
Their tracks are unchanged (`bg-line` in the overlay, `bg-raised` for export and upload). Before
this change they filled with the accent blue.

Before this change `--color-surface` was `#0c0d10` and the lifted token was named `--color-panel`
(same `#15171b`) and also filled the correction area, dialogs and track lanes. The track lanes are
now black wells (`bg-surface`) inside the lifted tracks panel. The tracks panel's padding sits
outside an inner `relative` box, so the playhead's `left-20` still matches the lanes.

### Corner radius

The studio has one corner radius (owner, 2026-11-03): `--radius-reel` in the same `@theme`, `0.5rem`
(8 px, the value the reel preview frame had as `rounded-lg`), used as `rounded-reel`. It is on six
elements only:

1. the reel preview frame (`data-testid="preview-frame"` in `PreviewPlayer.tsx`, `overflow-hidden`
   with a `ring-1 ring-line` edge; the ring is a box shadow, so it follows the token; the
   `<hyperframes-player>` inside draws no rounding of its own and is clipped by the frame),
2. Export (`export-button` in `ExportPanel.tsx`),

3. the reel cards in the reels list (owner, 2026-11-03): each card's thumbnail box
   (`tile-thumbnail`, `overflow-hidden`, so the image is clipped to the corners) and the card's
   link, so its focus ring follows the same shape. `ThumbnailGrid` rounds only when its `rounded`
   prop is set, and only the reels list (`page.tsx`) sets it.
4. the reels list's **+** upload button ("Upload a reel" in `UploadDialog.tsx`, owner, 2026-11-03),
   white like every filled button.

One exception (owner, 2026-11-03): track items have a small 4px radius (slightly
rounded). The items in the Behind, Hook, Accents and Transitions rows of the tracks timeline
(`track-item` in `TracksTimeline.tsx`, class from `trackItemClass` in
`apps/studio/src/lib/tracks-timeline.ts`) take `rounded-track`, from the `--radius-track` token
(0.25rem) next to `--radius-reel` in `apps/studio/src/app/globals.css`. A footage clip is the same
`track-item` element but holds a strip of frames from the sprite, so the Footage row's items stay
square: `trackItemClass` adds `rounded-track` for every row but `footage`.

Every other element is square: buttons (Zones, Go back, tabs, dialog buttons, the Close cross, Cancel and
Yes, Delete, Sign out, a reel card's bin and its delete dialog's Cancel and Delete), photo tiles
and every add tile, the
status and tile badges, dialogs, the tracks panel, its lanes, the ruler, the Footage row's clips and the playhead and its dot, the
progress overlay and its bars, the export and upload progress bars (the native `<progress>` is
styled flat with `appearance-none`), the drop overlay, the upload dialog's dashed drop zone, the refusal message, inputs (the sign-in
page), and focus rings (square because they follow the element; a reel card's
is rounded for the same reason). Icon artwork
inside an SVG (the play triangle's round joins, the pause bars' `rx`, round line caps) is drawing,
not a corner, and is unchanged.

### Tracks timeline

- `apps/studio/src/lib/tracks-timeline.ts`: `timelineRows(edit, transcript)` turns the shown version's
  `resolveTimeline` spans (the same ones the builder uses, so rows sit where the preview plays them)
  into five rows Footage, Behind, Hook, Accents and Transitions (`TRACK_ROWS`). The rows are a reference
  for Claude's decisions, so the edit's captions and sounds tracks have no row (owner, 2026-11-03;
  the edit and `resolveTimeline` still carry them, and there is no toggle to show them), and a
  legacy `cutout` track is never shown. The Behind row holds the version's `behind` items (empty for a
  version without them): a VISUAL labelled `visual <spot>` (for example `visual left`, or `visual, in front`
  for one in front of the speaker), a big word by its text. The Hook row holds the written hook (the overlay of kind `hook`, at most one, labelled
  by its text; empty for a version without one), so the Accents row keeps the spoken accents
  only. `formatClock` makes `mm:ss`. Temporary testing aid, to be removed: `SHOW_MILLISECONDS`
  (true) switches `clockText` (the player's clock and the ruler's read-out) to `formatClockMs`
  (`mm:ss.mmm`, rounded to the millisecond) and `itemTitle` (each track item's native `title`
  tooltip, `There (0.412 to 0.733 s)`) to three decimals; with it false they fall back to
  `formatClock` and two decimals. The ruler's tick labels stay whole seconds either way. `secondsAtX(clientX, box, duration)` maps a pointer x to
  reel seconds from the ruler's own box, clamped to 0 and the duration;
  `scrubKey(key, shift, position, duration)` gives the ruler's key moves (`SCRUB_STEP` 1 s,
  `SCRUB_STEP_LARGE` 5 s).
- `apps/studio/src/components/TracksTimeline.tsx`: renders the ruler, the rows and a playhead that
  follows the player's clock. The ruler is the one scrubber: one focusable element (`role="slider"`,
  named `Position`, `aria-valuemin` 0, `aria-valuemax` the duration, `aria-valuenow` and
  `aria-valuetext` such as `00:12 of 00:52` (`00:12.250 of 00:52.140` while the testing aid is on), `data-testid="ruler"`, a visible focus ring). Pointer
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
  `--color-track-behind` (`#81ecec`, `bg-track-behind`) with dark text (`text-surface`); the hook
  `--color-track-hook` (`#fdcb6e`, `bg-track-hook`), dark text too.

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
  hover), 44 px on a phone, a plain `text-ink` icon with no background or shape and a slight fade on
  hover (see `app_docs/studio.md`).
- `apps/studio/src/components/ThumbnailGrid.tsx`: generic tile grid, each tile with a thumbnail or
  neutral block, title, a meta line (age and size, `1w · 62.2 MB`) and a status badge
  (`reel-list-status` kept). Title, meta and badge are each optional: an item without them shows
  only its image (the photo library's tiles), and its `label` is then the tile's `aria-label`; the
  reel cards always pass all three. An item has `href` (a link tile) or `onSelect` (a `<button>` tile). Prop
  `aspect`: `"portrait"` (default, 9:16) or `"square"`. Prop `rounded` (default off): each item's
  thumbnail box (`data-testid="tile-thumbnail"`) and tile take `rounded-reel`; the add tile stays
  square. Prop `columns`: `"page"` (default, 3 columns
  on a phone, up to 8 on wide screens) or `"panel"` (3 at every width). Optional prop `add`: a dashed
  add tile first in the grid, the tiles' size and aspect, with a **+** and a visible label that is
  also its accessible name, `disabled` and `data-ready`; with no item it is the only tile, under the
  optional `empty` text (none when `empty` is not passed, as in the photo library). Optional
  `corner` per item: a control rendered as a sibling of the tile's link, never inside it, with the
  title and meta padded clear of it. Nothing reel-specific: the reels use the defaults with `rounded` and without `add`, and the photo
  library uses it with `onSelect`, `aspect="square"`, `columns="panel"` and `add`
  (`app_docs/photo-library.md`).
- `apps/studio/src/components/UploadDialog.tsx`: the white, rounded (`rounded-reel`) **+** button and a native `<dialog>` with
  `UploadForm`. The dialog stays in the DOM when closed so an upload in progress is never unmounted.
  The button is disabled (`data-ready="false"`) until the client has hydrated. The dialog closes
  with the same cross as the photo dialog (`CloseButton.tsx`) and picks the clip in a square
  dashed drop zone (`app_docs/upload.md`, Upload dialog).

## How to Use

1. Sign in to the studio. The reels show as a grid of thumbnails; tap one to open it.
2. Tap **+** to open the upload dialog and pick a clip. The reel page opens when the upload finishes.
3. On the reel page, press Play. To move through the video, click or drag the ruler above the
   tracks (the playhead follows the pointer), or focus it and use the arrow keys (Shift for 5 s),
   Home and End. Read the timeline rows against the playhead.
   Press the expand button at the right end of the control row to let the preview fill the edit
   area (the timeline and Zones hide); press it again to collapse.
4. Open a version's details with its arrow in the Versions area and use "Go back to this" to make
   an older version current (it saves a new version copying the old one); the preview always shows
   the current version.
5. On a phone, switch between the Edit, Versions and Library tabs. On desktop the edit area is the left
   column, and Versions and the library sit side by side on the right. Start over is beside the
   Versions heading; use Export in the header.

## Configuration

No new environment variables. Thumbnails and the frames sprite are signed with the studio's existing
read keys (or the storage mock route under `E2E_MOCK_STORAGE`).

## Testing

- Unit: `tracks-timeline` (the five rows, the hook in its own row and never among the accents, no captions or sounds items; `secondsAtX` and `scrubKey`:
  clamping, Home and End, the Shift step; `trackItemClass`: slightly rounded except footage), `reels` (`formatAge`), `preview-sources` tests in
  `apps/studio/src/lib/`; the worker's `preview-copies.test.ts` and `preview-copies-record.test.ts`.
- E2E: `apps/studio/e2e/reel-layout.spec.ts` seeds a processed reel with 14 versions and 48 steps and
  checks at 1440x900 and 390x844 that the page never scrolls (Export inside the root box, no status
  area, no step log and no ready-notification control, the phone's Edit, Versions and Library tabs,
  with Start over on the Versions tab). At 1440x900, 1280x800 and 1024x768 (the `lg` breakpoint) it
  checks the desktop split within 1 px: the edit area over the full height under the header, Versions
  and the library side by side each over the full height, Versions' list scrolling inside it, and the
  DOM order edit, Versions, library (the tab order). At 1440x900 and 390x844 it checks the versions list:
  every row one height within 1 px whatever its text, the details behind the arrow. It also checks the
  timeline's five rows in order (Footage, Behind, Hook, Accents, Transitions; no Captions or Sounds row,
  though the edit has captions), the items at `resolveTimeline`'s times with footage frames from the sprite and nothing in the rows focusable
  (the ruler the timeline's one focusable element), the playhead following the clock, and no Undo or
  Redo button, the preview showing the current version and no version marked as showing, at both
  sizes. At both sizes it checks that Play and Pause is one icon
  button (`play-toggle`) with no text and one `aria-hidden` SVG, at least 40x40 and left of the
  clock, with a transparent background on hover, whose accessible name and `title` switch from
  `Play` to `Pause` and back; and that the clock's horizontal centre is within 2 px of the control
  row's, the current time (`clockText(0)`, `00:00.000` while the testing aid is on) above the total, and the row no taller than the button; and
  that the `play-toggle` SVG's left and the `preview-expand` SVG's right equal the `tracks` box's
  left and right within 1 px, paused and playing. At both sizes it
  checks the ruler as the one scrubber: no
  Position control in the control row and the ruler the page's one `role="slider"`; the ruler's left
  edge and width equal every lane's within 1 px; clicks at 25% and 75% of its box seek the player
  there; a drag keeps the playhead within 2 px of the pointer (also once the clock has settled on a
  frame) and keeps scrubbing past the ruler's end; a click on a row does nothing; arrows, Shift, Home
  and End move the position. At both sizes it checks expand and collapse: the button at the row's
  right end after Zones, named `Expand preview`; expanding with Enter while playing
  removes `tracks` and the ruler and Zones, keeps Play or Pause and the clock (still
  centred) and the button at the right end, makes the 9:16 frame taller, its top on the edit area's top edge and centred across it horizontally,
  with no page scroll, and switches the name to `Collapse preview`; collapsing with Space brings
  everything back at the collapsed size; the same `<hyperframes-player>` keeps playing through both
  toggles, and a paused player stays paused at the same time. Collapsed, the `tracks` box equals
  the edit area's content box (inside its padding) within 1 px; expanded, the two SVG edges equal
  that content box's edges within 1 px. With Zones on, expanding removes `platform-zones` and
  collapsing leaves Zones off (`aria-pressed="false"`, no layer). Every read waits for the seek to settle (`settledTime`: on a frame,
  within one frame of the target, the same over three reads 100 ms apart), since the player first
  reads the asked-for time and the runtime moves it to a frame boundary later. The seeking
  specs (`preview`, `e2e-tools/export-matches-preview`) seek with a real click on the
  ruler (`test-support/ruler.ts`). `reels.spec.ts` checks the
  grid (age and size, status, thumbnail, three columns at 390 px, **+** opening the dialog). `preview`,
  `upload`, `multipart-upload` and `footage-refusal` specs were adjusted to the new markup.
  `photo-library.spec.ts` checks the library right of `edit-area` at 1440x900 and the Library
  tab at 390x844, with no page scroll. `progress-overlay.spec.ts` checks the overlay inside the
  preview, clear of Play and the ruler, at 1440x900 and 390x844, its top equal to
  `preview-frame`'s top and its right equal to `edit-area`'s content right (and to `tracks`' right
  while collapsed) within 1 px, collapsed and expanded, at most 320 px wide, and its bar fill
  `rgb(255, 255, 255)`.
- `reel-layout.spec.ts` also checks at 1440x900 that the page background and the edit area are
  `rgb(0, 0, 0)` and the header and `tracks` are neither black nor transparent.
- `reel-layout.spec.ts` checks at 1440x900 that `preview-frame` and Export
  have the same non-zero `border-radius` on all four corners, and that the header, a version row,
  Zones, `play-toggle`, the library's add tile and `tracks` have `0px`; then, on the reels list, that
  a reel card's `tile-thumbnail` (with `overflow: hidden`) and its link have the preview frame's
  radius and its bin (`delete-reel`) has `0px` and a transparent background. It also checks that a Footage item, its lane and `tracks` stay `0px`, and, when the shown
  version has a non-footage `track-item`, that the first one has `4px` on all four corners. The seeded reel shows version 1 unchanged (`baselineEdit`: footage and
  captions only), so there it has none; the unit test of `trackItemClass` in `tracks-timeline.test.ts`
  checks `rounded-track` on every non-footage row's items and no rounding on footage. `photo-library.spec.ts` checks that a ready photo tile and its `tile-thumbnail` have `0px`.
- Measure edge-aligned elements from the root box, not `window.innerWidth` (see `AGENTS.md`).

## Rules

- The reel page never scrolls as a page at any size; lists scroll inside their own area.
- On desktop the edit area takes the full height, and Versions and the library take the full height
  beside it; never put a panel under them. The DOM order (edit, Versions, library) is the tab order; do
  not reorder it with CSS `order`.
- Do not measure the window in JavaScript to size the layout; keep it CSS, with `min-h-0` on growing
  children.
- The ruler is the one scrubber: the only focusable and draggable element in the tracks timeline, and
  the player's control row has no Position slider. Never add a second seek control.
- While the preview is expanded the tracks timeline (ruler included) and Zones are hidden; Play or
  Pause, the clock and the expand button stay. Expanding switches
  Zones off, and collapsing never switches it back on. The expanded state is
  never saved and starts collapsed on every open. Expanding or collapsing never remounts, pauses or
  seeks the player.
- The control row's outer glyphs sit on the tracks panel's edges: never inset the play or pause
  glyph from the panel's left edge or the expand glyph from its right edge, and never shrink their
  40x40 tap targets or push them outside the row to get there. Expanded, the row keeps those edges.
- Track items stay read only: nothing in the rows is focusable, selectable, clickable, draggable or
  editable.
- The timeline never shows a Captions or a Sounds row, and has no toggle to show hidden rows. Only
  the studio's `TRACK_ROWS` drops them; never remove those tracks from the edit or `resolveTimeline`.
- The ruler, every row's lane and the playhead share one time axis (same left edge after the label
  column, same width). The ruler maps a pointer from its own box, never the window.
- A ruler seek goes through the player's own seek (`PreviewPlayerHandle.seek`); never a second clock.
- Row spans come from `resolveTimeline`; never compute a second timeline for the display.
- The thumbnail's storage key is derived and signed on the server and never reaches a client
  component; select named columns from `reels`, never `*`.
- `ThumbnailGrid` stays free of reel-specific code.
- One-sentence UI texts in the studio (hints, statuses, empty states, blocked reasons, queue notes,
  refusals and errors) end without a full stop; a text of two or more sentences drops only its
  final one. Never add a full stop back to one.
- Do not unmount `UploadForm` when the upload dialog closes.
- A missing or malformed thumbnail or frames sprite is null, never a failure.
- The overlay never blocks the player's controls: `pointer-events` off except its own buttons.
- The overlay sits at the top right: its top edge on the preview frame's top edge and its right
  edge on the edit area's right content edge. Never offset it below the reel, never move it back
  to the left, and never make it wider than `max-w-xs` or its parent.
- Progress fills use `--color-primary`, never `--color-accent`.
- The studio's background is pitch black (`--color-surface`, `#000`); only the navigation (header
  bars, the phone's tab bar), the tracks timeline are lifted
  (`--color-chrome`). Never give another area a lifted or tinted background; use tokens, never raw
  colours.
- One corner radius (`--radius-reel`) and only on the reel preview, Export, the reel cards in the reels list (thumbnail and focus ring, through
  `ThumbnailGrid`'s `rounded`, set by the reels list only) and the reels list's **+** upload button. The one exception: track items in the
  Behind, Hook, Accents and Transitions rows have a small 4px radius (`rounded-track`, from
  `--radius-track`); Footage clips, lanes, the ruler,
  the playhead and the tracks panel stay square. Nothing else is rounded, photo tiles and add tiles
  included. Never add another `rounded-*` class, inline `borderRadius` or CSS `border-radius` in the
  studio.

## Notes

- Touches `apps/worker` (the `preview_copies` step, version 3, so existing reels re-run that step to
  get a thumbnail and a frames sprite), `fixtures/pipeline/` and `.adw/project.md`; most of the change
  is in `apps/studio`.
- Other docs to read with it: `app_docs/studio.md` (its reels-list and `LiveReel` lines predate this
  layout: `ReelList` is replaced by `ThumbnailGrid`), `app_docs/preview.md`, `app_docs/change-requests.md`, `app_docs/status.md`,
  `app_docs/photo-library.md`.
- Out of scope: editing from the timeline.
