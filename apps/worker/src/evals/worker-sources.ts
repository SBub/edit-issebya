import type { Storage } from "@edit-issebya/storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { RunSources, VersionRow } from "./curator-runs.ts";
import type { CuratorSources } from "./curator-input.ts";

const PAGE = 1000;
const ID_CHUNK = 100;

// The eval's sources over the worker's database and storage. Selects and gets
// only: it never inserts, updates, deletes or puts.
function workerRunSources(
  db: SupabaseClient,
  storage: Pick<Storage, "get">,
  keyPrefix: string,
): RunSources {
  return {
    async aiFiles() {
      const files: { reelId: string; key: string }[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from("stored_files")
          .select("reel_id, r2_key")
          .eq("step", "decide")
          .is("deleted_at", null)
          .not("reel_id", "is", null)
          .like("r2_key", "%.ai.json")
          .order("created_at")
          .order("id")
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`evals: reading stored_files: ${error.message}`);
        for (const row of data) {
          files.push({ reelId: String(row.reel_id), key: String(row.r2_key) });
        }
        if (data.length < PAGE) return files;
      }
    },
    async versions(ids) {
      const rows: VersionRow[] = [];
      for (let from = 0; from < ids.length; from += ID_CHUNK) {
        const { data, error } = await db
          .from("versions")
          .select("id, number, inputs")
          .in("id", ids.slice(from, from + ID_CHUNK));
        if (error) throw new Error(`evals: reading versions: ${error.message}`);
        for (const row of data) {
          const ref = (
            row.inputs as {
              transcript?: { step: string; fingerprint: string; file: string };
            } | null
          )?.transcript;
          if (!ref) continue;
          rows.push({
            id: String(row.id),
            number: Number(row.number),
            transcriptKey: cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file),
          });
        }
      }
      return rows;
    },
    async readJson(key) {
      const bytes = await storage.get(key);
      return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown) : null;
    },
  };
}

// The curator eval's sources: the judge eval's, and the latest version of a
// reel (its edit, transcript and head track keys). Selects only.
export function workerCuratorSources(
  db: SupabaseClient,
  storage: Pick<Storage, "get">,
  keyPrefix: string,
): CuratorSources {
  return {
    ...workerRunSources(db, storage, keyPrefix),
    async latestVersion(reelId) {
      const { data, error } = await db
        .from("versions")
        .select("id, number, r2_key, inputs")
        .eq("reel_id", reelId)
        .order("number", { ascending: false })
        .limit(1);
      if (error) throw new Error(`evals: reading the latest version: ${error.message}`);
      const row = data?.[0];
      if (!row) return null;
      const inputs = row.inputs as {
        transcript?: { step: string; fingerprint: string; file: string };
        head_track?: { step: string; fingerprint: string; file: string };
      } | null;
      if (!inputs?.transcript || !inputs.head_track) return null;
      const key = (ref: { step: string; fingerprint: string; file: string }) =>
        cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
      return {
        id: String(row.id),
        number: Number(row.number),
        editKey: String(row.r2_key),
        transcriptKey: key(inputs.transcript),
        headTrackKey: key(inputs.head_track),
      };
    },
  };
}
