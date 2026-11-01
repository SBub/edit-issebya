# Feature: Change requests: text box under the preview, change and restore jobs, versions list

## Metadata

issue_number: `34`
adw_id: `87bca34b`
issue_json: `{"number":34,"title":"feat: change requests: text box under the preview, change and restore jobs, versions list"}`

## Feature Description

Reel studio MVP, slice 11 of 17. The owner types a change in plain words in a text box under the
live preview ("move the title lower", "no accent on 'work'"), and about a minute later the preview
shows the new version without a reload. The reel page also lists every version (time, the request
that produced it or "automatic" / "restored from v3", the change summary) with a "Go back to this"
control on every non-current version. Going back creates a new version that copies the old one, so
going back can itself be undone.

Under the hood, two new job kinds join `process`:

- `change`: carries the owner's words (`jobs.request`). The worker runs only the existing `decide`
  step (`runDecide`) with the request and the current version as input. On success the new version
  becomes current (through `save_version`); on a second refusal the job fails with the reasons and
  the current version stays.
- `restore`: carries `jobs.restore_version_id`. The worker runs a `restore` step that calls
  `restoreVersion` from `packages/edit`, which saves a new version copying the old one's bytes and
  makes it current.

The new current version reaches the page through Realtime on the `reels` row (already in the
publication); the preview already rebuilds when `current_version_id` changes. No polling.

## User Story

As the reel owner
I want to ask for a change in plain words under the preview, see the new version a minute later, and go back to any earlier version
So that I can iterate on a reel without the old render-per-round loop and never lose a version

## Problem Statement

After #32 and #33 the studio plays the current version and the worker can make a version with the
decide step, but only once, automatically, after upload. The owner has no way to ask for a change,
no way to see which versions exist or what produced them, and no way to go back. `restoreVersion`
exists in `packages/edit` but nothing calls it. `jobs.kind` allows only `process`, and the only job
an owner can insert is a `process` job.

## Solution Statement

1. A migration widens `jobs_kind_check` to `process | change | restore`, adds `jobs.request text`
   and `jobs.restore_version_id uuid` (FK to `versions`, cascade with the reel), with table checks
   that make `request` required (trimmed, 1 to 1000 characters) exactly for `change` and
   `restore_version_id` required exactly for `restore`. The insert grant gains `request` and
   `restore_version_id` only (never `status`, `lease_*`, `attempts`, `error_tail`, `owner_id`); a
   new insert policy lets the owner insert a `change` or `restore` job for their own reel only, and
   for `restore` only a version of that same reel. `reels` and `versions` stay in the Realtime
   publication (nothing to add; asserted by a DB test).
2. The studio adds server actions `requestChange` and `requestRestore` (user's own client, under
   RLS, validated by a pure helper in `src/lib/change-requests.ts`), a `ChangeRequestForm` under the
   preview, and a `VersionList`. `LiveReel` follows `versions` inserts through the same channel and
   derives whether the box is open (interim rule: reel `processed` and no job `queued` or
   `running`). Sending sends `studio_change_requested` with `reel_id` only.
3. The worker dispatches on `job.kind` in `processJob`: `process` as today, `change` runs only
   `runDecide({ request })`, `restore` runs a new `restore` step (`apps/worker/src/restore-step.ts`)
   around `restoreVersion`. A `change` or `restore` job never writes the reel's `status` (finish or
   fail), so a failed change leaves the reel `processed` and its current version untouched.
4. A new E2E spec `apps/studio/e2e/change-requests.spec.ts` proves the seven verification points;
   DB tests prove the RLS and checks; unit tests prove the validation, the labels, the kind
   dispatch and the restore step.

## Relevant Files

Use these files to implement the feature:

- `README.md`, `AGENTS.md`, `.adw/project.md`: rules, commands, Protected section (migrations only
  through `supabase migration new`; after adding one in a run, `.adw/supabase-stack reset`).
- `docs/conditional-docs.md`: index; gets one new line for `app_docs/change-requests.md`.
- `app_docs/studio.md`: jobs table, RLS rules (owner insert grants), Realtime live status, worker.
  Its Rules bind this change (no polling, no `*` selects, owners never write status).
