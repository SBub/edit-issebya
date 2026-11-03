# PostHog Studio Metrics Dashboard

**Specifications:**

- specs/issue-40-adw-d6376789-sdlc_planner-posthog-studio-metrics-dashboard.md

## Overview

One PostHog dashboard (project 312096, EU host), "Studio MVP metrics", answers the reel studio MVP's
question: does the studio turn a two-hour edit into a short one, and what does each reel cost to
make. The dashboard, its insights and its two text cards are defined in TypeScript under
`apps/studio/scripts/posthog-dashboard/` and created or updated by a script the owner runs by hand,
so the dashboard can be reviewed and does not drift. Every table PostHog syncs carries an
`updated_at` column so the Postgres source can sync incrementally.

## How it works

Every metric except the funnel is a HogQL query over the tables PostHog syncs from the studio's
Supabase database; the funnel reads the five `studio_*` events. The database is the source for
anything it already records, so nothing is written twice.

Metrics, as defined by the code:

- Upload to export (main metric): per exported reel, minutes from upload (its earliest `process`
  job) to its first export (earliest `exports` row, so the render is included). Goal line 30
  minutes. Sources: `jobs`, `exports`.
- Streak: the latest exported reels, newest first, counted until the first one of 30 minutes or
  more (0 when none is exported). Rollout target 7 in a row. Sources: `jobs`, `exports`.
- Upload to first preview: minutes from upload to version 1 (`versions.created_at`, saved by
  `first_version`). Goal line 15 minutes. Sources: `jobs`, `versions`.
- Change requests per exported reel, by week of the first export: `jobs` of kind `change` created
  before the reel's first export.
- Completion by week of upload: reels uploaded, reels of those exported, their ratio.
- Funnel: the five studio events in order, per reel (`properties.reel_id`), 14-day window. Events
  are absent wherever PostHog is not initialised, so every other chart reads the database.
- Cost per reel and per step: wall and CPU seconds, peak memory, bytes, AI tokens and the AI cost
  Claude Code reports, summed from `steps`. No money is derived from machine time.
- Time per step against reel length (`insights/step-time-vs-length.ts`, key `step-time-vs-length`,
  "Studio: time per step against reel length", registered in `insights/index.ts` after the cost per
  step and in the dry-run snapshot): per step name and 15-second bucket of the reel's
  `source_seconds`, the count of `done` steps, their median and longest seconds, and the median
  seconds per second of retimed footage. Sources: `steps` joined to `reels` on `reel_id` (details in
  `app_docs/measurement.md`). Like every insight it reaches PostHog only through the owner's
  `--apply`.
- Failed steps by step name and week, over finished steps (done or failed).
- Cache hit rate by week and to date: skipped steps with `cache_hit` over finished steps (`steps`).
- Storage in total (distinct live `r2_key`, so a shared object counts once), per reel and per step,
  from `stored_files` rows with `deleted_at` null.
