// Named columns, never "*": a later column (a storage key, a worker field)
// never reaches the page by accident.
export const REEL_COLUMNS = "id, status, source_name, created_at";
export const REEL_DETAIL_COLUMNS =
  "id, status, source_name, source_bytes, created_at, updated_at, current_version_id, preview_copies, footage_seconds, refusal_message";

// The reels grid: the summary plus the size, the preview copies and the
// current version's key, from which the server derives (and signs) the
// thumbnail's key. The embed names the FK constraint, since versions.reel_id is
// a second relation between the two tables and the composite
// (current_version_id, id) key cannot be named by its column. Server only: the key never reaches
// a client component.
export const REEL_GRID_COLUMNS = `${REEL_COLUMNS}, source_bytes, current_version_id, preview_copies, current_version:versions!reels_current_version_fkey(r2_key)`;

export const REEL_STATUSES = [
  "uploading",
  "uploaded",
  "checking_footage",
  "received",
  "converting",
  "transcribing",
  "retiming",
  "removing_background",
  "tracking_head",
  "making_previews",
  "processed",
  "failed",
  "refused",
] as const;
export type ReelStatus = (typeof REEL_STATUSES)[number];

export interface ReelSummary {
  id: string;
  status: ReelStatus;
  source_name: string | null;
  created_at: string;
}

export interface ReelGridRow extends ReelSummary {
  source_bytes: number | null;
  current_version_id: string | null;
  preview_copies: unknown;
  current_version: { r2_key: string } | null;
}

export interface ReelDetail extends ReelSummary {
  source_bytes: number | null;
  updated_at: string;
  current_version_id: string | null;
  // Where the preview copies are (worker-written; see lib/preview-sources).
  preview_copies: unknown;
  // The retimed footage's length (numeric, a string from PostgREST), the
  // divisor of the time-left estimate; null until the worker's retime.
  footage_seconds: number | string | null;
  // Why the footage was refused, in the owner's words; null unless refused.
  refusal_message: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Checked before any query, so a malformed id is a not-found page, never a
// Postgres error.
export function isReelId(id: string): boolean {
  return UUID.test(id);
}

const CREATED_AT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function formatCreatedAt(iso: string): string {
  return `${CREATED_AT.format(new Date(iso))} UTC`;
}

export function reelName(reel: { source_name: string | null }): string {
  return reel.source_name?.trim() || "Untitled reel";
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// How old a reel is, in one short unit: `now` under a minute, then `5m`,
// `3h`, `2d`, `1w` (7 to 29 days, whole weeks), `3mo` (30 to 364 days,
// 30-day months) and `1y`. A date in the future reads as `now`.
export function formatAge(createdIso: string, now: number): string {
  const age = now - Date.parse(createdIso);
  if (!Number.isFinite(age) || age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  const days = Math.floor(age / DAY);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}