- `app_docs/decide-step.md`: `runDecide`, its `request` parameter, failure tail, the AI double and
  `E2E_MOCK_AI_SCRIPT`; its Notes already say the owner-request path reuses `runDecide`.
- `app_docs/edit-model.md`: `restoreVersion`, `save_version` (refuses a stale parent), version
  immutability. Rule: history is never rewritten.
- `app_docs/preview.md`: `ReelPreview` reloads on `current_version_id` change; `data-preview-version`.
- `app_docs/measurement.md`: the `studio_*` events, `capture`, the test hook.
- `supabase/migrations/20261031174750_job_queue.sql`: `jobs` table, `jobs_kind_check` (named so it
  can be dropped and re-added), insert grant `(reel_id, kind)`, the `process` insert policy,
  `claim_job` (returns `setof public.jobs`, so new columns come with the claimed row).
- `supabase/migrations/20261101153653_versions.sql`, `20261101175625_version_decide_records.sql`:
  `versions`, its owner select policy and publication membership.
- `apps/worker/src/process-job.ts`: wires a claimed job; becomes a dispatch on `job.kind`.
- `apps/worker/src/queue.ts`: `ClaimedJob` (gains `request`, `restore_version_id`), `endJob`,
  `finishJob`, `failJob` (today always set the reel to `processed` / `failed`).
- `apps/worker/src/decide/run-decide.ts`: `runDecide` with `request`; unchanged in behaviour.
- `apps/worker/src/decide/prompt.md`, `prompt.ts`: already take the request (`{{request}}`). No
  prompt change is planned; if the implementer edits `prompt.md`, bump `PROMPT_VERSION`.
- `apps/worker/src/first-version.ts`, `apps/worker/src/step-runner.ts`: the `runToolsStep` pattern
  for a step without tool calls (model for the `restore` step).
- `apps/worker/src/version-store.ts`: `supabaseVersionRows`, `storageVersionBlobs`.
- `apps/worker/src/run-job.test.ts`, `apps/worker/src/decide/run-decide.test.ts`,
  `apps/worker/src/first-version.test.ts`: unit test patterns with in-memory rows and blobs.
- `packages/edit/src/versions.ts`: `restoreVersion`, `saveVersion`.
- `apps/studio/src/app/reels/[id]/page.tsx`: server read of reel, jobs, steps; gains versions.
- `apps/studio/src/components/LiveReel.tsx`: Realtime channel; renders preview, jobs, steps; gains
  the form and the versions list.
