# Feature: resumable multipart upload of footage straight to R2

## Metadata

issue_number: `36`
adw_id: `849f9390`
issue_json: `{"number":36,"title":"feat: resumable multipart upload of footage straight to R2"}` (body: reel studio MVP slice 13 of 17, decisions D3, B2, D7; summarised below)

## Feature Description

The studio uploads raw phone footage (60 MB to several hundred MB, up to at least 1 GB) from the
owner's computer straight to Cloudflare R2 as an S3 multipart upload: parts of 10 MiB, each PUT to
its own presigned URL, a failed part retried on its own with backoff, a progress bar, and an
interrupted upload (dropped connection or page reload) that resumes where it stopped, skipping the
parts R2 already holds. The studio's server only signs, lists, completes and aborts; it never
receives file bytes (in R2 and in the E2E fake, whose route is a test double for R2 itself). When
the upload completes, the studio marks the reel `uploaded` with its real size and queues exactly
one `process` job, however many times completion is called. Every step checks the session and that
the reel belongs to the caller. `studio_footage_uploaded` is captured once, after completion.

## User Story

As the owner
I want to upload a 60 MB to 1 GB phone clip from my computer with a progress bar, and have it continue where it stopped after a dropped connection or a page reload
So that a large clip never has to start again from zero and I can see how far it got

## Problem Statement

Today `UploadForm` sends the whole file in one presigned `PUT` (`createUpload` then `finishUpload`
in `apps/studio/src/app/upload-actions.ts`). A dropped connection or a reload loses everything sent
so far, there is no progress, and one failed request fails the whole upload. Calling
`finish_upload` a second time raises, so a retried completion looks like a failure.

## Solution Statement

- **Storage interface** (`packages/storage`): five multipart methods, `createMultipartUpload`,
  `signUploadPart`, `listUploadParts`, `completeMultipartUpload`, `abortMultipartUpload`, in the
  R2 implementation (S3 multipart commands through the existing client) and the folder fake
  (parts as files under `.e2e-storage/.multipart/<uploadId>/`, assembled on complete). The
  single-PUT `signUpload` is removed (nothing else uses it).
- **Database** (one new migration): `reels.source_upload_id` (the R2 upload id, inserted with the
  row, so the server can always tie a reel to its one multipart upload); `finish_upload` replaced
  by an idempotent version (row locked, a second call returns the same `process` job id and
  inserts nothing); new `fail_upload(p_reel_id)` (owner's `uploading` reel becomes `failed`).
- **Studio server**:
  - Server actions (`upload-actions.ts`) for the three mutations: `createUpload` (validates,
    creates the multipart upload on a fresh reel id's key, inserts the `uploading` reel with
    `source_upload_id`, aborts the multipart upload if the insert fails), `completeUpload`
    (completes in storage, tolerating "already completed", reads the size from storage `head`,
    then `finish_upload`), `abortUpload` (aborts in storage, then `fail_upload`).
  - A route handler for the two frequent reads, `apps/studio/src/app/api/uploads/[reelId]/parts/route.ts`:
    `GET` lists uploaded parts, `POST` signs one part number. These are route handlers and not
    server actions because Next dispatches server actions one at a time per client
    (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, "Sequential dispatch"),
    which would serialise the concurrent part signing.
  - Every entry point resolves the reel through the user's own Supabase client (RLS, owner-only
    `select`), requires status `uploading`, and takes the key and upload id from the row, never
    from the browser. Another user's reel id answers 404, the same as a missing one.
- **Uploader**: `@uppy/core` 6.3.0 + `@uppy/aws-s3` 6.3.0, headless (no Uppy UI packages, our own
  Tailwind progress bar), `shouldUseMultipart: true`, `getChunkSize` 10 MiB, `retryDelays`
  `[0, 1000, 3000, 5000]` per part, `limit` 4 concurrent parts. The plugin's five callbacks call the
  actions and the route above.
- **Resume**: a small resume record in `localStorage` (`studio_upload_resume`: reel id, upload
  id, file name, size, `lastModified`). After a reload the form shows "An upload of
  `<name>` was interrupted. Pick the same file to resume." When the picked file matches the
  record (name, size, lastModified), the uploader is given the stored `{ key, uploadId }` as the
  file's `s3Multipart` state, so `@uppy/aws-s3` calls `listParts` and only sends the missing
  parts. `@uppy/golden-retriever` is not used: a browser cannot read a picked file after a reload
  without the user picking it again unless the bytes are copied into IndexedDB or kept by a
  Service Worker, and golden-retriever's IndexedDB store is capped far below 1 GB while a Service
  Worker under `/studio` is extra moving parts for no gain; the part that matters (reel id and
  upload id survive the reload, listed parts are skipped) is a 30-line record we own and test.
