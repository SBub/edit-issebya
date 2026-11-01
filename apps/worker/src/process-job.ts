import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import type { WorkerConfig } from "./config.ts";
import { type ClaimedJob, failJob, finishJob, renewLease } from "./queue.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { runInScratch } from "./scratch.ts";
import { supabaseStepStore } from "./step-store.ts";
import { receive } from "./steps/receive.ts";
import { recordedStorage, supabaseStoredFileStore } from "./stored-files.ts";
import { type Telemetry, endJobSpan, startJobSpan } from "./telemetry.ts";

// Wires one claimed job to the database, storage and telemetry: the job span,
// the `receive` step under a kept lease in the job's own scratch directory,
// then the job's final write. Steps write to storage only through
// recordedStorage, which records a stored_files row for every put.
export async function processJob(
  db: SupabaseClient,
  storage: Storage,
  config: WorkerConfig,
  telemetry: Telemetry,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const steps = supabaseStepStore(db);
  const files = recordedStorage(storage, supabaseStoredFileStore(db), job);
  const { span, context: jobContext } = startJobSpan(telemetry, job);
  let outcome: JobOutcome = "failed";
  try {
    // The directory goes after finish or fail, and after a lost lease.
    return await runInScratch(
      { root: config.scratchDir, jobId: job.id, log: console.log },
      async (scratch) => {
        outcome = await runJob({
          job,
          renewEveryMs: config.renewEveryMs,
          renew: () => renewLease(db, config, job.id),
          work: (signal) =>
            receive({ steps, storage: files, telemetry, jobContext, job, signal, scratch }),
          finish: () => finishJob(db, config, job),
          fail: (tail) => failJob(db, config, job, tail),
        });
        return outcome;
      },
    );
  } finally {
    endJobSpan(span, outcome);
  }
}
