import type { StoredVersion, VersionBlobs, VersionRows } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseFailure } from "./failure.ts";

// Named columns, never `*`.
const COLUMNS = "id, reel_id, number, parent_id, restored_from_id, checks, inputs, r2_key";

// The version rows through the worker's (service role) client: save is the
// save_version function, which inserts the row and moves the reel's current
// version in one transaction.
export function supabaseVersionRows(db: SupabaseClient): VersionRows {
  return {
    async current(reelId) {
      const { data, error, status } = await db
        .from("reels")
        .select("current_version_id")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw supabaseFailure("current version not read", { error, status });
      if (!data) throw new Error(`reel ${reelId} does not exist`);
      return (data as { current_version_id: string | null }).current_version_id;
    },
    async get(id) {
      const { data, error, status } = await db
        .from("versions")
        .select(COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw supabaseFailure("version not read", { error, status });
      return (data as StoredVersion | null) ?? null;
    },
    async save(row) {
      const { data, error, status } = await db.rpc("save_version", {
        p_id: row.id,
        p_reel_id: row.reel_id,
        p_parent_id: row.parent_id,
        p_restored_from_id: row.restored_from_id,
        p_request: row.request,
        p_model: row.model,
        p_prompt_version: row.prompt_version,
        p_change_summary: row.change_summary,
        p_checks: row.checks,
        p_inputs: row.inputs,
        p_r2_key: row.r2_key,
        p_used_free_field: row.used_free_field,
        p_unexpressed: row.unexpressed,
        p_free_field: row.free_field,
        p_rejected_reasons: row.rejected_reasons,
      });
      if (error) throw supabaseFailure("version not saved", { error, status });
      return data as number;
    },
  };
}

// Version blobs in R2 (or the folder fake): JSON, written put-if-absent.
export function storageVersionBlobs(storage: Storage): VersionBlobs {
  return {
    get: (key) => storage.get(key),
    putIfAbsent: (key, bytes) =>
      storage.putIfAbsent(key, bytes, { contentType: "application/json" }),
  };
}
