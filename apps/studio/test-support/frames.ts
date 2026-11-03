// For the tools spec (e2e-tools/) only: one frame of an MP4 as a PNG, and
// ffmpeg's SSIM between two images. Never imported by a CI spec.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

// A rectangle in the export's own pixels.
export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

// swscale flags for the export frame's yuv420p to RGB scale.
const SCALE_FLAGS = ["bicubic", "full_chroma_int", "accurate_rnd"].join("+");

// The frame shown at `seconds`, cropped to `crop` (when given) and scaled to
// width x height, written to `png`.
// `full_chroma_int` and `accurate_rnd`: the default yuv420p to RGB scale
// interpolates chroma coarsely and leaves a one-pixel ripple at every colour
// edge that the export itself does not have (measured on a 4:2:0 round trip of
// a preview capture: 0.988837 with the defaults, 0.994112 with these).
export async function extractFrame(
  mp4: string,
  seconds: number,
  width: number,
  height: number,
  png: string,
  crop?: Crop,
): Promise<void> {
  const cropFilter = crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1,` : "";
  await run(ffmpegPath(), [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-ss",
    String(seconds),
    "-i",
    mp4,
    "-frames:v",
    "1",
    "-vf",
    `${cropFilter}scale=${width}:${height}:flags=${SCALE_FLAGS}`,
    png,
  ]);
}

// The image at `source` scaled to width x height with the same swscale flags
// as `extractFrame`, written to `png`: a preview captured at a higher device
// scale goes through the same downscale as the export frame it is compared to.
export async function scaledImage(
  source: string,
  width: number,
  height: number,
  png: string,
): Promise<void> {
  await run(ffmpegPath(), [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-frames:v",
    "1",
    "-vf",
    `scale=${width}:${height}:flags=${SCALE_FLAGS}`,
    png,
  ]);
}

// `jpg` made from the image at `source` (same size), softened (Gaussian blur)
// and desaturated: the large colour areas stay, but no edge is a one-pixel step
// between saturated colours, which a 4:2:0 export cannot keep.
export async function softenedPhoto(source: string, jpg: string): Promise<void> {
  await run(ffmpegPath(), [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    source,
    "-frames:v",
    "1",
    "-vf",
    "gblur=sigma=8,eq=saturation=0.6",
    "-q:v",
    "2",
    "-pix_fmt",
    "yuvj420p",
    jpg,
  ]);
}

// SSIM over all planes (`All:` in ffmpeg's summary), 1 for identical images.
export async function ssim(a: string, b: string): Promise<number> {
  const { stderr } = await run(ffmpegPath(), [
    "-hide_banner",
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "ssim",
    "-f",
    "null",
    "-",
  ]);
  const match = /All:([\d.]+)/.exec(stderr);
  if (!match) throw new Error(`no SSIM between ${a} and ${b}:\n${stderr}`);
  return Number(match[1]);
}

// A PNG's width and height, from its IHDR chunk.
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
