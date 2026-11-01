import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineStep } from "./definition.ts";
import { parseProbe, probeArgs } from "./probe.ts";

const PREVIEW_VERSION = 1;

// Small copies for the studio's live preview (D5), both `width` wide with the
// source's aspect and frame timing. Aimed at about 18 MB together for a
// 50-second reel (about 2.9 Mbit/s for both).
export const PREVIEW_SETTINGS = {
  width: 540,
  footage: {
    videoCodec: "libx264",
    preset: "medium",
    crf: 26,
    pixelFormat: "yuv420p",
    keyframeSeconds: 1,
    audioCodec: "aac",
    audioBitrate: "96k",
    faststart: true,
  },
  subject: {
    videoCodec: "libvpx-vp9",
    pixelFormat: "yuva420p",
    crf: 36,
    deadline: "good",
    cpuUsed: 4,
    keyframeSeconds: 1,
  },
};

export type PreviewSettings = typeof PREVIEW_SETTINGS;

const FOOTAGE = "preview.mp4";
const SUBJECT = "preview-subject.webm";

// `-2` keeps the aspect with an even height (540x960 for 1080x1920).
function scale(settings: PreviewSettings): string {
  return `scale=${settings.width}:-2`;
}

// The retimed footage as small H.264; no frame-rate change.
export function previewFootageArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
  fps: number,
): string[] {
  const footage = settings.footage;
  const gop = String(Math.max(1, Math.round(fps * footage.keyframeSeconds)));
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
    "-c:v",
    footage.videoCodec,
    "-preset",
    footage.preset,
    "-crf",
    String(footage.crf),
    "-pix_fmt",
    footage.pixelFormat,
    "-g",
    gop,
    "-keyint_min",
    gop,
    "-sc_threshold",
    "0",
    "-fps_mode",
    "passthrough",
    "-c:a",
    footage.audioCodec,
    "-b:a",
    footage.audioBitrate,
    ...(footage.faststart ? ["-movflags", "+faststart"] : []),
    output,
  ];
}

// The cut-out as small VP9 with alpha, decoded with libvpx-vp9 (the native
// decoder drops alpha); no audio, no frame-rate change.
export function previewSubjectArgs(
  input: string,
  output: string,
  settings: PreviewSettings,
  fps: number,
): string[] {
  const subject = settings.subject;
  return [
    "-hide_banner",
    "-v",
    "error",
    "-y",
    "-c:v",
    "libvpx-vp9",
    "-i",
    input,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    scale(settings),
    "-c:v",
    subject.videoCodec,
    "-pix_fmt",
    subject.pixelFormat,
    "-b:v",
    "0",
    "-crf",
    String(subject.crf),
    "-deadline",
    subject.deadline,
    "-cpu-used",
    String(subject.cpuUsed),
    "-row-mt",
    "1",
    "-auto-alt-ref",
    "0",
    "-g",
    String(Math.max(1, Math.round(fps * subject.keyframeSeconds))),
    "-fps_mode",
    "passthrough",
    output,
  ];
}

// `30000/1001` as a number, for the keyframe interval only.
function frameRate(text: string): number {
  const [numerator, denominator] = text.split("/").map(Number);
  const fps = numerator! / denominator!;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`preview_copies: no frame rate (${text})`);
  return fps;
}

export const previewCopies: PipelineStep<PreviewSettings> = {
  name: "preview_copies",
  version: PREVIEW_VERSION,
  settings: PREVIEW_SETTINGS,
  reelStatus: "making_previews",
  outputs: [
    { file: FOOTAGE, keep: "kept" },
    { file: SUBJECT, keep: "kept" },
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
    const source = files["source.mp4"]!;
    const probe = parseProbe(await tool({ file: tools.ffprobe, args: probeArgs(source) }));
    const fps = frameRate(probe.video.rFrameRate);
    const footage = join(dir, "preview.part.mp4");
    await tool({ file: tools.ffmpeg, args: previewFootageArgs(source, footage, settings, fps) });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(footage, join(dir, FOOTAGE));
    const subject = join(dir, "preview-subject.part.webm");
    await tool({
      file: tools.ffmpeg,
      args: previewSubjectArgs(files["subject.webm"]!, subject, settings, fps),
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(subject, join(dir, SUBJECT));
    return { what: "preview copies made" };
  },
};
