// Claims and runs at most one job, then exits: 0 when it ended `done` (or there
// was none), 1 otherwise. No subscription, no timer, no housekeeping. The disk
// guard applies as in the long-running worker. Specs spawn this.
import { workerConfig } from "./config.ts";
import {
  claimIfRoom,
  createDiskGuard,
  freeDiskBytes,
  supabaseWorkerStatusStore,
} from "./disk-guard.ts";
import { processJob } from "./process-job.ts";
import { claimJob } from "./queue.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

const config = workerConfig();
const db = workerSupabase(config);
const telemetry = createTelemetry();
let waiting: string | null = null;
const guard = createDiskGuard({
  freeBytes: () => freeDiskBytes(config.scratchDir),
  minFreeDiskGb: config.minFreeDiskGb,
  status: supabaseWorkerStatusStore(db, config.workerId),
  log: (reason) => (waiting = reason),
});
const job = await claimIfRoom(guard, () => claimJob(db, config))();
if (!job) {
  console.log(waiting ? `no job: ${waiting}` : "no job");
  await telemetry.shutdown();
  process.exit(0);
}
console.log(`job ${job.id}: claimed (attempt ${job.attempts})`);
const outcome = await processJob(db, workerStorage(), config, telemetry, job);
// Flushes the job's spans and log records before exiting.
await telemetry.shutdown();
process.exit(outcome === "done" ? 0 : 1);