- **Size**: the browser refuses a file above `MAX_UPLOAD_BYTES` (kept at 5 GiB, comfortably above
  the required 1 GB; 10 MiB parts allow 10,000 parts, about 97 GiB, so the cap is a product
  bound, not an R2 one) with "Pick an MP4, MOV, M4V or WebM clip up to 5 GB.", before any server
  call. The server re-checks the same rule in `createUpload`.
- **Fake path, no bytes through the server in production**: under `E2E_MOCK_STORAGE=true` the
  fake signs part URLs to the existing `/studio/api/e2e-storage-mock/<key>?uploadId=..&partNumber=n`
  route, which writes the part and answers its `ETag` (MD5 of the part, quoted, as R2 does). The
  single-object `PUT` branch of that route is removed; its `GET` and `HEAD` stay (preview and
  export use them). The studio's `proxy.ts` matcher excludes `api/e2e-storage-mock`, because
  `proxy` buffers request bodies only up to `proxyClientMaxBodySize` (10 MB by default,
  `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`)
  and a 10 MiB part would be at that edge; the route needs no session.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, the Protected list (migrations only via `supabase migration new`, `.adw/supabase-stack reset` after a migration, never start the worker).
- `docs/conditional-docs.md`: the index; gets one line for `app_docs/upload.md`.
- `app_docs/studio.md`: upload, storage doubles, RLS rules (its rule "do not grant `authenticated` ... `insert` beyond `id`, `source_name` and `source_key`" changes in this commit to include `source_upload_id`; add `fail_upload` to the execute rules; the Upload section points to the new doc).
- `app_docs/measurement.md`: the `studio_footage_uploaded` row (still `UploadForm.tsx`, once after completion) and its E2E line.
- `app_docs/preview.md`, `app_docs/export.md`: mention the mock route's `GET`/`HEAD`; check nothing they describe depends on the route's single `PUT`.
- `packages/storage/src/storage.ts`: the `Storage` interface; add the multipart methods and types, remove `signUpload`.
- `packages/storage/src/r2.ts`, `packages/storage/src/r2.test.ts`: R2 implementation and its no-network request-handler tests.
- `packages/storage/src/fake.ts`, `packages/storage/src/fake.test.ts`: the folder fake.
- `packages/storage/src/index.ts`: exports.
- `apps/studio/src/app/upload-actions.ts`: current single-PUT actions, replaced.
- `apps/studio/src/lib/upload.ts`, `apps/studio/src/lib/upload.test.ts`: request validation, `sourceKey`, `MAX_UPLOAD_BYTES`.
- `apps/studio/src/components/UploadForm.tsx`: the upload control, replaced by the Uppy-driven form with progress.
- `apps/studio/src/lib/storage.ts`, `apps/studio/src/lib/storage.test.ts`: `studioStorage()`, `MOCK_UPLOAD_URL_BASE`; the `signUpload` tests change to `signUploadPart`.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` and `route.test.ts`: the R2 double; `PUT` becomes part-only.
- `apps/studio/src/proxy.ts`: matcher exclusion for the mock route.
- `apps/studio/src/lib/reels.ts`: named column lists, `isReelId`.
- `apps/studio/src/lib/supabase-server.ts`: the per-request client used by actions and the route.
- `apps/studio/src/lib/track.ts`: `capture("studio_footage_uploaded", ...)`.
- `supabase/migrations/20261031105245_studio_skeleton.sql`, `supabase/migrations/20261031174750_job_queue.sql`: the reels table, insert grant and policy, the current `finish_upload` (never edited; replaced by the new migration).
- `apps/studio/db-tests/rls.test.ts`: the `finish_upload` describe (its "second call errors" expectation changes to "second call returns the same job, one job").
- `apps/studio/e2e/upload.spec.ts`, `apps/studio/e2e/events.ts`, `apps/studio/test-support/fixtures.ts`, `apps/studio/test-support/local-supabase.ts`, `apps/studio/test-support/worker.ts` (`claimableJobIds`): patterns for the new spec (sign-in link, event log, cleanup, no leftover claimable jobs).
- `apps/studio/playwright.config.ts`: chromium, workers 1, through the landing address.
- `apps/studio/package.json`: gets the two Uppy dependencies.
- `knip.json`: confirm no new entry is needed (route handlers are picked up by the Next plugin).
- `node_modules/next/dist/docs/01-app/02-guides/server-actions.md`, `.../route-handlers` guide, and the `proxyClientMaxBodySize` page: read before the Next work.
- `node_modules/@uppy/aws-s3/` (after install): read its `README`/types for the exact option names (`shouldUseMultipart`, `getChunkSize`, `createMultipartUpload`, `signPart`, `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `retryDelays`, `limit`) and how a file's `s3Multipart` `{ key, uploadId }` state triggers `listParts` on resume.

