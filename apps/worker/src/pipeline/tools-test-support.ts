// For the tool tests (`test:tools`) only: the real tools, run directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../step-runner.ts";
import { toolPaths } from "./tools.ts";

const run = promisify(execFile);

// stdout as bytes, for raw frames.
function runBuffer(file: string, args: string[]): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    );
  });
}

export const REAL_TOOLS = toolPaths(process.env);

export const CLIP = new URL("../../../../fixtures/footage/short-speech.mp4", import.meta.url)
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

// The person clip, for the cut-out tool tests only. Read only: never written.
export const PERSON_CLIP = new URL("../../../../fixtures/footage/short-person.mp4", import.meta.url)
  .pathname;

interface StreamInfo {
  codec_name: string;
  width: number;
  height: number;
  pix_fmt: string;
  tags?: Record<string, string>;
}

export async function streamInfo(path: string): Promise<StreamInfo> {
  const probe = (await ffprobeJson(path, ["-show_streams", "-select_streams", "v:0"])) as {
    streams: StreamInfo[];
  };
  return probe.streams[0]!;
}

export async function formatDuration(path: string): Promise<number> {
  const probe = (await ffprobeJson(path, ["-show_entries", "format=duration"])) as {
    format: { duration: string };
  };
  return Number(probe.format.duration);
}

// One frame at `seconds`, as raw RGBA at w x h; WebM is decoded with libvpx-vp9
// so the alpha survives.
export async function decodeFrameRgba(
  path: string,
  seconds: number,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const decoder = path.endsWith(".webm") ? ["-c:v", "libvpx-vp9"] : [];
  const { stdout } = await runBuffer(REAL_TOOLS.ffmpeg, [
    "-hide_banner",
    "-v",
    "error",
    "-ss",
    String(seconds),
    ...decoder,
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    `scale=${w}:${h}`,
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    "-",
  ]);
  return new Uint8Array(stdout);
}
