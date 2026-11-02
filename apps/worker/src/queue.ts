import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";

export interface ClaimedJob {
  id: string;
  reel_id: string;
  owner_id: string;
  kind: string;
  attempts: number;
  // A `change` job's request (null for every other kind).
  request: string | null;
  // The version a `restore` job goes back to (null for every other kind).
  restore_version_id: string | null;
  // The version a `render` job exports (null for every other kind).
  version_id: string | null;
  // The failed job this one retries (the owner's Retry), or null.
  retry_of_job_id?: string | null;
}

// How long a job whose AI is not available waits before it is taken again.
export const AI_RETRY_MINUTES = 15;

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

// The periodic check reads only ids: queued jobs, jobs waiting for the AI
// past their `not_before`, or running ones whose lease has expired.
export async function claimableJobIds(db: SupabaseClient): Promise<string[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("jobs")
    .select("id")
    .or(
      `status.eq.queued,and(status.eq.waiting_ai,not_before.lt.${now}),and(status.eq.running,lease_expires_at.lt.${now})`,
    )
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
  // null: the reel's status stays as it is (a change, restore or render job).
  outcome: {
    job: "done" | "failed";
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

// Only a `process` job moves the reel's status. A change, restore or render
// job runs on a processed reel and leaves it processed whatever happens: a
// failed change keeps the reel usable and its current version untouched, a
// failed render leaves the reel as it was.
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

// The footage cannot be used: the job fails with the message as its tail and
// the reel is `refused` with it, guarded by the lease like endJob.
export async function refuseJob(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  message: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("jobs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error_tail: message,
      lease_expires_at: null,
    })
    .eq("id", job.id)
    .eq("lease_holder", config.workerId)
    .eq("status", "running")
    .select("id");
  if (error) throw new Error(`job not refused: ${error.message}`);
  if ((data ?? []).length !== 1) return false;
  const reel = await db
    .from("reels")
    .update({ status: "refused", refusal_message: message })
    .eq("id", job.reel_id);
  if (reel.error) throw new Error(`reel not refused: ${reel.error.message}`);
  return true;
}

// The AI is not available: the job waits with its reason, its lease given up,
// and claim_job skips it until `not_before`. The reel's status stays as it is.
export async function waitJob(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  reason: string,
  now: Date = new Date(),
): Promise<boolean> {
  const { data, error } = await db
    .from("jobs")
    .update({
      status: "waiting_ai",
      waiting_reason: reason,
      not_before: new Date(now.getTime() + AI_RETRY_MINUTES * 60_000).toISOString(),
      lease_expires_at: null,
      lease_holder: null,
    })
    .eq("id", job.id)
    .eq("lease_holder", config.workerId)
    .eq("status", "running")
    .select("id");
  if (error) throw new Error(`job not set waiting: ${error.message}`);
  return (data ?? []).length === 1;
}
