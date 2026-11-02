# Upload

**Specifications:**

- specs/issue-36-adw-849f9390-sdlc_planner-resumable-multipart-footage-upload.md

## Overview

Footage goes from the browser straight to R2 as a multipart upload in 10 MiB parts
(`PART_SIZE_BYTES`), up to 5 GiB (`MAX_UPLOAD_BYTES`, a product bound, not an R2 limit: 10 MiB parts
allow 10,000 parts). An interrupted upload resumes after a reload from the parts storage already
holds, and the owner can cancel one while it runs. The studio's server never sees the file's bytes:
it only creates, signs, lists, completes and aborts.

## How it works

### Browser

- `apps/studio/src/lib/uploader.ts`: `createUploader` builds a headless `@uppy/core` 6.3.0 with
  `@uppy/aws-s3` 6.3.0 (no Uppy UI; `UploadForm.tsx` draws its own progress bar). It is created per
  upload inside the component, never at module load, and closed when the form goes away. A
  finished upload reports 100 before the page goes to the reel, because Uppy's total progress is
  throttled (500 ms, trailing) and its own 100 can arrive after `upload()` resolves.
- The plugin runs in `companionEndpoint` mode pointed at `UPLOAD_ENDPOINT` (`/studio/api/uploads`,
  `apps/studio/src/lib/upload.ts`), with `shouldUseMultipart: true`, a fixed `getChunkSize`
  (`PART_SIZE_BYTES`: R2 requires every part but the last to be the same size), `allowedMetaFields:
["bytes"]` (the create request carries the file's size) and `limit: 1`.
- Parts go one at a time, each `PUT` straight to its own signed storage URL. A failed part request
  (a network error or a 5xx) is retried on its own by Uppy's built-in policy, three retries with
  backoff, and only that part is sent again.
- `start` resolves to `finished` (with the reel id read from the completed key), `cancelled` or
  `failed`. `cancel` calls Uppy's `cancelAll`, which sends the abort request.

### Design change from the spec

The spec planned three server actions plus one parts route, four parallel parts and custom retry
delays. `@uppy/aws-s3` in Companion mode speaks a fixed HTTP protocol, so the studio implements that
protocol itself as route handlers (no Companion server), and parts are sent sequentially with Uppy's
default retries. The routes under `apps/studio/src/app/api/uploads/s3/multipart/`, JSON only:

- `POST` (create): validates name, size, `video/` type and extension (`mp4`, `mov`, `m4v`, `webm`)
  through `parseUploadRequest` in `upload.ts`, creates the multipart upload, inserts the `uploading`
  reel with `source_key` and `source_upload_id` through the user's own client (aborting the upload
  if the insert fails) and answers the key and upload id.
- `GET [uploadId]`: lists the parts storage already holds (the `key` query parameter Uppy sends is
  ignored).
- `DELETE [uploadId]` (abort): storage drops the parts, then `fail_upload` marks the reel `failed`.
- `GET [uploadId]/[partNumber]`: signs one part URL (`PART_URL_SECONDS`, 900 seconds) for the reel
  row's key.
- `POST [uploadId]/complete`: assembles the object, then calls `finish_upload` with the size
  storage reports.

The logic lives in `apps/studio/src/lib/upload-server.ts`; `apps/studio/src/lib/upload-routes.ts`
is the shared request and response glue (per-request dependencies, JSON body only when the content
type is `application/json`, `Cache-Control: no-store` answers).

### Ownership

Every route reads the session. After create, the reel is looked up by `source_upload_id` through
the user's own client, so RLS returns only the caller's reel; the key and upload id come from that
row, never from the browser. Another user's reel and a missing one get the same `404 not-found`; a
signed-out caller gets `401`. Sign, list and abort need the reel still `uploading`.

### Database

`supabase/migrations/20261101212954_multipart_upload.sql`:

- `reels.source_upload_id`: checked format (`^[A-Za-z0-9._~-]+$`, at most 1024 characters), unique
  where set, insertable by `authenticated` under the existing uploading-only insert policy.
- `finish_upload(p_reel_id, p_bytes)` is idempotent: the owner's `uploading` reel becomes
  `uploaded` with its size and one `process` job is queued; a second call (a retried complete)
  returns that same job and inserts nothing. The row lock queues two concurrent calls. A `failed`
  reel, another owner's reel and a call without a user fail the same way.
- `fail_upload(p_reel_id)` marks the caller's `uploading` reel `failed` (already `failed` is a
  no-op). The reel stays as `failed`, since `authenticated` has no delete on `reels`.
- Both are `security definer`, executable by `authenticated` only. The size `finish_upload` records
  comes from storage (`head` after assembling), never from the browser.
- `supabase/migrations/20261101233625_storage_records.sql` replaced `finish_upload`: in the same
  transaction it also records the raw footage's `source` row in `stored_files` (step `upload`, the
  size from storage), once; a repeated call records nothing more. See `app_docs/storage.md`.