### New Files

- `supabase/migrations/<stamp>_multipart_upload.sql`: created with `supabase migration new multipart_upload`.
- `apps/studio/src/app/api/uploads/[reelId]/parts/route.ts`: `GET` list parts, `POST` sign a part.
- `apps/studio/src/app/api/uploads/[reelId]/parts/route.test.ts`: unit test with the Supabase client and storage stubbed (vitest `vi.mock`), for the 401/404/400 branches and the signed answer.
- `apps/studio/src/lib/upload-session.ts`: shared server helper `ownUploadingReel(supabase, reelId)` returning `{ id, sourceKey, uploadId }` or null (used by the route and the actions).
- `apps/studio/src/lib/upload-resume.ts` and `upload-resume.test.ts`: read, write, clear and match the resume record (pure, `Storage`-like object injected).
- `apps/studio/src/lib/uploader.ts`: builds the Uppy instance with the AwsS3 plugin and the five callbacks (client module, created inside the component, never at module load).
- `apps/studio/e2e/multipart-upload.spec.ts`: the four browser cases plus ownership and abort.
- `apps/studio/test-support/footage.ts`: writes a deterministic 35 MiB `.mp4`-named file to a temp dir and returns its path, size and SHA-256.
- `app_docs/upload.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

Storage multipart methods in `packages/storage` (R2 and fake) with unit tests; the migration
(`source_upload_id`, idempotent `finish_upload`, `fail_upload`) with DB tests; the Uppy
dependencies.

### Phase 2: Core Implementation

Server actions and the parts route with ownership checks; the mock route's part `PUT`; the proxy
matcher; the uploader module, resume record and the new `UploadForm` with progress, cancel and
resume prompt.

### Phase 3: Integration

Remove `signUpload` and the single-PUT branch; update the existing upload spec's comment; the new
E2E spec, including the negative proof for resume; docs and the index; all gates.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md`, `app_docs/measurement.md` (events), the Next guides named in Relevant Files.
- `yarn workspace @edit-issebya/studio add @uppy/core@6.3.0 @uppy/aws-s3@6.3.0`, then read `node_modules/@uppy/aws-s3` types and source for the callback signatures and the resume behaviour (a file whose state has `s3Multipart: { key, uploadId }` is resumed through `listParts`). Confirm neither package has a React peer that conflicts with React 19 (`yarn npm info` showed `@uppy/core` depends on preact internally and `@uppy/aws-s3` peers only on `@uppy/core`). If `@uppy/aws-s3` cannot resume from injected state, fall back to `@uppy/golden-retriever`'s state restore with the same resume record check, and say so in `app_docs/upload.md`.

### 2. Storage interface: multipart types and methods

