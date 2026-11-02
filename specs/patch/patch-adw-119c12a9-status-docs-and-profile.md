# Patch: document progress, time left, notification, heartbeat and keep-awake (step 18)

## Metadata

adw_id: `119c12a9`
review_change_request: `run_defect: The review failed on this run's own gaps, not on the base. The plan's step 18 (documentation) is missing from the diff. The reviewer also captured no screenshots of the studio reel page this run changed, so the engine rejected its verdict. Make only documentation changes; leave all code alone, since every gate already passes.`

## Issue Summary

**Original Spec:** specs/issue-38-adw-119c12a9-sdlc_planner-reel-progress-notification-heartbeat.md
**Issue:** Step 18 (Documentation, spec lines 507 to 532) was never done: there is no
`app_docs/status.md`, no index line in `docs/conditional-docs.md`, the out-of-scope Notes in
`app_docs/measurement.md` and `app_docs/export.md` still list progress and time left,
`app_docs/storage.md` still defers the heartbeat to slice 15, `app_docs/pipeline.md` does not
mention `remove-background-entry.ts`, and `.adw/project.md` Tests omits the three new specs and the
new columns. The second blocker (no screenshots of the studio reel page) needs no file change: the
re-run review captures them (see Validation, last item).
**Solution:** Docs-only patch. Write `app_docs/status.md`, add its index line, and edit the five
existing docs and the profile exactly as step 18 describes. No code, test, migration or config file
is touched. Facts in the new doc are taken from the code already on this branch (read the files
named below before writing a sentence about them; do not invent behaviour).

## Files to Modify

Use these files to implement the patch:

- `app_docs/status.md` (new)
- `docs/conditional-docs.md`
- `app_docs/measurement.md` (line 153)
- `app_docs/export.md` (line 162)
- `app_docs/storage.md` (Notes, lines 165 to 168)
- `app_docs/pipeline.md` (the `remove-background.ts` bullet, lines 60 to 66)
- `.adw/project.md` (Tests section only)

Read-only sources for the facts (do not edit): `apps/worker/src/progress.ts`,
`apps/worker/src/progress-parsers.ts`, `apps/worker/src/progress-testdata/`,
`apps/worker/src/pipeline/remove-background-entry.ts`, `apps/worker/src/pipeline/remove-background.ts`,
`apps/worker/src/render/render-call.ts`, `apps/worker/src/render/fake-render.ts`,
`apps/worker/src/pipeline/run-pipeline.ts`, `apps/worker/src/pipeline/retime.ts`,
`apps/worker/src/heartbeat.ts`, `apps/worker/src/keep-awake.ts`, `apps/worker/src/main.ts`,
`apps/worker/src/once.ts`, `apps/worker/src/process-job.ts`, `apps/worker/src/disk-guard.ts`,
`apps/studio/src/lib/progress.ts`, `apps/studio/src/lib/ready-notice.ts`,
`apps/studio/src/lib/worker-offline.ts`, `apps/studio/src/lib/worker-status.ts`, the studio reel
page components the diff changed (`git diff --stat origin/develop...HEAD -- apps/studio`),
`supabase/migrations/20261102005505_progress_heartbeat.sql`, and
`apps/studio/e2e/progress.spec.ts`, `notification.spec.ts`, `worker-offline.spec.ts`.

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Create `app_docs/status.md`

- Same shape as `app_docs/storage.md`: `# Progress, time left, ready notification, worker heartbeat and keep-awake`,
  then `**Specifications:**` with the bullet
  `specs/issue-38-adw-119c12a9-sdlc_planner-reel-progress-notification-heartbeat.md`, then
  `## Overview`, `## How it works` (with `###` subsections), `## Rules`, `## Notes`. Add
  `## How to Use`, `## Configuration` and `## Testing` between them as storage.md does.
