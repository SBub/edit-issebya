# Patch: Write the change-requests doc, update the touched docs and the ADW profile

## Metadata

adw_id: `7812d494`
review_change_request: `Issue #1: Step 11 (Documentation) was not implemented, so the acceptance criterion "app_docs/change-requests.md exists with a Rules section; docs/conditional-docs.md lists it" fails. Since the merge commit 0d4204c, the feature commit 9447901 touches no file under app_docs/, docs/ or .adw/. Missing: (a) app_docs/change-requests.md does not exist. (b) docs/conditional-docs.md has no line for it. (c) app_docs/measurement.md:93 still lists studio_change_requested as "reserved, not sent yet", although ChangeRequestForm.tsx:57 now sends it. (d) Step 4 of "How to Use" in app_docs/decide-step.md does not point to change-requests.md. (e) app_docs/studio.md does not describe the jobs table's new kinds, the request/restore_version_id columns, the new insert policy or the widened jobs insert grant in its Rules. (f) The Review section of .adw/project.md does not add the change box and the versions list to the studio captures. Resolution: write every item on this branch now, then grep the changed files for em-dashes. Severity: blocker`

## Issue Summary

**Original Spec:** `specs/issue-34-adw-7812d494-sdlc_planner-change-requests-and-versions.md`
**Issue:** Step 11 of the spec was skipped. `app_docs/change-requests.md` and its index line do not exist, `app_docs/measurement.md` still calls `studio_change_requested` reserved, `app_docs/decide-step.md` says nothing reads a request yet, `app_docs/studio.md` describes `jobs` as `process`-only with no owner insert beyond `process`, and the ADW profile's Review section has no capture of the change box or the versions list.
**Solution:** Documentation and profile only, no code change. Write every item on this branch now (the document phase writes only one feature doc and its index line, so it would not do (c) to (f)). Every fact below was read from the current source (the three migrations, `change-job.ts`, `steps/restore.ts`, `queue.ts`, `version-actions.ts`, `ChangeRequestForm.tsx`, `VersionList.tsx`, `change-requests.spec.ts`, the fixtures); re-read the named file while writing so each literal is exact.

## Files to Modify

- `app_docs/change-requests.md` (new)
- `docs/conditional-docs.md` (one new line)
- `app_docs/measurement.md` (events table)
- `app_docs/decide-step.md` (How to Use, step 4)
- `app_docs/studio.md` (Jobs, steps and the lease; Rules)
- `.adw/project.md` (Review, the Studio bullet; the nine `##` headings untouched)

Touch no code, test, migration or fixture.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Write `app_docs/change-requests.md`

Title `# Change requests and versions`, then `**Specifications:** [specs/issue-34-adw-7812d494-sdlc_planner-change-requests-and-versions.md](../specs/issue-34-adw-7812d494-sdlc_planner-change-requests-and-versions.md)` (same form as the top of `app_docs/decide-step.md`), then the sections `## Overview`, `## How it works`, `## How to Use`, `## Configuration`, `## Testing`, `## Rules`, `## Notes`. Content:

