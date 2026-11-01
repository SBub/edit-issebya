import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseVersionStore } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { WorkerConfig } from "./config.ts";
import { decide } from "./decide/decide.ts";
import { type ClaimedJob, failJob, finishJob, renewLease } from "./queue.ts";
import { recordPreviewCopies } from "./pipeline/record-preview-copies.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { firstVersion } from "./steps/first-version.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { supabaseStepStore } from "./step-store.ts";
import { type Telemetry, endJobSpan, startJobSpan } from "./telemetry.ts";

// Wires one claimed job to the database, storage and telemetry: the job span,
// the fixed pipeline steps, the first version and the decide step (the AI's
// edit, saved as the next version) under a kept lease, then the job's final
// write.
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
        const { fingerprints } = await runPipeline({
          ctx,
          storage,
          keyPrefix: config.keyPrefix,
          scratchDir: config.scratchDir,
          tools: toolPaths(),
        });
        await recordPreviewCopies(ctx, fingerprints);
        const versions = supabaseVersionStore(db);
        await firstVersion({
          ctx,
          storage,
          keyPrefix: config.keyPrefix,
          fingerprints,
          versions,
        });
        await decide({
          ctx,
          storage,
          keyPrefix: config.keyPrefix,
          scratchDir: config.scratchDir,
          fingerprints,
          versions,
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
