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
} from "./head-sample.ts";

const HEAD_TRACK_VERSION = 1;

const OUTPUT = "head-track.json";
const FRAMES = "frames.rgba";

// The cut-out decoded to raw RGBA at the analysis size and rate. The
// `libvpx-vp9` decoder comes before `-i`: ffmpeg's native VP9 decoder drops
// the alpha.
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
    "-vf",
    `fps=${settings.samplesPerSecond},scale=${settings.analysisWidth}:${settings.analysisHeight}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    output,
  ];
}

// Reads the raw frames one at a time (a 50 second reel is about 100 MB of
// them: never read whole).
async function trackFile(path: string, settings: HeadTrackSettings) {
  const size = frameBytes(settings);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  const handle = await open(path);
  try {
    const { size: total } = await handle.stat();
    if (total % size !== 0) {
      throw new Error(`head_track: ${total} bytes of frames is not a whole number of frames`);
    }
    const track: (HeadSample | null)[] = [];
    const frame = new Uint8Array(size);
    for (let index = 0; index < total / size; index += 1) {
      const { bytesRead } = await handle.read(frame, 0, size, index * size);
      if (bytesRead !== size) throw new Error("head_track: short read of a frame");
      track.push(headSample(frame, index, settings));
    }
    return track;
  } finally {
    await handle.close();
  }
}

// `[{ t, head_top, cx, head_w } | null, ...]` in 1080x1920 pixels, one entry
// per 0.25 s. A track without any head (no person in frame) is not a failure.
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
    await tool({
      file: tools.ffmpeg,
      args: headTrackDecodeArgs(files["subject.webm"]!, FRAMES, settings),
      cwd: dir,
    });
    const frames = join(dir, FRAMES);
    const track = await trackFile(frames, settings);
    await rm(frames, { force: true });
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(track)}\n`);
    const missing = track.filter((sample) => sample === null).length;
    return { what: `head tracked, ${track.length} samples, ${missing} without a head` };
  },
};
