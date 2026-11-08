// What a failure means for the job: the error classes the worker throws on
// purpose, and the one classifier every automatic retry goes through
// (app_docs/failures.md).

// An error worth one more try (a network hiccup, a 5xx), marked explicitly.
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientError";
  }
}

// Never retried automatically, whatever its cause says (an AI call already
// made, say: a retry would make another).
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentError";
  }
}

// The footage cannot be used; the message is the human text the reel shows.
export class FootageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootageRefused";
  }
}

// The AI's answer failed the checks in every round: the names of the check
// rules it failed (rule names only, never free text) and how many rounds ran.
export class AnswerRefused extends PermanentError {
  readonly rules: string[];
  readonly rounds: number;

  constructor(rules: string[], rounds: number) {
    super("the answer failed the checks");
    this.name = "AnswerRefused";
    this.rules = rules;
    this.rounds = rounds;
  }
}

// The AI is not available (no key, no credits, a rate limit, OpenRouter down): the job
// waits and is taken again later.
export class AiUnavailable extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`AI not available: ${reason}`);
    this.name = "AiUnavailable";
    this.reason = reason;
  }
}

// From the first AI call on, a failure is never retried automatically: a
// retry would call the AI again, and an AI step makes at most two calls. An
// unavailable AI keeps its own class (the job waits).
export function permanentAfterAiCall(error: unknown): never {
  if (error instanceof AiUnavailable || error instanceof PermanentError) throw error;
  throw new PermanentError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

const MAX_DEPTH = 10;

// The error and its causes, outer to inner (at most ten links).
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && chain.length < MAX_DEPTH) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

// The first error of this class in the cause chain, or null.
export function findCause<T>(error: unknown, ctor: abstract new (...args: never[]) => T): T | null {
  for (const link of causeChain(error)) {
    if (link instanceof ctor) return link;
  }
  return null;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

const TIMEOUT_NAMES = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException"]);

type Verdict = "transient" | "permanent" | null;

// One link's verdict; null: this link does not decide, look further in.
function verdictOf(link: unknown): Verdict {
  if (
    link instanceof PermanentError ||
    link instanceof FootageRefused ||
    link instanceof AiUnavailable
  ) {
    return "permanent";
  }
  // A step's own check failed (its reasons are the tail): rerunning gives the
  // same answer. By name, so this module does not import the step runner.
  if (link instanceof Error && link.name === "StepError") return "permanent";
  if (link instanceof TransientError) return "transient";
  if (typeof link !== "object" || link === null) return null;
  const fields = link as {
    exitSignal?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
    status?: unknown;
    $fault?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  // A tool killed by a signal (never our own abort: a lost lease is checked first).
  if (typeof fields.exitSignal === "string") return "transient";
  if (typeof fields.code === "string") {
    if (NETWORK_CODES.has(fields.code) || fields.code.startsWith("UND_ERR_")) return "transient";
  }
  if (link instanceof TypeError && fields.message === "fetch failed") return "transient";
  const httpStatus = fields.$metadata?.httpStatusCode;
  if (typeof httpStatus === "number" && httpStatus >= 500) return "transient";
  if (fields.$fault === "server") return "transient";
  if (typeof fields.name === "string" && TIMEOUT_NAMES.has(fields.name)) return "transient";
  if (typeof fields.status === "number" && fields.status >= 500) return "transient";
  return null;
}

// True when one more try may succeed: the first decisive link of the cause
// chain, outer to inner, says so. Anything unknown (a tool's non-zero exit
// with its message, say) is not transient.
export function isTransient(error: unknown): boolean {
  for (const link of causeChain(error)) {
    const verdict = verdictOf(link);
    if (verdict !== null) return verdict === "transient";
  }
  return false;
}

// The error a store throws for a failed Supabase call: transient for a 5xx or
// postgrest-js's network failure (status 0), plain otherwise.
export function supabaseFailure(
  what: string,
  { error, status }: { error: { message: string }; status: number },
): Error {
  const message = `${what}: ${error.message}`;
  return status >= 500 || status === 0 ? new TransientError(message) : new Error(message);
}

export type FailureKind = "refused" | "answer_refused" | "transient" | "failed";

// What kind of failure an error is, for the job's `failure_kind` and error
// tracking: refused footage, a refused AI answer, else transient or failed by
// isTransient.
export function failureKind(error: unknown): FailureKind {
  if (findCause(error, FootageRefused)) return "refused";
  if (findCause(error, AnswerRefused)) return "answer_refused";
  return isTransient(error) ? "transient" : "failed";
}
