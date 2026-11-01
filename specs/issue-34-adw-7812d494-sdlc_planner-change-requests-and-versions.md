# Feature: change requests: text box under the preview, change and restore jobs, versions list

## Metadata

issue_number: `34`
adw_id: `7812d494`
issue_json: `{"number":34,"title":"feat: change requests: text box under the preview, change and restore jobs, versions list"}`

## Feature Description

Reel studio MVP, slice 11 of 17. The owner types a change in plain words in a text box under the
reel's live preview ("move the title lower", "no accent on 'work'"). Submitting inserts a `change`
job carrying the text. The worker runs only the decide step for that job, with the request and the
current version as input (every fixed step is skipped, so it takes seconds plus the AI's time). On
success the new version becomes current and the preview rebuilds through Realtime, without a reload.
On a double failure the job fails with both rounds' reasons and the current version does not move.

The reel page also gains a versions list: every version with its time, what produced it (the
request in quotes, "automatic", or "restored from vN"), its change summary, and a "Go back to this"
control on every non-current version. Going back inserts a `restore` job; the worker copies the old
version's bytes into a new version (C2: history is never rewritten), so going back can itself be
undone. Sending a request sends `studio_change_requested` with `reel_id` only.

## User Story

As the owner of the studio
I want to type a change in plain words under the preview, see the new version a minute later without
reloading, and go back to any earlier version
So that I can iterate on a reel in seconds instead of the old render-per-round loop, without ever
losing a version

## Problem Statement

After #32 and #33 the worker can make an AI version (decide) and the preview follows the current
version, but the owner has no way to ask for a change: `decide` only runs once inside the `process`
job with `request = null`, `jobs.kind` allows only `process`, the owner may insert only a `process`
job, and the reel page shows only the current version's number. `restoreVersion` exists in
`packages/edit` but nothing calls it. The reserved `studio_change_requested` event is never sent, so
the section 4 metric "changes per reel" has no data.

## Solution Statement

- **Database** (one new migration): `jobs.kind` allows `change` and `restore`; new columns
  `jobs.request text` (required, trimmed, 1 to 1000 characters, exactly when `kind = 'change'`) and
  `jobs.restore_version_id uuid references versions(id)` (required exactly when
  `kind = 'restore'`). The column insert grant widens to `(reel_id, kind, request,
restore_version_id)`; status and lease columns stay ungranted. A new insert policy lets the owner
  queue a `change` or `restore` job only for their own `processed` reel with no `queued` or
  `running` job (the interim ordering rule, also enforced in the UI until slice 16), and a restore
  target only from that same reel.
- **Worker**: `processJob` routes on `job.kind`. `process` is unchanged. `change` reads the current
  version's `inputs` (the fingerprints the edit was made from), maps them to the step fingerprints
  `decide` needs and calls `decide({ request: job.request })`: no fixed step runs and no step row is
  written for them, only `decide`. `restore` runs a new in-process step `restore` that calls
  `restoreVersion` through the lease-guarded wrappers. For `change` and `restore` the job's end
  never touches `reels.status` (a failed change must leave the reel `processed` and its version
  as it was).
- **Studio**: a `ChangeRequestForm` under the preview (textarea plus submit button) calls a server
  action that validates the text and inserts the job under the owner's session (RLS decides), then
  sends `studio_change_requested` with `{ reel_id }` only. A pure helper gives the one-line reason the
  form and the restore buttons are disabled. A `VersionList` reads the reel's versions under RLS on
  open and re-reads once each time Realtime reports a new `current_version_id` (no polling). The
  jobs list shows each job's request or restore target so a pending request is visible.

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview (read first).
- `AGENTS.md`: repository rules (no em-dashes, Yarn only, docs rules, test rules).
- `.adw/project.md`: the ADW profile (commands, ports, Protected: only `supabase migration up --local`).
- `docs/conditional-docs.md`: documentation index; the lines for `studio.md`, `measurement.md`,
  `decide-step.md`, `edit-model.md` and `preview.md` match this task.
- `app_docs/studio.md`: tables, RLS, job queue, Realtime, studio Rules (no polling, named columns,
  no general status write for owners).
- `app_docs/measurement.md`: the step runner, `studio_*` events table (`studio_change_requested`
  is "reserved, not sent yet" today) and the event Rules.
- `app_docs/decide-step.md` (from #33): decide's inputs, `request`, retry and failure, the fake
  `E2E_MOCK_AI_SCRIPT`; "How to Use" step 4 says a later slice passes `request`.
- `app_docs/edit-model.md` (from #31): `saveVersion`, `restoreVersion`, `save_version`, immutability.
- `app_docs/preview.md` (from #32): the preview rebuilds when `current_version_id` changes.
- `app_docs/pipeline.md` (from #29/#30): the fixed steps and their fingerprints.
- `supabase/migrations/20261031174750_job_queue.sql`: `jobs` table, `jobs_kind_check`, grants,
  the owner's process-job insert policy, `claim_job` (returns `jobs.*`, so new columns arrive).
- `supabase/migrations/20261104090000_versions.sql`, `20261106090000_decide_versions.sql`: the
  `versions` table, owner-read RLS, `save_version` (refuses a parent that is no longer current).
- `apps/worker/src/process-job.ts`: wires one claimed job; becomes the router by kind.
- `apps/worker/src/queue.ts`: `ClaimedJob`, `finishJob`, `failJob` (`endJob` sets the reel to
  `processed` or `failed` today).
- `apps/worker/src/decide/decide.ts`: the decide step; already takes `request` and skips the
  "already decided" shortcut when a request is present.
- `apps/worker/src/steps/version-io.ts`: `leaseGuarded`, `fingerprintOf`; shared helpers for
  version steps.
- `apps/worker/src/steps/first-version.ts` and `first-version.test.ts`: the pattern for an
  in-process version step and its unit test with fakes.
- `apps/worker/src/ai.ts`: the scripted fake (`E2E_MOCK_AI_SCRIPT`, last answer repeated).
- `apps/worker/src/decide/fixture-answer.test.ts`: proves a committed fake script passes every check.
- `packages/edit/src/versions.ts`: `restoreVersion` (sets `restored_from_id`, `parent_id` = current,
  `change_summary` = `restored version N`).
- `apps/studio/src/app/reels/[id]/page.tsx`: server read of the reel, jobs, steps, version number.
- `apps/studio/src/components/LiveReel.tsx`: Realtime subscription; renders the preview, status,
  jobs and steps. The form and the versions list go here.
- `apps/studio/src/components/Preview.tsx`: rebuilds on a new `versionId`; sets `window.__preview`.
- `apps/studio/src/lib/jobs.ts`: `JOB_COLUMNS`, `JobRow`, `upsertById`, `pickColumns`.
- `apps/studio/src/lib/reels.ts`: `REEL_DETAIL_COLUMNS`, `versionNumberOf`.
- `apps/studio/src/lib/track.ts`: `capture` and `STUDIO_EVENTS`.
- `apps/studio/src/app/upload-actions.ts`: the server action pattern (session client, result union,
  logging without user content).
- `apps/studio/e2e/preview.spec.ts`, `apps/studio/e2e/upload.spec.ts`, `apps/studio/e2e/events.ts`:
  spec setup (seeded cache, `runWorkerOnce`, `claimableJobIds` guard, `window` marker, event log).
- `apps/studio/test-support/pipeline.ts`, `worker.ts`, `fixtures.ts`, `local-supabase.ts`: seeding,
  spawning the worker's `once` with fakes, test users, signed-in clients.
- `apps/studio/db-tests/jobs.test.ts`, `rls.test.ts`, `versions.test.ts`: DB-layer patterns.
- `fixtures/decide/short-speech.json`: the fake's scripted decide answer for the E2E clip.
- `knip.json`, `turbo.json`: no change expected (no new env variable, new files sit in existing
  project globs).
- `node_modules/next/dist/docs/`: read the server actions / forms guide before the studio work.

### New Files

- `supabase/migrations/20261107090000_change_requests.sql`: job kinds, `request`,
  `restore_version_id`, checks, grant, insert policy.
- `apps/worker/src/steps/restore.ts` and `restore.test.ts`: the `restore` step.
- `apps/worker/src/change-job.ts` and `change-job.test.ts`: the `change` job's work (fingerprints
  from the current version's inputs, then `decide` with the request).
- `apps/studio/src/lib/change-request.ts` and `change-request.test.ts`: `parseChangeRequest`
  (trim, 1 to 1000) and `changeBlockedReason(reelStatus, jobs)` (the interim rule).
- `apps/studio/src/lib/versions.ts` and `versions.test.ts`: `VERSION_COLUMNS`, `VersionListRow`,
  `readVersions`, `versionLabel` ("automatic", the request, "restored from vN").
- `apps/studio/src/app/version-actions.ts`: server actions `requestChange` and `goBackTo`.
- `apps/studio/src/components/ChangeRequestForm.tsx`: the text box under the preview.
- `apps/studio/src/components/VersionList.tsx`: the versions list with "Go back to this".
- `apps/studio/db-tests/change-jobs.test.ts`: RLS and checks for the new job kinds.
- `apps/studio/e2e/change-requests.spec.ts`: the browser journey (verification 1, 2, 3, 5, 6, 7).
- `fixtures/decide/change-request.json`: scripted valid answer for the change (differs from v2).
- `fixtures/decide/fail-twice.json`: scripted answer that fails the schema (repeated, so both
  rounds fail).
- `app_docs/change-requests.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

1. Bring #32 (live preview) and #33 (decide step) into this branch. Neither is in it yet (it is at
   `7d82d00`, PR #50). If `origin/develop` already contains both, merge `origin/develop`. Otherwise
   merge `feat/issue-33-adw-48ca5f11-add-decide-step-claude-schema` first, then
   `feat/issue-32-adw-b7898314-live-preview-hyperframes-player`. Both build on #31, so the second
   merge conflicts in seven files; every resolution is a union of both sides (see the tasks).
2. The migration: new job kinds, the two columns and their checks, the widened grant and the
   owner's change/restore insert policy. Apply it with `supabase migration up --local` (the one
   database command ADW may run); on failure stop and report.

### Phase 2: Core Implementation

1. Worker: `ClaimedJob` carries `request` and `restore_version_id`; `endJob` leaves the reel's
   status alone for `change` and `restore`; `processJob` routes by kind to the existing pipeline,
   the new `changeJob` and the new `restore` step.
2. Studio helpers (pure, unit-tested): request parsing, interim-rule reason, version labels, the
   versions read.
3. Studio server actions inserting `change` and `restore` jobs under the owner's session.

### Phase 3: Integration

1. `ChangeRequestForm` under the preview, `VersionList` below it, the jobs list showing each job's
   request or restore target, all in `LiveReel`, following Realtime (reels, jobs) with one versions
   re-read per new `current_version_id`.
2. `studio_change_requested` sent with `{ reel_id }` after a successful insert.
3. DB tests, the E2E spec, fixtures, the feature doc and its index line, the measurement and decide
   docs updated.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Merge the dependency branches

- `git fetch origin`. If `git merge-base --is-ancestor feat/issue-33-adw-48ca5f11-add-decide-step-claude-schema origin/develop`
  and the same for `feat/issue-32-adw-b7898314-live-preview-hyperframes-player` both succeed,
  `git merge origin/develop`. Otherwise `git merge feat/issue-33-adw-48ca5f11-add-decide-step-claude-schema`
  (clean, fast-forwardable content) and then `git merge feat/issue-32-adw-b7898314-live-preview-hyperframes-player`.
- Resolve the conflicts as unions, keeping both features:
  - `apps/studio/src/lib/reels.ts`: keep `current_version_id: string | null` once (with #32's
    comment) and keep #33's `versionNumberOf`.
  - `apps/studio/src/components/LiveReel.tsx`: keep #33's signature with `versionNumber` and a
    comment naming both the version number and the preview rebuild.
  - `apps/worker/src/process-job.ts`: keep both `await recordPreviewCopies(ctx, fingerprints);` and
    `const versions = supabaseVersionStore(db);` (preview copies first, as in #32's order).
  - `apps/worker/src/step-store.ts`: keep `previewCopies(reelId, fingerprint)` and the `done` with
    the optional `ai?: AiUsage` argument, in interface and implementation.
  - `apps/worker/src/recording-steps.ts`: keep the `previewCopies` call variant and the `done`
    variant with `ai?`, and both methods.
  - `apps/studio/e2e/upload.spec.ts`: keep #33's two-version assertions and #32's
    `preview_copies_fingerprint` assertion; merge the key bookkeeping into one list.
  - `docs/conditional-docs.md`: keep both lines (`decide-step.md` and `preview.md`).
- `yarn install --immutable` (the merged `yarn.lock` must not change), then `yarn lint`,
  `yarn typecheck`, `yarn knip`, `yarn test` must pass before going on. Commit the merge
  (`feat: merge the live preview and the decide step`).

### 2. Migration `supabase/migrations/20261107090000_change_requests.sql`

- Header comment: owners may now queue a change (their words) or a restore (a version of the same
  reel) for their own processed reel; status and lease stay the worker's; `reels` stays in the
  Realtime publication (already added by the skeleton migration; do not add it again).
- `alter table public.jobs drop constraint jobs_kind_check, add constraint jobs_kind_check check (kind in ('process', 'change', 'restore'));`
- `alter table public.jobs add column request text, add column restore_version_id uuid references public.versions (id);`
  (no `on delete` cascade needed; versions are never deleted except by the reel's cascade, which
  also removes its jobs).
- Named checks:
  - `jobs_request_check`: `(kind = 'change') = (request is not null)` and
    `(request is null or (request = btrim(request) and char_length(request) between 1 and 1000))`.
  - `jobs_restore_check`: `(kind = 'restore') = (restore_version_id is not null)`.
- `grant insert (reel_id, kind, request, restore_version_id) on public.jobs to authenticated;`
  (no grant on `status`, `lease_*`, `owner_id`, `attempts`, `error_tail`).
- New policy `"jobs: owner inserts a change or restore job for own processed reel"` for insert to
  authenticated, `with check`: `(select auth.uid()) = owner_id`, `kind in ('change', 'restore')`,
  `status = 'queued'`, the reel exists with `owner_id = auth.uid()` and `status = 'processed'`, no
  job of that reel is `queued` or `running` (the interim ordering rule; comment that slice 16
  replaces it), and `restore_version_id is null or exists (select 1 from public.versions v where v.id = restore_version_id and v.reel_id = reel_id)`.
  Keep the existing process-job policy unchanged.
- Run `supabase migration up --local`. If it fails, report the error and stop (never reset).

### 3. Worker: queue and job routing

- `apps/worker/src/queue.ts`: `ClaimedJob` gains `request: string | null` and
  `restore_version_id: string | null`. `endJob`'s outcome `reel` becomes
  `"processed" | "failed" | null`; `null` skips the reel update. `finishJob`/`failJob` pass `null`
  when `job.kind !== "process"` (comment: a change or restore never moves the reel's status; a
  failed change leaves the reel processed on its current version).
- `apps/worker/src/steps/version-io.ts`: add `fingerprintsFromInputs(inputs: Edit["inputs"])`
  returning `{ retime: inputs.transcript, head_track: inputs.headTrack, remove_background: inputs.cutout }`
  (the mapping `first_version` used to build them; comment it).
- New `apps/worker/src/change-job.ts`: `changeJob({ ctx, storage, keyPrefix, scratchDir, versions, request, ai?, newId?, spawnTool? })`:
  reads `versions.current(reel)` then `versions.get(id)`; none is the error
  `change: no current version`; calls `decide` with `fingerprints = fingerprintsFromInputs(parent.inputs)`
  and the `request`. A missing or empty request throws `change: job has no request` before any step.
- New `apps/worker/src/steps/restore.ts`: an in-process step named `restore` run through the step
  runner like `first_version` (one `steps` row, measurements, span). It reads the job's
  `restore_version_id`, calls `restoreVersion` with `leaseGuarded(storage, versions, signal)` and a
  new id; the line is `restore: restored version N as version M`. A target of another reel or a
  missing object fails the step (from `restoreVersion`'s errors).
- `apps/worker/src/process-job.ts`: inside `work(signal)`, `switch (job.kind)`: `"process"` keeps
  the merged body; `"change"` calls `changeJob`; `"restore"` calls `restore`; any other kind throws
  `unknown job kind: <kind>`. Update the top comment.

### 4. Worker unit tests

- `apps/worker/src/change-job.test.ts` (fake storage, in-memory `VersionStore`, recording steps,
  `fakeAiRunner`), modelled on `decide/decide.test.ts` and `steps/first-version.test.ts`:
  the step rows written are exactly `["decide"]` (no fixed step, no `first_version`); the AI's prompt
  carries the request; the new version records `request`, `parent_id` = the previous current;
  a double failure saves nothing and the current version is unchanged; no current version fails
  with `change: no current version`.
- `apps/worker/src/steps/restore.test.ts`: restoring v1 while v3 is current makes v4 with
  `restored_from_id` v1, `parent_id` v3, the same bytes as v1, and leaves v1's object and row
  untouched; a version of another reel fails; a lost lease writes nothing.
- Extend the existing queue/run-job tests if one covers `endJob`; otherwise add a small
  `apps/worker/src/queue.test.ts` with a stub Supabase builder asserting `failJob` on a `change`
  job never updates `reels`.
- Extend `apps/worker/src/decide/fixture-answer.test.ts` so `fixtures/decide/change-request.json`
  passes every check on the seeded fixtures and `fixtures/decide/fail-twice.json` fails them.

### 5. Fixtures

- `fixtures/decide/change-request.json`: copy of `short-speech.json`'s answer with a different
  `change_summary` (for example `removed the accent on "this"`) and one accent overlay fewer, so
  the saved v3 differs from v2. Must pass the checks (task 4 proves it).
- `fixtures/decide/fail-twice.json`: `[{ "output": { "change_summary": "broken" } }]` (fails the
  per-reel schema with readable `schema: ...` reasons; the fake repeats it for round 2).

### 6. Studio helpers and unit tests

- `apps/studio/src/lib/change-request.ts`:
  - `MAX_REQUEST_CHARS = 1000`; `parseChangeRequest(raw: unknown)`: trims; returns
    `{ ok: true, value }` or `{ ok: false, reason }` for empty or over 1000 characters.
  - `changeBlockedReason(status: ReelStatus, jobs: Pick<JobRow, "status">[]): string | null`:
    `"Changes open once processing has finished."` when the reel is not `processed`;
    `"Wait for the running job to finish."` when any job is `queued` or `running`; else `null`.
- `apps/studio/src/lib/versions.ts`: `VERSION_COLUMNS = "id, number, created_at, request, change_summary, restored_from_id, parent_id"`;
  `VersionListRow`; `readVersions(supabase, reelId)` (named columns, ordered by `number` desc,
  under RLS; error throws); `versionLabel(row, rows)`: the request in quotes, `restored from vN`
  (N looked up by `restored_from_id`), else `automatic`. Move `versionNumberOf` here only if it keeps
  callers simple; otherwise leave it in `reels.ts`.
- `apps/studio/src/lib/jobs.ts`: add `request` and `restore_version_id` to `JOB_COLUMNS` and
  `JobRow` (still no lease column).
- Tests: `change-request.test.ts` (trim, empty, whitespace only, exactly 1000, 1001; every reel
  status other than `processed`; queued and running vs done and failed jobs) and
  `versions.test.ts` (three labels, a restore of an unknown version still labelled safely).

### 7. Studio server actions `apps/studio/src/app/version-actions.ts`

- `"use server"`. Read the Next.js server actions guide in `node_modules/next/dist/docs/` first.
- `requestChange({ reelId, text })`: validates `isReelId` and `parseChangeRequest`; session client;
  `getUser` (no user: `signed-out`); `insert({ reel_id, kind: "change", request })`, owner and status
  from defaults; a refused insert logs only the error code and message (never the request text) and
  returns `{ status: "refused" }`. Returns `{ status: "queued" }`.
- `goBackTo({ reelId, versionId })`: same shape with `kind: "restore", restore_version_id`.
- No secret key, no admin client (studio Rules).

### 8. Studio components

- `apps/studio/src/components/ChangeRequestForm.tsx` (client): a labelled `<textarea>` ("Ask for a
  change", `maxLength=1000`, `name="request"`), a submit button "Send change", and when blocked a
  one-line reason (`data-testid="change-blocked"`), with the textarea and button `disabled`. On
  submit it calls `requestChange`; on `queued` it clears the box, shows "Sent: waiting for the
  worker" until the job appears, and calls `capture("studio_change_requested", { reel_id })`, with
  no other property. An `invalid` or `refused` answer shows a short error line. Prefer an event
  handler or `useActionState` over effects (see the `no-unnecessary-effects` guidance).
- `apps/studio/src/components/VersionList.tsx`: section "Versions", one `li`
  (`data-testid="version-row"`, `data-version={number}`) per version, newest first: `version N`,
  `<time>` via `formatCreatedAt`, `versionLabel`, the change summary, a "current" mark on the current
  one, and on every other row a "Go back to this" button calling `goBackTo`, disabled with the same
  `changeBlockedReason`.
- `apps/studio/src/components/LiveReel.tsx`: render `ChangeRequestForm` directly under the
  `Preview` (only when a current version exists), then `VersionList`. Keep versions in state: the
  server reads them on open (page passes `versions`), the ready-subscription catch-up re-reads them,
  and a reel update naming a new `current_version_id` triggers one `readVersions` (no interval). Keep
  the "numbers only grow" guard (apply a list only if its highest number is not lower than the one
  shown). The jobs list shows `job.request` for a change (quoted, `break-words`) and
  "go back to version N" for a restore.
- `apps/studio/src/app/reels/[id]/page.tsx`: read the versions alongside jobs and steps and pass
  them to `LiveReel`.

### 9. DB tests `apps/studio/db-tests/change-jobs.test.ts`

Modelled on `jobs.test.ts` and `rls.test.ts` (two signed-in test users, admin for setup, cleanup):

- Owner A inserts a `change` job with text for A's processed reel: accepted, `status` `queued`.
- User B inserts a `change` job for A's reel: refused.
- A `change` job without `request`, with `"   "`, with `" padded "` and with 1001 characters: refused
  (check); a `restore` job without `restore_version_id`, and a `process` job with a `request`:
  refused.
- A `restore` job naming a version of another reel: refused.
- A change while the reel is not `processed`, or while one of its jobs is `queued` or `running`:
  refused.
- The owner cannot insert `status`, `lease_holder` or `attempts` (column grant).
- `claim_job` returns `request` and `restore_version_id`.
- Needs `supabase migration up --local` (task 2).

### 10. E2E spec `apps/studio/e2e/change-requests.spec.ts`

Serial, modelled on `preview.spec.ts` (its `claimableJobIds` guard, own `CACHE_PREFIX`, seeded
pipeline cache, uploaded clip, `runWorkerOnce` with `R2_KEY_PREFIX`, `recordEvents`, cleanup of
stored keys and the test user). `beforeAll`: one `process` job through `runWorkerOnce` with the
default script, leaving the reel `processed` with version 2 current. Tests:

1. **Interim rule**: insert (admin) a `process` job with `status: "running"` and a lease in the
   future; open the reel page: the textarea and button are disabled and `change-blocked` shows the
   reason; set that job `done` (admin): the box enables without a reload.
2. **Change**: set `window.__noReload = "marker"`; type `no accent on 'work'` and submit; assert
   (admin) one `change` job with exactly that `request`; the event log has one
   `studio_change_requested` whose properties are exactly `reel_id` (and `app`), with no property
   holding the text. Run `runWorkerOnce({ R2_KEY_PREFIX, E2E_MOCK_AI_SCRIPT: <root>/fixtures/decide/change-request.json })`;
   without a reload `current-version` reads `version 3`, `window.__preview.versionId` is v3's id,
   the marker survives, and the v3 row shows the quoted request and its change summary.
   **Only decide ran**: the change job's `steps` rows are exactly one, `decide`, `done` (every fixed
   step absent).
3. **Failure keeps the version**: submit a request, run the worker with `fail-twice.json`: the job
   row shows `failed` with `decide failed twice` and `round 1:`/`round 2:` reasons; the current
   version is still 3 (page and DB) and the reel status is still `processed`.
4. **Restore**: hash (sha256) every version object v1 to v3; click "Go back to this" on v1; run the
   worker: v4 appears in the list as "restored from v1", `restored_from_id` = v1 and `parent_id` = v3
   in the DB, v4's bytes equal v1's, the preview shows v4. Then go back to v3 the same way: v5,
   `restored_from_id` = v3. Re-hash v1 to v4: unchanged.

RLS (verification 4) lives in the DB layer (task 9), the cheapest layer that proves it.

### 11. Documentation

- New `app_docs/change-requests.md` (Specifications link to this plan; Overview; How it works: the
  text box and its validation, job kinds `change` and `restore` and their columns and checks, the
  insert policy, what the worker runs for each (decide only, from the current version's inputs;
  `restore` step), the reel status untouched by these jobs, the versions list and going back, the
  interim ordering rule in UI and policy, the event; How to Use; Configuration (fixture scripts);
  Testing; Rules: history is never rewritten (restore always makes a new version, nothing edits or
  deletes one); a failed change leaves the current version and the reel status as they were; the
  request text is stored on the job and the version, never sent to PostHog or logged; no polling;
  a change job never runs a fixed step).
- `docs/conditional-docs.md`: one line for `app_docs/change-requests.md` (when changing the change
  box, the versions list, job kinds `change`/`restore`, their columns or policy, the interim rule,
  or `studio_change_requested`).
- `app_docs/measurement.md`: `studio_change_requested` moves from reserved to sent (`reel_id`,
  `app`), with where it is sent.
- `app_docs/decide-step.md`: "How to Use" step 4 now points to `change-requests.md`.
- `app_docs/studio.md`: the `jobs` table's new kinds, columns and insert policy, and the widened
  insert grant in its Rules (the Rules line about `authenticated` inserts is about `reels`; add the
  jobs grant explicitly so the invariant stays true).
- `.adw/project.md` Review section: add the processed sample reel's page with the change box and the
  versions list to the studio captures (no heading renamed or reordered).
- No em-dashes anywhere.

### 12. Validation

Run every command in `Validation Commands`, in order, and fix anything that fails.

## Testing Strategy

### Unit Tests

- `apps/studio/src/lib/change-request.test.ts`: request parsing bounds and the interim-rule reason.
- `apps/studio/src/lib/versions.test.ts`: the three labels.
- `apps/worker/src/change-job.test.ts`: only `decide` runs, the request reaches the prompt and the
  record, a double failure keeps the current version.
- `apps/worker/src/steps/restore.test.ts`: a restore makes a new version copying the bytes, never
  touches the old one.
- `apps/worker/src/queue.test.ts` (or the existing test covering `endJob`): a failed `change` never
  updates the reel.
- `apps/worker/src/decide/fixture-answer.test.ts`: the two new scripts behave as the spec expects.

### Test Coverage

- Unit (`yarn turbo run test`), `change-request.test.ts`: catches a request outside 1 to 1000
  trimmed characters reaching the database, and a box left enabled while a job runs.
- Unit, `change-job.test.ts`: catches a change job running a fixed step or saving on a failed
  decide; fails today because `changeJob` does not exist.
- Unit, `restore.test.ts`: catches a restore that edits history or sets the wrong parent.
- Unit, `queue.test.ts`: catches a failed change flipping the reel to `failed`.
- DB (`yarn turbo run test:db --filter=./apps/studio`), `change-jobs.test.ts`: catches another
  user queuing a change, a change without text, a restore across reels, an owner writing status;
  fails today because the kinds and columns do not exist.
- E2E (`yarn test:e2e`), `change-requests.spec.ts`: catches the box, the job insert, the event
  without text, the Realtime switch to the new version without reload, the failed change keeping
  v3, restore creating v4/v5 with unchanged history, and the disabled box; fails today because
  there is no text box.

### Edge Cases

- Request of only whitespace, exactly 1000 characters, 1001 characters, multi-line text, quotes.
- Double submit: the second insert is refused by the policy (a job is already queued); the form
  shows the refusal line.
- Restore of the current version: no button is shown; the policy still allows it and the worker
  makes an identical copy (harmless).
- Restore target from another reel: refused by the policy and by `restoreVersion`.
- Change job when the reel has no current version: fails with `change: no current version`.
- A change job retried after its lease expired mid-run: `save_version` refuses a stale parent;
  `decide` starts from the then-current version.
- Realtime catch-up: a version saved between the server read and the subscription appears after
  the ready re-read.
- A failed change leaves `reels.status = 'processed'` so the box enables again for the next try.

## Acceptance Criteria

- Migration applies with `supabase migration up --local`; `jobs.kind` accepts `change` and
  `restore`; `request` and `restore_version_id` are enforced by named checks; the owner can insert
  only those columns and only for their own processed reel with no active job.
- Submitting text under the preview creates one `change` job with the trimmed text and sends
  exactly one `studio_change_requested` with `reel_id` (no text in any property).
- The worker's change job writes one `steps` row (`decide`) and no fixed-step row; success makes
  the new version current and the preview shows it without a reload; double failure fails the job
  with both rounds' reasons, the version and the reel status unchanged.
- The versions list shows each version's number, time, request or "automatic" or "restored from
  vN", and summary; "Go back to this" on a non-current version creates a new version copying it
  (`restored_from_id`, `parent_id` = previous current); no version object or row ever changes.
- While the reel is not processed or any of its jobs is queued or running, the box and restore
  buttons are disabled with a one-line reason.
- No polling anywhere; versions are re-read only on open, on subscription ready and on a new
  `current_version_id`.
- `app_docs/change-requests.md` exists with a Rules section; `docs/conditional-docs.md` lists it.
- Every validation command passes.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `supabase migration up --local`: applies the new migration to the shared local stack (the only
  database command allowed; stop and report on failure).
- `yarn format:check`: formatting over the whole repository.
- `yarn turbo run lint --filter=./apps/studio --filter=./apps/worker --filter=./packages/edit`: lint the touched workspaces.
- `yarn turbo run typecheck --filter=./apps/studio --filter=./apps/worker --filter=./packages/edit`: types, including the merged dependency code.
- `yarn knip`: no unused export or file (new helpers and fixtures are used).
- `yarn turbo run test --filter=./apps/studio --filter=./apps/worker --filter=./packages/edit`: unit tests, including the new worker and studio tests.
- `yarn turbo run test:db --filter=./apps/studio`: RLS and checks of the new job kinds.
- `yarn turbo run build --filter=./apps/studio --filter=./apps/web`: the studio builds (web for the forwarding zone); the worker's build check is its typecheck.
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the issue's unfiltered gates.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: both E2E suites, including `change-requests.spec.ts`, against the server `/prepare_app` started.

## Notes

- **Dependencies not yet in this branch.** The branch is at PR #50 (`7d82d00`); #29 to #33 live on
  their own branches. #32 and #33 are siblings on #31, and merging them conflicts in seven files
  (task 1 lists each resolution). If the owner merges them into `develop` first, task 1 becomes a
  plain `git merge origin/develop`.
- **Why the change job takes fingerprints from the version's `inputs`** rather than running
  `runPipeline` for cache hits: `runPipeline` sets `reels.status` at every step, even on a hit,
  which would flip the reel away from `processed` during a change (breaking the interim rule and
  the status line). The version's `inputs` are also exactly the outputs that version's word anchors
  refer to, which stays correct even if the pipeline definition changes later.
- **Interim ordering rule** is enforced twice: the UI disables the controls, and the insert policy
  refuses a change or restore while the reel is not processed or has an active job. Slice 16
  replaces both with database-enforced ordering and the AI-unavailable wait.
- **`claim_job`** still takes the oldest job globally; with the policy above a reel never has two
  active jobs, so order per reel holds for now.
- A restored version has `model` and `prompt_version` null (from `restoreVersion`). `decide`'s
  "already decided" shortcut applies only to `request = null` (process jobs), so a later change
  request after a restore still runs.
- No new dependency, no new environment variable (the fixture scripts reach the worker through
  `runWorkerOnce`'s child env), no `turbo.json` change.
- The pipeline does not verify the AI's handling of real requests or the real round-trip time; that
  is the owner's manual acceptance (three real changes taken from the `rethink-work` review notes,
  timed against the old render-per-round loop).
- Out of scope: comments pinned to a moment, a timeline editor, export (slice 12), database
  ordering of jobs (slice 16).
