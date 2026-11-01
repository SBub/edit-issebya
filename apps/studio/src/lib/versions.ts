import type { SupabaseClient } from "@supabase/supabase-js";

// Named columns, never "*": the list shows how each version was made, not its
// storage key or the AI's checks.
const VERSION_COLUMNS =
  "id, number, created_at, request, change_summary, restored_from_id, parent_id";

export interface VersionListRow {
  id: string;
  number: number;
  created_at: string;
  request: string | null;
  change_summary: string | null;
  restored_from_id: string | null;
  parent_id: string | null;
}

// Every version of the reel, newest first, under the owner's row-level
// security. The newest is the current one: every save and restore makes the
// new version current.
export async function readVersions(
  supabase: SupabaseClient,
  reelId: string,
): Promise<VersionListRow[]> {
  const { data, error } = await supabase
    .from("versions")
    .select(VERSION_COLUMNS)
    .eq("reel_id", reelId)
    .order("number", { ascending: false })
    .returns<VersionListRow[]>();
  if (error) throw new Error(`studio: versions not loaded: ${error.message}`);
  return data ?? [];
}

// What produced a version: the owner's request in quotes, a restore of an
// earlier one, or the worker on its own.
export function versionLabel(row: VersionListRow, rows: VersionListRow[]): string {
  if (row.request !== null) return `"${row.request}"`;
  if (row.restored_from_id !== null) {
    const from = rows.find((candidate) => candidate.id === row.restored_from_id);
    return from ? `restored from v${from.number}` : "restored from an earlier version";
  }
  return "automatic";
}
