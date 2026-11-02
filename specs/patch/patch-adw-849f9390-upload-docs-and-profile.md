# Patch: Add the upload feature doc and bring studio, measurement and profile docs in step

## Metadata

adw_id: `849f9390`
review_change_request: `Issue #1: Spec step 14 (Docs) and the acceptance criterion "app_docs/upload.md and its index line exist" are not in the diff. app_docs/upload.md does not exist, docs/conditional-docs.md has no line for it, app_docs/measurement.md and .adw/project.md are not updated, and app_docs/studio.md's Upload section and Notes still describe the deleted single-PUT path. Resolution: add app_docs/upload.md (Overview; How it works; Owner steps; Testing; Rules) describing the real Companion-protocol design, add the index line, shorten studio.md's Upload section to a pointer, drop the single-PUT Notes item, describe the mock route's PUT as part-only, update measurement.md's event row and E2E line, and add multipart-upload.spec.ts and the part signing to .adw/project.md without touching its nine headings. No em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-36-adw-849f9390-sdlc_planner-resumable-multipart-footage-upload.md`
**Issue:** Spec step 14 was never done. `app_docs/upload.md` is missing, so the library-forced design change (Uppy Companion-protocol route handlers instead of server actions plus a parts route, and parts sent one at a time) is recorded nowhere. `docs/conditional-docs.md` has no line for it. `app_docs/studio.md` lines 65 to 81 still describe `apps/studio/src/app/upload-actions.ts` (deleted) and a single presigned PUT capped by "R2's single-PUT limit", line 142 says the mock route stands in for R2's PUT in general, line 238 lists "resumable upload (single PUT only)" as a later slice, and the Testing E2E line (198 to 200) omits `multipart-upload.spec.ts`. `app_docs/measurement.md` line 93 says the event fires when "an upload finishes" and lines 126 to 127 name only `upload.spec.ts`. `.adw/project.md` line 66 says the studio "sign uploads" to the mock route and the Tests section never names `multipart-upload.spec.ts`.
**Solution:** Docs only, no code. Write `app_docs/upload.md` from the code as it is on this branch, add the spec's index line (worded for the route handlers, since there are no upload actions), and make targeted edits to `app_docs/studio.md`, `app_docs/measurement.md` and `.adw/project.md`.

## Files to Modify

Use these files to implement the patch:

