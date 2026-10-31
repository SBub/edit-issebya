import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { errorTail } from "../errors.ts";
import { receivedSummary } from "../format.ts";
import type { ClaimedJob } from "../queue.ts";

// The writes a step makes, behind an interface so the step is tested without
// a database.
export interface StepStore {
  start(job: ClaimedJob, name: string): Promise<string>;
  sourceKey(reelId: string): Promise<string | null>;
  done(stepId: string, summary: string): Promise<void>;
  failed(stepId: string, errorTail: string): Promise<void>;
}

export function supabaseStepStore(db: SupabaseClient): StepStore {
  return {
    async start(job, name) {
      const { data, error } = await db
        .from("steps")
        .insert({
          job_id: job.id,
          reel_id: job.reel_id,
          owner_id: job.owner_id,
          name,
          status: "running",
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`step not started: ${error?.message}`);
      return (data as { id: string }).id;
    },
    async sourceKey(reelId) {
      const { data, error } = await db
        .from("reels")
        .select("source_key")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw new Error(`reel not read: ${error.message}`);
      return (data as { source_key: string | null } | null)?.source_key ?? null;
    },
    async done(stepId, summary) {
      const { error } = await db
        .from("steps")
        .update({ status: "done", summary, finished_at: new Date().toISOString() })
        .eq("id", stepId);
      if (error) throw new Error(`step not finished: ${error.message}`);
    },
    async failed(stepId, tail) {
      const { error } = await db
        .from("steps")
        .update({ status: "failed", error_tail: tail, finished_at: new Date().toISOString() })
        .eq("id", stepId);
      if (error) throw new Error(`step not failed: ${error.message}`);
    },
  };
}

// The placeholder step: confirms the source object is in storage and records
// its size. After an abort (lost lease) it writes nothing more.
export async function receive({
  steps,
  storage,
  job,
  signal,
}: {
  steps: StepStore;
  storage: Storage;
  job: ClaimedJob;
  signal: AbortSignal;
}): Promise<void> {
  signal.throwIfAborted();
  const stepId = await steps.start(job, "receive");
  try {
    const key = await steps.sourceKey(job.reel_id);
    if (!key) throw new Error("reel has no source key");
    const object = await storage.head(key, { signal });
    signal.throwIfAborted();
    if (!object) throw new Error("source object missing");
    await steps.done(stepId, receivedSummary(object.bytes));
  } catch (error) {
    if (!signal.aborted) await steps.failed(stepId, errorTail(error));
    throw error;
  }
}
