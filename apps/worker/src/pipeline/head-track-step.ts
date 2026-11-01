import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import {
  HEAD_TRACK_SETTINGS,
  type HeadSample,
  type HeadTrackSettings,
  headSample,
  headTrackWhat,
} from "./head-track.ts";

const HEAD_TRACK_VERSION = 1;

const OUTPUT = "head-track.json";
// Raw RGBA frames, about 100 MB for 50 s: written to a file, never through
// stdout (a Tool keeps only its last 64 KB), and removed once read.
const FRAMES = "frames.rgba";

// ffmpeg's arguments: the cut-out decoded with the decoder that keeps its
// alpha, sampled and scaled for analysis, as raw RGBA frames.
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
    settings.decoder,
    "-i",
    input,
    "-vf",
    `fps=${settings.samplesPerSecond},scale=${settings.analysisWidth}:${settings.analysisHeight}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    output,
  ];
}

// One sample per whole frame of the file; a trailing partial frame is ignored.
async function sampleFrames(path: string, settings: HeadTrackSettings): Promise<HeadSample[]> {
  const frame = new Uint8Array(settings.analysisWidth * settings.analysisHeight * 4);
  const samples: HeadSample[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  const file = await open(path, "r");
  try {
    for (;;) {
      let filled = 0;
      while (filled < frame.length) {
        const { bytesRead } = await file.read(frame, filled, frame.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled < frame.length) return samples;
      samples.push(headSample(frame, samples.length, settings));
    }
  } finally {
    await file.close();
  }
}

export const headTrack: PipelineStep<HeadTrackSettings> = {
  name: "head_track",
  version: HEAD_TRACK_VERSION,
  settings: HEAD_TRACK_SETTINGS,
  reelStatus: "tracking_head",
  outputs: [{ file: OUTPUT, keep: "kept" }],
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
    const samples = await sampleFrames(frames, settings);
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(samples)}\n`);
    await rm(frames, { force: true });
    return { what: headTrackWhat(samples) };
  },
};
