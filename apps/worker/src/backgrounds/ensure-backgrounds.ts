import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BackgroundMap, type EditRef, backgroundMapSchema } from "@edit-issebya/edit";
import type { Storage } from "@edit-issebya/storage";
import { cacheKey, fingerprint } from "../pipeline/fingerprint.ts";
import type { ToolPaths } from "../pipeline/tools.ts";
import { type SpawnTool, type StepContext, recordHit, runToolsStep } from "../step-runner.ts";
import {
  BACKGROUNDS_VERSION,
  BACKGROUND_SETTINGS,
  backgroundArgs,
  backgroundsJson,
  mapFromRaw,
} from "./background-map.ts";

// The on-demand background map step and its one output.
export const BACKGROUNDS_STEP = "backgrounds";
const BACKGROUNDS_FILE = "backgrounds.json";

// What a map depends on: the footage (by its producer), the grid and how it
// is made. The same footage is sampled once for every later version.
export function backgroundsFingerprint(footage: EditRef): string {
  return fingerprint({
    inputs: [{ step: footage.step, fingerprint: footage.fingerprint, file: footage.file }],
    settings: BACKGROUND_SETTINGS,
    version: BACKGROUNDS_VERSION,
  });
}

// `${prefix}cache/backgrounds/<fingerprint>/backgrounds.json`.
export function backgroundsKey(prefix: string, footage: EditRef): string {
  return cacheKey(prefix, BACKGROUNDS_STEP, backgroundsFingerprint(footage), BACKGROUNDS_FILE);
}

export interface EnsureBackgrounds {
  ctx: StepContext;
  storage: Storage;
  keyPrefix: string;
  scratchDir: string;
  footage: EditRef;
  tools: ToolPaths;
  spawnTool?: SpawnTool;
  // Records that the job's reel needs a map found already stored (its size);
  // a map this step writes is recorded by the storage it is given.
  recordStored?: (key: string, bytes: number) => Promise<void>;
}

function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function parse(bytes: Uint8Array): BackgroundMap {
  return backgroundMapSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

// Makes sure the footage's background map is stored and returns it, before
// the layout engine places any text over that footage. Stored: a hit row
// (`backgrounds reused`). Else one measured `backgrounds` step downloads the
// footage, samples it with ffmpeg, and uploads the map put-if-absent, so a
// stored map is never replaced.
export async function ensureBackgrounds({
  ctx,
  storage,
  keyPrefix,
  scratchDir,
  footage,
  tools,
  spawnTool,
  recordStored,
}: EnsureBackgrounds): Promise<BackgroundMap> {
  const { signal } = ctx;
  const started = performance.now();
  const key = backgroundsKey(keyPrefix, footage);
  const stored = await storage.get(key);
  signal.throwIfAborted();
  if (stored) {
    const map = parse(stored);
    if (recordStored) await recordStored(key, stored.length);
    await recordHit(ctx, {
      name: BACKGROUNDS_STEP,
      summary: "backgrounds reused",
      wallMs: elapsedMs(started),
    });
    return map;
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the worker's own scratch folder
  await mkdir(scratchDir, { recursive: true });
  const dir = await mkdtemp(join(scratchDir, "backgrounds-"));
  const footagePath = join(dir, "footage.mp4");
  const rawPath = join(dir, "frames.rgb");
  const jsonPath = join(dir, BACKGROUNDS_FILE);
  let map: BackgroundMap | undefined;
  try {
    await runToolsStep(
      ctx,
      {
        name: BACKGROUNDS_STEP,
        inputs: [footagePath],
        outputs: [jsonPath],
        sizeOf: "out",
        async work(tool) {
          const footageKey = cacheKey(keyPrefix, footage.step, footage.fingerprint, footage.file);
          if (!(await storage.getFile(footageKey, footagePath, { signal }))) {
            throw new Error(`${BACKGROUNDS_STEP}: input missing: ${footageKey}`);
          }
          await tool({
            file: tools.ffmpeg,
            args: backgroundArgs(footagePath, rawPath, BACKGROUND_SETTINGS),
          });
          signal.throwIfAborted();
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's scratch folder
          const made = mapFromRaw(new Uint8Array(await readFile(rawPath)), BACKGROUND_SETTINGS);
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the step's scratch folder
          await writeFile(jsonPath, backgroundsJson(made));
          await storage.putFileIfAbsent(key, jsonPath, { contentType: "application/json" });
          map = made;
          return { what: `backgrounds of ${made.frames.length} frames` };
        },
      },
      spawnTool,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return map!;
}
