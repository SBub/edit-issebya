// The studio metrics dashboard's fixed facts (app_docs/dashboard.md). No
// secret lives here: the personal API key and the project id come only from
// the owner's shell when `--apply` runs.

// The EU cloud host of project 312096 (the landing page and the studio share it).
export const POSTHOG_HOST = "https://eu.posthog.com";

// Printed in dry-run paths instead of a real project id.
export const DEFAULT_PROJECT_ID = "<POSTHOG_PROJECT_ID>";

// Everything PostHog puts before a synced table's name in its SQL editor. After
// connecting the Postgres source, read the real names there and change this
// constant if they differ.
export const TABLE_PREFIX = "supabase_";

// The tables the PostHog Postgres source syncs. Each one has
// `updated_at timestamptz not null default now()` and a `<table>_set_updated_at`
// trigger (supabase/migrations/*_posthog_sync_columns.sql), checked by
// db-tests/sync-columns.test.ts. A table added here adds both in its migration.
export const SYNCED_TABLES = [
  "reels",
  "jobs",
  "steps",
  "versions",
  "exports",
  "stored_files",
] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

// Every object the script writes carries this tag and a marker line.
export const TAG = "studio-metrics";
export const DASHBOARD_KEY = "dashboard";
export const DASHBOARD_NAME = "Studio MVP metrics";
export const DASHBOARD_DESCRIPTION =
  "Does the studio turn a two-hour edit into a short one, and what does each reel cost to make? " +
  "Built from code in apps/studio/scripts/posthog-dashboard/: change it there, not here.";

/** The line that identifies an object the script owns, whatever its name became. */
export function marker(key: string): string {
  return `[${TAG}:${key}]`;
}

// Goals.
export const MAIN_METRIC_MINUTES = 30;
export const FIRST_PREVIEW_MINUTES = 15;
export const STREAK_TARGET = 7;

// The funnel's conversion window, in days.
export const FUNNEL_WINDOW_DAYS = 14;

// The studio's hosted Supabase project ref (public: it is in the project's URL)
// and its usage page.
// eslint-disable-next-line no-secrets/no-secrets -- a public project ref, not a key
const SUPABASE_PROJECT_REF = "ykjgyapmrszliovfqjfx";
const SUPABASE_USAGE_URL = `https://supabase.com/dashboard/project/${SUPABASE_PROJECT_REF}/settings/usage`;

export const SUPABASE_CARD_KEY = "supabase-usage";
export const SUPABASE_CARD_TEXT =
  "**Supabase usage** (database size, data sent out, user accounts) is not in PostHog. " +
  `See it on the studio's Supabase usage page: ${SUPABASE_USAGE_URL}`;

export const GUARDRAIL_CARD_KEY = "guardrail";
export const GUARDRAIL_TEXT =
  "**Preview matches export guardrail.** A test that the exported video looks like the preview. " +
  "It runs only on the owner's Mac (`yarn workspace @edit-issebya/studio test:tools`), so its " +
  "result is not shown here. Accepted scores: app_docs/export.md.";
