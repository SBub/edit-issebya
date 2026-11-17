import type { RetimePlan } from "./retime-plan.ts";
import type { RetimeSettings } from "./retime-preset.ts";

// A number for the filter graph: up to six decimals, no trailing zeros.
function num(value: number): string {
  return String(Number(value.toFixed(6)));
}

// Pitch kept above 1x (atempo); below 1x a plain rate change, which drops the
// pitch: the planner slows only quiet frames (room tone), never a voice.
function tempo(speed: number, sampleRate: number): string {
  return speed >= 1
    ? `atempo=${num(speed)}`
    : `asetrate=${Math.round(sampleRate * speed)},aresample=${sampleRate}`;
}

// The filter graph applying a plan to the converted footage (constant
// `frameRate`, so every boundary is a whole frame and a whole number of audio
// samples). Each audio piece is padded and trimmed to its video piece's
// length, so concat never drifts and no measuring pass is needed.
//
// The joins: a pause is a gap of the transcript whatever its loudness, so a
// join often falls inside a breath or room sound, and two pieces set end to
// end there click. Every piece but the first fades in over joinFadeSeconds,
// and every piece but the last fades out over it (the last one carries the
// longer end fade). A fade only scales samples that are already in the piece
// (`afade` by sample position, after the trim): no piece changes length, so
// the sound's total length and its place against the picture stay exactly as
// planned, and the video pieces are not touched at all. A piece shorter than
// two fades gets half its length for each.
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
    const join = Math.min(
      Math.round(settings.joinFadeSeconds * sampleRate),
      Math.floor(samples / 2),
    );
    const fadeIn = index > 0 && join > 0 ? `,afade=t=in:ss=0:ns=${join}` : "";
    const fadeOut = last
      ? `,afade=t=out:st=${num(Math.max(0, samples / sampleRate - settings.endFadeSeconds))}:d=${num(settings.endFadeSeconds)}`
      : join > 0
        ? `,afade=t=out:ss=${samples - join}:ns=${join}`
        : "";
    parts.push(
      `[0:v]trim=start_frame=${first}:end_frame=${end},setpts=(PTS-STARTPTS)/${num(segment.speed)}[v${index}]`,
    );
    parts.push(
      `[0:a]atrim=start_sample=${Math.round(first * samplesPerFrame)}:end_sample=${Math.round(end * samplesPerFrame)},` +
        `asetpts=PTS-STARTPTS,${tempo(segment.speed, sampleRate)},apad,atrim=end_sample=${samples}${fadeIn}${fadeOut}[a${index}]`,
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
