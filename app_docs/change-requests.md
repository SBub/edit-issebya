# Versions list, going back and Start over

**Specifications:**

- specs/issue-34-adw-87bca34b-sdlc_planner-change-requests-versions-list.md
- Owner request, 2026-11-03: one-line version rows with details behind an arrow, plain titles.
- Owner request, 2026-11-04: a temporary Start over button for testing the first edit.
- Owner decision, 2026-11-07: the change box is removed until the product works end to end.
- specs/issue-156-adw-ca502a36-sdlc_planner-honest-version-summary-from-diff.md

## Overview

The owner of a processed reel sees every version of the reel, goes back to an earlier one, and can
Start over (rerun the first edit from version 1). Going back queues a `restore` job that saves a new
version copying the old one; Start over queues a `start_over` job. History is never rewritten: every
outcome is a new version.

The change box (typing a change in plain words, which queued a `change` job) is removed for now. The
product has no request input until it works end to end, so the decide step runs only on its own: the
first automatic decide after version 1, and Start over.

## The change box (removed 2026-11-07)

- No UI sends a `change` job: `ChangeRequestForm.tsx` and `requestChange` are gone, and the reel page
  has no request field. The versions list and Start over are the owner's only controls.
- The worker fails a `change` job that is somehow claimed, with the message `change jobs are no
longer run: the change box is removed` (`apps/worker/src/job-kinds.ts`). It never crashes the worker.
- The database still accepts `change` jobs and their `request` text (`supabase/migrations/20261101184843_change_restore_jobs.sql`),
  so old rows stay valid. No migration was made for the removal.
- Versions made from an old change keep their owner's words in the list: `versionOrigin` and
  `versionTitle` read them as before (`What you asked` in the details).
- The decide answer's request path (the prompt's request, the checklist, the hook kept unless asked) stays in the worker's decide code, unused by the live paths. The
  `studio_change_requested` event is no longer sent (`app_docs/measurement.md`).
- To bring the box back, see the owner's later decision; its files were `ChangeRequestForm.tsx`, the
  `change` case in `change-actions.ts` and `job-kinds.ts`, and the overlay's Change the request action.

## How it works

- `supabase/migrations/20261101184843_change_restore_jobs.sql`: `jobs.kind` accepts `process`,
  `change` and `restore`. Columns `request` and `restore_version_id` (a restore names a version, no
  other kind does; `on delete cascade`). Owners insert through a column-limited grant (`request`,
  `restore_version_id` on top of `reel_id`, `kind`) and the policy `jobs: owner inserts a change or
restore job for own reel`: own reel, status `queued`, and for a restore a version of the same reel.
  Status, lease, attempt and error columns stay the worker's.
- `apps/studio/src/app/change-actions.ts`: server actions `requestRestore` and `requestStartOver`. Both
  use the owner's own client (RLS), re-read the reel, and refuse with `blocked` only when
  `changeBlockedReason` says so: the reel is `refused`, still `uploading`, or `failed` with no
  current version. `requestRestore` refuses the already current version. Errors are logged without
  the job's content.
- `apps/studio/src/lib/change-requests.ts`: `changeBlockedReason` (null when open; otherwise `This clip was refused; upload another clip`,
  `Changes open once the upload finishes` or `Processing failed; press Try again on the preview
first`, Try again being the progress overlay's, `app_docs/status.md`), `versionOrigin`,
  `versionTitle` and `jobRequestLabel` (the text shown beside a version or a job; a render job reads
  `export of vN`, or `export` when the version is unknown). `versionOrigin`: `Back to vN` for a
  going back, the owner's own words for an old change, `First version` (no parent), else `Styled
automatically` (the decide run after the first version). `versionTitle`: `Back to vN` and `First
version` as above; otherwise the version's `change_title`, falling back (versions saved before
  titles) to the owner's request, else the origin label. A version saved now has no title (null), so
  it reads its origin label: `Styled automatically` for the automatic run and Start over.
- `apps/studio/src/components/VersionList.tsx`: under the `Versions` heading, one muted intro line
  (`data-testid="versions-intro"`, `text-xs text-muted`, the heading's `px-3`), exactly
  `Your reel's history. Open a version to see what changed and bring it back` (no full stop),
  linked from the section with `aria-describedby`. It shows whether or not versions exist; an
  empty list keeps `No version yet` below it. Then every version, newest first, one row each at one
  fixed height (`h-14`, sized for two title lines, whatever the text): `v{n}`, the `current` (or
  `showing`) mark, the title (`versionTitle`, `data-testid="version-title"`, wrapping to at most two
  lines, `line-clamp-2`; a long request standing in for an old version's title is cut there, and
  shows in full in the details) and at the right
  an arrow button (`version-toggle`: a chevron that turns up when open, `aria-expanded`,
  `aria-controls` naming the details, accessible name `Show details of vN`, Enter or Space toggles,
  the accent focus ring). The arrow opens the row's details in place (`version-details`, `hidden`
  while closed; several rows may be open): for an old change `What you asked` with the owner's words
  (`version-origin`) and, only when the version has a stored summary, `What changed` with it
  (`version-summary`); for a going back `Back to vN`; for the first version `First version`; then
  `Go back to this`,
  never on the current version. The list scrolls inside the Versions area (desktop and the phone's
  Versions tab). The `Start over` button sits at the right of the heading (`StartOverButton.tsx`).
