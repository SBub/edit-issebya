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
  "Does the studio turn a two-hour edit into a short one, and what does each reel cost to make. " +
  "Defined in apps/studio/scripts/posthog-dashboard/ (app_docs/dashboard.md); edit the code, not this dashboard.";

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

// The studio project's Supabase usage page. Placeholder until the owner
// replaces <studio-project-ref> (manual step 4 in app_docs/dashboard.md).
const SUPABASE_USAGE_URL =
  "https://supabase.com/dashboard/project/<studio-project-ref>/settings/usage";

export const SUPABASE_CARD_KEY = "supabase-usage";
export const SUPABASE_CARD_TEXT =
  "**Supabase usage** (database size, egress, auth users) is not synced to PostHog. " +
  `Read it on the studio project's usage page: ${SUPABASE_USAGE_URL}`;

export const GUARDRAIL_CARD_KEY = "guardrail";
export const GUARDRAIL_TEXT =
  "**Preview matches export guardrail.** Checked by " +
  "`apps/studio/e2e-tools/export-matches-preview.spec.ts`, run on the owner's Mac by " +
  "`yarn workspace @edit-issebya/studio test:tools`, never in CI. Its last result is the " +
  "owner's terminal output; the accepted scores and bound are in app_docs/export.md.";
