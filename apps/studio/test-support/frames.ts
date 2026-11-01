// For the tools spec (e2e-tools/) only: one frame of an MP4 as a PNG, and
// ffmpeg's SSIM between two images. Never imported by a CI spec.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

// The frame shown at `seconds`, scaled to width x height, written to `png`.
export async function extractFrame(
  mp4: string,
  seconds: number,
  width: number,
  height: number,
  png: string,
): Promise<void> {
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
    `scale=${width}:${height}`,
    png,
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
