import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Context,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  type Attributes,
  type Span,
  trace,
} from "@opentelemetry/api";
import {
  type Edit,
  type EditInputs,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Transcript,
  type VersionRows,
  build,
  headTrackSchema,
  maskPath,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { type CutoutDeps, ensureVersionCutouts } from "../cutout/version-cutouts.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { isJobCancelled } from "../lease.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { runPipeline } from "../pipeline/run-pipeline.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { reelOf } from "../queue.ts";
import {
  type SpawnTool,
  type StepContext,
  type Tool,
  recordHit,
  runToolsStep,
} from "../step-runner.ts";
import { inSpan } from "../telemetry.ts";
import { exportKey } from "./export-key.ts";
import type { ExportStore } from "./export-store.ts";
import { type RenderRange, renderCall, renderScratchEnv } from "./render-call.ts";
import { type RenderFiles, writeRenderProject } from "./render-project.ts";

export const STEP = "render";

// A stage of the render in its own span under the step (see inSpan): the
// span's name and attributes, and the work with its span and Context.
export type RenderStage = <T>(
  name: string,
  attributes: Attributes,
  work: (span: Span, context: Context) => Promise<T>,
) => Promise<T>;

// Without telemetry: the work runs, its span is not recording.
const UNSPANNED: RenderStage = (_name, _attributes, work) =>
  work(trace.wrapSpanContext(INVALID_SPAN_CONTEXT), ROOT_CONTEXT);

export interface RenderExport {
  tool: Tool;
  tools: ToolPaths;
  // The render's own folder: the project goes to `<dir>/project`, the MP4 to
  // `<dir>/export.mp4`, HyperFrames' caches, history and temporary files to
  // the folders renderScratchEnv names.
  dir: string;
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  // The full-size retimed footage and the masks, on disk.
  files: RenderFiles;
  range?: RenderRange;
  env?: NodeJS.ProcessEnv;
  // The build and the encode are its spans (`render.build`, `render.encode`).
  stage?: RenderStage;
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
  stage = UNSPANNED,
}: RenderExport): Promise<{ output: string; projectFiles: string[] }> {
  const projectDir = join(dir, "project");
  const projectFiles = await stage("render.build", {}, async (span) => {
    const { html, assets } = build(
      edit,
      transcript,
      headTrack,
      ISSEBYA_PRESET,
      await editMeasurer(edit.font_pair),
    );
    const written = await writeRenderProject({ dir: projectDir, html, assets, files });
    span.setAttributes({
      "render.page_bytes": Buffer.byteLength(html),
      "render.assets": assets.length,
    });
    return written;
  });
  const output = join(dir, "export.mp4");
  for (const folder of Object.values(renderScratchEnv(dir))) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
    await mkdir(folder, { recursive: true });
  }
  // The HyperFrames call is the encode's child: its exec span is under it.
  await stage(
    "render.encode",
    { "render.duration_seconds": edit.duration },
    async (_span, context) => {
      await tool({
        ...renderCall({ tools, dir, projectDir, output, range, env }),
        parent: context,
      });
    },
  );
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
  // Passed to the default pipeline: records the stored outputs it reuses.
  recordStored?: (key: string, bytes: number) => Promise<void>;
  newId?: () => string;
  spawnTool?: SpawnTool;
  env?: NodeJS.ProcessEnv;
  // Given, the version's masks are made sure of after the pipeline (a slimmed
  // one is rebuilt in a `cutout` step).
  cutouts?: CutoutDeps;
  // Removes an export file uploaded but never recorded (the job was cancelled
  // or the row was not written): its `stored_files` row is marked deleted and
  // the object deleted. Never touches a recorded export.
  discardExport?: (key: string) => Promise<void>;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

