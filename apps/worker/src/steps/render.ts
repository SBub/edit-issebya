import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type HeadTrack,
  ISSEBYA,
  type Transcript,
  type VersionStore,
  build,
  createMeasurer,
} from "@edit-issebya/edit";
import { type Storage, cacheKey } from "@edit-issebya/storage";
import type { ExportStore } from "../export-store.ts";
import { PIPELINE } from "../pipeline/definition.ts";
import { runPipeline } from "../pipeline/run-pipeline.ts";
import { type ToolPaths, hyperframesEnv } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, runToolsStep } from "../step-runner.ts";
import { type RenderRange, exportKey, renderArgs } from "./render-args.ts";
import { ensureRenderInputs } from "./render-inputs.ts";
import { writeRenderProject } from "./render-project.ts";
import { fontBytes, readJson } from "./version-io.ts";

const STEP = "render";
// A long reel at delivery quality takes minutes; an hour means it hung.
const RENDER_TIMEOUT_MS = 60 * 60 * 1000;

export interface RenderRun {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  // The render's files go to `<scratchDir>/render-<job id>/`, removed at the end.
  scratchDir: string;
  tools: ToolPaths;
  versions: Pick<VersionStore, "get">;
  exportsStore: ExportStore;
  // The job's version_id: the version this render exports.
  versionId: string | null;
  // The render call only (E2E_MOCK_RENDER); a rebuild runs the real tools.
  spawnTool?: SpawnTool;
  // Tests pass a fixed id.
  newId?: () => string;
  // Only the tools test renders a span; a job never carries one.
  range?: RenderRange;
  // Rebuilds the version's media inputs; the fixed steps up to the cut-out
  // by default, never moving the reel's status.
  rebuild?: () => Promise<{ fingerprints: Record<string, string> }>;
}

const REBUILD_PIPELINE = PIPELINE.slice(
  0,
  PIPELINE.findIndex((step) => step.name === "remove_background") + 1,
);

// A render job's one step: the pinned version's page, built by the same
// builder the preview uses and never edited, rendered by HyperFrames at
// delivery quality, stored at `<prefix>exports/<reel>/<export>.mp4` and
// recorded in exports (which lives 24 hours). Never moves reels.status or
// current_version_id; after a lost lease nothing is uploaded or recorded.
export async function render({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  tools,
  versions,
  exportsStore,
  versionId,
  spawnTool,
  newId = randomUUID,
  range,
  rebuild,
}: RenderRun): Promise<void> {
  const { job, signal } = ctx;
  if (!versionId) throw new Error(`${STEP}: job has no version`);
  const version = await versions.get(versionId);
  if (!version) throw new Error(`${STEP}: version not found`);
  if (version.reel_id !== job.reel_id) throw new Error(`${STEP}: version belongs to another reel`);
  const { inputs } = version;

  // Before the step row, so a rebuild writes its own pipeline rows first.
  const keys = await ensureRenderInputs({
    storage,
    keyPrefix,
    inputs,
    signal,
    rebuild:
      rebuild ??
      (() =>
        runPipeline({
          ctx,
          storage,
          keyPrefix,
          scratchDir,
          tools,
          pipeline: REBUILD_PIPELINE,
          moveReelStatus: false,
        })),
  });

  const workDir = join(scratchDir, `render-${job.id}`);
  const mediaDir = join(workDir, "media");
  const projectDir = join(workDir, "project");
  const footagePath = join(mediaDir, "footage.mp4");
  const cutoutPath = join(mediaDir, "subject.webm");
  const output = join(workDir, "export.mp4");

  await rm(workDir, { recursive: true, force: true });
  try {
    await runToolsStep(
      ctx,
      {
        name: STEP,
        inputs: [footagePath, cutoutPath],
        outputs: [output],
        sizeOf: "out",
        async work(tool) {
          const edit = await readJson<unknown>(storage, version.r2_key, STEP);
          const transcript = await readJson<Transcript>(
            storage,
            cacheKey(keyPrefix, "retime", inputs.transcript, "transcript.json"),
            STEP,
          );
          const headTrack = await readJson<HeadTrack>(
            storage,
            cacheKey(keyPrefix, "head_track", inputs.headTrack, "head-track.json"),
            STEP,
          );
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
          await mkdir(mediaDir, { recursive: true });
          for (const [key, path] of [
            [keys.footage, footagePath],
            [keys.cutout, cutoutPath],
          ] as const) {
            if (!(await storage.getFile(key, path, { signal }))) {
              throw new Error(`${STEP}: input missing: ${key}`);
            }
          }

          const measurer = createMeasurer(await fontBytes(ISSEBYA));
          let page;
          try {
            page = build({ edit, transcript, headTrack, preset: ISSEBYA, measurer });
          } finally {
            measurer.close();
          }
          await writeRenderProject({ dir: projectDir, build: page, footagePath, cutoutPath });

          await tool({
            file: tools.hyperframes[0],
            args: renderArgs({ cli: tools.hyperframes[1], project: projectDir, output, range }),
            env: hyperframesEnv(process.env, tools),
            sampleGroupMemory: true,
            timeoutMs: RENDER_TIMEOUT_MS,
          });
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
          const written = await stat(output).catch(() => null);
          if (!written || written.size === 0)
            throw new Error(`${STEP}: HyperFrames wrote no video`);

          const exportId = newId();
          const key = exportKey(keyPrefix, job.reel_id, exportId);
          signal.throwIfAborted();
          await storage.putFileIfAbsent(key, output, { contentType: "video/mp4" });
          signal.throwIfAborted();
          await exportsStore.insert({
            id: exportId,
            reel_id: job.reel_id,
            owner_id: job.owner_id,
            job_id: job.id,
            version_id: version.id,
            r2_key: key,
            bytes: written.size,
          });
          return { what: "exported" };
        },
      },
      spawnTool,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
