import { rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRemoveBackgroundProgress } from "../progress-parsers.ts";
import type { PipelineStep } from "./definition.ts";
import { HYPERFRAMES_VERSION, hyperframesEnv } from "./tools.ts";

const REMOVE_BACKGROUND_VERSION = 1;

// The model is not a flag: HyperFrames' default (`u2net_human_seg` in
// 0.8.222) is pinned by the HyperFrames version, which is why that version is
// a setting. Per D4 the model stays as it is in the MVP; faster methods are
// issue #20, not here.
export const REMOVE_BACKGROUND_SETTINGS = {
  device: "auto",
  quality: "balanced",
  hyperframes: HYPERFRAMES_VERSION,
};

export type RemoveBackgroundSettings = typeof REMOVE_BACKGROUND_SETTINGS;

const OUTPUT = "subject.webm";
// HyperFrames infers the format from the extension, so the encode's own name
// ends in `.webm` too; renamed once it exited 0.
const PARTIAL = "subject.part.webm";

// The worker's own entry around HyperFrames' `removeBackground` (it prints
// the frame progress the pinned CLI keeps to itself unattended), run by the
// same Node as HyperFrames' CLI.
export const REMOVE_BACKGROUND_ENTRY = fileURLToPath(
  new URL("./remove-background-entry.ts", import.meta.url),
);

// The entry's arguments: the CLI's `remove-background` options, the same
// values, without the command name and `--json` (the entry always ends with
// the JSON result).
export function removeBackgroundArgs(
  input: string,
  output: string,
  settings: RemoveBackgroundSettings,
): string[] {
  return [input, "-o", output, "--device", settings.device, "--quality", settings.quality];
}

// The last non-empty stdout line is the JSON result (the CLI's `--json`
// document, printed by the entry).
export function parseRemoveBackgroundResult(stdout: string): {
  framesProcessed: number;
  provider: string;
} {
  const line = stdout
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .at(-1);
  let result: unknown;
  try {
    result = JSON.parse(line ?? "");
  } catch {
    throw new Error(`remove_background: no JSON result in HyperFrames' output: ${line ?? ""}`);
  }
  const { ok, framesProcessed, provider } = (result ?? {}) as {
    ok?: unknown;
    framesProcessed?: unknown;
    provider?: unknown;
  };
  if (ok !== true || typeof framesProcessed !== "number" || !(framesProcessed > 0)) {
    throw new Error(`remove_background: HyperFrames did not succeed: ${line}`);
  }
  return { framesProcessed, provider: typeof provider === "string" ? provider : "unknown" };
}

// The full-size cut-out of the speaker: VP9 with alpha.
export const removeBackground: PipelineStep<RemoveBackgroundSettings> = {
  name: "remove_background",
  version: REMOVE_BACKGROUND_VERSION,
  settings: REMOVE_BACKGROUND_SETTINGS,
  reelStatus: "removing_background",
  outputs: [{ file: OUTPUT, retention: "rebuildable" }],
  reusedWhat: "background removed",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const [node] = tools.hyperframes;
    const partial = join(dir, PARTIAL);
    const stdout = await tool({
      file: node,
      args: [
        REMOVE_BACKGROUND_ENTRY,
        ...removeBackgroundArgs(files["source.mp4"]!, partial, settings),
      ],
      env: hyperframesEnv(),
      progress: parseRemoveBackgroundProgress,
    });
    parseRemoveBackgroundResult(stdout);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, OUTPUT));
    return { what: "background removed" };
  },
};
