// The time-left estimate of a long step: the median of the owner's earlier
// `done` rows of the same step (ms of step time per second of footage, newest
// ten), times this reel's footage seconds, minus the time the step has run.
// Fewer than three earlier rows: no estimate yet.
const ESTIMATE_MIN_ROWS = 3;
export const ESTIMATE_LAST_ROWS = 10;
// The only steps that write progress.
export const PROGRESS_STEPS = ["remove_background", "render"] as const;

export function isProgressStep(name: string): boolean {
  return (PROGRESS_STEPS as readonly string[]).includes(name);
}

// One earlier done row with its reel's footage seconds (numeric arrives from
// PostgREST as a string).
export interface HistoryRow {
  wall_ms: number | string | null;
  reels: { footage_seconds: number | string | null } | null;
}

// Ms of step time per second of footage, in the rows' order, skipping a row
// without both values.
export function historyRates(rows: HistoryRow[]): number[] {
  const rates: number[] = [];
  for (const row of rows) {
    const wallMs = row.wall_ms === null ? NaN : Number(row.wall_ms);
    const raw = row.reels?.footage_seconds;
    const footage = raw === null || raw === undefined ? NaN : Number(raw);
    if (!(wallMs >= 0) || !(footage > 0)) continue;
    rates.push(wallMs / footage);
  }
  return rates;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

// Seconds left, never below 0; null without enough history or footage
// seconds. `rates` is newest first.
export function timeLeftSeconds({
  rates,
  footageSeconds,
  elapsedMs,
}: {
  rates: number[] | undefined;
  footageSeconds: number | string | null | undefined;
  elapsedMs: number;
}): number | null {
  const footage =
    footageSeconds === null || footageSeconds === undefined ? NaN : Number(footageSeconds);
  if (!rates || rates.length < ESTIMATE_MIN_ROWS || !(footage > 0)) return null;
  const totalMs = median(rates.slice(0, ESTIMATE_LAST_ROWS)) * footage;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.max(0, Math.round((totalMs - elapsed) / 1000));
}

export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null) return "no estimate yet";
  if (seconds < 60) return "less than a minute left";
  return `about ${Math.round(seconds / 60)} min left`;
}
