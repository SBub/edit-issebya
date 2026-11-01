# Change requests, versions list and going back

**Specifications:**

- specs/issue-34-adw-87bca34b-sdlc_planner-change-requests-versions-list.md

## Overview

The owner of a processed reel can type a change in plain words, see every version of the reel, and
go back to an earlier one. A change queues a `change` job whose worker run is the decide step alone,
with the owner's words as the request; going back queues a `restore` job that saves a new version
copying the old one. History is never rewritten: every outcome is a new version.

## How it works

- `supabase/migrations/20261101184843_change_restore_jobs.sql`: `jobs.kind` accepts `process`,
  `change` and `restore`. New columns `request` (a change carries 1 to 1000 trimmed characters, no
  other kind carries any) and `restore_version_id` (a restore names a version, no other kind does;
  `on delete cascade`). Owners insert through a column-limited grant (`request`,
  `restore_version_id` on top of `reel_id`, `kind`) and the policy `jobs: owner inserts a change or
restore job for own reel`: own reel, status `queued`, and for a restore a version of the same reel.
  Status, lease, attempt and error columns stay the worker's.
- `apps/studio/src/app/change-actions.ts`: server actions `requestChange` and `requestRestore`. Both
  use the owner's own client (RLS), re-read the reel and its jobs, and refuse with `blocked` when the
  interim ordering rule fails. `requestRestore` refuses the already current version. Errors are logged
  without the request text.
- `apps/studio/src/lib/change-requests.ts`: `normalizeRequest` (trim, 1 to 1000 characters),
  `changeBlockedReason` (the interim ordering rule: the reel must be `processed` and no job `queued`
  or `running`), `versionOrigin` and `jobRequestLabel` (the text shown beside a version or a job; a
  render job reads `export of vN`, or `export` when the version is unknown).
- `apps/studio/src/components/ChangeRequestForm.tsx`: the change box above the versions list. Disabled
  with the blocked reason beside it; after sending it shows `Pending: <request>` until the job ends.
- `apps/studio/src/components/VersionList.tsx`: every version, newest first, the current one marked,
  each with its origin (`restored from vN`, the owner's quoted words, or `automatic`), its change
  summary and a go back control.
- `apps/studio/src/components/LiveReel.tsx`: reads `versions` with the snapshot (`VERSION_LIST_COLUMNS`
  in `apps/studio/src/lib/versions.ts`, no edit metadata) and follows `INSERT` on `versions` over
  Realtime, filtered to the reel. The jobs list shows each job's request or `go back to vN`.
- `apps/worker/src/job-kinds.ts`: `runJobKind` dispatches a claimed job by kind. A change without a
  request, a restore without a version and an unknown kind fail the job.
- `apps/worker/src/process-job.ts`: `process` runs the pipeline, preview copies, first version and
  decide (request null); `change` runs `runDecide` with `job.request`; `restore` runs `runRestore`.
- `apps/worker/src/restore-step.ts`: the `restore` step. Calls `restoreVersion` from
  `@edit-issebya/edit`, which refuses a version of another reel before writing: a new version copies
  the old bytes, its parent is the current version, `restored_from_id` the old one, and it becomes
  current. The step summary reads `version N: restored from version M`.
- `apps/worker/src/queue.ts`: `ClaimedJob` carries `request` and `restore_version_id`. Only a
  `process` job moves the reel's status; a failed `change` or `restore` job fails the job and leaves
  the reel `processed` with its current version untouched.
- `apps/studio/src/lib/track.ts`: sends `studio_change_requested` (reel id and app, never the text).

## How to Use

1. Open a processed reel in the studio.
2. Type the change in the box and send it. The box shows `Pending: ...` while the job runs, then a
   new version becomes current and the live preview follows.
3. To go back, pick an earlier version in the Versions list. A new version, restored from the old
   one, becomes current; going back can itself be undone the same way.
4. While a job is queued or running, or while the reel is not `processed`, both controls are disabled
   with the reason beside them.

## Configuration

None. The decide step needs the AI runner as for the first run (`E2E_MOCK_AI_SCRIPT` replaces it in
specs, see `app_docs/decide-step.md`).

## Testing

- `apps/studio/src/lib/change-requests.test.ts`, `apps/worker/src/job-kinds.test.ts`,
  `apps/worker/src/queue.test.ts`, `apps/worker/src/restore-step.test.ts` (unit).
- `apps/studio/db-tests/change-jobs.test.ts`: the kind checks, the column grant and the insert policy.
- `apps/studio/e2e/change-requests.spec.ts`: a change makes version 3, a change the AI refuses twice
  (`brokenAnswerScript` in `apps/studio/test-support/ai-script.ts`) keeps version 3 and the reel
  `processed`, and going back makes versions 4 and 5.

## Notes

- The one-job-at-a-time rule is interim and checked in the page and the server action only; jobs are
  not yet ordered in the database. It counts every job, so a queued or running render also holds a
  change or going back, while the Export button follows only its own rule (`app_docs/export.md`).
- A change that decides on no edit still saves nothing new; see `app_docs/decide-step.md`.
- Touches `app_docs/studio.md` (jobs kinds, policies), `app_docs/decide-step.md` (the request path),
  `app_docs/measurement.md` (the `studio_change_requested` event) and `app_docs/edit-model.md`
  (`restored_from_id`, `restoreVersion`).
