import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { type Context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { errorTail } from "./errors.ts";
import { sampleTreeRss } from "./process-tree.ts";
import type { ClaimedJob } from "./queue.ts";
import type { AiUsage, StepMeasurements, StepStore } from "./step-store.ts";
import { outputTail, stepSummary } from "./summary.ts";
import { type StepStream, type Telemetry, stepLogger } from "./telemetry.ts";
import { parseTimeReport, timeCommand } from "./time-report.ts";

// What every step of a job shares.
export interface StepContext {
  steps: StepStore;
  telemetry: Telemetry;
  // The job span's context; each step span is its child.
  jobContext: Context;
  job: ClaimedJob;
  // Aborted when the lease is lost: the step stops and writes nothing more.
  signal: AbortSignal;
}

// One tool call: a child process.
export interface ToolCall {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Also sample the memory of the whole process tree every second (render).
  sampleGroupMemory?: boolean;
  // Written to the child's stdin, which is then closed; without it stdin is
  // not connected.
  input?: string;
  // The call fails after this long: the group gets SIGTERM, then SIGKILL.
  timeoutMs?: number;
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
  // `ai` reports one AI call's usage; the row holds the sum, done or failed.
  work: (tool: Tool, ai: (usage: AiUsage) => void) => Promise<{ what: string }>;
}

// Thrown by a step's work to set the failed row's error tail itself (the
// stack's last lines are the default).
export class StepTailError extends Error {
  readonly tail: string;

  constructor(message: string, tail: string = message) {
    super(message);
    this.tail = tail;
  }
}

const OUTPUT_CAP = 64 * 1024;
// A tool's answer on stdout (Claude Code's envelope holds the answer twice).
const STDOUT_CAP = 16 * 1024 * 1024;
const SAMPLE_EVERY_MS = 1000;
const KILL_AFTER_MS = 5000;
// Wraps the tool so its stderr goes to fd 3 and `/usr/bin/time`'s report alone
// to fd 2. `$0` is the tool, `$@` its arguments: nothing is shell-interpreted.
const WRAPPER = 'exec "$0" "$@" 2>&3';
// sh's codes for a tool it could not find or execute: the report is sh's own.
const NOT_STARTED = new Set([126, 127]);

// A failed step's measurements and tail, carried to the row write.
class StepFailure extends Error {
  readonly tail: string;
  readonly measurements: StepMeasurements;
  readonly ai: AiUsage | undefined;

  constructor(message: string, tail: string, measurements: StepMeasurements, ai?: AiUsage) {
    super(message);
    this.tail = tail;
    this.measurements = measurements;
    this.ai = ai;
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
async function withStep(
  ctx: StepContext,
  name: string,
  body: (
    stepContext: Context,
    started: number,
  ) => Promise<{ summary: string; measurements: StepMeasurements; ai?: AiUsage }>,
): Promise<void> {
  ctx.signal.throwIfAborted();
  const stepId = await ctx.steps.start(ctx.job, name);
  const span = ctx.telemetry.tracer.startSpan(
    `step ${name}`,
    { attributes: { "reel.id": ctx.job.reel_id, "job.id": ctx.job.id, "step.name": name } },
    ctx.jobContext,
  );
  const started = performance.now();
  try {
    const { summary, measurements, ai } = await body(trace.setSpan(ctx.jobContext, span), started);
    ctx.signal.throwIfAborted();
    setMeasurementAttributes(span, measurements);
    await ctx.steps.done(stepId, summary, measurements, ai);
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    // A lost lease: another worker may hold the job now.
    if (ctx.signal.aborted) throw error;
    const failure = error instanceof StepFailure ? error : null;
    const measurements = failure?.measurements ?? emptyMeasurements(elapsedMs(started));
    setMeasurementAttributes(span, measurements);
    await ctx.steps.failed(
      stepId,
      failure?.tail ?? outputTail(errorTail(error)),
      stepSummary({ what: `${name} failed`, wallMs: measurements.wall_ms, sizeBytes: null }),
      measurements,
      failure?.ai,
    );
    throw error;
  } finally {
    span.end();
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
  // stdout alone (a tool's JSON answer), capped at 16 MB.
  stdout: string;
  groupPeakBytes: number | null;
  // The call's timeoutMs ran out and the group was killed.
  timedOut?: boolean;
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
const runChild: SpawnTool = (spec, signal, log) => {
  const [timeBin, timeFlag] = timeCommand(process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(timeBin, [timeFlag, "/bin/sh", "-c", WRAPPER, spec.file, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: [spec.input === undefined ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
      detached: true,
    });
    if (spec.input !== undefined) {
      // A child that exits without reading its input is reported by its exit.
      child.stdin!.on("error", () => {});
      child.stdin!.end(spec.input);
    }
    let output = "";
    let stdout = "";
    let report = "";
    let groupPeakBytes: number | null = null;
    let sampling: Promise<void> = Promise.resolve();
    let sampler: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const keep = (line: string, stream: StepStream) => {
      log(line, stream);
      output = capped(`${output}${line}\n`);
    };
    eachLine(child.stdout!, (line) => {
      stdout = capped(`${stdout}${line}\n`, STDOUT_CAP);
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
    const stop = () => {
      if (killer) return;
      killGroup("SIGTERM");
      killer = setTimeout(() => killGroup("SIGKILL"), KILL_AFTER_MS);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (spec.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, spec.timeoutMs);
    }

    const cleanUp = () => {
      clearInterval(sampler);
      clearTimeout(killer);
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.on("close", (code, exitSignal) => {
      cleanUp();
      void sampling.then(() =>
        resolve({ code, exitSignal, report, output, stdout, groupPeakBytes, timedOut }),
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
  spawnTool: SpawnTool = runChild,
): Promise<void> {
  return withStep(ctx, spec.name, async (stepContext, started) => {
    const log = stepLogger(ctx.telemetry, stepContext, {
      "reel.id": ctx.job.reel_id,
      "job.id": ctx.job.id,
      "step.name": spec.name,
    });
    let cpuMs: number | null = null;
    let peakRssBytes: number | null = null;
    let usage: AiUsage | undefined;
    // Tokens and cost added up (null only while no call reported one), the
    // model the last one named.
    const reportAi = (reported: AiUsage) => {
      const add = (a: number | null | undefined, b: number | null) =>
        a === null || a === undefined ? b : b === null ? a : a + b;
      usage = {
        inputTokens: add(usage?.inputTokens, reported.inputTokens),
        outputTokens: add(usage?.outputTokens, reported.outputTokens),
        costUsd: add(usage?.costUsd, reported.costUsd),
        model: reported.model ?? usage?.model ?? null,
      };
    };

    const measure = async (): Promise<StepMeasurements> => ({
      wall_ms: elapsedMs(started),
      cpu_ms: cpuMs,
      peak_rss_bytes: peakRssBytes,
      bytes_in: await totalSize(spec.inputs),
      bytes_out: await totalSize(spec.outputs),
    });

    const tool: Tool = async (call) => {
      const run = await spawnTool(call, ctx.signal, log);
      ctx.signal.throwIfAborted();
      const toolStarted = run.code === null || !NOT_STARTED.has(run.code);
      const report = toolStarted ? parseTimeReport(process.platform, run.report) : null;
      if (report) cpuMs = (cpuMs ?? 0) + report.cpuMs;
      for (const peak of [report?.peakRssBytes, toolStarted ? run.groupPeakBytes : null]) {
        if (typeof peak === "number") peakRssBytes = Math.max(peakRssBytes ?? 0, peak);
      }
      if (run.code === 0 && !run.timedOut) return run.stdout;
      if (run.timedOut) {
        const message = `${spec.name} timed out after ${Math.round((call.timeoutMs ?? 0) / 1000)} s`;
        const tail = outputTail(`${run.output}${message}`);
        throw new StepFailure(`${message}\n${tail}`, tail, await measure(), usage);
      }
      const tail = outputTail(run.output);
      const how = run.code ?? run.exitSignal ?? "unknown";
      // Measured here: the wall time ends at the failing call.
      throw new StepFailure(
        `${spec.name} exited with ${how}\n${tail}`,
        tail,
        await measure(),
        usage,
      );
    };

    let what: string;
    try {
      ({ what } = await spec.work(tool, reportAi));
    } catch (error) {
      if (error instanceof StepFailure || ctx.signal.aborted) throw error;
      // A failure between calls (a download, a parse) keeps what was measured;
      // a StepTailError brings its own tail.
      const failure = new StepFailure(
        error instanceof Error ? error.message : String(error),
        outputTail(error instanceof StepTailError ? error.tail : errorTail(error)),
        await measure(),
        usage,
      );
      failure.cause = error;
      throw failure;
    }
    const wallMs = elapsedMs(started);
    const measurements = { ...(await measure()), wall_ms: wallMs };
    const sizeBytes =
      spec.sizeOf === "in"
        ? measurements.bytes_in
        : (measurements.bytes_out ?? measurements.bytes_in);
    return { summary: stepSummary({ what, wallMs, sizeBytes }), measurements, ai: usage };
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