- `app_docs/upload.md` (new)
- `docs/conditional-docs.md`
- `app_docs/studio.md`
- `app_docs/measurement.md`
- `.adw/project.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Read the code the doc describes, then write `app_docs/upload.md`

- Read first so every statement is true of this branch: `apps/studio/src/lib/uploader.ts`, `apps/studio/src/lib/upload.ts`, `apps/studio/src/lib/upload-routes.ts`, `apps/studio/src/lib/upload-server.ts`, `apps/studio/src/lib/upload-resume.ts`, `apps/studio/src/components/UploadForm.tsx`, the five route files under `apps/studio/src/app/api/uploads/s3/multipart/`, `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts`, `apps/studio/src/proxy.ts` (matcher comment), `packages/storage/src/storage.ts`, `packages/storage/src/fake.ts`, `supabase/migrations/20261101212954_multipart_upload.sql`, `apps/studio/e2e/multipart-upload.spec.ts`. Copy the header style of an existing doc (for example `app_docs/export.md`: title, spec link list, then sections).
- Sections, in this order: `## Overview`, `## How it works`, `## Owner steps`, `## Testing`, `## Rules` (a short `## Notes` is allowed for out-of-scope items).
- Overview: footage goes from the browser straight to R2 as a multipart upload in 10 MiB parts (`PART_SIZE_BYTES`), up to 5 GiB (`MAX_UPLOAD_BYTES`, a product bound, not an R2 limit), resumable after a reload, cancellable; the studio's server never sees file bytes.
- How it works, with subsections:
  - Browser: a headless `@uppy/core` 6.3.0 with `@uppy/aws-s3` 6.3.0 (no Uppy UI, our own progress bar in `UploadForm.tsx`), created per upload in `createUploader` (`uploader.ts`), in `companionEndpoint` mode pointed at `UPLOAD_ENDPOINT`, `shouldUseMultipart: true`, a fixed `getChunkSize` (R2 requires every part but the last to be the same size), `limit: 1`. Parts go one at a time; a failed part request (network error or 5xx) is retried on its own by Uppy's built-in policy, three retries with backoff, and only that part is sent again.
  - Design change from the spec, stated explicitly: the spec planned three server actions plus one parts route, four parallel parts and custom retry delays. `@uppy/aws-s3` in Companion mode speaks a fixed HTTP protocol, so the studio implements that protocol as route handlers instead, and parts are sent sequentially with Uppy's default retries. List the routes under `apps/studio/src/app/api/uploads/s3/multipart/`: `POST` (create: validates name, size, `video/` type and extension through `upload.ts`, inserts the `uploading` reel with `source_key` and `source_upload_id` through the user's client, returns key and upload id), `GET [uploadId]` (list the uploaded parts), `DELETE [uploadId]` (abort: storage drops the parts, `fail_upload` marks the reel `failed`), `GET [uploadId]/[partNumber]` (sign one part URL), `POST [uploadId]/complete` (assemble, then `finish_upload`). Logic lives in `upload-server.ts`; `upload-routes.ts` is the shared request and response glue.
  - Ownership: every route reads the session; the reel is looked up by `source_upload_id` through the user's own client, so RLS returns only the caller's reel; key and upload id come from that row, never from the browser; another user's or a signed-out caller's request gets the same not-found answer.
  - Database: `reels.source_upload_id` (checked format, insertable by `authenticated` under the uploading-only policy), `finish_upload` idempotent (a second complete leaves one reel and one `process` job), `fail_upload` for cancel (the reel stays as `failed`, since `authenticated` has no delete on `reels`). Size recorded by `finish_upload` comes from storage, never from the browser.
  - Resume: `upload-resume.ts` keeps a record (reel id, key, upload id, file name, size, last modified) in `localStorage`; after a reload the form asks the owner to pick the same file again, `matchesResume` checks it, and Uppy resumes from `{ key, uploadId }` by listing parts and sending only the missing ones. Skip already claimed reels when re-picking (commit 41177f3): describe what `UploadForm.tsx` actually does.
  - Storage: the multipart methods of the `Storage` interface (`createMultipartUpload`, `signUploadPart`, `listUploadParts`, `completeMultipartUpload`, `abortMultipartUpload`, `isUploadId`, `MAX_PART_NUMBER`); `signUpload` is gone. R2 implementation via the S3 multipart commands; the fake keeps parts under `<root>/.multipart/<uploadId>/` (`meta.json` plus `<n>.part`), assembles on complete and is invisible to `list()`.
  - Mock route: under `E2E_MOCK_STORAGE=true` (exactly) the studio signs part URLs to `/studio/api/e2e-storage-mock/...?uploadId=&partNumber=`; that route's `PUT` accepts upload parts only and answers 404 otherwise. It is left out of the `proxy.ts` matcher because proxy buffers a body only up to 10 MB and a part is 10 MiB.
  - Event: `studio_footage_uploaded` fires once, after complete succeeds.
- Owner steps: (1) R2 bucket CORS allowing `PUT` from the studio origins (listing and completing go through the studio's routes, so the browser only PUTs to R2) with `ETag` in `ExposeHeaders`, without which Uppy cannot read part ETags and every complete fails; (2) a lifecycle rule aborting incomplete multipart uploads after 3 days for each key prefix in use. Note these are not verified by the pipeline, together with real network drops.
- Testing: unit (`packages/storage` `r2.test.ts` and `fake.test.ts` multipart cases, `apps/studio/src/lib/upload-server.test.ts`, `upload-resume.test.ts`, `upload.test.ts`, the mock route test), DB (`yarn turbo run test:db --filter=./apps/studio`: idempotent `finish_upload`, `fail_upload`, `source_upload_id` RLS; name the file actually holding them), E2E `apps/studio/e2e/multipart-upload.spec.ts` (its five tests: four 10 MiB parts with progress, one failed part re-sent alone, reload resumes sending only missing parts, ownership on all routes, cancel leaves the reel `failed` with no parts and no job) plus the unchanged `upload.spec.ts`.
- Rules (each an invariant): never send file bytes to the studio's server (the mock route is R2's double, inert unless the flag is exactly `"true"`); complete is idempotent (one reel, one `process` job); every route checks the session and finds the reel by `source_upload_id` through RLS, taking key and upload id from the row, never from the browser; never call `finish_upload` with a size the browser reported; never use `@uppy/golden-retriever`'s file store for footage; keep a fixed part size (every part but the last the same size); do not add Uppy UI packages.
- No em-dashes.

### Step 2: Add the index line to `docs/conditional-docs.md`

