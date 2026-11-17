import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  photoPath,
  reelFrames,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { type CutoutDeps, ensureVersionCutouts } from "../cutout/version-cutouts.ts";
import { editMeasurer } from "../edit-measurer.ts";
import { isJobCancelled } from "../lease.ts";
import type { PhotoLibrary } from "../photos/photo-store.ts";
import { cacheKey } from "../pipeline/fingerprint.ts";
import { probeArgs } from "../pipeline/probe.ts";
import { runPipeline } from "../pipeline/run-pipeline.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import {
  type ProgressParser,
  ffmpegFrameProgress,
  parseRenderProgress,
  weightedParts,
} from "../progress-parsers.ts";
import { reelOf } from "../queue.ts";
import {
  type SpawnTool,
  type StepContext,
  type Tool,
  recordHit,
  runToolsStep,
} from "../step-runner.ts";
import { inSpan } from "../telemetry.ts";
import {
  compositeArgs,
  cutoutSpans,
  footageJpegArgs,
  maskListText,
  parseMediaFacts,
  soundCutArgs,
} from "./composite.ts";
import { exportKey } from "./export-key.ts";
import type { ExportStore } from "./export-store.ts";
import {
  type RenderLayer,
  type RenderRange,
  ffmpegPassCall,
  layerCall,
  renderCall,
  renderDoubled,
  renderScratchEnv,
  runLanes,
  withChromeTmp,
} from "./render-call.ts";
import { type RenderFiles, writeRenderProject } from "./render-project.ts";
import {
  type MediaFacts,
  type RenderMode,
  type RenderRoute,
  type RenderSettings,
  renderRoute,
  renderSettings,
} from "./render-route.ts";

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

// One version to an MP4 by the single call: the full page from the one shared
// builder (exactly what `build` returns, never stored), a temporary HyperFrames
// project around it, and one render call that screenshots every frame, the
// footage included. Returns the MP4's path and the project's files.
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
  // Chrome's short temporary folder exists only for the call (removed on
  // success, failure and cancel alike).
  await stage(
    "render.encode",
    { "render.duration_seconds": edit.duration },
    async (_span, context) => {
      await withChromeTmp((chromeTmp) =>
        tool({
          ...renderCall({ tools, dir, chromeTmp, projectDir, output, range, env }),
          parent: context,
        }),
      );
    },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) throw new Error(`${STEP}: the render wrote no MP4`);
  return { output, projectFiles };
}

// How much of the step's progress each part of the composite is, about its
// share of the wall time (the layers run next to each other, the composite
// after them). A part that does not run counts nothing.
const PROGRESS_WEIGHTS = { front: 30, sound: 4, behind: 4, footage: 4, composite: 58 } as const;

interface RenderComposite {
  tool: Tool;
  tools: ToolPaths;
  // The render's own folder: each layer page has a folder of its own in it
  // (`front`, `sound`, `behind`: its project, caches and history), and the
  // sound, the footage's JPEG copy, the mask list and `export.mp4` beside them.
  dir: string;
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  files: RenderFiles;
  mode: RenderMode;
  // The probed footage, and the probed mask of each cut-out span in order.
  footage: MediaFacts;
  masks: readonly MediaFacts[];
  env?: NodeJS.ProcessEnv;
  stage?: RenderStage;
}

