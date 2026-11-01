import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedJob } from "./queue.ts";

// What the step runner measured; null where a step has no such measurement
// (an in-process step has wall time only).
export interface StepMeasurements {
  wall_ms: number;
  cpu_ms: number | null;
  peak_rss_bytes: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
}

// The reel statuses the pipeline writes (one per step); the job's end writes
// processed or failed.
export type PipelineReelStatus = "converting" | "transcribing" | "retiming";

// The writes a step makes, behind an interface so steps are tested without a
// database.
export interface StepStore {
  start(job: ClaimedJob, name: string): Promise<string>;
  // A cache hit: one finished row, status skipped, cache_hit true, wall time only.
  skipped(job: ClaimedJob, name: string, summary: string, wallMs: number): Promise<void>;
  reelStatus(reelId: string, status: PipelineReelStatus): Promise<void>;
  sourceKey(reelId: string): Promise<string | null>;
  done(stepId: string, summary: string, measurements: StepMeasurements): Promise<void>;
  failed(
    stepId: string,
    errorTail: string,
    summary: string,
    measurements: StepMeasurements,
  ): Promise<void>;
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
    async skipped(job, name, summary, wallMs) {
      const { error } = await db.from("steps").insert({
        job_id: job.id,
        reel_id: job.reel_id,
        owner_id: job.owner_id,
        name,
        status: "skipped",
        cache_hit: true,
        summary,
        finished_at: new Date().toISOString(),
        wall_ms: wallMs,
        cpu_ms: null,
        peak_rss_bytes: null,
        bytes_in: null,
        bytes_out: null,
      });
      if (error) throw new Error(`step not recorded: ${error.message}`);
    },
    async reelStatus(reelId, status) {
      const { error } = await db.from("reels").update({ status }).eq("id", reelId);
      if (error) throw new Error(`reel not updated: ${error.message}`);
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
    async done(stepId, summary, measurements) {
      const { error } = await db
        .from("steps")
        .update({
          status: "done",
          summary,
          finished_at: new Date().toISOString(),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw new Error(`step not finished: ${error.message}`);
    },
    async failed(stepId, tail, summary, measurements) {
      const { error } = await db
        .from("steps")
        .update({
          status: "failed",
          error_tail: tail,
          summary,
          finished_at: new Date().toISOString(),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw new Error(`step not failed: ${error.message}`);
    },
  };
}
