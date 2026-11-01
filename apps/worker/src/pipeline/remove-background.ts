import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { HYPERFRAMES_VERSION, hyperframesEnv } from "./tools.ts";

const REMOVE_BACKGROUND_VERSION = 1;

// The model is HyperFrames' current u2net (`u2net_human_seg`), fixed by the
// HyperFrames version, and stays until issue #20 is taken up. `auto` lets a
// CoreML and a CPU run share a fingerprint.
export const REMOVE_BACKGROUND_SETTINGS = {
  device: "auto",
  quality: "balanced",
  hyperframes: HYPERFRAMES_VERSION,
};

export type RemoveBackgroundSettings = typeof REMOVE_BACKGROUND_SETTINGS;

const OUTPUT = "subject.webm";
// HyperFrames writes here; the output exists under its final name only once
// it exited 0.
const PARTIAL = "subject.part.webm";

// HyperFrames' arguments (after its entry file): the speaker cut out of the
// footage, VP9 with alpha.
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
    const [node, entry] = tools.hyperframes;
    const partial = join(dir, PARTIAL);
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