- In `packages/storage/src/storage.ts` add:
  - `interface UploadedPart { partNumber: number; etag: string; bytes: number }` (etag unquoted).
  - `createMultipartUpload(key, { contentType }): Promise<{ uploadId: string }>`
  - `signUploadPart(key, { uploadId, partNumber, expiresInSeconds }): Promise<string>` (a URL the browser PUTs one part to)
  - `listUploadParts(key, { uploadId }): Promise<UploadedPart[] | null>` (sorted by part number; null when the upload does not exist, completed or aborted)
  - `completeMultipartUpload(key, { uploadId, parts: { partNumber, etag }[] }): Promise<"completed" | "missing">` ("missing" when the upload id is unknown, so the caller can check the object with `head`)
  - `abortMultipartUpload(key, { uploadId }): Promise<void>` (no error when already gone)
  - `isUploadId(value)` guard (`/^[A-Za-z0-9._~-]{1,1024}$/`, wide enough for R2's opaque ids, no slash, no query characters) and `MAX_PART_NUMBER = 10000`.
- Remove `signUpload` from the interface.

### 3. R2 implementation

- In `r2.ts` implement with `CreateMultipartUploadCommand`, `UploadPartCommand` presigned through `getSignedUrl` (no checksum parameters, kept off by `requestChecksumCalculation: "WHEN_REQUIRED"`), `ListPartsCommand` paginated with `PartNumberMarker`, `CompleteMultipartUploadCommand` with parts sorted by number and ETags re-quoted, `AbortMultipartUploadCommand`. Map `NoSuchUpload` (404) to `null` / `"missing"` / no error. Every key through `assertStorageKey`, every upload id through `isUploadId`, part numbers 1 to 10000.
- Remove `signUpload`.
- Extend `r2.test.ts` (existing `answering` request-handler pattern, no network): the presigned part URL is on the R2 host, carries `partNumber` and `uploadId`, no `x-amz-checksum` or `x-amz-sdk-checksum-algorithm`; complete sends parts sorted; `NoSuchUpload` maps to `"missing"` and abort swallows it; an invalid upload id or part number 0 / 10001 throws before any request. Replace the `signUpload` describe.

### 4. Fake implementation

- In `fake.ts`: parts live under `<root>/.multipart/<uploadId>/` with a `meta.json` (`{ key }`) and one file per part (`<n>.part`, written temp-then-rename). `createMultipartUpload` makes a `randomUUID()` upload id. `signUploadPart` returns `${uploadUrlBase}${key}?uploadId=<id>&partNumber=<n>`. `listUploadParts` reads the folder (null when it is missing or its `meta.json` key differs). `completeMultipartUpload` checks the key, that every listed ETag equals the stored part's MD5, then concatenates the parts in order into a temp file next to the key and renames it, then removes the upload folder (a second call answers `"missing"`). `abortMultipartUpload` removes the folder. Add `putUploadPart(key, { uploadId, partNumber, body })` to the fake only (not the interface) for the mock route, returning the MD5.
- `list()` skips everything under `.multipart/`; `.multipart` cannot collide with a key (keys start with `[a-z0-9]`).
- Remove `signUpload`. Export what the route needs from `index.ts`.
- Extend `fake.test.ts`: full cycle with parts written out of order assembles the right bytes; a wrong ETag or a key mismatch is refused; complete twice gives `"completed"` then `"missing"` and the object stays; abort removes the parts; `list("")` never shows `.multipart` files; a part number outside 1..10000 is refused.

### 5. Migration

- `supabase migration new multipart_upload` (never hand-pick the version), then write:
  - `alter table public.reels add column source_upload_id text` with a check (`source_upload_id is null or source_upload_id ~ '^[A-Za-z0-9._~-]{1,1024}$'`).
  - `grant insert (source_upload_id) on public.reels to authenticated;` (the existing uploading-only insert policy still applies).
  - `create or replace function public.finish_upload(p_reel_id uuid, p_bytes bigint)`: same checks, but `select status into v_status from public.reels where id = p_reel_id and owner_id = (select auth.uid()) and source_key is not null for update;`; when not found or `failed`: raise as before; when `uploading`: update to `uploaded` with `source_bytes`, insert one `process` job, return its id; otherwise (already finished, any later pipeline status): return the reel's existing `process` job id (oldest), raising if there is none. The row lock makes two concurrent calls queue, so the second sees `uploaded`. Re-state the revoke/grant lines (execute for `authenticated` only).
  - `create function public.fail_upload(p_reel_id uuid) returns void`, `security definer`, `set search_path = ''`: the caller's own reel in `uploading` becomes `failed`; already `failed` is a no-op; any other state or another owner's reel raises `P0002`. Revoke from `public, anon, service_role`, grant execute to `authenticated`.
- Run `.adw/supabase-stack reset` (the only allowed reset) before `test:db` and E2E.

### 6. DB tests

- In `apps/studio/db-tests/rls.test.ts`:
  - Change "finishes the owner's upload once, queueing one job": the second call succeeds and returns the same job id; still exactly one `process` job; `source_bytes` unchanged.
  - Add: `source_upload_id` is insertable by the owner with the uploading reel and readable only by the owner (B's select gets no row).
  - Add a `fail_upload` describe: owner's uploading reel becomes `failed` (twice is fine), B's call and anon's call fail and change nothing, an `uploaded` reel is refused, `finish_upload` after `fail_upload` is refused.

### 7. Shared upload helpers

- `apps/studio/src/lib/upload.ts`: keep `parseUploadRequest` and `MAX_UPLOAD_BYTES` (5 GiB, comment now says it is a product bound, not R2's single-PUT limit); add `PART_SIZE_BYTES = 10 * 1024 * 1024` and `partCount(bytes)`. Extend `upload.test.ts`: 1 GiB accepted, 5 GiB accepted, 5 GiB + 1 refused as `too-large`, `partCount(35 MiB) === 4`, `partCount(10 MiB) === 1`.
- `apps/studio/src/lib/upload-session.ts`: `ownUploadingReel(supabase, reelId)` selects `id, status, source_key, source_upload_id` (named columns) by id through the user's client and returns them only for status `uploading` with both values set.
- `apps/studio/src/lib/upload-resume.ts`: `readResume(store)`, `writeResume(store, record)`, `clearResume(store)`, `matchesResume(record, file)`; a malformed record reads as null and is cleared. Unit tests in `upload-resume.test.ts`.

### 8. Server actions

- Rewrite `apps/studio/src/app/upload-actions.ts`:
  - `createUpload({ name, bytes, type })`: parse; session; storage and prefix; fresh reel id, key from `sourceKey`; `storage.createMultipartUpload(key, { contentType })`; insert the reel with `source_upload_id`; on insert error abort the multipart upload and answer `failed`. Answer `{ status: "ready", reelId, key, uploadId }`.
  - `completeUpload({ reelId, parts })`: validate id and parts (1..10000, unique, ETag shape); session; `ownUploadingReel` (if not uploading, call `finish_upload` anyway so a repeated call returns `finished` for an already finished reel of the caller, and nothing for anyone else); `completeMultipartUpload` with the row's key and upload id; on `"missing"` go on only if `head(key)` exists; size from `head(key).bytes`; `rpc("finish_upload", { p_reel_id, p_bytes })`; answer `{ status: "finished", reelId }`.
  - `abortUpload({ reelId })`: session; `ownUploadingReel`; `abortMultipartUpload`; `rpc("fail_upload")`.
  - Errors logged without the file name, as today. Remove `finishUpload` and the single-URL signing.

### 9. Parts route

- `apps/studio/src/app/api/uploads/[reelId]/parts/route.ts` (`dynamic = "force-dynamic"`):
  - Both methods: `isReelId` else 400; server client else 503; no user 401; `ownUploadingReel` null 404 (same answer for another user's reel and a missing one); storage null 503.
  - `GET`: `listUploadParts(row.source_key, { uploadId: row.source_upload_id })` answered as `{ parts: [{ PartNumber, ETag, Size }] }` (the shape `@uppy/aws-s3` expects); null answers `{ parts: [] }`.
  - `POST` body `{ partNumber }` (JSON, integer 1..10000, else 400): answers `{ url }` signed for 900 seconds. The body never carries file bytes.
- `route.test.ts`: with `@/lib/supabase-server` and `@/lib/storage` mocked: 401 signed out, 404 for a reel the client cannot see, 400 for part 0 and 10001 and a malformed id, 200 with a URL built from the row's key and upload id (never from the request).

### 10. Mock route and proxy

- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`: `PUT` requires `uploadId` and `partNumber` query parameters (400 otherwise; the single-object branch goes), calls the fake's `putUploadPart`, answers 200 with `ETag: "<md5>"` (quoted) and `Access-Control-Expose-Headers: ETag` (harmless same-origin, mirrors the R2 CORS rule). Still 404 for every method unless `E2E_MOCK_STORAGE` is exactly `"true"`. Update the header comment.
- `route.test.ts`: replace the single-PUT case with a part PUT that lists back through the fake; 400 without the parameters; 404 without the flag.
- `apps/studio/src/proxy.ts`: add `api/e2e-storage-mock` to the negative lookahead of the matcher, with a comment on `proxyClientMaxBodySize`.
- `apps/studio/src/lib/storage.test.ts`: replace the `signUpload` cases with `signUploadPart`.

### 11. Uploader and form

- `apps/studio/src/lib/uploader.ts`: `createUploader({ onProgress, ... })` returns a new `Uppy` with `restrictions: { maxNumberOfFiles: 1, maxFileSize: MAX_UPLOAD_BYTES }`, `autoProceed: false`, and `AwsS3` with `shouldUseMultipart: true`, `getChunkSize: () => PART_SIZE_BYTES`, `limit: 4`, `retryDelays: [0, 1000, 3000, 5000]`, and the callbacks: `createMultipartUpload` calls `createUpload` (and writes the resume record), `signPart` POSTs to `/studio/api/uploads/<reelId>/parts`, `listParts` GETs it, `completeMultipartUpload` calls `completeUpload`, `abortMultipartUpload` calls `abortUpload`. The reel id travels in the file's meta.
- `UploadForm.tsx` (client): keeps the "Clip" label and "Upload" button; checks the file with `parseUploadRequest` before anything (size message "Pick an MP4, MOV, M4V or WebM clip up to 5 GB."); shows a `<progress>` with `aria-label="Upload progress"` and `data-testid="upload-progress"` whose `value` is 0 to 100, plus "Uploading... 42%" in the live status; a "Cancel" button while uploading (calls `uppy.cancelAll()`, which triggers abort; then clears the resume record and says "Upload cancelled."). On mount (in an event-free read: `useSyncExternalStore` or a lazy initial state, not an effect that sets state) reads the resume record and shows "An upload of <name> was interrupted. Pick the same file to resume."; on submit with a matching file it adds the file with `s3Multipart: { key, uploadId }` and the reel id in meta so only missing parts are sent; a non-matching file starts a fresh upload (the old reel stays `uploading` until the lifecycle rule removes its parts; note in docs). On `complete` success: clear the record, `capture("studio_footage_uploaded", { reel_id })` exactly once, `router.push("/reels/<id>")`. Signed out answers refresh the page as today. The Uppy instance is created in the component (ref, lazily), never at module load, and closed on unmount.

### 12. Remove the single-PUT path

- Delete `signUpload` everywhere (interface, R2, fake, their tests, studio storage test) and `finishUpload`. Run `yarn knip` and remove anything it reports as unused.
- `apps/studio/e2e/upload.spec.ts`: only update the comment about "two server actions, a PUT" (the short clip is one part); its assertions (status `uploaded`, `source_bytes`, one `process` job, one event) must still pass unchanged.

### 13. E2E spec (fails without the feature)

- `apps/studio/test-support/footage.ts`: `writeFootage(dir, bytes = 35 * 1024 * 1024)` writes deterministic pseudo-random bytes (seeded, so reruns are identical) to `<dir>/footage-35mb.mp4`, returns `{ path, bytes, sha256 }`.
- `apps/studio/e2e/multipart-upload.spec.ts`, modelled on `upload.spec.ts` (sign-in link, `recordEvents`, `fakeStorage` reading `.e2e-storage/`, cleanup of objects, `.multipart` leftovers, jobs then users in `afterAll`; the `beforeAll` leftover-claimable-jobs check, and every test deletes its queued `process` job so `upload.spec.ts` stays green). Count part requests with `page.on("request")` on `PUT`s whose URL has `partNumber`, keyed by part number. Tests:
  1. **Parts**: upload the 35 MiB file; exactly 4 part numbers, each once; the progress bar reaches 100; URL becomes `/studio/reels/<id>`; the reel is `uploaded` with `source_bytes` 36700160; one `process` job `queued`; SHA-256 of `.e2e-storage/<source_key>` equals the file's; `studio_footage_uploaded` captured exactly once with the reel id.
  2. **One part fails**: `page.route` on part PUTs aborts only the first request for `partNumber=2` (`route.abort()`), continues the rest; upload completes; counts `{1:1, 2:2, 3:1, 4:1}`; hash correct; one event.
  3. **Reload resumes**: route holds part 3 and part 4 (handler awaits a promise that is released after reload, then `route.abort()` inside a try/catch) and lets 1 and 2 through; wait until both part 1 and part 2 responses are 200 and the parts route `GET` would list them (poll the fake's `listUploadParts`); `page.reload()`; `page.unrouteAll({ behavior: "ignoreErrors" })`; reset the counter; the resume prompt shows; pick the same file; Upload; after reload parts 1 and 2 are sent 0 times, 3 and 4 once each; hash correct; one `studio_footage_uploaded` in total.
  4. **Ownership**: user A creates an upload (start it with all part PUTs held, then read the reel id from the DB); in a second browser context signed in as user B, `POST /studio/api/uploads/<A's reel>/parts` with `{ partNumber: 1 }` answers 404 and `GET` answers 404; signed out answers 401; A's reel is unchanged.
  5. **Cancel**: start an upload with parts held, press Cancel; the reel becomes `failed`, its `.multipart/<uploadId>` folder is gone, no `process` job, no event.
- **Negative proof** (task, not committed): temporarily make the `listParts` callback in `uploader.ts` return `[]`, run only spec 3 (`PORT=$PORT STUDIO_PORT=$BACKEND_PORT yarn test:e2e -- multipart-upload.spec.ts -g "Reload resumes"`), confirm it fails because parts 1 and 2 are sent again, then revert the probe and confirm it passes. Record the failing output in the run's notes; `git diff` must show no trace of the probe.

### 14. Docs

- New `app_docs/upload.md` (Overview, How it works: flow diagram in words create, sign part, PUT to R2, list, complete, abort; 10 MiB parts and the R2 rule that every part but the last has the same size; retries `[0, 1000, 3000, 5000]` and 4 parallel parts; resume record and the re-pick step; the actions and the route and their ownership checks; `source_upload_id`, idempotent `finish_upload`, `fail_upload`; the fake's `.multipart/` layout and mock route; the proxy matcher exclusion; Owner steps: R2 CORS allowing `PUT` from the studio origins and exposing `ETag`, lifecycle rule aborting incomplete multipart uploads after 3 days for each prefix in use; Testing; Rules: never send file bytes to the studio's server (the mock route is R2's double, inert unless the flag is exactly `"true"`), complete is idempotent (one reel, one `process` job), every action and route checks the session and the reel's owner through RLS and takes key and upload id from the row, never from the browser, never use golden-retriever's file store for footage, never call `finish_upload` with a size the browser reported).
- `docs/conditional-docs.md`: one line, "Read `app_docs/upload.md` when changing the footage upload (UploadForm, the uploader, upload actions or the parts route), the multipart methods of `packages/storage`, `finish_upload` or `fail_upload`, `reels.source_upload_id`, the resume record, or the storage mock route's part `PUT`."
- `app_docs/studio.md`: Upload section shortened to a pointer to `upload.md`; Rules updated (insert columns now include `source_upload_id`; `anon` never executes `fail_upload`; "finishing an upload goes only through `finish_upload`" kept); the Notes line "resumable upload (single PUT only)" removed; mock route description says part `PUT`.
- `app_docs/measurement.md`: the event row says "after the multipart upload completes, once".
- `.adw/project.md`: Workspaces note on `E2E_MOCK_STORAGE` says the studio signs upload parts to the mock route; Tests lists `multipart-upload.spec.ts`. Keep the nine headings untouched.

### 15. Validation

- Run every command in `Validation Commands`.

## Testing Strategy

### Unit Tests

- `packages/storage/src/r2.test.ts`: multipart commands, presigned part URL shape, `NoSuchUpload` mapping, input guards.
- `packages/storage/src/fake.test.ts`: assembly, ETag and key checks, idempotent complete, abort, `list` hides parts.
- `apps/studio/src/lib/upload.test.ts`: 1 GiB accepted, above 5 GiB refused, `partCount`.
- `apps/studio/src/lib/upload-resume.test.ts`: record round trip, malformed record, file matching.
- `apps/studio/src/app/api/uploads/[reelId]/parts/route.test.ts`: session and ownership branches, bounds, key and upload id from the row.
- `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.test.ts`: part `PUT`, 400 without parameters, 404 without the flag.
- `apps/studio/src/lib/storage.test.ts`: `signUploadPart` through the fake.

### Test Coverage

- E2E `apps/studio/e2e/multipart-upload.spec.ts` "Parts": catches a non-multipart upload, wrong part size, missing progress, wrong `source_bytes` or a corrupted assembled object (fails today: one PUT, no `partNumber`, no progress bar).
- E2E "One part fails": catches a whole-upload failure or full restart on one failed part.
- E2E "Reload resumes" (plus the recorded negative proof): catches re-sending parts R2 already has after a reload.
- E2E "Ownership": catches signing or listing parts for another user's reel through the route.
- E2E "Cancel": catches an abort that leaves the reel `uploading` or its parts in storage.
- DB `apps/studio/db-tests/rls.test.ts` `finish_upload` twice: catches a second completion inserting a second `process` job or raising (today it raises). `fail_upload` cases: catch an owner failing another's reel or a finished one.
- Unit tests above: catch R2 command shape regressions, fake assembly bugs and the browser size bound without a browser.
- `studio_footage_uploaded` once: asserted in every E2E case above and still in `upload.spec.ts`.

### Edge Cases

- File of exactly 10 MiB (one part), file just above (two parts, last tiny), 35 MiB (4 parts, last 5 MiB).
- File above 5 GiB: refused in the browser, no server call (unit on the shared parser; the form uses it first).
- Empty file, wrong extension or type: refused as today.
- Complete called twice (double click, retry after a lost answer): one job, second answer `finished`.
- Complete after R2 already completed but the answer was lost: `"missing"` plus `head` present continues to `finish_upload`.
- Reload then picking a different file: fresh upload; the old reel stays `uploading`, its parts expire by the lifecycle rule.
- Resume record for a reel that is no longer `uploading` (finished in another tab, cancelled): the parts route answers 404, the form clears the record and asks for a fresh upload.
- Session expired mid-upload: 401 from the route, the form refreshes to the login.
- Part numbers 0 and 10001, malformed upload ids, keys with `..`: refused before any storage call.
- Signed URL expiry during a long part: each part is signed just before it is sent, 900 seconds.

## Acceptance Criteria

- A 35 MiB file uploads in 4 part requests to presigned part URLs; the progress bar reaches 100; the reel is `uploaded` with `source_bytes` 36700160 and the assembled object's SHA-256 matches.
- A part whose first attempt fails is retried alone and the upload completes (part 2 sent twice, others once).
- After a reload with parts 1 and 2 done, picking the same file resumes and parts 1 and 2 are not sent again.
- The negative proof was run: with listing disabled the resume spec fails; the probe is removed.
- Calling complete twice leaves one `process` job (DB test).
- User B gets 404 signing or listing parts for user A's reel; signed out gets 401.
- `studio_footage_uploaded` is captured exactly once per upload, after completion.
- No request carrying file bytes reaches the studio's server except the mock route under `E2E_MOCK_STORAGE=true`; `signUpload`, `finishUpload` and the single-object mock `PUT` are gone; knip is clean.
- Files up to 5 GiB (so at least 1 GB) are accepted; larger are refused in the browser with a message.
- `app_docs/upload.md` and its index line exist; `app_docs/studio.md` rules updated in the same commit; no em-dashes anywhere.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `yarn format:check`: Prettier over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./packages/storage`: lint the two changed workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker`: typecheck, including the worker, which consumes the changed `Storage` interface.
- `yarn knip`: dead code; proves the single-PUT path is gone and nothing new is unused.
- `yarn turbo run test --filter=./apps/studio --filter=./packages/storage --filter=./apps/worker`: unit tests, including the migration version guard and the worker's storage users.
- `.adw/supabase-stack reset`: apply the new migration to the ADW stack (the only allowed reset).
- `yarn turbo run test:db --filter=./apps/studio`: idempotent `finish_upload`, `fail_upload`, `source_upload_id` RLS.
- `yarn turbo run build --filter=./apps/studio`: the studio builds with the uploader and the new route.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the issue's full gate, unfiltered.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites against the run's servers (values from `.ports.env`), including `multipart-upload.spec.ts` and the unchanged `upload.spec.ts`.

## Notes

- New dependencies: `@uppy/core@6.3.0` and `@uppy/aws-s3@6.3.0` in `@edit-issebya/studio` (`yarn workspace @edit-issebya/studio add ...`). `@uppy/golden-retriever` is deliberately not added (reason in Solution Statement). No Uppy UI or React bindings: the progress bar is ours.
- Choice for abort: the reel is marked `failed` through `fail_upload`, not deleted, because `authenticated` has no `delete` on `reels` (a studio rule) and a failed row keeps the history visible.
- Server actions for the three mutations keep Next's built-in origin check; the parts route relies on the Supabase session cookie (`SameSite=Lax`) and answers JSON only, never bytes.
- R2 requires every part except the last to be the same size; a fixed `getChunkSize` guarantees it.
- Not verified by the pipeline: real R2 multipart, CORS (`PUT` allowed, `ETag` exposed), the lifecycle rule, real network drops. These are the owner's manual acceptance and owner steps from the issue.
- Out of scope: phone or link upload, several clips per reel, file format and length checks (slice 16).
- The worker is unaffected except that it consumes the `Storage` interface; it never called `signUpload`.