// One version to an MP4 by the composite (app_docs/export.md): the builder's
// three layer pages (never stored), a temporary HyperFrames project around
// each, the pages rendered in two lanes at the same time (the front layer;
// next to it the sound page, its cut, then the behind layer) with, in `match`
// mode, the footage's JPEG pass as a third lane, and then one ffmpeg pass that
// blends and encodes. A lane that fails stops the others. Returns the MP4's
// path and every file the render read.
async function renderComposite({
  tool,
  tools,
  dir,
  edit,
  transcript,
  headTrack,
  files,
  mode,
  footage,
  masks,
  env = process.env,
  stage = UNSPANNED,
}: RenderComposite): Promise<{ output: string; projectFiles: string[] }> {
  const spans = cutoutSpans(edit, transcript);
  const maskFiles = spans.map((span) => {
    const file = files.masks?.[span.path];
    if (!file) throw new Error(`${STEP}: no file for mask ${span.path}`);
    return file;
  });
  const hasCutout = spans.length > 0;
  const match = mode === "match";
  const doubled = renderDoubled(env);
  const frames = reelFrames(edit.duration);
  const layers: RenderLayer[] = hasCutout ? ["front", "sound", "behind"] : ["front", "sound"];
  const projectFiles = await stage("render.build", {}, async (span) => {
    const measurer = await editMeasurer(edit.font_pair);
    const written: string[] = [...maskFiles];
    let pageBytes = 0;
    let assetCount = 0;
    for (const layer of layers) {
      const { html, assets } = build(edit, transcript, headTrack, ISSEBYA_PRESET, measurer, {
        layer,
      });
      written.push(
        ...(await writeRenderProject({ dir: join(dir, layer, "project"), html, assets, files })),
      );
      pageBytes += Buffer.byteLength(html);
      assetCount += assets.length;
      for (const folder of Object.values(renderScratchEnv(join(dir, layer)))) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
        await mkdir(folder, { recursive: true });
      }
    }
    span.setAttributes({
      "render.page_bytes": pageBytes,
      "render.assets": assetCount,
      "render.pages": layers.length,
    });
    return written;
  });

  const output = join(dir, "export.mp4");
  const framesDir = (layer: RenderLayer) => join(dir, layer, "frames");
  const soundPage = join(dir, "sound", "sound.mp4");
  const sound = join(dir, "sound.m4a");
  const footageJpeg = join(dir, "footage.mkv");
  const maskList = join(dir, "masks.txt");
  const [frontProgress, soundProgress, behindProgress, footageProgress, compositeProgress] =
    weightedParts(
      [
        parseRenderProgress,
        parseRenderProgress,
        parseRenderProgress,
        ffmpegFrameProgress(footage.frames),
        ffmpegFrameProgress(frames),
      ],
      [
        PROGRESS_WEIGHTS.front,
        PROGRESS_WEIGHTS.sound,
        hasCutout ? PROGRESS_WEIGHTS.behind : 0,
        match ? PROGRESS_WEIGHTS.footage : 0,
        PROGRESS_WEIGHTS.composite,
      ],
    ).map(
      // A report of nothing done yet is not written: the step's first write is
      // at once and the next one a throttle window later, so a 0 from the
      // first process to speak would sit on screen that long.
      (parse): ProgressParser =>
        (line) =>
          parse(line) || null,
    ) as [ProgressParser, ProgressParser, ProgressParser, ProgressParser, ProgressParser];
  // Every call is the encode's child: its exec span is under it.
  await stage(
    "render.encode",
    { "render.duration_seconds": edit.duration, "render.path": "composite", "render.mode": mode },
    async (_span, context) => {
      // One layer page: Chrome's short temporary folder is its own and exists
      // only for the call (removed on success, failure and cancel alike).
      const page = (
        layer: RenderLayer,
        pageOutput: string,
        progress: ProgressParser,
        signal: AbortSignal,
      ) =>
        withChromeTmp((chromeTmp) =>
          tool({
            ...layerCall({
              tools,
              layer,
              dir: join(dir, layer),
              chromeTmp,
              projectDir: join(dir, layer, "project"),
              output: pageOutput,
              progress,
              signal,
              env,
            }),
            parent: context,
          }),
        );
      await runLanes([
        async (signal) => {
          await page("front", framesDir("front"), frontProgress, signal);
        },
        // The sound page and the behind layer are short: one after the other
        // next to the front layer, so at most three browsers are open at once.
        async (signal) => {
          await page("sound", soundPage, soundProgress, signal);
          if (!doubled) {
            await tool({
              file: tools.ffmpeg,
              args: soundCutArgs({ input: soundPage, output: sound, frames }),
              env: { ...env },
              signal,
              parent: context,
            });
          }
          if (hasCutout) await page("behind", framesDir("behind"), behindProgress, signal);
        },
        ...(match
          ? [
              async (signal: AbortSignal) => {
                await tool({
                  ...ffmpegPassCall({
                    tools,
                    args: footageJpegArgs({ footage: files.footage, output: footageJpeg }),
                    output: footageJpeg,
                    frames: footage.frames,
                    part: "footage",
                    progress: footageProgress,
                    signal,
                    env,
                  }),
                  parent: context,
                });
              },
            ]
          : []),
      ]);
      if (hasCutout) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
        await writeFile(maskList, maskListText(maskFiles));
      }
      await tool({
        ...ffmpegPassCall({
          tools,
          args: compositeArgs({
            mode,
            duration: edit.duration,
            frames,
            width: ISSEBYA_PRESET.frame.width,
            height: ISSEBYA_PRESET.frame.height,
            footage: match ? footageJpeg : files.footage,
            footageFacts: footage,
            spans: spans.map((span, index) => ({ ...span, facts: masks[index]! })),
            ...(hasCutout ? { maskList, behindFrames: framesDir("behind") } : {}),
            frontFrames: framesDir("front"),
            sound,
            output,
          }),
          output,
          frames,
          part: "composite",
          progress: compositeProgress,
          env,
        }),
        parent: context,
      });
    },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
  const info = await stat(output).catch(() => null);
  if (!info || info.size === 0) throw new Error(`${STEP}: the render wrote no MP4`);
  return { output, projectFiles };
}

