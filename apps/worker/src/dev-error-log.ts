import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { scrub } from "./scrub.ts";

// The development error log (app_docs/error-tracking.md): with the PostHog
// gate closed, every failure the worker would capture is one JSON line in
// `<WORKER_STATE_DIR or ~/.edit-issebya-worker/dev>/errors.jsonl`, never sent
// anywhere. Rotated by size: at MAX_LOG_BYTES the file becomes
// `errors.1.jsonl` (replacing the older one). `yarn dev:studio errors` reads it
// back in plain words through formatLastFailures.

type Env = Record<string, string | undefined>;

export const MAX_LOG_BYTES = 2 * 1024 * 1024;

// One failure, as written. Never the request text, never an env value.
export interface ErrorLine {
  time: string;
  job_id: string | null;
  job_kind: string | null;
  reel_id?: string | null;
  photo_id?: string | null;
  // null for a job failure outside a step, or a crash.
  step: string | null;
  attempt: number | null;
  // `uncaught` for a crash.
  failure_kind: string;
  // The first line of the tail, scrubbed, at most 300 characters.
  message: string;
  rules?: string[];
  rounds?: number;
}

const MESSAGE_CHARS = 300;

// The first non-empty line of a tail, scrubbed, at most 300 characters.
export function logMessage(tail: string): string {
  const first = tail.split("\n").find((line) => line.trim() !== "") ?? "";
  return scrub(first.trim()).slice(0, MESSAGE_CHARS);
}

export function errorLogPath(env: Env = process.env): string {
  const dir = env.WORKER_STATE_DIR?.trim() || join(homedir(), ".edit-issebya-worker", "dev");
  return join(dir, "errors.jsonl");
}

function rotatedPath(path: string): string {
  return path.replace(/\.jsonl$/, ".1.jsonl");
}

function fileSize(path: string): number {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log's own path
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Appends one line, rotating first when the file is at the limit. A log that
// cannot be written prints one line and never breaks the job.
export function appendErrorLine(
  path: string,
  line: ErrorLine,
  log: (message: string) => void = console.error,
): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log's own folder
    mkdirSync(dirname(path), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log's own path
    if (fileSize(path) >= MAX_LOG_BYTES) renameSync(path, rotatedPath(path));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log's own path
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    log(`worker: error log not written: ${typeof code === "string" ? code : "unknown"}`);
  }
}

function readLines(path: string): ErrorLine[] {
  let text: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the log's own path
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines: ErrorLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as ErrorLine);
    } catch {
      // A torn line (a crash mid-write): skipped.
    }
  }
  return lines;
}

function clock(time: string): string {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function plainWords(line: ErrorLine): string {
  if (line.failure_kind === "answer_refused") {
    const rounds = line.rounds ?? 0;
    const failed = rounds === 2 ? "failed twice" : `failed ${rounds} times`;
    const rules = line.rules?.length ? `; rules ${line.rules.join(", ")}` : "";
    return `the AI's answer ${failed}${rules}; ${rounds} rounds`;
  }
  if (line.failure_kind === "uncaught") return `the worker crashed: ${line.message}`;
  const kind = line.failure_kind === "transient" ? " (may pass on a retry)" : "";
  return `${line.message}${kind}`;
}

function describeLine(line: ErrorLine): string {
  const what = line.step ?? (line.failure_kind === "uncaught" ? "worker" : "job");
  const job = line.job_id ? `job ${line.job_id.slice(0, 8)}...` : null;
  const where = [line.job_kind, job].filter(Boolean).join(", ");
  const attempt = line.attempt && line.attempt > 1 ? ` (attempt ${line.attempt})` : "";
  return `${clock(line.time)} ${what}${where ? ` (${where})` : ""}${attempt}: ${plainWords(line)}`;
}

// The last `count` failures, oldest first, one plain line each, from the
// rotated file and the current one.
export function formatLastFailures(path: string, count = 10): string {
  const lines = [...readLines(rotatedPath(path)), ...readLines(path)].slice(-count);
  if (lines.length === 0) return `No failures logged in ${path}.`;
  return lines.map(describeLine).join("\n");
}
