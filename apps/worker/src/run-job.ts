import { errorTail } from "./errors.ts";
import { AiUnavailableError, FootageRefusedError, causeOf, classifyFailure } from "./failures.ts";
import { keepLease } from "./lease.ts";
import type { ClaimedJob } from "./queue.ts";

export type JobOutcome = "done" | "failed" | "lost" | "refused" | "waiting";

export interface RunJobDeps {
  job: ClaimedJob;
  renewEveryMs: number;
  renew: () => Promise<boolean>;
  work: (signal: AbortSignal) => Promise<void>;
  finish: () => Promise<boolean>;
  fail: (errorTail: string) => Promise<boolean>;
  // The footage was refused: the owner's message.
  refuse: (message: string) => Promise<boolean>;
  // The AI cannot answer now: why.
  wait: (reason: string) => Promise<boolean>;
  log?: (message: string) => void;
}

// Runs one claimed job while keeping its lease. Success finishes the job; a
// refused clip refuses the reel; an unavailable AI makes the job wait; any
// other failure fails it with the error's tail; a lost lease writes nothing
// more (another worker may hold the job now).
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
    const kind = classifyFailure(error);
    if (kind === "refused") {
      const message = causeOf(error, FootageRefusedError)?.message ?? errorTail(error);
      log(`job ${job.id}: footage refused: ${message}`);
      return (await refuse(message)) ? "refused" : "lost";
    }
    if (kind === "ai_unavailable") {
      const reason = causeOf(error, AiUnavailableError)?.reason ?? "unavailable";
      log(`job ${job.id}: waiting for the AI: ${reason}`);
      return (await wait(reason)) ? "waiting" : "lost";
    }
    const tail = errorTail(error);
    log(`job ${job.id}: failed: ${tail.split("\n")[0]}`);
    return (await fail(tail)) ? "failed" : "lost";
  } finally {
    lease.stop();
  }
}
