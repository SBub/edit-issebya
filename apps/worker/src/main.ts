// The long-running worker on the owner's machine (never on Vercel). It wakes
// on Realtime inserts into public.jobs, checks the table every
// WORKER_POLL_INTERVAL_SECONDS reading only ids, and runs one job at a time.
// Between jobs it housekeeps storage at most hourly, and it claims nothing
// while the scratch volume is below WORKER_MIN_FREE_DISK_GB.
import { workerConfig } from "./config.ts";
import {
  claimIfRoom,
  createDiskGuard,
  freeDiskBytes,
  supabaseWorkerStatusStore,
} from "./disk-guard.ts";
import { createDrainer } from "./loop.ts";
import { processJob } from "./process-job.ts";
import { claimJob, claimableJobIds } from "./queue.ts";
import { HOUSEKEEPING_EVERY_MS, createHousekeeping, housekeep } from "./slimming.ts";
import { workerStorage } from "./storage.ts";
import { supabaseStoredFileStore } from "./stored-files.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

const config = workerConfig();
const db = workerSupabase(config);
const storage = workerStorage();
const telemetry = createTelemetry();

const guard = createDiskGuard({
  freeBytes: () => freeDiskBytes(config.scratchDir),
  minFreeDiskGb: config.minFreeDiskGb,
  status: supabaseWorkerStatusStore(db, config.workerId),
});
const files = supabaseStoredFileStore(db);
const housekeeping = createHousekeeping({
  everyMs: HOUSEKEEPING_EVERY_MS,
  now: () => new Date(),
  run: () => housekeep({ files, storage, now: new Date(), log: console.log }),
});
const claimWithRoom = claimIfRoom(guard, () => claimJob(db, config));

// Housekeeping runs inside the drain loop, between jobs, never during one.
const drainer = createDrainer({
  claim: async () => {
    await housekeeping.maybeRun();
    return claimWithRoom();
  },
  run: (job) => processJob(db, storage, config, telemetry, job),
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
}, config.pollIntervalSeconds * 1000);

// An idle worker still housekeeps hourly.
const hourly = setInterval(() => drainer.signal(), HOUSEKEEPING_EVERY_MS);

drainer.signal();
console.log(`worker ${config.workerId}: started`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal}, finishing the current job`);
  clearInterval(poll);
  clearInterval(hourly);
  await db.removeChannel(channel);
  await drainer.idle();
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