export interface RenderVersion {
  tool: Tool;
  tools: ToolPaths;
  dir: string;
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  files: RenderFiles;
  // Default: WORKER_RENDER_PATH and WORKER_RENDER_MODE of `env`.
  settings?: RenderSettings;
  // Told the route as soon as it is decided, before anything is rendered.
  onRoute?: (route: RenderRoute) => void;
  env?: NodeJS.ProcessEnv;
  stage?: RenderStage;
}

// One version to an MP4, by the route `renderRoute` gives it: the composite
// when it handles the version, else the single call. The route is its own
// span, `render.route`, with the probes (ffprobe on the footage and each mask)
// beneath it; under the render double nothing is probed and only the edit's
// own rules are judged.
export async function renderVersion({
  tool,
  tools,
  dir,
  edit,
  transcript,
  headTrack,
  files,
  settings,
  onRoute,
  env = process.env,
  stage = UNSPANNED,
}: RenderVersion): Promise<{ output: string; projectFiles: string[]; route: RenderRoute }> {
  const chosen = settings ?? renderSettings(env);
  const decided = await stage("render.route", {}, async (span, context) => {
    let route = renderRoute({ settings: chosen, edit, transcript });
    let footage: MediaFacts | null = null;
    const masks: MediaFacts[] = [];
    if (route.path === "composite") {
      const spans = cutoutSpans(edit, transcript);
      if (renderDoubled(env)) {
        // Nothing to probe: files of the export's own shape.
        footage = {
          ...ISSEBYA_PRESET.frame,
          rate: "30/1",
          avgRate: "30/1",
          frames: reelFrames(edit.duration),
          range: "tv",
          pixFmt: "yuv420p",
          hasAudio: true,
        };
        masks.push(...spans.map(() => footage!));
      } else {
        const probe = async (path: string) =>
          parseMediaFacts(
            await tool({ file: tools.ffprobe, args: probeArgs(path), parent: context }),
          );
        footage = await probe(files.footage);
        for (const cut of spans) {
          const file = files.masks?.[cut.path];
          if (!file) throw new Error(`${STEP}: no file for mask ${cut.path}`);
          masks.push(await probe(file));
        }
        route = renderRoute({ settings: chosen, edit, transcript, footage, masks });
      }
    }
    span.setAttributes(routeAttributes(route));
    return { route, footage, masks };
  });
  const { route } = decided;
  onRoute?.(route);
  const rendered =
    route.path === "composite"
      ? await renderComposite({
          tool,
          tools,
          dir,
          edit,
          transcript,
          headTrack,
          files,
          mode: route.mode,
          footage: decided.footage!,
          masks: decided.masks,
          env,
          stage,
        })
      : await renderExport({ tool, tools, dir, edit, transcript, headTrack, files, env, stage });
  return { ...rendered, route };
}