- `apps/studio/src/components/ReelPreview.tsx`: unchanged; already rebuilds on version change.
- `apps/studio/src/components/UploadForm.tsx`, `apps/studio/src/app/upload-actions.ts`: form and
  server action patterns (status results, `capture` after success, user's own client).
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS` (gains `request`, `restore_version_id`), statuses,
  `upsertById`, `pickColumns`.
- `apps/studio/src/lib/versions.ts`: `VERSION_COLUMNS`, `VersionRow`.
- `apps/studio/src/lib/track.ts`: `capture`, `STUDIO_EVENTS` (already reserves
  `studio_change_requested`); its comment about what is sent today is updated.
- `apps/studio/src/lib/supabase-server.ts`: per-request server client for the actions.
- `apps/studio/test-support/pipeline-cache.ts` (`seedProcessedReel`), `test-support/ai-script.ts`
  (`SHORT_SPEECH_ANSWER`, `unchangedAnswerScript`), `test-support/worker.ts` (`runWorkerOnce`,
  `claimableJobIds`), `test-support/fixtures.ts` (`createTestUser`, `signInLink`,
  `signedInClient`), `test-support/local-supabase.ts`.
- `apps/studio/e2e/preview.spec.ts`: model for the new spec (CDN routing, `openReel`, no-reload
  marker, `data-preview-version`), `apps/studio/e2e/events.ts` (`recordEvents`, `eventsNamed`).
- `apps/studio/db-tests/rls.test.ts`, `apps/studio/db-tests/jobs.test.ts`,
  `apps/studio/db-tests/realtime.test.ts`: DB test patterns.
- `node_modules/next/dist/docs/`: read the Server Actions / forms guide before writing the actions.

### New Files

- `supabase/migrations/<stamp>_change_restore_jobs.sql`: made by
  `supabase migration new change_restore_jobs` (never a hand-picked version).
- `apps/worker/src/restore-step.ts` and `apps/worker/src/restore-step.test.ts`: the `restore` step.
- `apps/worker/src/process-job.test.ts` (or a pure `jobPlan(kind)` in `apps/worker/src/job-kinds.ts`
  with `job-kinds.test.ts`): the dispatch per kind.
- `apps/studio/src/lib/change-requests.ts` and `change-requests.test.ts`: `MAX_REQUEST_LENGTH`,
  `normalizeRequest`, `changeBlockedReason(reel, jobs)`, `versionOrigin(version, byId)`.
- `apps/studio/src/app/change-actions.ts`: server actions `requestChange` and `requestRestore`.
- `apps/studio/src/components/ChangeRequestForm.tsx`: the text box and submit button.
- `apps/studio/src/components/VersionList.tsx`: the versions list with "Go back to this".
- `apps/studio/db-tests/change-jobs.test.ts`: RLS and checks for `change` and `restore` jobs.
- `apps/studio/e2e/change-requests.spec.ts`: the browser proof.
- `apps/studio/test-support/ai-script.ts` gains `brokenAnswerScript(dir)` (an envelope whose
  `result` is not JSON, so the double refuses twice).
- `app_docs/change-requests.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

The migration (kinds, columns, checks, grant, policy), applied to the ADW stack with
`.adw/supabase-stack reset`, and its DB tests. Then the worker's `ClaimedJob` and `endJob` change so
a non-`process` job never touches the reel's status.

### Phase 2: Core Implementation

Worker: the `restore` step and the kind dispatch in `processJob` (`change` runs only `runDecide`
with the request; `restore` runs the restore step). Studio: the pure helper, the two server
actions, the form, the versions list, and `LiveReel` following `versions` inserts.

### Phase 3: Integration

The reel page reads versions once on the server and hands them to `LiveReel`; the form sits right
under `ReelPreview`; the preview follows `current_version_id` as it already does. The event, the
E2E spec, the feature doc and the index line, and the small updates to `studio.md`,
`decide-step.md`, `measurement.md`, `track.ts`'s comment and the profile's Tests section.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Read before coding

- Read `app_docs/studio.md`, `app_docs/decide-step.md`, `app_docs/edit-model.md`,
  `app_docs/preview.md`, `app_docs/measurement.md` in full, and the Next 16 Server Actions guide
  under `node_modules/next/dist/docs/`.

### 2. Migration: job kinds `change` and `restore`

- Run `supabase migration new change_restore_jobs` (the only allowed way to create it).
- In it, with a header comment explaining the slice:
  - `alter table public.jobs drop constraint jobs_kind_check, add constraint jobs_kind_check check
(kind in ('process', 'change', 'restore'))`.
  - `add column request text`, `add column restore_version_id uuid references public.versions (id)
on delete cascade`.
  - `constraint jobs_request_check check ((kind = 'change') = (request is not null) and (request
is null or (request = btrim(request) and char_length(request) between 1 and 1000)))`.
  - `constraint jobs_restore_version_check check ((kind = 'restore') = (restore_version_id is not
null))`.
  - `grant insert (request, restore_version_id) on public.jobs to authenticated` (the existing
    `(reel_id, kind)` grant stays; no grant on `status`, `lease_holder`, `lease_expires_at`,
    `attempts`, `error_tail`, `started_at`, `finished_at`; `owner_id` comes from its default
    `auth.uid()`).
  - Policy `jobs: owner inserts a change or restore job for own reel` (`for insert to
authenticated with check`): `auth.uid() = owner_id`, `status = 'queued'`, `kind in ('change',
'restore')`, the reel is the caller's, and for `restore` `exists (select 1 from
public.versions v where v.id = restore_version_id and v.reel_id = jobs.reel_id)`. Leave the
    existing `process` policy as it is.
  - No publication change: `reels`, `jobs`, `steps` and `versions` are already in
    `supabase_realtime`.
- Run `.adw/supabase-stack reset` to apply it to the ADW stack. If it fails, report its error and
  stop. (The issue says `supabase migration up --local`; the profile's Protected section forbids
  that by hand in a run and prescribes this reset instead.)

### 3. DB tests for the new jobs

- Create `apps/studio/db-tests/change-jobs.test.ts` modelled on `rls.test.ts` (users A and B,
  `signedInClient`, `insertReel`, a version saved through `save_version` as the service role):
  - A inserts a `change` job with `request` for their reel: accepted, `status` `queued`,
    `owner_id` A.
  - B inserts a `change` job for A's reel: refused.
  - A inserts a `change` job without `request`, with `"   "`, with `" padded "` and with 1001
    characters: refused by the check (also as the service role for the missing request).
  - A inserts a `restore` job without `restore_version_id`: refused; with a version of another reel
    of theirs or of B's: refused; with a version of the same reel: accepted.
  - A `process` job with a `request`: refused by the check.
  - A cannot insert `status: 'running'`, `lease_holder` or `attempts` on a `change` job (permission
    denied) and cannot update a job's status.
  - `pg_publication_tables` for `supabase_realtime` still lists `reels`, `jobs`, `versions`.
- Clean up the queued jobs it inserts (delete as admin) before deleting the users, so no claimable
  job is left on the stack for the E2E specs.

### 4. Worker: jobs that never touch the reel status

- `apps/worker/src/queue.ts`: `ClaimedJob` gains `request: string | null` and
  `restore_version_id: string | null`. `endJob` takes `reel: "processed" | "failed" | null`; with
  `null` it updates only the job. `finishJob`/`failJob` pass the reel status only for `kind ===
