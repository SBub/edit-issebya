import type { SupabaseClient } from "@supabase/supabase-js";

// The small admin reads specs share now that the reel page no longer shows
// the reel's machine status, the jobs list or the step log
// (app_docs/status.md): read through `expect.poll` where a value changes live.

export interface JobRecord {
  id: string;
  kind: string;
  status: string;
  request: string | null;
  retry_of_job_id: string | null;
  failure_kind: string | null;
  failure_rules: string[] | null;
  waiting_reason: string | null;
  not_before: string | null;
}

export interface StepLine {
  job_id: string;
  name: string;
  status: string;
  summary: string | null;
}

/** The reel's status column. */
export async function reelStatus(admin: SupabaseClient, reelId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("reels")
    .select("status")
    .eq("id", reelId)
    .maybeSingle<{ status: string }>();
  if (error) throw new Error(`reel not read: ${error.message}`);
  return data?.status ?? null;
}

/** The reel's jobs, oldest first. */
export async function jobsOf(admin: SupabaseClient, reelId: string): Promise<JobRecord[]> {
  const { data, error } = await admin
    .from("jobs")
    .select(
      "id, kind, status, request, retry_of_job_id, failure_kind, failure_rules, waiting_reason, not_before",
    )
    .eq("reel_id", reelId)
    .order("created_at")
    .order("id");
  if (error) throw new Error(`jobs not read: ${error.message}`);
  return (data ?? []) as JobRecord[];
}

/** The reel's step rows, in start order. */
export async function stepLines(admin: SupabaseClient, reelId: string): Promise<StepLine[]> {
  const { data, error } = await admin
    .from("steps")
    .select("job_id, name, status, summary")
    .eq("reel_id", reelId)
    .order("started_at")
    .order("id");
  if (error) throw new Error(`steps not read: ${error.message}`);
  return (data ?? []) as StepLine[];
}
