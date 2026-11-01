import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewVersion, VersionRow, VersionStore } from "./versions.ts";

const COLUMNS =
  "id, reel_id, number, parent_id, restored_from_id, request, model, prompt_version, change_summary, checks, inputs, r2_key, used_free_field, free_field, unexpressed";

// The version store over Supabase, for a client with the secret key (only
// the worker writes versions): reads by named columns, and every insert
// through `save_version`, which numbers the row and moves the reel's current
// version in one transaction.
export function supabaseVersionStore(db: SupabaseClient): VersionStore {
  return {
    async current(reelId) {
      const { data: reel, error } = await db
        .from("reels")
        .select("current_version_id")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw new Error(`reel not read: ${error.message}`);
      const id = (reel as { current_version_id: string | null } | null)?.current_version_id;
      if (!id) return null;
      const { data, error: versionError } = await db
        .from("versions")
        .select("id, number")
        .eq("id", id)
        .single();
      if (versionError || !data) throw new Error(`version not read: ${versionError?.message}`);
      return data as { id: string; number: number };
    },
    async get(versionId) {
      const { data, error } = await db
        .from("versions")
        .select(COLUMNS)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(`version not read: ${error.message}`);
      return (data as VersionRow | null) ?? null;
    },
    async insert(row: NewVersion) {
      const { data, error } = await db
        .rpc("save_version", {
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
          p_free_field: row.free_field,
          p_unexpressed: row.unexpressed,
        })
        .select(COLUMNS)
        .single();
      if (error || !data) throw new Error(`version not saved: ${error?.message}`);
      return data as VersionRow;
    },
  };
}
