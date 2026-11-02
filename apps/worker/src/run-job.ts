import { errorTail } from "./errors.ts";
import { AiUnavailable, FootageRefused, findCause } from "./failure.ts";
import { keepLease } from "./lease.ts";
import type { ClaimedJob } from "./queue.ts";

export type JobOutcome = "done" | "failed" | "refused" | "waiting" | "lost";

export interface RunJobDeps {
  job: ClaimedJob;
  renewEveryMs: number;
  renew: () => Promise<boolean>;
  work: (signal: AbortSignal) => Promise<void>;
  finish: () => Promise<boolean>;
  fail: (errorTail: string) => Promise<boolean>;
  // The footage cannot be used: the reel is refused with this human message.
  refuse: (message: string) => Promise<boolean>;
  // The AI is not available: the job waits and is taken again later.
  wait: (reason: string) => Promise<boolean>;
  log?: (message: string) => void;
}

// Runs one claimed job while keeping its lease. Success finishes the job,
// refused footage refuses the reel, an unavailable AI makes the job wait, any
// other failure fails it with the error's tail, and a lost lease writes
// nothing more (another worker may hold the job now). Each write is guarded
// by the lease: one that matched no row is `lost`.
export async function runJob({
  job,
  renewEveryMs,
  renew,
  work,
  finish,
  fail,
  refuse,
  wait,
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
    const refusal = findCause(error, FootageRefused);
    if (refusal) {
      log(`job ${job.id}: footage refused: ${refusal.message}`);
      return (await refuse(refusal.message)) ? "refused" : "lost";
    }
    const unavailable = findCause(error, AiUnavailable);
    if (unavailable) {
      log(`job ${job.id}: waiting for the AI: ${unavailable.reason}`);
      return (await wait(unavailable.reason)) ? "waiting" : "lost";
    }
    const tail = errorTail(error);
    log(`job ${job.id}: failed: ${tail.split("\n")[0]}`);
    return (await fail(tail)) ? "failed" : "lost";
  } finally {
    lease.stop();
  }
}
