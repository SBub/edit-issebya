import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import {
  HEAD_TRACK_SETTINGS,
  type HeadTrackSettings,
  headTrackWhat,
  headTrack as trackFrames,
} from "./head-track.ts";
import { parseProbe, probeArgs } from "./probe.ts";

const HEAD_TRACK_VERSION = 1;

const OUTPUT = "head-track.json";
// A scratch file, not an output: about 100 MB for a 50-second reel, so never
// read through the tool's stdout and never whole.
const FRAMES = "frames.rgba";

// ffmpeg decodes the cut-out to raw RGBA at the analysis size and sample rate.
// The libvpx-vp9 decoder comes before -i: the native one drops alpha.
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
    `fps=${settings.sampleFps},scale=${settings.analysisWidth}:${settings.analysisHeight}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    output,
  ];
}

// One frame at a time from the raw file; a trailing partial frame throws.
async function* rawFrames(path: string, frameBytes: number): AsyncGenerator<Uint8Array> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
  const file = await open(path, "r");
  try {
    for (;;) {
      const buffer = new Uint8Array(frameBytes);
      let filled = 0;
      while (filled < frameBytes) {
        const { bytesRead } = await file.read(buffer, filled, frameBytes - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) return;
      if (filled < frameBytes) {
        throw new Error(`head_track: the decode ends in a partial frame (${filled} bytes)`);
      }
      yield buffer;
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
    const subject = files["subject.webm"]!;
    const probe = parseProbe(await tool({ file: tools.ffprobe, args: probeArgs(subject) }));
    const frames = join(dir, FRAMES);
    await tool({ file: tools.ffmpeg, args: headTrackDecodeArgs(subject, frames, settings) });
    const track = await trackFrames(
      rawFrames(frames, settings.analysisWidth * settings.analysisHeight * 4),
      {
        ...settings,
        scaleX: probe.video.width / settings.analysisWidth,
        scaleY: probe.video.height / settings.analysisHeight,
      },
    );
    if (track.length === 0) throw new Error("head_track: the cut-out decoded to no frames");
    await rm(frames, { force: true });
    await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(track)}\n`);
    return { what: headTrackWhat(track) };
  },
};
