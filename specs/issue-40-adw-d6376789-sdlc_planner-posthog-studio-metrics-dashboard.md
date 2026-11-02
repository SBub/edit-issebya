# Feature: PostHog dashboard for the studio metrics, funnel and storage, defined in code

## Metadata

issue_number: `40`
adw_id: `d6376789`
issue_json: `{"number":40,"title":"feat: PostHog dashboard for the studio metrics, funnel and storage, defined in code"}`

## Feature Description

One PostHog dashboard (project 312096, EU host) answers the reel studio MVP's question: does the
studio turn a two-hour edit into a short one, and what does each reel cost to make. It shows the
main metric (upload to export, target under 30 minutes) per reel with its 30-minute line and the
current streak of reels under 30 minutes (rollout target: 7), time to the first preview (target
under 15 minutes), change requests per exported reel, completion by week, cost per reel and per
step (raw seconds, CPU seconds, bytes, peak memory and the AI cost Claude Code reports, never
money derived from machine time), failed steps by step name and week, the five-event studio funnel
by reel, storage per reel, per step and in total, the cache hit rate, a text card linking to the
Supabase usage page and a text card saying where the preview-matches-export guardrail is checked.

Everything that can live in code does:

1. A migration that gives every table PostHog will sync (`reels`, `jobs`, `steps`, `versions`,
   `exports`, `stored_files`) a uniform `updated_at timestamptz not null default now()` maintained
   by the existing `public.set_updated_at()` trigger function on every update, so the PostHog
   Postgres source can sync incrementally (rule B3.5).
2. The insight and dashboard definitions in TypeScript (one module per insight), each insight a
   HogQL query over the synced tables (the funnel is a `FunnelsQuery` over the studio events).
