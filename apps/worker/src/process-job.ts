import type { SupabaseClient } from "@supabase/supabase-js";
import type { Storage } from "@edit-issebya/storage";
import { aiRunner } from "./ai.ts";
import {
  type AiObserver,
  DISABLED_AI_OBSERVER,
  jobAiContext,
  withAiContext,
} from "./ai-observability.ts";
import type { WorkerConfig } from "./config.ts";
import { runDecide } from "./decide/run-decide.ts";
import type { ErrorTracker } from "./error-tracking.ts";
import { saveFirstVersion } from "./first-version.ts";
import { ownerFontPair } from "./font-pair-store.ts";
import { runRelayout } from "./relayout.ts";
import { runJobKind } from "./job-kinds.ts";
import { runDescribePhotoJob } from "./photos/describe-photo.ts";
import { supabasePhotoStore } from "./photos/photo-store.ts";
import {
  type ClaimedJob,
  failJob,
  finishJob,
  jobCancelled,
  jobGone,
  reelOf,
  refuseJob,
  renewLease,
  waitJob,
} from "./queue.ts";
import { promptSourceOf } from "./prompts/select.ts";
import type { PromptSource } from "./prompts/source.ts";
import { runPipeline } from "./pipeline/run-pipeline.ts";
import { previewCopiesRefs, recordPreviewCopies } from "./preview-copies-record.ts";
import { stepDouble } from "./pipeline/step-double.ts";
import { toolPaths } from "./pipeline/tools.ts";
import { supabaseExportStore } from "./render/export-store.ts";
import { runRender } from "./render/render-step.ts";
import { runRestore } from "./restore-step.ts";
import { firstVersionId } from "./start-over.ts";
import { withKeepAwake } from "./keep-awake.ts";
import { type ReelSizeHolder, createReelSizeHolder, readReelSize } from "./reel-size.ts";
import { type JobOutcome, runJob } from "./run-job.ts";
import { withJobScratch } from "./scratch.ts";
import { supabaseStepStore } from "./step-store.ts";
import {
  classifyKey,
  jobTarget,
  recordingStorage,
  supabaseDiscardExport,
  supabaseStoredFiles,
} from "./stored-files.ts";
import { type Telemetry, emitFailureLog, endJobSpan, startJobSpan } from "./telemetry.ts";
import { tracedStorage } from "./traced-storage.ts";
import { storageVersionBlobs, supabaseVersionRows } from "./version-store.ts";

// One prompt source for the whole worker process: its cache serves every job
// (created on first use, so a job that needs no prompt never reads the variables).
let sharedPrompts: PromptSource | undefined;
function promptsOf(): PromptSource {
  sharedPrompts ??= promptSourceOf(process.env);
  return sharedPrompts;
}

