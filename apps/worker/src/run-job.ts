import type { ErrorTracker } from "./error-tracking.ts";
import { errorTail, failureReason } from "./errors.ts";
import { AiUnavailable, AnswerRefused, FootageRefused, failureKind, findCause } from "./failure.ts";
import { keepLease } from "./lease.ts";
import type { ClaimedJob, JobFailure } from "./queue.ts";
import { isStepFailure } from "./step-runner.ts";

export type JobOutcome = "done" | "failed" | "refused" | "waiting" | "lost";

export interface RunJobDeps {
  job: ClaimedJob;
  renewEveryMs: number;
  renew: () => Promise<boolean>;
  work: (signal: AbortSignal) => Promise<void>;
  finish: () => Promise<boolean>;
  fail: (errorTail: string, failure: JobFailure) => Promise<boolean>;
  // The footage cannot be used: the reel is refused with this human message.
  refuse: (message: string) => Promise<boolean>;
  // The AI is not available: the job waits and is taken again later.
  wait: (reason: string) => Promise<boolean>;
  // A failure outside any step (no step row captured it) is captured here.
  errors: Pick<ErrorTracker, "jobFailed">;
  log?: (message: string) => void;
}

// The job's failure kind and, for a refused AI answer, its rule names.
function jobFailure(error: unknown): JobFailure {
  const kind = failureKind(error);
  if (kind === "answer_refused") {
    const refused = findCause(error, AnswerRefused);
    const rules = refused && refused.rules.length > 0 ? refused.rules.slice(0, 20) : null;
    // The column wants rules with this kind; none known is a plain failure.
    return rules ? { kind, rules } : { kind: "failed", rules: null };
  }
  return { kind: kind === "transient" ? "transient" : "failed", rules: null };
}

// Runs one claimed job while keeping its lease. Success finishes the job,
// refused footage refuses the reel, an unavailable AI makes the job wait, any
// other failure fails it with the error's tail (a failed tool's output, else the
// stack's end), and a lost lease writes
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
  errors,
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
    // A failed tool's message carries its output after the first line: that
    // is the reason, never crowded out by stack frames.
    const reason = failureReason(error);
    const carriesOutput = error instanceof Error && error.message.trimEnd().includes("\n");
    const tail = carriesOutput ? reason : errorTail(error);
    log(`job ${job.id}: failed: ${reason}`);
    const failure = jobFailure(error);
    if (!isStepFailure(error)) errors.jobFailed({ job, error, tail, failure });
    return (await fail(tail, failure)) ? "failed" : "lost";
  } finally {
    lease.stop();
  }
}
