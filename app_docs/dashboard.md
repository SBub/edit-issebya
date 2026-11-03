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
- Worker load and capacity (registered last in `insights/index.ts`, in this order). The worker runs
  one job at a time on the owner's Mac; these six size its load and a future server, from columns
  already synced. Every job time below is `jobs.started_at` to `jobs.finished_at`, and `claim_job`
  overwrites `started_at` when it claims a job again after a lost lease, so such a job counts its
  last attempt only.
  - Jobs per day, by kind (`insights/jobs-per-day.ts`, key `jobs-per-day`, "Studio: jobs per day,
    by kind"): per day of `jobs.created_at` and `jobs.kind`, the count of jobs, any status. Source:
    `jobs`.
  - Job run time per kind, by week (`insights/job-run-time.ts`, key `job-run-time`, "Studio: job run
    time per kind, by week"): per week of `started_at` and kind, over `done` jobs, the count and the
    median and 95th percentile minutes from `started_at` to `finished_at`. Source: `jobs`.
  - Queue wait per kind, by week (`insights/queue-wait.ts`, key `queue-wait`, "Studio: queue wait
    per kind, by week (approximate)"): per week of `created_at` and kind, over jobs with a
    `started_at`, the median and 95th percentile minutes from `created_at` to `started_at`.
    Approximate, as its name and description say: a job claimed again after a lost lease has a later
    `started_at`, so its wait includes the lost attempt; and a job also waits while an older job of
    its reel or photo runs (`claim_job`'s per-reel order), not only while the worker is busy.
    Source: `jobs`.
  - Worker busy hours per day (`insights/worker-busy-hours.ts`, key `worker-busy-hours`, "Studio:
    worker busy hours per day"): per day of `started_at`, the hours from `started_at` to
    `finished_at` summed over `done` and `failed` jobs, that sum over 24 hours (`busy_share`) and the
    job count. A job counts whole on the day it started. Source: `jobs`.
  - Share of worker time waiting on Claude, by week (`insights/ai-wait-share.ts`, key
    `ai-wait-share`, "Studio: share of worker time waiting on Claude, by week"): per week of
    `steps.started_at`, the `wall_ms` of steps with a non-null `ai_model` over the `wall_ms` of every
    step that has one (done, failed or skipped; a running step has none). `ai_model` is the model
    Claude Code reports, written by the worker's `aiMeasurements` on AI steps only, so an AI call
    that reported no usage is not counted. The whole wall time of an AI step counts, so the share is
    an upper bound on time spent waiting for Claude. Source: `steps`.
  - CPU per source minute and peak memory, per step (`insights/capacity-per-minute.ts`, key
    `capacity-per-minute`, "Studio: CPU per source minute and peak memory, per step"): per step
    name, over `done` steps (cache hits are recorded `skipped`, and `not steps.cache_hit` is
    checked too) of reels with a `source_seconds`, the count, the median of `cpu_ms` seconds per
    minute of `reels.source_seconds`, and the largest `peak_rss_bytes`. Divided by
    `source_seconds`, not `footage_seconds`: the source is what the owner uploads, so its minutes
    are the unit of work a server must absorb, and the worker records it after `check_footage`,
    before the heavy steps, while `footage_seconds` (the retimed length) exists only after `retime`
    and depends on how much the edit cut. Steps of photo jobs have no reel and are left out. Raw
    machine measurements only: no money is derived. Sources: `steps` joined to `reels` on
    `reel_id`.
- Two text cards: a link to the studio Supabase project's usage page (database size, egress and auth
  users are not synced) and a note on where the preview-matches-export guardrail is checked
  (`apps/studio/e2e-tools/export-matches-preview.spec.ts`, owner's Mac only, see `app_docs/export.md`).

Code layout:

- `apps/studio/scripts/posthog-dashboard/main.ts`: entry; `--dry-run` (default) or `--apply`.
- `apps/studio/scripts/posthog-dashboard/config.ts`: fixed facts: host, `TABLE_PREFIX`, `SYNCED_TABLES`,
  goals, the `studio-metrics` tag and marker, the text cards.
- `apps/studio/scripts/posthog-dashboard/dialect.ts`: one SQL text in two dialects. Insights are
  written in a subset HogQL and Postgres both accept; the few differing pieces (`minutesBetween`,
  `secondsBetween`, `weekOf`, `dayOf`, `median`, `quantile`) come from a `Dialect`. HogQL's
  `median` and `quantile(p)` are ClickHouse's sampled estimates; Postgres uses `percentile_cont`. The payload uses HogQL; the DB test runs the Postgres rendering.
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
4. Run
   `POSTHOG_PERSONAL_API_KEY=... POSTHOG_PROJECT_ID=... yarn workspace @edit-issebya/studio posthog:dashboard --apply`.
   The Supabase usage card already links the studio's hosted project (`ykjgyapmrszliovfqjfx`).

To preview without a variable: `yarn workspace @edit-issebya/studio posthog:dashboard` (or
`--dry-run`) prints the exact payloads a first apply sends.

## Configuration

- `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID`: read from the owner's shell only by
  `--apply`, which refuses to start without both. Empty placeholders are in the root `.env.example`.
  They are in no env file and not in `turbo.json`.
- `TABLE_PREFIX`, `SYNCED_TABLES`, goals and the funnel window: constants in `config.ts`.

## Testing

- `apps/studio/scripts/posthog-dashboard/dry-run.test.ts`: snapshot of the dry-run payloads, and
  every description (dashboard, insights, text cards) under 400 characters and ending in its marker.
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
- Every description stays under 400 characters, marker included (PostHog's MCP tool caps insight
  descriptions there). A description over the cap is rewritten shorter, never truncated: a short,
  plain sentence or two on what the tile shows and how to read it, keeping each caveat that changes
  the reading.
- Never write a measurement twice: no event copies a database measurement.
- Never derive money from machine measurements.
- Never rename a `studio_*` event or a property.
- Never commit a key or write one to a file.
- Every synced table has `updated_at` and its `<table>_set_updated_at` trigger; a new synced table
  adds both in its migration and in `SYNCED_TABLES`.
