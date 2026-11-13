// The long-running worker on the owner's machine (never on Vercel). It wakes
// on Realtime inserts into public.jobs, checks the table every
// WORKER_POLL_INTERVAL_SECONDS reading only ids (of claimable jobs and of one
// due storage_deletions row), and runs one job at a time.
// Between jobs it deletes the objects of deleted reels (the storage_deletions
// queue, also drained by the poll when no job is waiting) and slims storage at
// most once an hour, and it claims nothing
// while the scratch volume is below WORKER_MIN_FREE_DISK_GB. It writes a
// heartbeat at start and every five minutes. Before anything reads the scratch
// volume it creates the scratch folder, and exits 1 naming it when it cannot.
import { createAiObserver } from "./ai-observability.ts";
import { workerConfig } from "./config.ts";
import { createErrorTracker, installCrashCapture } from "./error-tracking.ts";
import { freeBytesFn, guardedClaim, supabaseWorkerStatus } from "./disk-guard.ts";
import { startHeartbeat } from "./heartbeat.ts";
import { createDrainer } from "./loop.ts";
import { processJob } from "./process-job.ts";
import { claimJob, claimableJobIds } from "./queue.ts";
import { prepareScratchDir, sweepStaleScratch } from "./scratch.ts";
import { createSlimmer, runSlimming } from "./slimming.ts";
import {
  dueStorageDeletionIds,
  runStorageDeletions,
  supabaseStorageDeletions,
} from "./storage-deletions.ts";
import { workerStorage } from "./storage.ts";
import { supabaseStoredFiles } from "./stored-files.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

// First, so an error anywhere after it is captured.
const errors = createErrorTracker();
installCrashCapture(errors);
const config = workerConfig();
await prepareScratchDir(config.scratchDir);
const db = workerSupabase(config);
const storage = workerStorage();
const telemetry = createTelemetry();
// Every model call of a job is one PostHog generation event.
const aiObserver = createAiObserver("app");
const status = supabaseWorkerStatus(db, config.workerId);
const freeBytes = freeBytesFn(process.env);
const records = supabaseStoredFiles(db);
const deletions = supabaseStorageDeletions(db);

// Job folders a crashed run left behind, before the first job.
await sweepStaleScratch(config.scratchDir);

// Tells the studio this worker is alive; it shows it offline after eleven
// minutes without a beat.
const heartbeat = startHeartbeat({
  beat: async () => status.heartbeat({ freeDiskBytes: await freeBytes(config.scratchDir) }),
});

// Only between this worker's jobs: never while it runs one.
const slimmer = createSlimmer({
  run: (now) => runSlimming({ records, storage, keyPrefix: config.keyPrefix, now }),
});

// Only between this worker's jobs too; a failed pass is logged, and its keys
// stay queued for the next one.
async function deleteQueuedObjects() {
  try {
    await runStorageDeletions({ queue: deletions, storage, keyPrefix: config.keyPrefix });
  } catch (error) {
    console.error("storage deletions: failed:", error);
  }
}

const drainer = createDrainer({
  claim: async () => {
    await deleteQueuedObjects();
    await slimmer.maybeRun();
    return guardedClaim({
      dir: config.scratchDir,
      minFreeDiskGb: config.minFreeDiskGb,
      freeBytes,
      status,
      claim: () => claimJob(db, config),
    });
  },
  run: (job) => processJob(db, storage, config, telemetry, errors, job, aiObserver),
  onError: (error) => {
    console.error("worker: drain failed:", error);
    errors.crashed(error);
  },
});

const channel = db
  .channel(`worker-${config.workerId}`)
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "jobs" }, () =>
    drainer.signal(),
  )
  .subscribe((status, error) => {
    if (status === "SUBSCRIBED") console.log("worker: listening for new jobs");
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error(`worker: realtime ${status}`, error?.message ?? "");
    }
  });

const poll = setInterval(() => {
  claimableJobIds(db)
    .then((ids) => {
      if (ids.length > 0) drainer.signal();
    })
    .catch((error: unknown) => console.error("worker: check failed:", error));
  // A worker with no jobs still drains the deletion queue: the poll reads only
  // the id of one due row, and the drain's claim runs the pass (which also
  // drops held keys).
  dueStorageDeletionIds(db, config.keyPrefix)
    .then((ids) => {
      if (ids.length > 0) drainer.signal();
    })
    .catch((error: unknown) => console.error("storage deletions: check failed:", error));
}, config.pollIntervalSeconds * 1000);

drainer.signal();
console.log(`worker ${config.workerId}: started`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal}, finishing the current job`);
  clearInterval(poll);
  heartbeat.stop();
  await db.removeChannel(channel);
  await drainer.idle();
  await telemetry.shutdown();
  await errors.shutdown();
  await aiObserver.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