- The rows run edge to edge of the Versions area (no box around the list, the area itself has no
  padding), separated by thin `divide-line` dividers, each with the area's `px-3` side padding; the
  heading and the status line carry the same `px-3`, so they line up with the row text.
- No time or date shows in the list, in a row or its details: what changed matters, not when.
- Texts: a new version saves `change_title` and `change_summary` as null (owner decision 2026-11-08;
  the summary call is removed, `app_docs/decide-step.md`). Versions saved before keep their stored
  title and summary, which show as before; a going back saves the summary `Back to how vN looked`.
- `apps/studio/src/components/LiveReel.tsx`: reads `versions` with the snapshot (`VERSION_LIST_COLUMNS`
  in `apps/studio/src/lib/versions.ts`, no edit metadata) and follows `INSERT` on `versions` over
  Realtime, filtered to the reel. The reel page shows no jobs list; what a job is doing shows in the
  progress overlay.
- `apps/worker/src/job-kinds.ts`: `runJobKind` dispatches a claimed job by kind. A `change` job fails
  (see above), a restore without a version, a render without a version and an unknown kind fail the job.
- `apps/worker/src/process-job.ts`: `process` runs the pipeline, preview copies, first version and
  the automatic decide (request null); `restore` runs `runRestore`; `start_over` runs `runDecide` from
  version 1 (see Start over below).
- `apps/worker/src/restore-step.ts`: the `restore` step. Calls `restoreVersion` from
  `@edit-issebya/edit`, which refuses a version of another reel before writing: a new version copies
  the old bytes, its parent is the current version, `restored_from_id` the old one, and it becomes
  current. The step summary reads `version N: restored from version M`.
- `apps/worker/src/queue.ts`: `ClaimedJob` carries `restore_version_id`. Only a `process` job moves
  the reel's status; a failed `restore` or `start_over` job fails the job and leaves the reel
  `processed` with its current version untouched.
- `apps/studio/src/lib/track.ts`: `studio_change_requested` is no longer sent (see the change box above).

### Start over (temporary testing control, to be removed)

A control for the owner's testing of the first edit; it will be removed. It reruns the reel's first
edit from the decide step on the existing reel, with no upload and no request, and saves the result
as a new version beside the old ones, so first runs can be compared.

- `supabase/migrations/20261104153506_start_over_jobs.sql`: one more job kind, `start_over`, with no
  request, no version and no photo (the existing checks refuse any), and the policy `jobs: owner
inserts a start over job for own reel` (own reel, status `queued`) through the existing
  (`reel_id`, `kind`) grant. The restrictive retry policy applies, so Try again works as for a
  restore.
- `apps/studio/src/app/change-actions.ts`: `requestStartOver` refuses like going back
  (`changeBlockedReason`) and, with no current version yet, says `Start over opens once the first
version is ready`.
- `apps/studio/src/components/StartOverButton.tsx`: `Start over` (`data-testid="start-over"`), a
  square secondary button like Go back to this (`border-line`, `text-xs`), beside the `Versions`
  heading (VersionList's `action` slot, passed by `LiveReel.tsx`). Disabled while the reel is
  blocked, has no version, any job of the reel is queued, running or waiting for the AI, and until its
  own job ends; its title says why (`startOverQueueNote` in `apps/studio/src/lib/failures.ts`:
  `Waiting: your reel is still being styled. Start over starts right after`). A failure to queue
  shows beside it. Progress shows in the overlay (`JOB_STEPS.start_over` is `decide`); a failure gets
  Try again and Keep the current version.
- `apps/worker/src/job-kinds.ts` dispatches `start_over`; `apps/worker/src/process-job.ts` reads the
  reel's version 1 (`firstVersionId` in `apps/worker/src/start-over.ts`; a reel without one fails
  the job) and runs `runDecide` with `request` null and `startFrom` that version. Every earlier step
  (convert, transcribe, retime, head_track, preview_copies, cut-outs) is reused
  from the cache; decide is never cached. Claude starts from version 1's choices (captions only),
  never the current version's; the reel's behind rules hold as on any run. The new version's
  parent is the current version and it becomes current; it saves no title and no summary (both
  null). In the list it reads like the automatic run (`Styled automatically`). The step summary ends
  with `started over from version 1`.