- Overview: the owner types a change in plain words under the live preview of a processed reel; the studio inserts a `change` job with the text; the worker runs only `decide` from the current version with the request; on success the new version becomes current and the preview follows through Realtime without a reload; on a double failure the job fails with both rounds' reasons and nothing else moves. The reel page also lists every version and lets the owner go back to any earlier one through a `restore` job that copies it into a new version, so going back can itself be undone.
- How it works, subsections:
  - Database, one bullet per migration:
    - `supabase/migrations/20261107090000_change_requests.sql`: `jobs_kind_check` allows `process`, `change`, `restore`; new columns `jobs.request text` and `jobs.restore_version_id uuid references versions (id)`; `jobs_request_check` (a request exactly when `kind = 'change'`, trimmed, 1 to 1000 characters) and `jobs_restore_check` (a restore target exactly when `kind = 'restore'`); `grant insert (reel_id, kind, request, restore_version_id) on public.jobs to authenticated` (status, lease and attempts stay the worker's); the insert policy for `change` and `restore`: own reel, `status = 'queued'`, reel `processed`, no `queued` or `running` job on the reel, restore target a version of the same reel.
    - `20261107090100_change_requests_policy_name.sql`: the first policy name was over Postgres's 63-byte identifier limit and was stored truncated; renamed to `jobs: owner queues a change or restore for own processed reel`.
    - `20261107090200_change_requests_active_job.sql`: the policy read `public.jobs` from inside a policy on `public.jobs`, which Postgres refuses as infinite recursion (42P17) on every insert. The "no active job" check now calls `public.reel_has_active_job(p_reel_id)`, a `security definer` SQL function (`search_path = ''`) that answers only for the caller's own reels; execute revoked from `public`, `anon` and `service_role` (Supabase's default privileges grant them explicitly), granted to `authenticated`. The policy is dropped and recreated with it.
  - Studio: `apps/studio/src/lib/change-request.ts` (`MAX_REQUEST_CHARS = 1000`, `parseChangeRequest`, `changeBlockedReason` with "Changes open once processing has finished." and "Wait for the running job to finish."); `apps/studio/src/app/version-actions.ts` (`requestChange` and `goBackTo` server actions under the owner's session, RLS decides; a refused insert logs only the error code and message, never the text; answers `queued`, `invalid`, `signed-out`, `refused`); `src/components/ChangeRequestForm.tsx` (label "Ask for a change", "Send change", `data-testid="change-blocked"` reason, "Sent: waiting for the worker", then `capture("studio_change_requested", { reel_id })`); `src/lib/versions.ts` (`VERSION_COLUMNS`, `readVersions`, `versionLabel`: the request in quotes, "restored from vN" or "automatic"); `src/components/VersionList.tsx` (newest first, `version-row`, `version-label`, `version-summary`, "current" mark, "Go back to this" on every other row, disabled by the same reason); `LiveReel.tsx` renders the form under the preview and the list under it, re-reads versions on the ready catch-up and once on each new `current_version_id`, and shows a job's request (quoted) or "go back to version N"; `src/lib/jobs.ts` adds `request` and `restore_version_id` to `JOB_COLUMNS`.
  - Worker: `apps/worker/src/process-job.ts` routes on `job.kind`; `change-job.ts` (`changeJob`) reads the current version, maps its `inputs` to step fingerprints with `fingerprintsFromInputs` (`steps/version-io.ts`) and calls `decide` with the request, so no fixed step runs and only a `decide` step row is written; errors `change: job has no request`, `change: no current version`. `steps/restore.ts`: the in-process step `restore` calls `restoreVersion` through the lease-guarded wrappers, line `restore: restored version N as version M`. `queue.ts`: `endJob`'s `reel` outcome may be `null`, and `finishJob`/`failJob` pass `null` for any kind but `process`, so a change or restore never moves `reels.status`.
  - Interim ordering rule: enforced in the UI (disabled box and buttons) and by the insert policy; slice 16 replaces both.
- How to Use: open a processed reel's page, type a change, "Send change", wait for the next version to appear; in Versions, "Go back to this" on an earlier one.
- Configuration: `E2E_MOCK_AI_SCRIPT` scripts `fixtures/decide/change-request.json` (a passing answer with a different `change_summary` and one accent fewer, so v3 differs from v2) and `fixtures/decide/fail-twice.json` (`[{ "output": { "change_summary": "broken" } }]`, fails the per-reel schema; the fake repeats it for round 2). Nothing new in `turbo.json` or env files.
- Testing: unit `apps/studio/src/lib/change-request.test.ts`, `apps/studio/src/lib/versions.test.ts`, `apps/worker/src/change-job.test.ts`, `apps/worker/src/steps/restore.test.ts`, `apps/worker/src/queue.test.ts`, `apps/worker/src/decide/fixture-answer.test.ts`; DB `apps/studio/db-tests/change-jobs.test.ts` (needs `supabase migration up --local`); E2E `apps/studio/e2e/change-requests.spec.ts` with its four tests (box disabled while a job runs; a change makes the next version current without a reload, running only decide; a double failure keeps the version and the reel; going back copies an old version and can be undone).
- Rules (one bullet each): History is never rewritten: a restore always makes a new version, nothing edits or deletes a version object or row. A failed change leaves the current version and the reel status as they were. The request text is stored on the job and the version, and is never sent to PostHog or logged (`studio_change_requested` carries `reel_id` and `app` only). Never poll: versions are read on open, on subscription ready and on a new `current_version_id`. A change job never runs a fixed step. Do not read `public.jobs` inside a policy on `public.jobs`; go through `reel_has_active_job`. Do not grant the owner insert on `jobs` beyond `(reel_id, kind, request, restore_version_id)`.
- Notes: the interim ordering rule is temporary (slice 16); `claim_job` still takes the oldest job globally.

### Step 2: Index line and the touched docs

- `docs/conditional-docs.md`: append, in the style of the last lines: "- `app_docs/change-requests.md`: read when changing the change box, the versions list or going back, the `change` and `restore` job kinds, `jobs.request` or `jobs.restore_version_id`, their checks, grant or insert policy, `reel_has_active_job`, the interim ordering rule, or `studio_change_requested`."
- `app_docs/measurement.md` events table (lines 89 to 93): add a row `studio_change_requested` | a change request is queued (`ChangeRequestForm.tsx`, after a `queued` answer) | `reel_id`, `app`; the reserved row becomes `studio_export_requested`, `studio_export_downloaded`.
- `app_docs/decide-step.md` How to Use step 4 (line 132): replace with "4. A change request passes the owner's words to `decide` as `request`, from the current version; see `app_docs/change-requests.md`."
- `app_docs/studio.md`, Jobs, steps and the lease (after the `20261031174750_job_queue.sql` bullet): add a bullet: `20261107090000_change_requests.sql` (and its two follow-ups) adds the kinds `change` and `restore`, the columns `request` and `restore_version_id` with their checks, the insert grant `(reel_id, kind, request, restore_version_id)` and the owner insert policy for a change or restore on an own processed reel with no active job (through `reel_has_active_job`); see `app_docs/change-requests.md`. Change "tables `jobs` (kind `process`," to "tables `jobs` (kind `process`, later also `change` and `restore`,".
- `app_docs/studio.md` Rules: after the `reels` insert rule add "Do not grant `authenticated` insert on `jobs` beyond `reel_id`, `kind`, `request` and `restore_version_id`, nor `update` or `delete`; job status, lease and attempts stay the worker's."

### Step 3: ADW profile Review (`.adw/project.md`)

- Review, the Studio bullet (line 279): after "with the live preview player, playing and after a seek showing the \"Loading\" hold" add ", then the same page's change box under the preview and its versions list". Keep "each at 1920x1080 and 375x667" and the sign-in sentence as they are.
- Change no heading, no heading order, no other section.

### Step 4: Format and checks

- Run `yarn format` (Prettier realigns the measurement table), then the em-dash grep below; fix anything it prints.

## Validation

- `grep -n -P "\x{2014}" app_docs/change-requests.md docs/conditional-docs.md app_docs/measurement.md app_docs/decide-step.md app_docs/studio.md .adw/project.md specs/patch/patch-adw-7812d494-change-requests-docs-and-profile.md` prints nothing.
- `grep "^## " .adw/project.md` lists Identity, Workspaces, Install, Build, Tests, Ports, Protected, Documentation, Review in that order (nine lines).
- `grep -n "change-requests.md" docs/conditional-docs.md app_docs/decide-step.md app_docs/studio.md` prints a line in each; `grep -n "reserved" app_docs/measurement.md` no longer names `studio_change_requested`; `grep -n "^## Rules" app_docs/change-requests.md` prints one line.
- `yarn format:check`
- `yarn knip`

## Patch Scope

**Lines of code to change:** about 120 lines of documentation (about 95 new in `app_docs/change-requests.md`, about 25 across the index, three docs and the profile), no code.
**Risk level:** low
**Testing required:** formatting, the em-dash grep and the heading check; no test runs needed since no code changes.
