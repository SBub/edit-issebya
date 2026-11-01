# Patch: write the multipart upload docs and update the studio and measurement docs

## Metadata

adw_id: `67f9b648`
review_change_request: `Issue #1: Step 18 (Documentation) and the acceptance criterion about docs are not in the diff. app_docs/upload.md does not exist, docs/conditional-docs.md has no line for it, and app_docs/studio.md and app_docs/measurement.md are unchanged. The new abort_upload is a second owner path to change a reel's status, which breaks the studio.md rule "finishing an upload goes only through finish_upload" (AGENTS.md: a change that breaks a feature-doc rule changes that rule in the same commit). studio.md still describes the 5 GiB single PUT and its Notes still say "resumable upload (single PUT only)". Resolution: write app_docs/upload.md with the sections and Rules from spec step 18, add its index line, update studio.md (Upload section, idempotent finish_upload, abort_upload, the status rule, the anon rule, Storage doubles, Testing, Notes, Specifications) and measurement.md (studio_footage_uploaded "when" cell, Testing). No em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md

**Issue:** Spec step 18 was left to the document phase. Only `.adw/project.md` and
`apps/studio/.env.example` were updated. `app_docs/upload.md` is missing and has no index line.
`app_docs/studio.md` still describes the single PUT and still has the rule that `abort_upload` now
breaks. `app_docs/measurement.md` still has the old trigger for `studio_footage_uploaded`.

**Solution:** Write all of step 18's documentation on this branch: a new `app_docs/upload.md`, its
line in `docs/conditional-docs.md`, and the edits step 18 lists for `app_docs/studio.md` and
`app_docs/measurement.md`. Docs only, no code changes. Every name the docs use comes from the code
that is already on the branch.

## Files to Modify

- `app_docs/upload.md` (new)
- `docs/conditional-docs.md`
- `app_docs/studio.md`
- `app_docs/measurement.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Write `app_docs/upload.md`

Read these files first so every name in the doc is a real one:
`apps/studio/src/lib/upload.ts` (`MAX_UPLOAD_BYTES`, `PART_BYTES`, `parseSignRequest`,
`retryDelayMs`), `apps/studio/src/lib/upload-service.ts` (`createUploadFor`,
`signUploadRequestFor`, `finishUploadFor`, `abortUploadFor`), `apps/studio/src/app/upload-actions.ts`
(`createUpload`, `signUploadRequest`, `finishUpload`, `abortUpload`),
`apps/studio/src/lib/upload-resume.ts` (`RESUME_STORAGE_KEY` = `studio-upload-resume`,
`matchesFile`), `apps/studio/src/lib/multipart-upload.ts` (`startUpload`, the `online` listener),
`apps/studio/src/components/UploadForm.tsx`, `packages/storage/src/storage.ts`, `r2.ts`, `fake.ts`,
`fake-multipart.ts`, `apps/studio/src/app/api/e2e-storage-mock/[...key]/route.ts` and
`supabase/migrations/20261101120000_multipart_upload.sql`.

- Title: `# Footage upload: resumable multipart upload straight to R2`.
- Use the same structure as `app_docs/studio.md`: **Specifications:** (list
  `specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md`), `## Overview`,
  `## How it works` (with `###` subsections), `## How to Use`, `## Configuration`, `## Testing`,
  `## Rules`, `## Notes`.
- How it works must cover:
  - The flow from start to finish: `createUpload` inserts the `uploading` reel, Uppy signs and sends
    create, parts, list and complete, then `finishUpload` runs.
  - Part size: `PART_BYTES` is 10 MiB. All parts are the same size and each is at least 5 MiB
    except the last (S3 and R2 require this).
  - The 1 GiB browser limit (`MAX_UPLOAD_BYTES`) and its message "Pick a clip up to 1 GB.".
  - The uploader: `@uppy/core` and `@uppy/aws-s3` 6.3.0. Explain why `@uppy/golden-retriever` is not
    used: its IndexedDB store caps a file at 10 MiB.
  - Signing per request: copy the spec's Solution Statement table of actions and their ownership
    checks (create, sign part, list parts, complete S3, complete studio, abort).
  - Retry: `retryDelayMs` backoff through `uppy.retryUpload`, which lists parts and sends only the
    missing ones. The `online` event retries at once.
  - Resume: the `localStorage` record under `studio-upload-resume` holds the reel id, key, upload
    id, file name, size and last-modified time. After a reload the owner picks the same file again
    (`matchesFile`), `s3Multipart` is set and Uppy lists the parts. The record is removed on finish,
    cancel or discard.
  - Abort: `abortUpload` aborts the multipart upload on the server first, then `abort_upload` marks
    the reel `failed`. The row is never deleted. `abort_upload` is idempotent on an already `failed`
    reel.
  - `finish_upload` is idempotent. It locks the row (`for update`). The size comes from a
    server-side HEAD of the object, never from the browser. One reel always has one `process` job.
  - The fake: `fakeMultipart` keeps its state under `.e2e-storage/.multipart/<uploadId>/` and binds
    each upload id to its key. Describe the mock route's S3 verbs (`POST ?uploads`,
    `PUT ?partNumber&uploadId`, `GET ?uploadId`, `POST ?uploadId`); a plain PUT is refused.
