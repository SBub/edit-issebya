# Bug: future-dated pipeline_steps migration sorts after every new migration

## Metadata

issue_number: `65`
adw_id: `65eeae69`
issue_json: `{"number":65,"title":"fix: rename the future-dated pipeline_steps migration and fail CI on future-dated migrations"}`

## Bug Description

`<OLD>` below stands for the old version, `20261102` followed by `090000` (2026-11-02 09:00 UTC).
It is never written as one string in this plan or in any new file, so the issue's
`grep -rn` check on it prints nothing. Shell commands spell it `"20261102""090000"`.

`supabase/migrations/<OLD>_pipeline_steps.sql` (from #29, PR #52, merged 2026-11-01
10:54 UTC) carries a future version: it was written on 2026-11-01 but names 2026-11-02 09:00 UTC.
Supabase applies migrations in filename (version) order, so every migration created now with
`supabase migration new` (which stamps the current UTC time) sorts before it and is applied first.

Actual: run `fe4e42f4` (#30) added `20261101115144_pipeline_steps_part_two.sql`, which widens
`reels_status_check`. On reset the later-sorting `<OLD>_pipeline_steps.sql` then drops and
re-adds the constraint with the old eight statuses, so `yarn turbo run test:db --filter=./apps/studio`
fails on `pipeline-statuses.test.ts > accepts each step's reel status` with
`new row for relation "reels" violates check constraint "reels_status_check"`. Review blocked it
three times. Every slice that adds a migration before 2026-11-02 09:00 UTC hits the same wall.

Expected: migrations apply in the order they were written; a correctly stamped new migration
always sorts after every existing one, and nothing lets a future-dated version reach `develop`.

## Problem Statement

1. One committed migration has a version later than the current time, breaking ordering for every
   migration created before that time.
2. The "never future-date a version" rule (`AGENTS.md`, `.adw/project.md` Protected,
   `app_docs/adw-supabase-stack.md` Rules) is enforced by nothing, so it was broken silently and
   can be broken again. Duplicate versions are likewise unchecked.

## Solution Statement

1. `git mv` the file to `supabase/migrations/20261101100000_pipeline_steps.sql` (content
   unchanged). It sorts after `20261101090000_step_measurements.sql` (its dependency) and before
   anything created from now on (now is after 2026-11-01 10:54 UTC). The hosted project has never
   been linked or pushed, so no remote history records the old version; the ADW stack is simply
   reset; CI builds a fresh stack each run.
2. Update every textual reference to `<OLD>` (one app doc, two specs).
3. Add a Vitest unit guard in the studio workspace (the workspace that owns the migrations in
   `app_docs/studio.md`): a pure checker `checkMigrationVersions(fileNames, now)` plus a test that
   runs it over the real `supabase/migrations/*.sql` against the current time. It fails, naming the
   file, when a version is later than now plus 10 minutes, when two files share a version, or when
   a `.sql` file lacks a 14-digit prefix. It runs under `yarn test`, hence the pre-push hook and
   CI's unit step.
4. Make turbo's cache for `@edit-issebya/studio#test` depend on `supabase/migrations/**`
   (`$TURBO_ROOT$/supabase/migrations/**` in `inputs`). Without it a new or renamed migration at the
   repository root would not invalidate the cached studio test, and the guard would be replayed as
   a stale pass locally and in CI (CI restores `.turbo/cache`).
5. State the guard in the docs where the migration rule lives.

## Steps to Reproduce

1. `ls supabase/migrations`: `<OLD>_pipeline_steps.sql` is listed while the current UTC
   time is 2026-11-01.
2. On a scratch branch (never committed), create a migration with `supabase migration new probe`
   (it gets a `20261101hhmmss` version), put `select 1;` in it and observe `ls` sorts it before
   `<OLD>_pipeline_steps.sql`; with run `fe4e42f4`'s part-two migration in place,
   `ADW_ID=<run> .adw/supabase-stack reset` then `yarn turbo run test:db --filter=./apps/studio`
   fails on `reels_status_check`. Delete the probe afterwards.
3. Before the fix there is no check: `yarn turbo run test --filter=./apps/studio` passes with the
   future-dated file present.

## Root Cause Analysis

The #29 plan hand-picked the version `<OLD>` instead of creating the file with
`supabase migration new`, so it encodes a time a day ahead of when it was written. Supabase orders
strictly by version, so any later-written but earlier-stamped migration is applied before it, and
its `drop constraint ... add constraint` on `reels_status_check` silently reverts the newer
migration's widening. The repository rule forbidding future-dated versions is prose only: no
hook, unit test or CI step parses the versions, so the mistake merged unnoticed. The #62 plan
noted the problem and left "a CI or lefthook version check" out of scope.

## Relevant Files

Use these files to fix the bug:

- `README.md`: repository overview (read first).
- `AGENTS.md`: the migration rule (`supabase migration new`, never future-date); gets one sentence
  about the guard.
- `.adw/project.md`: ADW profile; Protected has the migration rule and Tests lists the unit layer.
  Add the guard there; keep the nine `##` headings unchanged.
- `docs/conditional-docs.md`: index; `app_docs/studio.md` (migrations, studio tests) and
  `app_docs/adw-supabase-stack.md` (how runs apply migrations) match this task; `app_docs/pipeline.md`
  references the renamed file.
- `app_docs/studio.md`: feature doc owning migrations and the studio's tests; Testing and Rules
  sections get the guard.
- `app_docs/adw-supabase-stack.md`: Rules line "Never hand-pick, copy, future-date or reuse a
  migration version" gets a pointer to the guard.
- `app_docs/pipeline.md`: line 58 references `<OLD>_pipeline_steps.sql`.
- `specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md`: lines 154 and 233
  reference the old version.
- `specs/issue-62-adw-518dc931-sdlc_planner-adw-own-supabase-stack.md`: line 416 references the
  old version.
- `supabase/migrations/<OLD>_pipeline_steps.sql`: the file to rename (content unchanged).
- `supabase/migrations/20261101090000_step_measurements.sql`: must still sort before the renamed file.
- `apps/studio/vitest.config.ts`: unit include globs (`src/**/*.test.ts`,
  `test-support/**/*.test.ts`); the new test lands under `test-support/`, so no config change.
- `apps/studio/test-support/local-supabase.test.ts`: style model for a test-support unit test.
- `turbo.json`: add a `@edit-issebya/studio#test` entry whose `inputs` include the root
  migrations folder.
- `knip.json`: `apps/studio` project already covers `test-support/**/*.ts`; no change expected.
- `apps/studio/db-tests/pipeline-statuses.test.ts`: the DB test that failed in run `fe4e42f4`;
  must stay green after the reset.
- `lefthook.yml`, `.github/workflows/ci.yml`: confirm `yarn test` runs on push and in CI (no change).

### New Files

- `apps/studio/test-support/migration-versions.ts`: pure `checkMigrationVersions(fileNames: string[], now: Date): string[]`
  returning one human-readable problem per offending file (empty array when clean), and
  `MIGRATION_CLOCK_SKEW_MS = 10 * 60 * 1000`.
- `apps/studio/test-support/migration-versions.test.ts`: unit cases for the checker plus the
  guard over the real `supabase/migrations` directory.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Rename the migration

- `git mv "supabase/migrations/20261102""090000_pipeline_steps.sql" supabase/migrations/20261101100000_pipeline_steps.sql`.
- Do not change its SQL. Confirm with `git diff --cached -M --stat` that it is a 100% rename.
- `ls supabase/migrations` must list, in order: `20261031105245_studio_skeleton.sql`,
  `20261031174750_job_queue.sql`, `20261101090000_step_measurements.sql`,
  `20261101100000_pipeline_steps.sql`.

### 2. Update every reference to the old version

- `app_docs/pipeline.md` line 58: `<OLD>_pipeline_steps.sql` to `20261101100000_pipeline_steps.sql`.
- `specs/issue-29-adw-4a47b364-sdlc_planner-pipeline-convert-transcribe-retime.md` lines 154 and 233:
  same replacement.
- `specs/issue-62-adw-518dc931-sdlc_planner-adw-own-supabase-stack.md` line 416: same replacement
  (the sentence about "renumbering the future-dated versions" may stay as history).
- `grep -rn "20261102""090000" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.turbo --exclude-dir=.next --exclude-dir=agents`
  prints nothing. This plan never spells the old version as one string, and no new file (test,
  doc) may either, so the issue's literal `grep` stays empty.

### 3. Write the pure checker `apps/studio/test-support/migration-versions.ts`

- Export `MIGRATION_CLOCK_SKEW_MS = 10 * 60 * 1000` and
  `checkMigrationVersions(fileNames: readonly string[], now: Date): string[]`.
- For each name ending in `.sql`:
  - Match `/^(\d{14})_.+\.sql$/`. No match: problem `"<name>: no 14-digit UTC version prefix"`.
  - Parse `YYYYMMDDHHMMSS` as UTC with `Date.UTC(y, mo - 1, d, h, mi, s)`; reject impossible dates
    (round-trip check: the formatted UTC parts must equal the input), problem
    `"<name>: <version> is not a valid UTC timestamp"`.
  - If the parsed time is greater than `now.getTime() + MIGRATION_CLOCK_SKEW_MS`, problem
    `"<name>: version <version> is in the future (now <now ISO>); create migrations with supabase migration new"`.
  - Collect versions in a `Map<string, string[]>`; for any version with two or more files, problem
    `"<version> is used by <a>, <b>"` (names sorted).
- Ignore non-`.sql` entries (e.g. `.gitkeep`).
- Plain functions, no classes, no decorators, no em-dashes.

### 4. Write the test `apps/studio/test-support/migration-versions.test.ts`

- Unit cases with a fixed `now = new Date("2026-11-01T12:00:00Z")`:
  - Clean list (the four real names after the rename) returns `[]`.
  - `20991231000000_probe.sql` returns one problem whose text contains that file name and "future".
  - A version 9 minutes ahead of `now` passes; 11 minutes ahead fails (the skew boundary).
  - Two files `20261101090000_a.sql`, `20261101090000_b.sql` return one problem naming both.
  - `probe.sql` and `20261301000000_bad.sql` are reported (no prefix, invalid date).
  - `.gitkeep` is ignored.
  - A pre-fix-shaped list whose last file is a day ahead of `now` (use
    `20261102120000_pipeline_steps.sql`, deliberately not the old version string so the grep check
    stays empty) reports it. This mirrors the unfixed tree.
- The repository guard: resolve the directory with
  `new URL("../../../supabase/migrations/", import.meta.url)`, read it with `readdirSync`, and
  `expect(checkMigrationVersions(names, new Date())).toEqual([])` so the failure message lists each
  offending file. Also assert at least one `.sql` file was read, so a wrong path cannot pass vacuously.

### 5. Make turbo re-run the studio unit test when migrations change

- In `turbo.json` add, alongside the other workspace-specific tasks:
  ```json
  "@edit-issebya/studio#test": {
    "outputs": [],
    "inputs": ["$TURBO_DEFAULT$", "$TURBO_ROOT$/supabase/migrations/**"]
  }
  ```
- Check with `yarn turbo run test --filter=./apps/studio --dry=json` that the task's inputs list
  the migration files (or touch a probe migration and confirm the task is a cache miss).

### 6. Document the guard

- `AGENTS.md` (the migration bullet under Tooling): add one sentence: the studio unit test
  `apps/studio/test-support/migration-versions.test.ts` (run by `yarn test`, the pre-push hook and
  CI) fails on a version more than 10 minutes in the future or a version two files share.
- `.adw/project.md`: in Protected, append the same fact to the migration bullet; in Tests, add
  `apps/studio/test-support/migration-versions.test.ts` (the migration version guard) to the unit
  layer description. Do not rename, add or reorder any `##` heading.
- `app_docs/studio.md`: list the new test in Testing; in Rules add "Never future-date or reuse a
  migration version; `migration-versions.test.ts` enforces it."
- `app_docs/adw-supabase-stack.md`: extend the existing Rules line with "(enforced by
  `apps/studio/test-support/migration-versions.test.ts`)". The "reset to four migrations" note
  stays correct.
