import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { parsePersonMaskProgress } from "../progress-parsers.ts";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import {
  HEAD_TRACK_SETTINGS,
  type HeadSample,
  type HeadTrackSettings,
  frameBytes,
  headSample,
  headTrackWhat,
  withinBounds,
} from "./head-track.ts";
import {
  PERSON_MASK_ENTRY,
  PERSON_MASK_SETTINGS,
  type PersonMaskSettings,
  parsePersonMaskResult,
  personMaskArgs,
} from "./person-mask.ts";
import { hyperframesEnv } from "./tools.ts";

// 2: the step makes its own sampled person mask from the retimed footage
// (there is no stored cut-out any more).
const HEAD_TRACK_VERSION = 2;

// The tracker's settings and the person mask's (the HyperFrames version among
// them), so a HyperFrames upgrade re-runs the step.
export const HEAD_TRACK_STEP_SETTINGS = { ...HEAD_TRACK_SETTINGS, mask: PERSON_MASK_SETTINGS };

export type HeadTrackStepSettings = HeadTrackSettings & { mask: PersonMaskSettings };

const OUTPUT = "head-track.json";
// Scratch files, deleted in the step and never uploaded. Raw frames go to a
// file, not stdout: the step runner caps stdout and splits it into lines.
const SAMPLES = "samples.mp4";
// HyperFrames infers the format from the extension, so the mask's name ends
// in `.webm`.
const MASK = "mask.part.webm";
const FRAMES = "frames.rgba";

// ffmpeg keeps only the frames the tracker analyses (one per sample, at the
// analysis size), losslessly, so the person mask runs on about 4 small frames
// per second of footage instead of every full-size frame.
export function headTrackSampleArgs(
  input: string,
  output: string,
  settings: HeadTrackSettings,
): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-an",
    "-vf",
    `fps=${1 / settings.sampleSeconds},scale=${settings.analysisWidth}:${settings.analysisHeight}`,
    "-c:v",
    "libx264",
    "-crf",
    "0",
    "-pix_fmt",
    "yuv444p",
    output,
  ];
}

// ffmpeg decodes the person mask to raw RGBA at the analysis size, one frame
// per sample. The `libvpx-vp9` decoder before `-i` keeps the alpha channel.
export function headTrackDecodeArgs(
  input: string,
  output: string,
  settings: HeadTrackSettings,
): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-c:v",
    "libvpx-vp9",
    "-i",
    input,
    "-an",
    "-vf",
    `fps=${1 / settings.sampleSeconds},scale=${settings.analysisWidth}:${settings.analysisHeight}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    output,
  ];
}

// Reads the raw file one frame at a time, so memory stays at one frame.
async function trackFrames(
  path: string,
  settings: HeadTrackSettings,
): Promise<(HeadSample | null)[]> {
  const size = frameBytes(settings);
  const buffer = new Uint8Array(size);
  const samples: (HeadSample | null)[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  const file = await open(path, "r");
  try {
    for (;;) {
      let filled = 0;
      while (filled < size) {
        const { bytesRead } = await file.read(buffer, filled, size - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) break;
      if (filled < size) {
        throw new Error(`head_track: a partial frame of ${filled} bytes at the end`);
      }
      const t = samples.length * settings.sampleSeconds;
      samples.push(withinBounds(headSample(buffer, t, settings), settings.bounds));
    }
  } finally {
    await file.close();
  }
  return samples;
}

export const headTrack: PipelineStep<HeadTrackStepSettings> = {
  name: "head_track",
  version: HEAD_TRACK_VERSION,
  settings: HEAD_TRACK_STEP_SETTINGS,
  reelStatus: "tracking_head",
  outputs: [{ file: OUTPUT, retention: "kept" }],
  reusedWhat: "head tracked",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const sampled = join(dir, SAMPLES);
    const mask = join(dir, MASK);
    const frames = join(dir, FRAMES);
    let samples: (HeadSample | null)[];
    try {
      await tool({
        file: tools.ffmpeg,
        args: headTrackSampleArgs(files["source.mp4"]!, sampled, settings),
      });
      const [node] = tools.hyperframes;
      const stdout = await tool({
        file: node,
        args: [PERSON_MASK_ENTRY, ...personMaskArgs(sampled, mask, settings.mask)],
        env: hyperframesEnv(),
        progress: parsePersonMaskProgress,
      });
      parsePersonMaskResult(stdout);
      await tool({ file: tools.ffmpeg, args: headTrackDecodeArgs(mask, frames, settings) });
      samples = await trackFrames(frames, settings);
    } finally {
      for (const path of [sampled, mask, frames]) await rm(path, { force: true });
    }
    if (samples.length === 0) throw new Error("head_track: the person mask decoded to no frames");
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(samples)}\n`);
    return { what: headTrackWhat(samples) };
  },
};
