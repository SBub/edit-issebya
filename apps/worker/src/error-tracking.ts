import { PostHog } from "posthog-node";
import { AnswerRefused, failureKind, findCause } from "./failure.ts";
import type { ClaimedJob, JobFailure } from "./queue.ts";
import { scrub } from "./scrub.ts";

// The worker's error tracking (see app_docs/error-tracking.md): every failed
// step row and every uncaught error of the process go to PostHog error
// tracking. Built per process in main.ts and once.ts and passed down like
// telemetry, never at module load, never global. Without both
// POSTHOG_PROJECT_TOKEN and POSTHOG_HOST no client is built at all and nothing
// is captured. Failures are logged to the OpenTelemetry logger either way
// (telemetry.ts emitFailureLog), so Grafana shows them in every mode.
//
// Checked against posthog-node 5.61.1 (dist/client.d.ts):
// `captureException(error: unknown, distinctId?: string, additionalProperties?)`
// queues the event; `shutdown(shutdownTimeoutMs?): Promise<void>` sends it.

type Env = Record<string, string | undefined>;

export interface StepFailedInput {
  job: ClaimedJob;
  step: string;
  // The step's attempt: 1, or 2 for its one automatic retry.
  attempt: number;
  // True when the step runs once more after this failure.
  retrying: boolean;
  error: unknown;
  // The tail written to the failed row.
  tail: string;
}

export interface JobFailedInput {
  job: ClaimedJob;
  error: unknown;
  // The tail written to the failed job.
  tail: string;
  failure: JobFailure;
}

export interface ErrorTracker {
  // True only when a client was built.
  enabled: boolean;
  stepFailed(input: StepFailedInput): void;
  // A job failure outside any step (no step row captured it).
  jobFailed(input: JobFailedInput): void;
  crashed(error: unknown): void;
  // Sends what was captured; never rejects. Call before the process exits.
  shutdown(timeoutMs?: number): Promise<void>;
}

/** The gate closed: every method a no-op, nothing is captured. */
export const DISABLED_TRACKER: ErrorTracker = {
  enabled: false,
  stepFailed() {},
  jobFailed() {},
  crashed() {},
  async shutdown() {},
};

type PostHogClient = Pick<PostHog, "captureException" | "shutdown">;

/** The last `max` UTF-16 units, never starting on half a surrogate pair. */
export function lastChars(value: string, max: number): string {
  if (value.length <= max) return value;
  const tail = value.slice(-max);
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
}

const TAIL_CHARS = 1000;

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && chain.length < 10) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

/** The innermost error's `code` or `name` (not a bare `Error`), or null. */
function innermostCode(error: unknown): string | null {
  for (const link of causes(error).reverse()) {
    if (typeof link !== "object" || link === null) continue;
    const { code, name } = link as { code?: unknown; name?: unknown };
    if (typeof code === "string" && code !== "") return scrub(code).slice(0, 100);
    if (typeof name === "string" && name !== "" && name !== "Error")
      return scrub(name).slice(0, 100);
  }
  return null;
}

// A refused AI answer's rule names and round count, else nulls.
function refusal(error: unknown): { failed_rules: string[] | null; rounds: number | null } {
  const refused = findCause(error, AnswerRefused);
  return refused
    ? { failed_rules: [...refused.rules], rounds: refused.rounds }
    : { failed_rules: null, rounds: null };
}

function scrubbedError(thrown: unknown): Error {
  const original = thrown instanceof Error ? thrown : null;
  const error = new Error(scrub(original ? original.message : String(thrown)).slice(0, 500));
  if (original?.name) error.name = scrub(original.name).slice(0, 100);
  error.stack = original?.stack ? scrub(original.stack).slice(0, 4000) : undefined;
  return error;
}

export function createErrorTracker(
  env: Env = process.env,
  makeClient: (projectToken: string, host: string) => PostHogClient = (projectToken, host) =>
    new PostHog(projectToken, { host }),
): ErrorTracker {
  const projectToken = env.POSTHOG_PROJECT_TOKEN?.trim();
  const host = env.POSTHOG_HOST?.trim();
  if (!projectToken || !host) return DISABLED_TRACKER;
  const client = makeClient(projectToken, host);
  const workerId = env.WORKER_ID?.trim();

  // A capture never breaks the worker.
  const capture = (error: Error, distinctId: string | undefined, properties: object) => {
    try {
      client.captureException(error, distinctId, properties);
    } catch {
      // PostHog refused it: the failure is still in the row and the log.
    }
  };

  return {
    enabled: true,
    stepFailed({ job, step, attempt, retrying, error, tail }) {
      // Never the job's request (a change request is the owner's words).
      capture(new Error("worker: step failed"), job.owner_id, {
        app: "worker",
        step,
        job_kind: job.kind,
        reel_id: job.reel_id,
        photo_id: job.photo_id,
        job_id: job.id,
        attempt,
        retrying,
        failure_kind: failureKind(error),
        ...refusal(error),
        error_code: innermostCode(error),
        error_tail: lastChars(scrub(tail), TAIL_CHARS),
      });
    },
    jobFailed({ job, error, tail, failure }) {
      // A failure outside any step: never the job's request either.
      capture(new Error("worker: job failed"), job.owner_id, {
        app: "worker",
        job_kind: job.kind,
        reel_id: job.reel_id,
        photo_id: job.photo_id,
        job_id: job.id,
        failure_kind: failure.kind,
        error_code: innermostCode(error),
        error_tail: lastChars(scrub(tail), TAIL_CHARS),
      });
    },
    crashed(error) {
      capture(scrubbedError(error), workerId ? `worker:${workerId}` : undefined, {
        app: "worker",
        kind: "uncaught",
      });
    },
    async shutdown(timeoutMs) {
      try {
        await client.shutdown(timeoutMs);
      } catch {
        // PostHog down: nothing more to do before exit.
      }
    },
  };
}

type CrashSource = Pick<NodeJS.Process, "on">;

/**
 * Captures an uncaught exception or unhandled rejection, logs it, flushes
 * (bounded wait) and exits 1. A listener replaces Node's default crash, so it
 * must exit itself.
 */
export function installCrashCapture(
  tracker: ErrorTracker,
  proc: CrashSource = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let crashing = false;
  const onCrash = (error: unknown) => {
    console.error("worker: crashed:", error);
    if (crashing) return;
    crashing = true;
    tracker.crashed(error);
    void tracker.shutdown(3000).finally(() => exit(1));
  };
  proc.on("uncaughtException", onCrash);
  proc.on("unhandledRejection", onCrash);
}