- How it works, one subsection each:
  - Progress parsing per tool: the `@hf-progress` line the parsers read (exact format from
    `progress-parsers.ts`); why `remove_background` runs through
    `apps/worker/src/pipeline/remove-background-entry.ts` (from that file's own comment); the
    committed samples in `apps/worker/src/progress-testdata/` and that `progress-parsers.test.ts`
    replays them.
  - The throttle (`progress.ts`): the first value is written at once, then at most one write per
    10 s per step, never a lower value, 100 at the end of a successful step, no write after a
    failure or a lost lease.
  - `reels.footage_seconds`, read from `retime.json` after retime (ran or cache hit).
  - Time left (`apps/studio/src/lib/progress.ts`): median of `wall_ms / footage_seconds` over the
    owner's last 10 `done` rows of the same step, times this reel's `footage_seconds`, minus the
    elapsed time; only with at least 3 earlier rows, otherwise `no estimate yet`; rows without
    `footage_seconds` excluded; never negative (`less than a minute left`); read once per page open.
  - Ready notification and title (`ready-notice.ts`): permission asked only from the Notify toggle
    click; while the tab is hidden and the reel reaches `processed` or a new export is recorded, a
    `Notification` is shown and the title becomes `Ready: <reel>`; the title is restored when the
    tab becomes visible; no toggle when the Notification API is missing.
  - Heartbeat (`heartbeat.ts`): written from `main` only (never from `once`), at start and every 5
    minutes, upserting `worker_status.heartbeat_at` without touching `waiting_reason`.
  - Offline display (`worker-offline.ts`): offline once the newest heartbeat is older than 11
    minutes, decided by one local timer (no database poll), `Worker offline since HH:MM` (local
    time) shown under queued jobs, updated live through Realtime.
  - Keep-awake (`keep-awake.ts`): `caffeinate -i -w <pid>` on macOS only, spawned around
    `processJob` and killed when the job ends, whatever the outcome.
- Configuration: `E2E_MOCK_RENDER_SECONDS` (the render double replays the committed render progress
  over that many seconds; read `render-call.ts` and `fake-render.ts` for the default).
- Testing: the unit tests named in the spec's Testing Strategy, the DB column checks, and the three
  specs `apps/studio/e2e/progress.spec.ts`, `notification.spec.ts`, `worker-offline.spec.ts`, one
  line each on what it proves.
- Rules (each an invariant):
  - Never more than one progress write per 10 s per step.
  - Progress only for `remove_background` and `render`.
  - Never poll the database from the studio for progress, heartbeat or offline (Realtime and local
    timers only).
  - Never ask for notification permission except from a click.
  - No notification service; nothing works with the tab closed.
  - Never write a heartbeat from `once`.
  - Never let the heartbeat clear `waiting_reason`.
- Notes:
  - Estimates are wrong for the first reels (warm-up, few rows).
  - Not verified by the pipeline: real macOS notifications, real sleep and wake, estimate quality.
  - Owner steps: apply `supabase/migrations/20261102005505_progress_heartbeat.sql` to the hosted
    project after merge, and do the manual acceptance.
- No em-dashes; wrap at about 100 columns like the other docs.

### Step 2: Index line in `docs/conditional-docs.md`

- Append after the `app_docs/storage.md` line:
  `- Read \`app_docs/status.md\` when changing step progress (\`steps.progress_percent\`, the parsers or the throttle), the time-left estimate or \`reels.footage_seconds\`, the ready notification and \`Ready: <reel>\` title, \`worker_status.heartbeat_at\` and the \`Worker offline since\` line, keep-awake (\`caffeinate\`), or \`E2E_MOCK_RENDER_SECONDS\`.`

### Step 3: Update the four existing feature docs

- `app_docs/measurement.md` line 153: drop "progress and time left" from the out-of-scope list and
  add a sentence: step progress and time left are in `app_docs/status.md`.
- `app_docs/export.md` line 162: replace "render progress and time left" with a pointer
  (`Render progress and time left: see app_docs/status.md.`), keeping "Out of scope: cloud
  rendering."
- `app_docs/storage.md` Notes: the slimming bullet keeps the cross-worker rule as future work but
  stops calling it "the heartbeat slice (15)"; the stale-rows bullet says the heartbeat
  (`heartbeat_at`, every 5 minutes from `main`) and the offline display now exist, see
  `app_docs/status.md`, and stale rows still stay until that worker writes again.
- `app_docs/pipeline.md` `remove-background.ts` bullet: add that the step now runs HyperFrames
  through `apps/worker/src/pipeline/remove-background-entry.ts` (so it can print progress, see
  `app_docs/status.md`) with the same arguments, settings and HyperFrames version, so its
  fingerprint and cache hits are unchanged.

### Step 4: `.adw/project.md` Tests section

- In the studio E2E list, after `disk-guard.spec.ts ...`, add: `progress.spec.ts` (a render job
  with `E2E_MOCK_RENDER_SECONDS` shows its percentage live and reaches 100),
  `notification.spec.ts` (a hidden tab gets the notification spy call and the `Ready: <reel>`
  title, restored on visible; none while visible), `worker-offline.spec.ts` (a 20-minute-old
  `heartbeat_at` shows `Worker offline since HH:MM` under a queued job live, a fresh one clears it).
- In the DB layer list: `steps-measurements.test.ts` also covers `steps.progress_percent` and
  `progress_updated_at`; `stored-files.test.ts` also covers `worker_status.heartbeat_at` (and that
  the heartbeat upsert leaves `waiting_reason`); mention `reels.footage_seconds` where the reels
  columns are checked (match what the DB tests on this branch actually assert).
- Touch nothing outside the Tests section; the nine `##` headings stay exactly as they are.

## Validation

Execute every command to validate the patch is complete with zero regressions.

1. `git diff --stat` lists only the seven files above (plus this patch plan); no file under
   `apps/`, `packages/` or `supabase/` changed.
2. `grep -nP '\x{2014}' app_docs/status.md app_docs/measurement.md app_docs/export.md app_docs/storage.md app_docs/pipeline.md docs/conditional-docs.md .adw/project.md` prints nothing.
3. `grep -c "^## " .adw/project.md` prints `9`.
4. `yarn format:check` (run `yarn format` first if it reports the new doc) and `yarn knip`, both
   from the root; both pass.
5. Re-run review evidence (no file change): sign in with
   `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`, seed on the review user's reel
   a running `render` step with `progress_percent` set and a queued job, plus a `worker_status` row
   with `heartbeat_at` 20 minutes old; capture `/studio/reels/<id>` at 1920x1080 and 375x667 with
   the Playwright MCP server into `agents/119c12a9/<agent>/review_img/`; then delete the seeded
   rows.

## Patch Scope

**Lines of code to change:** about 180 lines of Markdown (about 150 new in `status.md`, about 30 edited elsewhere); 0 lines of code
**Risk level:** low
**Testing required:** format check and knip only (docs-only change); the review re-run captures the studio reel page screenshots