- Configuration: no new variables. The `R2_STUDIO_*` key needs multipart rights (an "Object Read &
  Write" token has them). Add the owner steps from the spec Notes:
  - CORS: allow `PUT`, `POST` and `GET`, allow the `Content-Type` header, expose `ETag`. `DELETE`
    is not needed.
  - Lifecycle: abort incomplete multipart uploads after 3 days for each prefix in use.
  - The pipeline cannot verify either step.
- Testing: the unit tests from the spec's Testing Strategy, `apps/studio/db-tests/upload.test.ts`
  and `apps/studio/e2e/multipart-upload.spec.ts` (a 35 MiB clip in 10 MiB parts; a failed part, a
  reload that resumes, Cancel, the 1 GiB limit).
- Rules: copy spec step 18's seven bullets word for word (no bytes through the studio's server;
  sign only after the session and owner `uploading` key check; never sign a single PutObject or a
  DELETE for the browser; `source_bytes` not from the browser; `finish_upload` stays idempotent; the
  upload id is not stored in `reels` without changing the studio.md insert rule; no Uppy instance at
  module load or in render).
- Notes: the resume restores the upload's identity, not the file. The `localStorage` record is
  functional state and needs no legal-page change. Out of scope: phone or link upload, several clips
  per reel, format and length checks, a job retry limit.
- No em-dashes.

### Step 2: Add the index line in `docs/conditional-docs.md`

- After the `app_docs/studio.md` line, add exactly: "- Read `app_docs/upload.md` when changing the
  footage upload: the upload form or progress bar, multipart signing, the upload server actions,
  retries, resume, `finish_upload` or `abort_upload`, the storage multipart methods or the mock
  route's multipart verbs."

### Step 3: Update `app_docs/studio.md`

- **Specifications** (lines 3 to 6): add
  `- specs/issue-36-adw-67f9b648-sdlc_planner-resumable-multipart-r2-upload.md`.
- **Upload** section (lines 64 to 80):
  - Replace the `upload-actions.ts` bullet (the 5 GiB single-PUT text) and the `UploadForm.tsx`
    bullet with one bullet. It says `createUpload` validates (name, size up to 1 GiB, `video/` type,
    extension `mp4`, `mov`, `m4v` or `webm`) and inserts the `uploading` row through the user's own
    client. The browser then sends the file to R2 in multipart parts. The studio's server never sees
    the bytes. The bullet ends with "See `app_docs/upload.md`".
  - Keep the key bullet and the `storage.ts` bullet.
  - Change the `finish_upload` bullet to say it is idempotent: it locks the row, a repeat call
    returns the same `process` job id, and `p_bytes` is the stored object's size from a server HEAD.
  - Add a bullet for `abort_upload(p_reel_id)` (`security definer`, executable by `authenticated`
    only). It moves the owner's `uploading` reel to `failed`, returns quietly if the reel is already
    `failed`, and refuses anything else. `abortUpload` aborts the multipart upload in storage before
    calling it.
- **Storage and AI doubles** (lines 122 to 124): replace "stands in for R2's PUT" with "stands in
  for R2's S3 multipart verbs (create, part, list, complete); a plain PUT is refused". Also mention
  `fakeMultipart` and `.e2e-storage/.multipart/`.
- **Testing**:
  - DB bullet: add `upload.test.ts` (signing ownership, idempotent `finish_upload` including
    concurrent calls, `abort_upload`).
  - E2E bullet: add `multipart-upload` to the spec list, then add one sentence:
    "`multipart-upload.spec.ts` sends a 35 MiB clip in 10 MiB parts: a failed part, a reload that
    resumes, Cancel, the 1 GiB limit."
- **Rules**:
  - Line 182 to 183 becomes: "- Never give the owner a general right to write `status`; status
    changes from the owner go only through `finish_upload` and `abort_upload`."
  - Line 184 becomes: "- Never let `authenticated` or `anon` execute `claim_job`, or `anon` execute
    `finish_upload` or `abort_upload`."
- **Notes** (lines 203 to 204): drop "resumable upload (single PUT only)". The line then reads
  "Processing, edits and render steps and a retry limit are later slices; the `receive` step is a
  placeholder."
- No em-dashes.

### Step 4: Update `app_docs/measurement.md`

- Events table (line 91): change the `studio_footage_uploaded` "Sent when" cell to "the whole file
  is in storage and `finishUpload` succeeded, once per upload". Keep the `(UploadForm.tsx)` file
  reference if it fits. Let Prettier re-pad the table.
- Testing, Studio E2E bullet (lines 121 to 122): add `e2e/multipart-upload.spec.ts`
  (`studio_footage_uploaded` exactly once per upload, through a retry and a resume).

### Step 5: Format and check for em-dashes

- Run `yarn format` so the new table widths and wrapping are Prettier-clean.
- Run `grep -n "—" app_docs/upload.md app_docs/studio.md app_docs/measurement.md docs/conditional-docs.md`.
  It must print nothing.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`: Prettier over the whole repository, including the new and edited docs.
- `yarn knip`: the docs-only change leaves the dead-code check clean.
- `grep -rn "—" app_docs docs`: no em-dash in any doc (must print nothing).
- `test -f app_docs/upload.md && grep -c "app_docs/upload.md" docs/conditional-docs.md`: the doc
  exists and the index lists it once.
- `grep -n "abort_upload" app_docs/studio.md && ! grep -n "single PUT only\|5 GiB" app_docs/studio.md`:
  studio.md describes `abort_upload` and no longer describes the single PUT.

## Patch Scope

**Lines of code to change:** about 150 (about 120 new in `app_docs/upload.md`, about 30 edited in
`app_docs/studio.md`, `app_docs/measurement.md` and `docs/conditional-docs.md`)

**Risk level:** low

**Testing required:** documentation only. Prettier, knip and the em-dash grep. No code, test or
migration changes, so the unit, DB and E2E suites are unaffected.
