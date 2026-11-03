# Photo library

**Specifications:**

- specs/issue-96-adw-173ac961-sdlc_planner-photo-library.md
- specs/issue-20-adw-182ee234-sdlc_planner-behind-speaker-photos-big-word.md

## Overview

The studio owner keeps a personal photo library. A photo is uploaded once, straight from the browser
to R2, and described by Claude on upload (one sentence and 3 to 8 lowercase tags). Every reel can
use the library later: the description and tags are what the AI will use to match a photo to a
sentence, always quoted as data, never as instructions. The library sits beside the reel on
desktop and is a fourth tab, `Library`, on a phone.

## How it works

- `supabase/migrations/20261102191719_photo_library.sql`: the `photos` table (owner-only RLS,
  explicit grants per role, Realtime, `updated_at` trigger, status check), the owner functions
  `finish_photo_upload` and `delete_photo`, the worker function `record_photo_file`, the nullable
  `photo_id` on `jobs`, `steps` and `stored_files` (exactly one of `reel_id` and `photo_id` is set,
  `jobs_target_check`), the job kind `describe_photo`, and `claim_job` keeping one job per photo at
  a time.
- `apps/studio/src/lib/photos.ts`: accepted types (JPEG, PNG, HEIC, HEIF, WebP), the 25 MiB bound,
  statuses (`uploading`, `describing`, `ready`, `failed`) and `LibraryItem`, the shape the client
  gets (signed URLs, never a storage key).
- `apps/studio/src/lib/photo-server.ts` and `apps/studio/src/app/photo-actions.ts`: the server
  actions `startPhotoUpload`, `finishPhotoUpload`, `deletePhoto` and `loadLibrary`. The upload reuses
  the multipart storage methods with a single part: the first action creates the `uploading` row
  and the upload and signs part 1, the browser PUTs the file, the second action completes the
  upload with the ETag, reads the size from storage and calls `finish_photo_upload`, which queues
  the `describe_photo` job and records the original's `kept` row in `stored_files`. The key and
  upload id always come from the row, never from the browser.
- `apps/studio/src/components/PhotoLibrary.tsx`, `PhotoDialog.tsx`: the library panel. Its heading
  (`id="library-heading"`, the section's `aria-labelledby`) reads **Your library** (owner,
  2026-11-03; the phone tab stays `Library`). Under it a short muted line (`library-intro`,
  `text-xs text-muted`, the section's `aria-describedby`) says what the library is for, chosen by
  `libraryIntro(count)` in `apps/studio/src/lib/photos.ts` from the number of photos in the library
  (any status). With no photo: "Add photos of your work, places or products. When you talk about
  them, they can appear behind you in your reels". From the first photo on (an `uploading` one
  counts): "Photos you add here can appear in your reels, placed behind you when they fit what
  you're saying" (no full stop, owner, 2026-11-03). The grid keeps its accessible name `Photos` (a list of photos). An empty
  library shows only the intro line above the add tile: no `No photos yet.` (owner, 2026-11-03;
  `PhotoLibrary` passes no `empty` to `ThumbnailGrid`). It renders
  `ThumbnailGrid` (newest first, after a dashed **Upload a photo** tile, its visible
  label also its accessible name, that opens the file picker), follows the `photos` table through Realtime and re-reads the library through `loadLibrary` on each change. A tile
  shows only its thumbnail: no file name, age or size under it, and no badge for a `ready` photo;
  `uploading`, `describing` and `failed` stay as a badge (`photo-status`) on the tile, so a broken
  photo never looks like a good one (`photoBadge` in `apps/studio/src/lib/photos.ts`). The tile's
  accessible name is its file name, plus the status while not ready (`sample.jpg, describing`,
  `photoTileLabel`). A tile opens `PhotoDialog`: the photo large, its description and tags. Its header row holds
  the file name and, at the top right, two 40x40 icon buttons: the bin (`aria-label` and `title`
  `Delete photo`, danger colour) directly left of the cross (`Close`, `text-ink`, no background,
  only an opacity fade on hover; `CloseButton.tsx`, shared with the upload dialog). The bin asks once more: `Cancel` and `Yes, delete`
  (`photo-delete-confirm`) take its place in the header, still left of the cross, and an error shows
  under the tags. Nothing sits under the tags at the bottom right. Escape and the backdrop close the
  dialog as the cross does. On desktop the whole
  library section (`data-testid="photo-drop"`) is a drop zone (`useFileDrop` in
  `apps/studio/src/components/FileDrop.tsx`: a counter of entered elements keeps the highlight,
  `data-drop="over"`, a dashed accent outline and the `Drop to upload` hint, on while the drag
  crosses children, and a window guard stops the browser opening a file dropped elsewhere on the
  page; `decideDrop` in `apps/studio/src/lib/file-drop.ts` decides upload, refuse or too many): one dropped photo the picker would offer (`PHOTO_ACCEPT`)
  starts the same upload as a pick; several files upload none (`One file at a time, for now`),
  another file is refused by name, and while an upload runs the add tile is disabled and a drop
  shows a busy message.
