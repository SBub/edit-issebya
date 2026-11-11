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
  // An AI step's usage as OpenRouter reported it; absent on every other step.
  ai_input_tokens?: number | null;
  ai_output_tokens?: number | null;
  ai_cost_usd?: number | null;
  ai_model?: string | null;
}

// What one or more AI calls used, raw as reported (null where not reported).
// `inputTokens` counts every input token (fresh, cache writes, cache reads);
// the two cache counts are its parts, read for the trace only: the step row
// stores `aiMeasurements`, which never includes them.
export interface AiUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  model: string | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

// Two calls' usage summed (null only where neither reported it); the model is
// the later call's when it names one.
export function addUsage(total: AiUsage, usage: AiUsage): AiUsage {
  const sum = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);
  return {
    inputTokens: sum(total.inputTokens, usage.inputTokens),
    outputTokens: sum(total.outputTokens, usage.outputTokens),
    costUsd: sum(total.costUsd, usage.costUsd),
    model: usage.model ?? total.model,
    cacheReadTokens: sum(total.cacheReadTokens, usage.cacheReadTokens),
    cacheWriteTokens: sum(total.cacheWriteTokens, usage.cacheWriteTokens),
  };
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
  | "tracking_head"
  | "making_previews";

// The writes a step makes, behind an interface so steps are tested without a
// database.
// Every row's times come from the worker: `startedAt` is the instant the step
// (or the attempt) started, and a finished row ends `wall_ms` after it, so the
// row, its span and its wall time always agree.
function finishedAt(startedAt: Date, wallMs: number): string {
  return new Date(startedAt.getTime() + wallMs).toISOString();
}

export interface StepStore {
  start(job: ClaimedJob, name: string, startedAt: Date): Promise<string>;
  // A cache hit: one finished row, status skipped, cache_hit true, wall time only.
  skipped(
    job: ClaimedJob,
    name: string,
    summary: string,
    wallMs: number,
    startedAt: Date,
  ): Promise<void>;
  reelStatus(reelId: string, status: PipelineReelStatus): Promise<void>;
  sourceKey(reelId: string): Promise<string | null>;
  done(
    stepId: string,
    summary: string,
    measurements: StepMeasurements,
    startedAt: Date,
  ): Promise<void>;
  // A long step's progress (0 to 100) on its own running row.
  progress(stepId: string, percent: number): Promise<void>;
  // The reel's retimed footage length in seconds, null until recorded.
  footageSeconds(reelId: string): Promise<number | null>;
  // Sets it only while the reel has none.
  recordFootageSeconds(reelId: string, seconds: number): Promise<void>;
  // The source's length and display size from check_footage, set only while
  // the reel has none.
  recordSourceSize(
    reelId: string,
    size: { seconds: number; width: number; height: number },
  ): Promise<void>;
  // The transcript's word count after retime, set only while the reel has none.
  recordWordCount(reelId: string, count: number): Promise<void>;
  failed(
    stepId: string,
    errorTail: string,
    summary: string,
    measurements: StepMeasurements,
    startedAt: Date,
  ): Promise<void>;
  // The AI is not available: the row is `waiting`, its tail the reason.
  waiting(
    stepId: string,
    reason: string,
    summary: string,
    measurements: StepMeasurements,
    startedAt: Date,
  ): Promise<void>;
  // A job taken again after its worker stopped: every row it left `running`
  // ends `failed`.
  abandonRunning(jobId: string): Promise<void>;
}

const ABANDONED_TAIL = "the worker stopped during this step; the job was taken again";

export function supabaseStepStore(db: SupabaseClient): StepStore {
  return {
    async start(job, name, startedAt) {
      const { data, error } = await db
        .from("steps")
        .insert({
          job_id: job.id,
          reel_id: job.reel_id,
          photo_id: job.photo_id,
          owner_id: job.owner_id,
          name,
          status: "running",
          started_at: startedAt.toISOString(),
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`step not started: ${error?.message}`);
      return (data as { id: string }).id;
    },
    async skipped(job, name, summary, wallMs, startedAt) {
      const { error } = await db.from("steps").insert({
        job_id: job.id,
        reel_id: job.reel_id,
        photo_id: job.photo_id,
        owner_id: job.owner_id,
        name,
        status: "skipped",
        cache_hit: true,
        summary,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt(startedAt, wallMs),
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
    async progress(stepId, percent) {
      const { error } = await db
        .from("steps")
        .update({ progress_percent: percent, progress_updated_at: new Date().toISOString() })
        .eq("id", stepId);
      if (error) throw new Error(`step progress not written: ${error.message}`);
    },
    async footageSeconds(reelId) {
      const { data, error } = await db
        .from("reels")
        .select("footage_seconds")
        .eq("id", reelId)
        .maybeSingle();
      if (error) throw new Error(`reel not read: ${error.message}`);
      const raw = (data as { footage_seconds: number | string | null } | null)?.footage_seconds;
      return raw === null || raw === undefined ? null : Number(raw);
    },
    async recordFootageSeconds(reelId, seconds) {
      const { error } = await db
        .from("reels")
        .update({ footage_seconds: seconds })
        .eq("id", reelId)
        .is("footage_seconds", null);
      if (error) throw new Error(`footage seconds not recorded: ${error.message}`);
    },
    async recordSourceSize(reelId, { seconds, width, height }) {
      const { error } = await db
        .from("reels")
        .update({ source_seconds: seconds, source_width: width, source_height: height })
        .eq("id", reelId)
        .is("source_seconds", null);
      if (error) throw new Error(`source size not recorded: ${error.message}`);
    },
    async recordWordCount(reelId, count) {
      const { error } = await db
        .from("reels")
        .update({ word_count: count })
        .eq("id", reelId)
        .is("word_count", null);
      if (error) throw new Error(`word count not recorded: ${error.message}`);
    },
    async done(stepId, summary, measurements, startedAt) {
      const { error } = await db
        .from("steps")
        .update({
          status: "done",
          summary,
          finished_at: finishedAt(startedAt, measurements.wall_ms),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw new Error(`step not finished: ${error.message}`);
    },
    async failed(stepId, tail, summary, measurements, startedAt) {
      const { error } = await db
        .from("steps")
        .update({
          status: "failed",
          error_tail: tail,
          summary,
          finished_at: finishedAt(startedAt, measurements.wall_ms),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw new Error(`step not failed: ${error.message}`);
    },
    async waiting(stepId, reason, summary, measurements, startedAt) {
      const { error } = await db
        .from("steps")
        .update({
          status: "waiting",
          error_tail: reason,
          summary,
          finished_at: finishedAt(startedAt, measurements.wall_ms),
          ...measurements,
        })
        .eq("id", stepId);
      if (error) throw new Error(`step not marked waiting: ${error.message}`);
    },
    async abandonRunning(jobId) {
      const { error } = await db
        .from("steps")
        .update({
          status: "failed",
          error_tail: ABANDONED_TAIL,
          finished_at: new Date().toISOString(),
        })
        .eq("job_id", jobId)
        .eq("status", "running");
      if (error) throw new Error(`abandoned steps not closed: ${error.message}`);
    },
  };
}
