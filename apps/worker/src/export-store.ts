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

// The one write of an export, behind an interface so the render step is tested
// without a database. expires_at comes back from the row: the database sets
// it (created_at + 24 hours), never the worker.
export interface ExportStore {
  insert(row: NewExport): Promise<{ expires_at: string }>;
}

export function supabaseExportStore(db: SupabaseClient): ExportStore {
  return {
    async insert(row) {
      const { data, error } = await db.from("exports").insert(row).select("expires_at").single();
      if (error || !data) throw new Error(`exports row not inserted: ${error?.message}`);
      return data as { expires_at: string };
    },
  };
}
