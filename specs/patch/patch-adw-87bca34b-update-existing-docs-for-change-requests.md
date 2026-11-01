# Patch: Update the existing docs and the ADW profile for change requests and going back

## Metadata

adw_id: `87bca34b`
review_change_request: `Issue #1: Spec step 12 is only partly done. None of app_docs/, docs/ or .adw/project.md is touched on this branch. (a) app_docs/studio.md line 85 still describes jobs as kind process only, with one owner insert path, and has no pointer to the new doc. (b) app_docs/measurement.md line 92 still lists studio_change_requested as reserved, not sent yet, but ChangeRequestForm now sends it. (c) The Notes in app_docs/decide-step.md were not updated to say the owner-request path now exists. (d) The .adw/project.md Tests section has no clause for apps/studio/e2e/change-requests.spec.ts. Resolution: (1) studio.md: three kinds, two owner insert paths, point to app_docs/change-requests.md. (2) measurement.md: studio_change_requested sent with reel_id (plus app) only, never the request text; check studio_preview_opened. (3) decide-step.md Notes: a change job runs runDecide with job.request. (4) .adw/project.md Tests: one clause for change-requests.spec.ts next to preview.spec.ts, no heading changes. No em-dashes. Run yarn format. app_docs/change-requests.md and its index line stay with the document phase. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-34-adw-87bca34b-sdlc_planner-change-requests-versions-list.md`
**Issue:** Spec step 12 asked for edits to three existing feature docs and the ADW profile; none was made. `app_docs/studio.md` still says `jobs` has only kind `process` and one owner insert path; `app_docs/measurement.md` lists `studio_change_requested` (and `studio_preview_opened`) as "reserved, not sent yet", contradicting `apps/studio/src/lib/track.ts` and the code; `app_docs/decide-step.md` Notes still describe the owner-request path as future; `.adw/project.md` Tests does not describe `apps/studio/e2e/change-requests.spec.ts`.
**Solution:** Four small in-place text edits, then `yarn format`. Facts verified in the tree: `supabase/migrations/20261101184843_change_restore_jobs.sql` widens `jobs_kind_check` to `process | change | restore`, adds `request` and `restore_version_id` with their checks, grants `insert (request, restore_version_id)` and adds policy `jobs: owner inserts a change or restore job for own reel`; the existing policy is `jobs: owner inserts a process job for own reel` (`20261031174750_job_queue.sql:70`). `ChangeRequestForm.tsx:52` sends `studio_change_requested` with `{ reel_id }`; `ReelPreview.tsx:147` already sends `studio_preview_opened` with `{ reel_id }` (since c8fe702, before this branch). `app_docs/change-requests.md` and its `docs/conditional-docs.md` line are left to the document phase, as the review allows.

## Files to Modify

Use these files to implement the patch:

- `app_docs/studio.md`
- `app_docs/measurement.md`
- `app_docs/decide-step.md`
- `.adw/project.md`

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: `app_docs/studio.md`, Jobs, steps and the lease

- In the first bullet (line 85), change "tables `jobs` (kind `process`, status ..." so it reads that `jobs` starts with kind `process`; keep the rest of the sentence.
- Add one bullet right after it (before the `claim_job` bullet), about the slice-11 migration: "`supabase/migrations/20261101184843_change_restore_jobs.sql`: `jobs` now has three kinds, `process`, `change` (carries the owner's words in `request`, 1 to 1000 trimmed characters) and `restore` (names an earlier version of the same reel in `restore_version_id`). Owners insert jobs on two paths: the `process` policy (`jobs: owner inserts a process job for own reel`, used by `finish_upload`'s caller) and `jobs: owner inserts a change or restore job for own reel`, through a column-limited grant (`reel_id`, `kind`, `request`, `restore_version_id`); status, lease, attempt and error columns stay the worker's. See `app_docs/change-requests.md`."
- Keep the existing "Only the worker (secret key) writes job and step state." sentence true (it is about state columns); do not touch the Rules section.

### Step 2: `app_docs/measurement.md`, the events table (lines 89 to 92)

- Add two rows above the reserved row, matching the existing `studio_footage_uploaded` row's format:
  - `studio_preview_opened` | the live preview first plays a version (`ReelPreview.tsx`) | `reel_id`, `app`
  - `studio_change_requested` | the owner sends a change request (`ChangeRequestForm.tsx`) | `reel_id`, `app` (never the request text)
- Reduce the reserved row to `studio_export_requested`, `studio_export_downloaded` | reserved, not sent yet | `reel_id`, `app`.
- Before writing the `studio_preview_opened` "Sent when" cell, read `apps/studio/src/components/ReelPreview.tsx` around line 147 and describe the actual trigger in a few words.
- Let `yarn format` realign the table.

### Step 3: `app_docs/decide-step.md`, Notes (line 127)

- Replace "`request` is null for the automatic run; the owner-request path reuses `runDecide` with a request." with: "`request` is null for the automatic run. The owner-request path now exists: a `change` job runs `runDecide` with `job.request` (see `app_docs/change-requests.md`)."
- Before writing, grep `apps/worker/src` for `runDecide` to confirm the call passes `job.request`; word the sentence to match.

### Step 4: `.adw/project.md`, Tests section (lines 175 to 178)

- After the `preview.spec.ts` clause (which ends "...so no network)"), insert one clause before ", run last by": "`change-requests.spec.ts` seeds a processed reel the same way, a change makes version 3 live, a change the AI refuses twice keeps version 3 and the reel `processed`, and going back makes versions 4 and 5". Join it with a comma or semicolon so the sentence still reads; no heading changes, nothing reordered.

### Step 5: Format and check

- Run `yarn format`, then grep the four files for em-dashes (`grep -n "—" app_docs/studio.md app_docs/measurement.md app_docs/decide-step.md .adw/project.md` must print nothing).

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check`
- `grep -n "—" app_docs/studio.md app_docs/measurement.md app_docs/decide-step.md .adw/project.md` (no output)
- `grep -n "^## " .adw/project.md` (exactly the nine headings: Identity, Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review, in that order)
- `yarn lint && yarn typecheck && yarn knip && yarn test` (docs-only change; the commit and push hooks must still pass)

## Patch Scope

**Lines of code to change:** about 15 lines of Markdown across four files
**Risk level:** low
**Testing required:** formatting, em-dash and heading checks; the hook gate to confirm nothing else regressed. No code or spec changes.
