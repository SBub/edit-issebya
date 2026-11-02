// Claims and runs at most one job, then exits: 0 when it ended `done` (or there
// was none, or the disk guard kept it from claiming), 1 otherwise. No
// subscription, no timer, no slimming. Specs spawn this. No heartbeat either:
// it exits at once, and a beat from it would show a live worker for eleven
// minutes that is not there.
import { workerConfig } from "./config.ts";
import { createErrorTracker, installCrashCapture } from "./error-tracking.ts";
import { freeBytesFn, guardedClaim, supabaseWorkerStatus } from "./disk-guard.ts";
import { processJob } from "./process-job.ts";
import { claimJob } from "./queue.ts";
import { prepareScratchDir } from "./scratch.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

// First, so an error anywhere after it is captured.
const errors = createErrorTracker();
installCrashCapture(errors);
const config = workerConfig();
// Before the disk guard reads the scratch volume; exits 1 when it cannot.
await prepareScratchDir(config.scratchDir);
const db = workerSupabase(config);
const telemetry = createTelemetry();
const job = await guardedClaim({
  dir: config.scratchDir,
  minFreeDiskGb: config.minFreeDiskGb,
  freeBytes: freeBytesFn(process.env),
  status: supabaseWorkerStatus(db, config.workerId),
  claim: () => claimJob(db, config),
  log: console.log,
});
if (!job) {
  console.log("no job");
  await telemetry.shutdown();
  await errors.shutdown();
  process.exit(0);
}
console.log(`job ${job.id}: claimed (attempt ${job.attempts})`);
const outcome = await processJob(db, workerStorage(), config, telemetry, errors, job);
// Flushes the job's spans, log records and exceptions before exiting.
await telemetry.shutdown();
await errors.shutdown();
process.exit(outcome === "done" ? 0 : 1);
