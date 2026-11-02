// Named columns, never "*", and no lease column: the page shows what a job
// did, not which worker holds it.
export const JOB_COLUMNS =
  "id, reel_id, kind, request, restore_version_id, version_id, retry_of_job_id, status, waiting_reason, not_before, attempts, error_tail, created_at, started_at, finished_at";
export const STEP_COLUMNS =
  "id, job_id, reel_id, name, status, summary, error_tail, started_at, finished_at, progress_percent, progress_updated_at";

// `process` after an upload; `change` carries the owner's words; `restore`
// goes back to an earlier version; `render` exports a version to an MP4.
export const JOB_KINDS = ["process", "change", "restore", "render"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["queued", "running", "waiting_ai", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STEP_STATUSES = ["running", "done", "failed", "skipped", "waiting"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface JobRow {
  id: string;
  reel_id: string;
  kind: string;
  // A change job's words; null for the other kinds.
  request: string | null;
  // The version a restore job goes back to; null for the other kinds.
  restore_version_id: string | null;
  // The version a render job exports; null for the other kinds.
  version_id: string | null;
  // The failed job this one retries (the Retry button); null otherwise.
  retry_of_job_id: string | null;
  status: JobStatus;
  // While `waiting_ai`: why the AI is not available, and the next try.
  waiting_reason: string | null;
  not_before: string | null;
  attempts: number;
  error_tail: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface StepRow {
  id: string;
  job_id: string;
  reel_id: string;
  name: string;
  status: StepStatus;
  summary: string | null;
  error_tail: string | null;
  started_at: string;
  finished_at: string | null;
  // A long step's progress (0 to 100) and when it was written; null otherwise.
  progress_percent: number | null;
  progress_updated_at: string | null;
}

// Replaces the row with the same id or adds it, then orders by `order`
// (ISO timestamps sort as strings), id breaking ties.
export function upsertById<T extends { id: string }>(rows: T[], row: T, order: keyof T): T[] {
  const next = rows.some((r) => r.id === row.id)
    ? rows.map((r) => (r.id === row.id ? row : r))
    : [...rows, row];
  return next.sort((a, b) => {
    const left = String(a[order] ?? "");
    const right = String(b[order] ?? "");
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// A Realtime payload carries every column of the row; keep only the listed ones.
export function pickColumns<T>(record: Record<string, unknown>, columns: string): T {
  const picked: Record<string, unknown> = {};
  for (const column of columns.split(",").map((c) => c.trim())) {
    if (Object.hasOwn(record, column)) picked[column] = record[column];
  }
  return picked as T;
}
