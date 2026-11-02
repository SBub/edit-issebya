// Claims and runs at most one job, then exits: 0 when it ended `done`,
// `waiting` (for the AI) or `refused` (the footage), or there was none, or the
// disk guard kept it from claiming; 1 otherwise. No
// subscription, no timer, no slimming. Specs spawn this.
import { workerConfig } from "./config.ts";
import { freeBytesFn, guardedClaim, supabaseWorkerStatus } from "./disk-guard.ts";
import { processJob } from "./process-job.ts";
import { claimJob } from "./queue.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

const config = workerConfig();
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
  process.exit(0);
}
console.log(`job ${job.id}: claimed (attempt ${job.attempts})`);
const outcome = await processJob(db, workerStorage(), config, telemetry, job);
// Flushes the job's spans and log records before exiting.
await telemetry.shutdown();
console.log(`job ${job.id}: outcome ${outcome}`);
process.exit(outcome === "done" || outcome === "waiting" || outcome === "refused" ? 0 : 1);
