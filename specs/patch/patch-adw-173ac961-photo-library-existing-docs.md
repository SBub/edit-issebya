# Patch: Update the existing feature docs for the photo library

## Metadata

adw_id: `173ac961`
review_change_request: `Issue #1: Step 14 of the spec asks for edits to existing feature docs, and these are not in the diff. (1) app_docs/studio-reel-layout.md still lists 'the photo library' under Out of scope and still describes three phone tabs (lines 23, 86, 100); it has nothing on the third column or on ThumbnailGrid's button tiles, aspect and columns. (2) app_docs/studio.md has nothing on the photos table, the describe_photo kind, nullable reel_id with photo_id, or the library panel and tab. (3) app_docs/failures.md, app_docs/measurement.md and app_docs/error-tracking.md lack their one line each for photo jobs (waiting, photo.id, photo_id). Resolution: edit those five docs as listed, no em-dashes, then run yarn format. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-96-adw-173ac961-sdlc_planner-photo-library.md` (Step 14)
**Issue:** Five existing feature docs were not updated for the photo library: `studio-reel-layout.md`
still says three phone tabs and lists the photo library as out of scope; `studio.md` has no `photos`
table, `describe_photo` kind, nullable `reel_id` with `photo_id`, or library panel; `failures.md`,
`measurement.md` and `error-tracking.md` lack their one line each for photo jobs.
**Solution:** Documentation-only edits in place to those five files, matching what the branch's code
does (`ReelScreen.tsx`, `ThumbnailGrid.tsx`, `PhotoLibrary.tsx`, `PhotoDialog.tsx`, the
`20261102191719_photo_library.sql` migration, `telemetry.ts` `targetAttributes`,
`error-tracking.ts` `photo_id`). No code change. `app_docs/photo-library.md` and its index line stay
with the document phase.

## Files to Modify