'process'`; `change` and `restore` pass `null`.
- Extend `apps/worker/src/run-job.test.ts` or add a `queue` unit test with a stub client proving a
  failed `change` job updates no `reels` row.

### 5. Worker: the restore step

- `apps/worker/src/restore-step.ts`: `runRestore({ ctx, rows, blobs, keyPrefix, versionId, newId?
})`, a `runToolsStep` named `restore` (no tool call, like `first_version`) that calls
  `restoreVersion` and returns `what: "version <n>: restored from version <m>"`. A version of
  another reel throws (already `restoreVersion`'s behaviour) and fails the job; nothing is written.
- `apps/worker/src/restore-step.test.ts` with in-memory rows and blobs (pattern of
  `first-version.test.ts`): the new version copies the old bytes, `parent_id` is the current
  version, `restored_from_id` the old one, the old blob and row are unchanged, the step line names
  both numbers; another reel's version is refused.

### 6. Worker: dispatch on job kind

- `apps/worker/src/process-job.ts`: inside `work(signal)` switch on `job.kind`:
  - `process`: unchanged (pipeline, preview copies, first version, decide).
  - `change`: only `runDecide({ ..., request: job.request })`. No pipeline step runs, so every
    fixed step is absent from the job's step rows. A missing `request` throws.
  - `restore`: only `runRestore({ versionId: job.restore_version_id })`. A missing id throws.
  - Any other kind throws `unknown job kind`.
- Keep the dispatch testable: a small pure `jobSteps(kind)` (or an injected runner map) in
  `apps/worker/src/job-kinds.ts` with `job-kinds.test.ts` proving `change` runs only `decide` with
  the request, `restore` only `restore`, and an unknown kind throws.
- Update the header comment of `process-job.ts`.

### 7. Studio: pure helper

- `apps/studio/src/lib/change-requests.ts`:
  - `MAX_REQUEST_LENGTH = 1000`; `normalizeRequest(text)` returns `{ ok: true, request }` (trimmed)
    or `{ ok: false, reason }` for empty or over 1000 characters.
  - `changeBlockedReason(reel, jobs)`: `null` when the reel is `processed` and no job is `queued`
    or `running`; otherwise one line: "A job is running on this reel; wait for it to finish." /
    "Changes open once the reel is processed." (interim rule until slice 16).
  - `versionOrigin(version, versionsById)`: `"restored from v<n>"` when `restored_from_id` is set,
    the request when set, else `"automatic"`.
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS` gains `request, restore_version_id`; `JobRow` the
  two fields; add `JOB_KINDS`.
