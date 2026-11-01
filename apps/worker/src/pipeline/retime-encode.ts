import type { RetimePlan } from "./retime-plan.ts";
import type { RetimeSettings } from "./retime-preset.ts";

// A number for the filter graph: up to six decimals, no trailing zeros.
function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

// Pitch kept above 1x (atempo); below 1x a plain rate change on room tone.
function tempo(speed: number, sampleRate: number): string {
  return speed >= 1
    ? `atempo=${num(speed)}`
    : `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate}`;
}

// The filter graph applying a plan to the converted footage (constant
// `frameRate`, so every boundary is a whole frame and a whole number of audio
// samples). Each audio piece is padded and trimmed to its video piece's
// length, so concat never drifts and no measuring pass is needed.
export function retimeFilterGraph(
  plan: RetimePlan,
  sampleRate: number,
  settings: RetimeSettings,
): string {
  const fps = settings.frameRate;
  const samplesPerFrame = sampleRate / fps;
  const parts: string[] = [];
  const labels: string[] = [];
  plan.segments.forEach((segment, index) => {
    const first = Math.round(segment.orig[0] * fps);
    const end = Math.round(segment.orig[1] * fps);
    const samples = Math.round(((end - first) * samplesPerFrame) / segment.speed);
    const last = index === plan.segments.length - 1;
    const fade = last
      ? `,afade=t=out:st=${num(Math.max(0, samples / sampleRate - settings.endFadeSeconds))}:d=${num(settings.endFadeSeconds)}`
      : "";
    parts.push(
      `[0:v]trim=start_frame=${first}:end_frame=${end},setpts=(PTS-STARTPTS)/${num(segment.speed)}[v${index}]`,
    );
    parts.push(
      `[0:a]atrim=start_sample=${Math.round(first * samplesPerFrame)}:end_sample=${Math.round(end * samplesPerFrame)},` +
        `asetpts=PTS-STARTPTS,${tempo(segment.speed, sampleRate)},apad,atrim=end_sample=${samples}${fade}[a${index}]`,
    );
    labels.push(`[v${index}][a${index}]`);
  });
  parts.push(`${labels.join("")}concat=n=${plan.segments.length}:v=1:a=1[vc][a]`);
  parts.push(`[vc]fps=${fps}[v]`);
  return parts.join(";\n");
}

// The encode, with the graph read from a file (a long plan exceeds argument
// limits; `-/filter_complex` is ffmpeg 7+ syntax).
export function retimeEncodeArgs(
  input: string,
  graphFile: string,
  output: string,
  settings: RetimeSettings,
): string[] {
  const gop = String(settings.frameRate);
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-/filter_complex",
    graphFile,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    settings.videoCodec,
    "-preset",
    settings.preset,
    "-crf",
    String(settings.crf),
    "-g",
    gop,
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    settings.audioBitrate,
    "-movflags",
    "+faststart",
    output,
  ];
}
