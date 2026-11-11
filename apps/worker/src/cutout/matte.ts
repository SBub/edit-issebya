// The pure parts of the cut-out's MODNet matting (modnet-entry.ts runs them):
// the working size, the model's input from RGB frames, the matte as grayscale,
// the temporal smoothing and the two ffmpeg calls around the model.

// What makes a mask besides its span and its crop: the model (by its SHA-256),
// the working size, the crop rule, the smoothing, the execution provider and
// the mask's format. Every mask fingerprint names them, with MASK_TOOL_VERSION.
export const MATTE_SETTINGS = {
  // MODNet's portrait matting model quantised to int8 (modnet-model.ts).
  model: "modnet_int8_13",
  modelSha256: "a293b5ae8fb8ac81447a82bf1ad661479fb412fe2d276188711386c6c81df28b",
  // The short side 384, both sides multiples of 32 (MODNet's reference is 512:
  // 384 is 1.7 times faster and the masks stay as good to the eye).
  size: 384,
  // The rule that leaves out the rows above the speaker (CROP_RULE.id, crop.ts).
  crop: "above-head-half-width",
  // A per-pixel median of each frame and its two neighbours.
  smoothing: "median3",
  // CPU everywhere: CoreML on the Mac was slower and gave other values.
  provider: "cpu",
  format: "h264-gray",
} as const;

// The working size of a frame, by MODNet's own rule (onnx/inference_onnx.py)
// at this reference: a frame
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

// The height of the frame the head track measures in (1080x1920 pixels,
// whatever the footage's size): a crop is given in these pixels.
const HEAD_TRACK_FRAME_HEIGHT = 1920;

export interface MatteRegion {
  // The footage rows the model sees: from `top` down, `height` of them.
  top: number;
  height: number;
  // The size the region is scaled to for the model.
  matte: { width: number; height: number };
}

// The part of a frame the model runs on, and at which size. Without a crop,
// the whole frame at its working size. With `cropTop` (rows left out at the
// top, in head-track pixels) the frame keeps the scale of its working size,
// and the crop is moved up as far as needed for the region to scale to a
// whole multiple of 32 rows (and to start on an even row), so the model never
// sees less than the rule asked for; the rows above it are background. A crop
// that moves up to the frame's top is no crop.
export function matteRegion(
  width: number,
  height: number,
  cropTop = 0,
  ref: number = MATTE_SETTINGS.size,
): MatteRegion {
  const whole = { top: 0, height, matte: workingSize(width, height, ref) };
  const asked = Math.floor((cropTop * height) / HEAD_TRACK_FRAME_HEIGHT);
  if (!(asked > 0)) return whole;
  const scaled = Math.max(width, height) < ref || Math.min(width, height) > ref;
  const scale = scaled ? ref / Math.min(width, height) : 1;
  const rows = Math.ceil(((height - asked) * scale) / 32) * 32;
  const top = Math.floor((height - rows / scale) / 2) * 2;
  if (top <= 0) return whole;
  return { top, height: height - top, matte: { width: whole.matte.width, height: rows } };
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
  // The footage rows decoded (matteRegion); absent or from row 0, all of them.
  region?: { top: number; height: number };
}

// ffmpeg decoding the span to raw RGB at the working size (area scaling, as
// MODNet's reference resizes), on stdout; with a region, only its rows. The
// seek sits a quarter frame before the first frame, so that frame is kept and
// the one before is not, and exactly `frames` frames come out (fewer only
// where the footage ends).
export function decodeArgs({
  input,
  start,
  frames,
  fps,
  width,
  height,
  region,
}: DecodeCall): string[] {
  const seek = Math.max(0, onFrameGrid(start, fps) - 0.25 / fps);
  const crop = region && region.top > 0 ? [`crop=iw:${region.height}:0:${region.top}:exact=1`] : [];
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
    [...crop, `scale=${width}:${height}:flags=area`, "format=rgb24"].join(","),
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
  // The footage rows the mattes cover (matteRegion); absent or from row 0, all.
  region?: { top: number; height: number };
}

// ffmpeg reading the gray mattes on stdin and writing the mask: scaled up to
// the footage's size (bicubic), or to its region with the rows above it
// filled black (background), full-range gray to video-range luma with
// neutral chroma, H.264 High yuv420p, BT.709 tags, a keyframe every second,
// frame i at i / fps. The format the old mask tool wrote, which the builder,
// the preview and the export read.
export function encodeArgs({ output, rate, matte, footage, region }: EncodeCall): string[] {
  const fps = parseFrameRate(rate) ?? 30;
  const cropped = region && region.top > 0 ? region : null;
  const height = cropped ? cropped.height : footage.height;
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
      `scale=${footage.width}:${height}:flags=bicubic:in_range=full:out_range=limited`,
      "format=yuv420p",
      ...(cropped ? [`pad=${footage.width}:${footage.height}:0:${cropped.top}:black`] : []),
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