- `apps/studio/src/lib/versions.ts`: add `VERSION_LIST_COLUMNS` (`id, reel_id, number, parent_id,
restored_from_id, request, change_summary, created_at`, named, never `*`) and its row type; keep
  `VERSION_COLUMNS` if still used, or remove it if knip flags it.
- `apps/studio/src/lib/change-requests.test.ts`: trimming, empty, whitespace only, exactly 1000,
  1001; each blocked reason (status not processed, a queued job, a running job, a failed or done
  job does not block); the three origin labels.

### 8. Studio: server actions

- `apps/studio/src/app/change-actions.ts` (`"use server"`), modelled on `upload-actions.ts`:
  - `requestChange({ reelId, text })`: `isReelId`, `normalizeRequest`, the user's own server
    client (signed out returns `signed-out`), reads the reel's status and its jobs (named columns)
    and returns `blocked` with the reason when `changeBlockedReason` is not null, then inserts
    `{ reel_id, kind: 'change', request }` under RLS and returns `{ status: 'queued', jobId }`.
    Never logs the request text.
  - `requestRestore({ reelId, versionId })`: same checks, refuses the current version, inserts
    `{ reel_id, kind: 'restore', restore_version_id }`.
  - Results: `queued | invalid | blocked | signed-out | failed`.

### 9. Studio: the text box

- `apps/studio/src/components/ChangeRequestForm.tsx` (client): a labelled `<textarea>` ("Ask for a
  change", `maxLength` 1000, name `request`) and a "Send" button. Disabled, with the one-line reason
  in a `<p>` linked by `aria-describedby`, when `blockedReason` is set. On submit: calls
  `requestChange`; on `queued` clears the box, shows "Pending: <the request>" until the job leaves
  `queued`/`running` (derived from the live jobs prop, no timer), and calls
  `capture("studio_change_requested", { reel_id })` with nothing else. Validation errors show
  inline. No `useEffect` for derived state.

### 10. Studio: the versions list

- `apps/studio/src/components/VersionList.tsx` (client): heading "Versions", newest first, each
  item (`data-testid="version-item"`, `data-version-number`) shows "v<n>", the time
  (`formatCreatedAt`), the origin (`versionOrigin`, the request quoted), the change summary, a
  "current" marker on `current_version_id`, and on every other version a "Go back to this" button
  (disabled with the same blocked reason) that calls `requestRestore`.
- `apps/studio/src/components/LiveReel.tsx`: takes `versions`, holds them in state, adds a
  `postgres_changes` `INSERT` listener on `versions` filtered `reel_id=eq.<id>` (rows picked with
  `pickColumns` on `VERSION_LIST_COLUMNS`, merged with `upsertById`), reads them in the catch-up
  snapshot, renders `ChangeRequestForm` directly under `ReelPreview` and `VersionList` after it.
  Show each job's request (or "go back to v<n>") on its line in the jobs list. No interval, no
  polling.
- `apps/studio/src/app/reels/[id]/page.tsx`: also reads the reel's versions (named columns,
  ordered by `number`) and passes them in.
- `apps/studio/src/lib/track.ts`: update the comment (two events are sent now).

### 11. E2E spec

- Add `apps/studio/test-support/ai-script.ts` `brokenAnswerScript(dir)`: one envelope
  `{ type: "result", subtype: "success", is_error: false, result: "not json", usage: {...} }`,
  replayed for both calls, so decide fails twice.
