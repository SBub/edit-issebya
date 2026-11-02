# Patch: confirm step 18 documentation is complete and unblock the review screenshots

## Metadata

adw_id: `119c12a9`
review_change_request: `run_defect: The review failed on this run's own gaps, not on the base. The plan's step 18 (documentation) is missing from the diff. The reviewer also captured no screenshots of the studio reel page this run changed, so the engine rejected its verdict. Make only documentation changes; leave all code alone, since every gate already passes.`

## Issue Summary

**Original Spec:** specs/issue-38-adw-119c12a9-sdlc_planner-reel-progress-notification-heartbeat.md
(step 18, lines 507 to 532)

**Issue:** The triage reports step 18 (Documentation) missing from the diff, plus no review
screenshots of the studio reel page.

**Finding while planning:** step 18 is already on this branch. Commit `f92c86e` ("feat: document
step progress, time left, notifications and heartbeat", from the earlier patch
`specs/patch/patch-adw-119c12a9-status-docs-and-profile.md`) added `app_docs/status.md` (194 lines)
and edited `docs/conditional-docs.md`, `app_docs/measurement.md`, `app_docs/export.md`,
`app_docs/storage.md`, `app_docs/pipeline.md` and `.adw/project.md`. The triage most likely read a
diff from before that commit. Every item in the request was checked against the committed text:

- `app_docs/status.md`: has Specifications, Overview, How it works, Rules and Notes (plus How to
  Use, Configuration and Testing, as in `app_docs/storage.md`). It covers the `@hf-progress` line,
  why remove-background runs through `remove-background-entry.ts`, the samples in
  `apps/worker/src/progress-testdata/`, the throttle (first value at once, one per 10 s, never
  lower, 100 at the end, nothing after a failure), `footage_seconds` from `retime.json`, the
  estimate (median of the last 10 `done` rows, `wall_ms / footage_seconds`, at least 3 rows or
  `no estimate yet`, one read per page open), the notification and title rules (permission only
  from the toggle click, `Ready: <reel>` when hidden, restored when visible), the heartbeat (`main`
  only, at start and every 5 minutes, never `once`), the offline display (11 minutes, one local
  timer, `Worker offline since HH:MM` under queued jobs), keep-awake (`caffeinate -i -w <pid>`, macOS
  only, around `processJob`), `E2E_MOCK_RENDER_SECONDS` and the three specs. The Rules section holds
  all seven rules and the Notes section all three notes.
- `docs/conditional-docs.md` line 21: the `status.md` line with every topic asked for.
- `app_docs/measurement.md` and `app_docs/export.md`: "progress and time left" is out of the
  out-of-scope Notes, and both point to `status.md`.
- `app_docs/storage.md` Notes: no longer defer the heartbeat to slice 15.
- `app_docs/pipeline.md`: the `remove_background` bullet names `remove-background-entry.ts`, with
  arguments, settings and HyperFrames version unchanged.
- `.adw/project.md` Tests: the three specs are in the studio E2E list, and the new columns are named
  (`steps.progress_percent` and `progress_updated_at`, `worker_status.heartbeat_at`). The nine `##`
  headings are unchanged. `reels.footage_seconds` is **not** named there yet, so Step 1 adds it.
- None of the changed files contains an em-dash.

**Solution:** A docs-only patch with a single edit, the missing `reels.footage_seconds` mention in
`.adw/project.md` Tests. No code, test, migration or config file is touched. The screenshot blocker
needs no file change: the re-run review captures them (Step 3).

## Files to Modify

- `.adw/project.md` (Tests section only: the DB-layer sentence)

## Implementation Steps

IMPORTANT: Execute every step in order, top to bottom.

### Step 1: Name `reels.footage_seconds` in the profile's Tests section

- In `.adw/project.md`, Tests, DB-layer paragraph, after the `pipeline-statuses.test.ts` clause
  ("for the pipeline's reel statuses and `cache_hit`"), add that the reel's `footage_seconds` column
  comes from the progress migration and is written once by the worker after `retime` (unit-tested in
  `apps/worker/src/pipeline/run-pipeline.test.ts`). Check
  `apps/studio/db-tests/*.test.ts` first (`grep -rn footage_seconds apps/studio/db-tests`): if a DB
  test does assert the column, name that file instead. Do not claim coverage that does not exist.
- Keep the nine `##` headings and their order unchanged. No em-dashes.

### Step 2: Re-check the step 18 docs against the request, and change nothing else

- Re-read `app_docs/status.md`, `docs/conditional-docs.md` line 21 and the diffs of
  `app_docs/measurement.md`, `app_docs/export.md`, `app_docs/storage.md` and `app_docs/pipeline.md`
  (`git diff origin/develop...HEAD -- app_docs docs .adw`) against the request's checklist (repeated
  under Issue Summary). Edit a file only if an item is actually missing; every item was present
  while this plan was written.
- Leave every file outside `app_docs/`, `docs/` and `.adw/project.md` alone.

### Step 3: Screenshots for the re-run review (no file change, done by the reviewer)

- Source `.ports.env`; with the `/prepare_app` server up, sign in by opening the URL printed by
  `PORT=$PORT yarn workspace @edit-issebya/studio e2e:sign-in-url`.
- With the admin client (the test helpers' local secret key, local hosts only), on the review
  user's (`studio-review@example.test`) reel, seed: a queued job, a running `render` step with a
  `progress_percent` (for example 42) and `progress_updated_at` now, and a `worker_status` row with
  its own review worker id and `heartbeat_at` 20 minutes old (keep `waiting_reason` null).
- With the Playwright MCP server, capture `/studio/reels/<id>` at 1920x1080 and 375x667, showing the
  percentage, the time left and `Worker offline since HH:MM`, into
  `agents/119c12a9/<agent_name>/review_img/`.
- Delete the seeded job, step and `worker_status` rows afterwards, even after a failure, so nothing
  claimable or stale is left. Never stage `agents/`.

## Validation

Execute every command to validate the patch is complete with zero regressions.

- `yarn format:check` - Prettier over the whole repository, including the edited Markdown.
- `yarn knip` - unchanged dead-code result (docs only).
- `git diff --name-only origin/develop...HEAD | xargs grep -nP "\x{2014}"` - prints nothing (no em-dashes).
- `grep -c "^## " .adw/project.md` - prints `9`, the headings unchanged.
- `git diff --stat HEAD` - only `.adw/project.md` (and any doc Step 2 had to fix) changed; no code.

## Patch Scope

**Lines of code to change:** 0 lines of code; about 1 to 3 lines of Markdown in `.adw/project.md`.
**Risk level:** low
**Testing required:** format check and knip; the re-run review captures the two reel-page
screenshots from seeded rows and then deletes them.
