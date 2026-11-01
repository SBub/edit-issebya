import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { aiRunner } from "./ai.ts";
import type { WorkerConfig } from "./config.ts";
import { runDecide } from "./decide/run-decide.ts";
import { saveFirstVersion } from "./first-version.ts";
import { runJobKind } from "./job-kinds.ts";
import { type ClaimedJob, failJob, finishJob, renewLease } from "./queue.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { previewCopiesRefs, recordPreviewCopies } from "./preview-copies-record.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { runRestore } from "./restore-step.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { supabaseStepStore } from "./step-store.ts";
import { type Telemetry, endJobSpan, startJobSpan } from "./telemetry.ts";
import { storageVersionBlobs, supabaseVersionRows } from "./version-store.ts";

// Wires one claimed job to the database, storage and telemetry: the job span,
// the job's work by kind under a kept lease, then the job's final write. A
// `process` job runs the fixed pipeline steps, the preview copies' location,
// the first version and the decide step; a `change` job only the decide step
// with the owner's request; a `restore` job only the restore step. Only a
// `process` job moves the reel's status (queue.ts).
export async function processJob(
  db: SupabaseClient,
  storage: Storage,
  config: WorkerConfig,
  telemetry: Telemetry,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const steps = supabaseStepStore(db);
  const { span, context: jobContext } = startJobSpan(telemetry, job);
  let outcome: JobOutcome = "failed";
  try {
    outcome = await runJob({
      job,
      renewEveryMs: config.renewEveryMs,
      renew: () => renewLease(db, config, job.id),
      async work(signal) {
        const ctx = { steps, telemetry, jobContext, job, signal };
        const rows = supabaseVersionRows(db);
        const blobs = storageVersionBlobs(storage);
        const decide = (request: string | null) =>
          runDecide({
            ctx,
            storage,
            rows,
            blobs,
            keyPrefix: config.keyPrefix,
            ai: aiRunner(process.env),
            scratchDir: config.scratchDir,
            request,
          });
        await runJobKind(job, {
          async process() {
            const { fingerprints } = await runPipeline({
              ctx,
              storage,
              keyPrefix: config.keyPrefix,
              scratchDir: config.scratchDir,
              tools: toolPaths(),
            });
            // Before the first version, so a reel with a current version
            // already says where its preview copies are.
            await recordPreviewCopies(db, job.reel_id, previewCopiesRefs(fingerprints));
            await saveFirstVersion({
              ctx,
              storage,
              rows,
              blobs,
              keyPrefix: config.keyPrefix,
              fingerprints,
            });
            // Never cached: a failed decide fails the job and version 1 stays
            // current; a retried job decides again from the current version.
            await decide(null);
          },
          // The owner's words: decide alone, from the current version. A
          // second refusal fails the job and the current version stays.
          change: (request) => decide(request),
          restore: (versionId) =>
            runRestore({ ctx, rows, blobs, keyPrefix: config.keyPrefix, versionId }),
        });
      },
      finish: () => finishJob(db, config, job),
      fail: (tail) => failJob(db, config, job, tail),
    });
    return outcome;
  } finally {
    endJobSpan(span, outcome);
  }
}