- Two text cards: a link to the studio Supabase project's usage page (database size, egress and auth
  users are not synced) and a note on where the preview-matches-export guardrail is checked
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`, owner's Mac only, see `app_docs/export.md`).

Code layout:

- `apps/studio/scripts/posthog-dashboard/main.ts`: entry; `--dry-run` (default) or `--apply`.
- `apps/studio/scripts/posthog-dashboard/config.ts`: fixed facts: host, `TABLE_PREFIX`, `SYNCED_TABLES`,
  goals, the `studio-metrics` tag and marker, the text cards.
- `apps/studio/scripts/posthog-dashboard/dialect.ts`: one SQL text in two dialects. Insights are
  written in a subset HogQL and Postgres both accept; the few differing pieces (`minutesBetween`,
  `weekOf`) come from a `Dialect`. The payload uses HogQL; the DB test runs the Postgres rendering.
- `apps/studio/scripts/posthog-dashboard/insights/`: one module per insight, listed in dashboard
  order by `index.ts`. Every synced table is aliased by its bare name and every column qualified
  (`steps.wall_ms`) so `sql-references.ts` can list the `(table, column)` pairs a query reads.
- `apps/studio/scripts/posthog-dashboard/payloads.ts`: the API payloads and dashboard tiles.
- `apps/studio/scripts/posthog-dashboard/apply.ts` and `http.ts`: the idempotent create-or-update.
  Objects are matched by a marker line `[studio-metrics:<key>]` in their description (a text card:
  in its body), falling back to the exact name, never by tag alone. A match is PATCHed, a missing
  object POSTed; a second run creates nothing.
- `apps/studio/src/lib/studio-events.ts`: the `studio_*` event names, dependency-free so the script
  imports them without loading posthog-js (`src/lib/track.ts` re-uses the type).
- `supabase/migrations/20261102060324_posthog_sync_columns.sql`: adds
  `updated_at timestamptz not null default now()` and a `<table>_set_updated_at` trigger
  (`public.set_updated_at()`) to `jobs`, `steps`, `versions`, `exports` and `stored_files`
  (`reels` already had both). `worker_status` is not synced. On `versions` and `exports`, which
  never change after insert, `updated_at` is the insert time; on `stored_files` recording a
  deletion moves it. Deletes through the reel cascade are not seen by incremental sync.

## How to Use

Manual owner steps (ADW never does these):

1. In PostHog, connect the studio project's Supabase Postgres as a data warehouse source and sync
   `reels`, `jobs`, `steps`, `versions`, `exports` and `stored_files` incrementally on `updated_at`.
2. In the PostHog SQL editor read the real synced table names; if the prefix is not `supabase_`,
   change `TABLE_PREFIX` in `config.ts`.
3. Create a personal API key with write access to insights and dashboards, and export it in your
   shell with the project id (never to a file).
4. Replace `<studio-project-ref>` in the Supabase usage URL in `config.ts`, then run
   `POSTHOG_PERSONAL_API_KEY=... POSTHOG_PROJECT_ID=... yarn workspace @edit-issebya/studio posthog:dashboard --apply`.

To preview without a variable: `yarn workspace @edit-issebya/studio posthog:dashboard` (or
`--dry-run`) prints the exact payloads a first apply sends.

## Configuration

- `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`: read from the owner's shell only by
  `--apply`, which refuses to start without both. Empty placeholders are in the root `.env.example`.
  They are in no env file and not in `turbo.json`.
- `TABLE_PREFIX`, `SYNCED_TABLES`, goals and the funnel window: constants in `config.ts`.

## Testing

- `apps/studio/scripts/posthog-dashboard/dry-run.test.ts`: snapshot of the dry-run payloads.
- `apps/studio/scripts/posthog-dashboard/apply.test.ts`: `--apply` idempotency against a fake HTTP
  client, no network.
- `apps/studio/db-tests/sync-columns.test.ts`: `updated_at` and trigger on every synced table.
- `apps/studio/db-tests/dashboard-queries.test.ts`: the queries' columns and events against the real
  schema, and the Postgres rendering's numbers on seeded rows.
- Run `yarn test` and `yarn turbo run test:db --filter=./apps/studio` (after
  `.adw/supabase-stack reset` in a run).

## Notes

- Out of scope: Supabase usage (a link card only) and any real-time guardrail result in PostHog.
- Touches `app_docs/measurement.md` (event constants moved to `studio-events.ts`),
  `app_docs/studio.md` and `app_docs/storage.md` (the `updated_at` columns).

## Rules

- Never run `posthog:dashboard --apply` from automation (ADW, CI, tests); only the owner, from their shell.
- Never write a measurement twice: no event copies a database measurement.
- Never derive money from machine measurements.
- Never rename a `studio_*` event or a property.
- Never commit a key or write one to a file.
- Every synced table has `updated_at` and its `<table>_set_updated_at` trigger; a new synced table
  adds both in its migration and in `SYNCED_TABLES`.