- `app_docs/studio-reel-layout.md`
- `app_docs/studio.md`
- `app_docs/failures.md`
- `app_docs/measurement.md`
- `app_docs/error-tracking.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

Before writing, confirm each fact against the branch's code (`apps/studio/src/components/ReelScreen.tsx`,
`ThumbnailGrid.tsx`, `PhotoLibrary.tsx`, `apps/studio/src/app/reels/[id]/page.tsx`,
`supabase/migrations/20261102191719_photo_library.sql`, `apps/worker/src/telemetry.ts`,
`apps/worker/src/error-tracking.ts`, `apps/worker/src/photos/describe-photo.ts`). No em-dashes anywhere.

### Step 1: `app_docs/studio-reel-layout.md`

- Overview (line 9 to 12): add that the reel page also carries the photo library: a third column on
  desktop and a fourth tab on a phone.
- How it works, `ReelScreen.tsx` bullet (lines 18 to 24): desktop gains a third column, the library
  (`library-area`, `id="reel-panel-library"`), spanning every row
  (`lg:grid-cols-[minmax(0,1fr)_20rem_18rem]`, wider at `xl:`), `min-h-0` on its growing children;
  phone tabs become Edit, Versions, Status and Library (arrows, Home and End wrap over four); the
  areas' test ids become four (`edit-area`, `versions-area`, `status-area`, `library-area`). Add that
  `ReelScreen` takes a `library` prop.
- `LiveReel.tsx` bullet: it passes the `library` node through; `reels/[id]/page.tsx` loads the
  library on the server and renders `PhotoLibrary` into it (details in `app_docs/photo-library.md`).
- `ThumbnailGrid.tsx` bullet (lines 71 to 74): an item has `href` (a link tile) or `onSelect` (a
  `<button>` tile); prop `aspect` (`"portrait"` default 9:16, `"square"`) and prop `columns`
  (`"page"` default, 3 on a phone up to 8 wide; `"panel"`, 3 at every width). Replace "so the photo
  library can reuse it" with "the photo library uses it with `onSelect`, `aspect="square"` and
  `columns="panel"`". Reels are unchanged.
- How to Use step 5 (line 86): "switch between the Edit, Versions, Status and Library tabs"; add a
  sentence that on desktop the library is the right-hand column.
- Testing (line 100): "the phone's four tabs"; add `photo-library.spec.ts` (library column right of
  `edit-area` at 1440x900, Library tab at 390x844, no page scroll).
- Notes, Out of scope (line 129): drop "the photo library (it will reuse `ThumbnailGrid`)", leaving
  "editing from the timeline"; add `app_docs/photo-library.md` to "Other docs to read with it".

### Step 2: `app_docs/studio.md`

- Title/Overview: mention the photo library beside reels where the overview lists what the studio holds.
- Under "Jobs, steps and the lease" (after the export/render migration bullet, about line 94), add a
  bullet for `supabase/migrations/20261102191719_photo_library.sql`: table `public.photos` (owner,
  `r2_key`, `upload_id`, file name, content type, size and dimensions, status `uploading`,
  `describing`, `ready` or `failed`, description, tags, model, prompt version, `thumbnail_key`,
  `large_key`; owner-only `select` and a column-limited `insert` of an `uploading` row; in
  `supabase_realtime`); the sixth job kind `describe_photo`; `reel_id` is now nullable on `jobs`,
  `steps` and `stored_files`, each with a `photo_id` beside it (cascade) and a check that exactly one
  is set (`jobs_target_check` also ties `describe_photo` to `photo_id`); owners never insert a
  `describe_photo` job directly, `finish_photo_upload` queues it; `claim_job` keeps one job per reel
  or per photo at a time. Point to `app_docs/photo-library.md` for the rest.
- Under "Live status" (or "Reels", wherever the reel page is described), add a line: the reel page
  carries the photo library (`PhotoLibrary`, its own Realtime channel on `photos`), the third desktop
  column and the phone's Library tab (`app_docs/studio-reel-layout.md`).
- Testing: add `photos.test.ts` to the DB integration list.
- Do not change any existing Rules line.

### Step 3: one line each in `failures.md`, `measurement.md`, `error-tracking.md`

- `app_docs/failures.md`, "Waiting for the AI" (after the `waitJob` bullet, about line 138): "A
  `describe_photo` job waits the same way (`waiting_ai`, `not_before` 15 minutes on); its photo stays
  `describing` until the job is claimed again."
- `app_docs/measurement.md`, Telemetry bullet (lines 61 to 66): add that a `describe_photo` job's
  trace uses the photo's id (`traceIdForJob`) and its spans carry `photo.id` in place of `reel.id`
  (`targetAttributes`).
- `app_docs/error-tracking.md`, Worker section (after the `withStep` bullet, about line 80): "A
  photo job's exception carries `photo_id` (beside a null `reel_id`) in place of a reel id."
  Do not alter the stable-messages table except to add `photo_id` to the `worker: step failed`
  row's properties if the code sends it there (`apps/worker/src/error-tracking.ts`).

### Step 4: Format and check

- Run `yarn format`, then `grep -n "—" app_docs/*.md` must print nothing for the five files.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `grep -c "—" app_docs/studio-reel-layout.md app_docs/studio.md app_docs/failures.md app_docs/measurement.md app_docs/error-tracking.md` (every count 0)
- `grep -n "three tabs\|three phone tabs\|the photo library (it will" app_docs/studio-reel-layout.md` (prints nothing)
- `grep -n "photos\|describe_photo\|photo_id" app_docs/studio.md` and `grep -n "photo" app_docs/failures.md app_docs/measurement.md app_docs/error-tracking.md` (each file has its line)
- `yarn knip` (docs-only change, unchanged result)

## Patch Scope

**Lines of code to change:** about 40 lines of Markdown across five docs, no code
**Risk level:** low
**Testing required:** formatting check and greps only; no unit, DB or E2E impact
