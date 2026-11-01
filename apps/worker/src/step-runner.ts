import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { type Context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { errorTail } from "./errors.ts";
import { sampleTreeRss } from "./process-tree.ts";
import type { ClaimedJob } from "./queue.ts";
import type { StepMeasurements, StepStore } from "./step-store.ts";
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
  // The job's own scratch directory, removed when the job ends.
  scratch: string;
}

export interface ChildStep {
  name: string;
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // Files the tool reads and writes; their sizes are bytes_in and bytes_out.
  inputs?: string[];
  outputs?: string[];
  // Also sample the memory of the whole process tree every second (render).
  sampleGroupMemory?: boolean;
  // The summary's first part on success, e.g. `background removed`.
  describe: string;
  // Which size the summary names; "out" falls back to in when nothing is written.
  sizeOf?: "out" | "in";
}

const OUTPUT_CAP = 64 * 1024;
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

  constructor(message: string, tail: string, measurements: StepMeasurements) {
    super(message);
    this.tail = tail;
    this.measurements = measurements;
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
  ) => Promise<{ summary: string; measurements: StepMeasurements }>,
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
    const { summary, measurements } = await body(trace.setSpan(ctx.jobContext, span), started);
    ctx.signal.throwIfAborted();
    setMeasurementAttributes(span, measurements);
    await ctx.steps.done(stepId, summary, measurements);
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
    );
    throw error;
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

interface ChildRun {
  code: number | null;
  exitSignal: NodeJS.Signals | null;
  report: string;
  output: string;
  groupPeakBytes: number | null;
}

// Spawns the tool under `/usr/bin/time` in its own process group.
function runChild(
  spec: ChildStep,
  signal: AbortSignal,
  log: (line: string, stream: StepStream) => void,
): Promise<ChildRun> {
  const [timeBin, timeFlag] = timeCommand(process.platform);
  return new Promise((resolve, reject) => {
    const child = spawn(timeBin, [timeFlag, "/bin/sh", "-c", WRAPPER, spec.file, ...spec.args], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let report = "";
    let groupPeakBytes: number | null = null;
    let sampling: Promise<void> = Promise.resolve();
    let sampler: NodeJS.Timeout | undefined;
    let killer: NodeJS.Timeout | undefined;

    const keep = (line: string, stream: StepStream) => {
      log(line, stream);
      output += `${line}\n`;
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    eachLine(child.stdout!, (line) => keep(line, "stdout"));
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
      void sampling.then(() => resolve({ code, exitSignal, report, output, groupPeakBytes }));
    });
  });
}

// A tool run as its own child process, measured by the operating system:
// wall time, CPU (user + sys), peak RSS, and the sizes of the files it read
// and wrote. Its output lines go to the OTel logger; on failure the tail goes
// to the row and the thrown error.
export function runStep(ctx: StepContext, spec: ChildStep): Promise<void> {
  return withStep(ctx, spec.name, async (stepContext, started) => {
    const bytesIn = await totalSize(spec.inputs);
    const log = stepLogger(ctx.telemetry, stepContext, {
      "reel.id": ctx.job.reel_id,
      "job.id": ctx.job.id,
      "step.name": spec.name,
    });
    const run = await runChild(spec, ctx.signal, log);
    const wallMs = elapsedMs(started);
    ctx.signal.throwIfAborted();

    const toolStarted = run.code === null || !NOT_STARTED.has(run.code);
    const report = toolStarted ? parseTimeReport(process.platform, run.report) : null;
    const peaks = [report?.peakRssBytes, toolStarted ? run.groupPeakBytes : null].filter(
      (value): value is number => typeof value === "number",
    );
    const bytesOut = await totalSize(spec.outputs);
    const measurements: StepMeasurements = {
      wall_ms: wallMs,
      cpu_ms: report?.cpuMs ?? null,
      peak_rss_bytes: peaks.length > 0 ? Math.max(...peaks) : null,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
    };

    if (run.code === 0) {
      const sizeBytes = spec.sizeOf === "in" ? bytesIn : (bytesOut ?? bytesIn);
      return { summary: stepSummary({ what: spec.describe, wallMs, sizeBytes }), measurements };
    }
    const tail = outputTail(run.output);
    const how = run.code ?? run.exitSignal ?? "unknown";
    throw new StepFailure(`${spec.name} exited with ${how}\n${tail}`, tail, measurements);
  });
}
