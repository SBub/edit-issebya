import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { type Context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { errorTail } from "./errors.ts";
import { AiUnavailable, FootageRefused, findCause, isTransient } from "./failure.ts";
import { type ProgressThrottle, createProgressThrottle } from "./progress.ts";
import type { ProgressParser } from "./progress-parsers.ts";
import { sampleTreeRss } from "./process-tree.ts";
import type { ClaimedJob } from "./queue.ts";
import {
  type AiUsage,
  type StepMeasurements,
  type StepStore,
  aiMeasurements,
} from "./step-store.ts";
import { outputTail, stepSummary } from "./summary.ts";
import { type StepStream, type Telemetry, stepLogger } from "./telemetry.ts";
import { parseTimeReport, reportedSignal, timeCommand } from "./time-report.ts";

// What every step of a job shares.
export interface StepContext {
  steps: StepStore;
  telemetry: Telemetry;
  // The job span's context; each step span is its child.
  jobContext: Context;
  job: ClaimedJob;
  // Aborted when the lease is lost: the step stops and writes nothing more.
  signal: AbortSignal;
  // The pause before a step's one automatic retry (default
  // TRANSIENT_RETRY_DELAY_MS; unit tests pass 0).
  retryDelayMs?: number;
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
// one row: CPU summed over the calls, peak memory the largest of them.
export interface ToolsStep {
  name: string;
  // Local files the step reads and writes, measured after `work` (inputs may
  // be downloaded inside it).
  inputs?: string[];
  outputs?: string[];
  sizeOf?: "out" | "in";
  // `ai`: what the step's AI calls used, written as the ai_* measurements.
  work: (tool: Tool) => Promise<{ what: string; ai?: AiUsage }>;
}

// A step that fails with a tail of its own (the reasons, not a stack), and
// the AI usage it spent getting there.
export class StepError extends Error {
  readonly tail: string;
  readonly ai: AiUsage | undefined;

  constructor(message: string, tail: string, ai?: AiUsage) {
    super(message);
    this.name = "StepError";
    this.tail = tail;
    this.ai = ai;
  }
}

const OUTPUT_CAP = 64 * 1024;
const SAMPLE_EVERY_MS = 1000;
const KILL_AFTER_MS = 5000;
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

function emptyMeasurements(wallMs: number): StepMeasurements {
  return { wall_ms: wallMs, cpu_ms: null, peak_rss_bytes: null, bytes_in: null, bytes_out: null };
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
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
// (the job waits). A lost lease is never retried and writes nothing more.
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
    const stepId = await ctx.steps.start(ctx.job, name);
    const span = ctx.telemetry.tracer.startSpan(
      `step ${name}`,
      {
        attributes: {
          "reel.id": ctx.job.reel_id,
          "job.id": ctx.job.id,
          "step.name": name,
          "step.attempt": attempt,
        },
      },
      ctx.jobContext,
    );
    const started = performance.now();
    try {
      const { summary, measurements } = await body(
        trace.setSpan(ctx.jobContext, span),
        started,
        stepId,
      );
      ctx.signal.throwIfAborted();
      setMeasurementAttributes(span, measurements);
      await ctx.steps.done(stepId, summary, measurements);
      return;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      // A lost lease: another worker may hold the job now.
      if (ctx.signal.aborted) throw error;
      const failure = error instanceof StepFailure ? error : null;
      const measurements = failure?.measurements ?? emptyMeasurements(elapsedMs(started));
      setMeasurementAttributes(span, measurements);
      const unavailable = findCause(error, AiUnavailable);
      if (unavailable) {
        await ctx.steps.waiting(
          stepId,
          unavailable.reason,
          `${name} waiting for the AI`,
          measurements,
        );
        throw error;
      }
      const retry = attempt === 1 && isTransient(error);
      await ctx.steps.failed(
        stepId,
        failure?.tail ?? outputTail(errorTail(error)),
        stepSummary({
          what: retry ? `${name} failed, retrying once` : `${name} failed`,
          wallMs: measurements.wall_ms,
          sizeBytes: null,
        }),
        measurements,
      );
      if (!retry) throw error;
    } finally {
      span.end();
    }
    await sleep(ctx.retryDelayMs ?? TRANSIENT_RETRY_DELAY_MS, undefined, { signal: ctx.signal });
  }
}

// A step whose outputs are already stored (a cache hit): one `skipped` row
// with cache_hit, and its span. Nothing is spawned, read or written.
export async function recordHit(
  ctx: StepContext,
  { name, summary, wallMs }: { name: string; summary: string; wallMs: number },
): Promise<void> {
  ctx.signal.throwIfAborted();
  const span = ctx.telemetry.tracer.startSpan(
    `step ${name}`,
    {
      attributes: {
        "reel.id": ctx.job.reel_id,
        "job.id": ctx.job.id,
        "step.name": name,
        "step.cache_hit": true,
        "step.wall_ms": wallMs,
      },
    },
    ctx.jobContext,
  );
  try {
    await ctx.steps.skipped(ctx.job, name, summary, wallMs);
  } finally {
    span.end();
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
    const wallMs = elapsedMs(started);
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

// Spawns the tool under `/usr/bin/time` in its own process group.
export const spawnChild: SpawnTool = (spec, signal, log) => {
  const [timeBin, timeFlag] = timeCommand(process.platform);
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
    const onAbort = () => {
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
      cleanUp();
      void sampling.then(() =>
        resolve({ code, exitSignal, report, output, stdout, groupPeakBytes }),
      );
    });
  });
};

