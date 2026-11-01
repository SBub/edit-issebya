# Footage upload: resumable multipart upload straight to R2

**Specifications:**

- specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md

## Overview

The owner sends a clip from the studio's upload form straight from the browser to Cloudflare R2 as
an S3 multipart upload in fixed 10 MiB parts. The studio's server signs every request after an
ownership check but never sees the bytes. A failed part is sent again on its own, a reload resumes
when the owner picks the same file again, Cancel marks the reel `failed`, and completion is
idempotent: one reel always has one `process` job.

## How it works

### Flow

1. `UploadForm.tsx` checks the file against `MAX_UPLOAD_BYTES`, then calls `createUpload`
   (`apps/studio/src/app/upload-actions.ts`). It validates the name, size, type and extension and
   inserts the `uploading` reel through the user's own client (`createUploadFor` in
   `apps/studio/src/lib/upload-service.ts`), returning the reel id and key.
2. `startUpload` (`apps/studio/src/lib/multipart-upload.ts`) builds one Uppy instance for this
   upload. Uppy asks `signUploadRequest` to sign each S3 request and sends it to the signed URL
   itself: create (`POST ?uploads`), each part (`PUT ?partNumber&uploadId`), list (`GET ?uploadId`)
   when resuming or retrying, and complete (`POST ?uploadId` with the parts XML).
3. When Uppy reports success, the form calls `finishUpload`, which HEADs the stored object and
   calls `finish_upload`. The form then sends `studio_footage_uploaded` and goes to
   `/reels/<id>`.

### Part size and limit

- `PART_BYTES` (`apps/studio/src/lib/upload.ts`) is 10 MiB. Every part but the last is exactly this
  size: S3 and R2 need at least 5 MiB for every part but the last, and R2 needs equal part sizes.
- `MAX_UPLOAD_BYTES` is 1 GiB, the studio's own limit. The browser refuses a larger file before
  anything is created, with "Pick a clip up to 1 GB."; `parseUploadRequest` refuses it again on the
  server. A file of exactly 1 GiB is accepted.

### Uploader

- `@uppy/core` and `@uppy/aws-s3` 6.3.0, with `shouldUseMultipart: true` (every file, even one
  part), `getChunkSize: () => PART_BYTES`, `limit: 1` and `generateObjectKey` returning the key
  `createUpload` gave. No Uppy UI plugin is loaded.
- `@uppy/golden-retriever` is not used: its IndexedDB store caps a file at 10 MiB, so footage would
  always come back as a "ghost" the owner must pick again anyway. What must survive a reload is a
  few strings, kept in one `localStorage` record (see Resume).

### Signing per request

