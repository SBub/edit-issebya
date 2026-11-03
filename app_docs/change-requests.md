# Change requests, versions list and going back

**Specifications:**

- specs/issue-34-adw-87bca34b-sdlc_planner-change-requests-versions-list.md
- Owner request, 2026-11-03: one-line version rows with details behind an arrow, plain titles.

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
  use the owner's own client (RLS), re-read the reel, and refuse with `blocked` only when
  `changeBlockedReason` says so: the reel is `refused`, still `uploading`, or `failed` with no
  current version. `requestRestore` refuses the already current version. Errors are logged
  without the request text.
- `apps/studio/src/lib/change-requests.ts`: `normalizeRequest` (trim, 1 to 1000 characters),
  `changeBlockedReason` (null when open; otherwise `This clip was refused; upload another clip`,
  `Changes open once the upload finishes` or `Processing failed; press Try again on the preview
first`, Try again being the progress overlay's, `app_docs/status.md`), `versionOrigin`,
  `versionTitle` and `jobRequestLabel` (the text shown beside a version or a job; a render job reads
  `export of vN`, or `export` when the version is unknown). `versionOrigin`: `Back to vN` for a
  going back, the owner's own words for a change, `First version` (no parent), else `Styled
automatically` (the decide run after the first version). `versionTitle`: `Back to vN` and `First
version` as above; otherwise the version's `change_title`, falling back (versions saved before
  titles) to the owner's request, else `Styled automatically`.
- `apps/studio/src/components/ChangeRequestForm.tsx`: the change box (on desktop the bottom 32% of the right
  side, under Versions and the library; pinned at the bottom on a phone; placement in
  `app_docs/studio-reel-layout.md`). Built like a chat composer: one box with the studio's one corner radius
  (`rounded-reel`, `data-testid="change-field"`, `border-line`, `bg-chrome`, `bg-chrome/50` while disabled, an accent ring
  while focused) holds the textarea and, in its bottom right corner, Send: a small square white
  button (`bg-primary`, `rounded-reel` too) with a black up arrow icon (`text-on-primary`, inline SVG, `aria-hidden`) and no text, named by `aria-label="Send"`
  and `title`, at half opacity while disabled. The textarea's right padding keeps text from running
  under the button. No visible label: the textarea is named by `aria-label="Ask for a change"`, and
  its placeholder says what to do ("What should change? For example: slower transitions, no photos
  in this one, bigger captions"). Enter adds a new line; the button sends. Disabled with the blocked reason beside it, otherwise the queue note (`changeQueueNote` in
  `apps/studio/src/lib/failures.ts`) when jobs are ahead; after sending it shows `Pending: <request>` until the job ends. These lines sit under the box: the
  blocked reason or queue note (`change-blocked-reason`), then the status line (`change-status`,
  `aria-live`, the pending line or a send error). Each hides while empty (`empty:hidden`), so with
  no text the box keeps the area's even inset on all four sides; one shows only when it has text.
  Its `refill(text)` handle puts a request back in the field and focuses it (the overlay's Change
  the request).
- A change refused twice (the job `failed` with `failure_kind` `answer_refused`) shows in the
  progress overlay as `Could not finish styling`, a plain reason from the rule names
  (`refusalReason` in `apps/studio/src/lib/step-words.ts`), Change the request (refills the field
  with the sent request and focuses it) and Keep the current version; never Try again and never the
  raw error tail.
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
  while closed; several rows may be open): for a change `What you asked` with the owner's words
  (`version-origin`) and `What changed` with the summary (`version-summary`); for a going back
  `Back to vN`; for the first version `First version` and its summary; then `Go back to this`,
  never on the current version. The list scrolls inside the Versions area (desktop and the phone's
  Versions tab).
- The rows run edge to edge of the Versions area (no box around the list, the area itself has no
  padding), separated by thin `divide-line` dividers, each with the area's `px-3` side padding; the
  heading and the status line carry the same `px-3`, so they line up with the row text.
- No time or date shows in the list, in a row or its details: what changed matters, not when.
- Texts: Claude writes `change_title` and `change_summary` in plain words for the owner
  (`app_docs/decide-step.md`); a going back saves the summary `Back to how vN looked`. Old
  technical summaries stay as stored and show only inside the details.
- `apps/studio/src/components/LiveReel.tsx`: reads `versions` with the snapshot (`VERSION_LIST_COLUMNS`
  in `apps/studio/src/lib/versions.ts`, no edit metadata) and follows `INSERT` on `versions` over
  Realtime, filtered to the reel. The reel page shows no jobs list; what a job is doing shows in the
  progress overlay.
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
3. To go back, open an earlier version's details with its arrow in the Versions list and press Go
   back to this. A new version, restored from the old one, becomes current; going back can itself
   be undone the same way.
4. The change box stays open while the reel is processing and shows
   `Your change will run after processing finishes` (or `Your change will run after the jobs before
it finish` while other jobs are ahead). Both controls are disabled, with the reason beside them,
   only while the reel is `refused`, still `uploading`, or `failed` with no current version. The
   order the jobs run in is `claim_job`'s, see `app_docs/failures.md`.

## Configuration

None. The decide step needs the AI runner as for the first run (`E2E_MOCK_AI_SCRIPT` replaces it in
specs, see `app_docs/decide-step.md`).

## Testing

- `apps/studio/src/lib/change-requests.test.ts`, `apps/worker/src/job-kinds.test.ts`,
  `apps/worker/src/queue.test.ts`, `apps/worker/src/restore-step.test.ts` (unit).
- `apps/studio/db-tests/change-jobs.test.ts`: the kind checks, the column grant and the insert policy.
- `apps/studio/e2e/change-requests.spec.ts`: a change makes version 3, a change the AI refuses twice
  (`brokenAnswerScript` in `apps/studio/test-support/ai-script.ts`) keeps version 3 and the reel
  `processed`, with the overlay's `Could not finish styling`, its reason, Change the request (the
  field refilled and focused, `studio_failure_action` sent) and Keep the current version, no Try
  again, and going back makes versions 4 and 5. It checks version 3's stored and shown title,
  the intro line under the Versions heading (visible, exact text, `aria-describedby`),
  details hidden until the arrow opens them (`aria-expanded`), What you asked, What changed, and
  the `Back to vN` titles of the restores.
- `apps/studio/e2e/reel-layout.spec.ts`: at 1440x900 and 390x844, every row the same height
  (within 1 px) with a long title, a long request without a title and a short title, no `time`
  element, every row as wide as the Versions area (within 1 px) with no box around the list, the
  short title shown in full and the long ones cut at two lines, the details opened with Enter and closed with Space, several open at once.

## Notes

- Jobs are ordered per reel in the database: `claim_job` runs one job per reel at a time, oldest
  first (`app_docs/failures.md`). The Export button follows its own rule (`app_docs/export.md`).
- A change that decides on no edit still saves nothing new; see `app_docs/decide-step.md`.
- Touches `app_docs/studio.md` (jobs kinds, policies), `app_docs/decide-step.md` (the request path),
  `app_docs/measurement.md` (the `studio_change_requested` event) and `app_docs/edit-model.md`
  (`restored_from_id`, `restoreVersion`).