// Wires one claimed job to the database, storage and telemetry: the job span,
// the job's work by kind under a kept lease, then the job's final write. A
// `process` job checks the footage (a refusal refuses the reel), then runs the
// fixed pipeline steps (the step double under E2E_MOCK_STEPS), the preview copies' location,
// the first version and the decide step; a `restore` job only the restore step; a `render`
// job the pipeline's hits (or a rebuilt output) and the render step, leaving
// the reel's status alone, and stops within seconds once its owner cancels it; a
// `start_over` job (a temporary testing control) only the decide step from version 1
// with no request; any job stops
// within one lease renewal once its reel (or photo) is deleted, as `deleted`; a `describe_photo` job a library photo's two copies
// and its description, recorded against the photo. Only a `process` job moves the reel's status
// (queue.ts). The job runs in its own scratch folder, removed afterwards
// whatever happened, and writes storage only through the recording storage,
// so every object it stores has a `stored_files` row for its reel. On macOS
// the whole job runs under caffeinate, so the Mac does not sleep in it.
export async function processJob(
  db: SupabaseClient,
  rawStorage: Storage,
  config: WorkerConfig,
  telemetry: Telemetry,
  errors: ErrorTracker,
  job: ClaimedJob,
  aiObserver: AiObserver = DISABLED_AI_OBSERVER,
): Promise<JobOutcome> {
  // The job's AI runner: every model call is reported with the job as its trace.
  const ai = () => withAiContext(aiRunner(process.env, aiObserver), jobAiContext(job));
  const steps = supabaseStepStore(db);
  const records = supabaseStoredFiles(db);
  const target = jobTarget(job);
  const recordStored = (key: string, bytes: number) =>
    records.record({ ...target, key, bytes, ...classifyKey(config.keyPrefix, key) });
  // The reel's size, on the job span and every step span (a photo job has none).
  const size: ReelSizeHolder | undefined = job.reel_id
    ? createReelSizeHolder(await readReelSize(db, job.reel_id))
    : undefined;
  const { span, context: jobContext } = startJobSpan(telemetry, job, size);
  // Every read and write of the job is an `r2.get` or `r2.put` span under the
  // step or stage that made it (the job's span outside any step), and every
  // write is recorded.
  const storage = recordingStorage(
    tracedStorage(rawStorage, { telemetry, keyPrefix: config.keyPrefix, fallback: jobContext }),
    { records, target, keyPrefix: config.keyPrefix },
  );
  let outcome: JobOutcome = "failed";
  try {
    outcome = await withKeepAwake(() =>
      withJobScratch(config.scratchDir, job.id, (scratchDir) =>
        runJob({
          job,
          renewEveryMs: config.renewEveryMs,
          renew: () => renewLease(db, config, job.id),
          // Only a render can be cancelled (cancel_job): no other kind reads it.
          cancelled: job.kind === "render" ? () => jobCancelled(db, job.id) : undefined,
          cancelCheckEveryMs: config.cancelCheckEveryMs,
          // Its reel (or photo) deleted, the job's row went with it.
          gone: () => jobGone(db, job.id),
          failureLog: (input) => emitFailureLog(telemetry, jobContext, input),
          async work(signal, checkCancelled, checkGone) {
            const ctx = {
              steps,
              telemetry,
              errors,
              jobContext,
              job,
              signal,
              checkCancelled,
              checkGone,
              size,
            };
            // Taken again after its worker stopped: the rows it left running
            // end failed, so the step log never shows a step running forever.
            if (job.attempts > 1) await steps.abandonRunning(job.id);
            const rows = supabaseVersionRows(db);
            const blobs = storageVersionBlobs(storage);
            // The masks behind items need (E2E_MOCK_MASK makes black ones).
            const cutouts = {
              storage,
              keyPrefix: config.keyPrefix,
              scratchDir,
              tools: toolPaths(),
              recordStored,
            };
            // The automatic decide and Start over: no request (the change box
            // is removed), from the current version unless startFrom says otherwise.
            const decide = (startFrom: string | null = null) =>
              runDecide({
                ctx,
                storage,
                rows,
                blobs,
                keyPrefix: config.keyPrefix,
                ai: ai(),
                prompts: promptsOf(),
                scratchDir,
                startFrom,
                tools: cutouts.tools,
                recordStored,
                ownerFontPair: () => ownerFontPair(db, job.owner_id),
              });
            await runJobKind(job, {
              async process() {
                const { fingerprints } = await runPipeline({
                  ctx,
                  storage,
                  keyPrefix: config.keyPrefix,
                  scratchDir,
                  tools: toolPaths(),
                  recordStored,
                  checkFootage: true,
                  runStep: stepDouble(process.env) ?? undefined,
                });
                // Before the first version, so a reel with a current version
                // already says where its preview copies are.
                await recordPreviewCopies(db, reelOf(job), previewCopiesRefs(fingerprints));
                await saveFirstVersion({
                  ctx,
                  storage,
                  rows,
                  blobs,
                  keyPrefix: config.keyPrefix,
                  fingerprints,
                  fontPair: await ownerFontPair(db, job.owner_id),
                });
                // Never cached: a failed decide fails the job and version 1 stays
                // current; a retried job decides again from the current version.
                await decide();
              },
              restore: (versionId) =>
                runRestore({ ctx, rows, blobs, keyPrefix: config.keyPrefix, versionId, cutouts }),
              render: (versionId) =>
                runRender({
                  ctx,
                  storage,
                  rows,
                  exports: supabaseExportStore(db),
                  keyPrefix: config.keyPrefix,
                  scratchDir,
                  tools: toolPaths(),
                  recordStored,
                  versionId,
                  cutouts,
                  discardExport: supabaseDiscardExport(db, rawStorage),
                }),
              // Start over (temporary, for testing): decide alone, no
              // request, from version 1; saved as a new version.
              start_over: async () => decide(await firstVersionId(db, reelOf(job))),
              // A re-layout (font pairs): the current version placed again in the job's
              // pair, from its own AI answers, with no AI call.
              relayout: (fontPair) =>
                runRelayout({
                  ctx,
                  storage,
                  rows,
                  blobs,
                  keyPrefix: config.keyPrefix,
                  scratchDir,
                  tools: cutouts.tools,
                  recordStored,
                  fontPair,
                }),
              // A library photo: its two copies, then the AI's
              // description and tags; no reel is touched.
              describe_photo: (photoId) =>
                runDescribePhotoJob({
                  ctx,
                  storage,
                  store: supabasePhotoStore(db),
                  ai: ai(),
                  prompts: promptsOf(),
                  tools: toolPaths(),
                  keyPrefix: config.keyPrefix,
                  scratchDir,
                  photoId,
                }),
            });
          },
          finish: () => finishJob(db, config, job),
          fail: (tail, failure) => failJob(db, config, job, tail, failure),
          refuse: (message) => refuseJob(db, config, job, message),
          wait: (reason) => waitJob(db, config, job, reason),
          errors,
        }),
      ),
    );
    return outcome;
  } finally {
    endJobSpan(span, outcome, size);
  }
}