`signUploadRequest` passes each request to `signUploadRequestFor`, which parses it with
`parseSignRequest` (only the four multipart kinds pass; a single PutObject and every `DELETE` are
refused, the client's `expiresIn` is ignored) and signs it for 900 seconds only when the key is the
`source_key` of a reel the caller can see (RLS) in `uploading`. R2 binds an upload id to its key, so
another owner's upload id is useless with this key; the upload id itself is never stored.

| Action            | Implemented as                                                                                                       | Check                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| create            | `createUpload({ name, bytes, type })` inserts the reel, then `signUploadRequest({ method: "POST", key })`            | session; insert policy; then the key check below                                     |
| sign part         | `signUploadRequest({ method: "PUT", key, uploadId, partNumber })`                                                    | session; `key` is the `source_key` of a reel the caller can see (RLS) in `uploading` |
| list parts        | `signUploadRequest({ method: "GET", key, uploadId })`                                                                | same                                                                                 |
| complete (S3)     | `signUploadRequest({ method: "POST", key, uploadId })`                                                               | same                                                                                 |
| complete (studio) | `finishUpload({ reelId })`: HEADs the object (its real size, never the browser's number) and calls `finish_upload`   | session; RLS read of the reel; `finish_upload` checks the owner                      |
| abort             | `abortUpload({ reelId, uploadId })`: aborts the multipart upload in storage on the server, then calls `abort_upload` | session; RLS read of the reel; `abort_upload` checks the owner                       |

### Retry

- A failed part makes Uppy fail the file (`upload-error`). `startUpload` waits `retryDelayMs(attempt)`
  (1, 2, 4, 8 and 15 seconds, then it gives up) and calls `uppy.retryUpload`, which lists the parts
  storage already holds and sends only the missing ones. A finished part resets the attempt count.
- An `online` event on `window` retries at once instead of waiting out the backoff.
- Once the retries are spent the form shows the failure; the resume record stays, so picking the
  file again continues.

### Resume

- After each finished part `startUpload` writes one `localStorage` record under
  `studio-upload-resume` (`RESUME_STORAGE_KEY` in `apps/studio/src/lib/upload-resume.ts`): reel id,
  key, upload id, file name, size and last-modified time.
- After a reload the form shows "The upload of <name> stopped. Pick the same file to continue." When
  the picked file matches the record (`matchesFile`: name, size and last-modified), `startUpload`
  sets the file's `s3Multipart` state (`{ uploadId, key }`) before uploading, so Uppy lists the
  parts and sends only the rest.
- The record is removed on finish, on Cancel and on Discard. Discard, or picking a different file,
  aborts the stopped upload and marks its reel `failed` (`abortUpload`).

### Abort

- Cancel calls `abortUpload` (`abortUploadFor`): for an `uploading` reel with a valid upload id the
  server first aborts the multipart upload in storage (`abortMultipart`, no error when it is already
  gone), then `abort_upload` marks the reel `failed`. The row is never deleted.
- `abort_upload(p_reel_id)` (`supabase/migrations/20261101120000_multipart_upload.sql`,
  `security definer`, executable by `authenticated` only) moves the owner's `uploading` reel to
  `failed`, returns quietly when it is already `failed`, and refuses anything else.
- Uppy's own fire-and-forget abort (`DELETE`) is never signed.

### Idempotent finish

- `finish_upload(p_reel_id, p_bytes)` locks the owner's reel row (`for update`). An `uploading` reel
  becomes `uploaded` with `source_bytes` and gets one `process` job; a later call answers that same
  job's id. Concurrent calls serialise on the lock, so one reel always has one `process` job.
- `p_bytes` comes from a server-side HEAD of the stored object, never from the browser. No object
  yet answers `incomplete`.

### The fake

- `packages/storage/src/fake.ts` signs same-origin URLs to the studio's
  `/studio/api/e2e-storage-mock/[...key]` route with S3's query strings. `fakeMultipart`
  (`packages/storage/src/fake-multipart.ts`) keeps the multipart state as files under
  `.e2e-storage/.multipart/<uploadId>/`, binds each upload id to its key (every operation compares
  it), checks each part's ETag on complete and assembles the object. A leading dot is never a valid
  key, so `list` skips that folder.
- The mock route answers `POST ?uploads` (create), `PUT ?partNumber&uploadId` (part),
  `GET ?uploadId` (list), `POST ?uploadId` (complete) and `DELETE ?uploadId` (abort), plus a plain
  `GET` of the object's bytes and `HEAD` of its size. A plain `PUT` is refused. Every method answers
  404 unless `E2E_MOCK_STORAGE` is exactly `"true"`.

## How to Use

1. Sign in to the studio and pick a clip (MP4, MOV, M4V or WebM, up to 1 GB) under "Upload".
2. Press Upload. The progress bar fills; a dropped connection retries by itself.
3. Press Cancel to stop: the reel is marked `failed`.
4. After a reload, pick the same file again to continue, or press Discard.

## Configuration

- No new variables. The studio's R2 key (`R2_STUDIO_ACCESS_KEY_ID`, `R2_STUDIO_SECRET_ACCESS_KEY`)
  needs multipart rights on the bucket; an R2 "Object Read & Write" token has them.
- Owner steps on the R2 bucket:
  - CORS for the studio's origins: allow `PUT` (parts), `POST` (create and complete) and `GET`
    (list parts), allow the `Content-Type` header, and expose `ETag`. `DELETE` is not needed, abort
    runs on the server.
  - Lifecycle: abort incomplete multipart uploads after 3 days, for each prefix in use.
- The pipeline cannot verify either step, nor real network drops.

## Testing

- Unit (`yarn test`): `packages/storage/src/fake-multipart.test.ts` (byte-exact assembly, listing,
  key binding, bad and unknown upload ids, ETag check, repeat complete, abort, no path out of the
  root), `packages/storage/src/fake.test.ts` (the signers' URL shapes, `list` skips `.multipart`),
  `packages/storage/src/r2.test.ts` (each presigned multipart URL), `apps/studio/src/lib/upload.test.ts`
  (the 1 GiB boundary, `parseSignRequest`, `retryDelayMs`),
  `apps/studio/src/lib/upload-resume.test.ts` (record round-trip, malformed input, file matching),
  `apps/studio/src/lib/storage.test.ts` (`signUploadPart` through the fake and R2) and
  `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts` (flag gate, every S3 verb, plain
  PUT refused).
- DB integration (`yarn test:db`): `apps/studio/db-tests/upload.test.ts` (signing ownership,
  idempotent `finish_upload` including concurrent calls, `abort_upload`).
- E2E: `apps/studio/e2e/multipart-upload.spec.ts` sends a 35 MiB clip in 10 MiB parts: a failed
  part, a reload that resumes, Cancel, the 1 GiB limit. Each test that finishes an upload asserts `studio_footage_uploaded`
  exactly once. `apps/studio/e2e/upload.spec.ts` still covers a one-part upload.

## Rules

- Never send file bytes through the studio's server; only the browser talks to R2 (the mock route
  is R2's stand-in, inert unless `E2E_MOCK_STORAGE` is exactly `"true"`).
- Never sign a request before checking the session and that the key is the caller's own
  `uploading` reel's `source_key`.
- Never sign a single PutObject or a DELETE for the browser.
- Do not take `source_bytes` from the browser; it is the stored object's size.
- `finish_upload` stays idempotent: one reel, one `process` job, however many calls.
- Do not store the upload id in `reels` without changing the insert-columns rule in
  `app_docs/studio.md` in the same change.
- Do not create an Uppy instance at module load or in render.

## Notes

- A reload restores the upload's identity, not the file: a browser never lets a page re-read a
  local file without the owner picking it again. The stopped notice says so.
- The `localStorage` record is functional state, never sent anywhere, and the studio is used only
  by the owner, so it needs no legal-page change.
- Out of scope: upload from a phone or a link, several clips per reel, checking the file's format
  and length (a later worker slice), a retry limit on jobs.
