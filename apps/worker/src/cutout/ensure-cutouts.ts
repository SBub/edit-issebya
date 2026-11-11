import { type Attributes, type Context, trace } from "@opentelemetry/api";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Edit, HeadTrack, Transcript } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import { parseCutoutProgress, partProgress } from "../progress-parsers.ts";
import { spanCropTop } from "./crop.ts";
import { maskToolCall } from "./mask-tool.ts";
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
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// The cut-out step span's counts: the masks this call made and the stored ones
// it reused (`cutout.made`, `cutout.reused`).
function cutoutCounts(made: number, reused: number): Attributes {
  return { "cutout.made": made, "cutout.reused": reused };
}

// Makes sure every padded span of the edit's behind items has its person mask
// stored, before a version naming them is saved or rendered. Each mask is
// fingerprinted by footage, span, crop and tool version (maskSpans gives the same
// spans the builder draws). All stored: a hit row (`cut-out reused`). Else one
// measured `cutout` step downloads the footage once, runs the mask tool for
// each missing span (its per-frame progress weighted by the span's length
// across the step) and uploads it put-if-absent, so a stored mask is never
// replaced. Returns the edit with `inputs.masks` (by start) naming them; an
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
    try {
      await runToolsStep(
        stepCtx,
        {
          name: MASK_STEP,
          inputs: [footagePath],
          outputs,
          sizeOf: "out",
          async work(tool, cutoutContext) {
            trace
              .getSpan(cutoutContext)
              ?.setAttributes(cutoutCounts(missing.length, spans.length - missing.length));
            const footageKey = cacheKey(keyPrefix, footage.step, footage.fingerprint, footage.file);
            if (!(await storage.getFile(footageKey, footagePath, { signal }))) {
              throw new Error(`${MASK_STEP}: input missing: ${footageKey}`);
            }
            const total = missing.reduce((sum, span) => sum + (span.end - span.start), 0);
            let seconds = 0;
            for (const [index, span] of missing.entries()) {
              const output = outputs[index]!;
              const call = maskToolCall(
                {
                  input: footagePath,
                  start: span.start,
                  end: span.end,
                  cropTop: spanCropTop(headTrack, span),
                  output,
                },
                { tools, env },
              );
              const from = (100 * seconds) / total;
              const to = (100 * (seconds + span.end - span.start)) / total;
              await tool({ ...call, progress: partProgress(parseCutoutProgress, from, to) });
              signal.throwIfAborted();
              await storage.putFileIfAbsent(span.key, output, { contentType: "video/mp4" });
              seconds += span.end - span.start;
            }
            const reused = spans.length - missing.length;
            return {
              what: `${plural(missing.length, "cut-out")} made, ${reused} reused, ${seconds.toFixed(1)} s masked`,
            };
          },
        },
        spawnTool,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return named;
}
