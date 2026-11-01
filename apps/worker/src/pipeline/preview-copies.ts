import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";

const PREVIEW_VERSION = 1;

// Small copies for the studio's live preview in Chrome, both at the source's
// own frame timing. About 1.6 Mbit/s of footage plus 1.3 Mbit/s of cut-out:
// about 18 MB for a 50 s reel. `fps` only sets the keyframe interval, never a
// filter or `-r`.
export const PREVIEW_SETTINGS = {
  width: 540,
  height: 960,
  keyframeSeconds: 1,
  fps: 30,
  footage: {
    codec: "libx264",
    preset: "medium",
    crf: 23,
    maxrate: "1500k",
    bufsize: "3000k",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioBitrate: "128k",
    faststart: true,
  },
  cutout: {
    decoder: "libvpx-vp9",
    codec: "libvpx-vp9",
    pixelFormat: "yuva420p",
    crf: 32,
    bitrate: "1300k",
    deadline: "good",
    cpuUsed: 4,
  },
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

const SOURCE_OUTPUT = "preview-source.mp4";
const SUBJECT_OUTPUT = "preview-subject.webm";
// Each encode's own name: an output exists under its final name only once
// ffmpeg exited 0.
const SOURCE_PARTIAL = "preview-source.part.mp4";
const SUBJECT_PARTIAL = "preview-subject.part.webm";

function scaled(settings: PreviewSettings): string[] {
  return ["-vf", `scale=${settings.width}:${settings.height}`, "-fps_mode", "passthrough"];
}

function keyframes(settings: PreviewSettings): string[] {
  const gop = String(settings.fps * settings.keyframeSeconds);
  return ["-g", gop, "-keyint_min", gop];
}

// The footage: H.264 and AAC, moov atom first.
export function previewSourceArgs(
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
    ...scaled(settings),
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
    "-pix_fmt",
    footage.pixelFormat,
    ...keyframes(settings),
    "-sc_threshold",
    "0",
    "-c:a",
    footage.audioCodec,
    "-b:a",
    footage.audioBitrate,
    ...(footage.faststart ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

// The cut-out: decoded with the decoder that keeps its alpha, VP9 with alpha
// again (libvpx needs `-auto-alt-ref 0` for alpha), no audio.
export function previewSubjectArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
): string[] {
  const { cutout } = settings;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-c:v",
    cutout.decoder,
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    ...scaled(settings),
    "-c:v",
    cutout.codec,
    "-pix_fmt",
    cutout.pixelFormat,
    "-crf",
    String(cutout.crf),
    "-b:v",
    cutout.bitrate,
    "-deadline",
    cutout.deadline,
    "-cpu-used",
    String(cutout.cpuUsed),
    "-auto-alt-ref",
    "0",
    "-row-mt",
    "1",
    ...keyframes(settings),
    output,
  ];
}

export const previewCopies: PipelineStep<PreviewSettings> = {
  name: "preview_copies",
  version: PREVIEW_VERSION,
  settings: PREVIEW_SETTINGS,
  reelStatus: "making_previews",
  outputs: [
    { file: SOURCE_OUTPUT, keep: "kept" },
    { file: SUBJECT_OUTPUT, keep: "kept" },
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
    const source = join(dir, SOURCE_PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: previewSourceArgs(files["source.mp4"]!, source, settings),
    });
    const subject = join(dir, SUBJECT_PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: previewSubjectArgs(files["subject.webm"]!, subject, settings),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(source, join(dir, SOURCE_OUTPUT));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(subject, join(dir, SUBJECT_OUTPUT));
    return { what: "preview copies made" };
  },
};
