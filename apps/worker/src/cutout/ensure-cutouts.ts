import { type Attributes, type Context, trace } from "@opentelemetry/api";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Edit, HeadTrack, Transcript } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import { parseCutoutProgress, weightedProgress } from "../progress-parsers.ts";
import { spanCropTop } from "./crop.ts";
import { maskToolCall } from "./mask-tool.ts";
import { type PoolLimits, cutoutPool, machineLimits, runPool } from "./pool.ts";
import { recordCutoutSpeed, startCutoutSpeed } from "./speed.ts";
import { MASK_STEP, cutoutKey, withMasks } from "./spans.ts";

export interface EnsureCutouts {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  edit: Edit;
  transcript: Transcript;
  // The reel's head track: each span's crop above the speaker comes from it
  // (null: no crop).
  headTrack: HeadTrack | null;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  // Records that the job's reel needs a mask found already stored (its HEAD
  // size); masks this step writes are recorded by the storage it is given.
  recordStored?: (key: string, bytes: number) => Promise<void>;
  // The span the step is a child of when it is not the job's own (decide's
  // span context); the job span when absent.
  parent?: Context;
  // The CPUs and memory the span tool calls share (the machine's, or the
  // container's; unit tests pass their own).
  limits?: PoolLimits;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// The cut-out step span's counts: the masks this call made and the stored ones
// it reused (`cutout.made`, `cutout.reused`). A step that makes masks adds how
// many it makes at a time (`cutout.parallel`) and the footage it cuts out in
// milliseconds (`cutout.video_ms`).
function cutoutCounts(made: number, reused: number): Attributes {
  return { "cutout.made": made, "cutout.reused": reused };
}

// Makes sure every padded span of the edit's behind items has its person mask
// stored, before a version naming them is saved or rendered. Each mask is
// fingerprinted by footage, span, crop and tool version (maskSpans gives the same
// spans the builder draws). All stored: a hit row (`cut-out reused`). Else one
// measured `cutout` step downloads the footage once, runs the mask tool for
// each missing span, several at a time (cutoutPool: as many as the CPUs and
// the memory allow, the longest first, the CPUs shared out as ONNX threads;
// each span's per-frame progress weighted by its length across the step), and
// uploads each mask put-if-absent as its call ends, so a stored mask is never
// replaced. A failed span stops the ones not started; the step fails once the
// running ones have ended. Returns the edit with `inputs.masks` (by start) naming them; an
// edit without behind items comes back without masks, and one whose only items
// are VISUALs in front of the speaker has none; neither writes a row.
export async function ensureCutouts({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  edit,
  transcript,
  headTrack,
  tools,
  spawnTool,
  env = process.env,
  recordStored,
  parent,
  limits = machineLimits(),
}: EnsureCutouts): Promise<Edit> {
  const named = withMasks(edit, transcript, headTrack);
  const items = edit.tracks.behind ?? [];
  if (items.length === 0) return named;
  const { signal } = ctx;
  // The same step, its span under `parent` when one is given.
  const stepCtx: StepContext = parent ? { ...ctx, jobContext: parent } : ctx;
  const started = performance.now();

  // VISUALs in front of the speaker only: no cut-out to make or reuse.
  if ((named.inputs.masks ?? []).length === 0) return named;
  const footage = edit.inputs.footage;
  const spans = (named.inputs.masks ?? []).map((mask) => ({
    ...mask,
    key: cutoutKey(keyPrefix, mask.fingerprint),
  }));
  const stored = await Promise.all(spans.map((span) => storage.head(span.key, { signal })));
  signal.throwIfAborted();
  if (recordStored) {
    for (const [index, object] of stored.entries()) {
      if (object) await recordStored(spans[index]!.key, object.bytes);
    }
  }
  const missing = spans.filter((_, index) => stored[index] === null);

  if (missing.length === 0) {
    await recordHit(stepCtx, {
      name: MASK_STEP,
      summary: "cut-out reused",
      wallMs: elapsedMs(started),
      attributes: cutoutCounts(0, spans.length),
    });
  } else {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own scratch folder
    await mkdir(scratchDir, { recursive: true });
    const dir = await mkdtemp(join(scratchDir, "cutout-"));
    const footagePath = join(dir, "footage.mp4");
    const outputs = missing.map((span) => join(dir, `${span.fingerprint}.mp4`));
    const lengths = missing.map((span) => span.end - span.start);
    // The footage this step cuts out: the made spans' lengths.
    const videoSeconds = lengths.reduce((sum, length) => sum + length, 0);
    const pool = cutoutPool(lengths, limits);
    // The longest first: it decides how long the step lasts.
    const order = [...missing.keys()].sort((a, b) => lengths[b]! - lengths[a]!);
    try {
      startCutoutSpeed(ctx.telemetry.meter);
      await ctx.telemetry.flushMetrics();
      const stepStarted = performance.now();
      await runToolsStep(
        stepCtx,
        {
          name: MASK_STEP,
          inputs: [footagePath],
          outputs,
          sizeOf: "out",
          async work(tool, cutoutContext) {
            trace.getSpan(cutoutContext)?.setAttributes({
              ...cutoutCounts(missing.length, spans.length - missing.length),
              "cutout.parallel": pool.concurrency,
              "cutout.video_ms": Math.round(videoSeconds * 1000),
            });
            const footageKey = cacheKey(keyPrefix, footage.step, footage.fingerprint, footage.file);
            if (!(await storage.getFile(footageKey, footagePath, { signal }))) {
              throw new Error(`${MASK_STEP}: input missing: ${footageKey}`);
            }
            const progress = weightedProgress(parseCutoutProgress, lengths);
            await runPool(order, pool.concurrency, async (index) => {
              const span = missing[index]!;
              const output = outputs[index]!;
              const call = maskToolCall(
                {
                  input: footagePath,
                  start: span.start,
                  end: span.end,
                  cropTop: spanCropTop(headTrack, span),
                  threads: pool.threads[index]!,
                  output,
                },
                { tools, env },
              );
              // The call's memory is the entry's and its two ffmpegs' together.
              await tool({ ...call, sampleGroupMemory: true, progress: progress[index]! });
              signal.throwIfAborted();
              await storage.putFileIfAbsent(span.key, output, { contentType: "video/mp4" });
            });
            const reused = spans.length - missing.length;
            return {
              what: `${plural(missing.length, "cut-out")} made, ${reused} reused, ${videoSeconds.toFixed(1)} s masked`,
            };
          },
        },
        spawnTool,
      );
      // Only a step that succeeded: a failed one throws before this line.
      recordCutoutSpeed(
        ctx.telemetry.meter,
        videoSeconds,
        (performance.now() - stepStarted) / 1000,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return named;
}