// Which way a render went, as span attributes: `render.path` (`composite` or
// `single`), with `render.mode` (`match` or `clean`) for the composite and
// `render.route_reason` for the single call.
function routeAttributes(route: RenderRoute): Attributes {
  return route.path === "composite"
    ? { "render.path": route.path, "render.mode": route.mode }
    : { "render.path": route.path, "render.route_reason": route.reason };
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
  // The owner's ready library photos: where a VISUAL's photo's large copy is.
  photos?: PhotoLibrary;
  // Removes an export file uploaded but never recorded (the job was cancelled
  // or the row was not written): its `stored_files` row is marked deleted and
  // the object deleted. Never touches a recorded export.
  discardExport?: (key: string) => Promise<void>;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

// A render job: the pipeline's hits (or a rebuilt output), then one measured
// `render` step that renders the version (`renderVersion`), uploads the MP4 put-if-absent to
// `${prefix}exports/<reel_id>/<export_id>.mp4` and records the `exports` row.
// A retried job whose export is already recorded is a hit. A cancel (the
// owner closed the export) aborts the signal: the running render's process
// group is killed and nothing more is written; a file uploaded but not
// recorded is discarded.
//
// The step's span has six stages as children, in order: `render.load` (the
// version row, its edit and inputs), `render.route` (which way it is rendered,
// the probes beneath), `render.build` (the HyperFrames pages and projects),
// `render.encode` (every HyperFrames and ffmpeg call of the render, their exec
// spans beneath), `render.upload` (the MP4 to storage) and `render.save` (the
// export row). The step's span says which way it went (`render.path`,
// `render.mode`). A cancel ends the stage it stopped and the step clean, with
// `job.cancelled` true; nothing is an error.
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
  photos,
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
                // uses it, so it is never downloaded. Masks and photos are.
                const files: Required<RenderFiles> = {
                  footage: await download(version.inputs.footage),
                  masks: {},
                  photos: {},
                };
                for (const mask of parsed.edit.inputs.masks ?? []) {
                  files.masks[maskPath(mask)] = await download(mask, `${mask.fingerprint}.mp4`);
                }
                // Each library photo's large copy, its key from its own row
                // (the owner's, ready); one deleted from the library fails the
                // export with a clear message.
                const photoIds = parsed.edit.inputs.photos ?? [];
                if (photoIds.length > 0) {
                  const library = photos
                    ? await photos.readyPhotos(job.owner_id, photoIds)
                    : new Map();
                  for (const photoId of photoIds) {
                    const photo = library.get(photoId);
                    const gone = `${STEP}: photo ${photoId} is no longer in the library`;
                    if (!photo) throw new Error(gone);
                    const path = join(dir, "inputs", "photos", `${photoId}.jpg`);
                    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the render's scratch folder
                    await mkdir(join(dir, "inputs", "photos"), { recursive: true });
                    if (!(await storage.getFile(photo.large_key, path, { signal }))) {
                      throw new Error(gone);
                    }
                    files.photos[photoPath(photoId)] = path;
                  }
                }
                span.setAttributes({
                  "render.version_number": version.number,
                  "render.inputs": 1 + (parsed.edit.inputs.masks?.length ?? 0) + photoIds.length,
                });
                return { version, transcript, headTrack, edit: parsed.edit, files };
              },
            );
            const { version, transcript, headTrack, edit, files } = loaded;
            step?.setAttribute("render.duration_seconds", edit.duration);

            const { projectFiles } = await renderVersion({
              tool,
              tools,
              dir,
              edit,
              transcript,
              headTrack,
              files,
              // On the step's span at once, so a failed or cancelled render
              // says which way it was going.
              onRoute: (route) => step?.setAttributes(routeAttributes(route)),
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
