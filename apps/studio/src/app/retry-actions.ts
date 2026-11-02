"use server";

import type { JobRow } from "@/lib/jobs";
import { type ReelDetail, isReelId } from "@/lib/reels";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export type RetryActionResult =
  | { status: "queued"; jobId: string }
  | { status: "blocked"; reason: string }
  | { status: "already" }
  | { status: "signed-out" }
  | { status: "failed" };

type FailedJob = Pick<
  JobRow,
  "id" | "reel_id" | "kind" | "status" | "request" | "restore_version_id" | "version_id"
>;

// Queues a new job of the failed job's kind and parameters naming it in
// `retry_of_job_id`; every step before the one that failed is a fingerprint
// hit, so the new job resumes there. The reel and the job are read under RLS
// as the signed-in owner; the insert policies and the restrictive retry
// policy decide again, and the unique index lets one retry per failed job
// through (a double click answers `already`). Logs codes only.
export async function requestRetry(input: {
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

  const [reel, job] = await Promise.all([
    supabase
      .from("reels")
      .select("id, status")
      .eq("id", input.reelId)
      .maybeSingle<Pick<ReelDetail, "id" | "status">>(),
    supabase
      .from("jobs")
      .select("id, reel_id, kind, status, request, restore_version_id, version_id")
      .eq("id", input.jobId)
      .maybeSingle<FailedJob>(),
  ]);
  if (reel.error || job.error) {
    console.error("studio: job not read for a retry:", reel.error?.code ?? job.error?.code);
    return { status: "failed" };
  }
  if (!reel.data || !job.data || job.data.reel_id !== reel.data.id) return { status: "failed" };
  if (reel.data.status === "refused") {
    return { status: "blocked", reason: "This clip was refused; upload another clip." };
  }
  if (job.data.status !== "failed") {
    return { status: "blocked", reason: "Only a failed job can be retried." };
  }

  const failed = job.data;
  const row: Record<string, string> = {
    reel_id: failed.reel_id,
    kind: failed.kind,
    retry_of_job_id: failed.id,
  };
  if (failed.request !== null) row.request = failed.request;
  if (failed.restore_version_id !== null) row.restore_version_id = failed.restore_version_id;
  if (failed.version_id !== null) row.version_id = failed.version_id;

  const { data, error } = await supabase
    .from("jobs")
    .insert(row)
    .select("id")
    .single<{ id: string }>();
  if (error?.code === "23505") return { status: "already" };
  if (error || !data) {
    console.error("studio: retry not queued:", error?.code);
    return { status: "failed" };
  }
  return { status: "queued", jobId: data.id };
}
