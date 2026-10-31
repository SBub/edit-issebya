import { errorTail } from "./errors.ts";
import { keepLease } from "./lease.ts";
import type { ClaimedJob } from "./queue.ts";

export type JobOutcome = "done" | "failed" | "lost";

export interface RunJobDeps {
  job: ClaimedJob;
  renewEveryMs: number;
  renew: () => Promise<boolean>;
  work: (signal: AbortSignal) => Promise<void>;
  finish: () => Promise<boolean>;
  fail: (errorTail: string) => Promise<boolean>;
  log?: (message: string) => void;
}

// Runs one claimed job while keeping its lease. Success finishes the job,
// failure fails it with the error's tail, and a lost lease writes nothing more
// (another worker may hold the job now).
export async function runJob({
  job,
  renewEveryMs,
  renew,
  work,
  finish,
  fail,
  log = console.log,
}: RunJobDeps): Promise<JobOutcome> {
  const lease = keepLease({ renew, everyMs: renewEveryMs });
  try {
    await work(lease.signal);
    if (lease.signal.aborted) {
      log(`job ${job.id}: lease lost, leaving it`);
      return "lost";
    }
    if (!(await finish())) {
      log(`job ${job.id}: lease lost before finishing, leaving it`);
      return "lost";
    }
    log(`job ${job.id}: done`);
    return "done";
  } catch (error) {
    if (lease.signal.aborted) {
      log(`job ${job.id}: lease lost, leaving it`);
      return "lost";
    }
    const tail = errorTail(error);
    log(`job ${job.id}: failed: ${tail.split("\n")[0]}`);
    return (await fail(tail)) ? "failed" : "lost";
  } finally {
    lease.stop();
  }
}
