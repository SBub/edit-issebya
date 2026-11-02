import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClaimedJob } from "./queue.ts";
import { dbFailure } from "./failures.ts";

// What the step runner measured; null where a step has no such measurement
// (an in-process step has wall time only).
export interface StepMeasurements {
  wall_ms: number;
  cpu_ms: number | null;
  peak_rss_bytes: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  // An AI step's usage as Claude Code reported it; absent on every other step.
  ai_input_tokens?: number | null;
  ai_output_tokens?: number | null;
  ai_cost_usd?: number | null;
  ai_model?: string | null;
}

// What one or more AI calls used, raw as reported (null where not reported).
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  model: string | null;
}

export function aiMeasurements(usage: AiUsage): Partial<StepMeasurements> {
  return {
    ai_input_tokens: usage.inputTokens,
    ai_output_tokens: usage.outputTokens,
    ai_cost_usd: usage.costUsd,
    ai_model: usage.model,
  };
}

// The reel statuses the pipeline writes (one per step); the job's end writes
// processed or failed.
export type PipelineReelStatus =
  | "checking_footage"
  | "converting"
  | "transcribing"
  | "retiming"
  | "removing_background"
  | "tracking_head"
  | "making_previews";

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
  // The step needs the AI and the AI cannot answer now: the row waits with the job.
  waiting(stepId: string, summary: string, measurements: StepMeasurements): Promise<void>;
}

export function supabaseStepStore(db: SupabaseClient): StepStore {
  return {
    async start(job, name) {
      const { data, error, status } = await db
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
      if (error || !data) throw dbFailure("step not started", { error, status });
      return (data as { id: string }).id;
    },
    async skipped(job, name, summary, wallMs) {
      const { error, status } = await db.from("steps").insert({
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
      if (error) throw dbFailure("step not recorded", { error, status });
    },
    async reelStatus(reelId, status) {
      const result = await db.from("reels").update({ status }).eq("id", reelId);
      if (result.error) throw dbFailure("reel not updated", result);
    },
    async sourceKey(reelId) {
      const { data, error, status } = await db
        .from("reels")
        .select("source_key")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw dbFailure("reel not read", { error, status });
      return (data as { source_key: string | null } | null)?.source_key ?? null;
    },
    async done(stepId, summary, measurements) {
      const { error, status } = await db
        .from("steps")
        .update({
          status: "done",
          summary,
          finished_at: new Date().toISOString(),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw dbFailure("step not finished", { error, status });
    },
    async failed(stepId, tail, summary, measurements) {
      const { error, status } = await db
        .from("steps")
        .update({
          status: "failed",
          error_tail: tail,
          summary,
          finished_at: new Date().toISOString(),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw dbFailure("step not failed", { error, status });
    },
    async waiting(stepId, summary, measurements) {
      const { error, status } = await db
        .from("steps")
        .update({
          status: "waiting_ai",
          summary,
          finished_at: new Date().toISOString(),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw dbFailure("step not marked waiting", { error, status });
    },
  };
}