// A render job: the pipeline's hits (or a rebuilt output), then one measured
// `render` step that renders the version, uploads the MP4 put-if-absent to
// `${prefix}exports/<reel_id>/<export_id>.mp4` and records the `exports` row.
// A retried job whose export is already recorded is a hit. A cancel (the
// owner closed the export) aborts the signal: the running render's process
// group is killed and nothing more is written; a file uploaded but not
// recorded is discarded.
//
// The step's span has five stages as children, in order: `render.load` (the
// version row, its edit and inputs), `render.build` (the HyperFrames page and
// project), `render.encode` (the HyperFrames render, its exec span beneath),
// `render.upload` (the MP4 to storage) and `render.save` (the export row). A
// cancel ends the stage it stopped and the step clean, with `job.cancelled`
// true; nothing is an error.
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
  recordStored,
  newId = randomUUID,
  spawnTool,
  env = process.env,
  cutouts,
  discardExport,
}: RenderRun): Promise<void> {
  const started = performance.now();
  const { job, signal } = ctx;
  const checkCancelled = async () => {
    await ctx.checkCancelled?.();
  };
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
        recordStored,
      }))
  )();
  signal.throwIfAborted();
  if (cutouts) {
    const version = await rows.get(versionId);
    if (version && version.reel_id === reelOf(job)) {
      await ensureVersionCutouts(ctx, cutouts, version);
    }
    signal.throwIfAborted();
  }
  // A cancel seen now stops the job before the render step starts.
  await checkCancelled();
  signal.throwIfAborted();

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own scratch folder
  await mkdir(scratchDir, { recursive: true });
  const dir = await mkdtemp(join(scratchDir, "render-"));
  const output = join(dir, "export.mp4");
  // Filled inside the step, measured after it (bytes_in).
  const inputs: string[] = [];
  const cancelled = () => isJobCancelled(signal);
  try {
    await runToolsStep(
      ctx,
      {
        name: STEP,
        inputs,
        outputs: [output],
        sizeOf: "out",
        async work(tool, stepContext) {
          const step = trace.getSpan(stepContext);
          const stage: RenderStage = (name, attributes, work) =>
            inSpan(ctx.telemetry, stepContext, name, attributes, work, { cancelled });
          step?.setAttributes({ "render.version_id": versionId, "job.cancelled": false });
          try {
            const loaded = await stage(
              "render.load",
              { "render.version_id": versionId },
              async (span) => {
                const version = await rows.get(versionId);
                if (!version || version.reel_id !== reelOf(job)) {
                  throw new Error(`${STEP}: version ${versionId} is not a version of this reel`);
                }
                const read = async (ref: EditInputs["footage"]) => {
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

                const download = async (ref: EditInputs["footage"], name = ref.file) => {
                  const key = cacheKey(keyPrefix, ref.step, ref.fingerprint, ref.file);
                  const path = join(dir, "inputs", ref.step, name);
                  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
                  await mkdir(join(dir, "inputs", ref.step), { recursive: true });
                  if (!(await storage.getFile(key, path, { signal }))) {
                    throw new Error(`${STEP}: input missing: ${key}`);
                  }
                  return path;
                };
                // An old version may name the whole-clip cut-out: the page never
                // uses it, so it is never downloaded. Masks are.
                const files: Required<RenderFiles> = {
                  footage: await download(version.inputs.footage),
                  masks: {},
                };
                for (const mask of parsed.edit.inputs.masks ?? []) {
                  files.masks[maskPath(mask)] = await download(mask, `${mask.fingerprint}.mp4`);
                }
                span.setAttributes({
                  "render.version_number": version.number,
                  "render.inputs": 1 + (parsed.edit.inputs.masks?.length ?? 0),
                });
                return { version, transcript, headTrack, edit: parsed.edit, files };
              },
            );
            const { version, transcript, headTrack, edit, files } = loaded;
            step?.setAttribute("render.duration_seconds", edit.duration);

            const { projectFiles } = await renderExport({
              tool,
              tools,
              dir,
              edit,
              transcript,
              headTrack,
              files,
              env,
              stage,
            });
            inputs.push(...projectFiles);

            // A cancel seen now stops before anything is uploaded.
            await checkCancelled();
            signal.throwIfAborted();
            const id = newId();
            const key = exportKey(keyPrefix, reelOf(job), id);
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
            const { size } = await stat(output);
            await stage("render.upload", { "render.mp4_bytes": size, "render.key": key }, () =>
              storage.putFileIfAbsent(key, output, { contentType: "video/mp4" }),
            );
            step?.setAttribute("render.mp4_bytes", size);
            try {
              signal.throwIfAborted();
              // Refused by the database once the job is cancelled.
              await stage("render.save", { "render.export_id": id }, () =>
                exports.insert({
                  id,
                  reel_id: reelOf(job),
                  owner_id: job.owner_id,
                  job_id: job.id,
                  version_id: version.id,
                  r2_key: key,
                  bytes: size,
                }),
              );
            } catch (error) {
              // Uploaded but not recorded: the file is removed, so a cancelled
              // or failed render leaves no export behind. A cancel turns the
              // refusal into the abort, so the step writes nothing more.
              await discardExport?.(key);
              await checkCancelled();
              throw error;
            }
            return { what: "exported" };
          } catch (error) {
            if (cancelled()) step?.setAttribute("job.cancelled", true);
            throw error;
          }
        },
      },
      spawnTool,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
