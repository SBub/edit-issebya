import type { SupabaseClient } from "@supabase/supabase-js";

export interface NewExport {
  id: string;
  reel_id: string;
  owner_id: string;
  job_id: string;
  version_id: string;
  r2_key: string;
  bytes: number;
}

// The `exports` rows, written only by the worker (service role).
export interface ExportStore {
  // The export a job already made (a retried job), or null.
  forJob(jobId: string): Promise<string | null>;
  // created_at and expires_at come from the database (expires_at and
  // owner_id are set by its trigger whatever is passed).
  insert(row: NewExport): Promise<void>;
}

export function supabaseExportStore(db: SupabaseClient): ExportStore {
  return {
    async forJob(jobId) {
      const { data, error } = await db
        .from("exports")
        .select("id")
        .eq("job_id", jobId)
        .maybeSingle();
      if (error) throw new Error(`export not read: ${error.message}`);
      return (data as { id: string } | null)?.id ?? null;
    },
    async insert(row) {
      const { error } = await db.from("exports").insert({
        id: row.id,
        reel_id: row.reel_id,
        owner_id: row.owner_id,
        job_id: row.job_id,
        version_id: row.version_id,
        r2_key: row.r2_key,
        bytes: row.bytes,
      });
      if (error) throw new Error(`export not recorded: ${error.message}`);
    },
  };
}
