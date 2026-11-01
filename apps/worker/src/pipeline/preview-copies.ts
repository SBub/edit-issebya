import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";

const PREVIEW_COPIES_VERSION = 1;

// About 18 MB together for a 50 second reel (2.9 Mbit/s): the footage's video
// and its copied 256k AAC, plus the cut-out.
export const PREVIEW_SETTINGS = {
  width: 540,
  height: 960,
  keyframeSeconds: 1,
  frameRate: 30,
  footage: { codec: "libx264", preset: "medium", crf: 23, maxrate: "1400k", bufsize: "2800k" },
  subject: { codec: "libvpx-vp9", crf: 34, bitrate: "1000k", deadline: "good", cpuUsed: 2 },
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

function scale(settings: PreviewSettings): string {
  return `scale=${settings.width}:${settings.height}:flags=lanczos`;
}

function gop(settings: PreviewSettings): string {
  return String(settings.keyframeSeconds * settings.frameRate);
}

// The retimed footage, small: H.264 at the preview size, every frame and its
// timestamp kept, the audio copied.
export function previewFootageArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
): string[] {
  const { footage } = settings;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    scale(settings),
    "-fps_mode",
    "passthrough",
    "-c:v",
    footage.codec,
    "-preset",
    footage.preset,
    "-crf",
    String(footage.crf),
    "-maxrate",
    footage.maxrate,
    "-bufsize",
    footage.bufsize,
    "-g",
    gop(settings),
    "-keyint_min",
    gop(settings),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ];
}

// The cut-out, small: VP9 with alpha at the preview size. The `libvpx-vp9`
// decoder before `-i` keeps the source's alpha; `-auto-alt-ref 0` and
// `alpha_mode=1` are what Chrome needs to play it.
export function previewSubjectArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
): string[] {
  const { subject } = settings;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-c:v",
    "libvpx-vp9",
    "-i",
    input,
    "-vf",
    scale(settings),
    "-fps_mode",
    "passthrough",
    "-c:v",
    subject.codec,
    "-crf",
    String(subject.crf),
    "-b:v",
    subject.bitrate,
    "-deadline",
    subject.deadline,
    "-cpu-used",
    String(subject.cpuUsed),
    "-row-mt",
    "1",
    "-auto-alt-ref",
    "0",
    "-g",
    gop(settings),
    "-pix_fmt",
    "yuva420p",
    "-metadata:s:v:0",
    "alpha_mode=1",
    "-an",
    output,
  ];
}

// Each encode writes under a partial name whose extension picks the muxer,
// renamed after its exit 0.
const COPIES = [
  {
    file: "footage.mp4",
    partial: "footage.part.mp4",
    input: "source.mp4",
    args: previewFootageArgs,
  },
  {
    file: "subject.webm",
    partial: "subject.part.webm",
    input: "subject.webm",
    args: previewSubjectArgs,
  },
] as const;

export const previewCopies: PipelineStep<PreviewSettings> = {
  name: "preview_copies",
  version: PREVIEW_COPIES_VERSION,
  settings: PREVIEW_SETTINGS,
  reelStatus: "making_previews",
  // Kept: they hang off the seven-minute cut-out, so they are not cheap to make again.
  outputs: [
    { file: "footage.mp4", keep: "kept" },
    { file: "subject.webm", keep: "kept" },
  ],
  reusedWhat: "preview copies made",
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "retime", fingerprint: fingerprints.retime!, file: "source.mp4" },
      as: "source.mp4",
    },
    {
      ref: {
        step: "remove_background",
        fingerprint: fingerprints.remove_background!,
        file: "subject.webm",
      },
      as: "subject.webm",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    for (const copy of COPIES) {
      const partial = join(dir, copy.partial);
      await tool({ file: tools.ffmpeg, args: copy.args(files[copy.input]!, partial, settings) });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
      await rename(partial, join(dir, copy.file));
    }
    return { what: "preview copies made" };
  },
};
