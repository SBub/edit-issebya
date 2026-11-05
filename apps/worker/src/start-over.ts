import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseFailure } from "./failure.ts";

// Start over (a temporary testing control, to be removed): the id of the
// reel's version 1, the captions-only first version a `start_over` job
// decides from. A reel without one fails the job.
export async function firstVersionId(db: SupabaseClient, reelId: string): Promise<string> {
  const { data, error, status } = await db
    .from("versions")
    .select("id")
    .eq("reel_id", reelId)
    .eq("number", 1)
    .maybeSingle();
  if (error) throw supabaseFailure("first version not read", { error, status });
  if (!data) throw new Error(`start_over: reel ${reelId} has no version 1`);
  return (data as { id: string }).id;
}
