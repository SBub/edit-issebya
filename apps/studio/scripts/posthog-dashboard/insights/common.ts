import type { Dialect, TableRef } from "../dialect.ts";

// Shared shapes and CTE fragments of the insights. Every synced table is
// aliased by its bare name and every column qualified (`steps.wall_ms`), so
// sql-references.ts can list the (table, column) pairs a query reads. CTE names
// never equal a synced table's name.

export type SqlDisplay = "ActionsLineGraph" | "ActionsBar" | "ActionsTable" | "BoldNumber";

export interface SqlInsight {
  kind: "sql";
  key: string;
  name: string;
  description: string;
  display: SqlDisplay;
  xAxis?: string;
  yAxis?: string[];
  goal?: { label: string; value: number };
  build(d: Dialect, t: TableRef): string;
}

export interface FunnelInsight {
  kind: "funnel";
  key: string;
  name: string;
  description: string;
  /** The ordered steps, imported from src/lib/studio-events.ts, never retyped. */
  events: readonly string[];
}

export type Insight = SqlInsight | FunnelInsight;

/**
 * A reel's upload time: the earliest `process` job, inserted by finish_upload
 * in the statement that completes the upload (a Retry job is later).
 */
export function uploadsCte(t: TableRef): string {
  return `uploads as (
  select jobs.reel_id as reel_id, min(jobs.created_at) as uploaded_at
  from ${t("jobs")} as jobs
  where jobs.kind = 'process'
  group by jobs.reel_id
)`;
}

/** A reel's export time: its earliest `exports` row, the first exported file. */
export function firstExportsCte(t: TableRef): string {
  return `first_exports as (
  select exports.reel_id as reel_id, min(exports.created_at) as exported_at
  from ${t("exports")} as exports
  group by exports.reel_id
)`;
}

/** A reel's first preview: its earliest version (version 1, from first_version). */
export function firstVersionsCte(t: TableRef): string {
  return `first_versions as (
  select versions.reel_id as reel_id, min(versions.created_at) as previewed_at
  from ${t("versions")} as versions
  group by versions.reel_id
)`;
}

/** Upload to first export in minutes, one row per exported reel. */
export function exportedReelsCte(d: Dialect): string {
  return `exported_reels as (
  select uploads.reel_id as reel_id, first_exports.exported_at as exported_at,
    ${d.minutesBetween("uploads.uploaded_at", "first_exports.exported_at")} as minutes
  from uploads
  inner join first_exports on first_exports.reel_id = uploads.reel_id
)`;
}