- To remove: the button file and its `action` use in `LiveReel.tsx` (and the slot if unused), the
  action, `start_over` in `JOB_KINDS`, `JOB_STEPS` and `jobRequestLabel`, the worker's runner,
  `start-over.ts` and `startFrom` in `run-decide.ts`, their tests, `apps/studio/e2e/start-over.spec.ts`,
  and a new migration dropping the policy and the kind.

## How to Use

1. Open a processed reel in the studio.
2. To go back, open an earlier version's details with its arrow in the Versions list and press Go
   back to this. A new version, restored from the old one, becomes current; going back can itself
   be undone the same way.
3. To try the first edit again, press Start over beside the Versions heading. Its job shows in the
   progress overlay, and the new version becomes current when it is saved.
4. Going back and Start over stay open while the reel is processing and show
   `Waiting: your reel is still being styled. Start over starts right after` (the same line while
   other jobs are ahead). Both are disabled, with the reason as the title or beside them, only while the
   reel is `refused`, still `uploading`, or `failed` with no current version. The order the jobs run
   in is `claim_job`'s, see `app_docs/failures.md`.

## Configuration

None. The decide step needs the AI runner as for the first run (`E2E_MOCK_AI_SCRIPT` replaces it in
specs, see `app_docs/decide-step.md`).

## Testing

- `apps/studio/src/lib/change-requests.test.ts`, `apps/studio/src/lib/failures.test.ts`,
  `apps/worker/src/job-kinds.test.ts` (a `change` job fails with the clear message and runs nothing),
  `apps/worker/src/queue.test.ts`, `apps/worker/src/restore-step.test.ts` (unit).
- `apps/studio/db-tests/change-jobs.test.ts`: the kind checks, the column grant and the insert policy
  (the database is unchanged, so these still hold).
- `apps/studio/e2e/change-requests.spec.ts`: Start over makes version 3, then going back makes
  versions 4 and 5 (each a new version copying the old one, with the `Back to vN` titles and details),
  the bytes and rows of older versions kept, the reel page never reloaded; another owner cannot queue
  a going back, and a going back needs a version.
- Start over: `apps/worker/src/job-kinds.test.ts`, `apps/worker/src/queue.test.ts` (never moves the
  reel's status), `apps/worker/src/decide/run-decide.test.ts` (`runDecide starting over`: decides
  from version 1, parent the current version, a version of another reel refused),
  `apps/studio/db-tests/change-jobs.test.ts` (the policy, no request or version, another owner
  refused) and `apps/studio/e2e/start-over.spec.ts` (beside the heading, off while a job runs,
  version 3 with version 1's bytes from an answer with no choices, older versions kept).
- `apps/studio/e2e/reel-layout.spec.ts`: at 1440x900 and 390x844, every row the same height
  (within 1 px) with a long title, a long request without a title and a short title, no `time`
  element, every row as wide as the Versions area (within 1 px) with no box around the list, the
  short title shown in full and the long ones cut at two lines, the details opened with Enter and closed with Space, several open at once.

## Rules

- A new version has no title or summary text: `change_title` and `change_summary` are saved null.
- A going back saves a new version copying the old one's bytes, never rewriting history.
- The worker never runs a `change` job: it fails with the clear message (the change box is removed).
- A Start over decides from version 1's choices, never the current version's.

## Notes

- Jobs are ordered per reel in the database: `claim_job` runs one job per reel at a time, oldest
  first (`app_docs/failures.md`). The Export button follows its own rule (`app_docs/export.md`).
- The decide step's request path (the photo and hook rules that a request lifts) is dormant: no live path passes a request. It stays in the decide code for the later decide
  task (`app_docs/decide-step.md`).
- Touches `app_docs/studio.md` (jobs kinds, policies), `app_docs/decide-step.md` (the Start over path),
  `app_docs/measurement.md` (the `studio_change_requested` event, no longer sent) and
  `app_docs/edit-model.md` (`restored_from_id`, `restoreVersion`).
