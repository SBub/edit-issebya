import type { ErrorTracker } from "./error-tracking.ts";
import { errorTail, failureReason } from "./errors.ts";
import { AiUnavailable, AnswerRefused, FootageRefused, failureKind, findCause } from "./failure.ts";
import { isJobCancelled, isJobGone, keepLease } from "./lease.ts";
import type { ClaimedJob, JobFailure } from "./queue.ts";
import { isStepFailure } from "./step-runner.ts";

export type JobOutcome =
  "done" | "failed" | "refused" | "waiting" | "lost" | "cancelled" | "deleted";

export interface RunJobDeps {
  job: ClaimedJob;
  renewEveryMs: number;
  renew: () => Promise<boolean>;
  // Given (a render job), checked every `cancelCheckEveryMs`: true once the
  // owner cancelled the job.
  cancelled?: () => Promise<boolean>;
  cancelCheckEveryMs?: number;
  // True once the job's row is gone (its reel or photo was deleted); asked
  // when a renewal or a final write matched no row, and before any failure
  // is recorded.
  gone?: () => Promise<boolean>;
  // `checkCancelled` checks for a cancel at once, `checkGone` for a deleted
  // job's row (see LeaseKeeper).
  work: (
    signal: AbortSignal,
    checkCancelled: () => Promise<boolean>,
    checkGone: () => Promise<boolean>,
  ) => Promise<void>;
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
// nothing more (another worker may hold the job now). A cancelled job writes
// nothing more either: `cancel_job` already ended it. A job whose row is gone
// (its owner deleted the reel or the photo) is `deleted`: it writes nothing
// more, records no failure and captures nothing, whatever it was doing when
// the row went. Each write is guarded by the lease: one that matched no row is
// `lost`, or `deleted` when the row is gone.
export async function runJob({
  job,
  renewEveryMs,
  renew,
  cancelled,
  cancelCheckEveryMs,
  gone,
  work,
  finish,
  fail,
  refuse,
  wait,
  errors,
  log = console.log,
}: RunJobDeps): Promise<JobOutcome> {
  const lease = keepLease({ renew, everyMs: renewEveryMs, cancelled, cancelCheckEveryMs, gone });
  const deleted = (): JobOutcome => {
    log(`job ${job.id}: ${job.reel_id ? "reel" : "photo"} deleted, stopped`);
    return "deleted";
  };
  const stopped = (): JobOutcome => {
    if (isJobGone(lease.signal)) return deleted();
    if (isJobCancelled(lease.signal)) {
      log(`job ${job.id}: cancelled, leaving it`);
      return "cancelled";
    }
    log(`job ${job.id}: lease lost, leaving it`);
    return "lost";
  };
  // A final write that matched no row: the row is gone, or the lease is lost.
  const unmatched = async (lost: JobOutcome): Promise<JobOutcome> =>
    (await lease.checkGone()) ? deleted() : lost;
  try {
    await work(
      lease.signal,
      () => lease.checkCancelled(),
      () => lease.checkGone(),
    );
    if (lease.signal.aborted) return stopped();
    if (!(await finish())) {
      if (await lease.checkGone()) return deleted();
      log(`job ${job.id}: lease lost before finishing, leaving it`);
      return "lost";
    }
    log(`job ${job.id}: done`);
    return "done";
  } catch (error) {
    // Before anything else: a write that failed because the row went is no
    // failure.
    if (lease.signal.aborted || (await lease.checkGone())) return stopped();
    const refusal = findCause(error, FootageRefused);
    if (refusal) {
      log(`job ${job.id}: footage refused: ${refusal.message}`);
      return (await refuse(refusal.message)) ? "refused" : unmatched("lost");
    }
    const unavailable = findCause(error, AiUnavailable);
    if (unavailable) {
      log(`job ${job.id}: waiting for the AI: ${unavailable.reason}`);
      return (await wait(unavailable.reason)) ? "waiting" : unmatched("lost");
    }
    // A failed tool's message carries its output after the first line: that
    // is the reason, never crowded out by stack frames.
    const reason = failureReason(error);
    const carriesOutput = error instanceof Error && error.message.trimEnd().includes("\n");
    const tail = carriesOutput ? reason : errorTail(error);
    log(`job ${job.id}: failed: ${reason}`);
    const failure = jobFailure(error);
    if (!isStepFailure(error)) errors.jobFailed({ job, error, tail, failure });
    return (await fail(tail, failure)) ? "failed" : unmatched("lost");
  } finally {
    lease.stop();
  }
}
