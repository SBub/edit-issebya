// For the tool tests (`test:tools`) only: the real tools, run directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../step-runner.ts";
import { toolPaths } from "./tools.ts";

const run = promisify(execFile);

export const REAL_TOOLS = toolPaths(process.env);

export const CLIP = new URL("../../../../fixtures/footage/short-speech.mp4", import.meta.url)
  .pathname;

// A person on a plain background, H.264 30 fps 1080x1920. Read only.
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
  r_frame_rate: string;
  avg_frame_rate: string;
  color_transfer?: string;
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

export interface VideoFormat {
  codec_name: string;
  width: number;
  height: number;
  pix_fmt: string;
  // The WebM's `ALPHA_MODE` tag, whatever its case.
  alphaMode: string | null;
  durationSeconds: number;
}

export async function videoFormat(path: string): Promise<VideoFormat> {
  const probe = (await ffprobeJson(path, [
    "-show_streams",
    "-show_format",
    "-select_streams",
    "v:0",
  ])) as {
    streams: {
      codec_name: string;
      width: number;
      height: number;
      pix_fmt: string;
      tags?: Record<string, string>;
    }[];
    format: { duration: string };
  };
  const stream = probe.streams[0]!;
  const alpha = Object.entries(stream.tags ?? {}).find(
    ([key]) => key.toLowerCase() === "alpha_mode",
  );
  return {
    codec_name: stream.codec_name,
    width: stream.width,
    height: stream.height,
    pix_fmt: stream.pix_fmt,
    alphaMode: alpha?.[1] ?? null,
    durationSeconds: Number(probe.format.duration),
  };
}

// One frame at `seconds`, decoded with libvpx-vp9 (so alpha survives) to raw RGBA.
export async function rgbaFrame(path: string, seconds: number): Promise<Uint8Array> {
  const { stdout } = await run(
    REAL_TOOLS.ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      "-ss",
      String(seconds),
      "-c:v",
      "libvpx-vp9",
      "-i",
      path,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgba",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}