// Several tool calls as one step row. Each call runs as its own child process,
// measured by the operating system; the row has the wall time of the whole
// step, CPU (user + sys) summed over the calls (null when none reported), the
// largest peak RSS, and the sizes of the declared files. Output lines go to the
// OTel logger; a failed call's tail goes to the row and the thrown error, with
// the measurements gathered so far.
export function runToolsStep(
  ctx: StepContext,
  spec: ToolsStep,
  spawnTool: SpawnTool = spawnChild,
): Promise<void> {
  return withStep(ctx, spec.name, async (stepContext, started, stepId) => {
    const log = stepLogger(ctx.telemetry, stepContext, {
      "reel.id": ctx.job.reel_id,
      "job.id": ctx.job.id,
      "step.name": spec.name,
    });
    let cpuMs: number | null = null;
    let peakRssBytes: number | null = null;

    const measure = async (): Promise<StepMeasurements> => ({
      wall_ms: elapsedMs(started),
      cpu_ms: cpuMs,
      peak_rss_bytes: peakRssBytes,
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
      const run = await spawnTool(call, ctx.signal, callLog);
      ctx.signal.throwIfAborted();
      const toolStarted = run.code === null || !NOT_STARTED.has(run.code);
      const report = toolStarted ? parseTimeReport(process.platform, run.report) : null;
      if (report) cpuMs = (cpuMs ?? 0) + report.cpuMs;
      for (const peak of [report?.peakRssBytes, toolStarted ? run.groupPeakBytes : null]) {
        if (typeof peak === "number") peakRssBytes = Math.max(peakRssBytes ?? 0, peak);
      }
      if (run.code === 0) return run.stdout;
      const tail = outputTail(run.output);
      // Killed by a signal is never our abort (checked above): the child
      // itself (code null), or the tool under `/usr/bin/time` (its report).
      const exitSignal =
        run.code === null
          ? (run.exitSignal ?? "signal")
          : toolStarted
            ? reportedSignal(process.platform, run.report)
            : null;
      const how = exitSignal ? `signal ${exitSignal}` : (run.code ?? "unknown");
      // Measured here: the wall time ends at the failing call.
      throw new StepFailure(`${spec.name} exited with ${how}\n${tail}`, tail, await measure(), {
        exitCode: exitSignal ? null : run.code,
        exitSignal,
      });
    };

    let what: string;
    let ai: AiUsage | undefined;
    try {
      ({ what, ai } = await spec.work(tool));
      ctx.signal.throwIfAborted();
      // 100 lands before the `done` write.
      await (throttle as ProgressThrottle | null)?.finish();
    } catch (error) {
      // No progress write after a failure or a lost lease.
      const pending = throttle as ProgressThrottle | null;
      pending?.stop();
      await pending?.settled();
      if (error instanceof StepFailure || ctx.signal.aborted) throw error;
      // A failed call wrapped on its way out (decide marks it permanent):
      // its tail and measurements stay, the wrapper is the cause.
      const call = findCause(error, StepFailure);
      if (call) {
        const failure = new StepFailure(call.message, call.tail, call.measurements);
        failure.cause = error;
        throw failure;
      }
      // A failure between calls (a download, a parse) keeps what was measured;
      // a StepError brings its own tail (its reasons) and AI usage; a refusal
      // its human message. The original error is the cause, so the retry
      // classifier sees it.
      const own = error instanceof StepError ? error : null;
      const refused = error instanceof FootageRefused ? error : null;
      let tail = outputTail(errorTail(error));
      if (own) tail = outputTail(own.tail);
      else if (refused) tail = outputTail(refused.message);
      const failure = new StepFailure(
        error instanceof Error ? error.message : String(error),
        tail,
        { ...(await measure()), ...(own?.ai ? aiMeasurements(own.ai) : {}) },
      );
      failure.cause = error;
      throw failure;
    }
    const wallMs = elapsedMs(started);
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
