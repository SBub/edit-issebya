import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkerConfig } from "./config.ts";
import { dbFailure } from "./failures.ts";

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
  // The failed job this one retries (the owner's Retry button), else null.
  retry_of_job_id: string | null;
  // Cleared by claim_job; read only.
  waiting_reason: string | null;
  not_before: string | null;
}

// How long a job waits for the AI before its next try (app_docs/failures.md).
export const AI_RETRY_AFTER_SECONDS = 15 * 60;

type QueueConfig = Pick<WorkerConfig, "workerId" | "leaseSeconds">;

// The oldest claimable job, now leased to this worker; null when none.
export async function claimJob(
  db: SupabaseClient,
  config: QueueConfig,
): Promise<ClaimedJob | null> {
  const { data, error, status } = await db.rpc("claim_job", {
    p_worker: config.workerId,
    p_lease_seconds: config.leaseSeconds,
  });
  if (error) throw dbFailure("claim_job failed", { error, status });
  const rows = (data ?? []) as ClaimedJob[];
  return rows[0] ?? null;
}

// The filter of the periodic check: queued jobs, running ones whose lease has
// expired, and waiting ones whose next try has come.
export function claimableFilter(now: Date): string {
  const at = now.toISOString();
  return [
    "status.eq.queued",
    `and(status.eq.running,lease_expires_at.lt.${at})`,
    `and(status.eq.waiting_ai,not_before.lte.${at})`,
  ].join(",");
}

// The periodic check reads only ids. claim_job decides which job is next (one
// per reel, in order); this only wakes the worker.
export async function claimableJobIds(db: SupabaseClient): Promise<string[]> {
  const { data, error, status } = await db
    .from("jobs")
    .select("id")
    .or(claimableFilter(new Date()))
    .limit(1);
  if (error) throw dbFailure("jobs not checked", { error, status });
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
  const { data, error, status } = await db
    .from("jobs")
    .update({ lease_expires_at: leaseUntil(config) })
    .eq("id", jobId)
    .eq("lease_holder", config.workerId)
    .eq("status", "running")
    .select("id");
  if (error) throw dbFailure("lease not renewed", { error, status });
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
  const { data, error, status } = await db
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
  if (error) throw dbFailure("job not ended", { error, status });
  // Another worker holds the lease now: leave the reel to it.
  if ((data ?? []).length !== 1) return false;
  if (outcome.reel === null) return true;
  const reel = await db.from("reels").update({ status: outcome.reel }).eq("id", job.reel_id);
  if (reel.error) throw dbFailure("reel not updated", reel);
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

// A refused clip: the job fails with the owner's message as its tail, and the
// reel becomes `refused` with the same message. False when the lease is lost.
export async function refuseJob(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  message: string,
): Promise<boolean> {
  const { data, error, status } = await db
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
  if (error) throw dbFailure("job not refused", { error, status });
  if ((data ?? []).length !== 1) return false;
  const reel = await db
    .from("reels")
    .update({ status: "refused", refusal_message: message })
    .eq("id", job.reel_id);
  if (reel.error) throw dbFailure("reel not refused", reel);
  return true;
}

// The AI cannot answer now: the job waits with its reason, its next try
// counted by the database clock. False when the lease is lost.
export async function waitForAi(
  db: SupabaseClient,
  config: QueueConfig,
  job: ClaimedJob,
  reason: string,
): Promise<boolean> {
  const { data, error, status } = await db.rpc("wait_for_ai", {
    p_job_id: job.id,
    p_worker: config.workerId,
    p_reason: reason,
    p_retry_after_seconds: AI_RETRY_AFTER_SECONDS,
  });
  if (error) throw dbFailure("job not set waiting", { error, status });
  return data === true;
}