- Append after the `app_docs/export.md` line: "Read `app_docs/upload.md` when changing the footage upload (`UploadForm`, the uploader, the upload routes under `apps/studio/src/app/api/uploads/s3/multipart/`), the multipart methods of `packages/storage`, `finish_upload` or `fail_upload`, `reels.source_upload_id`, the resume record, or the storage mock route's part `PUT`."
- In the existing `app_docs/studio.md` line, leave the wording as is (it still covers the studio broadly).

### Step 3: Update `app_docs/studio.md`

- Replace the body of `### Upload` (lines 67 to 81) with: the key format `<R2_KEY_PREFIX>reels/<reel id>/source/original.<ext>` and the insert policy sentence (both still true), `apps/studio/src/lib/storage.ts`'s `studioStorage()` bullet, and one pointer: "The resumable multipart upload (`UploadForm`, the uploader, the routes under `apps/studio/src/app/api/uploads/s3/multipart/`, `finish_upload`, `fail_upload`, `source_upload_id`, resume) is described in `app_docs/upload.md`." Remove every mention of `upload-actions.ts`, `finishUpload`, the presigned single PUT and "R2's single-PUT limit".
- Line 14 Overview phrase "an upload straight to Cloudflare R2" stays; line 160 How to Use step stays.
- In `### Storage and AI doubles` (line 142), change "stands in for R2's PUT" to "stands in for R2's upload part `PUT` (part requests only, see `app_docs/upload.md`)".
- In `## Testing` E2E bullet (lines 198 to 200), add `multipart-upload` to the spec list and one clause that `multipart-upload.spec.ts` covers parts, a retried part, resume, ownership and cancel (details in `app_docs/upload.md`).
- In `## Notes` (line 238), remove "resumable upload (single PUT only)" so the item reads "Processing, edits and render steps and a retry limit are later slices; ..." (or drop the item if every remaining part is now done; check against the other docs and keep it minimal).
- Leave `## Rules` as already updated on this branch.

### Step 4: Update `app_docs/measurement.md`

- Line 93: the `studio_footage_uploaded` "when" cell becomes "after the multipart upload completes, once (`UploadForm.tsx`)"; keep the table column widths aligned (Prettier reformats the table).
- Lines 126 to 127: the Studio E2E bullet adds `e2e/multipart-upload.spec.ts` (`studio_footage_uploaded` once with the reel id and `app` after completion, also after a retried part and after a resume, and never after cancel).

### Step 5: Update `.adw/project.md` without touching any `##` heading

- Workspaces, line 66: "`E2E_MOCK_STORAGE=true` makes the studio sign upload parts to its `/studio/api/e2e-storage-mock` route (part `PUT` only), which writes into the gitignored `.e2e-storage/` folder ..." (rest unchanged).
- Tests, E2E code suites paragraph: after the `upload.spec.ts` clause add "`multipart-upload.spec.ts` uploads a 35 MiB clip in four 10 MiB parts through the mock route, re-sends only a failed part, resumes after a reload sending only the missing parts, refuses another user's and a signed-out caller's sign, list, complete and abort, and on cancel leaves the reel `failed` with no parts and no job,".
- Confirm with `grep -c '^## ' .adw/project.md` that the count is still 9 and the order unchanged.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `test -f app_docs/upload.md && grep -n 'app_docs/upload.md' docs/conditional-docs.md && grep -n 'multipart-upload.spec.ts' .adw/project.md app_docs/measurement.md app_docs/studio.md app_docs/upload.md`: the doc, its index line and the spec mentions exist.
- `! grep -rn 'upload-actions\|finishUpload\|single PUT\|single-PUT' app_docs/studio.md && ! grep -rn "$(printf '\342\200\224')" app_docs/upload.md app_docs/studio.md app_docs/measurement.md docs/conditional-docs.md .adw/project.md && grep -c '^## ' .adw/project.md`: no stale single-PUT text, no em-dashes, nine headings.
- `yarn format:check`: Prettier over the whole repository (run `yarn format` first if a table needs realigning).
- `yarn lint && yarn typecheck && yarn knip && yarn test`: the commit and push gates still pass (docs-only change, root-only target).

## Patch Scope

**Lines of code to change:** about 150 to 200 lines of Markdown (about 130 new in `app_docs/upload.md`, the rest small edits), no code.
**Risk level:** low
**Testing required:** none new; docs only. Format check and the commit and push gates must pass.
