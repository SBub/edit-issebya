import type { AiUsage } from "./step-store.ts";

// The one classification of a step's or a job's failure (app_docs/failures.md):
// `transient` re-runs the step once; `ai_unavailable` makes the job wait for the
// AI; `refused` refuses the reel's footage; anything else is `permanent` and
// stops the job with the step's error tail.
export type FailureKind = "transient" | "ai_unavailable" | "refused" | "permanent";

// The footage check refused the clip: the message is the owner's.
export class FootageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootageRefusedError";
  }
}

// Claude Code cannot answer now (a usage limit, signed out): the job waits.
export class AiUnavailableError extends Error {
  readonly reason: string;
  readonly ai: AiUsage | undefined;

  constructor(reason: string, ai?: AiUsage) {
    super(`the AI is unavailable: ${reason}`);
    this.name = "AiUnavailableError";
    this.reason = reason;
    this.ai = ai;
  }
}

// How a tool's child process ended, carried on the error a failed call throws.
export interface ToolExit {
  code: number | null;
  signal: string | null;
  stdout: string;
}

const MAX_DEPTH = 8;

function* chain(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth < MAX_DEPTH && current !== undefined && current !== null; depth++) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function isToolExit(value: unknown): value is ToolExit {
  if (!value || typeof value !== "object") return false;
  const { code, signal } = value as Record<string, unknown>;
  return (
    (code === null || typeof code === "number") && (signal === null || typeof signal === "string")
  );
}

// The tool exit an error carries, itself or through its `cause`; null when none.
export function toolExitOf(error: unknown): ToolExit | null {
  for (const link of chain(error)) {
    const exit = (link as { exit?: unknown }).exit;
    if (isToolExit(exit)) return exit;
  }
  return null;
}

// A failed Supabase call: the message names what was not done, `status` is the
// PostgREST HTTP status (0 when the request never got an answer).
export interface DbFailure extends Error {
  status: number;
}

export function dbFailure(
  what: string,
  { error, status }: { error: { message: string } | null; status?: number },
): DbFailure {
  const failure = new Error(`${what}: ${error?.message ?? "no data"}`, {
    cause: error ?? undefined,
  }) as DbFailure;
  failure.status = status ?? 0;
  return failure;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

// Storage (AWS SDK) and fetch errors that say "try again".
const TRANSIENT_NAMES = new Set([
  "TimeoutError",
  "RequestTimeout",
  "ServiceUnavailable",
  "InternalError",
  "SlowDown",
]);

function linkKind(link: unknown): FailureKind | null {
  if (link instanceof FootageRefusedError) return "refused";
  if (link instanceof AiUnavailableError) return "ai_unavailable";
  if (!link || typeof link !== "object") return null;
  const value = link as Record<string, unknown>;
  // A decide refusal and a schema or check failure: running again changes nothing.
  if (value.name === "StepError" || value.name === "ZodError") return "permanent";
  if (isToolExit(value.exit)) {
    // A tool killed by a signal (memory pressure, the system) may pass next time;
    // a tool that answered with a non-zero exit will answer the same.
    if (typeof value.exit.code === "number") return "permanent";
    if (value.exit.signal !== null) return "transient";
  }
  if (typeof value.code === "string" && NETWORK_CODES.has(value.code)) return "transient";
  if (value instanceof TypeError && value.message === "fetch failed") return "transient";
  if (typeof value.name === "string" && TRANSIENT_NAMES.has(value.name)) return "transient";
  const metadata = value.$metadata as { httpStatusCode?: unknown } | undefined;
  if (typeof metadata?.httpStatusCode === "number" && metadata.httpStatusCode >= 500) {
    return "transient";
  }
  if (link instanceof Error && typeof value.status === "number") {
    if (value.status === 0 || value.status >= 500) return "transient";
  }
  return null;
}

// The first error of a class in the error's `cause` chain; null when none.
export function causeOf<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | null {
  for (const link of chain(error)) if (link instanceof type) return link;
  return null;
}

// Walks the error and its `cause` chain (bounded): the first link that names a
// kind decides; an error nothing recognises is permanent.
export function classifyFailure(error: unknown): FailureKind {
  for (const link of chain(error)) {
    const kind = linkKind(link);
    if (kind) return kind;
  }
  return "permanent";
}
