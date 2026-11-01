import type { SupabaseClient } from "@supabase/supabase-js";

// Named columns, never "*": a later column (a storage key, a worker field)
// never reaches the page by accident.
export const REEL_COLUMNS = "id, status, source_name, created_at";
export const REEL_DETAIL_COLUMNS =
  "id, status, source_name, source_bytes, created_at, updated_at, current_version_id";

export const REEL_STATUSES = [
  "uploading",
  "uploaded",
  "received",
  "converting",
  "transcribing",
  "retiming",
  "removing_background",
  "tracking_head",
  "making_previews",
  "processed",
  "failed",
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
}

// The number of a version (shown as "version 2"), read under the owner's
// row-level security; null before the first version or when it is not
// readable.
export async function versionNumberOf(
  supabase: SupabaseClient,
  versionId: string | null | undefined,
): Promise<number | null> {
  if (!versionId) return null;
  const { data, error } = await supabase
    .from("versions")
    .select("number")
    .eq("id", versionId)
    .maybeSingle<{ number: number }>();
  if (error || !data) return null;
  return data.number;
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