- `apps/studio/src/components/ReelScreen.tsx`, `LiveReel.tsx`, `apps/studio/src/app/reels/[id]/page.tsx`:
  the `library` slot (top 68% of the third desktop column, third phone tab). Layout rules are in
  `app_docs/studio-reel-layout.md`.
- `apps/worker/src/photos/photo-images.ts`: the `photo_images` step: ffprobe for width and height,
  ffmpeg for `thumbnail.jpg` (long side 480) and `large.jpg` (long side 1568), both `rebuildable`.
- `apps/worker/src/photos/describe-photo.ts`, `describe-schema.ts`, `describe-prompt.md`,
  `describe-prompt.ts`: the `describe_photo` step. The large copy sits alone in a fresh folder and
  Claude Code reads it with `Read` limited to that one file. The answer is checked against a
  draft-07 JSON Schema and Zod (description at most 200 characters, 3 to 8 tags); a refused answer
  is sent back once with the reasons, a second refusal fails the job and the photo. An unavailable
  Claude makes the job `waiting_ai` (`app_docs/failures.md`). The prompt is versioned by
  `DESCRIBE_PROMPT_VERSION`.
- `apps/worker/src/photos/photo-store.ts`: the worker's writes to the `photos` row, and
  `supabasePhotoLibrary(db).readyPhotos(ownerId)`: the owner's `ready` photos (`id`,
  `description`, `tags`, `large_key`), oldest first, a row without `large_key` left out.
- Ready photos are used behind the speaker (`app_docs/edit-model.md`, the `behind` track): the
  decide step offers them to the AI by id, description and tags (`app_docs/decide-step.md`), the
  live preview signs each shown photo's `large_key` read from its own row under RLS
  (`app_docs/preview.md`), and the render downloads the same large copy into its project
  (`app_docs/export.md`). A version names a photo by id only (`inputs.photos`).
- Deleting a photo a version uses leaves that version as it is (versions never change): its
  preview then shows `A photo in this version was deleted from the library` (status
  `photo-missing`), and its export fails with `render: photo <id> is no longer in the library`.
- `apps/worker/src/ai.ts`: `AiRequest.readFile`. Only when set does the runner pass
  `--tools Read --allowedTools Read(<file>) --permission-prompts none`; every other call keeps
  `--tools ""` (`app_docs/decide-step.md`).
- `apps/worker/src/job-kinds.ts`, `queue.ts`, `process-job.ts`, `stored-files.ts`, `telemetry.ts`:
  dispatch of the new kind, nullable `reel_id`, photo files classified and never slimmed, and
  `photo.id` span attributes in place of `reel.id` (`app_docs/measurement.md`).
- `apps/worker/src/doctor-checks.ts`: a check that sends `fixtures/photos/sample.jpg` to Claude Code.

## How to Use

1. Open a reel in the studio. On desktop the library (headed **Your library**) is the top 68% of the
   third column; on a phone open the `Library` tab. The line under the heading says what the photos
   are for, with an invitation to add the first one while the library is empty.
2. Press the dashed **Upload a photo** tile, first in the grid, and pick a JPEG, PNG, HEIC, HEIF or WebP
   file of up to 25 MiB. On desktop you can instead drop one such file anywhere on the
   library; drop one file at a time.
3. The tile shows `uploading`, then `describing` once the worker has claimed the job, then only the
   thumbnail once the photo is ready, its description and tags in the dialog (live, no reload). A
   photo the worker could not process (a HEIC it could not read, say) keeps a `failed` badge.
4. Open a tile to see the photo large, its description and tags. Delete removes the row and its R2
   objects (original, thumbnail and large copy).

