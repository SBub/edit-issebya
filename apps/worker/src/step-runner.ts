import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { ErrorTracker } from "./error-tracking.ts";
import { errorTail, failureReason } from "./errors.ts";
import { AiUnavailable, FootageRefused, failureKind, findCause, isTransient } from "./failure.ts";
import { type ProgressThrottle, createProgressThrottle } from "./progress.ts";
import type { ProgressParser } from "./progress-parsers.ts";
import { sampleTreeRss } from "./process-tree.ts";
import type { ClaimedJob } from "./queue.ts";
import { type ReelSizeHolder, reelSizeAttributes } from "./reel-size.ts";
import {
  type AiUsage,
  type StepMeasurements,
  type StepStore,
  aiMeasurements,
} from "./step-store.ts";
import { outputTail, stepSummary } from "./summary.ts";
import {
  type StepStream,
  type Telemetry,
  emitFailureLog,
  failureAttributes,
  runUnderSpan,
  stepLogger,
  targetAttributes,
} from "./telemetry.ts";
import { parseTimeReport, reportedSignal, timeCommand } from "./time-report.ts";

// What every step of a job shares.
export interface StepContext {
  steps: StepStore;
  telemetry: Telemetry;
  // Every failed step row is also captured here (DISABLED_TRACKER in tests).
  errors: ErrorTracker;
  // The job span's context; each step span is its child.
  jobContext: Context;
  job: ClaimedJob;
  // Aborted when the lease is lost, the job was cancelled or its row is gone
  // (its reel or photo was deleted): the step stops and writes nothing more.
  signal: AbortSignal;
  // Checks for a cancel at once and aborts `signal` when there was one (a
  // render job; absent, nothing is checked).
  checkCancelled?: () => Promise<boolean>;
  // Checks at once whether the job's row is gone and aborts `signal` when it
  // is; asked before a failure is written (absent, nothing is checked).
  checkGone?: () => Promise<boolean>;
  // The pause before a step's one automatic retry (default
  // TRANSIENT_RETRY_DELAY_MS; unit tests pass 0).
  retryDelayMs?: number;
  // The clock the step's wall time is read from, in milliseconds (default
  // performance.now; unit tests pass a fixed one, so a duration in a summary
  // is the same on every run, however loaded the machine is).
  clock?: () => number;
  // The reel's size, put on every step span as `reel.*` attributes (none for
  // a photo job or a unit test without it).
  size?: ReelSizeHolder;
}

// The `reel.*` attributes of what the job knows of its reel's size now.
function sizeAttributes(ctx: StepContext) {
  return ctx.size ? reelSizeAttributes(ctx.size.current()) : {};
}

const TRANSIENT_RETRY_DELAY_MS = 2000;

// One tool call: a child process.
export interface ToolCall {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Also sample the memory of the whole process tree every second (render).
  sampleGroupMemory?: boolean;
  // Written to the tool's stdin, then closed; without it stdin is ignored.
  stdin?: string;
  // The cap on the returned stdout (default 64 KB); the logged output keeps
  // the default.
  maxStdoutBytes?: number;
  // Reads the tool's progress from its output lines (the two long steps
  // only); the step writes it to its row, throttled, and 100 before `done`.
  progress?: ProgressParser;
  // The Context the call's `exec` span is a child of; absent, the step's span.
  parent?: Context;
}

export interface ChildStep extends ToolCall {
  name: string;
  // Files the tool reads and writes; their sizes are bytes_in and bytes_out.
  inputs?: string[];
  outputs?: string[];
  // The summary's first part on success, e.g. `background removed`.
  describe: string;
  // Which size the summary names; "out" falls back to in when nothing is written.
  sizeOf?: "out" | "in";
}

// Runs one tool call and resolves with its stdout; a non-zero exit throws.
export type Tool = (call: ToolCall) => Promise<string>;

