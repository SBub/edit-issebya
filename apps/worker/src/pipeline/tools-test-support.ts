// For the tool tests (`test:tools`) only: the real tools, run directly.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Tool } from "../step-runner.ts";
import { removeBackground } from "./remove-background.ts";
import { toolPaths } from "./tools.ts";

const run = promisify(execFile);

export const REAL_TOOLS = toolPaths(process.env);

export const CLIP = new URL("../../../../fixtures/footage/short-speech.mp4", import.meta.url)
  .pathname;

// Four seconds of a person speaking, H.264 30 fps 1080x1920 like a retimed
// source.mp4: read in place, never written beside, never changed.
export const PERSON_CLIP = new URL("../../../../fixtures/footage/short-person.mp4", import.meta.url)
  .pathname;

// WebM is decoded with libvpx-vp9: ffmpeg's native VP9 decoder drops alpha.
function decoder(path: string): string[] {
  return path.endsWith(".webm") ? ["-c:v", "libvpx-vp9"] : [];
}

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
  tags?: Record<string, string>;
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

// Frames actually decoded, so a WebM (which carries no frame count) is counted
// too. ffprobe's own VP9 decoder drops alpha, which a count does not need.
export async function frameCount(path: string): Promise<number> {
  const probe = (await ffprobeJson(path, [
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
  ])) as { streams: { nb_read_frames: string }[] };
  return Number(probe.streams[0]!.nb_read_frames);
}

// The first video stream's tags, keys lower-cased (Matroska writes ALPHA_MODE).
export async function streamTags(path: string): Promise<Record<string, string>> {
  const { tags = {} } = await videoStream(path);
  return Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
}

// One decoded frame's alpha plane at `width` x `height`, one byte per pixel.
export async function rawAlphaFrame(
  path: string,
  seconds: number,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const { stdout } = await run(
    REAL_TOOLS.ffmpeg,
    [
      "-hide_banner",
      "-v",
      "error",
      ...decoder(path),
      "-ss",
      String(seconds),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      `alphaextract,scale=${width}:${height}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return new Uint8Array(stdout);
}

// Runs remove_background on PERSON_CLIP into `dir` (about a minute): the
// cut-out the head-track and preview tool tests read.
export async function personCutOut(dir: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await mkdir(dir, { recursive: true });
  await removeBackground.run({
    tool: realTool,
    tools: REAL_TOOLS,
    dir,
    files: { "source.mp4": PERSON_CLIP },
    settings: removeBackground.settings,
    signal: new AbortController().signal,
  });
  return join(dir, "subject.webm");
}
