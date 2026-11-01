import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Edit,
  type EditInputs,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Transcript,
  type VersionRows,
  build,
  headTrackSchema,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { editMeasurer } from "../edit-measurer.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { runPipeline } from "../pipeline/run-pipeline.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import {
  type SpawnTool,
  type StepContext,
  type Tool,
  recordHit,
  runToolsStep,
} from "../step-runner.ts";
import { exportKey } from "./export-key.ts";
import type { ExportStore } from "./export-store.ts";
import { type RenderRange, renderCall } from "./render-call.ts";
import { writeRenderProject } from "./render-project.ts";

const STEP = "render";

export interface RenderExport {
  tool: Tool;
  tools: ToolPaths;
  // The render's own folder: the project goes to `<dir>/project`, the MP4 to
  // `<dir>/export.mp4`.
  dir: string;
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  // The full-size retimed footage and cut-out, on disk.
  files: { footage: string; cutout: string };
  range?: RenderRange;
  env?: NodeJS.ProcessEnv;
}

// One version to an MP4: the page from the one shared builder (exactly what
// `build` returns, never stored), a temporary HyperFrames project around it,
// and one render call. Returns the MP4's path and the project's files.
export async function renderExport({
  tool,
  tools,
  dir,
  edit,
  transcript,
  headTrack,
  files,
  range,
  env,
}: RenderExport): Promise<{ output: string; projectFiles: string[] }> {
  const { html, assets } = build(edit, transcript, headTrack, ISSEBYA_PRESET, await editMeasurer());
  const projectDir = join(dir, "project");
  const projectFiles = await writeRenderProject({ dir: projectDir, html, assets, files });
  const output = join(dir, "export.mp4");
  await tool(renderCall({ tools, projectDir, output, range, env }));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) throw new Error(`${STEP}: the render wrote no MP4`);
  return { output, projectFiles };
}

export interface RenderRun {
  ctx: StepContext;
  storage: Storage;
  rows: VersionRows;
  exports: ExportStore;
  keyPrefix: string;
  scratchDir: string;
  tools: ToolPaths;
  // The version to export; must be a version of the job's reel.
  versionId: string;
  // Makes sure every full-size input is stored; default: the fixed pipeline,
  // every step a hit unless a rebuildable output was deleted, the reel's
  // status untouched.
  ensureInputs?: () => Promise<unknown>;
  newId?: () => string;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

// A render job: the pipeline's hits (or a rebuilt output), then one measured
// `render` step that renders the version, uploads the MP4 put-if-absent to
// `${prefix}exports/<reel_id>/<export_id>.mp4` and records the `exports` row.
// A retried job whose export is already recorded is a hit.
export async function runRender({
  ctx,
  storage,
  rows,
  exports,
  keyPrefix,
  scratchDir,
  tools,
  versionId,
  ensureInputs,
  newId = randomUUID,
  spawnTool,
  env = process.env,
}: RenderRun): Promise<void> {
  const started = performance.now();
  const { job, signal } = ctx;
  if ((await exports.forJob(job.id)) !== null) {
    await recordHit(ctx, {
      name: STEP,
      summary: "export kept, reused",
      wallMs: elapsedMs(started),
    });
    return;
  }
  await (
    ensureInputs ??
    (() =>
      runPipeline({
        ctx,
        storage,
        keyPrefix,
        scratchDir,
        tools,
        spawnTool,
        setReelStatus: false,
      }))
  )();
  signal.throwIfAborted();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own scratch folder
  await mkdir(scratchDir, { recursive: true });
  const dir = await mkdtemp(join(scratchDir, "render-"));
  const output = join(dir, "export.mp4");
  // Filled inside the step, measured after it (bytes_in).
  const inputs: string[] = [];
  try {
    await runToolsStep(
      ctx,
      {
        name: STEP,
        inputs,
        outputs: [output],
        sizeOf: "out",
        async work(tool) {
          const version = await rows.get(versionId);
          if (!version || version.reel_id !== job.reel_id) {
            throw new Error(`${STEP}: version ${versionId} is not a version of this reel`);
          }
          const read = async (ref: EditInputs[keyof EditInputs]) => {
            const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
            const bytes = await storage.get(key);
            if (!bytes) throw new Error(`${STEP}: input missing: ${key}`);
            return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          };
          const transcript = transcriptSchema.parse(await read(version.inputs.transcript));
          const headTrack = headTrackSchema.parse(await read(version.inputs.head_track));
          const editBytes = await storage.get(version.r2_key);
          if (!editBytes) throw new Error(`${STEP}: edit missing: ${version.r2_key}`);
          const parsed = parseEdit(
            JSON.parse(new TextDecoder().decode(editBytes)) as unknown,
            ISSEBYA_PRESET,
            transcript,
          );
          if (!parsed.ok) {
            throw new Error(`${STEP}: stored edit refused: ${parsed.reasons.join("; ")}`);
          }

          const download = async (ref: EditInputs["footage"]) => {
            const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
            const path = join(dir, "inputs", ref.step, ref.file);
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
            await mkdir(join(dir, "inputs", ref.step), { recursive: true });
            if (!(await storage.getFile(key, path, { signal }))) {
              throw new Error(`${STEP}: input missing: ${key}`);
            }
            return path;
          };
          const files = {
            footage: await download(version.inputs.footage),
            cutout: await download(version.inputs.cutout),
          };
          const { projectFiles } = await renderExport({
            tool,
            tools,
            dir,
            edit: parsed.edit,
            transcript,
            headTrack,
            files,
            env,
          });
          inputs.push(...projectFiles);

          signal.throwIfAborted();
          const id = newId();
          const key = exportKey(keyPrefix, job.reel_id, id);
          await storage.putFileIfAbsent(key, output, { contentType: "video/mp4" });
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
          const { size } = await stat(output);
          signal.throwIfAborted();
          await exports.insert({
            id,
            reel_id: job.reel_id,
            owner_id: job.owner_id,
            job_id: job.id,
            version_id: version.id,
            r2_key: key,
            bytes: size,
          });
          return { what: "exported" };
        },
      },
      spawnTool,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
