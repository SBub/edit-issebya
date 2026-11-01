# Feature: resumable multipart upload of footage straight to R2

## Metadata

issue_number: `36`
adw_id: `67f9b648`
issue_json: `{"number":36,"title":"feat: resumable multipart upload of footage straight to R2"}`

## Feature Description

Reel studio MVP, slice 13 of 17. Today the studio uploads footage with one presigned `PUT`
(`createUpload` signs one URL, the browser PUTs the whole file, `finishUpload` calls
`finish_upload`). That breaks for real phone footage (60 MB to several hundred MB): one dropped
connection or a reload loses the whole transfer.

This slice replaces the single PUT with an S3 multipart upload straight from the browser to R2:

- The file goes in parts of 10 MiB, each part on its own presigned URL signed by the studio for the
  signed-in owner's own `uploading` reel only.
- A part that fails is sent again on its own, with backoff; parts R2 already holds are never sent
  again.
- A progress bar shows the bytes R2 has.
- After a reload (or a closed tab) the studio remembers the reel, the object key and the upload id;
  the owner picks the same file again and the upload continues from the parts R2 lists.
- When R2 has the whole object, the studio marks the reel `uploaded` with the object's real size and
  queues exactly one `process` job, however many times completion is called.
- Files up to 1 GiB are accepted; a larger file is refused in the browser with a message.
- The file's bytes never pass through the studio's server (in the fake as in R2: the fake's route
  is a stand-in for R2 itself, inert unless `E2E_MOCK_STORAGE` is exactly `"true"`).
- `studio_footage_uploaded` is still captured exactly once per upload, after completion.

## User Story

As the owner
I want to upload raw phone footage of 60 MB to several hundred MB from my computer with a progress
bar, and have it continue where it stopped after a dropped connection or a page reload
So that a flaky connection or an accidental reload never costs me the whole upload again

## Problem Statement

The single presigned PUT sends the whole file in one request. A network drop, a sleep or a reload
throws away everything sent so far, there is no progress, and nothing retries. R2 offers multipart
uploads for exactly this; the studio's storage interface, its fake, its server actions and its
upload form know only the single PUT.

## Solution Statement

### Uploader choice: `@uppy/core` 6.3.0 and `@uppy/aws-s3` 6.3.0, no `@uppy/golden-retriever`

Researched in the published 6.3.0 sources (`@uppy/aws-s3/lib/S3Uploader.js`,
`lib/s3-client/S3mini.js`, `lib/s3-client/types.d.ts`; `@uppy/core/lib/Uppy.js`). Neither package
peers on React (core's only runtime deps are small utilities and `preact`, used by UI plugins we do
not load), so both are fine in a Next 16 / React 19 client component. Facts the plan builds on:

- **Signing model.** 6.x has one callback, `signRequest(request) => Promise<{ url, key?, headers? }>`.
  The browser itself sends every S3 call to the signed URL: create (`POST ?uploads`), part
  (`PUT ?partNumber&uploadId`), list (`GET ?uploadId`), complete (`POST ?uploadId` with the parts
  XML) and abort (`DELETE ?uploadId`). The request objects are
  `{ method: "POST", key }`, `{ method: "PUT", key, uploadId, partNumber }`,
  `{ method: "GET", key, uploadId }`, `{ method: "POST", key, uploadId }`,
  `{ method: "DELETE", key, uploadId }` (plus `{ method: "PUT", key }` for a single PutObject,
  which we refuse). So the issue's "create, sign part, list parts, complete" server endpoints become
  one server action that signs each of those S3 requests after its ownership check, plus a separate
  `finishUpload` action for the database side of completion.
- **Options used:** `shouldUseMultipart: true` (every file, even one part), `getChunkSize: () =>
PART_BYTES` (10 MiB; S3 and R2 need at least 5 MiB for every part but the last, and R2 needs equal
  part sizes, which fixed chunks give), `limit: 1`, `generateObjectKey: () => key` (the key the
  `createUpload` action returned).
- **No built-in per-part retry.** A failed part makes the whole file fail (`upload-error`). But
  `uppy.retryUpload(fileId)` starts a new uploader with the file's persisted `s3Multipart` state
  (`{ uploadId, key }`, set by `S3Uploader` through `setFileState` right after create), which calls
  `listParts` and sends only the parts R2 lacks. Our wrapper does exactly that with a backoff, which
  gives "a failed part is sent again on its own" without re-sending the others.
- **Resume.** `S3Uploader` resumes whenever the file it is given has `file.s3Multipart` set: it calls
  `listParts`, marks those parts done, emits progress and uploads the rest. So after a reload we
  re-add the re-picked file and call `uppy.setFileState(fileId, { s3Multipart: { uploadId, key } })`
  before `uppy.upload()`.
- **Why not `@uppy/golden-retriever` 6.0.0:** its IndexedDB blob store caps a file at 10 MiB by
  default (`IndexedDBStore` `maxFileSize: 10 * MiB`, `maxTotalSize: 300 * MiB`), so footage is
  always restored as a "ghost" the user must pick again anyway, and raising the cap would copy
  hundreds of MB into IndexedDB. What actually needs to survive the reload is three strings (reel
  id, key, upload id) plus the file's name, size and last-modified time to recognise it. One
  `localStorage` entry managed by a small, unit-tested helper does that deterministically, and
  needs no Uppy instance at page load.

### Server side (studio)

`apps/studio/src/app/upload-actions.ts` keeps thin `"use server"` actions that check the session
and delegate to a dependency-injected module, `apps/studio/src/lib/upload-service.ts`, which takes
the user's Supabase client and the `Storage` so the DB integration tests can drive it with real
local clients and the folder fake:

