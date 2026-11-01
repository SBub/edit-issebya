import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";

export interface ClaimedJob {
  id: string;
  reel_id: string;
  owner_id: string;
  kind: string;
  attempts: number;
  // A change job's words; null for every other kind.
  request: string | null;
  // The version a restore job copies; null for every other kind.
  restore_version_id: string | null;
  // The version a render job exports; null for every other kind.
  version_id: string | null;
}

type QueueConfig = Pick<WorkerConfig, "workerId" | "leaseSeconds">;

// The oldest claimable job, now leased to this worker; null when none.
export async function claimJob(
  db: SupabaseClient,
  config: QueueConfig,
): Promise<ClaimedJob | null> {
  const { data, error } = await db.rpc("claim_job", {
    p_worker: config.workerId,
    p_lease_seconds: config.leaseSeconds,
  });
  if (error) throw new Error(`claim_job failed: ${error.message}`);
  const rows = (data ?? []) as ClaimedJob[];
  return rows[0] ?? null;
}

// The periodic check reads only ids: queued jobs, or running ones whose lease
// has expired.
export async function claimableJobIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db
    .from("jobs")
    .select("id")
    .or(`status.eq.queued,and(status.eq.running,lease_expires_at.lt.${new Date().toISOString()})`)
    .limit(1);
  if (error) throw new Error(`jobs not checked: ${error.message}`);
  return (data ?? []).map((row: { id: string }) => row.id);
}

function leaseUntil(config: QueueConfig): string {
  return new Date(Date.now() + config.leaseSeconds * 1000).toISOString();
}

// True only while this worker still holds the running job's lease.
export async function renewLease(
  db: SupabaseClient,
  config: QueueConfig,
  jobId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("jobs")
    .update({ lease_expires_at: leaseUntil(config) })
    .eq("id", jobId)
    .eq("lease_holder", config.workerId)
    .eq("status", "running")
    .select("id");
  if (error) throw new Error(`lease not renewed: ${error.message}`);
  return (data ?? []).length === 1;
}

async function endJob(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  outcome: {
    job: "done" | "failed";
    // null leaves the reel's status as it is.
    reel: "processed" | "failed" | null;
    errorTail: string | null;
  },
): Promise<boolean> {
  const { data, error } = await db
    .from("jobs")
    .update({
      status: outcome.job,
      finished_at: new Date().toISOString(),
      error_tail: outcome.errorTail,
      lease_expires_at: null,
    })
    .eq("id", job.id)
    .eq("lease_holder", config.workerId)
    .eq("status", "running")
    .select("id");
  if (error) throw new Error(`job not ended: ${error.message}`);
  // Another worker holds the lease now: leave the reel to it.
  if ((data ?? []).length !== 1) return false;
  if (outcome.reel === null) return true;
  const reel = await db.from("reels").update({ status: outcome.reel }).eq("id", job.reel_id);
  if (reel.error) throw new Error(`reel not updated: ${reel.error.message}`);
  return true;
}

// Only a process job moves the reel's status: a change, restore or render
// never does, so a failed change or export leaves the reel processed on its
// current version.
function reelStatusAfter(job: ClaimedJob, status: "processed" | "failed") {
  return job.kind === "process" ? status : null;
}

export function finishJob(db: SupabaseClient, config: QueueConfig, job: ClaimedJob) {
  return endJob(db, config, job, {
    job: "done",
    reel: reelStatusAfter(job, "processed"),
    errorTail: null,
  });
}

export function failJob(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  errorTail: string,
) {
  return endJob(db, config, job, {
    job: "failed",
    reel: reelStatusAfter(job, "failed"),
    errorTail,
  });
}
