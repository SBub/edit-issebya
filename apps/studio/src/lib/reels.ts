// Named columns, never "*": a later column (a storage key, a worker field)
// never reaches the page by accident.
export const REEL_COLUMNS = "id, status, source_name, created_at";
export const REEL_DETAIL_COLUMNS =
  "id, status, source_name, source_bytes, created_at, updated_at, current_version_id, preview_copies, footage_seconds, refusal_message";

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
