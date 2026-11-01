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

// The frame numbered `index` (from 0), as a PNG; selected by index so no seek
// rounding picks a neighbour.
export async function extractFrame(video: string, index: number, out: string): Promise<void> {
  await ffmpeg([
    "-y",
    "-i",
    video,
    "-vf",
    `select=eq(n\\,${index})`,
    "-fps_mode",
    "passthrough",
    "-frames:v",
    "1",
    out,
  ]);
}

// The video's frame rate, from ffmpeg's description of its stream.
export async function frameRate(video: string): Promise<number> {
  const log = await ffmpeg(["-i", video, "-f", "null", "-"]).catch(
    (error: { stderr?: string }) => error.stderr ?? "",
  );
  const match = /([0-9.]+) fps/.exec(log);
  if (!match) throw new Error(`frameRate: none in ffmpeg's output:\n${log}`);
  return Number(match[1]);
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

// A rectangle in pixels of the image it is cut from.
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The `region` of the image, as a PNG of the region's size.
export async function crop(image: string, region: Region, out: string): Promise<void> {
  const { x, y, width, height } = region;
  await ffmpeg(["-y", "-i", image, "-vf", `crop=${width}:${height}:${x}:${y}`, out]);
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
    // A mono file is measured as played on both speakers, as a stereo copy of
    // the same sound is: without it the stereo export of the mono source
    // reads 3 LU louder (10 log10 2) with the same samples on each channel.
    "ebur128=dualmono=true",
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
// silence in that difference is an onset (seconds). Each is brought to its
// first channel at 48 kHz (a mono downmix of the export's two identical
// channels would be 3 dB hotter than the source) and the source is inverted
// before the mix: `amix` takes no negative weight, so `weights='1 -1'` added
// the voice instead of removing it.
const SAME_FORMAT = "pan=mono|c0=c0,aresample=48000,aformat=sample_fmts=fltp";

// The AAC export does not cancel the source exactly: its residue of the voice
// reached about -32 dB at 1.83 s, so -35 dB reported it as a click. The click
// (`mouse-click-trimmed.wav` at the preset's -13 dB) peaks at -12.1 dB in the
// difference, and -22 dB sits 10 dB from each. The click's detected onset moves
// by less than 0.1 ms between -35 and -20 dB (0.207896 s against 0.207979 s
// after 0.2 s of silence), so `ONSET_S` measures the same thing.
const ONSET_NOISE_DB = -22;

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
    [
      `[0:a]${SAME_FORMAT}[export]`,
      `[1:a]${SAME_FORMAT},volume=-1[inverted]`,
      `[export][inverted]amix=inputs=2:normalize=0,silencedetect=noise=${ONSET_NOISE_DB}dB:d=0.01`,
    ].join(";"),
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
