"use server";

import { canRetry } from "@/lib/job-failures";
import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type RetryActionResult =
  | { status: "queued"; jobId: string }
  | { status: "blocked"; reason: string }
  | { status: "signed-out" }
  | { status: "failed" };

type RetriedJob = Pick<
  JobRow,
  "id" | "reel_id" | "kind" | "status" | "request" | "restore_version_id" | "version_id"
>;

// Postgres' unique violation: the failed job already has its retry.
const UNIQUE_VIOLATION = "23505";

// Retries a failed job: a new job of the same kind and parameters naming it in
// `retry_of_job_id`. The job, the reel and the reel's jobs are read here under
// RLS (another owner's read as missing), the rule the button follows is
// checked again, and the database's trigger and unique index check it once
// more, so a stale tab or a double press queues one retry at most. Every step
// the failed job finished is a fingerprint hit, so the retry resumes at the
// step that failed (app_docs/failures.md).
export async function retryJob(input: {
  reelId: string;
  jobId: string;
}): Promise<RetryActionResult> {
  if (typeof input.reelId !== "string" || !isReelId(input.reelId)) return { status: "failed" };
  if (typeof input.jobId !== "string" || !isReelId(input.jobId)) return { status: "failed" };
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "failed" };
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: "signed-out" };

  const [reel, jobs] = await Promise.all([
    supabase
      .from("reels")
      .select("id, status")
      .eq("id", input.reelId)
      .maybeSingle<Pick<ReelDetail, "id" | "status">>(),
    supabase
      .from("jobs")
      .select("id, reel_id, kind, status, request, restore_version_id, version_id, retry_of_job_id")
      .eq("reel_id", input.reelId)
      .returns<(RetriedJob & Pick<JobRow, "retry_of_job_id">)[]>(),
  ]);
  if (reel.error || jobs.error) {
    console.error("studio: reel not read for a retry:", reel.error?.code ?? jobs.error?.code);
    return { status: "failed" };
  }
  const job = jobs.data?.find((candidate) => candidate.id === input.jobId);
  if (!reel.data || !job) return { status: "failed" };
  if (!canRetry(job, jobs.data ?? [], reel.data)) {
    return { status: "blocked", reason: "This job cannot be retried." };
  }

  // Under RLS: the kind's insert policy takes the owner from the session and
  // accepts only the caller's reel and that kind's parameters.
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      reel_id: job.reel_id,
      kind: job.kind,
      ...(job.request !== null ? { request: job.request } : {}),
      ...(job.restore_version_id !== null ? { restore_version_id: job.restore_version_id } : {}),
      ...(job.version_id !== null ? { version_id: job.version_id } : {}),
      retry_of_job_id: job.id,
    })
    .select("id")
    .single<{ id: string }>();
  if (error?.code === UNIQUE_VIOLATION) return { status: "blocked", reason: "already retried" };
  if (error || !data) {
    // Logged without the request text.
    console.error(`studio: ${job.kind} retry not queued:`, error?.code, error?.message);
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id };
}