- Create `apps/studio/e2e/change-requests.spec.ts`, serial, modelled on `preview.spec.ts`
  (`claimableJobIds` guard in `beforeAll`, own `CACHE_PREFIX`, `seedProcessedReel` so version 2 is
  current, CDN routing, cleanup of every key and the user), with one page kept across steps where
  the no-reload marker matters. Tests, in this order:
  1. Interim rule: insert as admin a `process` job `running` with `lease_holder` and
     `lease_expires_at` an hour ahead (not claimable); the box and "Go back to this" are disabled
     with the reason; then mark it `done` as admin and the box enables live.
  2. Change: set `window.__noReload`; type `no accent on 'work'` and click Send; the pending line
     shows; as admin the reel has one `change` job with exactly that `request`; run
     `runWorkerOnce({ R2_KEY_PREFIX, E2E_MOCK_AI_SCRIPT: SHORT_SPEECH_ANSWER })` (exit 0); without a
     reload `data-preview-version` becomes version 3's id, the versions list shows v3 with the
     request and the answer's change summary; `__noReload` survives. The change job's step rows are
     exactly one, `decide`, `done` (no fixed step, no `first_version`). `studio_change_requested`
     was captured once with properties `{ app: "studio", reel_id }` only, and no property value
     contains the request text.
  3. Failure keeps the version: send another request, run the worker with `brokenAnswerScript`
     (exit 1); the job shows `failed` with the tail naming "the answer failed twice, version 3
     stays current"; `reels.current_version_id` is still v3; the reel status is still `processed`;
     the box is enabled again.
  4. Restore: record the bytes of v1 to v3's keys; click "Go back to this" on v1; a `restore` job
     exists; run the worker; v4 appears (`restored_from_id` v1, `parent_id` v3, bytes equal to v1)
     and the preview shows it; go back to v3, run the worker: v5 (`restored_from_id` v3, `parent_id`
     v4). v1 to v4 keys hold the same bytes as before, and their rows are unchanged.
  5. RLS from the browser side: with `signedInClient` for a second user B, inserting a `change` job
     for A's reel is refused; as A, a `change` job without `request` is refused by the check.
- Add the new keys to the cleanup list.

### 12. Documentation

- Create `app_docs/change-requests.md` (Specifications, Overview, How it works, How to Use,
  Configuration, Testing, Rules, Notes) covering the text box, job kinds `change` and `restore` and
  their columns and checks, the insert policy, what the worker runs for each kind and that it never
  touches the reel status, the versions list and going back, the interim ordering rule (until
  slice 16), the event. Rules: history is never rewritten (restore always creates a new version,
  nothing deletes or edits a version); a failed change leaves the current version and the reel
  status as they were; the request text is stored on the job and the version, never sent to
  PostHog (the event carries `reel_id` only); never poll for the new version; owners never write
  job status or lease columns. No em-dashes.
- `docs/conditional-docs.md`: one line, "Read `app_docs/change-requests.md` when changing the
  change-request box, the versions list or going back, job kinds `change` and `restore`, the
  worker's dispatch on job kind, or `apps/studio/e2e/change-requests.spec.ts`."
- `app_docs/studio.md`: jobs now have three kinds and two owner insert paths; point to the new doc.
  `app_docs/decide-step.md`: Notes, the owner-request path now exists. `app_docs/measurement.md`:
  `studio_change_requested` is sent.
- `.adw/project.md` Tests section: one clause describing `change-requests.spec.ts` beside the other
  studio specs (no heading changes).

### 13. Validation

