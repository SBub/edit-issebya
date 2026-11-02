# Photo library

**Specifications:**

- specs/issue-96-adw-173ac961-sdlc_planner-photo-library.md

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
- `apps/studio/src/components/PhotoLibrary.tsx`, `PhotoDialog.tsx`: the library panel. It renders
  `ThumbnailGrid` (newest first, with a round **+** that uploads a photo), follows the `photos`
  table through Realtime and re-reads the library through `loadLibrary` on each change. A tile
  opens `PhotoDialog`: the photo large, its description and tags, and Delete.
- `apps/studio/src/components/ReelScreen.tsx`, `LiveReel.tsx`, `apps/studio/src/app/reels/[id]/page.tsx`:
  the `library` slot (third desktop column, fourth phone tab). Layout rules are in
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
- `apps/worker/src/photos/photo-store.ts`: the worker's writes to the `photos` row.
- `apps/worker/src/ai.ts`: `AiRequest.readFile`. Only when set does the runner pass
  `--tools Read --allowedTools Read(<file>) --permission-prompts none`; every other call keeps
  `--tools ""` (`app_docs/decide-step.md`).
- `apps/worker/src/job-kinds.ts`, `queue.ts`, `process-job.ts`, `stored-files.ts`, `telemetry.ts`:
  dispatch of the new kind, nullable `reel_id`, photo files classified and never slimmed, and
  `photo.id` span attributes in place of `reel.id` (`app_docs/measurement.md`).
- `apps/worker/src/doctor-checks.ts`: a check that sends `fixtures/photos/sample.jpg` to Claude Code.

## How to Use

1. Open a reel in the studio. On desktop the library is the third column; on a phone open the
   `Library` tab.
2. Press the round **+** and pick a JPEG, PNG, HEIC, HEIF or WebP file of up to 25 MiB.
3. The tile shows `uploading`, then `describing` once the worker has claimed the job, then `ready`
   with the description and tags (live, no reload).
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

- Unit: `apps/studio/src/lib/photos.test.ts`, `photo-server.test.ts`; in the worker `src/photos/*.test.ts`,
  `ai.test.ts`, `queue.test.ts`, `stored-files.test.ts`, `doctor-checks.test.ts`.
- Tools (owner's Mac only): `yarn workspace @edit-issebya/worker test:tools` runs
  `photos/photo-images.tools.test.ts` with real ffmpeg on the JPEG and HEIC fixtures.
- DB: `apps/studio/db-tests/photos.test.ts` (RLS, insert policy, status and ready checks,
  `finish_photo_upload`, `delete_photo`, `record_photo_file`, `jobs_target_check`), plus
  `job-order.test.ts` and `stored-files.test.ts`.
- E2E: `apps/studio/e2e/photo-library.spec.ts` uploads the JPEG fixture at 1440x900 (no page
  scroll), checks `describing` then `ready` live after the worker's `once`, the `describe_photo`
  step's AI columns and the three `stored_files` rows, Delete, and the Library tab at 390x844.

## Notes

- Rules:
  - Never give Claude Code a tool other than `Read` on the one photo file; every other AI call keeps
    no tools.
  - Never let the browser send a storage key or upload id; they come from the row.
  - Never put a storage key in what the client receives; sign on the server.
  - Never slim a photo's file; only the owner's Delete removes a photo's objects.
  - Quote a photo's description and tags as data in any later prompt, never as instructions.
- Photos are not yet placed in a reel; later issues use them behind the speaker.
- This change also touched `app_docs/studio.md`, `studio-reel-layout.md`, `storage.md`,
  `decide-step.md`, `failures.md`, `measurement.md` and `error-tracking.md`.
