// The worker is offline once the newest heartbeat of any worker is older than
// eleven minutes (it beats every five). No heartbeat ever: nothing to say.
export const OFFLINE_AFTER_MS = 11 * 60_000;

interface HeartbeatRow {
  heartbeat_at: string | null;
}

function newestHeartbeat(rows: HeartbeatRow[]): number | null {
  let newest: number | null = null;
  for (const row of rows) {
    if (row.heartbeat_at === null) continue;
    const at = Date.parse(row.heartbeat_at);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

// The moment the worker turns offline, or null without any heartbeat.
export function offlineAt(rows: HeartbeatRow[]): Date | null {
  const newest = newestHeartbeat(rows);
  return newest === null ? null : new Date(newest + OFFLINE_AFTER_MS);
}

// The newest heartbeat when the worker is offline at `now`, else null.
export function offlineSince(rows: HeartbeatRow[], now: Date): Date | null {
  const newest = newestHeartbeat(rows);
  if (newest === null || now.getTime() < newest + OFFLINE_AFTER_MS) return null;
  return new Date(newest);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

// 24-hour local time.
export function formatOfflineSince(since: Date): string {
  return `Worker offline since ${twoDigits(since.getHours())}:${twoDigits(since.getMinutes())}`;
}