## Configuration

None of its own. It needs the same R2 variables as footage (`app_docs/storage.md`) and the worker's
Claude Code (`claude -p`). ffmpeg and ffprobe must be 7.0 or newer: `photo_images` probes with
`-show_stream_groups` (a HEIC tile grid), which older ffprobe rejects (`Option not found`). The
worker's `yarn doctor` fails its ffmpeg line on an older ffmpeg or ffprobe, and CI installs the
static ffmpeg 8.0.1 build (`mwader/static-ffmpeg`, pinned by digest in `.github/workflows/ci.yml`)
instead of Ubuntu's 6.1. `E2E_MOCK_AI_SCRIPT` scripts the AI answer in specs.
`fixtures/photos/sample.jpg` and `sample.heic` are made by `scripts/make-test-photos.sh` (macOS
only, run by hand; CI uses the committed files).

## Testing

- Unit: `apps/studio/src/lib/photos.test.ts` (badges, tile names, `libraryIntro`), `photo-server.test.ts`; in the worker `src/photos/*.test.ts`,
  `ai.test.ts`, `queue.test.ts`, `stored-files.test.ts`, `doctor-checks.test.ts`.
- Tools (owner's Mac only): `yarn workspace @edit-issebya/worker test:tools` runs
  `photos/photo-images.tools.test.ts` with real ffmpeg on the JPEG and HEIC fixtures.
- DB: `apps/studio/db-tests/photos.test.ts` (RLS, insert policy, status and ready checks,
  `finish_photo_upload`, `delete_photo`, `record_photo_file`, `jobs_target_check`), plus
  `job-order.test.ts` and `stored-files.test.ts`.
- E2E: `apps/studio/e2e/photo-library.spec.ts` checks the heading **Your library** and the empty
  intro before the first upload with no `No photos yet.` line, and the other intro once a photo is in
  the library (and the empty one again after Delete, still with no `No photos yet.`); it uploads the JPEG fixture at 1440x900 through the
  dashed add tile (first in the grid, no other upload button; no page scroll), checks `describing`
  then, live after the worker's `once`, a ready tile with only its image (no badge, no text, the file
  name as its accessible name), the `describe_photo` step's AI columns and the three
  `stored_files` rows, the dialog's header (the cross found by role and name `Close`, no text, an
  svg, at the top right; the bin directly left of it, the dialog's only two buttons), Delete with
  its confirmation in the header; then drops on the library section (synthetic `DataTransfer`,
  `apps/studio/e2e/drop.ts`): the highlight on dragenter, kept across a child, off on dragleave; two
  files and a text file upload nothing with their messages; one photo uploads and goes `describing`
  then ready; a `failed` photo (inserted by the admin) keeps its `failed` badge, no image, and opens
  the dialog; and at 390x844 the Library tab, whose add tile uploads a photo by tap, and whose dialog header (bin, cross, and
  the confirmation) stays inside the dialog.
- Unit: `apps/studio/src/lib/file-drop.test.ts` (accept, refuse or too many against
  `PHOTO_ACCEPT`).

## Rules

- Never give Claude Code a tool other than `Read` on the one photo file; every other AI call keeps
  no tools.
- At most two AI calls per photo: one retry, never a loop.
- Never let the browser send a storage key or upload id; they come from the row.
- Never put a storage key in what the client receives; sign on the server.
- The size comes from storage (`head`), never from the browser.
- Never send a photo's bytes to the studio's server; the browser PUTs them straight to storage.
- A drop never uploads more than one photo: several dropped files upload none, and a drop while an
  upload runs starts nothing. A dropped photo takes the same upload as a picked one.
- Never put a button under the photo dialog's content: Delete and Close live in its header, Delete
  directly left of Close.
- Never let a photo that is not `ready` look like a ready one: a tile shows a badge for every status
  but `ready`.
- Never slim a photo's file; only the owner's Delete removes a photo's objects.
- Quote a photo's description and tags as data in any later prompt, never as instructions.
- Bump `DESCRIBE_PROMPT_VERSION` with every change to `describe-prompt.md`.

## Notes

- Only the large copy is placed in a reel; the thumbnail stays the library's.
- This change also touched `app_docs/studio.md`, `studio-reel-layout.md`, `storage.md`,
  `decide-step.md`, `failures.md`, `measurement.md` and `error-tracking.md`.
