// Named columns, never "*", and no lease column: the page shows what a job
// did, not which worker holds it.
export const JOB_COLUMNS =
  "id, reel_id, kind, status, attempts, error_tail, created_at, started_at, finished_at";
export const STEP_COLUMNS =
  "id, job_id, reel_id, name, status, summary, error_tail, started_at, finished_at";
export const WORKER_STATUS_COLUMNS = "worker_id, waiting_reason, updated_at";

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const STEP_STATUSES = ["running", "done", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface JobRow {
  id: string;
  reel_id: string;
  kind: string;
  status: JobStatus;
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
}

// Why a worker is not claiming jobs (a nearly full disk); holds no reel data.
export interface WorkerStatusRow {
  worker_id: string;
  waiting_reason: string | null;
  updated_at: string;
}

// The newest reason any worker gives for waiting, else null.
export function waitingReason(statuses: WorkerStatusRow[]): string | null {
  let newest: WorkerStatusRow | null = null;
  for (const status of statuses) {
    if (status.waiting_reason === null) continue;
    if (!newest || status.updated_at > newest.updated_at) newest = status;
  }
  return newest?.waiting_reason ?? null;
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
