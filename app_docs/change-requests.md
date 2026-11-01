# Change requests and versions

**Specifications:** [specs/issue-34-adw-7812d494-sdlc_planner-change-requests-and-versions.md](../specs/issue-34-adw-7812d494-sdlc_planner-change-requests-and-versions.md)

## Overview

Under the live preview of a processed reel, the owner types a change in plain words. The studio
inserts a `change` job carrying the text, and the worker runs only `decide` from the current version
with that request. On success the new version becomes current and the preview follows through
Realtime without a reload; on a double failure the job fails with both rounds' reasons and nothing
else moves. The reel page also lists every version and lets the owner go back to any earlier one
through a `restore` job that copies it into a new version, so going back can itself be undone.

## How it works

### Database

- `supabase/migrations/20261107090000_change_requests.sql`: `jobs_kind_check` allows `process`,
  `change` and `restore`; new columns `jobs.request text` and
  `jobs.restore_version_id uuid references versions (id)`; `jobs_request_check` (a request exactly
  when `kind = 'change'`, trimmed, 1 to 1000 characters) and `jobs_restore_check` (a restore target
  exactly when `kind = 'restore'`); the column grant
  `grant insert (reel_id, kind, request, restore_version_id) on public.jobs to authenticated`
  (status, lease and attempts stay the worker's); the insert policy for
  `change` and `restore`: own reel, `status = 'queued'`, reel `processed`, no `queued` or `running`
  job on the reel, a restore target that is a version of the same reel.
- `supabase/migrations/20261107090100_change_requests_policy_name.sql`: the first policy name was
  over Postgres's 63-byte identifier limit and was stored truncated; it is renamed to
  `jobs: owner queues a change or restore for own processed reel`.
- `supabase/migrations/20261107090200_change_requests_active_job.sql`: the policy read
  `public.jobs` from inside a policy on `public.jobs`, which Postgres refuses as infinite recursion
  (42P17) on every insert. The "no active job" check now calls `public.reel_has_active_job(p_reel_id)`,
  a `security definer` SQL function (`search_path = ''`) that answers only for the caller's own
  reels. Execute is revoked from `public`, `anon` and `service_role` (Supabase's default privileges
  grant them explicitly) and granted to `authenticated`. The policy is dropped and recreated with it.

### Studio

- `apps/studio/src/lib/change-request.ts`: `MAX_REQUEST_CHARS = 1000`, `parseChangeRequest` (the
  same bounds as `jobs_request_check`) and `changeBlockedReason`, which answers "Changes open once
  processing has finished." or "Wait for the running job to finish." (or null when one may be sent).
- `apps/studio/src/app/version-actions.ts`: the `requestChange` and `goBackTo` server actions insert
  under the owner's session and RLS decides. A refused insert logs only the error code and message,
  never the text. They answer `queued`, `invalid`, `signed-out` or `refused`.
- `src/components/ChangeRequestForm.tsx`: the label "Ask for a change", the "Send change" button, the
  reason under `data-testid="change-blocked"` while blocked, "Sent: waiting for the worker" once
  queued, then `capture("studio_change_requested", { reel_id })`.
- `src/lib/versions.ts`: `VERSION_COLUMNS`, `readVersions` and `versionLabel` (the request in
  quotes, "restored from vN" or "automatic").
- `src/components/VersionList.tsx`: newest first, rows `version-row` with `version-label` and
  `version-summary`, a "current" mark, and "Go back to this" on every other row, disabled by the same
  reason as the change box.
- `src/components/LiveReel.tsx` renders the form under the preview and the list under it, re-reads
  the versions on the ready catch-up and once on each new `current_version_id`, and shows a job's
  request (quoted) or "go back to version N".
- `src/lib/jobs.ts` adds `request` and `restore_version_id` to `JOB_COLUMNS`.

### Worker

- `apps/worker/src/process-job.ts` routes on `job.kind`.
- `apps/worker/src/change-job.ts` (`changeJob`) reads the current version, maps its `inputs` to step
  fingerprints with `fingerprintsFromInputs` (`steps/version-io.ts`) and calls `decide` with the
  request, so no fixed step runs and only a `decide` step row is written. Its errors are
  `change: job has no request` and `change: no current version`.
- `apps/worker/src/steps/restore.ts`: the in-process step `restore` calls `restoreVersion` through
  the lease-guarded wrappers; its line reads `restore: restored version N as version M`.
- `apps/worker/src/queue.ts`: `endJob`'s `reel` outcome may be `null`, and `finishJob` and
  `failJob` pass `null` for any kind but `process`, so a change or restore never moves
  `reels.status`.

### Interim ordering rule

One active job per reel, enforced in the UI (the disabled box and buttons) and by the insert
policy. Slice 16 replaces both with ordering enforced by the queue.

## How to Use

1. Open a processed reel's page in the studio.
2. Type a change under the preview and press "Send change"; the next version appears in the
   preview and in Versions when the worker finishes.
3. In Versions, press "Go back to this" on an earlier version; it is copied into a new current
   version.

## Configuration

- `E2E_MOCK_AI_SCRIPT` scripts `fixtures/decide/change-request.json` (a passing answer with a
  different `change_summary` and one accent fewer, so version 3 differs from version 2) and
  `fixtures/decide/fail-twice.json` (`[{ "output": { "change_summary": "broken" } }]`, which fails
  the per-reel schema; the fake repeats it for round 2).
- Nothing new in `turbo.json` or the env files.

## Testing

- Unit: `apps/studio/src/lib/change-request.test.ts`, `apps/studio/src/lib/versions.test.ts`,
  `apps/worker/src/change-job.test.ts`, `apps/worker/src/steps/restore.test.ts`,
  `apps/worker/src/queue.test.ts`, `apps/worker/src/decide/fixture-answer.test.ts`.
- DB: `apps/studio/db-tests/change-jobs.test.ts` (needs `supabase migration up --local`).
- E2E: `apps/studio/e2e/change-requests.spec.ts`, four tests: the box is disabled while a job runs;
  a change makes the next version current without a reload, running only decide; a double failure
  keeps the version and the reel; going back copies an old version and can be undone.

## Rules

- History is never rewritten: a restore always makes a new version; nothing edits or deletes a
  version object or row.
- A failed change leaves the current version and the reel status as they were.
- The request text is stored on the job and the version, and is never sent to PostHog or logged
  (`studio_change_requested` carries `reel_id` and `app` only).
- Never poll: versions are read on open, on subscription ready and on a new `current_version_id`.
- A change job never runs a fixed step.
- Do not read `public.jobs` inside a policy on `public.jobs`; go through `reel_has_active_job`
  (which ignores `render` jobs: a render never moves the current version).
- Do not grant the owner insert on `jobs` beyond
  `(reel_id, kind, request, restore_version_id, version_id)`.

## Notes

- The interim ordering rule is temporary (slice 16).
- `claim_job` still takes the oldest job globally.
