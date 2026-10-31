import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import type { WorkerConfig } from "./config.ts";
import { type ClaimedJob, failJob, finishJob, renewLease } from "./queue.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { receive, supabaseStepStore } from "./steps/receive.ts";

// Wires one claimed job to the database and storage: the `receive` step under
// a kept lease, then the job's final write.
export function processJob(
  db: SupabaseClient,
  storage: Storage,
  config: WorkerConfig,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const steps = supabaseStepStore(db);
  return runJob({
    job,
    renewEveryMs: config.renewEveryMs,
    renew: () => renewLease(db, config, job.id),
    work: (signal) => receive({ steps, storage, job, signal }),
    finish: () => finishJob(db, config, job),
    fail: (tail) => failJob(db, config, job, tail),
  });
}