### Resume

`apps/studio/src/lib/upload-resume.ts` keeps one record in `localStorage` (`studio_upload_resume`:
reel id, key, upload id, file name, size, last modified), written as soon as the multipart upload
exists; a malformed record reads as none and is cleared. After a reload the form says "An upload of
`<name>` was interrupted. Pick the same file to resume." When the picked file matches
(`matchesResume`: same name, size and modified time), Uppy is given `{ key, uploadId }`, lists the
stored parts and sends only the missing ones. Any other file starts a fresh upload. The record is
cleared on finish and on cancel, and also when a resumed attempt fails (the upload finished
elsewhere, was cancelled or is gone), so the next attempt starts over ("Pick the file again to start
over"). The bytes are never kept: a browser cannot read a picked file after a reload.

### Storage

- `packages/storage/src/storage.ts`: the `Storage` interface's multipart methods
  `createMultipartUpload`, `signUploadPart`, `listUploadParts`, `completeMultipartUpload` (answers
  `"missing"` when the upload is gone; complete then checks whether the object already exists, a
  lost earlier answer) and `abortMultipartUpload`, with `isUploadId`, `isPartNumber` and
  `MAX_PART_NUMBER` (10000). The single-object `signUpload` is gone.
- The R2 implementation uses the S3 multipart commands.
- The fake (`packages/storage/src/fake.ts`) keeps an unfinished upload under
  `<root>/.multipart/<uploadId>/` (`meta.json` with its key, one `<n>.part` per part), checks each
  part's ETag and assembles the object on complete. That folder is invisible to `list()`.

### Mock route

Under `E2E_MOCK_STORAGE=true` (exactly) the studio's fake signs part URLs to
`/studio/api/e2e-storage-mock/<key>?uploadId=..&partNumber=n`. That route's `PUT` accepts upload
parts only (answering the part's quoted MD5 as its `ETag`, exposed to the browser, as R2 does) and
there is no single-object `PUT`. Every method answers 404 unless the flag is exactly `"true"`. The
route is left out of the `apps/studio/src/proxy.ts` matcher because proxy buffers a body only up to
10 MB and a part is 10 MiB.

### Event

`studio_footage_uploaded` (`reel_id`, `app`) fires once, after complete succeeds, from
`UploadForm.tsx`; never after a cancel (`app_docs/measurement.md`).

## Owner steps

Not done by the pipeline and not verified by it, any more than real network drops are:

1. R2 bucket CORS allowing `PUT` from the studio origins, with `ETag` in `ExposeHeaders`. Listing
   and completing go through the studio's routes, so the browser only PUTs to R2. Without the
   exposed `ETag` Uppy cannot read a part's ETag and every complete fails.
2. A lifecycle rule aborting incomplete multipart uploads after 3 days, for each key prefix in use.

## Testing

- Unit (`yarn test`): `packages/storage/src/r2.test.ts` and `fake.test.ts` (the multipart cases),
  `apps/studio/src/lib/upload-server.test.ts`, `upload-resume.test.ts`, `upload.test.ts`, and
  `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts` (the part `PUT`).
- DB (`yarn turbo run test:db --filter=./apps/studio`): `apps/studio/db-tests/rls.test.ts` covers
  `finish_upload` (one job, idempotent repeat, refused for another owner, no user or a bad size),
  `fail_upload`, and `source_upload_id` (owner-only read, malformed or reused value refused).
- E2E: `apps/studio/e2e/multipart-upload.spec.ts`, five tests through the mock route: a 35 MiB clip
  goes up in four 10 MiB parts with a progress bar; one failed part is sent again alone and the
  upload completes; after a reload the same file sends only the missing parts; another user and a
  signed-out caller cannot sign, list, complete or abort; cancel leaves the reel `failed` with no
  parts and no job. A reel an earlier test left `uploading` is skipped when a test picks its own
  uploading reel. `apps/studio/e2e/upload.spec.ts` is unchanged.

## Rules

- Never send file bytes to the studio's server; the browser PUTs parts straight to storage. The
  mock route is R2's double, inert unless `E2E_MOCK_STORAGE` is exactly `"true"`.
- Complete is idempotent: a repeated complete leaves one reel and one `process` job.
- Every route checks the session and finds the reel by `source_upload_id` through RLS, taking the
  key and upload id from the row, never from the browser.
- Never call `finish_upload` with a size the browser reported; the size comes from storage.
- Never use `@uppy/golden-retriever`'s file store for footage; resume keeps only the record.
- Keep a fixed part size: every part but the last the same size.
- Do not add Uppy UI packages; the uploader stays headless.
- Never go to the reel after a finished upload before the bar shows 100.

## Notes

- Bucket CORS, the lifecycle rule and real network drops are outside what the pipeline verifies
  (see Owner steps).