// A step made of several tool calls (ffprobe, then ffmpeg, say), measured as
// one row: CPU summed over the calls, peak memory the largest of them, or of
// the calls that ran at the same time taken together (see concurrentPeak).
export interface ToolsStep {
  name: string;
  // Local files the step reads and writes, measured after `work` (inputs may
  // be downloaded inside it).
  inputs?: string[];
  outputs?: string[];
  sizeOf?: "out" | "in";
  // `ai`: what the step's AI calls used, written as the ai_* measurements.
  // `stepContext` carries the step's span (an attribute the work learns).
  work: (tool: Tool, stepContext: Context) => Promise<{ what: string; ai?: AiUsage }>;
}

// A step that fails with a tail of its own (the reasons, not a stack), and
// the AI usage it spent getting there.
export class StepError extends Error {
  readonly tail: string;
  readonly ai: AiUsage | undefined;

  constructor(message: string, tail: string, ai?: AiUsage, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StepError";
    this.tail = tail;
    this.ai = ai;
  }
}

const OUTPUT_CAP = 64 * 1024;
const SAMPLE_EVERY_MS = 1000;
const KILL_AFTER_MS = 5000;
// After an abort, how long past the SIGKILL the step waits for the group's
// last process to be reaped, and how often it looks.
const REAP_GRACE_MS = 2000;
const GROUP_POLL_MS = 20;
// Wraps the tool so its stderr goes to fd 3 and `/usr/bin/time`'s report alone
// to fd 2. `$0` is the tool, `$@` its arguments: nothing is shell-interpreted.
const WRAPPER = 'exec "$0" "$@" 2>&3';
// sh's codes for a tool it could not find or execute: the report is sh's own.
const NOT_STARTED = new Set([126, 127]);

// A failed step's measurements and tail, carried to the row write. A failed
// tool call also carries how it ended: its exit code, or the signal that
// killed it (transient, see failure.ts); the original error is the `cause`.
class StepFailure extends Error {
  readonly tail: string;
  readonly measurements: StepMeasurements;
  readonly exitCode: number | null;
  // A signal's name, or `signal` when the report does not name it.
  readonly exitSignal: string | null;

  constructor(
    message: string,
    tail: string,
    measurements: StepMeasurements,
    {
      exitCode = null,
      exitSignal = null,
    }: { exitCode?: number | null; exitSignal?: string | null } = {},
  ) {
    super(message);
    this.tail = tail;
    this.measurements = measurements;
    this.exitCode = exitCode;
    this.exitSignal = exitSignal;
  }
}

// A failure carried out of a wrapper: `error` is its cause, and the message,
// tail and exit are those of the failure it carries (`from`).
function carriedFailure(
  error: unknown,
  from: StepFailure,
  measurements: StepMeasurements,
): StepFailure {
  const failure = new StepFailure(from.message, from.tail, measurements, {
    exitCode: from.exitCode,
    exitSignal: from.exitSignal,
  });
  failure.cause = error;
  return failure;
}

// Every error a step's row failed with and the error tracker captured there.
const STEP_FAILURES = new WeakSet<object>();

