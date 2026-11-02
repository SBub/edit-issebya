import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Storage } from "@edit-issebya/storage";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import { PIPELINE, type PipelineStep, fingerprintsFor, outputFiles } from "./definition.ts";
import { checkFootage as probeFootage } from "./footage-check.ts";
import { type FileRef, cacheKey } from "./fingerprint.ts";
import type { RunStep } from "./step-double.ts";
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
  // false: the reel's status never moves (a render runs on a processed reel).
  setReelStatus?: boolean;
  // Records that the job's reel needs an output it found already stored, with
  // the size its HEAD gave. Outputs this run writes are recorded by the
  // storage the job is given.
  recordStored?: (key: string, bytes: number) => Promise<void>;
  // true (a `process` job): the `check_footage` step first, which downloads
  // the source and refuses footage the studio cannot take before any heavy
  // step runs. A render never checks.
  checkFootage?: boolean;
  // How a step that must run is run (the specs' step double); default the
  // step's own `run`.
  runStep?: RunStep;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function contentType(file: string): string {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".webm")) return "video/webm";
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
// more is written. Returns every step's fingerprint, for the steps after it.
export async function runPipeline({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  tools,
  spawnTool,
  pipeline = PIPELINE,
  setReelStatus = true,
  recordStored,
  checkFootage = false,
  runStep,
}: PipelineRun): Promise<{ fingerprints: Record<string, string> }> {
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

  // After a step naming the footage length (retime), while the reel has none:
  // read from the step's own output when it ran, else from the kept file,
  // downloaded. Before the long steps, so the studio has it while they run.
  const recordFootage = async (step: PipelineStep, fingerprint: string) => {
    if (!step.footage) return;
    if ((await steps.footageSeconds(job.reel_id)) !== null) return;
    const ref = { step: step.name, fingerprint, file: step.footage.file };
    const key = keyOf(ref);
    let path = local.get(key);
    if (!path) {
      path = downloadPath(ref);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      await mkdir(dirname(path), { recursive: true });
      if (!(await storage.getFile(key, path, { signal }))) {
        throw new Error(`${step.name}: footage length missing: ${key}`);
      }
      local.set(key, path);
    }
    signal.throwIfAborted();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const seconds = step.footage.seconds(await readFile(path, "utf8"));
    await steps.recordFootageSeconds(job.reel_id, seconds);
  };

  await rm(jobDir, { recursive: true, force: true });
  try {
    if (checkFootage) {
      if (setReelStatus) await steps.reelStatus(job.reel_id, "checking_footage");
      // Where convert reads the source: a convert that runs downloads nothing more.
      const sourcePath = downloadPath({ source });
      await runToolsStep(
        ctx,
        {
          name: "check_footage",
          inputs: [sourcePath],
          sizeOf: "in",
          async work(tool) {
            if (!local.has(sourceKey)) {
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
              await mkdir(dirname(sourcePath), { recursive: true });
              if (!(await storage.getFile(sourceKey, sourcePath, { signal }))) {
                throw new Error(`check_footage: source missing: ${sourceKey}`);
              }
              local.set(sourceKey, sourcePath);
            }
            return probeFootage({ tool, tools, path: sourcePath });
          },
        },
        spawnTool,
      );
    }
    for (const step of pipeline) {
      const started = performance.now();
      const fingerprint = fingerprints[step.name]!;
      const outputNames = outputFiles(step);
      const outputKeys = outputNames.map((file) =>
        cacheKey(keyPrefix, step.name, fingerprint, file),
      );
      const stored = await Promise.all(outputKeys.map((key) => storage.head(key, { signal })));
      signal.throwIfAborted();
      if (recordStored) {
        for (const [index, object] of stored.entries()) {
          if (object) await recordStored(outputKeys[index]!, object.bytes);
        }
      }
      if (setReelStatus) await steps.reelStatus(job.reel_id, step.reelStatus);
      if (stored.every((object) => object !== null)) {
        await recordHit(ctx, {
          name: step.name,
          summary: `${step.reusedWhat}, reused`,
          wallMs: elapsedMs(started),
        });
        await recordFootage(step, fingerprint);
        continue;
      }

      const stepDir = join(jobDir, step.name);
      const inputs = step.inputs(source, fingerprints);
      const files = Object.fromEntries(
        inputs.map((input) => [input.as, local.get(keyOf(input.ref)) ?? downloadPath(input.ref)]),
      );
      const outputPaths = outputNames.map((file) => join(stepDir, file));
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
            const args = { tool, tools, dir: stepDir, files, settings: step.settings, signal };
            const result = runStep ? await runStep(step, args, fingerprint) : await step.run(args);
            for (const [index, file] of outputNames.entries()) {
              if (!(await exists(outputPaths[index]!))) {
                throw new Error(`${step.name} did not write ${file}`);
              }
            }
            for (const [index, file] of outputNames.entries()) {
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
      await recordFootage(step, fingerprint);
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
  return { fingerprints };
}
