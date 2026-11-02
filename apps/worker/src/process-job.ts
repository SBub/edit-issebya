import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { aiRunner } from "./ai.ts";
import type { WorkerConfig } from "./config.ts";
import { runDecide } from "./decide/run-decide.ts";
import { saveFirstVersion } from "./first-version.ts";
import { runJobKind } from "./job-kinds.ts";
import { type ClaimedJob, failJob, finishJob, refuseJob, renewLease, waitForAi } from "./queue.ts";
import { PIPELINE } from "./pipeline/definition.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { stepDoubles } from "./pipeline/step-double.ts";
import { previewCopiesRefs, recordPreviewCopies } from "./preview-copies-record.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { supabaseExportStore } from "./render/export-store.ts";
import { runRender } from "./render/render-step.ts";
import { runRestore } from "./restore-step.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { withJobScratch } from "./scratch.ts";
import { supabaseStepStore } from "./step-store.ts";
import { classifyKey, recordingStorage, supabaseStoredFiles } from "./stored-files.ts";
import { type Telemetry, endJobSpan, startJobSpan } from "./telemetry.ts";
import { storageVersionBlobs, supabaseVersionRows } from "./version-store.ts";

// Wires one claimed job to the database, storage and telemetry: the job span,
// the job's work by kind under a kept lease, then the job's final write. A
// `process` job runs the fixed pipeline steps, the preview copies' location,
// the first version and the decide step; a `change` job only the decide step
// with the owner's request; a `restore` job only the restore step; a `render`
// job the pipeline's hits (or a rebuilt output) and the render step, leaving
// the reel's status alone. Only a `process` job moves the reel's status
// (queue.ts). The job runs in its own scratch folder, removed afterwards
// whatever happened, and writes storage only through the recording storage,
// so every object it stores has a `stored_files` row for its reel.
export async function processJob(
  db: SupabaseClient,
  rawStorage: Storage,
  config: WorkerConfig,
  telemetry: Telemetry,
  job: ClaimedJob,
): Promise<JobOutcome> {
  const steps = supabaseStepStore(db);
  const records = supabaseStoredFiles(db);
  const storage = recordingStorage(rawStorage, {
    records,
    reelId: job.reel_id,
    keyPrefix: config.keyPrefix,
  });
  const recordStored = (key: string, bytes: number) =>
    records.record({ reelId: job.reel_id, key, bytes, ...classifyKey(config.keyPrefix, key) });
  const { span, context: jobContext } = startJobSpan(telemetry, job);
  // The fixed steps; a spec may double one (E2E_MOCK_STEP_RUN, test only).
  const pipeline = stepDoubles(process.env)(PIPELINE);
  let outcome: JobOutcome = "failed";
  try {
    outcome = await withJobScratch(config.scratchDir, job.id, (scratchDir) =>
      runJob({
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
              scratchDir,
              request,
            });
          await runJobKind(job, {
            async process() {
              const { fingerprints } = await runPipeline({
                ctx,
                storage,
                keyPrefix: config.keyPrefix,
                scratchDir,
                tools: toolPaths(),
                pipeline,
                recordStored,
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
            render: (versionId) =>
              runRender({
                ctx,
                storage,
                rows,
                exports: supabaseExportStore(db),
                keyPrefix: config.keyPrefix,
                scratchDir,
                tools: toolPaths(),
                pipeline,
                recordStored,
                versionId,
              }),
          });
        },
        finish: () => finishJob(db, config, job),
        fail: (tail) => failJob(db, config, job, tail),
        refuse: (message) => refuseJob(db, config, job, message),
        wait: (reason) => waitForAi(db, config, job, reason),
      }),
    );
    return outcome;
  } finally {
    endJobSpan(span, outcome);
  }
}