// True when the error (or one of its causes) failed a step: its row failed and
// it was captured there, so the job's failure needs no capture of its own.
export function isStepFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && typeof current === "object" && current !== null; depth += 1) {
    if (STEP_FAILURES.has(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function emptyMeasurements(wallMs: number): StepMeasurements {
  return { wall_ms: wallMs, cpu_ms: null, peak_rss_bytes: null, bytes_in: null, bytes_out: null };
}

// The clock a step's wall time is read from (see StepContext.clock).
export function stepClock(ctx: StepContext): () => number {
  return ctx.clock ?? (() => performance.now());
}

function elapsedMs(ctx: StepContext, started: number): number {
  return Math.max(0, Math.round(stepClock(ctx)() - started));
}

// The instant `wallMs` after `startedAt`: where a row or span of that wall time ends.
function endOf(startedAt: Date, wallMs: number): Date {
  return new Date(startedAt.getTime() + wallMs);
}

function setMeasurementAttributes(span: Span, measurements: StepMeasurements): void {
  for (const [column, value] of Object.entries(measurements)) {
    if (value !== null) span.setAttribute(`step.${column}`, value);
  }
}

// The row, the span, the summary and the tail, shared by both entry points.
// The body runs at most twice: a transient failure (failure.ts) on the first
// attempt marks that row failed (`<name> failed, retrying once`) and runs the
// body again in a new row; a second failure, or any other failure, fails the
// step. An unavailable AI writes the row `waiting` and is never retried here
// (the job waits). A lost lease is never retried and writes nothing more, and
// neither is a failure while the job's row is gone (a write refused because
// its reel was deleted): no failed row, no capture.
async function withStep(
  ctx: StepContext,
  name: string,
  body: (
    stepContext: Context,
    started: number,
    stepId: string,
  ) => Promise<{ summary: string; measurements: StepMeasurements }>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    ctx.signal.throwIfAborted();
    // The attempt's start instant: the row's started_at and the span's start.
    // The row ends wall_ms after it, and so does the span (see finishedAt).
    const startedAt = new Date();
    const stepId = await ctx.steps.start(ctx.job, name, startedAt);
    const span = ctx.telemetry.tracer.startSpan(
      `step ${name}`,
      {
        attributes: {
          ...targetAttributes(ctx.job),
          "job.id": ctx.job.id,
          "step.name": name,
          "step.attempt": attempt,
          ...sizeAttributes(ctx),
        },
        startTime: startedAt,
      },
      ctx.jobContext,
    );
    const started = stepClock(ctx)();
    // The span ends at the attempt's wall time, set once it is measured.
    let spanEnd: Date | undefined;
    try {
      const stepContext = trace.setSpan(ctx.jobContext, span);
      const { summary, measurements } = await runUnderSpan(stepContext, () =>
        body(stepContext, started, stepId),
      );
      ctx.signal.throwIfAborted();
      setMeasurementAttributes(span, measurements);
      spanEnd = endOf(startedAt, measurements.wall_ms);
      await ctx.steps.done(stepId, summary, measurements, startedAt);
      return;
    } catch (error) {
      // A lost lease (another worker may hold the job now), or the job's row
      // is gone (its reel was deleted): nothing more is written or captured,
      // and the span is not an error (a cancel ends clean the same way).
      if (ctx.signal.aborted || (await ctx.checkGone?.())) throw error;
      span.setStatus({ code: SpanStatusCode.ERROR });
      const failure = error instanceof StepFailure ? error : null;
      const measurements = failure?.measurements ?? emptyMeasurements(elapsedMs(ctx, started));
      setMeasurementAttributes(span, measurements);
      spanEnd = endOf(startedAt, measurements.wall_ms);
      const unavailable = findCause(error, AiUnavailable);
      if (unavailable) {
        await ctx.steps.waiting(
          stepId,
          unavailable.reason,
          `${name} waiting for the AI`,
          measurements,
          startedAt,
        );
        throw error;
      }
      const retry = attempt === 1 && isTransient(error);
      const tail = failure?.tail ?? outputTail(errorTail(error));
      await ctx.steps.failed(
        stepId,
        tail,
        stepSummary({
          what: retry ? `${name} failed, retrying once` : `${name} failed`,
          wallMs: measurements.wall_ms,
          sizeBytes: null,
        }),
        measurements,
        startedAt,
      );
      ctx.errors.stepFailed({ job: ctx.job, step: name, attempt, retrying: retry, error, tail });
      // One ERROR log record for this failed attempt, in the step's context, and
      // the reasons on the step span (the Tempo view shows them).
      const failed = {
        job: ctx.job,
        step: name,
        attempt,
        retrying: retry,
        failureKind: failureKind(error),
        message: failureReason(error),
        reasons: tail,
      };
      span.addEvent("failure", failureAttributes(failed));
      emitFailureLog(ctx.telemetry, trace.setSpan(ctx.jobContext, span), failed);
      if (typeof error === "object" && error !== null) STEP_FAILURES.add(error);
      if (!retry) throw error;
    } finally {
      span.setAttributes(sizeAttributes(ctx));
      span.end(spanEnd);
    }
    await sleep(ctx.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS, undefined, { signal: ctx.signal });
  }
}

// A step whose outputs are already stored (a cache hit): one `skipped` row
// with cache_hit, and its span. Nothing is spawned, read or written. `attributes`
// are the caller's own span attributes (a cut-out's made and reused counts).
export async function recordHit(
  ctx: StepContext,
  {
    name,
    summary,
    wallMs,
    attributes = {},
  }: { name: string; summary: string; wallMs: number; attributes?: Attributes },
): Promise<void> {
  ctx.signal.throwIfAborted();
  // The hit ended now, so it started wall_ms ago: the row and the span both
  // last exactly wall_ms.
  const startedAt = new Date(Date.now() - wallMs);
  const span = ctx.telemetry.tracer.startSpan(
    `step ${name}`,
    {
      attributes: {
        ...targetAttributes(ctx.job),
        "job.id": ctx.job.id,
        "step.name": name,
        "step.cache_hit": true,
        "step.wall_ms": wallMs,
        ...sizeAttributes(ctx),
        ...attributes,
      },
      startTime: startedAt,
    },
    ctx.jobContext,
  );
  try {
    await ctx.steps.skipped(ctx.job, name, summary, wallMs, startedAt);
  } finally {
    span.setAttributes(sizeAttributes(ctx));
    span.end(endOf(startedAt, wallMs));
  }
}

// Work that stays in the worker's own process (an HTTP call, a row read):
// wall time only, the other measurements null.
export function runInProcessStep(
  ctx: StepContext,
  { name, work }: { name: string; work: () => Promise<{ what: string; sizeBytes: number | null }> },
): Promise<void> {
  return withStep(ctx, name, async (_stepContext, started) => {
    const { what, sizeBytes } = await work();
    const wallMs = elapsedMs(ctx, started);
    return {
      summary: stepSummary({ what, wallMs, sizeBytes }),
      measurements: emptyMeasurements(wallMs),
    };
  });
}

// Sum of the sizes of the files that exist; null when none were declared.
async function totalSize(paths: string[] | undefined): Promise<number | null> {
  if (paths === undefined || paths.length === 0) return null;
  let total = 0;
  for (const path of paths) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's declared files
    const info = await stat(path).catch(() => null);
    if (info) total += info.size;
  }
  return total;
}

function eachLine(stream: Readable, onLine: (line: string) => void): void {
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
}

export interface ChildRun {
  code: number | null;
  exitSignal: NodeJS.Signals | null;
  // `/usr/bin/time`'s report.
  report: string;
  // stdout and stderr lines as they came, capped to the last 64 KB.
  output: string;
  // stdout alone (a tool's JSON answer), capped the same way.
  stdout: string;
  groupPeakBytes: number | null;
}

// How a tool call becomes a child process; tests pass a fake.
export type SpawnTool = (
  spec: ToolCall,
  signal: AbortSignal,
  log: (line: string, stream: StepStream) => void,
) => Promise<ChildRun>;

function capped(text: string, cap = OUTPUT_CAP): string {
  return text.length > cap ? text.slice(-cap) : text;
}

// Spawns the tool under `/usr/bin/time` in its own process group. An abort
// kills the whole group, and the call settles only once the group is gone.
export const spawnChild: SpawnTool = (spec, signal, log) => {
  const [timeBin, timeFlag] = timeCommand(process.platform);
  // An abort listener added now would never fire: nothing is spawned.
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const child = spawn(timeBin, [timeFlag, "/bin/sh", "-c", WRAPPER, spec.file, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [spec.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (spec.stdin !== undefined && child.stdin) {
      // A tool that exits without reading its input closes the pipe: EPIPE is
      // its exit code's business, never a crash of the worker.
      child.stdin.on("error", () => {});
      child.stdin.end(spec.stdin);
    }
    const stdoutCap = spec.maxStdoutBytes ?? OUTPUT_CAP;
    let output = "";
    let stdout = "";
    let report = "";
    let groupPeakBytes: number | null = null;
    let sampling: Promise<void> = Promise.resolve();
    let sampler: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;

    const keep = (line: string, stream: StepStream) => {
      log(line, stream);
      output = capped(`${output}${line}\n`);
    };
    eachLine(child.stdout!, (line) => {
      stdout = capped(`${stdout}${line}\n`, stdoutCap);
      keep(line, "stdout");
    });
    eachLine(child.stdio[3] as Readable, (line) => keep(line, "stderr"));
    child.stderr!.on("data", (chunk: Buffer) => (report += chunk.toString()));

    const pid = child.pid;
    const sample = () => {
      if (pid === undefined) return;
      sampling = sampling
        .then(() => sampleTreeRss(pid))
        .then((bytes) => {
          groupPeakBytes = Math.max(groupPeakBytes ?? 0, bytes);
        })
        // A failed sample (ps unavailable, tree gone) is skipped.
        .catch(() => {});
    };
    if (spec.sampleGroupMemory) {
      sample();
      sampler = setInterval(sample, SAMPLE_EVERY_MS);
    }

    const killGroup = (killSignal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, killSignal);
      } catch {
        // The group is already gone.
      }
    };
    // True once no process of the group is left. A member that exited but is
    // not reaped yet still counts: kill(-pid, 0) is EPERM for it on macOS and
    // succeeds on Linux; only ESRCH means none is left.
    const groupGone = (): boolean => {
      if (pid === undefined) return true;
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    };
    let abortedAt: number | null = null;
    // `close` comes when the last pipe closes, not when the group is gone: a
    // member that let go of the pipes may still run (SIGKILL reaches it), and
    // an exited one may wait for its reaper. Bounded, so a process nobody
    // reaps never holds the step forever.
    const groupExit = async () => {
      if (abortedAt === null) return;
      const deadline = abortedAt + KILL_AFTER_MS + REAP_GRACE_MS;
      while (!groupGone() && performance.now() < deadline) await sleep(GROUP_POLL_MS);
    };
    const onAbort = () => {
      abortedAt = performance.now();
      killGroup("SIGTERM");
      killer = setTimeout(() => killGroup("SIGKILL"), KILL_AFTER_MS);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const cleanUp = () => {
      clearInterval(sampler);
      clearTimeout(killer);
      signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.on("close", (code, exitSignal) => {
      clearInterval(sampler);
      signal.removeEventListener("abort", onAbort);
      // The SIGKILL stays armed until the group is gone.
      void Promise.all([sampling, groupExit()]).then(() => {
        clearTimeout(killer);
        resolve({ code, exitSignal, report, output, stdout, groupPeakBytes });
      });
    });
  });
};

// One `exec` span per tool call, a child of the step's span (or of the call's
// `parent`). Its name is `exec <executable>`; `node` running a script
// (`.mjs`, `.js`, `.cjs`, `.ts`) is named for the script (`exec hyperframes`
// for bin/hyperframes.mjs), and `process.executable.name` stays `node`. Its
// attributes never carry the arguments (paths, prompts): their count, and the
// first one after the script when it is a plain lower-case word.
const SCRIPT = /\.[cm]?[jt]s$/;
const SUBCOMMAND = /^[a-z][a-z-]{0,31}$/;

function execIdentity(file: string, args: readonly string[]) {
  const executable = basename(file);
  const script = args[0];
  if (/^node(\.exe)?$/.test(executable) && script !== undefined && SCRIPT.test(script)) {
    return {
      executable,
      name: `exec ${basename(script).replace(SCRIPT, "")}`,
      rest: args.slice(1),
    };
  }
  return { executable, name: `exec ${executable}`, rest: args };
}

function startExecSpan(telemetry: Telemetry, parent: Context, step: string, call: ToolCall): Span {
  const { executable, name, rest } = execIdentity(call.file, call.args);
  const subcommand = rest[0];
  const attributes: Attributes = {
    "step.name": step,
    "process.executable.name": executable,
    // The argv length, the executable included, as process.command_args counts it.
    "process.args_count": call.args.length + 1,
  };
  if (subcommand !== undefined && SUBCOMMAND.test(subcommand)) {
    attributes["edit_issebya.exec.subcommand"] = subcommand;
  }
  return telemetry.tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }, parent);
}

