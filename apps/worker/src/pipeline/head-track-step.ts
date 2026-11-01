import { open, rm } from "node:fs/promises";
import { join } from "node:path";
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

const HEAD_TRACK_VERSION = 1;

const OUTPUT = "head-track.json";
// Raw frames go to a file, not stdout: the step runner caps stdout and splits
// it into lines.
const FRAMES = "frames.rgba";

// ffmpeg decodes the cut-out to raw RGBA at the analysis size, one frame per
// sample. The `libvpx-vp9` decoder before `-i` keeps the alpha channel.
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

export const headTrack: PipelineStep<HeadTrackSettings> = {
  name: "head_track",
  version: HEAD_TRACK_VERSION,
  settings: HEAD_TRACK_SETTINGS,
  reelStatus: "tracking_head",
  outputs: [{ file: OUTPUT, retention: "kept" }],
  reusedWhat: "head tracked",
  inputs: (_source, fingerprints) => [
    {
      ref: {
        step: "remove_background",
        fingerprint: fingerprints.remove_background!,
        file: "subject.webm",
      },
      as: "subject.webm",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const frames = join(dir, FRAMES);
    await tool({
      file: tools.ffmpeg,
      args: headTrackDecodeArgs(files["subject.webm"]!, frames, settings),
    });
    const samples = await trackFrames(frames, settings);
    await rm(frames, { force: true });
    if (samples.length === 0) throw new Error("head_track: the cut-out decoded to no frames");
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(samples)}\n`);
    return { what: headTrackWhat(samples) };
  },
};
