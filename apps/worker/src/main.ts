// The long-running worker on the owner's machine (never on Vercel). It wakes
// on Realtime inserts into public.jobs, checks the table every
// WORKER_POLL_INTERVAL_SECONDS reading only ids, and runs one job at a time.
import { statfs } from "node:fs/promises";
import { workerConfig } from "./config.ts";
import { createDrainer } from "./loop.ts";
import { processJob } from "./process-job.ts";
import { claimJob, claimableJobIds } from "./queue.ts";
import { workerStorage } from "./storage.ts";
import { workerSupabase } from "./supabase.ts";
import { createTelemetry } from "./telemetry.ts";

const config = workerConfig();
const db = workerSupabase(config);
const storage = workerStorage();
const telemetry = createTelemetry();

async function enoughDisk(): Promise<boolean> {
  const info = await statfs(config.scratchDir);
  const freeGb = (info.bavail * info.bsize) / 1024 ** 3;
  if (freeGb >= config.minFreeDiskGb) return true;
  console.warn(
    `worker: ${freeGb.toFixed(1)} GB free in ${config.scratchDir}, below ${config.minFreeDiskGb} GB: not claiming`,
  );
  return false;
}

const drainer = createDrainer({
  claim: async () => ((await enoughDisk()) ? claimJob(db, config) : null),
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

drainer.signal();
console.log(`worker ${config.workerId}: started`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`worker: ${signal}, finishing the current job`);
  clearInterval(poll);
  await db.removeChannel(channel);
  await drainer.idle();
  await telemetry.shutdown();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
