// The pure parts of the cut-out's MODNet matting (modnet-entry.ts runs them):
// the working size, the model's input from RGB frames, the matte as grayscale,
// the temporal smoothing and the two ffmpeg calls around the model.

// What makes a mask besides its span: the model (by its SHA-256), the working
// size, the smoothing, the execution provider and the mask's format. Every
// mask fingerprint names them, with MASK_TOOL_VERSION.
export const MATTE_SETTINGS = {
  model: "modnet_photographic_portrait_matting",
  modelSha256: "07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9",
  // MODNet's reference size: the short side 512, both sides multiples of 32.
  size: 512,
  // A per-pixel median of each frame and its two neighbours.
  smoothing: "median3",
  // CPU everywhere: CoreML on the Mac was slower and gave other values.
  provider: "cpu",
  format: "h264-gray",
} as const;

// MODNet's own working size for a frame (onnx/inference_onnx.py): a frame
// whose sides are not both above or both below the reference keeps its size,
// any other is scaled so its short side is the reference; then each side is
// rounded down to a multiple of 32.
export function workingSize(
  width: number,
  height: number,
  ref: number = MATTE_SETTINGS.size,
): { width: number; height: number } {
  let w = width;
  let h = height;
  if (Math.max(width, height) < ref || Math.min(width, height) > ref) {
    if (width >= height) {
      h = ref;
      w = Math.trunc((width / height) * ref);
    } else {
      w = ref;
      h = Math.trunc((height / width) * ref);
    }
  }
  return { width: w - (w % 32), height: h - (h % 32) };
}

// One packed RGB frame (rgb24) as the model's input: planar NCHW, each value
// mapped from 0 to 255 onto -1 to 1.
export function modelInput(
  rgb: Uint8Array,
  width: number,
  height: number,
  out: Float32Array = new Float32Array(3 * width * height),
): Float32Array {
  const plane = width * height;
  for (let i = 0; i < plane; i++) {
    out[i] = (rgb[3 * i]! - 127.5) / 127.5;
    out[plane + i] = (rgb[3 * i + 1]! - 127.5) / 127.5;
    out[2 * plane + i] = (rgb[3 * i + 2]! - 127.5) / 127.5;
  }
  return out;
}

// The model's matte (0 to 1, person 1) as 8-bit gray, clamped and rounded.
export function matteToGray(matte: Float32Array): Uint8Array {
  const gray = new Uint8Array(matte.length);
  for (let i = 0; i < matte.length; i++) {
    gray[i] = Math.round(Math.min(1, Math.max(0, matte[i]!)) * 255);
  }
  return gray;
}

// The per-pixel median of three frames.
function median3(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    const z = c[i]!;
    out[i] = Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
  }
  return out;
}

// The temporal smoothing, streamed: frame i becomes the per-pixel median of
// frames i - 1, i and i + 1, the first and last frames standing in for their
// missing neighbour (so they come out as they went in). One frame of delay,
// two frames held: `push` gives the previous frame's smoothed matte once the
// next one is known, `flush` the last.
export class TemporalMedian {
  private previous: Uint8Array | null = null;
  private current: Uint8Array | null = null;

  push(next: Uint8Array): Uint8Array | null {
    const current = this.current;
    if (current === null) {
      this.current = next;
      return null;
    }
    const out = median3(this.previous ?? current, current, next);
    this.previous = current;
    this.current = next;
    return out;
  }

  flush(): Uint8Array | null {
    const last = this.current;
    this.current = null;
    this.previous = null;
    return last;
  }
}

// The frames of a span at `fps`: the same count the old mask tool wrote, at
// least one.
export function spanFrames(start: number, end: number, fps: number): number {
  return Math.max(1, Math.round((end - start) * fps));
}

// A span edge given to the millisecond lands on the frame it names: within a
// quarter frame of a frame time it is that frame time exactly.
export function onFrameGrid(seconds: number, fps: number): number {
  const frames = seconds * fps;
  const nearest = Math.round(frames);
  return Math.abs(frames - nearest) < 0.25 ? nearest / fps : seconds;
}

function secondsArg(n: number): string {
  return n.toFixed(6);
}

export interface DecodeCall {
  input: string;
  start: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
}

// ffmpeg decoding the span to raw RGB at the working size (area scaling, as
// MODNet's reference resizes), on stdout. The seek sits a quarter frame
// before the first frame, so that frame is kept and the one before is not,
// and exactly `frames` frames come out (fewer only where the footage ends).
export function decodeArgs({ input, start, frames, fps, width, height }: DecodeCall): string[] {
  const seek = Math.max(0, onFrameGrid(start, fps) - 0.25 / fps);
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-ss",
    secondsArg(seek),
    "-i",
    input,
    "-an",
    "-sn",
    "-frames:v",
    String(frames),
    "-fps_mode",
    "passthrough",
    "-vf",
    `scale=${width}:${height}:flags=area,format=rgb24`,
    "-f",
    "rawvideo",
    "pipe:1",
  ];
}

// The mask's colour tags: what the old mask tool wrote and the preview and
// the export decode by.
const BT709_VIDEO_RANGE = [
  "setparams=range=tv",
  "color_primaries=bt709",
  "color_trc=bt709",
  "colorspace=bt709",
].join(":");

export interface EncodeCall {
  output: string;
  // The footage's frame rate as ffprobe gives it (`30/1`).
  rate: string;
  // The matte's size (the working size) and the footage's.
  matte: { width: number; height: number };
  footage: { width: number; height: number };
}

// ffmpeg reading the gray mattes on stdin and writing the mask: scaled up to
// the footage's size (bicubic), full-range gray to video-range luma with
// neutral chroma, H.264 High yuv420p, BT.709 tags, a keyframe every second,
// frame i at i / fps. The format the old mask tool wrote, which the builder,
// the preview and the export read.
export function encodeArgs({ output, rate, matte, footage }: EncodeCall): string[] {
  const fps = parseFrameRate(rate) ?? 30;
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-s",
    `${matte.width}x${matte.height}`,
    "-framerate",
    rate,
    "-i",
    "pipe:0",
    "-vf",
    [
      `scale=${footage.width}:${footage.height}:flags=bicubic:in_range=full:out_range=limited`,
      "format=yuv420p",
      BT709_VIDEO_RANGE,
    ].join(","),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "12",
    "-profile:v",
    "high",
    "-g",
    String(Math.max(1, Math.round(fps))),
    "-f",
    "mp4",
    output,
  ];
}

// `30/1`, `30000/1001` or a plain number as frames per second; null when it
// is not a positive rate.
export function parseFrameRate(rate: string): number | null {
  const [num, den = "1"] = rate.trim().split("/");
  const value = Number(num) / Number(den);
  return Number.isFinite(value) && value > 0 ? value : null;
}
