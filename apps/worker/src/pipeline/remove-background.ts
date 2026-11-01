import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { HYPERFRAMES_VERSION, hyperframesEnv } from "./tools.ts";

const REMOVE_BACKGROUND_VERSION = 1;

// HyperFrames' current u2net model (u2net_human_seg), fixed by its version:
// faster methods are issue #20's, not this step's (app_docs/pipeline.md).
export const REMOVE_BACKGROUND_SETTINGS = {
  device: "auto",
  quality: "balanced",
  hyperframes: HYPERFRAMES_VERSION,
};

export type RemoveBackgroundSettings = typeof REMOVE_BACKGROUND_SETTINGS;

const OUTPUT = "subject.webm";
// HyperFrames infers the format from the extension, so the partial name ends
// in `.webm` too.
const PARTIAL = "subject.part.webm";

// HyperFrames' arguments (after its entry file): VP9 with alpha in WebM.
export function removeBackgroundArgs(
  input: string,
  output: string,
  settings: RemoveBackgroundSettings,
): string[] {
  return [
    "remove-background",
    input,
    "-o",
    output,
    "--device",
    settings.device,
    "--quality",
    settings.quality,
    "--json",
  ];
}

export interface RemoveBackgroundResult {
  framesProcessed: number;
  provider: string;
}

// The `--json` result is the last stdout line that is a JSON object.
export function parseRemoveBackgroundResult(stdout: string): RemoveBackgroundResult {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split("\n").reverse()) {
    try {
      const value = JSON.parse(line.trim()) as unknown;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        result = value as Record<string, unknown>;
        break;
      }
    } catch {
      // Not the result line.
    }
  }
  if (!result) throw new Error("remove-background printed no JSON result");
  if (result.ok !== true) {
    throw new Error(`remove-background did not succeed: ${JSON.stringify(result)}`);
  }
  if (result.format !== "webm") {
    throw new Error(`remove-background wrote ${String(result.format)}, not webm`);
  }
  if (typeof result.framesProcessed !== "number" || typeof result.provider !== "string") {
    throw new Error("remove-background result has no framesProcessed or provider");
  }
  return { framesProcessed: result.framesProcessed, provider: result.provider };
}

export const removeBackground: PipelineStep<RemoveBackgroundSettings> = {
  name: "remove_background",
  version: REMOVE_BACKGROUND_VERSION,
  settings: REMOVE_BACKGROUND_SETTINGS,
  reelStatus: "removing_background",
  outputs: [{ file: OUTPUT, keep: "rebuildable" }],
  reusedWhat: "background removed",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const [node, entry] = tools.hyperframes;
    const partial = join(dir, PARTIAL);
    const stdout = await tool({
      file: node,
      args: [entry, ...removeBackgroundArgs(files["source.mp4"]!, partial, settings)],
      env: hyperframesEnv(process.env, tools),
      // HyperFrames spawns ffmpeg and the model runtime.
      sampleGroupMemory: true,
    });
    parseRemoveBackgroundResult(stdout);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, OUTPUT));
    return { what: "background removed" };
  },
};