- No em-dashes anywhere.

### 7. No browser coverage

- This change touches migrations, a unit test, turbo config and docs. No page, component or
  rendered surface changes, so no E2E spec and no screenshots are warranted.

### 8. Reset the ADW stack and prove the order

- `.adw/supabase-stack reset` (the hook supplies `ADW_ID`; never any other `supabase` command,
  never the developer's stack). It must exit 0 and its verification must list the four versions
  including `20261101100000`.

### 9. Negative checks for the guard (never committed)

- `touch supabase/migrations/20991231000000_probe.sql`; `yarn turbo run test --filter=./apps/studio`
  must fail naming `20991231000000_probe.sql`. `rm` it.
- `cp supabase/migrations/20261101100000_pipeline_steps.sql supabase/migrations/20261101100000_dupe.sql`;
  the same command must fail naming both files. `rm` it.
- `git status --short supabase/` shows only the rename.

### 10. Run the Validation Commands

## Test Coverage

Unit layer (Vitest, `apps/studio/test-support/migration-versions.test.ts`, run by
`yarn turbo run test --filter=./apps/studio`): the repository guard fails against the unfixed tree
(`<OLD>_pipeline_steps.sql` is later than now plus 10 minutes on 2026-11-01) and passes
after the rename; it catches any future-dated or duplicate migration version before push and in
CI. The DB layer `pipeline-statuses.test.ts` (`yarn turbo run test:db --filter=./apps/studio`)
confirms the renamed migration still applies after `step_measurements` and the reel statuses hold.

## Validation Commands

Execute every command to validate the bug is fixed with zero regressions.

- Reproduction: write steps 3 and 4 before step 1 and run `yarn turbo run test --filter=./apps/studio`;
  the repository guard fails naming the 2026-11-02 09:00 `_pipeline_steps.sql` file. After step 1 it passes.
- `ls supabase/migrations`: four files, `20261101100000_pipeline_steps.sql` fourth, nothing future-dated.
- `git diff develop -M --stat -- supabase/migrations`: a pure rename, SQL unchanged.
- `grep -rn "20261102""090000" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.turbo --exclude-dir=.next --exclude-dir=agents`: prints nothing.
- `.adw/supabase-stack reset`: applies all migrations in order, exit 0.
- `yarn format:check`: Prettier over the repository (new TS, edited JSON and Markdown).
- `yarn turbo run lint --filter=./apps/studio`: ESLint on the new files.
- `yarn turbo run typecheck --filter=./apps/studio`: the new module and test typecheck.
- `yarn knip`: the new export is used by the test, nothing dead.
- `yarn turbo run test --filter=./apps/studio`: unit tests including the guard.
- `yarn test`: every workspace's unit tests (what the pre-push hook runs).
- `yarn turbo run test:db --filter=./apps/studio`: DB integration against the reset ADW stack, including `pipeline-statuses.test.ts`.
- `yarn build`: unfiltered build, since root files (`supabase/`, `turbo.json`) changed.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: E2E suites (run by the test phase) stay green against the reset stack.

## Notes

- No new dependency: `node:fs` and Vitest are enough.
- The 10-minute allowance covers clock skew between a developer's machine and CI; `supabase
migration new` stamps the current UTC time, so a correct migration is never ahead.
- The guard reads the clock at test time, so a version that was future-dated when pushed would
  start passing once its time arrives; that is acceptable because CI on the pull request fails
  first. The turbo `inputs` change keeps a cached pass from hiding a newly added bad file.
- Other open branches (e.g. run `fe4e42f4` for #30) must rebase onto this fix; their own
  migrations then sort after `20261101100000` as intended. Renumbering their files is out of scope.
- The hosted project has never been linked (`supabase migration list --linked`: "Cannot find
  project ref"); do not run that or any other `supabase` command beyond `.adw/supabase-stack reset`.
- Commit, e.g., `fix: rename the future-dated pipeline_steps migration and guard migration versions`,
  no trailers.
