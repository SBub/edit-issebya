import { access, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Storage } from "@edit-issebya/storage";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import { PIPELINE, type PipelineStep, fingerprintsFor } from "./definition.ts";
import { type FileRef, cacheKey } from "./fingerprint.ts";
import type { ToolPaths } from "./tools.ts";

export interface PipelineRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  // The job's files go to `<scratchDir>/job-<job id>/`, removed at the end.
  scratchDir: string;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  pipeline?: readonly PipelineStep[];
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function contentType(file: string): string {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

// Runs the fixed steps in order. A step whose outputs are all stored under its
// fingerprint is a hit (no download, no process); any other step downloads the
// inputs it declares, runs in its own folder and uploads each missing output
// with put-if-absent, so a stored output is never replaced. A failed job's
// retry therefore resumes at the step that failed. After a lost lease nothing
// more is written.
export async function runPipeline({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  tools,
  spawnTool,
  pipeline = PIPELINE,
}: PipelineRun): Promise<void> {
  const { steps, job, signal } = ctx;
  const sourceKey = await steps.sourceKey(job.reel_id);
  if (!sourceKey) throw new Error("reel has no source key");
  const head = await storage.head(sourceKey, { signal });
  signal.throwIfAborted();
  if (!head) throw new Error("source object missing");
  // Never fingerprint without it: the size alone does not name the content.
  if (!head.etag) throw new Error("source object has no ETag");
  const source = { etag: head.etag, bytes: head.bytes };
  const fingerprints = fingerprintsFor(source, pipeline);

  const jobDir = join(scratchDir, `job-${job.id}`);
  const keyOf = (ref: FileRef) =>
    "source" in ref ? sourceKey : cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
  // Downloads have their own folder: an input never shares a name with an output.
  const downloadPath = (ref: FileRef) =>
    "source" in ref ? join(jobDir, "inputs", "source") : join(jobDir, "inputs", ref.step, ref.file);
  // Storage keys already on disk in this job: earlier outputs and downloads.
  const local = new Map<string, string>();

  await rm(jobDir, { recursive: true, force: true });
  try {
    for (const step of pipeline) {
      const started = performance.now();
      const fingerprint = fingerprints[step.name]!;
      const outputKeys = step.outputs.map((file) =>
        cacheKey(keyPrefix, step.name, fingerprint, file),
      );
      const stored = await Promise.all(outputKeys.map((key) => storage.head(key, { signal })));
      signal.throwIfAborted();
      await steps.reelStatus(job.reel_id, step.reelStatus);
      if (stored.every((object) => object !== null)) {
        await recordHit(ctx, {
          name: step.name,
          summary: `${step.reusedWhat}, reused`,
          wallMs: elapsedMs(started),
        });
        continue;
      }

      const stepDir = join(jobDir, step.name);
      const inputs = step.inputs(source, fingerprints);
      const files = Object.fromEntries(
        inputs.map((input) => [input.as, local.get(keyOf(input.ref)) ?? downloadPath(input.ref)]),
      );
      const outputPaths = step.outputs.map((file) => join(stepDir, file));
      await runToolsStep(
        ctx,
        {
          name: step.name,
          inputs: Object.values(files),
          outputs: outputPaths,
          async work(tool) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
            await mkdir(stepDir, { recursive: true });
            for (const input of inputs) {
              const key = keyOf(input.ref);
              if (local.has(key)) continue;
              const path = downloadPath(input.ref);
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
              await mkdir(dirname(path), { recursive: true });
              if (!(await storage.getFile(key, path, { signal }))) {
                throw new Error(`${step.name}: input missing: ${key}`);
              }
              local.set(key, path);
            }
            const result = await step.run({
              tool,
              tools,
              dir: stepDir,
              files,
              settings: step.settings,
              signal,
            });
            for (const [index, file] of step.outputs.entries()) {
              if (!(await exists(outputPaths[index]!))) {
                throw new Error(`${step.name} did not write ${file}`);
              }
            }
            for (const [index, file] of step.outputs.entries()) {
              const key = outputKeys[index]!;
              local.set(key, outputPaths[index]!);
              // Stored already: that object stays.
              if (stored[index]) continue;
              signal.throwIfAborted();
              await storage.putFileIfAbsent(key, outputPaths[index]!, {
                contentType: contentType(file),
              });
            }
            return result;
          },
        },
        spawnTool,
      );
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
}
