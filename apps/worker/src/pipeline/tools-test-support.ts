// For the tool tests (`test:tools`) only: the real tools, run directly.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "../step-runner.ts";
import { toolPaths } from "./tools.ts";

const run = promisify(execFile);

export const REAL_TOOLS = toolPaths(process.env);

export const CLIP = new URL("../../../../fixtures/footage/short-speech.mp4", import.meta.url)
  .pathname;

// The clip with a person in it: read only, never touched.
export const PERSON_CLIP = new URL("../../../../fixtures/footage/short-person.mp4", import.meta.url)
  .pathname;

// A Tool without the step runner: stdout back, a non-zero exit thrown.
export const realTool: Tool = async (call) => {
  const { stdout } = await run(call.file, call.args, {
    cwd: call.cwd,
    env: call.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
};

export async function ffmpeg(args: string[]): Promise<void> {
  await run(REAL_TOOLS.ffmpeg, ["-hide_banner", "-v", "error", "-y", ...args]);
}

async function ffprobeJson(path: string, extra: string[] = []): Promise<unknown> {
  const { stdout } = await run(REAL_TOOLS.ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    ...extra,
    path,
  ]);
  return JSON.parse(stdout) as unknown;
}

interface VideoStream {
  codec_name: string;
  width: number;
  height: number;
  pix_fmt: string;
  r_frame_rate: string;
  avg_frame_rate: string;
  color_transfer?: string;
  // `1` on a VP9 WebM with alpha (the alpha lives in a side track); the
  // Matroska tag is upper case.
  tags?: { alpha_mode?: string; ALPHA_MODE?: string };
}

export async function videoStream(path: string): Promise<VideoStream> {
  const probe = (await ffprobeJson(path, ["-show_streams", "-select_streams", "v:0"])) as {
    streams: VideoStream[];
  };
  return probe.streams[0]!;
}

export async function keyframeTimes(path: string): Promise<number[]> {
  const probe = (await ffprobeJson(path, [
    "-select_streams",
    "v:0",
    "-skip_frame",
    "nokey",
    "-show_entries",
    "frame=pts_time",
  ])) as { frames: { pts_time: string }[] };
  return probe.frames.map((frame) => Number(frame.pts_time));
}

// One frame at `seconds`, decoded with libvpx-vp9 (alpha kept) to raw RGBA.
export async function decodeFrameRgba(path: string, seconds: number): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "frame-"));
  try {
    const out = join(dir, "frame.rgba");
    await ffmpeg([
      "-c:v",
      "libvpx-vp9",
      "-ss",
      String(seconds),
      "-i",
      path,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      out,
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside a fresh temp folder
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
