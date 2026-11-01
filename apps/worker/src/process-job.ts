import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseVersionStore } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import type { WorkerConfig } from "./config.ts";
import { changeJob } from "./change-job.ts";
import { decide } from "./decide/decide.ts";
import { supabaseExportStore } from "./export-store.ts";
import { renderSpawnTool } from "./fake-render.ts";
import { type ClaimedJob, failJob, finishJob, renewLease } from "./queue.ts";
import { recordPreviewCopies } from "./pipeline/record-preview-copies.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { firstVersion } from "./steps/first-version.ts";
import { render } from "./steps/render.ts";
import { restore } from "./steps/restore.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { supabaseStepStore } from "./step-store.ts";
import { type Telemetry, endJobSpan, startJobSpan } from "./telemetry.ts";

// Wires one claimed job to the database, storage and telemetry: the job span,
// the work for the job's kind under a kept lease, then the job's final write.
// A process job runs the fixed pipeline steps, the first version and the
// decide step (the AI's edit, saved as the next version); a change job runs
// only decide, with the owner's request; a restore job copies an earlier
// version into a new one; a render job exports its pinned version as an MP4
// (rebuilding missing inputs first, never moving the reel's status).
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
        const versions = supabaseVersionStore(db);
        switch (job.kind) {
          case "process": {
            const { fingerprints } = await runPipeline({
              ctx,
              storage,
              keyPrefix: config.keyPrefix,
              scratchDir: config.scratchDir,
              tools: toolPaths(),
            });
            await recordPreviewCopies(ctx, fingerprints);
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
            return;
          }
          case "change":
            await changeJob({
              ctx,
              storage,
              keyPrefix: config.keyPrefix,
              scratchDir: config.scratchDir,
              versions,
              request: job.request,
            });
            return;
          case "restore":
            await restore({
              ctx,
              storage,
              keyPrefix: config.keyPrefix,
              versions,
              fromId: job.restore_version_id,
            });
            return;
          case "render":
            await render({
              ctx,
              storage,
              keyPrefix: config.keyPrefix,
              scratchDir: config.scratchDir,
              tools: toolPaths(),
              versions,
              exportsStore: supabaseExportStore(db),
              versionId: job.version_id,
              spawnTool: renderSpawnTool(process.env),
            });
            return;
          default:
            throw new Error(`unknown job kind: ${job.kind}`);
        }
      },
      finish: () => finishJob(db, config, job),
      fail: (tail) => failJob(db, config, job, tail),
    });
    return outcome;
  } finally {
    endJobSpan(span, outcome);
  }
}