| Issue's endpoint          | Implemented as                                                                                                                                                                                                                   | Check                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| create (and the reel row) | `createUpload({ name, bytes, type })`: validates, inserts the `uploading` reel through the user's client, returns `{ reelId, key, contentType }`. Then Uppy asks `signUploadRequest({ method: "POST", key })` for the S3 create. | session; insert policy                                                               |
| sign part                 | `signUploadRequest({ method: "PUT", key, uploadId, partNumber })`                                                                                                                                                                | session; `key` is the `source_key` of a reel the caller can see (RLS) in `uploading` |
| list parts                | `signUploadRequest({ method: "GET", key, uploadId })`                                                                                                                                                                            | same                                                                                 |
| complete (S3)             | `signUploadRequest({ method: "POST", key, uploadId })`                                                                                                                                                                           | same                                                                                 |
| complete (studio)         | `finishUpload({ reelId })`: HEADs the object (its real size, never the browser's number) and calls the now idempotent `finish_upload`                                                                                            | session; RLS read of the reel; `finish_upload` checks the owner                      |
| abort                     | `abortUpload({ reelId, uploadId })`: aborts the multipart upload in storage on the server, then `abort_upload` marks the reel `failed`                                                                                           | session; RLS read of the reel; `abort_upload` checks the owner                       |

- **Abort choice: mark the reel `failed`** (new `abort_upload` database function), never delete
  the row. Reason: `authenticated` has no `delete` on `reels` (a rule in `app_docs/studio.md`), a
  failed row keeps a visible record, and the function mirrors `finish_upload`'s narrow path.
  `signUploadRequest` refuses `DELETE`: Uppy's own fire-and-forget abort is refused and logged as a
  warning, the real abort runs in `abortUpload` on the server, before the status changes.
- **Upload id ownership.** The upload id is not stored in the database (the reels insert policy
  only allows `id`, `source_name`, `source_key`, a rule we keep). Ownership is enforced by the key:
  the action signs only for a key that is the caller's own `uploading` reel's `source_key`, and R2
  binds an upload id to its key (a part signed for B's key with A's upload id is rejected by R2:
  `NoSuchUpload`). The fake enforces the same binding (its upload record holds the key and every
  operation compares it).
- **Idempotent complete.** A new migration replaces `finish_upload` so it locks the owner's reel row
  (`for update`) and: if `uploading`, sets `uploaded` and `source_bytes` and inserts one `process`
  job; if already past `uploading` with a `process` job, returns that job's id; otherwise raises as
  today. Two concurrent calls serialise on the row lock, so one reel always has one job.

### Storage package

`packages/storage` swaps the single-PUT signer for multipart: `signCreateMultipart`,
`signUploadPart`, `signListParts`, `signCompleteMultipart` and `abortMultipart` in the `Storage`
interface, in R2 (presigned `CreateMultipartUploadCommand`, `UploadPartCommand`,
`ListPartsCommand`, `CompleteMultipartUploadCommand`; `AbortMultipartUploadCommand` sent from the
server) and in the fake (same-origin URLs to the mock route, with S3's query strings). A new
`fakeMultipart` module holds the fake's server-side multipart state as files under
`.e2e-storage/.multipart/<uploadId>/` (a leading dot is never a valid storage key, so it never
collides with an object and `list` skips it), assembling the object on complete.

### Browser side

`apps/studio/src/lib/multipart-upload.ts` (client-only) builds one Uppy instance per upload,
wires `signRequest` to the server action, drives the retry backoff, reports progress and writes the
resume record. `UploadForm.tsx` renders the picker, a labelled progress bar, a Cancel button, the
"stopped upload" notice after a reload, and the messages.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview, how to run the studio.
- `AGENTS.md`: repository rules (Yarn only, no em-dashes, tests, docs, `.adw/project.md` upkeep).
- `.adw/project.md`: the ADW profile; its Workspaces section describes the mock storage route
  ("signs uploads to its `/studio/api/e2e-storage-mock` route") and must be updated to the
  multipart wording.
- `docs/conditional-docs.md`: the docs index; gets one line for `app_docs/upload.md`.
- `app_docs/studio.md`: matches (upload to R2, `packages/storage`, the storage double, migrations,
  DB and E2E tests). Its Upload section, `finish_upload` description, Storage doubles section,
  Testing section, Notes ("resumable upload (single PUT only) ... later slices") and Rules (finish
  only through `finish_upload`) change.
- `app_docs/measurement.md`: matches (`studio_*` events); `studio_footage_uploaded` keeps its name
  and properties, its "when" cell becomes "the whole file is in storage and `finishUpload`
  succeeded".
- `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` and
  `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`: read before
  changing the server actions (Next 16 behaviour: actions are public endpoints, always authorise
  inside, arguments must be serialisable).
- `packages/storage/src/storage.ts`: the `Storage` interface; `signUpload` goes, the multipart
  methods come.
- `packages/storage/src/r2.ts`, `packages/storage/src/r2.test.ts`: the R2 implementation (S3 client
  with `requestChecksumCalculation: "WHEN_REQUIRED"`, path style) and its signer test.
- `packages/storage/src/fake.ts`, `packages/storage/src/fake.test.ts`: the folder fake; `list`
  must skip the `.multipart` folder.
- `packages/storage/src/index.ts`: exports.
- `apps/studio/src/app/upload-actions.ts`: the server actions to replace.
- `apps/studio/src/lib/upload.ts`, `apps/studio/src/lib/upload.test.ts`: validation, `sourceKey`,
  `MAX_UPLOAD_BYTES` (5 GiB today, becomes 1 GiB).
- `apps/studio/src/lib/storage.ts`, `apps/studio/src/lib/storage.test.ts`: `studioStorage()`,
  `MOCK_UPLOAD_URL_BASE`; the test calls `signUpload` and must move to `signUploadPart`.
- `apps/studio/src/components/UploadForm.tsx`: the form to rebuild.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` and `route.test.ts`: the R2
  stand-in; gains the S3 multipart verbs, loses the plain object PUT.
- `apps/studio/src/lib/track.ts`: `capture("studio_footage_uploaded", { reel_id })`.
- `apps/studio/src/lib/supabase-server.ts`: per-request server client.
- `apps/studio/src/app/page.tsx`: renders `UploadForm` above `ReelList` (no change expected).
- `apps/studio/e2e/upload.spec.ts`: the existing upload spec (small clip, one part, spawns the
  worker's `once`); must keep passing unchanged.
- `apps/studio/e2e/events.ts`: the event recorder for specs.
- `apps/studio/test-support/fixtures.ts`, `apps/studio/test-support/local-supabase.ts`: test users,
  sign-in links, signed-in clients, the admin client.
- `apps/studio/db-tests/rls.test.ts`: its `finish_upload` block asserts a second call errors; that
  assertion flips to "returns the same job id, still one job".
- `apps/studio/vitest.db.config.ts`: needs the `@` alias of `vitest.config.ts` so DB tests can
  import `src/lib/upload-service.ts`.
- `apps/studio/playwright.config.ts`: chromium, `workers: 1`, through the landing address.
- `apps/studio/package.json`: gains `@uppy/core` and `@uppy/aws-s3`.
- `apps/studio/.env.example`: its comment about the mock route mentions the PUT; reword.
- `apps/studio/eslint.config.mjs`: security rules the new code must satisfy
  (`detect-non-literal-fs-filename`, `detect-unsafe-regex`, `detect-non-literal-regexp`).
- `supabase/migrations/20261031174750_job_queue.sql`: the current `finish_upload` and its grants.
- `supabase/migrations/20261031105245_studio_skeleton.sql`: `reels`, its status check and
  policies.
- `apps/worker/src/steps/receive.ts`, `apps/worker/src/storage.ts`: use `Storage.head` on the
  source key; must still typecheck after the interface change.
- `knip.json`: one workspace per package; tells whether the plain-PUT code is unused.
- `turbo.json`: strict env; no new variable is read, so no change.
- `node_modules/@uppy/aws-s3/lib/S3Uploader.js`, `node_modules/@uppy/aws-s3/lib/s3-client/S3mini.js`
  (after install): the exact XML shapes the fake route must answer (`InitiateMultipartUploadResult`
  / `UploadId`, `ListPartsResult` / `Part` / `PartNumber` / `ETag` / `Size`,
  `CompleteMultipartUploadResult` / `Location` / `Key` / `ETag`) and the `ETag` response header on a
  part PUT.

### New Files

- `packages/storage/src/fake-multipart.ts`: the fake's multipart state on disk.
- `packages/storage/src/fake-multipart.test.ts`: its unit tests.
- `apps/studio/src/lib/upload-service.ts`: `createUploadFor`, `signUploadRequestFor`,
  `finishUploadFor`, `abortUploadFor` with injected client and storage.
- `apps/studio/src/lib/upload-resume.ts`, `apps/studio/src/lib/upload-resume.test.ts`: the resume
  record (read, write, clear, match a file).
- `apps/studio/src/lib/multipart-upload.ts`: the client-only Uppy wrapper (retry, progress,
  resume record).
- `supabase/migrations/20261101120000_multipart_upload.sql`: idempotent `finish_upload`, new
  `abort_upload`.
- `apps/studio/db-tests/upload.test.ts`: ownership of signing, idempotent finish, abort.
- `apps/studio/e2e/multipart-upload.spec.ts`: the four browser scenarios.
- `app_docs/upload.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Dependencies, the storage interface with its R2 and fake implementations and their unit tests, the
fake's multipart state, and the database migration (idempotent `finish_upload`, `abort_upload`).
Nothing in the studio changes yet, apart from what the interface change forces to compile.

### Phase 2: Core Implementation

The studio's validation helpers (1 GiB limit, part size, sign-request parsing, retry delays), the
dependency-injected upload service, the thin server actions, the mock route's S3 multipart verbs,
the resume record and the client-side Uppy wrapper, then the rebuilt `UploadForm` with its progress
bar, Cancel, stopped-upload notice and messages.

### Phase 3: Integration

DB integration tests (ownership, idempotent finish, abort), the new E2E spec (parts, a failed part,
reload and resume, cancel), the negative proof for the resume, removal of the single-PUT path,
docs (`app_docs/upload.md`, the index line, `app_docs/studio.md`, `app_docs/measurement.md`,
`.adw/project.md`, `apps/studio/.env.example`), and the full validation run.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read the framework and uploader sources

- Read `node_modules/next/dist/docs/01-app/02-guides/server-actions.md` and
  `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md`.
- After step 2, read `node_modules/@uppy/aws-s3/lib/S3Uploader.js`,
  `node_modules/@uppy/aws-s3/lib/s3-client/S3mini.js` (`createMultipartUpload`, `uploadPart`,
  `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `send`) and
  `node_modules/@uppy/aws-s3/lib/s3-client/types.d.ts`, and `retryUpload`, `setFileState`,
  `addFile`, `destroy` in `node_modules/@uppy/core/lib/Uppy.js`. If 6.3.0 differs from the facts in
  the Solution Statement, follow the code and note the difference in `app_docs/upload.md`.

### 2. Add the uploader dependencies

- `yarn workspace @edit-issebya/studio add @uppy/core@6.3.0 @uppy/aws-s3@6.3.0` (exact versions,
  the two the issue names; no golden-retriever, see Solution Statement).
- Confirm `yarn install --immutable` would now be clean (the lockfile change is committed with this
  slice).

### 3. Multipart in the `Storage` interface (`packages/storage/src/storage.ts`)

- Remove `signUpload`. Add, each with a one-line comment in the file's style:
  - `signCreateMultipart(key, { contentType, expiresInSeconds }): Promise<{ url: string; headers: Record<string, string> }>`
    (the headers the browser must send, `Content-Type`).
  - `signUploadPart(key, { uploadId, partNumber, expiresInSeconds }): Promise<string>`.
  - `signListParts(key, { uploadId, expiresInSeconds }): Promise<string>`.
  - `signCompleteMultipart(key, { uploadId, expiresInSeconds }): Promise<string>`.
  - `abortMultipart(key, uploadId): Promise<void>` (sent by the server; no error when the upload is
    already gone).
- Export `PART_NUMBER_MAX = 10000` and an `isUploadId(value)` check (string, 1 to 1024 characters
  of `[A-Za-z0-9._~+/=-]`, a plain character class with a length bound so
  `security/detect-unsafe-regex` stays quiet) for both implementations and the studio.

### 4. R2 implementation (`packages/storage/src/r2.ts`)

- Presign with `getSignedUrl` and the existing client: `CreateMultipartUploadCommand` (`Bucket`,
  `Key`, `ContentType`; return `headers: { "Content-Type": contentType }`), `UploadPartCommand`
  (`UploadId`, `PartNumber`), `ListPartsCommand` (`UploadId`), `CompleteMultipartUploadCommand`
  (`UploadId`, no `MultipartUpload` body: the browser sends the XML). Every key through
  `assertStorageKey`, every upload id through `isUploadId`.
- `abortMultipart` sends `AbortMultipartUploadCommand`; a `NoSuchUpload` (404) answer is not an
  error.
- Remove the `PutObjectCommand` presign (keep `put`, the worker and tests use it).
- `r2.test.ts`: replace the `signUpload` test with one per signer: the host is the jurisdictional
  R2 host, the path is `/<bucket>/<key>`, the query carries `uploads` (create), `uploadId` and
  `partNumber` (part), `uploadId` (list, complete), `X-Amz-Expires` equals the request, and no
  `x-amz-checksum*` or `x-amz-sdk-checksum-algorithm` parameter appears (the browser cannot send
  them). An invalid key or upload id rejects.

### 5. The fake's multipart state (`packages/storage/src/fake-multipart.ts`)

- `fakeMultipart({ root })` returns `create(key)`, `putPart(key, uploadId, partNumber, bytes)`,
  `listParts(key, uploadId)`, `complete(key, uploadId, parts)` and `abort(key, uploadId)`.
- Layout: `<root>/.multipart/<uploadId>/upload.json` (`{ "key": ... }`) and
  `<root>/.multipart/<uploadId>/part-00001`... Upload ids are `randomBytes(16).toString("hex")`;
  every operation checks the id against `^[a-f0-9]{32}$` before touching the disk (no path out of
  the root) and that `upload.json`'s key equals the given key (the binding R2 enforces); a
  mismatch or a missing upload throws a `NoSuchUpload` error.
- `putPart` writes the part and returns its ETag, `"<first 32 hex of sha256>"` (quoted, like S3);
  part numbers 1 to `PART_NUMBER_MAX`.
- `listParts` returns `{ partNumber, etag, size }[]` sorted by part number.
- `complete` checks the given parts are ascending, each exists and its ETag matches (S3's
  `InvalidPart`), concatenates them in order into `<root>/<key>` (appending part by part), removes the upload
  folder and returns the object's ETag. A second `complete` for the same id throws `NoSuchUpload`,
  as R2 does.
- `abort` removes the upload folder (`rm` with `force`); no error when it is already gone.
- `fakeStorage` (`fake.ts`): the signers return same-origin paths to the mock route,
  `${uploadUrlBase}${key}?uploads`, `?partNumber=<n>&uploadId=<id>`, `?uploadId=<id>` (list and
  complete differ by method); `signCreateMultipart` returns `{ url, headers: { "Content-Type" } }`;
  `abortMultipart` delegates to `fakeMultipart(...).abort`. Remove `signUpload`. `list` (through
  `walk`) skips directories whose name starts with `.`.
- Export `fakeMultipart` from `packages/storage/src/index.ts`.
- Unit tests in `fake-multipart.test.ts` and `fake.test.ts` (temp root, as the existing tests do):
  four parts assemble to the exact bytes (compare sha256); `listParts` after two parts lists two;
  a wrong key for an upload id, a bad upload id (`../x`, uppercase, 31 hex) and an unknown one are
  refused; a wrong ETag on complete is refused; a second complete throws; abort removes the parts
  and is repeatable; `list("")` never returns a `.multipart` path; the signers' URL shapes.

### 6. Migration: idempotent `finish_upload` and `abort_upload`

- New `supabase/migrations/20261101120000_multipart_upload.sql`, with a header comment in the style
  of the existing migrations.
- `create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint) returns uuid`,
  `security definer`, `set search_path = ''`: keep the `p_bytes` check; `select status ... from
public.reels where id = p_reel_id and owner_id = (select auth.uid()) and source_key is not null
for update`; not found raises `P0002` (`no uploading reel of yours with this id`, as today); if
  `uploading`, update to `uploaded` with `source_bytes` and insert one `process` job, return its id;
  otherwise return the id of that reel's oldest `process` job, and raise `P0002` when there is none
  (a reel in another state without a job is still refused). `create or replace` keeps the existing
  grants; restate `revoke ... from public, anon, service_role` and `grant ... to authenticated`
  anyway so the file is self-describing.
- `create function public.abort_upload(p_reel_id uuid) returns void`, same header: update the
  caller's own reel from `uploading` to `failed`; if nothing changed and the caller's reel is
  already `failed`, return (idempotent); otherwise raise `P0002`. Revoke from `public, anon,
service_role`, grant to `authenticated`.
- Apply with `supabase migration up --local` (the one database command a run may use). If it fails,
  report the error and stop; never reset.
- Update `apps/studio/db-tests/rls.test.ts` `finish_upload` block: the second call now returns no
  error and the same job id as the first, and there is still exactly one job. Keep the
  "another user, anon, zero size" and "any other state" refusals.

### 7. Studio validation helpers (`apps/studio/src/lib/upload.ts`)

- `MAX_UPLOAD_BYTES = 1024 ** 3` (1 GiB; comment: the studio's own limit, the browser refuses
  larger before anything is created; R2's multipart limit is far above it).
- `PART_BYTES = 10 * 1024 ** 2`.
- `parseSignRequest(input: unknown)`: returns `{ ok: true, value: { kind: "create", key } |
{ kind: "part", key, uploadId, partNumber } | { kind: "list", key, uploadId } |
{ kind: "complete", key, uploadId } }` or `{ ok: false }`. `POST` without `uploadId` is create,
  `PUT` with `uploadId` and an integer `partNumber` 1 to 10000 is part, `GET` with `uploadId` is
  list, `POST` with `uploadId` is complete; `PUT` without `uploadId` (single PutObject) and every
  `DELETE` are refused; the key must pass `isStorageKey`, the id `isUploadId`. The client's
  `expiresIn` is ignored.
- `retryDelayMs(attempt)`: `[1000, 2000, 4000, 8000, 15000]` by attempt, `null` after the last.
- Update `upload.test.ts`: the 1 GiB boundary (`MAX_UPLOAD_BYTES` accepted, one more byte
  `too-large`), every `parseSignRequest` branch and refusal, `retryDelayMs`.

### 8. Upload service (`apps/studio/src/lib/upload-service.ts`)

- No `"use server"`, no `next/*` import: plain functions taking `supabase: SupabaseClient` (the
  user's client) and `storage: Storage`, so DB tests call them directly.
- `uploadingReelByKey(supabase, key)`: `select id, source_key` from `reels` where `source_key = key`
  and `status = 'uploading'`, `maybeSingle()`. Named columns, no owner filter (RLS scopes it, as in
  `page.tsx`).
- `createUploadFor(supabase, storage, prefix, input)`: today's `createUpload` body without the
  signing: `parseUploadRequest`, insert the reel, return `{ status: "ready", reelId, key,
contentType }`.
- `signUploadRequestFor(supabase, storage, request)`: `parseSignRequest`; refuse
  (`{ status: "refused" }`) when invalid or when `uploadingReelByKey` finds nothing; otherwise sign
  with `UPLOAD_URL_SECONDS` (900) and return `{ status: "signed", url, headers? }`.
- `finishUploadFor(supabase, storage, reelId)`: `isReelId`; read the reel (`id, status,
source_key`) through RLS, refused when missing; `storage.head(source_key)`, `{ status:
"incomplete" }` when the object is absent; `rpc("finish_upload", { p_reel_id, p_bytes:
head.bytes })`; `{ status: "finished", reelId, jobId }`. Called twice it returns the same job id.
- `abortUploadFor(supabase, storage, { reelId, uploadId })`: read the reel through RLS; when it is
  `uploading` and `isUploadId(uploadId)`, `storage.abortMultipart(source_key, uploadId)` (errors
  logged, never with the file name), then `rpc("abort_upload")`; `{ status: "aborted" }`.
- Log errors the way `upload-actions.ts` does (code and message, never the file name).

### 9. Server actions (`apps/studio/src/app/upload-actions.ts`)

- `"use server"`. `createUpload`, `signUploadRequest`, `finishUpload`, `abortUpload`: each creates
  the server client, returns `{ status: "unavailable" }` without configuration, `{ status:
"signed-out" }` without `auth.getUser()`'s user, gets `studioStorage()` and `keyPrefix()`, then
  calls the matching `*For` function. Arguments are plain serialisable objects; never trust a size,
  owner or key the browser sends beyond what the service checks.
- Remove the old single-URL `createUpload` result shape and the `bytes` argument of `finishUpload`.

### 10. Mock route: S3 multipart verbs (`apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`)

- Every method still answers 404 unless `isE2EMockStorage()`; keys still go through
  `isStorageKey`.
- `POST ?uploads` answers `InitiateMultipartUploadResult` XML with `Bucket`, `Key`, `UploadId`.
- `PUT ?partNumber=<n>&uploadId=<id>` writes the part through `fakeMultipart` and answers 200 with
  an `ETag` header.
- `PUT` without those parameters answers 400: the plain object PUT is gone with the single-PUT path.
- `GET ?uploadId=<id>` answers `ListPartsResult` XML (`Bucket`, `Key`, `UploadId`,
  `IsTruncated` false, one `Part` with `PartNumber`, `ETag`, `Size` per part).
- `POST ?uploadId=<id>` reads the `CompleteMultipartUpload` body (parse `PartNumber`/`ETag` pairs
  with a simple non-backtracking pattern, or a tiny tag scanner), completes, answers
  `CompleteMultipartUploadResult` XML (`Location`, `Bucket`, `Key`, `ETag`).
- `DELETE ?uploadId=<id>` aborts, 204.
- A `NoSuchUpload` or `InvalidPart` answers 404 or 400 with S3's error XML (`<Error><Code>`).
  `GET` without `uploadId` and `HEAD` stay as they are (object bytes and size).
- XML answers carry `Content-Type: application/xml`; values are escaped.
- The comment at the top says the route stands in for R2's S3 API, multipart included, and is inert
  without the exact flag.
- `route.test.ts`: 404 for every method and verb without the exact flag; create, two parts, list,
  complete round-trip through `GET`; the plain `PUT` answers 400; a bad upload id answers 400 and
  writes nothing; abort removes the parts.

### 11. Resume record (`apps/studio/src/lib/upload-resume.ts`)

- One `localStorage` entry, key `studio-upload-resume`, JSON `{ reelId, key, uploadId, name, size,
lastModified }`. Functions take a `Pick<Storage, "getItem" | "setItem" | "removeItem">` (the DOM
  one) so they test in node: `readResume`, `writeResume`, `clearResume`, `parseResume` (refuses
  anything malformed: bad uuid, key, upload id, negative size), `matchesFile(record, { name, size,
lastModified })`.
- Comment: functional state only, removed on finish, cancel or discard, never sent anywhere.
- `upload-resume.test.ts`: round-trip, malformed JSON and fields ignored, match and mismatch on
  each of name, size and last-modified.

### 12. Client Uppy wrapper (`apps/studio/src/lib/multipart-upload.ts`)

- Client-only module (imported only from `UploadForm.tsx`). `startUpload({ file, target, resume?,
sign, onProgress, onRetrying, onFailed, onDone })` creates a new `Uppy` (`autoProceed: false`,
  no UI plugins) with `AwsS3` (`shouldUseMultipart: true`, `getChunkSize: () => PART_BYTES`,
  `limit: 1`, `generateObjectKey: () => target.key`, `signRequest` calling the passed server
  action and throwing on any status but `signed`), adds the file, and when resuming calls
  `uppy.setFileState(id, { s3Multipart: { uploadId, key } })` before `uppy.upload()`.
- Retry: on `upload-error`, take `retryDelayMs(attempt)`; wait, then `uppy.retryUpload(id)`
  (which lists parts and re-sends only what is missing); give up (`onFailed`, record kept) when it
  is `null`. An `online` event retries at once. `s3-multipart:part-uploaded` resets the attempt
  count and writes the resume record from the file's `s3Multipart`.
- `upload-progress` reports whole percent (`Math.floor(bytesUploaded / bytesTotal * 100)`).
- `upload-success` clears nothing yet: it calls `onDone`, which runs `finishUpload`; the form clears
  the record on success.
- Returns `{ cancel }`: removes the window listener and destroys the Uppy instance. Never create an
  Uppy instance at module load or during render.

### 13. Rebuild `UploadForm.tsx`

- States: `idle`, `uploading` (progress bar, percent text, Cancel), `retrying` ("Connection lost.
  Retrying..." with the bar), `stopped` (a record exists after a reload: "The upload of <name>
  stopped at <n>%. Pick the same file to continue." with a Discard button; the percent is not known
  before listing, so show the name only if no percent is stored), `too-large` ("Pick a clip up to
  1 GB."), `invalid`, `failed` ("Upload failed. Try again."), `unavailable`.
- Read the record with `useSyncExternalStore` over `localStorage` (server snapshot `null`), not
  `useEffect` plus state (see the `no-unnecessary-effects` and `use-sync-external-store` skills).
- On submit: no file is `invalid`; `file.size > MAX_UPLOAD_BYTES` is `too-large` before any server
  call; a picked file that `matchesFile` the record resumes with the record's reel and upload id
  (no `createUpload`); any other file first discards a stale record (`abortUpload` in the
  background, record cleared) and then calls `createUpload`.
- The bar: a `div` with `role="progressbar"`, `aria-label="Upload progress"`,
  `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow`, `data-testid="upload-progress"`, and a
  visible percent; Tailwind classes in the form's existing style; full width and readable at 375px.
- On done: `finishUpload({ reelId })`; `finished` clears the record, captures
  `studio_footage_uploaded` with `{ reel_id }` exactly once (a ref guard per reel id), then
  `router.push(`/reels/${reelId}`)` as today; `incomplete` or `failed` shows `failed`;
  `signed-out` refreshes.
- Cancel and Discard: `cancel()` the wrapper, `abortUpload({ reelId, uploadId })` when an upload id
  is known, clear the record, back to `idle`, `router.refresh()` so the list shows the reel as
  `failed`.
- Keep the "Clip" label and the "Upload" button names (the existing `upload.spec.ts` uses them).

### 14. Remove the single-PUT path

- Confirm nothing calls `signUpload`, the old `createUpload` result `url`, or the plain mock PUT
  (`grep`, then `yarn knip`). Update `apps/studio/src/lib/storage.test.ts` to call
  `signUploadPart` for the fake and R2 checks.
- Keep the mock route (multipart, GET, HEAD use it) and `MOCK_UPLOAD_URL_BASE`.

### 15. DB integration tests (`apps/studio/db-tests/upload.test.ts`)

- Add the `@` alias to `apps/studio/vitest.db.config.ts` (mirror `vitest.config.ts`).
- Setup: users A and B (`createTestUser`), their signed-in clients (`signedInClient`), a
  `fakeStorage` and `fakeMultipart` on a temp root (`mkdtemp`, as the storage tests do). Cleanup:
  delete jobs then users, remove the temp root.
- Ownership (verification 6): A `createUploadFor` and signs a create; then as B,
  `signUploadRequestFor` for A's key refuses `create`, `part`, `list` and `complete`, and
  `finishUploadFor` and `abortUploadFor` on A's reel are refused and change nothing (A's reel still
  `uploading`, no job). As A the same part request is signed.
- Idempotent complete (verification 5): A creates, uploads two parts through `fakeMultipart`,
  completes them, then calls `finishUploadFor` twice in sequence and twice concurrently
  (`Promise.all`) on a second reel: each reel is `uploaded` with `source_bytes` equal to the
  assembled size and has exactly one `process` job; every call returns the same job id.
- `finishUploadFor` before the object exists answers `incomplete` and leaves the reel `uploading`.
- Abort: A's reel with a started upload: `abortUploadFor` removes the parts folder and the reel is
  `failed`; a second call is harmless; `finish_upload` on it is then refused.

### 16. E2E spec (`apps/studio/e2e/multipart-upload.spec.ts`)

- Model on `upload.spec.ts` (sign-in link, `recordEvents`, admin reads, `fakeStorage` on
  `e2eStorageRoot`). `beforeAll`: a test user, and a 35 MiB file of random bytes written to a
  `mkdtemp` folder as `clip-35mb.mp4` (4 parts: 10, 10, 10, 5 MiB) with its sha256. `afterAll`:
  delete the objects the tests created, the temp folder and the user (cascade removes reels and
  jobs, so `upload.spec.ts`'s leftover-jobs guard stays green).
- A helper counts mock-route requests per part number (`page.on("request")`, method `PUT`,
  `partNumber` in the query), and one counts list requests (`GET` with `uploadId`).
- An init script records every `aria-valuenow` the `upload-progress` bar takes on
  `window.__progressValues` (a `MutationObserver`; client navigation keeps the window).
- Test "uploads in four parts" (verification 1, 7): pick the file, Upload; the URL becomes the reel
  page; part counts are `{1:1, 2:1, 3:1, 4:1}`; the recorded progress includes `"100"`; the reel is
  `uploaded` with `source_bytes` equal to the file size; one `process` job; the assembled object's
  sha256 equals the file's; `studio_footage_uploaded` was captured exactly once with this
  `reel_id`.
- Test "a failed part is sent again on its own" (verification 2): `page.route` on the mock route
  aborts only the first `PUT` with `partNumber=2` (`route.abort("failed")`), continues everything
  else; the upload completes; counts `{1:1, 2:2, 3:1, 4:1}`; object hash correct; event once.
- Test "a reload resumes" (verification 3): `page.route` holds the first `partNumber=3` request
  (resolve a promise, never fulfil); once it is reached, `unrouteAll({ behavior: "ignoreErrors" })`
  and `page.reload()`; the stopped notice names `clip-35mb.mp4`; pick the same file and Upload; the
  upload completes on the same reel id as before the reload (read from the record or the
  admin's newest reel); counts show parts 1 and 2 sent once, at least one list request, parts 3 and
  4 complete; object hash correct; event once; the user has exactly one reel and one job.
- Test "Cancel marks the reel failed" (the abort control): hold part 2 as above, press Cancel; the
  reel becomes `failed`, no job, and no `.e2e-storage/.multipart/` folder for its upload remains
  (`fakeMultipart(...).listParts` throws `NoSuchUpload`).
- Test "a file over 1 GiB is refused in the browser": in `page.evaluate`, build a small `File`,
  override its `size` with `Object.defineProperty` to `1024 ** 3 + 1`, put it on the "Clip" input
  through a `DataTransfer` and dispatch `change`; press Upload; expect "Pick a clip up to 1 GB." and
  no reel for the user. If the size override proves unreliable in Chromium, drop this case and rely
  on the unit boundary in `upload.test.ts` (already planned), and say so in `app_docs/upload.md`.

### 17. Negative proof for the resume (verification 4)

- Temporarily make the wrapper skip `setFileState(..., { s3Multipart })` on resume (so no listing
  happens). Run only the reload spec:
  `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- --grep "a reload resumes"` after sourcing
  `.ports.env`, and confirm it fails because parts 1 and 2 are sent again. Restore the code, rerun
  it green, and record the failing output in the run's report. Never commit the probe.

### 18. Documentation

- New `app_docs/upload.md` (structure of `app_docs/studio.md`: Specifications, Overview, How it
  works, How to Use, Configuration, Testing, Rules, Notes): the multipart flow end to end, part
  size (10 MiB, equal parts, at least 5 MiB), the 1 GiB browser limit, the uploader choice and why
  not golden-retriever, signing per request with the table of actions and their ownership checks,
  the retry backoff (`retryDelayMs`, `online`), resume (the record, re-picking the file, listing
  parts), abort (marks `failed`, server-side multipart abort), idempotent `finish_upload`, the fake
  (`fakeMultipart`, `.e2e-storage/.multipart/`, the mock route's S3 verbs), the R2 owner steps
  (CORS and lifecycle, below) and a Rules section:
  - Never send file bytes through the studio's server; only the browser talks to R2 (the mock
    route is R2's stand-in, inert unless `E2E_MOCK_STORAGE` is exactly `"true"`).
  - Never sign a request before checking the session and that the key is the caller's own
    `uploading` reel's `source_key`.
  - Never sign a single PutObject or a DELETE for the browser.
  - Do not take `source_bytes` from the browser; it is the stored object's size.
  - `finish_upload` stays idempotent: one reel, one `process` job, however many calls.
  - Do not store the upload id in `reels` without changing the insert-columns rule in
    `app_docs/studio.md` in the same change.
  - Do not create an Uppy instance at module load or in render.
- `docs/conditional-docs.md`: one line, "Read `app_docs/upload.md` when changing the footage
  upload: the upload form or progress bar, multipart signing, the upload server actions, retries,
  resume, `finish_upload` or `abort_upload`, the storage multipart methods or the mock route's
  multipart verbs."
- `app_docs/studio.md`: shorten the Upload section to the reel row and key and point to
  `app_docs/upload.md`; `finish_upload` description says it is idempotent; add `abort_upload`; the
  rule "finishing an upload goes only through `finish_upload`" becomes "status changes from the
  owner go only through `finish_upload` and `abort_upload`"; add `abort_upload` to the rule about
  `anon`; Storage doubles and Testing mention the multipart verbs, the new DB test and spec; drop
  "resumable upload (single PUT only)" from Notes; add the spec path to Specifications.
- `app_docs/measurement.md`: the `studio_footage_uploaded` row's "when" is "the whole file is in
  storage and `finishUpload` succeeded, once per upload"; Testing lists the new spec.
- `.adw/project.md` (Workspaces, mock flags paragraph): "makes the studio sign multipart uploads to
  its `/studio/api/e2e-storage-mock` route (R2's S3 API stand-in)"; Tests: name
  `multipart-upload.spec.ts` beside `upload.spec.ts`. Do not rename or reorder its headings.
- `apps/studio/.env.example`: reword the comment on `E2E_MOCK_STORAGE` to the multipart route.

### 19. Run the validation commands

- Source `.ports.env` and run every command in `Validation Commands` in order; all must pass with
  zero regressions.

## Testing Strategy

### Unit Tests

- `packages/storage/src/fake-multipart.test.ts`: assembly byte-exact, listing, key binding, bad
  and unknown upload ids, ETag check, repeat complete, abort, no path out of the root.
- `packages/storage/src/fake.test.ts`: the signers' URL shapes, `list` skips `.multipart`, the
  existing round-trip and key refusals.
- `packages/storage/src/r2.test.ts`: each presigned multipart URL (host, path, query, expiry, no
  checksum parameters), refusals.
- `apps/studio/src/lib/upload.test.ts`: the 1 GiB boundary, `parseSignRequest` (every kind, single
  PUT and DELETE refused, bad part numbers, keys and ids), `retryDelayMs`.
- `apps/studio/src/lib/upload-resume.test.ts`: record round-trip, malformed input, file matching.
- `apps/studio/src/lib/storage.test.ts`: `signUploadPart` through the fake and R2.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`: flag gate, every S3 verb,
  plain PUT refused.

### Test Coverage

- E2E (`apps/studio/e2e/multipart-upload.spec.ts`, chromium, fake storage): "uploads in four
  parts" catches a non-multipart upload, a wrong part size, a progress bar that never reaches 100,
  a wrong `source_bytes` or a corrupt assembly; "a failed part is sent again on its own" catches a
  missing retry or a retry that re-sends every part; "a reload resumes" catches a resume that
  starts over (proven by the negative probe, task 17); "Cancel marks the reel failed" catches an
  abort that leaves the reel `uploading` or the parts in storage; "a file over 1 GiB is refused"
  catches a missing browser limit. Each fails on today's single-PUT code.
- DB integration (`apps/studio/db-tests/upload.test.ts`): ownership refusals catch signing for
  another user's reel (nothing tests signing today); idempotent finish catches a second `process`
  job, including under concurrency (today's `finish_upload` errors on the second call, which
  `rls.test.ts` now asserts the opposite of).
- Unit (`packages/storage`, `apps/studio/src/lib`, the route test): catch a malformed presigned
  URL, a fake that lets a key or upload id escape its root or crosses upload ids between keys, and
  a sign-request parser that lets a single PUT or DELETE through.
- `studio_footage_uploaded` exactly once (verification 7) is asserted in each E2E upload test, so a
  retry or a resume that sends it twice fails.

### Edge Cases

- A file smaller than one part (the existing `upload.spec.ts` clip): one-part multipart; that spec
  must still pass unchanged.
- A file of exactly `MAX_UPLOAD_BYTES` is accepted; one byte more is refused before any server call.
- A part fails on every retry: the form shows "Upload failed. Try again." and keeps the record so a
  later pick resumes.
- Reload before the first part finishes: no record yet, the next pick starts a new upload; the
  stale `uploading` reel stays (listed as uploading) and R2's lifecycle rule removes its parts.
- A different file is picked while a record exists: the stale upload is aborted and marked
  `failed`, then a new one starts.
- `finishUpload` called twice, or concurrently: one job, same job id.
- `finishUpload` before the object exists (complete failed): `incomplete`, reel stays `uploading`.
- The session expires mid-upload: signing answers `signed-out`, the form refreshes to the login.
- User B passes A's key (or A's key with B's own upload id): refused by the studio (key) and by R2
  or the fake (upload id bound to its key).
- `uploadId` or key with `..`, uppercase or overlong values: refused before any disk or S3 call.
- `E2E_MOCK_STORAGE` other than exactly `"true"`: every route verb answers 404.

## Acceptance Criteria

- The studio's upload sends the file to storage in 10 MiB parts, each part on its own presigned
  URL; the studio's server never receives file bytes (only the mock route, as R2's stand-in under
  the exact flag).
- A progress bar (`role="progressbar"`, "Upload progress") reaches 100 percent on success.
- A part that fails is sent again on its own after a backoff; other parts are sent once.
- After a reload, picking the same file continues the same reel's upload; parts R2 already has are
  not sent again.
- On completion the reel is `uploaded` with `source_bytes` equal to the stored object's size and
  has exactly one `process` job, however many times completion is called.
- Every action checks the session and that the reel is the caller's; user B can never sign for, or
  finish or abort, user A's upload.
- Cancel (or Discard) aborts the multipart upload in storage and marks the reel `failed`.
- Files up to 1 GiB are accepted; a larger one is refused in the browser with "Pick a clip up to
  1 GB." and no reel is created.
- `studio_footage_uploaded` is captured exactly once per upload, after completion.
- The single-PUT signing path is gone; `yarn knip` reports nothing unused.
- `app_docs/upload.md` exists with its Rules section, `docs/conditional-docs.md` lists it, and
  `app_docs/studio.md`, `app_docs/measurement.md` and `.adw/project.md` match the new behaviour.
- No em-dash in any changed file.
- Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `set -a; . ./.ports.env; set +a` - load this run's `PORT` and `BACKEND_PORT` (never edit the file).
- `yarn format:check` - Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - ESLint (security rules) in the changed workspaces and the worker that consumes the storage interface.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - types after the `Storage` interface change (the worker's `head` use included); the storage package and the worker have no build, so this is their build check.
- `yarn knip` - no unused files, exports or dependencies (proves the single-PUT path is gone and both Uppy packages are used).
- `yarn turbo run test --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker` - unit tests: fake multipart, R2 signers, route verbs, validation, resume record.
- `supabase migration up --local` - apply `20261101120000_multipart_upload.sql` to the shared local stack (the only database command a run may use; on failure report and stop, never reset).
- `yarn turbo run test:db --filter=./apps/studio` - RLS, idempotent `finish_upload`, `abort_upload`, signing ownership.
- `yarn turbo run build --filter=./apps/studio` - `next build` of the studio with no variables.
- `PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e` - both E2E suites (landing first, then the studio's, including `upload.spec.ts` and the new `multipart-upload.spec.ts`) against the `/prepare_app` server started with the profile's dev command.

## Notes

- **New dependencies:** `@uppy/core@6.3.0` and `@uppy/aws-s3@6.3.0` in `@edit-issebya/studio`,
  added with `yarn workspace @edit-issebya/studio add`. `@uppy/golden-retriever` is deliberately not
  added (see Solution Statement).
- **Owner steps, corrected for Uppy 6:** the browser sends more than `PUT` to R2. The R2 bucket's
  CORS rule for the studio's origins must allow `PUT` (parts), `POST` (create and complete) and
  `GET` (list parts), allow the `Content-Type` header, and expose `ETag`. `DELETE` is not needed
  (abort runs on the server). Lifecycle rule: abort incomplete multipart uploads after 3 days for
  each prefix in use. Both go in `app_docs/upload.md`; the pipeline cannot verify them, nor real
  network drops.
- The studio's R2 key (`R2_STUDIO_*`) must allow multipart operations on the bucket (an R2 "Object
  Read & Write" token does); no new variable, so `turbo.json` and the `.env.example` names do not
  change.
- `source_bytes` now comes from a server-side HEAD of the stored object, not from the browser.
- A reload restores the upload's identity, not the file: browsers do not let a page re-read a
  local file without the user picking it again. The stopped notice says so.
- The resume record is functional `localStorage` state (reel id, key, upload id, file name, size,
  last-modified), removed on finish, cancel or discard. The studio is used only by the owner; no
  legal-page change is planned, but mention it in `app_docs/upload.md`.
- Out of scope: upload from a phone or a link, several clips per reel, checking the file's format
  and length (slice 16, in the worker), a retry limit on jobs.
- The browser surface changes (upload control and progress bar): the review phase captures the
  signed-in studio at 1920x1080 and 375x667 per the profile's Review section; the bar must be full
  width and legible at 375px.
