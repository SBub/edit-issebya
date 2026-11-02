// Named columns, never `*`. The free disk stays on the worker's side.
export const WORKER_STATUS_COLUMNS = "worker_id, waiting_reason, updated_at";

export interface WorkerStatusRow {
  worker_id: string;
  waiting_reason: string | null;
  updated_at: string;
}

// One worker's row replaces its earlier one (a Realtime insert or update).
export function upsertWorkerStatus(
  rows: WorkerStatusRow[],
  row: WorkerStatusRow,
): WorkerStatusRow[] {
  return [...rows.filter((r) => r.worker_id !== row.worker_id), row];
}

// Why a queued job is not starting: the newest reason any worker gives, or
// null when none is waiting.
export function waitingReasonOf(rows: WorkerStatusRow[]): string | null {
  let newest: WorkerStatusRow | null = null;
  for (const row of rows) {
    if (row.waiting_reason === null) continue;
    if (!newest || row.updated_at > newest.updated_at) newest = row;
  }
  return newest?.waiting_reason ?? null;
}
