import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { type Probe, isHdr, isVariableFrameRate, parseProbe, probeArgs } from "./probe.ts";

const CONVERT_VERSION = 1;

export const CONVERT_SETTINGS = {
  fps: 30,
  keyframeSeconds: 1,
  videoCodec: "libx264",
  preset: "medium",
  crf: 18,
  pixelFormat: "yuv420p",
  // Audio in one of these codecs is copied; anything else is encoded.
  copyAudioCodecs: ["aac"],
  audioCodec: "aac",
  audioBitrate: "256k",
  faststart: true,
  // PQ or HLG footage, tone-mapped to SDR BT.709 (nominal peak in nits).
  hdrToSdr: { tonemap: "hable", npl: 100 },
};

export type ConvertSettings = typeof CONVERT_SETTINGS;

const OUTPUT = "converted.mp4";
// The encode's own name: the output exists under its final name only once
// ffmpeg exited 0.
const PARTIAL = "converted.part.mp4";

// The ffmpeg arguments that turn phone footage into the pipeline's footage:
// H.264, constant frame rate, a keyframe every `keyframeSeconds`, AAC audio,
// moov atom first; HDR tone-mapped to SDR BT.709.
export function convertArgs(
  probe: Probe,
  input: string,
  output: string,
  settings: ConvertSettings,
): string[] {
  const hdr = isHdr(probe);
  const { tonemap, npl } = settings.hdrToSdr;
  const filters = hdr
    ? [
        `zscale=t=linear:npl=${npl}`,
        "format=gbrpf32le",
        "zscale=p=bt709",
        `tonemap=tonemap=${tonemap}:desat=0`,
        "zscale=t=bt709:m=bt709:r=tv",
        `format=${settings.pixelFormat}`,
        `fps=${settings.fps}`,
      ]
    : [`fps=${settings.fps}`];
  const gop = String(settings.fps * settings.keyframeSeconds);
  let audio: string[] = [];
  if (probe.audio) {
    audio = settings.copyAudioCodecs.includes(probe.audio.codec)
      ? ["-c:a", "copy"]
      : ["-c:a", settings.audioCodec, "-b:a", settings.audioBitrate];
  }
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    // The first video and audio streams only: no phone metadata tracks.
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    filters.join(","),
    "-fps_mode",
    "cfr",
    "-r",
    String(settings.fps),
    "-c:v",
    settings.videoCodec,
    "-preset",
    settings.preset,
    "-crf",
    String(settings.crf),
    "-pix_fmt",
    settings.pixelFormat,
    "-g",
    gop,
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
    "-force_key_frames",
    `expr:gte(t,n_forced*${settings.keyframeSeconds})`,
    ...(hdr ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : []),
    ...audio,
    ...(settings.faststart ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

// `footage converted`, naming each fix the footage needed.
export function convertWhat(probe: Probe): string {
  const parts = ["footage converted"];
  if (isHdr(probe)) parts.push("HDR to SDR");
  if (isVariableFrameRate(probe)) parts.push("variable frame rate fixed");
  return parts.join(", ");
}

export const convert: PipelineStep<ConvertSettings> = {
  name: "convert",
  version: CONVERT_VERSION,
  settings: CONVERT_SETTINGS,
  reelStatus: "converting",
  outputs: [OUTPUT],
  reusedWhat: "footage converted",
  inputs: (source) => [{ ref: { source }, as: "source" }],
  async run({ tool, tools, dir, files, settings }) {
    const source = files.source!;
    const probe = parseProbe(await tool({ file: tools.ffprobe, args: probeArgs(source) }));
    const partial = join(dir, PARTIAL);
    await tool({ file: tools.ffmpeg, args: convertArgs(probe, source, partial, settings) });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, OUTPUT));
    return { what: convertWhat(probe) };
  },
};
