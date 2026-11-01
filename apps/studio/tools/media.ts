import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// The worker's ffmpeg when configured by path, else the one on PATH. Called
// with an argument list, never through a shell.
const FFMPEG = process.env.FFMPEG_PATH?.trim() || "ffmpeg";

async function ffmpeg(args: string[]): Promise<string> {
  const { stderr } = await run(FFMPEG, ["-hide_banner", "-nostats", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stderr;
}

// The frame shown at `seconds`, as a PNG.
export async function extractFrame(video: string, seconds: number, out: string): Promise<void> {
  await ffmpeg(["-y", "-i", video, "-ss", String(seconds), "-frames:v", "1", out]);
}

// The image scaled to exactly `width` x `height`.
export async function scaleTo(
  image: string,
  width: number,
  height: number,
  out: string,
): Promise<void> {
  await ffmpeg(["-y", "-i", image, "-vf", `scale=${width}:${height}:flags=area`, out]);
}

// The structural similarity of two images of the same size (1 is identical).
export async function ssim(a: string, b: string): Promise<number> {
  const log = await ffmpeg(["-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
  const match = /All:([0-9.]+)/.exec(log);
  if (!match) throw new Error(`ssim: no score in ffmpeg's output:\n${log}`);
  return Number(match[1]);
}

// A window of seconds, [from, to].
export interface Span {
  from: number;
  to: number;
}

// Integrated loudness (LUFS) of the first `seconds` of the file's sound, with
// each muted window silenced first.
export async function integratedLoudness(
  file: string,
  { seconds, mute = [] }: { seconds: number; mute?: Span[] },
): Promise<number> {
  const filters = [
    ...mute.map(({ from, to }) => `volume=enable='between(t,${from},${to})':volume=0`),
    "ebur128",
  ];
  const log = await ffmpeg([
    "-t",
    String(seconds),
    "-i",
    file,
    "-vn",
    "-af",
    filters.join(","),
    "-f",
    "null",
    "-",
  ]);
  const values = [...log.matchAll(/I:\s+(-?[0-9.]+|-inf) LUFS/g)].map((m) => m[1]!);
  const last = values.at(-1);
  if (last === undefined) throw new Error(`ebur128: no integrated loudness:\n${log}`);
  return last === "-inf" ? Number.NEGATIVE_INFINITY : Number(last);
}

// Where sound starts in the export beyond the source's own: the source is
// subtracted from the export, so only the clicks remain, and each end of
// silence in that difference is an onset (seconds).
export async function onsets(exported: string, source: string, seconds: number): Promise<number[]> {
  const log = await ffmpeg([
    "-t",
    String(seconds),
    "-i",
    exported,
    "-t",
    String(seconds),
    "-i",
    source,
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:weights='1 -1':normalize=0,silencedetect=noise=-35dB:d=0.01",
    "-f",
    "null",
    "-",
  ]);
  return [...log.matchAll(/silence_end: ([0-9.]+)/g)].map((m) => Number(m[1]));
}

// The file's duration in seconds.
export async function duration(file: string): Promise<number> {
  const log = await ffmpeg(["-i", file, "-f", "null", "-"]).catch(
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  const match = /Duration: (\d+):(\d+):([0-9.]+)/.exec(log);
  if (!match) throw new Error(`duration: none in ffmpeg's output:\n${log}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