interface ExecEnd {
  run: ChildRun;
  // False when the tool never started (sh's 126 or 127).
  toolStarted: boolean;
  // The signal that ended the call, or null.
  exitSignal: string | null;
  cpuMs: number | null;
  // This call's peak alone (the step keeps the largest of its calls).
  peakRssBytes: number | null;
  aborted: boolean;
}

// Ends a call's span with what it measured and how it ended. An abort, a tool
// that did not start, a signal and a non-zero exit are errors. The stdout
// count is the captured stdout, capped as the call returns it.
function endExecSpan(
  span: Span,
  { run, toolStarted, exitSignal, cpuMs, peakRssBytes, aborted }: ExecEnd,
): void {
  span.setAttribute("edit_issebya.exec.stdout_bytes", Buffer.byteLength(run.stdout));
  if (run.code !== null) span.setAttribute("process.exit.code", run.code);
  if (exitSignal !== null) span.setAttribute("edit_issebya.exec.signal", exitSignal);
  if (cpuMs !== null) span.setAttribute("edit_issebya.exec.cpu_ms", cpuMs);
  if (peakRssBytes !== null) span.setAttribute("edit_issebya.exec.peak_rss_bytes", peakRssBytes);
  const errorType = aborted
    ? "aborted"
    : !toolStarted
      ? "spawn_error"
      : exitSignal !== null
        ? "signal"
        : run.code !== 0
          ? "nonzero_exit"
          : null;
  if (errorType !== null) {
    const message = aborted
      ? "aborted"
      : !toolStarted
        ? `did not start, exit ${run.code}`
        : exitSignal !== null
          ? `killed by ${exitSignal}`
          : `exited with ${run.code}`;
    span.setAttribute("error.type", errorType);
    span.recordException(message);
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

// A call that threw before it had an outcome (the spawn itself failed).
function failExecSpan(span: Span, errorType: string, error: unknown): void {
  span.setAttribute("error.type", errorType);
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

// One finished call of a step: when it started and ended, as places in the
// order the step's calls started and ended, and its own peak.
interface CallPeak {
  started: number;
  ended: number;
  bytes: number;
}

// The step's peak memory from its finished calls: the largest total of the
// peaks of calls that were running at the same moment. Calls run one after the
// other give the largest single peak; calls run together count together (each
// at its own peak, so the total is an upper bound: the peaks need not fall on
// the same instant). The largest set of calls running together is always
// whole at the moment one of them ends, so only those moments are looked at.
function concurrentPeak(calls: readonly CallPeak[]): number | null {
  let peak: number | null = null;
  for (const one of calls) {
    let together = 0;
    for (const other of calls) {
      if (other.started < one.ended && other.ended >= one.ended) together += other.bytes;
    }
    peak = Math.max(peak ?? 0, together);
  }
  return peak;
}

// Several tool calls as one step row. Each call runs as its own child process,
// measured by the operating system; the row has the wall time of the whole
// step, CPU (user + sys) summed over the calls (null when none reported), the
// largest peak RSS (of one call, or of the calls that ran together, see
// concurrentPeak), and the sizes of the declared files. The work may run its
// calls one after the other or several at once. Each call is an `exec`
// span under the step (see startExecSpan). Output lines go to the OTel logger;
// a failed call's tail goes to the row and the thrown error, with the
// measurements gathered so far.
export function runToolsStep(
  ctx: StepContext,
  spec: ToolsStep,
  spawnTool: SpawnTool = spawnChild,
): Promise<void> {
  return withStep(ctx, spec.name, async (stepContext, started, stepId) => {
    const log = stepLogger(ctx.telemetry, stepContext, {
      ...targetAttributes(ctx.job),
      "job.id": ctx.job.id,
      "step.name": spec.name,
    });
    let cpuMs: number | null = null;
    // Every call that ended with a peak, and the count of starts and ends so far.
    const peaks: CallPeak[] = [];
    let moment = 0;

    const measure = async (): Promise<StepMeasurements> => ({
      wall_ms: elapsedMs(ctx, started),
      cpu_ms: cpuMs,
      peak_rss_bytes: concurrentPeak(peaks),
      bytes_in: await totalSize(spec.inputs),
      bytes_out: await totalSize(spec.outputs),
    });

    // Made by the first call that reads progress; a step without one writes
    // none. A lost lease stops it at once.
    let throttle: ProgressThrottle | null = null;
    const progressThrottle = (): ProgressThrottle => {
      if (throttle) return throttle;
      const made = createProgressThrottle({
        write: (percent) => ctx.steps.progress(stepId, percent),
        onError: (error) =>
          log(
            `progress not written: ${error instanceof Error ? error.message : String(error)}`,
            "stderr",
          ),
      });
      if (ctx.signal.aborted) made.stop();
      ctx.signal.addEventListener("abort", () => made.stop(), { once: true });
      throttle = made;
      return made;
    };

    // This step's own calls that failed (see the catch below).
    const ownFailures = new Set<StepFailure>();
    const tool: Tool = async (call) => {
      const parser = call.progress;
      let callLog = log;
      if (parser) {
        const progress = progressThrottle();
        callLog = (line, stream) => {
          log(line, stream);
          const percent = parser(line);
          if (percent !== null) progress.push(percent);
        };
      }
      // A call after a lost lease never starts.
      ctx.signal.throwIfAborted();
      const exec = startExecSpan(ctx.telemetry, call.parent ?? stepContext, spec.name, call);
      const startedAt = (moment += 1);
      let run: ChildRun;
      try {
        run = await spawnTool(call, ctx.signal, callLog);
      } catch (error) {
        failExecSpan(exec, ctx.signal.aborted ? "aborted" : "spawn_error", error);
        throw error;
      }
      const toolStarted = run.code === null || !NOT_STARTED.has(run.code);
      const report = toolStarted ? parseTimeReport(process.platform, run.report) : null;
      let callPeakBytes: number | null = null;
      for (const peak of [report?.peakRssBytes, toolStarted ? run.groupPeakBytes : null]) {
        if (typeof peak === "number") callPeakBytes = Math.max(callPeakBytes ?? 0, peak);
      }
      // Killed by a signal is never our abort (an abort throws below): the
      // child itself (code null), or the tool under `/usr/bin/time` (its report).
      const exitSignal =
        run.code === null
          ? (run.exitSignal ?? "signal")
          : toolStarted
            ? reportedSignal(process.platform, run.report)
            : null;
      // Ended before any throw below, so the span always ends.
      endExecSpan(exec, {
        run,
        toolStarted,
        exitSignal,
        cpuMs: report?.cpuMs ?? null,
        peakRssBytes: callPeakBytes,
        aborted: ctx.signal.aborted,
      });
      ctx.signal.throwIfAborted();
      // Into the step's totals only once the call was not aborted, as before.
      if (report) cpuMs = (cpuMs ?? 0) + report.cpuMs;
      if (callPeakBytes !== null) {
        peaks.push({ started: startedAt, ended: (moment += 1), bytes: callPeakBytes });
      }
      if (run.code === 0) return run.stdout;
      const tail = outputTail(run.output);
      const how = exitSignal ? `signal ${exitSignal}` : (run.code ?? "unknown");
      // Measured here: the step's own calls so far, its wall time to the failing call.
      const failed = new StepFailure(
        `${spec.name} exited with ${how}\n${tail}`,
        tail,
        await measure(),
        {
          exitCode: exitSignal ? null : run.code,
          exitSignal,
        },
      );
      ownFailures.add(failed);
      throw failed;
    };

    let what: string;
    let ai: AiUsage | undefined;
    try {
      ({ what, ai } = await spec.work(tool, stepContext));
      ctx.signal.throwIfAborted();
      // 100 lands before the `done` write.
      await (throttle as ProgressThrottle | null)?.finish();
    } catch (error) {
      // No progress write after a failure or a lost lease.
      const pending = throttle as ProgressThrottle | null;
      pending?.stop();
      await pending?.settled();
      if (ctx.signal.aborted) throw error;
      // Every failure of this step's attempt measures the whole attempt: its
      // wall time runs from the step's start to here, the nested steps it ran
      // included. Its CPU, memory and bytes are its own calls and files only:
      // a nested step (a cut-out inside decide) has its own row with its own.
      const nested = findCause(error, StepFailure);
      // This step's own call, wrapped on its way out (decide marks it
      // permanent): its tail, exit and measurements stay, only the wall time
      // is the whole step's.
      // The other calls it ran beside may have ended since: measured again.
      if (nested !== null && ownFailures.has(nested)) {
        throw carriedFailure(error, nested, { ...nested.measurements, ...(await measure()) });
      }
      // A failure between calls (a download, a parse) keeps what was measured;
      // a StepError brings its own tail (its reasons) and AI usage; a refusal
      // its human message; a nested step's failure its tail and exit. The
      // original error is the cause, so the retry classifier sees it.
      const own = error instanceof StepError ? error : null;
      const refused = error instanceof FootageRefused ? error : null;
      let tail = outputTail(errorTail(error));
      if (own) tail = outputTail(own.tail);
      else if (refused) tail = outputTail(refused.message);
      else if (nested) tail = nested.tail;
      const measurements = {
        ...(await measure()),
        ...(own?.ai ? aiMeasurements(own.ai) : {}),
      };
      if (nested !== null) throw carriedFailure(error, nested, measurements);
      const failure = new StepFailure(
        error instanceof Error ? error.message : String(error),
        tail,
        measurements,
      );
      failure.cause = error;
      throw failure;
    }
    const wallMs = elapsedMs(ctx, started);
    const measurements = {
      ...(await measure()),
      wall_ms: wallMs,
      ...(ai ? aiMeasurements(ai) : {}),
    };
    const sizeBytes =
      spec.sizeOf === "in"
        ? measurements.bytes_in
        : (measurements.bytes_out ?? measurements.bytes_in);
    return { summary: stepSummary({ what, wallMs, sizeBytes }), measurements };
  });
}

// A tool run as its own child process, measured by the operating system:
// wall time, CPU (user + sys), peak RSS, and the sizes of the files it read
// and wrote. Its output lines go to the OTel logger; on failure the tail goes
// to the row and the thrown error. One call of runToolsStep.
export function runStep(ctx: StepContext, spec: ChildStep): Promise<void> {
  const { name, inputs, outputs, sizeOf, describe, ...call } = spec;
  return runToolsStep(ctx, {
    name,
    inputs,
    outputs,
    sizeOf,
    async work(tool) {
      await tool(call);
      return { what: describe };
    },
  });
}
