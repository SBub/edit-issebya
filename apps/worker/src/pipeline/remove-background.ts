import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { HYPERFRAMES_VERSION, hyperframesEnv } from "./tools.ts";

const REMOVE_BACKGROUND_VERSION = 1;

// D4: HyperFrames' current u2net model (`u2net_human_seg`) with its default
// decode, until issue #20; no faster method here. The model is not a CLI
// option, so HyperFrames' version stands for it.
export const REMOVE_BACKGROUND_SETTINGS = {
  device: "auto",
  quality: "balanced",
  hyperframes: HYPERFRAMES_VERSION,
};

export type RemoveBackgroundSettings = typeof REMOVE_BACKGROUND_SETTINGS;

const OUTPUT = "subject.webm";
// Ends in .webm: HyperFrames infers the format from the extension.
const PARTIAL = "subject.part.webm";

// HyperFrames' arguments (after its entry file): the cut-out of the speaker,
// VP9 with alpha in WebM.
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
    const partial = join(dir, PARTIAL);
    const [node, entry] = tools.hyperframes;
    await tool({
      file: node,
      args: [entry, ...removeBackgroundArgs(files["source.mp4"]!, partial, settings)],
      env: hyperframesEnv(),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, OUTPUT));
    return { what: "background removed" };
  },
};
