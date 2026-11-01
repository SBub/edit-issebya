import { type Edit, type VersionRows, saveVersion } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";

// The version rows through the service-role client, the way the worker saves
// them: the save_version function (named columns, never `*`).
function adminVersionRows(admin: SupabaseClient): VersionRows {
  return {
    async current(reelId) {
      const { data, error } = await admin
        .from("reels")
        .select("current_version_id")
        .eq("id", reelId)
        .single();
      if (error) throw new Error(`current version not read: ${error.message}`);
      return (data as { current_version_id: string | null }).current_version_id;
    },
    async get(id) {
      const { data, error } = await admin
        .from("versions")
        .select("id, reel_id, number, parent_id, restored_from_id, checks, inputs, r2_key")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`version not read: ${error.message}`);
      return data ?? null;
    },
    async save(row) {
      const { data, error } = await admin.rpc("save_version", {
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
      });
      if (error) throw new Error(`version not saved: ${error.message}`);
      return data as number;
    },
  };
}

// A new current version of the reel holding `edit`, its parent the current
// one, its blob written to the storage double. Returns its id and key for the
// spec's checks and cleanup.
export async function saveTestVersion({
  admin,
  storage,
  prefix,
  reelId,
  edit,
  changeSummary,
}: {
  admin: SupabaseClient;
  storage: Storage;
  prefix: string;
  reelId: string;
  edit: Edit;
  changeSummary: string;
}): Promise<{ id: string; key: string }> {
  const rows = adminVersionRows(admin);
  const saved = await saveVersion(
    {
      rows,
      blobs: {
        get: (key) => storage.get(key),
        putIfAbsent: (key, bytes) =>
          storage.putIfAbsent(key, bytes, { contentType: "application/json" }),
      },
      keyPrefix: prefix,
      newId: () => crypto.randomUUID(),
    },
    {
      reelId,
      parentId: await rows.current(reelId),
      restoredFromId: null,
      request: null,
      model: null,
      promptVersion: null,
      changeSummary,
      checks: [],
      edit,
    },
  );
  return { id: saved.id, key: saved.key };
}
