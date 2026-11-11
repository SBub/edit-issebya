import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PoolLimits, machineLimits, runPool } from "../cutout/pool.ts";
import { parsePersonMaskProgress, weightedProgress } from "../progress-parsers.ts";
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
import type { ToolPaths } from "./tools.ts";
import { u2netModelPath } from "./u2net-model.ts";
import {
  type MaskChunk,
  U2NET_SETTINGS,
  type U2netSettings,
  maskEncodeArgs,
  maskPool,
  parseSampleCount,
  sampleCountArgs,
} from "./u2net.ts";

// 2: the step makes its own sampled person mask from the retimed footage
// (there is no stored cut-out any more), with HyperFrames' background removal
// (the fp32 `u2net_human_seg`). 3: the worker's own U2Net entry masks the
// samples with the int8 model, in chunks run at once. Tracks stored under 2
// stay with the reels that name them.
const HEAD_TRACK_VERSION = 3;

// The tracker's settings and the person mask's (the model's SHA-256 among
// them), so another model re-runs the step.
export const HEAD_TRACK_STEP_SETTINGS = { ...HEAD_TRACK_SETTINGS, mask: U2NET_SETTINGS };

export type HeadTrackStepSettings = HeadTrackSettings & { mask: U2netSettings };

// The worker's own U2Net entry, run by this Node.
export const U2NET_ENTRY = fileURLToPath(new URL("./u2net-entry.ts", import.meta.url));

const OUTPUT = "head-track.json";
// Scratch files, deleted in the step and never uploaded. Raw frames go to a
// file, not stdout: the step runner caps stdout and splits it into lines.
const SAMPLES = "samples.mp4";
// One chunk's raw RGBA masks (`mask-0.rgba`, ...), joined into the mask file.
const chunkFile = (index: number) => `mask-${index}.rgba`;
// ffmpeg infers the format from the extension, so the mask's name ends in
// `.webm`.
const MASK = "mask.part.webm";
const FRAMES = "frames.rgba";

// ffmpeg keeps only the frames the tracker analyses (one per sample, at the
// analysis size), losslessly (yuv444p), so the person mask runs on about 4
// small frames per second of footage instead of every full-size frame.
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

// The entry's arguments, exactly: the chunk of the sample clip, its threads,
// the model and the ffmpeg it decodes with.
export function u2netArgs(
  {
    input,
    first,
    frames,
    output,
    threads,
  }: MaskChunk & {
    input: string;
    output: string;
    threads: number;
  },
  model: string,
  tools: Pick<ToolPaths, "ffmpeg">,
): string[] {
  return [
    U2NET_ENTRY,
    "--input",
    input,
    "--first",
    String(first),
    "--frames",
    String(frames),
    "--output",
    output,
    "--threads",
    String(threads),
    "--model",
    model,
    "--ffmpeg",
    tools.ffmpeg,
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

export interface HeadTrackOptions {
  // The CPUs and memory the chunks share (the machine's, or the container's;
  // unit tests pass their own).
  limits?: () => PoolLimits;
  model?: string;
  node?: string;
}

// The step: ffmpeg samples the footage, ffprobe counts the samples, the U2Net
// entry masks them in chunks run at once (maskPool; each chunk's per-frame
// progress weighted by its samples), ffmpeg joins the chunks' masks into one
// VP9 file with alpha and decodes it back, and the tracker reads each frame.
export function headTrackStep({
  limits = machineLimits,
  model = u2netModelPath(),
  node = process.execPath,
}: HeadTrackOptions = {}): PipelineStep<HeadTrackStepSettings> {
  return {
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
    async run({ tool, tools, dir, files, settings, signal }) {
      const sampled = join(dir, SAMPLES);
      const mask = join(dir, MASK);
      const frames = join(dir, FRAMES);
      const scratch = [sampled, mask, frames];
      let samples: (HeadSample | null)[];
      try {
        await tool({
          file: tools.ffmpeg,
          args: headTrackSampleArgs(files["source.mp4"]!, sampled, settings),
        });
        const count = parseSampleCount(
          await tool({ file: tools.ffprobe, args: sampleCountArgs(sampled) }),
        );
        const pool = maskPool(count, limits());
        const parts = pool.chunks.map((_, index) => join(dir, chunkFile(index)));
        // A killed entry leaves its `.part`.
        scratch.push(...parts, ...parts.map((part) => `${part}.part`));
        const progress = weightedProgress(
          parsePersonMaskProgress,
          pool.chunks.map((chunk) => chunk.frames),
        );
        await runPool(pool.chunks, pool.chunks.length, async (chunk, index) => {
          await tool({
            file: node,
            args: u2netArgs(
              { ...chunk, input: sampled, output: parts[index]!, threads: pool.threads },
              model,
              tools,
            ),
            // The call's memory is the entry's and its ffmpeg's together.
            sampleGroupMemory: true,
            progress: progress[index]!,
          });
          signal.throwIfAborted();
        });
        await tool({
          file: tools.ffmpeg,
          args: maskEncodeArgs(parts, mask, settings, settings.mask),
        });
        for (const part of parts) await rm(part, { force: true });
        await tool({ file: tools.ffmpeg, args: headTrackDecodeArgs(mask, frames, settings) });
        samples = await trackFrames(frames, settings);
      } finally {
        for (const path of scratch) await rm(path, { force: true });
      }
      if (samples.length === 0) throw new Error("head_track: the person mask decoded to no frames");
      await writeAtomic(join(dir, OUTPUT), `${JSON.stringify(samples)}\n`);
      return { what: headTrackWhat(samples) };
    },
  };
}

export const headTrack = headTrackStep();