- Run every command in `Validation Commands`, fix anything that fails, and leave the tree passing.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/change-requests.test.ts`: request normalisation and the 1000-character
  limit, the interim blocked reasons, the version origin labels.
- `apps/worker/src/restore-step.test.ts`: restore copies bytes, sets parent and restored-from,
  leaves the old version untouched, refuses another reel's version.
- `apps/worker/src/job-kinds.test.ts` (or `process-job.test.ts`): `change` runs only decide with the
  request, `restore` only restore, unknown kinds fail.
- A queue test: a failed or finished `change`/`restore` job writes no reel status.

### Test Coverage

- DB layer, `apps/studio/db-tests/change-jobs.test.ts`: catches an owner inserting a job for
  another's reel, a `change` without valid text, a `restore` naming another reel's version, or an
  owner writing status or lease columns; fails today because the kinds and columns do not exist.
- Unit layer, `change-requests.test.ts`: catches a wrong trim or limit, a box that opens while a job
  is running, a wrong "automatic" / "restored from" label; fails today (module absent).
- Unit layer, `restore-step.test.ts` and `job-kinds.test.ts`: catch a change job that reruns fixed
  steps or a restore that rewrites history; fail today (no dispatch, no restore step).
- E2E layer, `apps/studio/e2e/change-requests.spec.ts`: catches the whole loop failing in a browser
  (no box, no live version 3, failed change moving the version or the reel to failed, restore not
  making v4 and v5, the event carrying text, the interim rule not disabling); fails today because
  the page has no text box or versions list.

### Edge Cases

- Request of only spaces, exactly 1000 characters, 1001 characters, leading/trailing spaces
  (stored trimmed).
- Submitting while a `process` job is running, while a previous `change` is queued, and while the
  reel is `failed` or still processing: box disabled, server action also returns `blocked`.
- Decide refuses twice: job `failed`, tail shows both rounds, version and reel status unchanged.
- "Go back to this" on the current version: not offered; the action refuses it.
- Restoring a version that was itself a restore (v4 from v1, then back to v3 making v5).
- `restore_version_id` of another reel or another owner's reel: refused by the policy.
- `save_version` refusing a stale parent (a version saved between read and save): the job fails and
  the current version stays (already enforced by the function).
- Realtime catch-up: a version saved between the server read and the subscription appears after the
  ready read.

## Acceptance Criteria

- Owners can insert `change` (with 1 to 1000 trimmed characters) and `restore` (with a version of
  the same reel) jobs for their own reels only; they cannot write status or lease columns; checks
  refuse a `change` without text and a `restore` without a version.
- The text box sits under the preview; sending creates a `change` job with the text, shows it as
  pending and sends `studio_change_requested` with `reel_id` only.
- The box is disabled with a one-line reason while the reel is not `processed` or any of its jobs is
  `queued` or `running`.
- A `change` job runs only `decide` (no fixed step rows); on success the new version is current and
  the preview shows it without a reload; on failure the job is `failed` with the reasons and the
  current version and reel status are unchanged.
- The versions list shows every version with time, origin and change summary, and "Go back to this"
  on non-current versions; a restore makes a new version copying the old one, with the right parent
  and restored-from; older versions' bytes and rows never change.
- No polling anywhere; updates arrive through Realtime.
- `app_docs/change-requests.md` exists with a Rules section and one index line.
- Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: applies the new migration to this run's ADW stack before the DB and
  E2E layers (the profile's replacement for `supabase migration up --local`; on failure report and
  stop).
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker`: lint the two changed apps.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker`: types, including the
  new `ClaimedJob` and `JobRow` fields.
- `yarn knip`: no unused export (for example a leftover `VERSION_COLUMNS`).
- `yarn format:check`: Prettier over the repository, including the doc and the migration.
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker`: unit tests, including the
  migration version guard over the new migration.
- `yarn turbo run test:db --filter=./apps/studio`: `change-jobs.test.ts` and the existing RLS,
  jobs, versions and Realtime tests against the ADW stack.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/worker`: the studio builds with no
  variables; the worker's check is its typecheck.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's full gate, unfiltered.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites, including
  `change-requests.spec.ts`, against the server `/prepare_app` started with the Workspaces dev
  command (values from `.ports.env`).

## Notes

- No new dependency.
- The issue asks to run `supabase migration up --local`; the profile's Protected section forbids
  that command in a run and prescribes `.adw/supabase-stack reset` after adding a migration, which
  applies the worktree's migrations to the ADW stack. The developer's stack is never touched. CI
  applies the migration to its own fresh stack.
- The ordering of a reel's jobs is enforced only in the UI and the server action (interim rule);
  database-enforced ordering and the AI-unavailable wait are slice 16. Two jobs for one reel can
  still be inserted directly through the API; `save_version`'s stale-parent check keeps history
  consistent if that happens.
- `change` and `restore` jobs never change `reels.status`: a failed change must leave a `processed`
  reel usable, and the reel row's only change on success is `current_version_id` (set by
  `save_version`), which is what Realtime delivers to the page.
- No prompt change is planned: the prompt already includes the owner's request. If the
  implementer edits `prompt.md`, bump `PROMPT_VERSION` (decide-step rule).
- The pipeline does not verify the AI's handling of real requests or the real round-trip time;
  those are the owner's manual acceptance (three changes from the `rethink-work` review notes and
  `editing-rules.md`, timed against the old render-per-round loop).
- Review screenshots: the signed-in reel page of a processed reel at 1920x1080 and 375x667 should
  show the text box under the preview and the versions list.
