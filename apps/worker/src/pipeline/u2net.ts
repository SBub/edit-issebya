// The pure parts of the head track's person mask (u2net-entry.ts runs them):
// the model's input from an RGB frame, its output as a mask, the chunks the
// samples are split into, and the ffmpeg calls around the model. The same
// steps HyperFrames' background removal takes with this model (0.8.222,
// `u2net_human_seg`): the frame scaled to 320x320 (lanczos3), divided by its
// largest value, ImageNet mean and deviation; the output stretched from its
// smallest to its largest value over 0 to 255 and scaled back (lanczos3); the
// mask written as VP9 with alpha by the same encoder arguments. Only the
// weights differ: the int8 model (u2net-model.ts).
import type { PoolLimits } from "../cutout/pool.ts";
import type { HeadTrackSettings } from "./head-track.ts";
import { U2NET_MODEL } from "./u2net-model.ts";

// What makes the person mask besides the tracker's own settings: the model
// (by its SHA-256), its input size, the execution provider and the mask
// file's encoding. Part of the head track's fingerprint.
export const U2NET_SETTINGS = {
  model: U2NET_MODEL.file.replace(/\.onnx$/, ""),
  modelSha256: U2NET_MODEL.sha256,
  // The model's square input.
  size: 320,
  resize: "lanczos3",
  // CPU everywhere, like the cut-out.
  provider: "cpu",
  // The mask file: VP9 with alpha, HyperFrames' `balanced` quality.
  format: "vp9-alpha",
  crf: 18,
  cpuUsed: 4,
} as const;

export type U2netSettings = typeof U2NET_SETTINGS;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

// The model's input (planar RGB floats) from one frame already scaled to the
// input size (interleaved RGB bytes): each value divided by the frame's
// largest, then the ImageNet mean taken off and divided by the deviation.
export function u2netInput(resized: Uint8Array, input: Float32Array): void {
  const plane = resized.length / 3;
  if (input.length !== 3 * plane) {
    throw new Error(`a frame of ${resized.length} bytes for an input of ${input.length} values`);
  }
  let max = 0;
  for (const value of resized) if (value > max) max = value;
  if (max === 0) max = 1;
  for (let p = 0; p < plane; p += 1) {
    input[p] = (resized[3 * p]! / max - MEAN[0]) / STD[0];
    input[plane + p] = (resized[3 * p + 1]! / max - MEAN[1]) / STD[1];
    input[2 * plane + p] = (resized[3 * p + 2]! / max - MEAN[2]) / STD[2];
  }
}

// The model's first output as a mask at the input size: stretched from its
// smallest value (0) to its largest (255), rounded.
export function u2netMask(output: Float32Array, mask: Uint8Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let p = 0; p < mask.length; p += 1) {
    const value = output[p]!;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const range = hi - lo || 1;
  for (let p = 0; p < mask.length; p += 1) {
    mask[p] = Math.max(0, Math.min(255, Math.round(((output[p]! - lo) / range) * 255)));
  }
}

// The mask as the alpha of an RGBA frame; the colour bytes stay as they are
// (black: the tracker reads the alpha only).
export function alphaToRgba(alpha: Uint8Array, rgba: Uint8Array): void {
  if (rgba.length !== alpha.length * 4) {
    throw new Error(`a mask of ${alpha.length} bytes for a frame of ${rgba.length}`);
  }
  for (let p = 0; p < alpha.length; p += 1) rgba[4 * p + 3] = alpha[p]!;
}

export const MASK_POOL = {
  // The samples are split into at most this many chunks, masked at once.
  chunks: 4,
  // What one chunk's tool call is counted as holding: the entry with its
  // ffmpeg peaks at about 450 MB (app_docs/pipeline.md).
  processBytes: 512 * 1024 ** 2,
  // The share of the memory limit the chunks may hold together.
  memoryShare: 0.5,
} as const;

export interface MaskChunk {
  // The first sample of the chunk and how many it holds.
  first: number;
  frames: number;
}

// The samples in order, split into `chunks` runs of the same length (the last
// one shorter); fewer runs when there are fewer samples.
export function chunkBounds(frames: number, chunks: number): MaskChunk[] {
  const count = Math.max(1, Math.floor(chunks));
  const step = Math.ceil(frames / count);
  const bounds: MaskChunk[] = [];
  for (let first = 0; first < frames; first += step) {
    bounds.push({ first, frames: Math.min(frames, first + step) - first });
  }
  return bounds;
}

// The chunks the step masks at once and the ONNX intra-op threads of each: at
// most MASK_POOL.chunks, as many as there are CPUs and memory for (at least
// one), the CPUs shared out evenly. The track is the same whatever the split
// (every frame is masked on its own), so the split is not a setting.
export function maskPool(
  frames: number,
  limits: PoolLimits,
): { chunks: MaskChunk[]; threads: number } {
  const cpus = Math.max(1, Math.floor(limits.cpus));
  const byMemory = Math.floor(
    (limits.memoryBytes * MASK_POOL.memoryShare) / MASK_POOL.processBytes,
  );
  const chunks = chunkBounds(frames, Math.max(1, Math.min(MASK_POOL.chunks, cpus, byMemory)));
  return { chunks, threads: Math.max(1, Math.floor(cpus / Math.max(1, chunks.length))) };
}

function sampleRate(settings: HeadTrackSettings): number {
  return 1 / settings.sampleSeconds;
}

function sampleFilter(settings: HeadTrackSettings): string {
  return `fps=${sampleRate(settings)},scale=${settings.analysisWidth}:${settings.analysisHeight}`;
}

// ffprobe counts the frames of the sample clip (one per sample), by decoding.
export function sampleCountArgs(input: string): string[] {
  return [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nw=1:nk=1",
    input,
  ];
}

export function parseSampleCount(stdout: string): number {
  const count = Number(stdout.trim());
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`head_track: the sample clip has no frames: ${stdout.trim()}`);
  }
  return count;
}

// ffmpeg decodes one chunk of the sample clip to raw RGB on stdout: `frames`
// samples from sample `first` on.
export function u2netDecodeArgs(
  { input, first, frames }: MaskChunk & { input: string },
  settings: HeadTrackSettings,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-ss",
    (first * settings.sampleSeconds).toFixed(6),
    "-i",
    input,
    "-an",
    "-vf",
    sampleFilter(settings),
    "-frames:v",
    String(frames),
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-",
  ];
}

// HyperFrames' filter from RGB to tagged BT.709 video range, in parts (the
// options joined by colons).
const MASK_COLOUR_FILTER = `scale=${["out_color_matrix=bt709", "out_range=tv", "flags=neighbor"].join(":")}`;

// ffmpeg writes the chunks' raw RGBA frames, joined in order, as one VP9 file
// with alpha: the arguments HyperFrames' background removal encodes its
// `.webm` with, at the mask settings' quality.
export function maskEncodeArgs(
  inputs: readonly string[],
  output: string,
  settings: HeadTrackSettings,
  mask: U2netSettings,
): string[] {
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${settings.analysisWidth}x${settings.analysisHeight}`,
    "-r",
    String(sampleRate(settings)),
    "-i",
    `concat:${inputs.join("|")}`,
    "-vf",
    MASK_COLOUR_FILTER,
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    String(mask.crf),
    "-deadline",
    "good",
    "-row-mt",
    "1",
    "-cpu-used",
    String(mask.cpuUsed),
    "-auto-alt-ref",
    "0",
    "-pix_fmt",
    "yuva420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-metadata:s:v:0",
    "alpha_mode=1",
    "-an",
    output,
  ];
}