3. A script (Node 24 runs the TypeScript) with `--dry-run` (default, prints the exact API payloads)
   and `--apply` (creates or updates the insights and the dashboard idempotently through the
   PostHog API, reading `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` from the owner's shell).

Connecting PostHog to the database, creating the key and running `--apply` are manual owner steps.

## User Story

As the studio's owner
I want one PostHog dashboard, defined and versioned in the repository, that shows upload-to-export
time per reel, the streak under 30 minutes, cost per reel, failures, the funnel and storage
So that I know whether the studio turns a two-hour edit into a short one, what each reel costs, and
when the main metric has held for seven reels in a row so invited founders can come in

## Problem Statement

The studio records everything the MVP metrics need (jobs, steps with measurements and AI cost,
versions, exports, stored files, five `studio_*` events), but nothing turns it into numbers. A
dashboard clicked together by hand drifts, cannot be reviewed and breaks silently when a column or
event is renamed. PostHog's Postgres source can only sync incrementally when every synced table has
a reliable change column; today only `reels` has an `updated_at` with a trigger, `jobs`, `steps`,
`versions`, `exports` and `stored_files` have none, so a status change, a step's measurements or a
stored file's deletion would never reach PostHog without a full resync.

## Solution Statement

- **Sync columns.** One new migration (created with `supabase migration new posthog_sync_columns`)
  adds `updated_at timestamptz not null default now()` to `jobs`, `steps`, `versions`, `exports`
  and `stored_files` (`reels` already has it) and a `before update ... for each row execute
function public.set_updated_at()` trigger named `<table>_set_updated_at` on each of the five
  (`reels_set_updated_at` exists). Existing rows get `now()` at migration time via the default.
  Trigger order is alphabetical, so on `versions`, `exports` and `stored_files` the existing
  `*_refuse_update` trigger still runs first: versions and exports stay immutable (their
  `updated_at` is the insert time forever), and the only allowed `stored_files` update, recording
  `deleted_at`, now also moves `updated_at` (the storage charts need deletions to sync).
  `stored_files_refuse_update` compares named columns only, so the trigger setting `updated_at`
  never trips it. `worker_status` is not synced (no metric reads it, and its heartbeat would churn
  the sync) and is left unchanged.
- **Where the code lives.** `apps/studio/scripts/posthog-dashboard/`, not a new root folder: the
  root has no TypeScript, lint, typecheck or Vitest tooling, while the studio workspace already has
  all four, `pg`, the DB-test layer and the event-name constants. A package under `packages/` is
  not warranted (one consumer). Run as
  `yarn workspace @edit-issebya/studio posthog:dashboard [--apply]` (script:
  `node scripts/posthog-dashboard/main.ts`). Node 24 strips types, so: explicit `.ts` import
  extensions, no enums, no parameter properties, no namespaces.
- **Event names.** Move `STUDIO_EVENTS` and `StudioEvent` from `src/lib/track.ts` into a new
  dependency-free `src/lib/studio-events.ts` (track.ts imports it; the names and values do not
  change), so the script imports the constants without loading `posthog-js`.
- **Sources (the doc states each and why).** The database is the source of truth (A1), and studio
  events are absent wherever PostHog is not initialised (development, automation, a blocked
  browser), so every metric except the funnel reads the synced tables:
  - Upload time of a reel: the earliest `jobs.created_at` with `kind = 'process'` (inserted by
    `finish_upload` in the same statement that marks the upload complete; a Retry job is later, so
    `min` is the upload).
  - Export time: the earliest `exports.created_at` of the reel (the moment the first exported file
    exists, so the main metric includes the render, by the clock).
  - First preview ready: the earliest `versions.created_at` (version 1, saved by `first_version`;
    the player shows a reel only once a version exists).
  - Change requests: `jobs` rows with `kind = 'change'` created before the reel's first export.
  - The funnel alone reads the five `studio_*` events, ordered, aggregated by
    `properties.reel_id`.
- **One SQL text, two dialects.** Each HogQL insight is built by a function
  `build(dialect, tables)` that returns SQL in a subset both ClickHouse-flavoured HogQL and
  Postgres accept (CTEs, `case when`, window functions, `coalesce`, `* 1.0` before a division,
  `sum(case ...)` instead of `countIf`), with the few dialect-specific pieces taken from a small
  `Dialect` object: `minutesBetween(a, b)` (HogQL `dateDiff('second', a, b) / 60.0`, Postgres
  `extract(epoch from (b - a)) / 60.0`) and `weekOf(ts)` (HogQL `toStartOfWeek(ts, 1)`, Postgres
  `date_trunc('week', ts)`), plus `tables(name)` giving the table reference (`${TABLE_PREFIX}name`
  for PostHog, a test schema for Postgres). The payload uses the HogQL dialect; the metric-logic DB
  test runs the Postgres rendering of the same query against seeded local rows. This is the plan's
  offline evaluation (issue Verification 5).
- **Table prefix.** One constant `TABLE_PREFIX = "supabase_"` in `config.ts`, the whole string
  PostHog puts before a synced table's name; the manual step says to read the real names in
  PostHog's SQL editor after connecting the source and change the constant if they differ.
- **Every column qualified.** Queries alias each synced table by its bare name (`... as steps`) and
  qualify every column (`steps.wall_ms`), so a test can extract `(table, column)` pairs with a
  regular expression and check them against the local database.
- **Idempotent apply.** Each insight has a fixed key and a fixed name (`Studio: <title>`); the
  dashboard is `Studio MVP metrics`. Every object carries the tag `studio-metrics` and a
  description ending in a marker line `[studio-metrics:<key>]`. Apply lists the project's
  dashboards and insights (following pagination), matches by marker (falling back to exact name),
  PATCHes a match and POSTs only what is missing, then sets the dashboard's tiles and layout and
  the two text cards. A second run with the same API state creates nothing. Matching never relies
  on tags alone (tagging can be a paid feature).
- **No secrets.** The key and project id come only from `process.env`; the script never reads a
  file, `--dry-run` needs neither (it prints `<POSTHOG_PROJECT_ID>` in paths), and `--apply` refuses
  to start without both. The two names are documented in `app_docs/dashboard.md` and as empty
  placeholders in the root `.env.example`; they are not added to any studio or worker env file or
  to `turbo.json` (the script is run by `yarn workspace`, never through turbo).

## Relevant Files

Use these files to implement the feature:

- `README.md`: repository overview; may gain one link to the new doc (no feature description).
- `AGENTS.md`: rules (Yarn only, migrations via `supabase migration new`, no em-dashes, no `.env`).
- `.adw/project.md`: the ADW profile. Its Tests section lists the unit and DB test files; it must
  name the new unit tests under `apps/studio/scripts/**` and the new DB tests, in the same change.
- `docs/conditional-docs.md`: index; gains one line for `app_docs/dashboard.md`.
- `app_docs/measurement.md`: the `studio_*` events table, the rule that step measurements are never
  sent as events and that events are never renamed; the event constants move here is described.
- `app_docs/studio.md`: the `reels`, `jobs`, `steps` tables and their migrations and DB tests.
- `app_docs/storage.md`: `stored_files` semantics (per-reel rows, distinct live keys for the total,
  the update trigger that allows only `deleted_at`); gains a line on `updated_at`.
- `app_docs/export.md`: `exports` immutability and the preview-matches-export guardrail
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`, `yarn workspace @edit-issebya/studio
test:tools`), which the guardrail text card points to.
- `app_docs/edit-model.md`: `versions` immutability (`versions_refuse_update`).
- `app_docs/failures.md`: job and step statuses (`waiting_ai`, `waiting`, `skipped`), Retry jobs.
- `app_docs/analytics.md`: PostHog project facts shared with the landing page.
- `supabase/migrations/20261031105245_studio_skeleton.sql`: `public.set_updated_at()` and
  `reels_set_updated_at`, the function and pattern to reuse.
- `supabase/migrations/20261031174750_job_queue.sql`, `20261101090000_step_measurements.sql`,
  `20261101100000_pipeline_steps.sql`, `20261101153653_versions.sql`,
  `20261101184843_change_restore_jobs.sql`, `20261101194557_export_render_jobs.sql`,
  `20261101233625_storage_records.sql`, `20261102040716_failures_and_footage_checks.sql`: the
  columns, statuses, kinds and refuse-update triggers the queries and the migration depend on.
- `apps/studio/src/lib/track.ts`: `STUDIO_EVENTS`, moved to `studio-events.ts`.
- `apps/studio/package.json`: gains the `posthog:dashboard` script.
- `apps/studio/vitest.config.ts`: include `scripts/**/*.test.ts` in the unit layer.
- `apps/studio/vitest.db.config.ts`: the DB layer config the two new DB tests run under.
- `apps/studio/eslint.config.mjs`: security rules the script must satisfy.
- `apps/studio/tsconfig.json`: `allowImportingTsExtensions`; includes `**/*.ts`.
- `apps/studio/test-support/local-supabase.ts`: `localDbUrl()` (refuses a non-local host).
- `apps/studio/test-support/fixtures.ts`: `createTestUser`, `deleteTestUser`, `insertReel`.
- `apps/studio/db-tests/steps-measurements.test.ts`: exact `steps` column set, gains `updated_at`.
- `apps/studio/db-tests/stored-files.test.ts`: exact `stored_files` column set, gains `updated_at`.
- `apps/studio/db-tests/exports.test.ts`, `versions.test.ts`: immutability tests that must keep
  passing with the new trigger.
- `knip.json`: the studio workspace's `entry` must include the script's entry file.
- `.env.example` (root): gains the two placeholder names.
- `apps/studio/scripts/e2e-sign-in-url.ts`: the existing studio script, the style to follow.

### New Files

- `supabase/migrations/<stamp>_posthog_sync_columns.sql`: the sync columns and triggers.
- `apps/studio/src/lib/studio-events.ts`: `STUDIO_EVENTS`, `StudioEvent` (moved, unchanged).
- `apps/studio/scripts/posthog-dashboard/config.ts`: `TABLE_PREFIX`, `POSTHOG_HOST`
  (`https://eu.posthog.com`), `DEFAULT_PROJECT_ID` placeholder text, `TAG`, `DASHBOARD_NAME`,
  `SYNCED_TABLES` (`reels`, `jobs`, `steps`, `versions`, `exports`, `stored_files`),
  `SUPABASE_USAGE_URL`, `GUARDRAIL_TEXT`, the goal constants (`MAIN_METRIC_MINUTES = 30`,
  `FIRST_PREVIEW_MINUTES = 15`, `STREAK_TARGET = 7`).
- `apps/studio/scripts/posthog-dashboard/dialect.ts`: `Dialect` type, `hogql` and `postgres`.
- `apps/studio/scripts/posthog-dashboard/insights/*.ts`: one module per insight (list below), each
  exporting `{ key, name, description, build(dialect, table) }` or, for the funnel, a fixed query.
- `apps/studio/scripts/posthog-dashboard/insights/index.ts`: the ordered list.
- `apps/studio/scripts/posthog-dashboard/payloads.ts`: turns definitions into the exact API
  bodies (insight body, dashboard body, tiles and layouts, text cards).
- `apps/studio/scripts/posthog-dashboard/apply.ts`: `applyDashboard(client, projectId)`, the
  idempotent create-or-update over an injected `HttpClient` interface.
- `apps/studio/scripts/posthog-dashboard/http.ts`: the real `fetch`-based `HttpClient`
  (Bearer key, JSON, pagination through `next`, throws on non-2xx with status and body).
- `apps/studio/scripts/posthog-dashboard/main.ts`: argument parsing, `--dry-run` printing, `--apply`.
- `apps/studio/scripts/posthog-dashboard/sql-references.ts`: extracts `(table, column)` pairs and
  event names from rendered SQL (used by tests only, so knip may need it as a test import; it is).
- `apps/studio/scripts/posthog-dashboard/dry-run.test.ts`: snapshot test (unit).
- `apps/studio/scripts/posthog-dashboard/apply.test.ts`: idempotency with a fake HTTP client (unit).
- `apps/studio/scripts/posthog-dashboard/__snapshots__/dry-run.test.ts.snap`: committed snapshot.
- `apps/studio/db-tests/sync-columns.test.ts`: the `updated_at` column and trigger per synced table.
- `apps/studio/db-tests/dashboard-queries.test.ts`: real columns and events, and metric logic.
- `app_docs/dashboard.md`: the feature doc.

## Implementation Plan

### Phase 1: Foundation

- The migration, then `.adw/supabase-stack reset` so the ADW stack has it (the profile's Protected
  section allows only that and `supabase migration new`; the issue's `supabase migration up --local`
  is a `supabase` command the profile forbids agents to run, and the profile wins). If the reset
  fails, report its error and stop.
- Update the two exact-column-set DB tests.
- Move the event constants to a dependency-free module.

### Phase 2: Core Implementation

- Read the PostHog API docs before writing payloads (do not guess field names): the insights
  endpoint (`/api/projects/{project_id}/insights/` or the newer `/api/environments/{id}/insights/`,
  whichever the current docs name for project 312096), the dashboards endpoint, the `query` shape of
  an insight (`DataVisualizationNode` with a `HogQLQuery` source, its `display` and
  `chartSettings.goalLines`; `InsightVizNode` with a `FunnelsQuery`, its `series` of `EventsNode`
  and `funnelsFilter.funnelAggregateByHogQL`), how an insight is attached to a dashboard
  (`dashboards: [id]` on the insight), how text cards are added (dashboard `tiles` with `text.body`)
  and how tile `layouts` are set. Record the doc URLs read in `app_docs/dashboard.md`.
- Write the dialect, config and insight modules; the payload builder; the apply logic; the CLI.

### Phase 3: Integration

- Unit tests (snapshot, fake-HTTP idempotency) in `yarn test`; DB tests (sync columns, query
  references, metric logic) in `test:db`.
- Docs, index, profile, root `.env.example`, knip entry.

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

### 1. Create the sync-columns migration

- Run `supabase migration new posthog_sync_columns` from the repository root (the only `supabase`
  command allowed besides the stack reset; it only writes a file).
- Contents (header comment explaining rule B3.5, incremental sync, that `reels` already has the
  column and trigger, why `worker_status` is not synced, and that the refuse-update triggers run
  first by name):
  - `alter table public.<t> add column updated_at timestamptz not null default now();` for `jobs`,
    `steps`, `versions`, `exports`, `stored_files`.
  - `create trigger <t>_set_updated_at before update on public.<t> for each row execute function
public.set_updated_at();` for the same five.
  - No grant changes: `authenticated` has select on these tables already, and column-level insert
    grants on `jobs` do not need the new column (it takes its default).
- Run `.adw/supabase-stack reset`. If it fails, report the error and stop.

### 2. Update the exact column-set DB tests

- `apps/studio/db-tests/steps-measurements.test.ts`: add `["updated_at", "timestamp with time
zone"]` to `STEP_COLUMNS`.
- `apps/studio/db-tests/stored-files.test.ts`: add the same pair to `STORED_FILE_COLUMNS`.
- Grep `apps/studio/db-tests` for any other exact column list of `jobs`, `versions` or `exports`
  and update it the same way.

### 3. Write the sync-columns DB test (`apps/studio/db-tests/sync-columns.test.ts`)

- Import `SYNCED_TABLES` from `../scripts/posthog-dashboard/config.ts` (create `config.ts` now with
  at least `SYNCED_TABLES`).
- For each table in `SYNCED_TABLES` (via `pg` and `localDbUrl()`):
  - `information_schema.columns` has `updated_at`, `timestamp with time zone`, `is_nullable = 'NO'`,
    `column_default` `now()`.
  - `pg_trigger` joined with `pg_proc` has a non-internal trigger on `public.<t>` whose function is
    `public.set_updated_at` and which fires before update for each row (check `tgtype` bits or
    `pg_get_triggerdef` containing `BEFORE UPDATE` and `FOR EACH ROW`).
- Behaviour, on rows seeded for a fresh test user (`createTestUser`, `insertReel`, direct `pg`
  inserts as in the existing DB tests, cleaned up with `deleteTestUser`):
  - Insert sets `updated_at` (not null, within a minute of the database's `now()`).
  - Each update runs in its own autocommit statement after `select pg_sleep(0.02)`, since `now()`
    is the transaction's time: `reels` (`source_name`), `jobs` (`error_tail`), `steps`
    (`summary`), `stored_files` (`deleted_at` set from null) each get a later `updated_at`.
  - `versions` and `exports`: an update still raises `55000` and `updated_at` stays the insert
    value (immutability unchanged).
  - A separate assertion that the table list is exactly the six names, so a table added to the
    sync without a column fails here first.

### 4. Move the event constants

- Create `apps/studio/src/lib/studio-events.ts` with `STUDIO_EVENTS` (same five names, same order)
  and `StudioEvent`, and the existing comment that names are never renamed.
- `apps/studio/src/lib/track.ts` imports them from `./studio-events` and re-exports nothing it did
  not export before unless something imports it from track (grep `STUDIO_EVENTS` and `StudioEvent`
  first; update importers to the new module so knip sees no unused export).

### 5. Write `dialect.ts` and `config.ts`

- `Dialect = { name: "hogql" | "postgres"; minutesBetween(from: string, to: string): string;
weekOf(ts: string): string }`, the two implementations given in the Solution Statement.
- `config.ts`: the constants listed under New Files. `SUPABASE_USAGE_URL`: the studio project's
  Supabase usage page; use a clearly marked placeholder
  (`https://supabase.com/dashboard/project/<studio-project-ref>/settings/usage` style, verify the
  path in Supabase's docs) unless the repository already records the project ref, and say in the
  doc that manual step 4 replaces it. `GUARDRAIL_TEXT`: says the preview-matches-export guardrail is
  `apps/studio/e2e-tools/export-matches-preview.spec.ts`, run on the owner's Mac by
  `yarn workspace @edit-issebya/studio test:tools`, never in CI, and that its last run is the
  owner's terminal output (or wherever `app_docs/export.md` says its result is kept; read it).

### 6. Write one module per insight (`insights/`)

Each module exports `key`, `name` (`Studio: ...`), `description` (the definition in one or two
sentences plus the source), a `display` and optional goal line, and `build(d: Dialect, t:
(name) => string): string`. Every table is aliased by its bare name and every column qualified.
Shared CTE fragments (per-reel upload, first version, first export) live in `insights/common.ts`.

- `main-metric.ts`: per exported reel, `minutes = minutesBetween(upload, first export)`, ordered by
  first export; line or bar chart, goal line 30 (`MAIN_METRIC_MINUTES`).
- `main-metric-streak.ts`: the current streak: rank exported reels by first export descending;
  streak is the rank of the first reel with `minutes >= 30` minus one, or the count of exported
  reels when none is; a bold number, description says the target is 7 (`STREAK_TARGET`).
- `first-preview.ts`: per reel with a version, `minutesBetween(upload, first versions.created_at)`;
  goal line 15.
- `changes-per-reel.ts`: per exported reel, the count of `jobs.kind = 'change'` created before the
  first export, plotted against the week of the first export (average per week, plus the per-reel
  table in the description's definition).
- `completion.ts`: by `weekOf(upload)`: uploaded reels (with a `process` job), exported reels
  (with an export row), and their ratio (`exported * 1.0 / uploaded`).
- `cost-per-reel.ts`: per reel: `sum(steps.wall_ms) / 1000.0` seconds, `sum(steps.cpu_ms) / 1000.0`
  CPU seconds, `max(steps.peak_rss_bytes)`, `sum(steps.bytes_in)`, `sum(steps.bytes_out)`,
  `sum(steps.ai_input_tokens)`, `sum(steps.ai_output_tokens)`, `sum(steps.ai_cost_usd)`; a table.
  No price derived from machine measurements (A3).
- `cost-per-step.ts`: the same sums grouped by `steps.name`; a table.
- `failed-steps.ts`: by `weekOf(steps.started_at)` and `steps.name`: failed over finished
  (`status in ('done', 'failed')`; `running`, `waiting` and `skipped` excluded, the doc says why).
- `funnel.ts`: an `InsightVizNode` with a `FunnelsQuery`: series of the five `STUDIO_EVENTS` in the
  order upload, preview opened, change requested, export requested, export downloaded (imported
  from `src/lib/studio-events.ts`, never retyped), ordered, aggregated by `properties.reel_id`, a
  conversion window the doc states (for example 14 days), filtered to `properties.app = 'studio'`.
- `storage-per-reel.ts`: `sum(stored_files.bytes)` where `deleted_at is null`, per reel.
- `storage-per-step.ts`: the same per `stored_files.step`.
- `storage-total.ts`: bytes of distinct live `r2_key` (an object two reels share counts once, as
  `app_docs/storage.md` says), plus the live per-reel-row sum for comparison; a bold number.
- `cache-hit-rate.ts`: `sum(case when steps.cache_hit then 1 else 0 end) * 1.0 / count(*)` over
  finished steps, by week and in total.
- `index.ts`: the ordered list (dashboard order: main metric, streak, first preview, changes,
  completion, funnel, cost per reel, cost per step, failed steps, storage total, per reel, per
  step, cache hit rate).

### 7. Write `payloads.ts`

- `insightBody(def, projectId)`: `{ name, description: <description + "\n\n[studio-metrics:<key>]">,
tags: [TAG], query: { kind: "DataVisualizationNode", source: { kind: "HogQLQuery", query:
def.build(hogql, (n) => TABLE_PREFIX + n) }, display, chartSettings } }` (or the funnel's
  `InsightVizNode`), with field names confirmed against the docs read in Phase 2.
- `dashboardBody()`: name, description with `[studio-metrics:dashboard]`, tags.
- `tilesLayout(insightIds)` and the two text cards (`SUPABASE_USAGE_URL` card, `GUARDRAIL_TEXT`
  card), in a fixed grid.
- `dryRunPayloads(projectId = "<POSTHOG_PROJECT_ID>")`: the full ordered list of `{ method, path,
body }` a first apply would send, with insight and dashboard ids as `<id:key>` placeholders.
  Stable output: no dates, no random values, keys in insertion order.

### 8. Write `apply.ts` and `http.ts`

- `HttpClient = { get(path), post(path, body), patch(path, body) }` returning parsed JSON.
- `applyDashboard(client, projectId)`: list dashboards (all pages), find by marker then exact name,
  else POST; list insights (all pages, not deleted), find each by marker then exact name; PATCH a
  match with the full body (name, description, query, tags, dashboards including the dashboard id),
  POST a missing one; then PATCH the dashboard's tiles: insight tiles' layouts and the two text
  cards, reusing existing text tiles found by their body's marker so no duplicate card is added.
  Returns `{ created: string[], updated: string[] }`.
- `http.ts`: `fetch` with `Authorization: Bearer <key>`, base `POSTHOG_HOST`, follows `next` for
  lists, throws with method, path, status and the response text on failure. Never logs the key.

### 9. Write `main.ts` and the package script

- Arguments: none or `--dry-run` prints `JSON.stringify(dryRunPayloads(...), null, 2)`; `--apply`
  reads `process.env.POSTHOG_PERSONAL_API_KEY` and `process.env.POSTHOG_PROJECT_ID`, exits 1 with a
  message naming the missing one, else runs `applyDashboard` and prints created and updated keys.
  Unknown arguments exit 1 with usage. A header comment says ADW and CI never run `--apply`.
- `apps/studio/package.json`: `"posthog:dashboard": "node scripts/posthog-dashboard/main.ts"`.
- `knip.json`: add `scripts/posthog-dashboard/main.ts` to the studio workspace's `entry`.
- `apps/studio/vitest.config.ts`: add `scripts/**/*.test.ts` to `include` (still database-free).

### 10. Write the unit tests

- `dry-run.test.ts`: `dryRunPayloads()` matches the committed snapshot; contains each of the 13
  insight keys exactly once (by marker), both text cards once, the dashboard once, and the tag on
  every insight and on the dashboard; the funnel's series events equal `STUDIO_EVENTS` in order;
  running `main.ts --dry-run` through `node:child_process` is not needed (keep it pure).
- `apply.test.ts`: an in-memory fake `HttpClient` that stores dashboards and insights with ids,
  supports list pagination (page size 2, to exercise `next`), POST and PATCH. First
  `applyDashboard` creates 1 dashboard, 13 insights, 2 text tiles; the second run against the same
  fake creates nothing (`created` empty, no POST recorded), PATCHes every object, and the store
  still holds exactly 1 dashboard, 13 insights and 2 text tiles. A third case pre-seeds an unrelated
  insight with a different name and checks it is left untouched. A fourth: `main`'s env check
  (factor it as `readApplyEnv(env)`) throws when either variable is missing.

### 11. Write the DB test for queries (`apps/studio/db-tests/dashboard-queries.test.ts`)

- **Real columns and events.** For every HogQL insight, render with the `postgres` dialect and
  `(n) => n` aliases resolved through `sql-references.ts`: extract tables (the names passed to the
  table function, recorded by a wrapping function) and every `<table>.<column>` pair for the six
  synced table names; each pair must exist in `information_schema.columns` for `public.<table>`
  (the prefix stripped by construction). Event names found in any query (`event = '...'`) and the
  funnel's series must all be in `STUDIO_EVENTS`. A renamed column or event fails here.
- **Metric logic.** In one `pg` transaction that is rolled back at the end (no residue on a shared
  stack):
  - Create a test user first (`createTestUser`, outside the transaction; `deleteTestUser` in
    `afterAll`).
  - `create schema dash_test` and, per synced table, `create view dash_test.<t> as select * from
public.<t> where owner_id = '<user id>'` (isolates the seeded rows from any other data on the
    stack).
  - Seed three reels with fixed times: process jobs at T, T+1h, T+2h; version 1 at +9, +12, +8
    minutes; one `change` job for reel B before its export; render jobs and exports at +22, +41,
    +18 minutes, the exports created in that order (A first, C last); steps rows with known
    `wall_ms`, `cpu_ms`, `peak_rss_bytes`, `bytes_*`, `ai_cost_usd`, `cache_hit`, one `failed`
    step; `stored_files` rows with one shared `r2_key` across two reels and one deleted row.
  - Run each insight's Postgres rendering with `(n) => "dash_test." + n` and assert: main metric
    22, 41, 18 minutes; streak 1; first preview 9, 12, 8; changes per exported reel 0, 1, 0;
    completion 3 of 3; the cost sums; failed share; storage per reel, per step and the total
    counting the shared key once and excluding the deleted row; cache hit rate.
  - Roll back.

### 12. Documentation

- New `app_docs/dashboard.md` (Specifications line pointing to this plan): overview; each metric's
  exact definition, source table or event and why that source (the Solution Statement's choices);
  the synced tables and their `updated_at` triggers (and that versions and exports never change
  after insert, so their `updated_at` is the insert time); deletes through the reel cascade are
  not seen by incremental sync (the doc says so); the code layout, the table prefix constant, the
  dialect approach; the script, `--dry-run` and `--apply`, the two variables
  `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` (shell only); the PostHog API doc URLs read;
  the four manual steps from the issue verbatim in substance; tests; and a Rules section: nothing
  written twice (no event copying a database measurement), no money from machine measurements,
  never run `--apply` from automation (ADW, CI, tests), never rename an event or a property, never
  commit a key, every synced table has `updated_at` with the trigger (a new synced table adds both
  in its migration and in `SYNCED_TABLES`).
- `docs/conditional-docs.md`: one line: read `app_docs/dashboard.md` when changing the PostHog
  dashboard script or its insights, a synced table's columns or `updated_at` trigger, the table
  prefix, or a metric definition.
- `app_docs/measurement.md`: the event constants now live in `src/lib/studio-events.ts`; the
  dashboard reads the events by these names.
- `app_docs/storage.md`, `app_docs/studio.md`: one line each on the `updated_at` column and trigger
  (storage: recording a deletion moves it).
- Root `.env.example`: a commented block naming `POSTHOG_PERSONAL_API_KEY=` and
  `POSTHOG_PROJECT_ID=` as empty placeholders, saying they are exported in the owner's shell for
  `yarn workspace @edit-issebya/studio posthog:dashboard --apply` and never written to a file.
- `.adw/project.md` Tests section: the unit layer adds `apps/studio/scripts/**/*.test.ts`; the DB
  layer adds `sync-columns.test.ts` and `dashboard-queries.test.ts`; Protected adds "never run
  `posthog:dashboard --apply`". Keep the nine headings unchanged.
- `README.md`: at most one link to `app_docs/dashboard.md` where the docs are listed.
- No em-dashes anywhere.

### 13. No browser coverage

- This change has no browser surface: the migration, a script under `apps/studio/scripts/` and
  tests. Nothing in the studio or landing page renders differently, so no Playwright spec and no
  review screenshots are needed. The existing studio E2E suite still runs as the regression gate
  (the migration touches tables every studio spec uses).

### 14. Run the Validation Commands

## Testing Strategy

### Unit Tests

- `apps/studio/scripts/posthog-dashboard/dry-run.test.ts`: stable snapshot of every payload;
  every insight once, both text cards, the tag; funnel events equal `STUDIO_EVENTS`.
- `apps/studio/scripts/posthog-dashboard/apply.test.ts`: fake HTTP client; second apply creates
  nothing and updates everything; pagination followed; unrelated objects untouched; missing env
  refused.
- Existing `apps/studio/src/lib/track.test.ts` keeps passing after the constants move.

### Test Coverage

- `apps/studio/db-tests/sync-columns.test.ts` (DB integration): fails today because `jobs`,
  `steps`, `versions`, `exports` and `stored_files` have no `updated_at` or trigger; catches a synced
  table added without one.
- `apps/studio/db-tests/dashboard-queries.test.ts` (DB integration): catches a query referencing a
  column or event that does not exist, and wrong metric arithmetic (22, 41, 18 minutes; streak 1;
  storage counting a shared key once). Fails without the insight modules.
- `apps/studio/scripts/posthog-dashboard/dry-run.test.ts` (unit): catches an insight, card or tag
  missing from the payloads, or unstable output. Fails without the script.
- `apps/studio/scripts/posthog-dashboard/apply.test.ts` (unit): catches duplicate creation on a
  second `--apply`. Fails without the script.
- Updated `steps-measurements.test.ts` and `stored-files.test.ts` (DB): pin the new exact column
  sets.
- No E2E spec: no browser surface (see task 13).

### Edge Cases

- A reel uploaded but never exported: absent from the main metric and streak, counted in completion
  as uploaded only.
- A reel with a Retry `process` job: upload time is still the first `process` job.
- A reel exported twice: only the first export counts; change requests after it are not counted.
- No exported reels: streak 0, not null.
- The latest export over 30 minutes: streak 0.
- Steps `running`, `waiting`, `skipped`: excluded from the failed share and the cache hit rate.
- Null measurements (a crashed step): `sum` ignores them; `coalesce` to 0 in the outputs.
- An object two reels share: counted per reel in per-reel storage, once in the total.
- A deleted stored file: excluded from live storage; its `updated_at` moved.
- `versions` and `exports` updates still refused after the new trigger.
- `--apply` with one variable missing: exits 1 naming it, no request sent.
- PostHog list pagination: objects on page two are found, not duplicated.
- Same-transaction updates: `now()` does not move; the test uses separate statements.

## Acceptance Criteria

- A new migration created by `supabase migration new` adds `updated_at timestamptz not null
default now()` and a `before update` trigger calling `public.set_updated_at()` to `jobs`,
  `steps`, `versions`, `exports` and `stored_files`; `reels` keeps its own; immutability of
  versions and exports and the `stored_files` deletion-only rule are unchanged.
- `apps/studio/scripts/posthog-dashboard/` holds one module per insight (13), the payload builder,
  the idempotent apply, the HTTP client and the CLI; `TABLE_PREFIX` defaults to `supabase_`.
- `yarn workspace @edit-issebya/studio posthog:dashboard` (dry run) prints stable payloads with
  every insight once, two text cards and the tag, without any environment variable.
- `--apply` reads only `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` from the environment and
  is idempotent (proven with the fake client). No test or CI job calls PostHog.
- No new event, no event renamed, no money derived from machine measurements.
- `app_docs/dashboard.md`, its index line, the root `.env.example` placeholders, the profile's Tests
  and Protected lines and the updated docs are in the change; no em-dashes; no secret committed.
- All validation commands pass.

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

- `.adw/supabase-stack reset`: applies the new migration to the ADW stack before `test:db` and E2E
  (the profile's rule after adding a migration; if it fails, report and stop).
- `yarn workspace @edit-issebya/studio posthog:dashboard --dry-run`: prints the payloads, proves
  the script runs under Node 24 with no variables.
- `yarn format:check`: whole-repository format check.
- `yarn turbo run lint --filter=./apps/studio`: lint of the studio, including the script.
- `yarn turbo run typecheck --filter=./apps/studio`: typecheck of the studio, including the script.
- `yarn knip`: no unused files, exports or dependencies (the new entry is registered).
- `yarn turbo run test --filter=./apps/studio`: unit layer, including the snapshot, idempotency and
  migration version guard tests.
- `yarn test`: the full unit layer the pre-push hook runs.
- `yarn turbo run test:db --filter=./apps/studio`: sync columns, query references, metric logic and
  the updated column-set tests against the ADW stack.
- `yarn turbo run build --filter=./apps/studio`: the studio still builds.
- `yarn build`: unfiltered build (the change also touches root files: migration, docs, knip).
- `yarn lint && yarn typecheck && yarn knip && yarn format:check && yarn test && yarn build`: the
  issue's gate in one line.
- `PORT=<run port> STUDIO_PORT=<BACKEND_PORT> yarn test:e2e`: the E2E suites, run last, against
  the server `/prepare_app` started (regression: the migration touches every studio table).

## Notes

- No new dependency: `fetch` is built into Node 24, `pg` and Vitest are already studio
  dependencies.
- The issue says to run `supabase migration up --local`; the profile's Protected section forbids
  every `supabase` command except `migration new` and `.adw/supabase-stack reset`, so the plan uses
  the reset, which applies the worktree's migrations to the ADW stack.
- The issue suggests `scripts/posthog-dashboard/` at the root; the plan puts it under
  `apps/studio/scripts/` because only the studio workspace has the TypeScript, lint, Vitest and DB
  tooling and the event constants, and `AGENTS.md` keeps the root manifest to shared tooling.
- `set_updated_at()` uses `now()` (transaction start). A long transaction committing after a sync
  could carry an `updated_at` older than the sync's high-water mark; the worker's writes are short
  single statements, so this is accepted and written in the doc rather than switching to
  `clock_timestamp()` (which would make `reels` and the new tables differ).
- Incremental sync does not see deleted rows (a reel's cascade); charts then keep the deleted
  reel's rows until a full resync. Acceptable for the MVP; noted in the doc.
- PostHog API field names and the warehouse table naming must be checked against the current docs
  during implementation (Phase 2), not taken from this plan; if a field differs, follow the docs and
  update the snapshot.
- Out of scope: connecting the source, the read-only role, the key, running `--apply`, alerts,
  release annotations and any invited-founder metric.
