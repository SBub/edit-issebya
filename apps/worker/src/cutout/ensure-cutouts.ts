import type { Context } from "@opentelemetry/api";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Edit, Transcript } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import { maskToolCall } from "./mask-tool.ts";
import { MASK_STEP, cutoutKey, withMasks } from "./spans.ts";

export interface EnsureCutouts {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  edit: Edit;
  transcript: Transcript;
  // The reel owner's ready library photos: a behind photo must be one of them
  // (a new version). Omitted, photos are not checked here (a restore or a
  // render of a version saved before; the render fails on a deleted photo).
  photoIds?: readonly string[];
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
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

// Makes sure every padded span of the edit's behind items has its person mask
// stored, before a version naming them is saved or rendered. Each mask is
// fingerprinted by footage, span and tool version (maskSpans gives the same
// spans the builder draws). All stored: a hit row (`cut-out reused`). Else one
// measured `cutout` step downloads the footage once, runs the mask tool for
// each missing span and uploads it put-if-absent, so a stored mask is never
// replaced. Returns the edit with `inputs.masks` (by start) and
// `inputs.photos` (sorted) naming them; an edit without behind items comes
// back without either, and one whose only items are photos in front of the
// speaker with its photos and no masks; neither writes a row.
export async function ensureCutouts({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  edit,
  transcript,
  photoIds,
  tools,
  spawnTool,
  env = process.env,
  platform = process.platform,
  recordStored,
  parent,
}: EnsureCutouts): Promise<Edit> {
  const named = withMasks(edit, transcript);
  const items = edit.tracks.behind ?? [];
  if (items.length === 0) return named;
  const { signal } = ctx;
  // The same step, its span under `parent` when one is given.
  const stepCtx: StepContext = parent ? { ...ctx, jobContext: parent } : ctx;
  const started = performance.now();

  if (photoIds) {
    const library = new Set(photoIds);
    for (const item of items) {
      if (item.kind === "photo" && !library.has(item.photo_id)) {
        throw new Error(`${MASK_STEP}: photo ${item.photo_id} is not in the library`);
      }
    }
  }

  // Photos in front of the speaker only: no cut-out to make or reuse.
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
          async work(tool) {
            const footageKey = cacheKey(keyPrefix, footage.step, footage.fingerprint, footage.file);
            if (!(await storage.getFile(footageKey, footagePath, { signal }))) {
              throw new Error(`${MASK_STEP}: input missing: ${footageKey}`);
            }
            let seconds = 0;
            for (const [index, span] of missing.entries()) {
              const output = outputs[index]!;
              await tool(
                maskToolCall(
                  { input: footagePath, start: span.start, end: span.end, output },
                  { tools, env, platform },
                ),
              );
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
